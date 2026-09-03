import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, withTx } from "./db.js";
import { hashToken } from "./auth.js";
import type { Config } from "./config.js";

// Minimal, hand-rolled OAuth 2.1 authorization server for the one-click "Add LLM Bus to Claude"
// custom-connector flow (decision 024, amends 010). node:crypto only - no new dependency. The crux:
// an issued access token is a NORMAL `tokens` row with expires_at set, so authenticate() resolves it
// to a Ctx unchanged (invariant 1); refresh tokens live in their own table so they can never resolve
// as a bearer. Codes, access tokens, and refresh tokens are all sha-256-hashed at rest (invariant 7),
// PKCE S256 is mandatory, and redirect_uri is exact-matched to a value the client registered.
//
// The issuer is the ADMIN origin (OAUTH_REDIRECT_BASE), NOT the resource origin (PUBLIC_URL): the
// SSO login, the `__Host-` session cookie, and the consent screen all live there, so the whole
// authorize dance must run same-origin. The protected-resource metadata on PUBLIC_URL advertises
// this issuer. When OAUTH_REDIRECT_BASE is unset (self-host single-host) it collapses to PUBLIC_URL.

const ACCESS_TTL_SEC = 3600; //  1h  - short; the client refreshes
const REFRESH_TTL_SEC = 30 * 24 * 3600; // 30d
const CODE_TTL_SEC = 60; //          60s - single-use, redeemed immediately
const SCOPE = "mcp"; //              single scope in phase 1 (decision 024 non-goals)
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 200;

/** The authorization-server issuer origin (no trailing slash). */
export function asIssuer(config: Config): string {
  return (config.OAUTH_REDIRECT_BASE ?? config.PUBLIC_URL).replace(/\/+$/, "");
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
}

/** RFC 8414 authorization-server metadata. Pure (network-free); the endpoints are issuer-relative.
 *  The authorize endpoint lives under /admin (it needs the admin session + SSO + consent render, all
 *  handled by handleAdmin); /token + /register are stateless top-level routes. RFC 8414 permits any
 *  paths, so the asymmetry is fine as long as each URL is the one actually served. */
export function authServerMetadata(config: Config): AuthServerMetadata {
  const issuer = asIssuer(config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/admin/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], // public PKCE clients; no client secret
  };
}

/**
 * A redirect_uri is allowed only if it is an absolute https URL, or an http loopback URL (RFC 8252
 * native-app pattern). Everything else - custom schemes, javascript:/data:, an embedded credential,
 * or a URL fragment (forbidden by RFC 6749 3.1.2) - is rejected. This is the open-redirect guard: at
 * /authorize we additionally require an EXACT match to a value the client registered, so the redirect
 * target is always one the client itself declared. Pure.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (typeof uri !== "string" || !uri) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false; // no fragment component
  if (u.username || u.password) return false; // no embedded credentials
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    const h = u.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  }
  return false;
}

/**
 * Verify a PKCE code_verifier against a stored S256 challenge in constant time. RFC 7636: the
 * verifier is 43-128 chars of the unreserved set; the challenge is base64url(sha256(verifier)).
 * Pure.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9._~-]+$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name: string | null;
}

export type RegisterResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; error: string; error_description: string };

/** Register a public PKCE client from a DCR request body. Validates + persists redirect_uris. */
export async function registerClient(body: unknown): Promise<RegisterResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.redirect_uris;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "invalid_redirect_uri", error_description: "redirect_uris is required" };
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", error_description: "too many redirect_uris" };
  }
  const uris: string[] = [];
  for (const u of raw) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        error_description: "each redirect_uri must be https or an http loopback URL",
      };
    }
    uris.push(u);
  }
  const clientName =
    typeof b.client_name === "string" && b.client_name.trim()
      ? b.client_name.trim().slice(0, MAX_CLIENT_NAME)
      : null;
  const clientId = randomBytes(24).toString("base64url");
  await query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2, $3)`,
    [clientId, uris, clientName],
  );
  return { ok: true, client: { client_id: clientId, redirect_uris: uris, client_name: clientName } };
}

/** Load a registered client by id, or null. */
export async function loadClient(clientId: string): Promise<RegisteredClient | null> {
  if (!clientId) return null;
  const r = await query<{ redirect_uris: string[]; client_name: string | null }>(
    `SELECT redirect_uris, client_name FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  if (r.rowCount === 0) return null;
  return { client_id: clientId, redirect_uris: r.rows[0].redirect_uris, client_name: r.rows[0].client_name };
}

