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
  | "task_block"
  | "task_resolve"
  | "task_ship";

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
