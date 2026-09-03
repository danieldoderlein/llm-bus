import type http from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";

// Per-session CSRF store, mirroring the http.ts sessions pattern: an in-memory Map with a
// periodic sweeper whose interval is unref()'d so it never keeps the process alive. A session
// is a browser-scoped opaque id (the cookie) bound to a single-use-per-session CSRF token that
// every POST form must echo back. This is double-submit-cookie CSRF: the secret lives in the
// session map (server side), the cookie only carries the session id.

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const SESSION_SWEEP_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 5000;

/** A validated OAuth-AS /authorize request, stashed on the session so the flow survives an SSO
 *  round-trip and so the consent POST reads the client's parameters from the TRUSTED session, never
 *  from tamperable form fields (decision 024). */
export interface AsAuthorize {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null; // the client's opaque state, echoed back verbatim
  scope: string;
}

interface AdminSession {
  csrf: string;
  expires: number;
  // Set after a successful in-app OAuth login (ADMIN_AUTH_SOURCE=oauth). The verified owner email.
  email?: string;
  // In-flight OAuth handshake state, bound to this session (CSRF for the callback).
  oauth?: { provider: string; state: string; inviteToken?: string };
  // The local /admin* path the user was heading to when the login guard bounced them to /admin/login.
  // Stashed at the guard (resolveIdentity) and honored once at the OAuth callback so sign-in returns
  // them where they were going instead of always /admin. Sanitized by safeAdminReturn (the open-redirect
  // guard) BEFORE it is written here; single-use (cleared on the next successful sign-in).
  returnTo?: string;
  // In-flight OAuth-AS /authorize request (the connector consent dance), bound to this session.
  asAuthorize?: AsAuthorize;
  // Notification-settings owner, bound after the digest magic-link sig verified (decision 025). Lets the
  // sig-bearing GET 302 to a sig-free URL so the HMAC never reaches a GA page_location.
  notifyOwnerId?: number;
  // Landing A/B variant (decision 027, gap-B) captured from the UNTRUSTED `llmbus_variant` query param
  // and enum-validated. Persisted to a newly-created owner as write-only conversion metadata; NEVER
  // read into identity/authz/scoping (invariant 1).
  landingVariant?: LandingVariant;
  // Acquisition channel (decision 031, task #114) captured from the UNTRUSTED `via` query param and
  // sanitized to [a-z0-9._-]{1,64}. Same posture as landingVariant: write-once conversion metadata on a
  // newly-created owner; NEVER read into identity/authz/scoping (invariant 1).
  acquisitionChannel?: string;
}

export type LandingVariant = "everyone" | "dev";

/** Validate the untrusted `llmbus_variant` query param to the closed enum, or null. */
export function asLandingVariant(s: string | null | undefined): LandingVariant | null {
  return s === "everyone" || s === "dev" ? s : null;
}

/** Sanitize the untrusted `via` (acquisition channel) query param: lowercased, bounded charset +
 *  length, else null. Bounds cardinality and pins the stored value to a charset with no HTML
 *  metacharacters (defense in depth beneath esc() at the operator-console render). */
export function asChannel(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(v) ? v : null;
}

const sessions = new Map<string, AdminSession>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expires <= now) sessions.delete(sid);
  }
}, SESSION_SWEEP_MS);
sweeper.unref();

const isProd = (): boolean => process.env.NODE_ENV === "production";

/**
 * Cookie name. In production we use the `__Host-` prefix (which the browser only honors with
 * Secure + Path=/ and no Domain), giving the strongest binding. Locally (NODE_ENV!=="production")
 * we drop the prefix and Secure so the cookie works over plain http on 127.0.0.1.
 */
export function cookieName(): string {
  return isProd() ? "__Host-yolo_admin" : "yolo_admin";
}

