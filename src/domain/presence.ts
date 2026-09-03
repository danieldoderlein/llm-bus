import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";
import { query } from "../db.js";

export interface RegisterResult {
  actor: string;
  lane: string;
  status: string;
  registered_at: string;
}
export interface ActiveActor {
  actor: string;
  lane: string;
  status: string;
  last_seen: string;
  /** Seconds since this actor last touched the bus. NOTE: last_seen only bumps on a BUS tool call
   *  (implicit heartbeat), so a large value means "quiet on the bus", NOT "offline" - an agent can be
   *  hard at work in its own repo while going minutes without a bus call. Read recency, not presence. */
  seen_ago_seconds: number;
}

/** Register (or re-register) this participation as present in a lane, with an optional short status. */
export async function register(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { lane: string; status?: string },
): Promise<RegisterResult> {
  // '(unset)' is the delivery sentinel touchPresence writes, and NULLIF erases it everywhere lanes are
  // resolved - so an agent registering into a lane literally named "(unset)" would end up addressable only
  // through the bounded fallback arm, on a lane named after having no lane. Refuse it rather than explain it.
  if (opts.lane === "(unset)") {
    throw new Error(`register: "(unset)" is reserved - it is how the bus records "no lane". Pick a real lane name.`);
  }
  const status = opts.status ?? "";
  const res = await client.query<{ registered_at: string }>(
    `INSERT INTO presence (participation_id, project_id, lane, status, registered_at, last_seen)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (participation_id)
     DO UPDATE SET lane = EXCLUDED.lane, status = EXCLUDED.status, registered_at = now(), last_seen = now()
     RETURNING registered_at`,
    [ctx.participation.id, ctx.project.id, opts.lane, status],
  );
  // Dual-write the ROSTER lane (decision 065). list_participants advertises participations.lane, and before
  // 065 nothing ever updated it - so an agent that registered into "qa" kept showing its provisioned "dev"
  // on the roster, forever. Now that both columns feed delivery (live wins, provisioned is the fallback),
  // a register that wrote only presence would leave two routing-relevant columns free to disagree. Same
  // transaction as the presence upsert: they move together or not at all.
  await client.query(`UPDATE participations SET lane = $2 WHERE id = $1`, [ctx.participation.id, opts.lane]);
  await appendEvent(client, ctx, "register", { lane: opts.lane, status });
  return { actor: ctx.actor, lane: opts.lane, status, registered_at: res.rows[0].registered_at };
}

/** Participations in this project seen within the liveness window (lane-scoped if `lane` given). */
export async function whoIsActive(
  ctx: Ctx,
  opts: { lane?: string; within_seconds?: number } = {},
): Promise<ActiveActor[]> {
  const within = opts.within_seconds ?? ctx.project.livenessWindowSec;
  const params: unknown[] = [ctx.project.id, within];
  let laneClause = "";
  if (opts.lane) {
    params.push(opts.lane);
    laneClause = `AND COALESCE(NULLIF(p.lane, '(unset)'), pa.lane) = $${params.length}`;
  }
  const res = await query<{
    actor: string;
    lane: string;
    status: string;
    last_seen: string;
    seen_ago_seconds: number;
  }>(
    // actor prefers the BOUND human (participations.human_owner_id, canonical per 038/052) over the
    // provisioner (participants.owner_id), then the bare label - same COALESCE as list_participants and
    // the access page, so all "who belongs to whom" surfaces agree for a cross-human-provisioned agent.
    // lane is the RESOLVED lane (live, else provisioned - decision 065). guide() promises "a post
    // to_lane=<lane> reaches everyone in it; who_is_active shows who is there", so this surface has to
    // report the lane a post would actually reach, not the raw presence column.
    `SELECT COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
            COALESCE(NULLIF(p.lane, '(unset)'), pa.lane, '(unset)') AS lane, p.status, p.last_seen,
            EXTRACT(EPOCH FROM (now() - p.last_seen))::int AS seen_ago_seconds
       FROM presence p
       JOIN participations pa ON pa.id = p.participation_id
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o ON o.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pa.human_owner_id
      WHERE p.project_id = $1
        AND p.last_seen >= now() - make_interval(secs => $2)
        ${laneClause}
      ORDER BY p.last_seen DESC`,
    params,
  );
  return res.rows.map((r) => ({ ...r, seen_ago_seconds: Number(r.seen_ago_seconds) }));
}
