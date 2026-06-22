import { randomBytes } from "node:crypto";
import { query, withTx } from "./db.js";
import { hashToken } from "./auth.js";

// Frictionless, OAuth-accepted invites (decision 010, phase 1) for the hosted service. This is the
// in-app analogue of the public /join (join_codes) flow in invite.ts, kept in a separate module so
// the live /join path is never disturbed. Only token_hash is stored (invariant 7). The participant
// is created under the PROJECT owner's namespace (same as /join), so accepting an invite gives the
// joiner a token INTO the project but grants the accepter's own owner account no admin over it
// (invariant 3). created_by/accepted_by are ON DELETE SET NULL (invariant 6).

const MAX_NAME = 64;

function validName(n: string | null | undefined): string | null {
  if (!n) return null;
  const t = n.trim();
  if (!t || t.length > MAX_NAME) return null;
  return t;
}

/** Derive a readable participant name from a verified email local-part. */
function deriveName(email: string): string {
  const local =
    email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 56) || "guest";
  return `human-${local}`.slice(0, MAX_NAME);
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  const n = Math.trunc(v ?? dflt);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
}

/** Mint an org invite (owner-scoped: the project must belong to ownerId). Returns the plaintext
 *  token once; only its hash is stored. */
export async function createOrgInvite(
  ownerId: number,
  projectId: number,
  opts: {
    intendedName?: string | null;
    kind?: "agent" | "human";
    lane?: string | null;
    isAdmin?: boolean;
    targetEmail?: string | null;
    ttlHours?: number;
  } = {},
): Promise<{ token: string; expiresAt: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const token = randomBytes(32).toString("base64url");
  const name = validName(opts.intendedName);
  const kind = opts.kind === "human" ? "human" : "agent";
  const lane = opts.lane && opts.lane.trim() ? opts.lane.trim() : null;
  const isAdmin = opts.isAdmin === true;
  const targetEmail = opts.targetEmail && opts.targetEmail.trim() ? opts.targetEmail.trim().toLowerCase() : null;
  const ttl = clampInt(opts.ttlHours, 1, 720, 168);
  const res = await query<{ expires_at: string }>(
    `INSERT INTO invites (token_hash, project_id, role_is_admin, intended_name, lane, kind, target_email, expires_at)
     SELECT $1, pr.id, $3, $4, $5, $6, $7, now() + make_interval(hours => $8)
       FROM projects pr
      WHERE pr.id = $2 AND pr.owner_id = $9
     RETURNING expires_at`,
    [hashToken(token), projectId, isAdmin, name, lane, kind, targetEmail, ttl, ownerId],
  );
  if (res.rowCount === 0) return null; // project not owned
  return { token, expiresAt: new Date(res.rows[0].expires_at).toISOString() };
}

export interface InvitePreview {
  projectName: string;
  intendedName: string | null;
  targetEmail: string | null;
  state: "pending" | "accepted" | "revoked";
  expiresAt: string;
}

/** Resolve an invite by its (raw) token for a server-side preview. Context comes from the token
 *  hash only, never from caller input (the invariant-1 analogue). */
