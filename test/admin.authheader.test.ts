// Boot a minimal server wired straight to handleAdmin and exercise the auth + CSRF gates over
// real HTTP. The SSO email header is the only identity input; CSRF must block forged POSTs.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { handleAdmin } from "../src/admin/handlers.js";
import { createHttpServer } from "../src/http.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const header = loadConfig().ADMIN_EMAIL_HEADER; // default "x-auth-request-email"
  const email = `authhdr-${randomUUID().slice(0, 8)}@test.local`;

  const server = http.createServer((req, res) => {
    void handleAdmin(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // (1) GET /admin with NO email header -> 401 JSON.
  const noHeader = await fetch(`${base}/admin`);
  check(noHeader.status === 401, `no-header GET expected 401, got ${noHeader.status}`);
  const noHeaderBody = await noHeader.json().catch(() => ({}));
  check(
    (noHeaderBody as { error?: string }).error === "unauthorized",
    `no-header body expected {error:"unauthorized"}, got ${JSON.stringify(noHeaderBody)}`,
  );

  // (2) GET /admin WITH the header -> 200 dashboard for that owner.
  const withHeader = await fetch(`${base}/admin`, { headers: { [header]: email } });
  check(withHeader.status === 200, `with-header GET expected 200, got ${withHeader.status}`);
  const ct = withHeader.headers.get("content-type") ?? "";
  check(ct.includes("text/html"), `dashboard content-type expected text/html, got "${ct}"`);
  const dashHtml = await withHeader.text();
  check(dashHtml.includes("Dashboard"), "dashboard HTML missing 'Dashboard'");
  check(dashHtml.includes(email), "dashboard HTML should show the owner email");
  // A session cookie should have been issued.
  const setCookie = withHeader.headers.get("set-cookie") ?? "";
  check(/yolo_admin=/.test(setCookie), `expected a session cookie, got "${setCookie}"`);

  // (3) A POST without a valid _csrf -> 403 (even with a valid email header).
  const badPost = await fetch(`${base}/admin/projects`, {
    method: "POST",
    headers: {
      [header]: email,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ slug: "x", name: "X", _csrf: "totally-wrong" }).toString(),
  });
  check(badPost.status === 403, `forged-CSRF POST expected 403, got ${badPost.status}`);
  const badBody = await badPost.json().catch(() => ({}));
  check(
    (badBody as { error?: string }).error === "forbidden",
    `forged-CSRF body expected {error:"forbidden"}, got ${JSON.stringify(badBody)}`,
  );

  // (4) Regression: the REAL http.ts server must ROUTE /admin (and subpaths) to the handler,
  //     not 404. The full /admin prefix must reach the app — Caddy must use `handle`, not
  //     `handle_path` (which would strip /admin). 401 (no email) proves it's routed, not 404.
  const realServer = createHttpServer();
  await new Promise<void>((resolve) => realServer.listen(0, "127.0.0.1", () => resolve()));
  const realBase = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;
  const adminRoot = await fetch(`${realBase}/admin`);
  check(adminRoot.status === 401, `real server GET /admin expected 401 (routed to handler), got ${adminRoot.status}`);
  const adminSub = await fetch(`${realBase}/admin/projects/1`);
  check(adminSub.status === 401, `real server GET /admin/projects/1 expected 401 (routed), got ${adminSub.status}`);
  await new Promise<void>((resolve) => realServer.close(() => resolve()));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL admin.authheader:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK admin.authheader: no email header -> 401 unauthorized; valid header -> 200 dashboard + session " +
      "cookie; POST with a bad _csrf -> 403 forbidden.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("admin.authheader test errored:", err);
  process.exit(1);
});
