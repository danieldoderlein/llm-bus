import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateResult } from "./auth.js";
import { query } from "./db.js";
import { buildServer, type RawCall } from "./mcp.js";
import { PLATFORM_ACTORS_SQL } from "./platform-identity.js";
import { handleAdmin } from "./admin/handlers.js";
import { loadConfig } from "./config.js";
import { waitForWork } from "./domain/wait.js";
import { billingEnabled, defaultVerifier } from "./billing/stripe.js";
import { applyWebhook } from "./billing/index.js";
import { ensureSession, getSessionEmail, getCsrf } from "./admin/session.js";
import { oauthEnabled } from "./admin/oauth.js";
import {
  asIssuer,
  authServerMetadata,
  registerClient,
  redeemAuthCode,
  redeemRefreshToken,
  type TokenGrant,
} from "./oauth-as.js";
import { resolveOwner } from "./admin/owner.js";
import { readForm } from "./admin/router.js";
import { gaHead, cookieBanner } from "./analytics.js";
import { TOKENS } from "./brand.js";

const MAX_BODY_BYTES = 1_000_000;
// Reported by /healthz. Kept in sync with package.json by config.validation - they DRIFTED once
// (2.0.55 shipped while /healthz still said 2.0.54), which made a SUCCESSFUL deploy read as a failed
// one: the version string is the surface a deploy is confirmed on, so a stale one is worse than none.
const VERSION = "2.0.55";

// Web analytics: GA4 via gtag.js, gated on GA_MEASUREMENT_ID. Consent Mode v2 sets analytics_storage
// "denied" by default and the gtag.js script is NOT loaded at all until consent is granted (opt-in,
// EEA-safe) - the cookie banner below loads it and flips consent to "granted" on accept, persisting
// the choice in localStorage. Both strings are empty when GA_MEASUREMENT_ID is unset, so self-host/dev
// render no analytics and no banner. The id is re-validated here against the same strict pattern as
// config.ts (not just at boot) so only a G-XXXX value can ever reach the inline script - the value has
// no quote/bracket characters, closing the HTML-injection surface regardless of how the env is set.
// Analytics markup (decision 021) - the single source is src/analytics.ts. Every HTML page below
// interpolates GA_HEAD in <head> and COOKIE_BANNER before </body>; both are "" when GA is unconfigured.
const GA_HEAD = gaHead();
const COOKIE_BANNER = cookieBanner();
// G-INSTRUMENT (decision 027): the signup_start gtag event is emitted ONLY when GA is configured
// (decision 021 - nothing analytics on self-host / dev / the open engine). The UTM params on the CTAs are
// harmless URL params and stay unconditionally (the no-JS attribution backbone). This fires through the
// shared gtag the chokepoint defines (not a second loader) and is consent-gated by Consent Mode v2.
const GA_ON = GA_HEAD !== "";
const SIGNUP_INSTRUMENT = GA_ON
  ? `
  (function(){
    var v=(document.body.getAttribute('data-aud')||'everyone');
    document.addEventListener('click',function(ev){
      var a=ev.target.closest?ev.target.closest('a[data-cta]'):null;
      if(!a) return;
      if(typeof window.gtag==='function'){
        window.gtag('event','signup_start',{cta:a.getAttribute('data-cta'),landing_variant:v});
      }
    },true);
  })();`
  : "";

// Brand favicon: the simplified v3 mark (hexagon + hub + one outside node) in the teal accent so it
// reads on both light and dark browser tab bars. Served at /favicon.svg; referenced from every <head>.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" fill="none" stroke="#14b8a6" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5"/><circle cx="120" cy="120" r="30" fill="#14b8a6" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6" stroke="none"/></svg>`;

