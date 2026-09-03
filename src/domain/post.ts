import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent, appendOwnerEvent } from "../events.js";
import { query } from "../db.js";
import { normalizeLinks, type LinkRow } from "./links.js";

/**
 * The day decision 065 merged: the cutoff for the PROVISIONED-lane delivery arm below.
 *
 * 065 made a provisioned lane deliver, which retroactively addresses the whole pre-065 lane archive to
 * agents that never received it - measured at 87 unread lane broadcasts in one 9-day window (decision 063).
 * Those are stale imperative handoffs ("deploy when green", "Campaign PAUSED") and CLAUDE.md section 15 has
 * agents plow their board at every task boundary, so delivering them at once means acting on superseded
 * instructions on a live service. The archive stays readable via read_posts(to_lane:) - it is just not
 * PUSHED. A code constant, deliberately: no DB column and no prod data write, so the whole change reverts
 * by reverting code. Set to the MERGE day and never to a future time, which would silently drop posts
 * written between deploy and the cutoff.
 */
export const LANE_FALLBACK_FROM = "2026-08-20T00:00:00Z";

/**
 * The lane-delivery rule, in ONE place. Five hand-copied copies of this predicate are what produced the
 * bug 065 fixes, so every delivery site consumes this helper instead of spelling it out.
 *
 * A participation's lane is its LIVE lane (`presence.lane`, written by register()) falling back to its
 * PROVISIONED lane (`participations.lane`, set by admin_provision/create_invite and shown by
 * list_participants). Strict COALESCE, not an OR-both: the `IS NULL` guard on the second arm means a
 * registered agent consults only its live lane, so register() is a lane MOVE rather than a lane ADD.
 * The fallback arm is bounded by LANE_FALLBACK_FROM; the live arm is unbounded, exactly as before 065.
 *
 * Placeholders only - values stay parameterized at the call site.
 */
export function laneDeliverySql(me: string, cutoff: string): string {
  return `(
          p.to_lane = NULLIF((SELECT lane FROM presence WHERE participation_id = ${me}), '(unset)')
          OR (
            NULLIF((SELECT lane FROM presence WHERE participation_id = ${me}), '(unset)') IS NULL
            AND p.to_lane = (SELECT lane FROM participations WHERE id = ${me})
            AND p.created_at >= ${cutoff}::timestamptz
          )
        )`;
}

export interface PostResult {
  post_id: number;
  event_id: number;
  created_at: string;
  /** How many OTHER inboxes this post reaches: participations whose resolved lane (decision 065) matches
   *  `to_lane`, plus the `to_actor` target, never the sender (decision 062 - your own post is not mail to
   *  you). Always present. Named `reaches`, not `delivered_to`: it counts inboxes the post is addressed to,
   *  and claiming delivery is the overclaiming this whole decision exists to stamp out. */
  reaches: number;
  /** The actors behind `reaches`, capped at RECIPIENTS_CAP. `reaches` always carries the TRUE count, so a
   *  trimmed list never states a trimmed number (decisions 062/063). */
  recipients: string[];
  /** Present when the post was accepted but currently reaches nobody. An UNKNOWN lane is now refused
   *  outright (decision 065), so this narrows to the case that is still legitimate: a known lane whose only
   *  member has since registered elsewhere. */
  warning?: string;
}

/** Response-size guard: `docs/architecture.md` pins responses as small and stable by design. */
export const RECIPIENTS_CAP = 25;

export interface LaneAudience {
  /** Every lane that exists in this project, by either column. Pinned to the project, so a lane in another
   *  tenant is simply absent - no existence oracle (invariant 3). */
  known: string[];
  /** Participations whose RESOLVED lane is the requested one, excluding the caller. */
  recipients: { id: number; actor: string }[];
}

/**
 * Who a lane actually reaches, and which lanes exist at all - one project scan, used by every write path so
 * the reach report and the delivery predicate cannot drift apart (they drifting apart IS the 065 bug).
 * Resolution matches laneDeliverySql exactly: live lane, else provisioned.
 */