// ── Authorization codes ──────────────────────────────────────────────────────

/** Mint a single-use authorization code bound to (client, participation, redirect_uri, challenge).
 *  Returns the plaintext code (only its hash is stored). */
export async function mintAuthCode(args: {
  clientId: string;
  participationId: number;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO oauth_codes
       (code_hash, client_id, participation_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'S256', $6, now() + make_interval(secs => $7))`,
    [hashToken(code), args.clientId, args.participationId, args.redirectUri, args.codeChallenge, args.scope ?? SCOPE, CODE_TTL_SEC],
  );
  return code;
}

export interface TokenGrant {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  participationId: number;
}

/** Mint an access token (a `tokens` row with expires_at) + a rotating refresh token, inside a tx. */
async function issueTokens(
  c: import("pg").PoolClient,
  clientId: string,
  participationId: number,
  scope: string,
): Promise<TokenGrant> {
  const accessToken = randomBytes(32).toString("base64url");
  await c.query(
    `INSERT INTO tokens (participation_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [participationId, hashToken(accessToken), `oauth:${clientId}`, ACCESS_TTL_SEC],
  );
  const refreshToken = randomBytes(32).toString("base64url");
  await c.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, participation_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [hashToken(refreshToken), clientId, participationId, REFRESH_TTL_SEC],
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope,
    participationId,
  };
}

export type ExchangeResult = { ok: true; grant: TokenGrant } | { ok: false; error: string };

/**
 * Exchange an authorization code for tokens. In ONE transaction: lock the code row, reject if
 * missing / already consumed (replay) / expired / redirect_uri-mismatched / PKCE-failed, mark it
 * consumed, then issue the access + refresh tokens. Single-use is enforced by the `consumed_at`
 * stamp under `FOR UPDATE`.
 */
export async function redeemAuthCode(
  rawCode: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<ExchangeResult> {
  if (!rawCode || !clientId) return { ok: false, error: "invalid_grant" };
  return withTx(async (c) => {
    const r = await c.query<{
      participation_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string | null;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `SELECT participation_id, redirect_uri, code_challenge, scope, expires_at, consumed_at
         FROM oauth_codes WHERE code_hash = $1 AND client_id = $2 FOR UPDATE`,
      [hashToken(rawCode), clientId],
    );
    if (r.rowCount === 0) return { ok: false, error: "invalid_grant" };
    const row = r.rows[0];
    if (row.consumed_at) return { ok: false, error: "invalid_grant" }; // replay
    if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, error: "invalid_grant" };
    if (row.redirect_uri !== redirectUri) return { ok: false, error: "invalid_grant" };
    if (!verifyPkceS256(codeVerifier, row.code_challenge)) return { ok: false, error: "invalid_grant" };
    await c.query(`UPDATE oauth_codes SET consumed_at = now() WHERE code_hash = $1`, [hashToken(rawCode)]);
    const grant = await issueTokens(c, clientId, Number(row.participation_id), row.scope ?? SCOPE);
    return { ok: true, grant };
  });
}