// Brand assets (served from /brand). The mark in its three official treatments + the "Runs on LLM Bus"
// README badge. All hand-authored SVG, no raster deps; the badge is a flat shields-style strip.
const MARK_DUOTONE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" fill="none" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="LLM Bus"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z" stroke="#111315"/><path d="M135,94.02 L174,26.5" stroke="#14b8a6"/><circle cx="120" cy="120" r="30" fill="#14b8a6"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6"/></svg>`;
const MARK_MONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" fill="none" stroke="#111315" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="LLM Bus"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5"/><circle cx="120" cy="120" r="30" fill="#111315" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#111315" stroke="none"/></svg>`;
const MARK_WHITE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" fill="none" stroke="#ffffff" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="LLM Bus"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5"/><circle cx="120" cy="120" r="30" fill="#ffffff" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#ffffff" stroke="none"/></svg>`;
// Badges use Verdana/DejaVu (not the decision-006 system-font token) on purpose: GitHub proxies badge
// SVGs through camo and strips webfonts, so Verdana is the one metric that renders identically
// everywhere - a documented exception for the badge surface only. Geometry + contrast per the marketing
// build spec (badges-spec.md, 2026-07-10): value text is ink #111315 on teal for WCAG AA (8.4:1), the
// mark carries teal, flat rx=4, viewBox for crisp author scaling. See BADGE RULES in src/brand.ts.
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 143 20" width="143" height="20" role="img" aria-label="Runs on LLM Bus"><title>Runs on LLM Bus</title><clipPath id="rr"><rect width="143" height="20" rx="4" fill="#fff"/></clipPath><g clip-path="url(#rr)"><rect width="74" height="20" fill="#111315"/><rect x="74" width="69" height="20" fill="#14b8a6"/></g><g transform="translate(6,4.2) scale(0.052)" fill="none" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z" stroke="#fff"/><path d="M135,94.02 L174,26.5" stroke="#14b8a6"/><circle cx="120" cy="120" r="30" fill="#14b8a6" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6" stroke="none"/></g><g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="25" y="14" fill="#fff">runs on</text><text x="108" y="14" fill="#111315" font-weight="bold" text-anchor="middle">LLM Bus</text></g></svg>`;
// (The per-project "Request to join" badge + its /join-badge.svg asset were removed with decision 038's
// retirement of request-to-join - the badge linked to the now-410 /p/<handle>/<slug> request page.)
// Add-to-Claude CTA button (marketing badges-spec.md, 2026-07-10): the primary connect badge now that
// one-click OAuth is live. "Claude" used nominatively. Links (in the /brand snippets) to the site connect
// destination - the same target as the landing "Add to Claude" CTA (anchor finalized with the landing).
const ADD_TO_CLAUDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 134 28" width="134" height="28" role="img" aria-label="Add to Claude on LLM Bus"><title>Add to Claude on LLM Bus</title><rect width="134" height="28" rx="8" fill="#111315"/><g transform="translate(11,6) scale(0.0667)" fill="none" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z" stroke="#fff"/><path d="M135,94.02 L174,26.5" stroke="#14b8a6"/><circle cx="120" cy="120" r="30" fill="#14b8a6" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6" stroke="none"/></g><g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11.5"><text x="36" y="18.5" fill="#fff" font-weight="bold">Add to Claude</text></g></svg>`;

// Own-venture proof-strip marks (marketing #814, G-LOGO cleared 2026-07-12): inline SVG so the ONE
// `.lgc{color:var(--muted)}` rule greys them all via currentColor (uniform). Fills flattened to
// currentColor; fixed width/height stripped so CSS sets one consistent height. CSP-safe (inline).

// Public brand page served at /brand: the mark, downloads, color/type, and the README badge with
// copy-paste snippets. Same B&W-plus-teal system as the landing/legal pages.

