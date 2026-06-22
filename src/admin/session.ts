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

interface AdminSession {
  csrf: string;
  expires: number;
  // Set after a successful in-app OAuth login (ADMIN_AUTH_SOURCE=oauth). The verified owner email.
  email?: string;
  // In-flight OAuth handshake state, bound to this session (CSRF for the callback).
  oauth?: { provider: string; state: string; inviteToken?: string };
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

/** Drop the authenticated email from a session (logout). */
export function clearSessionEmail(sid: string): void {
  const s = live(sid);
  if (s) s.email = undefined;
}