/** Exchange a refresh token: validate, ROTATE (revoke the old), and re-issue. One transaction. */
export async function redeemRefreshToken(rawRefresh: string, clientId: string): Promise<ExchangeResult> {
  if (!rawRefresh || !clientId) return { ok: false, error: "invalid_grant" };
  return withTx(async (c) => {
    const r = await c.query<{ participation_id: string; expires_at: string; revoked_at: string | null }>(
      `SELECT participation_id, expires_at, revoked_at
         FROM oauth_refresh_tokens WHERE token_hash = $1 AND client_id = $2 FOR UPDATE`,
      [hashToken(rawRefresh), clientId],
    );
    if (r.rowCount === 0) return { ok: false, error: "invalid_grant" };
    const row = r.rows[0];
    if (row.revoked_at) return { ok: false, error: "invalid_grant" };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, error: "invalid_grant" };
    await c.query(`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [hashToken(rawRefresh)]);
    const grant = await issueTokens(c, clientId, Number(row.participation_id), SCOPE);
    return { ok: true, grant };
  });
}

// ── Consent enumeration (who can this verified human connect as) ──────────────

export interface Membership {
  participationId: number;
  projectId: number;
  projectName: string;
  projectSlug: string;
  participantName: string;
  isAdmin: boolean;
}

export interface PendingInviteOption {
  inviteId: number;
  projectName: string;
  intendedName: string | null;
  isAdmin: boolean;
}

/** Participations this human already drives (human_owner_id). Read ONLY by the AS authorize flow -
 *  /admin owner-scoping stays keyed on projects.owner_id (invariant 3). */
export async function listMemberships(humanOwnerId: number): Promise<Membership[]> {
  const r = await query<{
    participation_id: string;
    project_id: string;
    project_name: string;
    slug: string;
    participant_name: string;
    is_admin: boolean;
  }>(
    `SELECT pa.id AS participation_id, pa.is_admin,
            pr.id AS project_id, pr.name AS project_name, pr.slug,
            pt.name AS participant_name
       FROM participations pa
       JOIN projects pr ON pr.id = pa.project_id
       JOIN participants pt ON pt.id = pa.participant_id
      WHERE pa.human_owner_id = $1
      ORDER BY pr.name, pt.name`,
    [humanOwnerId],
  );
  return r.rows.map((x) => ({
    participationId: Number(x.participation_id),
    projectId: Number(x.project_id),
    projectName: x.project_name,
    projectSlug: x.slug,
    participantName: x.participant_name,
    isAdmin: x.is_admin,
  }));
}

/** Pending invites targeted at this verified email (the invited-user win: connect with no pasted
 *  token). Only invites whose target_email matches are listed; picking one accepts it inline. */
export async function listPendingInvitesForEmail(email: string): Promise<PendingInviteOption[]> {
  const e = email.trim().toLowerCase();
  if (!e) return [];
  const r = await query<{
    id: string;
    project_name: string;
    intended_name: string | null;
    role_is_admin: boolean;
  }>(
    `SELECT i.id, pr.name AS project_name, i.intended_name, i.role_is_admin
       FROM invites i JOIN projects pr ON pr.id = i.project_id
      WHERE i.target_email = $1 AND i.state = 'pending' AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [e],
  );
  return r.rows.map((x) => ({
    inviteId: Number(x.id),
    projectName: x.project_name,
    intendedName: x.intended_name,
    isAdmin: x.role_is_admin,
  }));
}

/** Confirm a participation is driven by this human (re-prove before minting a code against it). */
export async function ownsParticipation(humanOwnerId: number, participationId: number): Promise<boolean> {
  if (!Number.isFinite(participationId)) return false;
  const r = await query(
    `SELECT 1 FROM participations WHERE id = $1 AND human_owner_id = $2`,
    [participationId, humanOwnerId],
  );
  return r.rowCount === 1;
}

/**
 * Attach an owner-driven participation for the "create a personal project" consent option, over a
 * project + participant the owner already created (both ownership-guarded in one statement, mirroring
 * admin grant()). Unlike grant() this mints NO standalone token - the OAuth access token issued at
 * /token is the only credential for the connection. Returns the participation id, or null if either
 * id is not owned by `ownerId`.
 */
export async function createOwnerParticipation(
  ownerId: number,
  projectId: number,
  participantId: number,
): Promise<number | null> {
  if (!Number.isFinite(projectId) || !Number.isFinite(participantId)) return null;
  const r = await query<{ id: string }>(
    `INSERT INTO participations (participant_id, project_id, is_admin, human_owner_id)
     SELECT pt.id, pr.id, true, $1
       FROM participants pt, projects pr
      WHERE pt.id = $3 AND pt.owner_id = $1
        AND pr.id = $2 AND pr.owner_id = $1
     ON CONFLICT (participant_id, project_id)
       DO UPDATE SET human_owner_id = COALESCE(participations.human_owner_id, EXCLUDED.human_owner_id)
     RETURNING id`,
    [ownerId, projectId, participantId],
  );
  return r.rowCount ? Number(r.rows[0].id) : null;
}
