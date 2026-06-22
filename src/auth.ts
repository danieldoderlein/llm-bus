import { createHash } from "node:crypto";
import { query } from "./db.js";
import type { Ctx } from "./context.js";

/** sha-256 hex of a plaintext token. Only the hash is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

/** The outcome of resolving a bearer token. `suspended` is the one deliberate block (decision 016):
 *  the token is valid but the owner is suspended for non-payment - distinct from a missing/bad token. */
export type AuthResult =
  | { ok: true; ctx: Ctx }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "suspended" };

/**
 * Resolve a bearer token to its full v2 context in one query:
 * token -> participation -> project (+ participant + owner).
 * Returns "unauthorized" if missing/invalid/revoked; "suspended" if the (non-comped) owner is
 * suspended for non-payment (decision 016 - a READ-before-action gate; the atomic claim is never
 * entered). Sub-agents sharing a token resolve to the same participation (the v1 invariant survives).
 */
export async function authenticateResult(authorization: string | undefined): Promise<AuthResult> {
  const token = extractBearer(authorization);
  if (!token) return { ok: false, reason: "unauthorized" };
  const res = await query<{
    participation_id: string;
    is_admin: boolean;
    lane: string | null;
    participant_id: string;
    participant_name: string;
    kind: "agent" | "human";
    project_id: string;
    slug: string;
    project_name: string;
    liveness_window_sec: number;
    owner_id: string;
    email: string;
    username: string | null;
    suspended_at: string | null;
    plan: "free" | "team" | "comped";
  }>(
    `SELECT pa.id AS participation_id, pa.is_admin, pa.lane,
            pt.id AS participant_id, pt.name AS participant_name, pt.kind,
            pr.id AS project_id, pr.slug, pr.name AS project_name, pr.liveness_window_sec,
            o.id AS owner_id, o.email, o.username, o.suspended_at, o.plan
       FROM tokens t
       JOIN participations pa ON pa.id = t.participation_id
       JOIN participants   pt ON pt.id = pa.participant_id
       JOIN projects       pr ON pr.id = pa.project_id
       JOIN owners         o  ON o.id  = pr.owner_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL
      LIMIT 1`,
    [hashToken(token)],
  );
  if (res.rowCount === 0) return { ok: false, reason: "unauthorized" };
  const r = res.rows[0];
  // Deliberate non-payment block (016). Comped owners are never suspended (defense in depth: ignore
  // a stray flag on a comped account).
  if (r.suspended_at !== null && r.plan !== "comped") return { ok: false, reason: "suspended" };
  const ownerId = Number(r.owner_id);
  // The single identity composition point (decision 018). The qualified actor is the owner handle +
  // participant label; until an owner is backfilled (username NULL) we dual-read the bare label so the
  // live service is never broken. Derived only from the token-resolved row - never from input.
  const handle = r.username;
  const actor = handle ? `${handle}/${r.participant_name}` : r.participant_name;
  return {
    ok: true,
    ctx: {
      project: {
        id: Number(r.project_id),
        slug: r.slug,
        name: r.project_name,
        livenessWindowSec: Number(r.liveness_window_sec),
        ownerId,
      },
      participant: { id: Number(r.participant_id), name: r.participant_name, kind: r.kind, ownerId, handle },
      participation: { id: Number(r.participation_id), isAdmin: r.is_admin, lane: r.lane },
      owner: { id: ownerId, email: r.email },
      actor,
    },
  };
}

/** Back-compat: resolve a token to its Ctx, or null if unauthorized OR suspended. */
export async function authenticate(authorization: string | undefined): Promise<Ctx | null> {
  const r = await authenticateResult(authorization);
  return r.ok ? r.ctx : null;
}