export async function resolveInviteByToken(rawToken: string): Promise<InvitePreview | null> {
  if (!rawToken) return null;
  const res = await query<{
    project_name: string;
    intended_name: string | null;
    target_email: string | null;
    state: "pending" | "accepted" | "revoked";
    expires_at: string;
  }>(
    `SELECT pr.name AS project_name, i.intended_name, i.target_email, i.state, i.expires_at
       FROM invites i JOIN projects pr ON pr.id = i.project_id
      WHERE i.token_hash = $1`,
    [hashToken(rawToken)],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    projectName: r.project_name,
    intendedName: r.intended_name,
    targetEmail: r.target_email,
    state: r.state,
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

export type AcceptResult =
  | {
      ok: true;
      token: string;
      projectSlug: string;
      projectName: string;
      participant: string;
      isAdmin: boolean;
      created: boolean;
    }
  | { ok: false; error: "invalid" | "expired" | "revoked" | "already_accepted" | "email_mismatch" };

/**
 * Accept an invite with a verified email. Resolves project + role SERVER-SIDE from the token hash
 * (never from caller input), then in ONE transaction: resolves the accepter's owner (self-serve
 * signup, audit), upserts the participant under the PROJECT owner, upserts the participation, mints
 * a bearer token, and flips the invite pending -> accepted (the race loser sees already_accepted).
 */
export async function acceptInvite(rawToken: string, verifiedEmail: string): Promise<AcceptResult> {
  if (!rawToken) return { ok: false, error: "invalid" };
  const vemail = verifiedEmail.trim().toLowerCase();
  if (!vemail) return { ok: false, error: "invalid" };
  const tokenHash = hashToken(rawToken);
  return withTx(async (c) => {
    const r = await c.query<{
      id: string;
      project_id: string;
      owner_id: string;
      project_slug: string;
      project_name: string;
      role_is_admin: boolean;
      intended_name: string | null;
      kind: "agent" | "human";
      lane: string | null;
      target_email: string | null;
      state: "pending" | "accepted" | "revoked";
      expires_at: string;
    }>(
      `SELECT i.id, i.project_id, pr.owner_id, pr.slug AS project_slug, pr.name AS project_name,
              i.role_is_admin, i.intended_name, i.kind, i.lane, i.target_email, i.state, i.expires_at
         FROM invites i JOIN projects pr ON pr.id = i.project_id
        WHERE i.token_hash = $1
        FOR UPDATE OF i`,
      [tokenHash],
    );
    if (r.rowCount === 0) return { ok: false, error: "invalid" };
    const iv = r.rows[0];
    if (iv.state === "revoked") return { ok: false, error: "revoked" };
    if (iv.state === "accepted") return { ok: false, error: "already_accepted" };
    if (new Date(iv.expires_at).getTime() <= Date.now()) return { ok: false, error: "expired" };
    if (iv.target_email && iv.target_email.toLowerCase() !== vemail) {
      return { ok: false, error: "email_mismatch" };
    }

    // The accepting human resolves to their own owner (self-serve signup + audit via accepted_by).
    const ownerRes = await c.query<{ id: string }>(
      `INSERT INTO owners (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [vemail],
    );
    const accepterOwnerId = Number(ownerRes.rows[0].id);

    // The participant lives under the PROJECT owner's namespace (isolation: the accepter's own
    // owner account gains no project access; they only receive a token to coordinate in it).
    const projectOwnerId = Number(iv.owner_id);
    const name = validName(iv.intended_name) ?? deriveName(vemail);

    const ins = await c.query<{ id: string }>(
      `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO NOTHING
       RETURNING id`,
      [projectOwnerId, name, iv.kind],
    );
    let participantId: number;
    let created: boolean;
    if (ins.rowCount && ins.rows[0]) {
      participantId = Number(ins.rows[0].id);
      created = true;
    } else {
      const sel = await c.query<{ id: string }>(
        `SELECT id FROM participants WHERE owner_id = $1 AND name = $2`,
        [projectOwnerId, name],
      );
      participantId = Number(sel.rows[0].id);
      created = false;
    }

    const participation = await c.query<{ id: string }>(
      `INSERT INTO participations (participant_id, project_id, lane, is_admin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (participant_id, project_id)
         DO UPDATE SET is_admin = participations.is_admin OR $4,
                       lane = COALESCE(EXCLUDED.lane, participations.lane)
       RETURNING id`,
      [participantId, Number(iv.project_id), iv.lane, iv.role_is_admin],
    );

    const token = randomBytes(32).toString("base64url");
    await c.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, 'invite')`, [
      participation.rows[0].id,
      hashToken(token),
    ]);

    const flip = await c.query(
      `UPDATE invites SET state = 'accepted', accepted_by = $2 WHERE id = $1 AND state = 'pending'`,
      [iv.id, accepterOwnerId],
    );
    if ((flip.rowCount ?? 0) === 0) return { ok: false, error: "already_accepted" };

    return {
      ok: true,
      token,
      projectSlug: iv.project_slug,
      projectName: iv.project_name,
      participant: name,
      isAdmin: iv.role_is_admin,
      created,
    };
  });
}
