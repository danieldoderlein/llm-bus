import type pg from "pg";
import type { Ctx } from "./context.js";

export type EventType =
  | "claim"
  | "seed"
  | "register"
  | "post"
  | "ack"
  | "lease"
  | "release"
  | "task_create"
  | "task_assign"
  | "task_start"
  | "task_stop"
  | "task_block"
  | "task_resolve"
  | "task_ship"
  | "task_review_request"
  | "task_review_answer"
  | "task_cancel"
  | "task_reopen"
  | "task_edit"
  | "task_depend"
  | "task_undepend"
  | "task_answer";

/**
 * The ONLY writer to the `events` ledger. Project-scoped and attributed from `ctx`
 * (project_id from the project, participation_id as the actor key, actor_name = the
 * participant's display name). Takes an explicit client so the event commits in the same
 * transaction as the act it records. Returns the new event id (posts link to it 1:1).
 */
export async function appendEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  type: EventType,
  payload: Record<string, unknown> = {},
): Promise<{ id: number }> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO events (project_id, participation_id, actor_name, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [ctx.project.id, ctx.participation.id, ctx.actor, type, JSON.stringify(payload)],
  );
  return { id: Number(res.rows[0].id) };
}

/**
 * Append an event authored by an OWNER (a human on the web admin), not a bus participant. The human
 * holds no token and is not a participation, so `participation_id` is NULL and `actor_name` is the
 * owner's globally-unique handle (decision 018) - an attribution SNAPSHOT, invariant-1-safe (identity
 * for the human still comes from the SSO session, never from input) and invariant-6-safe (the NULL FK
 * plus the preserved name survive deletion). Keeps events.ts the sole writer of the ledger (its stated
 * contract). Used by the human-in-the-loop review write-back (decision 033); takes an explicit client so
 * it commits in the caller's transaction. Returns the new event id (a post links to it 1:1).
 */
export async function appendOwnerEvent(
  client: pg.PoolClient,
  projectId: number,
  actorName: string,
  type: EventType,
  payload: Record<string, unknown> = {},
): Promise<{ id: number }> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO events (project_id, participation_id, actor_name, type, payload)
     VALUES ($1, NULL, $2, $3, $4::jsonb)
     RETURNING id`,
    [projectId, actorName, type, JSON.stringify(payload)],
  );
  return { id: Number(res.rows[0].id) };
}
