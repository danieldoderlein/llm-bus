import "./_setup.js"; // defaults DATABASE_URL to the local test cluster; must run before db.js
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { closePool, getPool } from "../src/db.js";
import type { Config } from "../src/config.js";
import { resolveOwner, linkProviderIdentity } from "../src/admin/owner.js";
import {
  oauthEnabled,
  googleIdentity,
  githubPrimaryEmail,
  beginLogin,
  asProvider,
} from "../src/admin/oauth.js";
import {
  asLandingVariant,
  ensureSession,
  setOauthState,
  setReturnTo,
  getReturnTo,
  getSessionEmail,
} from "../src/admin/session.js";
import { handleAdmin, resolveIdentity, safeAdminReturn } from "../src/admin/handlers.js";

async function landingVariantOf(ownerId: number): Promise<string | null> {
  const r = await getPool().query<{ landing_variant: string | null }>(
    `SELECT landing_variant FROM owners WHERE id = $1`,
    [ownerId],
  );
  return r.rows[0]?.landing_variant ?? null;
}

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

function cfg(overrides: Partial<Config>): Config {
  return {
    ADMIN_AUTH_SOURCE: "oauth",
    PUBLIC_URL: "https://app.example.com",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsec",
    GITHUB_CLIENT_ID: "ghid",
    GITHUB_CLIENT_SECRET: "ghsec",
    ...overrides,
  } as unknown as Config;
}

