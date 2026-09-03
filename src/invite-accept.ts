import type pg from "pg";
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

/** Derive a readable AGENT-seat name from a verified email local-part. No "human-" prefix (decision 057):
 *  the seat is an agent, and a "human-<name>" label reads as the very fiction 057 retired (and as the
 *  qualified actor "<handle>/human-<name>" post-056). Collision with an existing same-named agent falls back
 *  to grantParticipation's ON CONFLICT reuse (unchanged; an invitee can also be given an explicit name). */
function deriveName(email: string): string {
  const local =
    email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 56) || "guest";
  return local.slice(0, MAX_NAME);
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
    lane?: string | null;
    isAdmin?: boolean;
    targetEmail?: string | null;
    ttlHours?: number;
  } = {},
): Promise<{ token: string; expiresAt: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const token = randomBytes(32).toString("base64url");
  const name = validName(opts.intendedName);
  // Decision 057: an invite always provisions an AGENT seat. Human-ness is carried by the project_members
  // row stamped on accept (finalizeAccept), never a "human"-kind participation - eliminating the orphan
  // human-<name> placeholder rows the old person/agent choice created (037/038/056 lineage).
  const kind = "agent";
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

/**
 * Mint (or upsert) a participant + participation + bearer token under the PROJECT owner's namespace,
 * inside the caller's transaction (the caller holds any FOR UPDATE lock, so concurrent callers mint
 * exactly once). Shared by acceptInvite and the request-to-join approve path so both grant
 * identically and race-safely. Only token_hash is stored (invariant 7). Because the participant lives
 * under projectOwnerId, the joiner/requester gains no admin over a project they do not own
 * (invariant 3). Returns the plaintext token once.
 */
/** A seat name already held by a different human in this project (decision 068). */
export class SeatNameTakenError extends Error {
  constructor(public readonly seatName: string) {
    super(`participant name "${seatName}" is already in use in this project by someone else`);
    this.name = "SeatNameTakenError";
  }
}

export async function grantParticipation(
  c: pg.PoolClient,
  projectOwnerId: number,
  projectId: number,
  name: string,
  lane: string | null,
  isAdmin: boolean,
  tokenLabel: string,
  humanOwnerId: number | null = null,
): Promise<{ participantId: number; participationId: number; token: string; created: boolean }> {
  // Decision 057: the seat is ALWAYS an agent, enforced here at the accept boundary (not just at mint) so a
  // pre-057 invite that stored kind='human' still resolves to an agent seat. Human-ness is the humanOwnerId
  // driver + the project_members row the caller writes, never participants.kind.
  // REFUSE A NAME THAT IS ALREADY SOMEONE ELSE'S SEAT IN THIS PROJECT (decision 068).
  //
  // Before this, `ON CONFLICT DO NOTHING` below silently REUSED an existing participant, and the
  // participation upsert then stamped the accepter as `human_owner_id` on a row that already had a live
  // token. Because the qualified actor derives from the BOUND human (038/052/054/056), an existing agent's
  // UNCHANGED bearer token started authenticating as a DIFFERENT PERSON's actor - identity transferred by
  // a third party's action, which is exactly what invariant 1 exists to prevent. Reported from the imeo
  // project: an admin invited a teammate using the caller's OWN agent name, and after acceptance the
  // original agent's token resolved to alice/imeo-dev-agent, two humans shared one row, and demoting
  // "the new agent" from the web demoted the original lead.
  //
  // Re-acceptance by the SAME human is still idempotent (reconnecting without a fresh invite is the
  // documented path); it is only a DIFFERENT driver that is refused.
  const clash = await c.query<{ human_owner_id: string | null; active_tokens: string }>(
    `SELECT pa.human_owner_id,
            (SELECT count(*)::text FROM tokens t WHERE t.participation_id = pa.id AND t.revoked_at IS NULL) AS active_tokens
       FROM participants pt
       JOIN participations pa ON pa.participant_id = pt.id AND pa.project_id = $3
      WHERE pt.owner_id = $1 AND pt.name = $2`,
    [projectOwnerId, name, projectId],
  );
  if (clash.rowCount && clash.rows[0]) {
    const existingDriver = clash.rows[0].human_owner_id === null ? null : Number(clash.rows[0].human_owner_id);
    const sameHuman = existingDriver !== null && humanOwnerId !== null && existingDriver === humanOwnerId;
    if (!sameHuman) throw new SeatNameTakenError(name);
  }

  const ins = await c.query<{ id: string }>(
    `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, 'agent')
     ON CONFLICT (owner_id, name) DO NOTHING
     RETURNING id`,
    [projectOwnerId, name],
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

  // human_owner_id records which human drives this participation, so the OAuth consent picker can
  // enumerate a returning user's memberships (decision 024). COALESCE on conflict so a re-grant never
  // clears an existing driver. Read ONLY by the AS authorize flow; admin scoping is unchanged (inv 3).
  const participation = await c.query<{ id: string }>(
    `INSERT INTO participations (participant_id, project_id, lane, is_admin, human_owner_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (participant_id, project_id)
       DO UPDATE SET is_admin = participations.is_admin OR $4,
                     lane = COALESCE(EXCLUDED.lane, participations.lane),
                     human_owner_id = COALESCE(participations.human_owner_id, EXCLUDED.human_owner_id)
     RETURNING id`,
    [participantId, projectId, lane, isAdmin, humanOwnerId],
  );
  const participationId = Number(participation.rows[0].id);

  const token = randomBytes(32).toString("base64url");
  await c.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, $3)`, [
    participationId,
    hashToken(token),
    tokenLabel,
  ]);

  return { participantId, participationId, token, created };
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
      participationId: number;
    }
  | { ok: false; error: "invalid" | "expired" | "revoked" | "already_accepted" | "email_mismatch" | "name_taken"; seatName?: string };

// The locked invite row shared by both accept paths (by-token and by-id).
interface LockedInvite {
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
}

const INVITE_COLS = `i.id, i.project_id, pr.owner_id, pr.slug AS project_slug, pr.name AS project_name,
              i.role_is_admin, i.intended_name, i.kind, i.lane, i.target_email, i.state, i.expires_at`;

/**
 * Finalize acceptance of an already-locked invite row against a verified email. Validates
 * state/expiry/email, resolves the accepter's owner (self-serve signup + audit), upserts the
 * participant + participation under the PROJECT owner (recording the accepter as human_owner_id so
 * the OAuth picker can re-enumerate it), mints a bearer token, and flips pending -> accepted. Shared
 * by acceptInvite (email link) and acceptInviteById (OAuth consent picker).
 */
async function finalizeAccept(
  c: pg.PoolClient,
  iv: LockedInvite,
  vemail: string,
): Promise<AcceptResult> {
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

  // The participant lives under the PROJECT owner's namespace (the accepter's agent coordinates in the
  // project via its token). The accepter is stamped as the human_owner_id driver so they can reconnect via
  // OAuth without a fresh invite, and (decision 037) is recorded as a project MEMBER just below - which
  // grants them their membership-scoped rows on the /admin/tasks board, but no owner-level access.
  const projectOwnerId = Number(iv.owner_id);
  const name = validName(iv.intended_name) ?? deriveName(vemail);

  let grant: Awaited<ReturnType<typeof grantParticipation>>;
  try {
    grant = await grantParticipation(
      c,
      projectOwnerId,
      Number(iv.project_id),
      name,
      iv.lane,
      iv.role_is_admin,
      "invite",
      accepterOwnerId,
    );
  } catch (e) {
    // A seat name already driven by someone else (decision 068). Surfaced as a typed refusal rather than a
    // 500, so the invitee is told what to do and the invite stays usable with a different name. The invite
    // is NOT consumed - the throw rolls the transaction back, mirroring the open-invite name_taken path.
    if (e instanceof SeatNameTakenError) return { ok: false, error: "name_taken", seatName: e.seatName };
    throw e;
  }

  // Decision 037: the accepting human becomes a first-class MEMBER of the project (role 'member'), so tasks
  // can be assigned to them (human:<handle>) and they drive the tasks assigned to them on their cross-project
  // /admin/tasks board (decision 039). Same transaction as the grant; idempotent (re-accept is a no-op).
  await c.query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (project_id, owner_id) DO NOTHING`,
    [Number(iv.project_id), accepterOwnerId],
  );

  const flip = await c.query(
    `UPDATE invites SET state = 'accepted', accepted_by = $2 WHERE id = $1 AND state = 'pending'`,
    [iv.id, accepterOwnerId],
  );
  if ((flip.rowCount ?? 0) === 0) return { ok: false, error: "already_accepted" };

  return {
    ok: true,
    token: grant.token,
    projectSlug: iv.project_slug,
    projectName: iv.project_name,
    participant: name,
    isAdmin: iv.role_is_admin,
    created: grant.created,
    participationId: grant.participationId,
  };
}

