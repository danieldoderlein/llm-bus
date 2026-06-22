import type { Ctx } from "./context.js";
import { query } from "./db.js";

/**
 * Implicit heartbeat: refresh the participation's liveness on EVERY tool call, so presence
 * is never a manual chore an LLM forgets. Upserts so a heartbeat before an explicit register
 * still records liveness; never overwrites an existing lane. Runs outside the handler's
 * transaction so a failed business call still records liveness.
 */
export async function touchPresence(ctx: Ctx): Promise<void> {
  await query(
    `INSERT INTO presence (participation_id, project_id, lane, last_seen)
     VALUES ($1, $2, '(unset)', now())
     ON CONFLICT (participation_id) DO UPDATE SET last_seen = now()`,
    [ctx.participation.id, ctx.project.id],
  );
}