// ── Minimal http fakes: enough for the redirect assertions (writeHead captures status + Location). ──
function fakeReq(url: string, cookie?: string): http.IncomingMessage {
  return { url, method: "GET", headers: cookie ? { cookie } : {} } as unknown as http.IncomingMessage;
}
interface Captured {
  status?: number;
  headers?: Record<string, string | string[]>;
}
function fakeRes(cap: Captured): http.ServerResponse {
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      cap.status = status;
      cap.headers = headers ?? {};
      res.headersSent = true;
      return res;
    },
    setHeader(_name: string, _value: string | string[]) {
      /* set-cookie etc.; irrelevant to the redirect-target assertions */
    },
    end(_body?: unknown) {
      return res;
    },
  };
  return res as unknown as http.ServerResponse;
}
/** A duck-typed provider response (only `.ok` + `.json()` are read by handleCallback). */
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function main(): Promise<void> {
  // ── oauthEnabled dispatch ──
  check(oauthEnabled(cfg({ ADMIN_AUTH_SOURCE: "oauth" })) === true, "oauthEnabled should be true in oauth mode");
  check(oauthEnabled(cfg({ ADMIN_AUTH_SOURCE: "header" })) === false, "oauthEnabled should be false in header mode");
  check(asProvider("google") === "google" && asProvider("github") === "github" && asProvider("nope") === null, "asProvider");

  // ── Verified-email-only linking (the takeover guard) ──
  check(googleIdentity({ email: "a@x.com", email_verified: true, sub: "s1" })?.email === "a@x.com", "google verified accepted");
  check(googleIdentity({ email: "A@X.com", email_verified: true, sub: "s1" })?.email === "a@x.com", "google email not lowercased");
  check(googleIdentity({ email: "a@x.com", email_verified: false, sub: "s1" }) === null, "google UNVERIFIED must be rejected");
  check(googleIdentity({ email: "a@x.com", sub: "s1" }) === null, "google missing email_verified must be rejected");
  check(googleIdentity({ email: "a@x.com", email_verified: true }) === null, "google missing sub must be rejected");

  check(
    githubPrimaryEmail([
      { email: "second@x.com", primary: false, verified: true },
      { email: "Primary@X.com", primary: true, verified: true },
    ]) === "primary@x.com",
    "github primary+verified should be chosen and lowercased",
  );
  check(githubPrimaryEmail([{ email: "p@x.com", primary: true, verified: false }]) === null, "github primary but UNVERIFIED must be rejected");
  check(githubPrimaryEmail([{ email: "p@x.com", primary: false, verified: true }]) === null, "github verified but non-primary must be rejected");
  check(githubPrimaryEmail([]) === null, "github empty list -> null");

  // ── beginLogin: configured -> URL with the expected params; unconfigured -> null ──
  const url = beginLogin("google", "no-session", cfg({}), {});
  check(typeof url === "string", "beginLogin should return a URL when configured");
  if (typeof url === "string") {
    const u = new URL(url);
    check(u.searchParams.get("client_id") === "gid", "auth URL missing client_id");
    check(u.searchParams.get("redirect_uri") === "https://app.example.com/admin/auth/google/callback", "auth URL redirect_uri");
    check(!!u.searchParams.get("state"), "auth URL missing state");
    check(u.searchParams.get("scope") === "openid email", "auth URL scope");
  }
  check(beginLogin("google", "no-session", cfg({ GOOGLE_CLIENT_ID: undefined }), {}) === null, "beginLogin should be null when unconfigured");

  // ── Self-serve signup idempotency: provider identity links to one owner, stable across re-login ──
  const email = `oauth-${randomUUID().slice(0, 8)}@test.local`;
  const sub = `sub-${randomUUID().slice(0, 8)}`;
  const o1 = await resolveOwner(email);
  await linkProviderIdentity(o1.id, "google", sub, email);
  const o2 = await resolveOwner(email); // a second login
  await linkProviderIdentity(o2.id, "google", sub, email);
  check(o1.id === o2.id, "re-login resolved a different owner id");
  const ids = await getPool().query<{ n: string; owner_id: string }>(
    `SELECT count(*) AS n, max(owner_id) AS owner_id FROM owner_identities WHERE provider = 'google' AND provider_subject = $1`,
    [sub],
  );
  check(ids.rows[0].n === "1", `expected exactly one owner_identities row, got ${ids.rows[0].n}`);
  check(Number(ids.rows[0].owner_id) === o1.id, "owner_identities linked to the wrong owner");

  // ── gap-B (decision 027): first-party landing-variant attribution ──
  // asLandingVariant enum-validates the untrusted query param.
  check(asLandingVariant("dev") === "dev" && asLandingVariant("everyone") === "everyone", "asLandingVariant accepts the enum");
  check(asLandingVariant("Dev") === null && asLandingVariant("' OR 1=1--") === null && asLandingVariant(null) === null && asLandingVariant("") === null, "asLandingVariant rejects anything else -> null");

  // (a) A signup carrying llmbus_variant=dev stamps landing_variant='dev' on FIRST create.
  const devEmail = `oauth-dev-${randomUUID().slice(0, 8)}@test.local`;
  const dev1 = await resolveOwner(devEmail, { landingVariant: "dev" });
  check((await landingVariantOf(dev1.id)) === "dev", "first-create signup should persist landing_variant='dev'");

  // (b) A repeat login (even carrying a DIFFERENT variant) must NOT overwrite - and must resolve the SAME owner.
  const dev2 = await resolveOwner(devEmail, { landingVariant: "everyone" });
  check(dev2.id === dev1.id, "repeat login must resolve the SAME owner (identity from email, not variant)");
  check((await landingVariantOf(dev1.id)) === "dev", "repeat login must NOT overwrite the original landing_variant");
  // ...and a repeat login with no variant likewise leaves it intact.
  await resolveOwner(devEmail);
  check((await landingVariantOf(dev1.id)) === "dev", "a variant-less repeat login must leave landing_variant intact");

  // (c) A missing or garbage variant yields NULL on first create (the handler passes null for garbage).
  const noneEmail = `oauth-none-${randomUUID().slice(0, 8)}@test.local`;
  const none1 = await resolveOwner(noneEmail); // no opts at all
  check((await landingVariantOf(none1.id)) === null, "signup with no variant should leave landing_variant NULL");
  const garbageEmail = `oauth-garbage-${randomUUID().slice(0, 8)}@test.local`;
  // The handler enum-validates first (asLandingVariant('xyz') === null); resolveOwner also re-validates.
  const garbage1 = await resolveOwner(garbageEmail, { landingVariant: asLandingVariant("xyz") });
  check((await landingVariantOf(garbage1.id)) === null, "signup with a garbage variant should leave landing_variant NULL");

  // (d) CRITICAL: the variant never changes the resolved identity. Two different emails stay two owners
  // regardless of variant, and the SAME email with different variants is always ONE owner (proven in b).
  const idA = await resolveOwner(`oauth-idA-${randomUUID().slice(0, 8)}@test.local`, { landingVariant: "dev" });
  const idB = await resolveOwner(`oauth-idB-${randomUUID().slice(0, 8)}@test.local`, { landingVariant: "dev" });
  check(idA.id !== idB.id, "distinct emails must resolve to distinct owners irrespective of a shared variant");

  // ── Login return-path preservation (bugfix: /admin/review -> login -> back to /admin/review) ──

  // (c) safeAdminReturn is the open-redirect guard: only same-origin /admin* targets pass.
  check(safeAdminReturn("/admin") === "/admin", "(c) bare /admin accepted");
  check(safeAdminReturn("/admin/") === "/admin/", "(c) /admin/ accepted");
  check(safeAdminReturn("/admin/review") === "/admin/review", "(c) /admin/review accepted");
  check(safeAdminReturn("/admin?x=1") === "/admin?x=1", "(c) /admin?x=1 accepted");
  check(safeAdminReturn("/admin/review?tab=open") === "/admin/review?tab=open", "(c) nested path + query accepted");
  check(safeAdminReturn("/adminEVIL") === null, "(c) /adminEVIL (prefix trick) rejected");
  check(safeAdminReturn("//evil.com") === null, "(c) //evil.com (protocol-relative) rejected");
  check(safeAdminReturn("//evil.com/admin") === null, "(c) //evil.com/admin rejected");
  check(safeAdminReturn("https://evil.com") === null, "(c) absolute URL rejected");
  check(safeAdminReturn("http://evil.com/admin") === null, "(c) absolute admin URL rejected");
  check(safeAdminReturn("/admin/re\\view") === null, "(c) backslash rejected");
  check(safeAdminReturn("/admin/re\nview") === null, "(c) newline control char rejected");
  check(safeAdminReturn("/admin/re\tview") === null, "(c) tab control char rejected");
  check(safeAdminReturn("/other") === null, "(c) non-admin path rejected");
  check(safeAdminReturn("admin/review") === null, "(c) missing leading slash rejected");
  check(safeAdminReturn("") === null, "(c) empty string rejected");
  check(safeAdminReturn(null) === null, "(c) null rejected");
  check(safeAdminReturn(undefined) === null, "(c) undefined rejected");

  // (a) An unauth /admin* request in oauth mode redirects to /admin/login AND stashes the sanitized returnTo.
  {
    const oauthCfg = cfg({});
    const s = ensureSession(fakeReq("/ignored"));
    const cap: Captured = {};
    const owner = await resolveIdentity(fakeReq("/admin/review?tab=open"), fakeRes(cap), oauthCfg, s.sid, undefined);
    check(owner === null, "(a) unauth oauth request resolves no owner");
    check(cap.status === 302, `(a) expected 302, got ${cap.status}`);
    check(cap.headers?.location === "/admin/login", `(a) expected redirect to /admin/login, got ${String(cap.headers?.location)}`);
    check(getReturnTo(s.sid) === "/admin/review?tab=open", `(a) expected returnTo stashed, got ${String(getReturnTo(s.sid))}`);
  }

  // (b)+(d) Drive the REAL Google callback through handleAdmin (stubbing the provider's token+userinfo
  // fetches) and assert the post-login redirect honors, then falls back from, the stashed return path.
  // handleAdmin reads config from process.env via loadConfig(), so set oauth mode + client creds here.
  process.env.ADMIN_AUTH_SOURCE = "oauth";
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsec";
  const cbEmail = `oauth-ret-${randomUUID().slice(0, 8)}@test.local`;
  const cbSub = `ret-sub-${randomUUID().slice(0, 8)}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const u = String(input);
    if (u.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "AT" });
    if (u.includes("openidconnect.googleapis.com/v1/userinfo"))
      return jsonResponse({ email: cbEmail, email_verified: true, sub: cbSub });
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
  try {
    // (b) a stashed returnTo of /admin/review -> the callback lands there, not on /admin.
    {
      const s = ensureSession(fakeReq("/ignored"));
      setOauthState(s.sid, { provider: "google", state: "ST" });
      setReturnTo(s.sid, "/admin/review");
      const cap: Captured = {};
      await handleAdmin(fakeReq("/admin/auth/google/callback?code=CODE&state=ST", `yolo_admin=${s.sid}`), fakeRes(cap));
      check(cap.status === 302, `(b) expected 302, got ${cap.status}`);
      check(cap.headers?.location === "/admin/review", `(b) callback must honor returnTo, got ${String(cap.headers?.location)}`);
      check(getSessionEmail(s.sid) === cbEmail, "(b) callback establishes the session email");
      check(getReturnTo(s.sid) === null, "(b) returnTo is cleared after use");
    }
    // (d) no stashed returnTo -> the callback still lands on /admin.
    {
      const s = ensureSession(fakeReq("/ignored"));
      setOauthState(s.sid, { provider: "google", state: "ST2" });
      const cap: Captured = {};
      await handleAdmin(fakeReq("/admin/auth/google/callback?code=CODE&state=ST2", `yolo_admin=${s.sid}`), fakeRes(cap));
      check(cap.status === 302, `(d) expected 302, got ${cap.status}`);
      check(cap.headers?.location === "/admin", `(d) no returnTo falls back to /admin, got ${String(cap.headers?.location)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL oauth.signup:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK oauth.signup: oauthEnabled/asProvider dispatch; verified-email-only linking rejects unverified " +
      "Google + non-primary/unverified GitHub; beginLogin builds the authorize URL (state+scope+redirect) and " +
      "is null when unconfigured; resolveOwner+linkProviderIdentity is idempotent (one identity row, stable owner); " +
      "login return-path: safeAdminReturn open-redirect guard, the /admin* guard stashes returnTo, and the callback " +
      "honors it (/admin/review) then falls back to /admin.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("oauth.signup test errored:", err);
  process.exit(1);
});
