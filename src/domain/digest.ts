import type pg from "pg";
import type { Ctx } from "../context.js";
import { query } from "../db.js";
import type { LedgerEvent } from "./query.js";

export interface SequenceDigest {
  sequence: string;
  number: number;
  formatted: string;
  by: string;
  at: string;
}

/**
 * The latest claim per sequence in this project: one row per sequence, taken from the
 * highest event id (most recent claim). DISTINCT ON keeps that newest row per sequence.
 */
export async function latestClaims(ctx: Ctx): Promise<{ sequences: SequenceDigest[] }> {
  const res = await query<{
    sequence: string;
    number: string;
    formatted: string;
    by: string;
    at: string;
  }>(
    `SELECT DISTINCT ON (payload->>'sequence')
            payload->>'sequence'  AS sequence,
            payload->>'number'    AS number,
            payload->>'formatted' AS formatted,
            actor_name            AS by,
            ts                    AS at
       FROM events
      WHERE project_id = $1
        AND type = 'claim'
      ORDER BY payload->>'sequence', id DESC`,
    [ctx.project.id],
  );

  return {
    sequences: res.rows.map((r) => ({
      sequence: r.sequence,
      number: Number(r.number),
      formatted: r.formatted,
      by: r.by,
      at: r.at,
    })),
  };
}

/**
 * The session digest for the calling participation: everything appended since its cursor,
 * plus the small counts an agent needs to orient (mail addressed to it but unacked, active
 * leases, and the latest claim per sequence). Advances the cursor to the newest event seen
 * unless `advance_cursor === false`. Takes a client so the read + cursor advance commit
 * atomically with the caller's transaction.
 */
export async function whatsNew(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { advance_cursor?: boolean; limit?: number } = {},
): Promise<{
  since_event_id: number;
  events: LedgerEvent[];
  unacked_posts: number;
  active_leases: number;
  latest_claims: Record<string, string>;
}> {
  const limit = opts.limit ?? 100;

  // Read the participation's cursor (the last event id it has already digested), default 0.
  const cursorRes = await client.query<{ last_event_id: string }>(
    `SELECT last_event_id FROM actor_cursors WHERE participation_id = $1`,
    [ctx.participation.id],
  );
  const cursor = cursorRes.rows.length ? Number(cursorRes.rows[0].last_event_id) : 0;

  // Events appended after the cursor, oldest-first so the cursor advances monotonically.
  const evRes = await client.query<{
    id: string;
    ts: string;
    actor: string;
    type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, ts, actor_name AS actor, type, payload
       FROM events
      WHERE project_id = $1
        AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [ctx.project.id, cursor, limit],
  );
  const events: LedgerEvent[] = evRes.rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
  }));

  // Posts in this project addressed to the caller (directly or via its presence lane)
  // that the caller has not yet acked.
  const unackedRes = await client.query<{ count: string }>(
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
  const unacked_posts = Number(unackedRes.rows[0].count);

  // Active (unreleased, unexpired) leases in this project.
  const leaseRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leases
      WHERE project_id = $1
        AND released_at IS NULL
        AND expires_at > now()`,
    [ctx.project.id],
  );
  const active_leases = Number(leaseRes.rows[0].count);

  // Latest claim per sequence, flattened to sequence -> formatted.
  const { sequences } = await latestClaims(ctx);
  const latest_claims: Record<string, string> = {};
  for (const s of sequences) latest_claims[s.sequence] = s.formatted;

  // Advance the cursor to the newest event just returned (unless explicitly suppressed).
  if (opts.advance_cursor !== false && events.length > 0) {
    const maxId = events[events.length - 1].id;
    await client.query(
      `INSERT INTO actor_cursors (participation_id, project_id, last_event_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (participation_id)
       DO UPDATE SET last_event_id = EXCLUDED.last_event_id, updated_at = now()`,
      [ctx.participation.id, ctx.project.id, maxId],
    );
  }

  return { since_event_id: cursor, events, unacked_posts, active_leases, latest_claims };
}