// The public marketing landing (GET /). ONE builder -> two pre-rendered variants; the SERVER sets the body
// class + data-aud, so both are correct with NO JS (served-surface contract). Content = marketing's
// brand-reviewed relaunch-2026-08 (@ 9cec459), landed via src/landing-relaunch.ts (decision 060, refines
// 027). Decision 060 retired the on-page audience TOGGLE (single page) while keeping the ?v=/aud/UTM
// attribution backbone. Chokepoints: ${TOKENS} (026), ${gaHeadVariant}/${COOKIE_BANNER} (021).
function landingDoc(_dev: boolean): string {
  // The hosted service serves a marketing page here. A self-hosted bus does not need one, so this is a
  // plain index that says what the server is and where to go. It still routes through the decision-021
  // analytics chokepoint (inert here) and the shared token module, so adding your own page later does
  // not mean re-plumbing anything.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Bus</title>
${gaHead()}
<style>${TOKENS}
  body{font:16px/1.6 var(--font);color:var(--ink);background:var(--bg);margin:0;padding:3rem 1.25rem}
  main{max-width:38rem;margin:0 auto}
  h1{font-size:1.6rem;margin:0 0 .25rem}
  p.sub{color:var(--ink-soft);margin:0 0 2rem}
  code{font-family:var(--mono);background:var(--bg-soft);padding:.15em .4em;border-radius:4px}
  a{color:var(--accent)}
  ul{padding-left:1.1rem}
</style>
</head>
<body><main>
<h1>LLM Bus</h1>
<p class="sub">A coordination server for AI agents, over MCP. This instance is self-hosted.</p>
<ul>
  <li><a href="/admin">Admin</a> - projects, agents, invites, and the task board.</li>
  <li><code>/mcp</code> - the MCP endpoint. Agents connect here with a bearer token.</li>
  <li><code>/healthz</code> - liveness.</li>
</ul>
<p>Source and self-hosting guide: <a href="https://github.com/danieldoderlein/llm-bus">github.com/danieldoderlein/llm-bus</a></p>
</main>${cookieBanner()}</body></html>`;
}
const LANDING_EVERYONE = landingDoc(false);
const LANDING_DEV = landingDoc(true);

// Styled public 404 (task #69, harmonization #810/#811): an unknown web path used to return the bare
// JSON {error:"not found"}, which reads as broken in a browser. This mirrors the public web shell (same
// nav + Sora + footer as the legal pages) and carries the analytics chokepoint (GA_HEAD/COOKIE_BANNER,
// decision 021). Static, so it is a module constant; served only to HTML-accepting GETs (API clients
// keep the JSON error). HEAD is normalized to GET above, so it gets these headers with no body.
const WEB_404_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found - LLM Bus</title>
${GA_HEAD}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  ${TOKENS}
  *{box-sizing:border-box}html,body{overflow-x:hidden}
  body{margin:0;background:#fff;color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;min-height:100vh}
  .wrap{max-width:720px;margin:0 auto;padding:0 24px;width:100%}
  nav{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--line)}
  nav a.brand{display:inline-flex;align-items:center;gap:9px;font-family:var(--font-display);font-weight:700;font-size:17px;color:var(--ink);text-decoration:none}
  nav a.brand svg{width:24px;height:24px}nav .sp{margin-left:auto}nav a.home{color:var(--g6);font-size:15px;text-decoration:none}
  main{flex:1;display:flex;align-items:center;justify-content:center;padding:64px 0}
  .card{text-align:center;max-width:34rem}
  .code{font-family:var(--mono);font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--g5)}
  h1{font-family:var(--font-display);font-size:38px;letter-spacing:-.02em;margin:12px 0 12px;color:var(--ink)}
  p{color:var(--g6);margin:0 0 28px}
  .btn{display:inline-flex;align-items:center;gap:8px;background:var(--teal-600);color:#fff;font-weight:600;padding:11px 20px;border-radius:8px;text-decoration:none}
  .btn:hover{filter:brightness(1.05);text-decoration:none}
  footer{border-top:1px solid var(--line);padding:32px 0;color:var(--g5);font-size:14px}
  footer a{color:var(--g6)}
</style></head><body>
<div class="wrap"><nav><a class="brand" href="/"><svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5" stroke="#14b8a6"/><circle cx="120" cy="120" r="30" fill="#14b8a6" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6" stroke="none"/></svg>LLM&nbsp;Bus</a><span class="sp"></span><a class="home" href="/">Home</a></nav></div>
<main><div class="wrap"><div class="card">
  <div class="code">404</div>
  <h1>Page not found</h1>
  <p>That page doesn't exist - it may have moved or the link was mistyped. Head back home to pick up where you left off.</p>
  <a class="btn" href="/">Back to home</a>
</div></div></main>
${COOKIE_BANNER}
</body></html>`;

// Stateless MCP transport (decision 030): no session state is kept, so there is no session TTL or cap.
// The sweep interval below only expires the public rate-limit windows.
const RATE_SWEEP_MS = 60 * 1000;

// Per-IP rate limit for the public, unauthenticated POST /join (invite redemption).
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const JOIN_MAX_PER_WINDOW = 30;
const joinHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim(); // Caddy sets this
  return req.socket.remoteAddress ?? "unknown";
}

