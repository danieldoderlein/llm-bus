// HTTP-level wiring test for the OAuth AS routes (decision 024). The unit/DB test covers the crypto +
// SQL; this one drives the REAL server so the advertised metadata URLs actually resolve - the gap that
// let an `authorization_endpoint` typo (/authorize vs /admin/authorize) pass the suite once. Also checks
// the fail-open gating (all AS routes 404 in header mode).

import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";

// Configure BEFORE importing the app (config is read from process.env). Point issuer + resource at the
// loopback test host; the port is patched onto these once the server is listening.
process.env.DATABASE_URL ??= `postgres://127.0.0.1:5440/llm_bus`;
process.env.ADMIN_AUTH_SOURCE = "oauth";
process.env.GOOGLE_CLIENT_ID = "test-google-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";

const { createHttpServer } = await import("../src/http.js");
const { closePool } = await import("../src/db.js");

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

async function main(): Promise<void> {
  const server = createHttpServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_URL = base;
  process.env.OAUTH_REDIRECT_BASE = base;

  // 1. AS metadata resolves and advertises real endpoints.
  const mdRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
  check(mdRes.status === 200, `metadata status ${mdRes.status}`);
  check(mdRes.headers.get("access-control-allow-origin") === "*", "metadata is CORS-open");
  const md = (await mdRes.json()) as Record<string, string>;
  check(md.issuer === base, `issuer ${md.issuer}`);

  // 2. PRM advertises the AS issuer.
  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as {
    authorization_servers: string[];
  };
  check(prm.authorization_servers.includes(base), "PRM advertises the AS issuer");

  // 3. DCR: register a public client.
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const regRes = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }),
  });
  check(regRes.status === 201, `register status ${regRes.status}`);
  const reg = (await regRes.json()) as { client_id: string };
  check(typeof reg.client_id === "string" && reg.client_id.length > 0, "register returns a client_id");

  // 4. THE key assertion: the advertised authorization_endpoint path actually resolves (not 404).
  //    Unauthenticated + valid params -> a 302 to the login (route reached), never a 404.
  const authPath = new URL(md.authorization_endpoint).pathname;
  check(authPath === "/admin/authorize", `authorization_endpoint path ${authPath}`);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = `${base}${authPath}?response_type=code&client_id=${encodeURIComponent(reg.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  const authRes = await fetch(authUrl, { redirect: "manual" });
  check(authRes.status !== 404, `authorize path must resolve, got ${authRes.status}`);
  check(
    authRes.status === 302 || authRes.status === 303 || authRes.status === 307,
    `authorize (signed-out) redirects to SSO, got ${authRes.status}`,
  );
  const loc = authRes.headers.get("location") ?? "";
  check(loc.includes("/admin/login"), `authorize redirects to login (loc=${loc})`);

  // 5. An UNREGISTERED client / bad redirect_uri must NOT redirect (open-redirect guard) -> 400.
  const badAuth = `${base}${authPath}?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const badRes = await fetch(badAuth, { redirect: "manual" });
  check(badRes.status === 400, `unknown client -> 400 (got ${badRes.status})`);

  // 6. /token resolves (route exists) and rejects an unsupported grant with 400, not 404.
  const tokRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  check(tokRes.status === 400, `/token bad grant -> 400 (got ${tokRes.status})`);
  check(tokRes.headers.get("cache-control")?.includes("no-store") === true, "/token is no-store");

  // 7. Fail-open gating: in header mode every AS route 404s (self-host without SSO).
  process.env.ADMIN_AUTH_SOURCE = "header";
  const offMeta = await fetch(`${base}/.well-known/oauth-authorization-server`);
  check(offMeta.status === 404, `metadata 404 when AS off (got ${offMeta.status})`);
  const offReg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  check(offReg.status === 404, `register 404 when AS off (got ${offReg.status})`);
  const offPrm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as {
    authorization_servers: string[];
  };
  check(offPrm.authorization_servers.length === 0, "PRM advertises no AS when off");
  process.env.ADMIN_AUTH_SOURCE = "oauth";

  await new Promise<void>((r) => server.close(() => r()));
  await closePool();
  if (errors.length) {
    console.error("FAIL:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log("oauth.http: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
