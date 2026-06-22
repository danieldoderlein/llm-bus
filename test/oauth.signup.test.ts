import { randomUUID } from "node:crypto";
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
      "is null when unconfigured; resolveOwner+linkProviderIdentity is idempotent (one identity row, stable owner).",
  );
  void closePool();
}

main().catch((err) => {
  console.error("oauth.signup test errored:", err);
  process.exit(1);
});