function allowJoin(ip: string): boolean {
  const now = Date.now();
  const w = joinHits.get(ip);
  if (!w || now > w.resetAt) {
    joinHits.set(ip, { count: 1, resetAt: now + JOIN_WINDOW_MS });
    return true;
  }
  if (w.count >= JOIN_MAX_PER_WINDOW) return false;
  w.count++;
  return true;
}

const allowedHosts = process.env.ALLOWED_HOSTS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length ? JSON.parse(raw) : undefined;
}

/** Read an OAuth /token body as key/value params. Standard is form-urlencoded; some clients send
 *  JSON, so accept either. Bounded by MAX_BODY_BYTES via readRawBody. */
async function readTokenParams(req: http.IncomingMessage): Promise<URLSearchParams> {
  const raw = (await readRawBody(req)).toString("utf8");
  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("application/json")) {
    const out = new URLSearchParams();
    const o = raw ? JSON.parse(raw) : {};
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === "string") out.set(k, v);
      }
    }
    return out;
  }
  return new URLSearchParams(raw);
}

/** Shape the public token response (drops the internal participationId from the grant). */
function tokenResponse(g: TokenGrant): Record<string, unknown> {
  return {
    access_token: g.access_token,
    token_type: g.token_type,
    expires_in: g.expires_in,
    refresh_token: g.refresh_token,
    scope: g.scope,
  };
}

/** Read the body as RAW bytes (no JSON parse) - required for Stripe webhook signature verification. */
async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Aggregate, service-wide KPI counts for the public landing page. Cached in-memory for 60s. */
interface LiveStats {
  events: number;
  posts: number;
  ackedPct: number;
  anchoredPct: number;
  projects: number;
  participants: number;
  tokensSaved: number;
}

const STATS_TTL_MS = 60 * 1000;
let statsCache: LiveStats | null = null;
let statsCachedAt = 0;

async function getLiveStats(): Promise<LiveStats> {
  const now = Date.now();
  if (statsCache && now - statsCachedAt < STATS_TTL_MS) return statsCache;
  // When STATS_OWNER_EMAIL is set, scope every count to that owner's projects (our own dogfooding usage);
  // $1 IS NULL keeps the cross-tenant aggregate for self-host / the open engine. `scope` is the set of
  // project ids in view. Parameterized; a missing/unknown email yields an empty scope (all zeros), never
  // a leak of another tenant's data.
  const ownerEmail = loadConfig().STATS_OWNER_EMAIL ?? null;
  const result = await query<{
    projects: string;
    participants: string;
    events: string;
    posts: string;
    acked_pct: string | null;
    anchored_pct: string | null;
  }>(
    `WITH scope AS (
       SELECT id FROM projects
        WHERE $1::text IS NULL OR owner_id = (SELECT id FROM owners WHERE lower(email) = lower($1))
     )
     SELECT
       (SELECT count(*) FROM scope) AS projects,
       (SELECT count(*) FROM participations pa WHERE pa.project_id IN (SELECT id FROM scope)) AS participants,
       (SELECT count(*) FROM events WHERE project_id IN (SELECT id FROM scope) AND actor_name NOT IN ${PLATFORM_ACTORS_SQL}) AS events,
       (SELECT count(*) FROM posts WHERE project_id IN (SELECT id FROM scope) AND from_actor_name NOT IN ${PLATFORM_ACTORS_SQL}) AS posts,
       (SELECT round(100.0*count(*) FILTER (WHERE EXISTS(SELECT 1 FROM post_reads a WHERE a.post_id=p.id))/nullif(count(*),0),1)
          FROM posts p WHERE p.project_id IN (SELECT id FROM scope) AND p.from_actor_name NOT IN ${PLATFORM_ACTORS_SQL}) AS acked_pct,
       (SELECT round(100.0*count(*) FILTER (WHERE ref IS NOT NULL)/nullif(count(*),0),0)
          FROM posts WHERE project_id IN (SELECT id FROM scope) AND from_actor_name NOT IN ${PLATFORM_ACTORS_SQL}) AS anchored_pct`,
    [ownerEmail],
  );
  const r = result.rows[0];
  const posts = Number(r.posts);
  const stats: LiveStats = {
    events: Number(r.events),
    posts,
    ackedPct: Number(r.acked_pct),
    anchoredPct: Number(r.anchored_pct),
    projects: Number(r.projects),
    participants: Number(r.participants),
    tokensSaved: posts * 5000,
  };
  statsCache = stats;
  statsCachedAt = now;
  return stats;
}

