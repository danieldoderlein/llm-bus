import { createHash } from "node:crypto";
import { query } from "./db.js";
import { loadConfig } from "./config.js";
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
 * One membership row, joined to everything a `Ctx` needs. The SELECT list below (`CTX_COLUMNS`) is the
 * only thing that produces it, and `composeCtx` is the only thing that consumes it - so the token path
 * and the decision-070 project-switch path can never build a subtly different identity.
 */
export interface CtxRow {
  participation_id: string;
  is_admin: boolean;
  lane: string | null;
  human_owner_id: string | null;
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
  bound_handle: string | null;
  suspended_at: string | null;
  plan: "free" | "team" | "comped";
}

/** The SELECT list every Ctx is built from. Assumes the joins aliased pa/pt/pr/o/ho as below. */
export const CTX_COLUMNS = `pa.id AS participation_id, pa.is_admin, pa.lane, pa.human_owner_id,
            pt.id AS participant_id, pt.name AS participant_name, pt.kind,
            pr.id AS project_id, pr.slug, pr.name AS project_name, pr.liveness_window_sec,
            o.id AS owner_id, o.email, o.username, ho.username AS bound_handle, o.suspended_at, o.plan`;

/**
 * The deliberate non-payment block (decision 016), keyed on the PROJECT owner. Comped owners are never
 * suspended (defense in depth: ignore a stray flag on a comped account). BETA_FREE (decision 059) bypasses
 * the gate entirely - during the free beta nobody is blocked (a pre-beta suspended_at is left intact but
 * not enforced). Exported because decision 070 lets one connection act in projects owned by DIFFERENT
 * people, so the gate has to be re-applied against the target project's owner, not just at connect.
 */
export function suspensionBlocked(r: Pick<CtxRow, "suspended_at" | "plan">): boolean {
  if (r.suspended_at === null || r.plan === "comped") return false;
  return !loadConfig().BETA_FREE;
}

/**
 * The single identity composition point (decision 018, refined by 056). The DISPLAY handle prefers the
 * row's BOUND human (participations.human_owner_id) - the same COALESCE(bound, provisioner) the 052/054
 * roster surfaces use - then the PROJECT owner, then the bare label (dual-read until a handle is
 * backfilled). Derived ONLY from a row the server resolved, never from input (invariant 1). NB: the PROJECT
 * owner handle (r.username) becomes ctx.project.ownerHandle (the 044 cross-project qualifier), and
 * ctx.owner / billing / the suspension gate stay keyed on the project owner (decisions 016/044) - only the
 * DISPLAYED/written actor identity moves to the bound human.
 */
export function composeCtx(r: CtxRow): Ctx {
  const ownerId = Number(r.owner_id);
  const handle = r.bound_handle ?? r.username;
  const actor = handle ? `${handle}/${r.participant_name}` : r.participant_name;
  return {
    project: {
      id: Number(r.project_id),
      slug: r.slug,
      name: r.project_name,
      livenessWindowSec: Number(r.liveness_window_sec),
      ownerId,
      ownerHandle: r.username, // the PROJECT owner's handle (o.username joined on pr.owner_id); with slug -> the qualifier (044)
    },
    participant: { id: Number(r.participant_id), name: r.participant_name, kind: r.kind, ownerId, handle },
    participation: {
      id: Number(r.participation_id),
      isAdmin: r.is_admin,
      lane: r.lane,
      humanOwnerId: r.human_owner_id === null ? null : Number(r.human_owner_id),
    },
    owner: { id: ownerId, email: r.email },
    actor,
  };
}

/**
 * Resolve a bearer token to its full v2 context in one query:
 * token -> participation -> project (+ participant + owner).
 * Returns "unauthorized" if missing/invalid/revoked; "suspended" if the (non-comped) owner is
 * suspended for non-payment (decision 016 - a READ-before-action gate; the atomic claim is never
 * entered). Sub-agents sharing a token resolve to the same participation (the v1 invariant survives).
 * The membership this resolves to is the connection's DEFAULT project; decision 070 lets a call name
 * another one the same identity holds (see domain/projects.ts), never one it does not.
 */
export async function authenticateResult(authorization: string | undefined): Promise<AuthResult> {
  const token = extractBearer(authorization);
  if (!token) return { ok: false, reason: "unauthorized" };
  const res = await query<CtxRow>(
    `SELECT ${CTX_COLUMNS}
       FROM tokens t
       JOIN participations pa ON pa.id = t.participation_id
       JOIN participants   pt ON pt.id = pa.participant_id
       JOIN projects       pr ON pr.id = pa.project_id
       JOIN owners         o  ON o.id  = pr.owner_id
       LEFT JOIN owners     ho ON ho.id = pa.human_owner_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
      LIMIT 1`,
    [hashToken(token)],
  );
  if (res.rowCount === 0) return { ok: false, reason: "unauthorized" };
  const r = res.rows[0];
  if (suspensionBlocked(r)) return { ok: false, reason: "suspended" };
  return { ok: true, ctx: composeCtx(r) };
}

/** Back-compat: resolve a token to its Ctx, or null if unauthorized OR suspended. */
export async function authenticate(authorization: string | undefined): Promise<Ctx | null> {
  const r = await authenticateResult(authorization);
  return r.ok ? r.ctx : null;
}

/**
 * Re-read a participation's CURRENT admin flag from the DB, ignoring the connect-time snapshot.
 * An established MCP session reuses the ctx built when it connected (http.ts `buildServer(ctx)`), so
 * `ctx.participation.isAdmin` goes stale the moment the owner grants or revokes admin. Admin-gated
 * tools call this at the gate so the change takes effect on the NEXT tool call - no reconnect. A
 * missing participation (deleted) resolves to false: fail CLOSED for admin. Identity still comes from
 * the token (the id was resolved from it at connect and re-checked per request in http.ts); this only
 * refreshes the privilege bit, never widens scope.
 */
export async function liveIsAdmin(participationId: number): Promise<boolean> {
  const res = await query<{ is_admin: boolean }>(
    `SELECT is_admin FROM participations WHERE id = $1`,
    [participationId],
  );
  return res.rowCount === 1 ? res.rows[0].is_admin : false;
}