/**
 * Accept an invite with a verified email. Resolves project + role SERVER-SIDE from the token hash
 * (never from caller input), locks the invite row, and finalizes acceptance in one transaction.
 */
export async function acceptInvite(rawToken: string, verifiedEmail: string): Promise<AcceptResult> {
  if (!rawToken) return { ok: false, error: "invalid" };
  const vemail = verifiedEmail.trim().toLowerCase();
  if (!vemail) return { ok: false, error: "invalid" };
  const tokenHash = hashToken(rawToken);
  return withTx(async (c) => {
    const r = await c.query<LockedInvite>(
      `SELECT ${INVITE_COLS}
         FROM invites i JOIN projects pr ON pr.id = i.project_id
        WHERE i.token_hash = $1
        FOR UPDATE OF i`,
      [tokenHash],
    );
    if (r.rowCount === 0) return { ok: false, error: "invalid" };
    return finalizeAccept(c, r.rows[0], vemail);
  });
}

/**
 * Accept an invite by its id for the OAuth consent picker, where the raw token is not in hand (only
 * its hash is stored). Strictly limited to TARGETED invites whose target_email matches the verified
 * email - the same email check that guards the token path, so an untargeted or wrong-email invite can
 * never be accepted this way. The caller must have SSO-verified `verifiedEmail`.
 */
export async function acceptInviteById(inviteId: number, verifiedEmail: string): Promise<AcceptResult> {
  if (!Number.isFinite(inviteId)) return { ok: false, error: "invalid" };
  const vemail = verifiedEmail.trim().toLowerCase();
  if (!vemail) return { ok: false, error: "invalid" };
  return withTx(async (c) => {
    const r = await c.query<LockedInvite>(
      `SELECT ${INVITE_COLS}
         FROM invites i JOIN projects pr ON pr.id = i.project_id
        WHERE i.id = $1
        FOR UPDATE OF i`,
      [inviteId],
    );
    if (r.rowCount === 0) return { ok: false, error: "invalid" };
    const iv = r.rows[0];
    // A by-id accept requires a targeted invite whose email matches (never an untargeted /join-style
    // invite - those are redeemed by holding the token, not by id).
    if (!iv.target_email || iv.target_email.toLowerCase() !== vemail) {
      return { ok: false, error: "email_mismatch" };
    }
    return finalizeAccept(c, iv, vemail);
  });
}