/**
 * HTTP surface:
 *   GET  /healthz   -> unauthenticated liveness
 *   POST /mcp       -> MCP over Streamable HTTP; bearer-auth -> Ctx {actor, workspace} on every request
 *   GET/DELETE /mcp -> 405 (stateless transport has no session stream to open or tear down)
 *
 * Stateless (decision 030): each POST /mcp is handled by a fresh transport + server bound to the
 * token-resolved ctx, then torn down. No session is kept in memory, so a deploy/restart or an idle gap
 * never bricks a connected agent - the next request just re-authenticates and works. Identity is derived
 * from the token on every request (invariant 1).
 */
export function createHttpServer(): http.Server {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of joinHits) if (now > w.resetAt) joinHits.delete(ip);
  }, RATE_SWEEP_MS);
  sweeper.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // HEAD: serve it like the matching GET (same status + headers) but never emit a body, per HTTP
      // semantics. Routes only match "GET", so a raw HEAD used to fall through to 404 (broke uptime
      // monitors and link-preview crawlers). Route as GET and drop the body at res.end.
      if (req.method === "HEAD") {
        req.method = "GET";
        const realEnd = res.end.bind(res);
        res.end = function (chunk?: unknown, enc?: unknown, cb?: unknown) {
          const callback = typeof chunk === "function" ? chunk : typeof enc === "function" ? enc : cb;
          return realEnd(typeof callback === "function" ? (callback as () => void) : undefined);
        } as typeof res.end;
      }

      if (req.method === "GET" && url.pathname === "/") {
        // Landing variant attribution (decision 027, retained by 060): ?v=everyone|dev selects a variant and
        // persists it in an `aud` cookie; a return visit without ?v reads the cookie. DEFAULT is everyone (dev
        // only on an explicit ?v=dev or aud=dev). Decision 060 retired the on-page toggle (single brand-reviewed
        // page), so the two variants now serve IDENTICAL content and differ only in the gaHead landing_variant
        // dimension + the CTA UTM - i.e. ?v= is now write-only campaign attribution, not a content A/B.
        const v = url.searchParams.get("v");
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
        let dev: boolean;
        if (v === "everyone" || v === "dev") {
          dev = v === "dev";
          headers["set-cookie"] = `aud=${v}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
        } else {
          dev = /(?:^|;\s*)aud=dev(?:\s*;|\s*$)/.test(req.headers.cookie ?? "");
        }
        res.writeHead(200, headers);
        return res.end(dev ? LANDING_DEV : LANDING_EVERYONE);
      }


      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, service: "llm-bus", version: VERSION });
      }

      // Brand favicon: the v3 mark in teal (theme-agnostic, visible on light and dark tab bars).
      if (req.method === "GET" && url.pathname === "/favicon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        return res.end(FAVICON_SVG);
      }

      {
        const svgAsset: Record<string, string> = {
          "/brand/mark.svg": MARK_DUOTONE,
          "/brand/mark-mono.svg": MARK_MONO,
          "/brand/mark-white.svg": MARK_WHITE,
          "/badge.svg": BADGE_SVG,
          "/add-to-claude.svg": ADD_TO_CLAUDE_SVG,
        };
        const asset = svgAsset[url.pathname];
        if (req.method === "GET" && asset) {
          res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
          return res.end(asset);
        }
      }

      // Public, cached aggregate KPI counts for the landing page (60s in-memory cache).
      if (req.method === "GET" && url.pathname === "/api/stats") {
        try {
          return send(res, 200, await getLiveStats());
        } catch (err) {
          console.error("[llm-bus] stats error:", err);
          return send(res, 503, { error: "stats unavailable" });
        }
      }

      // ── The wake channel (decision 079) ──────────────────────────────────────────────────────────
      // GET /api/wait, bearer-authorized like any MCP call. Holds the request open until THIS caller's
      // own queue is non-empty, then answers with counts only - never content, so the agent still has to
      // read the board and the bus never grows a second inbox.
      //
      // NOT an MCP tool, deliberately: a tool call happens inside a turn and would block it. This is
      // meant to be held by a detached process while no turn is running at all.
      //
      // The cap is short (60s default, 300s ceiling) and that is not a compromise - re-arming costs an
      // HTTP round trip, not a model turn, so a client loops cheaply and still sleeps indefinitely. Short
      // windows also keep proxies, NAT and sleeping laptops from leaving half-open sockets that look
      // exactly like a live listener.
      if (req.method === "GET" && url.pathname === "/api/wait") {
        const auth = await authenticateResult(req.headers.authorization);
        if (!auth.ok) {
          // Same shape as every other refusal here: never an existence oracle (invariant 1).
          return send(res, auth.reason === "suspended" ? 402 : 401, { error: auth.reason });
        }
        const raw = Number(url.searchParams.get("timeout") ?? "60");
        const seconds = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 300) : 60;
        try {
          const r = await waitForWork(auth.ctx, seconds * 1000);
          return send(res, 200, {
            work: r.work,
            tasks: r.tasks,
            unread: r.unread,
            unassigned: r.unassigned,
            project: auth.ctx.project.slug,
            actor: auth.ctx.actor,
            waited_seconds: seconds,
          });
        } catch (err) {
          // Fail LOUD here, unlike most of this file. A wait endpoint that quietly returns "nothing"
          // when its channel is broken is indistinguishable from a quiet bus, and the client would sleep
          // forever believing it was listening. 503 tells the caller to fall back to polling.
          console.error("[llm-bus] wait error:", err);
          return send(res, 503, { error: "wake channel unavailable" });
        }
      }

      // OAuth 2.0 Protected Resource Metadata (RFC 9728). Points MCP clients at our authorization
      // server (decision 024); existing bearer clients never read this. authorization_servers is
      // empty when the AS is off (self-host / header mode), so nothing advertises a dead endpoint.
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
        const cfg = loadConfig();
        const base = cfg.PUBLIC_URL.replace(/\/+$/, "");
        // Public discovery metadata (identical for everyone, meant to be crawled) - CORS-open so
        // browser-based MCP clients can read it.
        return send(
          res,
          200,
          {
            resource: base,
            authorization_servers: oauthEnabled(cfg) ? [asIssuer(cfg)] : [],
            bearer_methods_supported: ["header"],
          },
          { "access-control-allow-origin": "*" },
        );
      }

      // OAuth 2.1 authorization-server metadata (RFC 8414). Only served when the AS is enabled
      // (ADMIN_AUTH_SOURCE=oauth); a self-host without SSO 404s so no dead AS is advertised.
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        const cfg = loadConfig();
        if (!oauthEnabled(cfg)) return send(res, 404, { error: "not_found" });
        return send(res, 200, authServerMetadata(cfg), { "access-control-allow-origin": "*" });
      }

      // Dynamic Client Registration (RFC 7591): a public PKCE client registers its redirect_uris and
      // gets a client_id. Rate-limited (shares the per-IP join bucket). AS-enabled only.
      if (req.method === "POST" && url.pathname === "/register") {
        const cfg = loadConfig();
        if (!oauthEnabled(cfg)) return send(res, 404, { error: "not_found" });
        if (!allowJoin(clientIp(req))) return send(res, 429, { error: "rate limited; try again shortly" });
        let body: unknown;
        try {
          body = await readBody(req);
        } catch {
          return send(res, 400, { error: "invalid_client_metadata", error_description: "unreadable body" });
        }
        const r = await registerClient(body);
        if (!r.ok) return send(res, 400, { error: r.error, error_description: r.error_description });
        return send(res, 201, {
          client_id: r.client.client_id,
          redirect_uris: r.client.redirect_uris,
          ...(r.client.client_name ? { client_name: r.client.client_name } : {}),
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }

      // Token endpoint: authorization_code exchange (with PKCE) + refresh rotation. Rate-limited,
      // never cached. AS-enabled only.
      if (req.method === "POST" && url.pathname === "/token") {
        const cfg = loadConfig();
        if (!oauthEnabled(cfg)) return send(res, 404, { error: "not_found" });
        if (!allowJoin(clientIp(req))) return send(res, 429, { error: "rate limited; try again shortly" });
        const nostore = { "cache-control": "no-store", pragma: "no-cache" };
        let params: URLSearchParams;
        try {
          params = await readTokenParams(req);
        } catch {
          return send(res, 400, { error: "invalid_request" }, nostore);
        }
        const grantType = params.get("grant_type");
        const clientId = params.get("client_id") ?? "";
        if (grantType === "authorization_code") {
          const r = await redeemAuthCode(
            params.get("code") ?? "",
            clientId,
            params.get("redirect_uri") ?? "",
            params.get("code_verifier") ?? "",
          );
          if (!r.ok) return send(res, 400, { error: r.error }, nostore);
          return send(res, 200, tokenResponse(r.grant), nostore);
        }
        if (grantType === "refresh_token") {
          const r = await redeemRefreshToken(params.get("refresh_token") ?? "", clientId);
          if (!r.ok) return send(res, 400, { error: r.error }, nostore);
          return send(res, 200, tokenResponse(r.grant), nostore);
        }
        return send(res, 400, { error: "unsupported_grant_type" }, nostore);
      }

      // Public notification settings + one-click unsubscribe (decision 025), reached from an emailed
      // Web admin (SSO-gated by Caddy/oauth2-proxy; trusts the email header it sets).
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        await handleAdmin(req, res);
        return;
      }

      // Public invite redemption: unauthenticated, scoped + rate-limited by the code + per-IP.
      if (url.pathname === "/join" && req.method === "POST") {
        // Decision 037: the open paste-a-code join path is RETIRED. Every collaborator joins by accepting an
        // emailed invite and signing in (SSO), so their agent binds to THEIR own identity and they become a
        // project member. create_invite (or the owner's Access page) sends a targeted /accept invite.
        const ip = clientIp(req);
        if (!allowJoin(ip)) return send(res, 429, { error: "rate limited; try again shortly" });
        return send(res, 410, {
          ok: false,
          error: "join_by_invite",
          message:
            "Open join codes are retired. Ask the project owner to invite you by email; you will get a " +
            "sign-in link (/accept) that connects your agent under your own identity.",
        });
      }

      // Request-to-join is RETIRED (decision 038, reversing the open-enrollment part of 020): enrollment is
      // targeted-invite-only. The old public request pages (/p/:handle/:slug and .../request) now 410 with a
      // pointer to the email-invite path, mirroring /join above. The join_requests table is retained (dormant)
      // for history; no live path reads or writes it.
      if (/^\/p\/[^/]+\/[^/]+(\/request)?\/?$/.test(url.pathname)) {
        const ip = clientIp(req);
        if (!allowJoin(ip)) return send(res, 429, { error: "rate limited; try again shortly" });
        return send(res, 410, {
          ok: false,
          error: "join_by_invite",
          message:
            "Request-to-join is retired. Ask the project owner to invite you by email; you will get a " +
            "sign-in link (/accept) that connects your agent under your own identity and makes you a member.",
        });
      }

      // Stripe webhook (decision 011): Stripe signs it (no bearer auth); raw body required for
      // constructEvent; idempotent via the stripe_events table. Fail-closed on a bad signature.
      if (url.pathname === "/webhooks/stripe" && req.method === "POST") {
        const cfg = loadConfig();
        const verify = defaultVerifier(cfg);
        if (!billingEnabled(cfg) || !cfg.STRIPE_WEBHOOK_SECRET || !verify) {
          return send(res, 503, { error: "billing disabled" });
        }
        const sig = req.headers["stripe-signature"];
        if (typeof sig !== "string") return send(res, 400, { error: "missing signature" });
        const raw = await readRawBody(req);
        let event: unknown;
        try {
          event = verify(raw, sig, cfg.STRIPE_WEBHOOK_SECRET);
        } catch {
          return send(res, 400, { error: "bad signature" });
        }
        try {
          await applyWebhook(event);
        } catch (err) {
          console.error("[llm-bus] stripe webhook apply error:", err);
          return send(res, 500, { error: "apply failed" }); // Stripe retries; idempotency makes it safe
        }
        return send(res, 200, { received: true });
      }

      if (url.pathname !== "/mcp") {
        // A browser (HTML-accepting GET) gets the styled 404 page through the web shell + analytics
        // chokepoint; API/MCP clients keep the machine-readable JSON error. HEAD was normalized to GET
        // above, so it receives these headers with no body.
        if (req.method === "GET" && (req.headers["accept"] ?? "").includes("text/html")) {
          res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          return res.end(WEB_404_HTML);
        }
        return send(res, 404, { error: "not found" });
      }

      const auth = await authenticateResult(req.headers["authorization"]);
      if (!auth.ok) {
        // Deliberate non-payment block (decision 016): a valid token whose owner is suspended gets a
        // clear 403 + a stable message - NOT a 401 challenge (that would loop OAuth-discovery clients).
        if (auth.reason === "suspended") {
          return send(res, 403, { error: "suspended due to non-payment" });
        }
        const base = loadConfig().PUBLIC_URL.replace(/\/+$/, "");
        const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
      }
      const ctx = auth.ctx;

      // Stateless transport (decision 030): a FRESH transport + server per POST, bound to the
      // token-resolved ctx, torn down when the response closes. No session id is issued and nothing is
      // kept in memory, so a deploy/restart or a >10-min idle gap never bricks a connected agent - the
      // next request just works. Every request already re-authenticates and rebuilds ctx, and the server
      // sends no server-initiated notifications, so a durable session bought nothing. GET/DELETE have no
      // session stream to open or tear down in stateless mode.
      if (req.method !== "POST") {
        return send(res, 405, { error: "method not allowed" });
      }
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      });
      // Capture the argument keys AS SENT, before the SDK's zod parse strips the ones this tool does not
      // declare - that stripping is what makes a misspelled parameter silently succeed (decision 066).
      let rawCall: RawCall | undefined;
      try {
        const b = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
        if (!Array.isArray(body) && b?.method === "tools/call" && typeof b.params?.name === "string") {
          const a = b.params.arguments;
          rawCall = {
            toolName: b.params.name,
            argKeys: a && typeof a === "object" && !Array.isArray(a) ? Object.keys(a) : [],
            // Which hostname this call arrived on, so a caller still using a non-canonical endpoint is told
            // on every call. Advisory only - never used for auth or routing (the Host header is the
            // client's to set; DNS-rebinding protection above is what actually constrains it).
            host: typeof req.headers.host === "string" ? req.headers.host : undefined,
          };
        }
      } catch {
        /* a body we cannot introspect just means no nag - never fail the call for it */
      }
      const mcp = buildServer(ctx, rawCall);
      // Tear down the per-request transport once the response is done. Only close the transport (not
      // mcp.close()): the McpServer holds no background work and is GC'd, and closing it would re-enter
      // the transport close cycle (MCP SDK 1.29.0). close() is idempotent.
      res.on("close", () => {
        void Promise.resolve(transport.close()).catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[llm-bus] request error:", err);
      if (!res.headersSent) send(res, 400, { error: "bad request" });
      else res.end();
    }
  });

  server.on("close", () => clearInterval(sweeper));
  return server;
}
