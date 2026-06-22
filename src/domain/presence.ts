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
}

/** Register (or re-register) this participation as present in a lane, with an optional short status. */
export async function register(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { lane: string; status?: string },
): Promise<RegisterResult> {
  const status = opts.status ?? "";
  const res = await client.query<{ registered_at: string }>(
    `INSERT INTO presence (participation_id, project_id, lane, status, registered_at, last_seen)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (participation_id)
     DO UPDATE SET lane = EXCLUDED.lane, status = EXCLUDED.status, registered_at = now(), last_seen = now()
     RETURNING registered_at`,
    [ctx.participation.id, ctx.project.id, opts.lane, status],
  );
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
    laneClause = `AND p.lane = $${params.length}`;
  }
  const res = await query<{ actor: string; lane: string; status: string; last_seen: string }>(
    `SELECT COALESCE(o.username || '/' || pt.name, pt.name) AS actor, p.lane, p.status, p.last_seen
       FROM presence p
       JOIN participations pa ON pa.id = p.participation_id
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o ON o.id = pt.owner_id
      WHERE p.project_id = $1
        AND p.last_seen >= now() - make_interval(secs => $2)
        ${laneClause}
      ORDER BY p.last_seen DESC`,
    params,
  );
  return res.rows;
}