export async function laneAudience(
  client: pg.PoolClient | null,
  projectId: number,
  meParticipationId: number,
  lane: string,
): Promise<LaneAudience> {
  const sql =
    // actor prefers the BOUND human over the provisioner, then the bare label - the same COALESCE as
    // listRoster/whoIsActive, so the names reported here match every other "who" surface.
    `SELECT pa.id,
            COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
            NULLIF(pres.lane, '(unset)') AS presence_lane,
            pa.lane AS provisioned_lane
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o ON o.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pa.human_owner_id
       LEFT JOIN presence pres ON pres.participation_id = pa.id
      WHERE pa.project_id = $1`;
  type Row = { id: string; actor: string; presence_lane: string | null; provisioned_lane: string | null };
  const res = client ? await client.query<Row>(sql, [projectId]) : await query<Row>(sql, [projectId]);
  const known = new Set<string>();
  const recipients: { id: number; actor: string }[] = [];
  for (const r of res.rows) {
    if (r.presence_lane) known.add(r.presence_lane);
    if (r.provisioned_lane) known.add(r.provisioned_lane);
    const effective = r.presence_lane ?? r.provisioned_lane;
    if (effective === lane && Number(r.id) !== meParticipationId) {
      recipients.push({ id: Number(r.id), actor: r.actor });
    }
  }
  return { known: [...known].sort(), recipients };
}

/** The one wording for "that lane does not exist here", so both the write and read paths teach the same fix. */
function unknownLaneError(verb: string, lane: string, known: string[]): Error {
  return new Error(
    `${verb}: lane "${lane}" does not exist in this project` +
      (known.length ? ` - lanes in use: ${known.join(", ")}` : " - this project has no lanes") +
      `. Use one of those, or address the agent directly with to_actor:"<handle>/<label>". ` +
      `An agent joins a lane with register(lane:"${lane}"); an owner can set one on the access page.`,
  );
}

export interface PostRow {
  post_id: number;
  from: string;
  to_lane: string | null;
  to_actor: string | null;
  subject: string | null;
  body: string;
  ref: string | null;
  tag: string | null;
  links: LinkRow[] | null;
  created_at: string;
  read: boolean;
}

/**
 * Publish a prose message addressed to a lane and/or a specific participant. The post body lives
 * only in the `posts` table (never in the ledger payload); the ledger event records the
 * routing metadata and links 1:1 to the row. Both commit in the caller's transaction.
 */
