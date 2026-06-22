import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";
import { query } from "../db.js";

export interface PostResult {
  post_id: number;
  event_id: number;
  created_at: string;
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
  created_at: string;
  acked: boolean;
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
  },
): Promise<PostResult> {
  if (!input.body || input.body.trim() === "") {
    throw new Error("post: body must be non-empty");
  }
  if (!input.to_lane && !input.to_actor) {
    throw new Error("post: at least one of to_lane or to_actor is required");
  }

  let toParticipationId: number | null = null;
  if (input.to_actor) {
    // Accept either the bare label ("claude-cli") or the qualified actor ("daniel/claude-cli") -
    // the stored participant name is the bare label (decision 018), matching task assignment.
    const label = input.to_actor.includes("/")
      ? input.to_actor.slice(input.to_actor.lastIndexOf("/") + 1)
      : input.to_actor;
    const target = await client.query<{ id: string }>(
      `SELECT pa.id
         FROM participations pa
         JOIN participants pt ON pt.id = pa.participant_id
        WHERE pa.project_id = $1 AND pt.name = $2`,
      [ctx.project.id, label],
    );
    if (target.rowCount === 0) {
      throw new Error(`post: to_actor '${input.to_actor}' not found in project`);
    }
    toParticipationId = Number(target.rows[0].id);
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
        to_lane, to_participation_id, subject, body, ref, tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      ctx.project.id,
      eventId,
      ctx.participation.id,
      ctx.actor,
      input.to_lane ?? null,
      toParticipationId,
      input.subject ?? null,
      input.body,
      input.ref ?? null,
      input.tag ?? null,
    ],
  );

  return { post_id: Number(res.rows[0].id), event_id: eventId, created_at: res.rows[0].created_at };
}

/** Read posts in this project, optionally narrowed to the caller (`to_me`) and other filters. */
export async function readPosts(
  ctx: Ctx,
  filter: {
    to_lane?: string;
    to_me?: boolean;
    tag?: string;
    ref?: string;
    unacked_only?: boolean;
    limit?: number;
  } = {},
): Promise<PostRow[]> {
  const params: unknown[] = [ctx.project.id, ctx.participation.id];
  const where: string[] = ["p.project_id = $1"];

  if (filter.to_lane) {
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
    where.push(
      `(p.to_participation_id = $2
        OR p.to_lane = (SELECT NULLIF(lane, '(unset)') FROM presence WHERE participation_id = $2))`,
    );
  }
  if (filter.unacked_only) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM post_acks pa WHERE pa.post_id = p.id AND pa.participation_id = $2)`,
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
    created_at: string;
    acked: boolean;
  }>(
    `SELECT p.id AS post_id,
            p.from_actor_name AS "from",
            p.to_lane,
            COALESCE(tpo.username || '/' || tpt.name, tpt.name) AS to_actor,
            p.subject,
            p.body,
            p.ref,
            p.tag,
            p.created_at,
            EXISTS (
              SELECT 1 FROM post_acks pa
               WHERE pa.post_id = p.id AND pa.participation_id = $2
            ) AS acked
       FROM posts p
       LEFT JOIN participations tpa ON tpa.id = p.to_participation_id
       LEFT JOIN participants tpt ON tpt.id = tpa.participant_id
       LEFT JOIN owners tpo ON tpo.id = tpt.owner_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY p.id DESC
      LIMIT ${limitClause}`,
    params,
  );

  return res.rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));
}

/**
 * Acknowledge a post. Idempotent: a repeated ack keeps the first `acked_at` and never throws.
 * Appends an `ack` event in the caller's transaction.
 */
export async function ack(
  client: pg.PoolClient,
  ctx: Ctx,
  post_id: number,
): Promise<{ post_id: number; acked_at: string }> {
  const owner = await client.query<{ id: string }>(
    `SELECT id FROM posts WHERE id = $1 AND project_id = $2`,
    [post_id, ctx.project.id],
  );
  if (owner.rowCount === 0) {
    throw new Error(`ack: post ${post_id} not found in project`);
  }

  const res = await client.query<{ acked_at: string }>(
    `INSERT INTO post_acks (post_id, participation_id, actor_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, participation_id)
     DO UPDATE SET acked_at = post_acks.acked_at
     RETURNING acked_at`,
    [post_id, ctx.participation.id, ctx.actor],
  );

  await appendEvent(client, ctx, "ack", { post_id });
  return { post_id, acked_at: res.rows[0].acked_at };
}

/**
 * Count of posts addressed to the caller (directly or via its presence lane) that it has not
 * acked. Used by the per-call unread surfacing in mcp.ts (the "push, don't poll" channel) and
 * mirrors the whats_new unacked_posts logic.
 */
export async function unackedCount(ctx: Ctx): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM posts p
      WHERE p.project_id = $1
        AND (
          p.to_participation_id = $2
          OR p.to_lane = (SELECT NULLIF(lane, '(unset)') FROM presence WHERE participation_id = $2)
        )
        AND NOT EXISTS (
          SELECT 1 FROM post_acks pa
           WHERE pa.post_id = p.id AND pa.participation_id = $2
        )`,
    [ctx.project.id, ctx.participation.id],
  );
  return Number(res.rows[0].count);
}