/** Parse the admin session id out of a Cookie header, if present. */
export function readSessionId(req: http.IncomingMessage): string | null {
  const raw = req.headers["cookie"];
  if (!raw) return null;
  const name = cookieName();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Build the Set-Cookie value for a session id, with prod/dev-appropriate attributes. */
function buildCookie(sid: string): string {
  // In OAuth mode the provider redirects back via a cross-site top-level navigation, which a
  // SameSite=Strict cookie would not accompany - so the callback would lose its session. Lax sends
  // the cookie on top-level GET navigations while still blocking cross-site POST; combined with the
  // per-session CSRF token it is the standard secure choice. Header (oauth2-proxy) mode keeps Strict.
  const sameSite = loadConfig().ADMIN_AUTH_SOURCE === "oauth" ? "Lax" : "Strict";
  const attrs = [
    `${cookieName()}=${encodeURIComponent(sid)}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Path=/",
  ];
  if (isProd()) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * Task-board filter preference (decision 058, refines 050 / task #611). The operator's board default
 * is "my tasks across all projects"; once they narrow by project and/or assignee we persist that
 * selection so it sticks across visits, deploys, and session expiry - "stick as far as possible".
 * This reuses decision 027's client-held nav-cookie pattern (the `aud` cookie): a validated,
 * server-set / server-read cookie that is NEVER identity or authz (invariant 1) - it only drives a
 * render-level narrowing of the already membership-scoped board (invariant 3). Same prod/dev binding
 * as the session cookie (`__Host-` + Secure in prod, bare over plain http on 127.0.0.1 in dev).
 */
export function boardFilterCookieName(): string {
  return isProd() ? "__Host-yolo_board" : "yolo_board";
}

/** Validate the untrusted board assignee filter: "" (Everyone), "@me" (my tasks), or an exact
 *  assignee handle (`handle/label` or a bare username). Bounds cardinality and pins the value to a
 *  charset with no HTML metacharacters (defense in depth beneath the esc()'d <select> render,
 *  invariant 4). Any other value -> null (treated as unset). Mirrors asChannel. */
export function asBoardAssignee(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  if (s === "" || s === "@me") return s;
  return /^[A-Za-z0-9._/-]{1,64}$/.test(s) ? s : null;
}

/** Parse the board-filter preference cookie off the request, or null when it is absent (the "no
 *  preference expressed yet" signal that lets the caller apply the @me default). Both fields are
 *  validated on read: a non-finite project id or an out-of-charset assignee is dropped, never
 *  trusted (the id still flows through the membership-scoped query, so a forged one yields nothing). */
export function readBoardFilter(
  req: http.IncomingMessage,
): { project?: number; assignee?: string } | null {
  const raw = req.headers["cookie"];
  if (!raw) return null;
  const name = boardFilterCookieName();
  let value: string | null = null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      value = decodeURIComponent(part.slice(eq + 1).trim());
      break;
    }
  }
  if (value === null) return null;
  const p = new URLSearchParams(value);
  const pref: { project?: number; assignee?: string } = {};
  const projRaw = p.get("project");
  if (projRaw && Number.isInteger(Number(projRaw))) pref.project = Number(projRaw);
  const asg = asBoardAssignee(p.get("assignee"));
  if (asg !== null) pref.assignee = asg;
  return pref;
}

/** Build the Set-Cookie value persisting the board filter (project + assignee). A client-held nav
 *  pref (decision 027 `aud` precedent): HttpOnly (server-only reads), SameSite=Lax, Path=/, a
 *  one-year Max-Age so it survives deploys/session expiry, Secure in prod (required by `__Host-`). */
export function boardFilterCookie(projectId: number | undefined, assignee: string): string {
  const p = new URLSearchParams();
  if (projectId !== undefined) p.set("project", String(projectId));
  p.set("assignee", assignee);
  const attrs = [
    `${boardFilterCookieName()}=${encodeURIComponent(p.toString())}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=31536000",
  ];
  if (isProd()) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * Ensure the request has a live session: reuse a valid existing one, otherwise mint a new id +
 * CSRF token and return its Set-Cookie header. Returns the session id, its CSRF token, and an
 * optional Set-Cookie value the handler should attach when a new/refreshed cookie is issued.
 */
export function ensureSession(req: http.IncomingMessage): {
  sid: string;
  csrf: string;
  setCookie?: string;
} {
  const existing = readSessionId(req);
  if (existing) {
    const s = sessions.get(existing);
    if (s && s.expires > Date.now()) {
      return { sid: existing, csrf: s.csrf };
    }
  }

  // New session. Bound the map so a flood of cookie-less requests can't exhaust memory.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  const sid = randomUUID();
  const csrf = randomUUID();
  sessions.set(sid, { csrf, expires: Date.now() + SESSION_TTL_MS });
  return { sid, csrf, setCookie: buildCookie(sid) };
}

/** The CSRF token bound to a session id, or null if unknown/expired. */
export function getCsrf(sid: string): string | null {
  const s = sessions.get(sid);
  if (!s || s.expires <= Date.now()) return null;
  return s.csrf;
}

// ── OAuth-session helpers (used only when ADMIN_AUTH_SOURCE=oauth) ──

function live(sid: string): AdminSession | null {
  const s = sessions.get(sid);
  return s && s.expires > Date.now() ? s : null;
}

/** The verified owner email established by an OAuth login on this session, or null. */
export function getSessionEmail(sid: string): string | null {
  return live(sid)?.email ?? null;
}

/** Record the verified owner email after a successful OAuth callback. */
export function setSessionEmail(sid: string, email: string): void {
  const s = live(sid);
  if (s) s.email = email;
}

/** Stash the in-flight OAuth handshake state (provider + CSRF state + optional invite token). */
export function setOauthState(sid: string, state: AdminSession["oauth"]): void {
  const s = live(sid);
  if (s) s.oauth = state;
}

/** Read the in-flight OAuth handshake state for this session, or null. */
export function getOauthState(sid: string): AdminSession["oauth"] | null {
  return live(sid)?.oauth ?? null;
}

/** Clear the in-flight OAuth handshake state (single-use). */
export function clearOauthState(sid: string): void {
  const s = live(sid);
  if (s) s.oauth = undefined;
}

// ── Notification-settings magic-link exchange (decision 025) ──
// The digest settings link carries an HMAC sig in the URL. To keep that secret out of any GA-captured
// page_location, the sig-bearing GET stashes the owner id here and 302s to a sig-free /notifications; the
// rendered page + its POST then read the owner from the session, never from the URL.

/** Bind this session to a notification-settings owner (after the sig verified). */
export function setNotifyOwner(sid: string, ownerId: number): void {
  const s = live(sid);
  if (s) s.notifyOwnerId = ownerId;
}

/** The notification-settings owner bound to this session, or null. */
export function getNotifyOwner(sid: string): number | null {
  return live(sid)?.notifyOwnerId ?? null;
}

/** Drop the authenticated email from a session (logout). */
export function clearSessionEmail(sid: string): void {
  const s = live(sid);
  if (s) s.email = undefined;
}

// ── Landing A/B variant capture (decision 027, gap-B) ──
// Stashed at the admin entry when a validated `llmbus_variant` is present, so it survives the redirect
// to /admin/login + the SSO round-trip and reaches the owner-creating callback. Write-only metadata.

/** Record the (already enum-validated) landing variant for this session. */
export function setLandingVariant(sid: string, variant: LandingVariant): void {
  const s = live(sid);
  if (s) s.landingVariant = variant;
}

/** The landing variant bound to this session, or null. */
export function getLandingVariant(sid: string): LandingVariant | null {
  return live(sid)?.landingVariant ?? null;
}

// ── Acquisition channel capture (decision 031, task #114) ──
// Stashed at the admin entry when a validated `via` is present, so it survives the redirect to
// /admin/login + the SSO round-trip and reaches the owner-creating callback. Same mechanism as the
// landing variant above; write-once conversion metadata.

/** Record the (already sanitized) acquisition channel for this session. */
export function setChannel(sid: string, channel: string): void {
  const s = live(sid);
  if (s) s.acquisitionChannel = channel;
}

/** The acquisition channel bound to this session, or null. */
export function getChannel(sid: string): string | null {
  return live(sid)?.acquisitionChannel ?? null;
}

// ── OAuth-AS authorize payload (the connector consent dance) ──

/** Stash a validated /authorize request so it survives the SSO round-trip. */
export function setAsAuthorize(sid: string, payload: AsAuthorize): void {
  const s = live(sid);
  if (s) s.asAuthorize = payload;
}

/** Read the in-flight /authorize request for this session, or null. */
export function getAsAuthorize(sid: string): AsAuthorize | null {
  return live(sid)?.asAuthorize ?? null;
}

/** Clear the in-flight /authorize request (single-use, on consent or abandonment). */
export function clearAsAuthorize(sid: string): void {
  const s = live(sid);
  if (s) s.asAuthorize = undefined;
}

// ── Login return-path (app-OAuth) ──
// Stashed at the unauth guard (resolveIdentity) when an /admin* request bounces to /admin/login, then
// read + cleared once at the OAuth callback so a signed-in user returns to where they were headed. The
// value is sanitized to a same-origin /admin* path by safeAdminReturn BEFORE it is written here.

/** Stash the (already-sanitized) local return path for this session. */
export function setReturnTo(sid: string, path: string): void {
  const s = live(sid);
  if (s) s.returnTo = path;
}

/** The stashed return path for this session, or null. */
export function getReturnTo(sid: string): string | null {
  return live(sid)?.returnTo ?? null;
}

/** Clear the stashed return path (single-use). */
export function clearReturnTo(sid: string): void {
  const s = live(sid);
  if (s) s.returnTo = undefined;
}