export async function post(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    to_lane?: string;
    to_actor?: string;
    subject?: string;
    body: string;
    ref?: string;
    tag?: string;
    links?: unknown;
  },
): Promise<PostResult> {
  if (!input.body || input.body.trim() === "") {
    throw new Error("post: body must be non-empty");
  }
  if (!input.to_lane && !input.to_actor) {
    throw new Error("post: at least one of to_lane or to_actor is required");
  }
  const links = normalizeLinks(input.links);

  let toParticipationId: number | null = null;
  let toActorCanonical: string | null = null;
  if (input.to_actor) {
    // Accept either the bare label ("claude-cli") or the qualified actor ("daniel/claude-cli") -
    // the stored participant name is the bare label (decision 018), matching task assignment.
    const label = input.to_actor.includes("/")
      ? input.to_actor.slice(input.to_actor.lastIndexOf("/") + 1)
      : input.to_actor;
    // Select the CANONICAL actor too: `recipients` must report the same qualified form every other "who"
    // surface uses, not the bare label a caller happened to type. A decision about names that overclaim
    // should not echo unverified input back as if the server had resolved it.
    const target = await client.query<{ id: string; actor: string }>(
      `SELECT pa.id,
              COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor
         FROM participations pa
         JOIN participants pt ON pt.id = pa.participant_id
         JOIN owners o ON o.id = pt.owner_id
         LEFT JOIN owners ho ON ho.id = pa.human_owner_id
        WHERE pa.project_id = $1 AND pt.name = $2`,
      [ctx.project.id, label],
    );
    if (target.rowCount === 0) {
      // Cross-namespace probe (in-project only, so no cross-tenant oracle - invariant 3): `to_actor` resolves
      // AGENTS only, so naming a human member here returned a bare "not found" about someone who IS in the
      // project. Say what they are and where their work actually lands (decision 061).
      const human = await client.query<{ name: string }>(
        `SELECT COALESCE(o.username, o.email) AS name
           FROM project_members pm JOIN owners o ON o.id = pm.owner_id
          WHERE pm.project_id = $1 AND (lower(o.username) = lower($2) OR lower(o.email) = lower($2))`,
        [ctx.project.id, label],
      );
      if (human.rowCount && human.rows[0]) {
        throw new Error(
          `post: '${label}' is a HUMAN MEMBER of this project, not an agent - people do not have a post ` +
            `inbox. Give them work with task_create/task_assign(human:"${human.rows[0].name}"), which lands ` +
            `on their web board and in their daily digest.`,
        );
      }
      throw new Error(`post: to_actor '${input.to_actor}' not found in project`);
    }
    toParticipationId = Number(target.rows[0].id);
    toActorCanonical = target.rows[0].actor;
  }
  // Decision 061 ruled that this check must READ THE DELIVERY SURFACE rather than the provisioning column -
  // its first cut read participations.lane and the security review caught it as the wrong-surface trap.
  // That rule is UPHELD here, not reversed: 065 moved the delivery surface (live lane, else provisioned -
  // see laneDeliverySql above), and the check follows it. What 065 does change is 061's "warn, never
  // reject": a lane that exists in NEITHER column reaches nobody by construction and is a typo every time,
  // and three projects independently lost real handoffs to one (an "infra", a "platform", and a lane that
  // was actually an actor name). 061's own text already said it - "a typo is not [fine]". A post ahead of
  // an agent JOINING is still legitimate and still accepted, because provisioning has already created the
  // lane by then.
  let laneWarning: string | undefined;
  let recipients: { id: number; actor: string }[] = [];
  if (input.to_lane) {
    const audience = await laneAudience(client, ctx.project.id, ctx.participation.id, input.to_lane);
    if (!audience.known.includes(input.to_lane)) throw unknownLaneError("post", input.to_lane, audience.known);
    recipients = audience.recipients;
    if (recipients.length === 0) {
      laneWarning =
        `lane "${input.to_lane}" exists but currently reaches nobody else - no other participation ` +
        `resolves to it (you are never mail to yourself, decision 062). The post still lands and stays ` +
        `readable with read_posts(to_lane:"${input.to_lane}").`;
    }
  }
  // The to_actor target is an inbox too, and is not necessarily in the lane. Never count the sender.
  if (toParticipationId !== null && toParticipationId !== ctx.participation.id
      && !recipients.some((r) => r.id === toParticipationId)) {
    recipients = [...recipients, { id: toParticipationId, actor: toActorCanonical as string }];
  }

  const { id: eventId } = await appendEvent(client, ctx, "post", {
    to_lane: input.to_lane ?? null,
    to_actor: input.to_actor ?? null,
    subject: input.subject ?? null,
    ref: input.ref ?? null,
    tag: input.tag ?? null,
  });

  const res = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO posts
       (project_id, event_id, from_participation_id, from_actor_name,
        to_lane, to_participation_id, to_actor_name, subject, body, ref, tag, links)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, created_at`,
    [
      ctx.project.id,
      eventId,
      ctx.participation.id,
      ctx.actor,
      input.to_lane ?? null,
      toParticipationId,
      // The addressee's name, kept alongside the id the way from_actor_name always has been for the
      // sender (decision 069). The id is SET NULL when that agent is deleted; without this the row would
      // lose every trace of who it was for - and, when there was no lane either, become invalid outright.
      toActorCanonical,
      input.subject ?? null,
      input.body,
      input.ref ?? null,
      input.tag ?? null,
      links ? JSON.stringify(links) : null,
    ],
  );

  return {
    post_id: Number(res.rows[0].id),
    event_id: eventId,
    created_at: res.rows[0].created_at,
    reaches: recipients.length,
    recipients: recipients.slice(0, RECIPIENTS_CAP).map((r) => r.actor),
    ...(laneWarning ? { warning: laneWarning } : {}),
  };
}

/**
 * Publish a post authored by an OWNER (a human on the web admin), not a bus participant - the
 * invariant-1-safe attribution for the human-in-the-loop review answer (decision 033). The human holds
 * no token, so `from_participation_id` is NULL and `from_actor_name` is the owner's globally-unique
 * handle (decision 018), a display SNAPSHOT (invariant 6: the NULL FK + preserved name survive deletion).
 * Linked 1:1 to an owner-authored `task_review_answer` event via appendOwnerEvent, keeping events.ts the
 * sole ledger writer. Commits in the caller's transaction. At least one of toParticipationId/toLane must
 * be set (the posts CHECK); the caller (answerReview) addresses the assignee's participation, else its lane.
 */
export async function postFromOwner(
  client: pg.PoolClient,
  input: {
    projectId: number;
    fromActorName: string;
    toParticipationId?: number | null;
    toLane?: string | null;
    subject?: string | null;
    body: string;
    ref?: string | null;
    tag?: string | null;
  },
): Promise<PostResult> {
  if (!input.body || input.body.trim() === "") {
    throw new Error("postFromOwner: body must be non-empty");
  }
  if (input.toParticipationId == null && (input.toLane == null || input.toLane === "")) {
    throw new Error("postFromOwner: at least one of toParticipationId or toLane is required");
  }

  const { id: eventId } = await appendOwnerEvent(
    client,
    input.projectId,
    input.fromActorName,
    "task_review_answer",
    {
      to_lane: input.toLane ?? null,
      to_participation_id: input.toParticipationId ?? null,
      subject: input.subject ?? null,
      ref: input.ref ?? null,
      tag: input.tag ?? null,
    },
  );

  const res = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO posts
       (project_id, event_id, from_participation_id, from_actor_name,
        to_lane, to_participation_id, to_actor_name, subject, body, ref, tag)
     VALUES ($1, $2, NULL, $3, $4, $5,
        -- Resolved in SQL rather than threaded through every caller: one expression, no drift, and the
        -- same COALESCE every other "who" surface uses (decision 069).
        (SELECT COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name)
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
           JOIN owners o ON o.id = pt.owner_id
           LEFT JOIN owners ho ON ho.id = pa.human_owner_id
          WHERE pa.id = $5),
        $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      input.projectId,
      eventId,
      input.fromActorName,
      input.toLane ?? null,
      input.toParticipationId ?? null,
      input.subject ?? null,
      input.body,
      input.ref ?? null,
      input.tag ?? null,
    ],
  );

  // Both internal writers address a participation directly (toLane is always null at every call site), so
  // the reach is the target itself. Reported for shape parity with post() - one PostResult, one contract.
  return {
    post_id: Number(res.rows[0].id),
    event_id: eventId,
    created_at: res.rows[0].created_at,
    reaches: input.toParticipationId != null ? 1 : 0,
    recipients: [],
  };
}

/**
 * Publish a review answer authored by a bus PARTICIPANT - an AGENT answering a review awaiting IT (decision
 * 034). The Ctx-authored twin of postFromOwner: from_participation_id = ctx.participation.id and
 * from_actor_name = ctx.actor (the qualified bus identity), linked 1:1 to a Ctx-authored `task_review_answer`
 * event via appendEvent - so the honest-ledger event TYPE matches the human path while the AUTHOR is the
 * agent. Keeps events.ts/post.ts the sole writers of their tables; commits in the caller's transaction. At
 * least one of toParticipationId/toLane must be set (the posts CHECK); the caller (answerReviewAsAgent)
 * addresses the REQUESTER's participation, else the task lane.
 */
export async function postReviewAnswerFromAgent(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    toParticipationId?: number | null;
    toLane?: string | null;
    subject?: string | null;
    body: string;
    ref?: string | null;
    tag?: string | null;
  },
): Promise<PostResult> {
  if (!input.body || input.body.trim() === "") {
    throw new Error("postReviewAnswerFromAgent: body must be non-empty");
  }
  if (input.toParticipationId == null && (input.toLane == null || input.toLane === "")) {
    throw new Error("postReviewAnswerFromAgent: at least one of toParticipationId or toLane is required");
  }

  const { id: eventId } = await appendEvent(client, ctx, "task_review_answer", {
    to_lane: input.toLane ?? null,
    to_participation_id: input.toParticipationId ?? null,
    subject: input.subject ?? null,
    ref: input.ref ?? null,
    tag: input.tag ?? null,
  });

  const res = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO posts
       (project_id, event_id, from_participation_id, from_actor_name,
        to_lane, to_participation_id, to_actor_name, subject, body, ref, tag)
     VALUES ($1, $2, $3, $4, $5, $6,
        -- Resolved in SQL rather than threaded through every caller: one expression, no drift, and the
        -- same COALESCE every other "who" surface uses (decision 069).
        (SELECT COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name)
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
           JOIN owners o ON o.id = pt.owner_id
           LEFT JOIN owners ho ON ho.id = pa.human_owner_id
          WHERE pa.id = $6),
        $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      ctx.project.id,
      eventId,
      ctx.participation.id,
      ctx.actor,
      input.toLane ?? null,
      input.toParticipationId ?? null,
      input.subject ?? null,
      input.body,
      input.ref ?? null,
      input.tag ?? null,
    ],
  );

  // Both internal writers address a participation directly (toLane is always null at every call site), so
  // the reach is the target itself. Reported for shape parity with post() - one PostResult, one contract.
  return {
    post_id: Number(res.rows[0].id),
    event_id: eventId,
    created_at: res.rows[0].created_at,
    reaches: input.toParticipationId != null ? 1 : 0,
    recipients: [],
  };
}

/**
 * Read posts in this project, optionally narrowed to the caller (`to_me`) and other filters. Reading IS the
 * receipt (decision 039, v2 - `ack` is retired): every returned post ADDRESSED to the caller (directly or via
 * its presence lane) is stamped read in `post_reads`, which is what clears it from the caller's unread count +
 * the owner's "needs you" nag. `read` on each row reflects the state BEFORE this call (so a just-read post
 * shows read:false the first time, read:true thereafter). `unread_only` narrows to the caller's still-unread
 * mail.
 */
export async function readPosts(
  ctx: Ctx,
  filter: {
    to_lane?: string;
    to_me?: boolean;
    tag?: string;
    ref?: string;
    unread_only?: boolean;
    limit?: number;
  } = {},
): Promise<PostRow[]> {
  const params: unknown[] = [ctx.project.id, ctx.participation.id];
  const where: string[] = ["p.project_id = $1"];

  if (filter.to_lane) {
    // Same refusal as the write path (decision 065): a lane filter that matches nothing returns a clean []
    // that is indistinguishable from "no lane mail", which is how one rig read its own ACTOR NAME as a lane
    // for nine days and saw an empty inbox as good news. Empty-result-as-success is the same failure class
    // as a success envelope for a delivery to nobody.
    //
    // "Known" is WIDER here than on the write path: it also counts any lane that has mail. A lane whose
    // members were re-laned or revoked stops existing in both columns, and refusing it would make the
    // archive that LANE_FALLBACK_FROM deliberately preserves permanently unreachable. The write path must
    // NOT include this - the pre-065 typo lanes are already in posts.to_lane, and honouring them there
    // would legitimize exactly the typos the rule exists to reject.
    const audience = await laneAudience(null, ctx.project.id, ctx.participation.id, filter.to_lane);
    const archived = await query<{ lane: string }>(
      `SELECT DISTINCT to_lane AS lane FROM posts WHERE project_id = $1 AND to_lane IS NOT NULL`,
      [ctx.project.id],
    );
    const known = [...new Set([...audience.known, ...archived.rows.map((r) => r.lane)])].sort();
    if (!known.includes(filter.to_lane)) throw unknownLaneError("read_posts", filter.to_lane, known);
    params.push(filter.to_lane);
    where.push(`p.to_lane = $${params.length}`);
  }
  if (filter.tag) {
    params.push(filter.tag);
    where.push(`p.tag = $${params.length}`);
  }
  if (filter.ref) {
    params.push(filter.ref);
    where.push(`p.ref = $${params.length}`);
  }
  if (filter.to_me) {
    params.push(LANE_FALLBACK_FROM);
    where.push(`(p.to_participation_id = $2 OR ${laneDeliverySql("$2", `$${params.length}`)})`);
  }
  if (filter.unread_only) {
    // You are never unread mail to yourself (decision 062). A post to your own lane comes back to you, so
    // without this an agent's own handoff sits in its inbox forever and rides every tool response as
    // "_unread_posts: N" - a counter that cannot be cleared by doing the thing it asks for.
    where.push(
      `p.from_participation_id IS DISTINCT FROM $2
       AND NOT EXISTS (SELECT 1 FROM post_reads pr WHERE pr.post_id = p.id AND pr.participation_id = $2)`,
    );
  }

  const limit = filter.limit ?? 50;
  params.push(limit);
  const limitClause = `$${params.length}`;

  const res = await query<{
    post_id: string;
    from: string;
    to_lane: string | null;
    to_actor: string | null;
    subject: string | null;
    body: string;
    ref: string | null;
    tag: string | null;
    links: LinkRow[] | null;
    created_at: string;
    read: boolean;
  }>(
    `SELECT p.id AS post_id,
            p.from_actor_name AS "from",
            p.to_lane,
            COALESCE(COALESCE(tho.username, tpo.username) || '/' || tpt.name, tpt.name) AS to_actor,
            p.subject,
            p.body,
            p.ref,
            p.tag,
            p.links,
            p.created_at,
            EXISTS (
              SELECT 1 FROM post_reads pr
               WHERE pr.post_id = p.id AND pr.participation_id = $2
            ) AS read
       FROM posts p
       LEFT JOIN participations tpa ON tpa.id = p.to_participation_id
       LEFT JOIN participants tpt ON tpt.id = tpa.participant_id
       LEFT JOIN owners tpo ON tpo.id = tpt.owner_id
       LEFT JOIN owners tho ON tho.id = tpa.human_owner_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY p.id DESC
      LIMIT ${limitClause}`,
    params,
  );

  const rows = res.rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));

  // Stamp a read receipt for every returned post ADDRESSED to the caller (reading = acking, decision 039).
  // Only addressed posts (the ones the unread count considers) get a receipt; a receipt is idempotent. Best-
  // effort autocommit write on the read path - advisory, so it never needs the caller's transaction.
  // Pass every returned id; the INSERT's WHERE keeps only the ones addressed to the caller.
  const returnedIds = rows.map((r) => r.post_id);
  if (returnedIds.length) {
    await query(
      `INSERT INTO post_reads (post_id, participation_id)
       SELECT p.id, $2 FROM posts p
        WHERE p.project_id = $1
          AND p.id = ANY($3::bigint[])
          AND (p.to_participation_id = $2 OR ${laneDeliverySql("$2", "$4")})
       ON CONFLICT DO NOTHING`,
      [ctx.project.id, ctx.participation.id, returnedIds, LANE_FALLBACK_FROM],
    );
  }

  return rows;
}

/**
 * Count of posts addressed to the caller (directly or via its presence lane) that it has not READ yet
 * (decision 039 - reading writes `post_reads`, retiring `ack`). Powers the per-call `_unread_posts` nudge
 * (the "push, don't poll" channel) and mirrors the whats_new unread_posts logic.
 */
export async function unreadCount(ctx: Ctx): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM posts p
      WHERE p.project_id = $1
        AND (p.to_participation_id = $2 OR ${laneDeliverySql("$2", "$3")})
        -- Your own post is not mail to you (decision 062). Lane posts fan out to everyone in the lane
        -- INCLUDING the sender, so without this an agent nags itself about its own handoff on every tool
        -- response, and the count never reaches zero however diligently it reads.
        AND p.from_participation_id IS DISTINCT FROM $2
        AND NOT EXISTS (
          SELECT 1 FROM post_reads pr
           WHERE pr.post_id = p.id AND pr.participation_id = $2
        )`,
    [ctx.project.id, ctx.participation.id, LANE_FALLBACK_FROM],
  );
  return Number(res.rows[0].count);
}
