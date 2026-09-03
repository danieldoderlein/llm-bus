import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshProject } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { hashToken, liveIsAdmin } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

// Item 3: admin grants/revokes must take effect on the NEXT tool call, with NO session reconnect.
// An established MCP session reuses the ctx built at connect (http.ts buildServer(ctx)), so the
// admin-gated tools + whoami must re-read is_admin LIVE from the DB (via liveIsAdmin), not the
// snapshot. This drives a single reused client session and flips is_admin in the DB between calls -
// the exact scenario an owner hits from the web admin (Daniel: "whoami says false, list_participants
// says true"). Mirrors smoke.mcp's harness.

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
function parse(result: unknown): Record<string, any> {
  return JSON.parse((result as ToolResult).content[0].text);
}
function errText(result: unknown): string {
  const r = result as ToolResult;
  return r.isError ? (r.content?.[0]?.text ?? "") : "";
}

async function mintToken(participationId: number): Promise<string> {
  const t = randomBytes(24).toString("base64url");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [participationId, hashToken(t)]);
  return t;
}

async function main(): Promise<void> {
  const pool = getPool();
  const ctx = await freshProject("liveadmin"); // freshProject makes an ADMIN participation
  const pid = ctx.participation.id;
  const token = await mintToken(pid);
  const errors: string[] = [];
  const check = (c: boolean, m: string): void => {
    if (!c) errors.push(m);
  };
  const setAdmin = (v: boolean) => pool.query(`UPDATE participations SET is_admin=$2 WHERE id=$1`, [pid, v]);

  // --- liveIsAdmin unit: reads the CURRENT flag, fail-closed on a missing row ---
  check((await liveIsAdmin(pid)) === true, "liveIsAdmin should be true for the fresh admin participation");
  await setAdmin(false);
  check((await liveIsAdmin(pid)) === false, "liveIsAdmin should reflect a live revoke");
  await setAdmin(true);
  check((await liveIsAdmin(pid)) === true, "liveIsAdmin should reflect a live re-grant");
  check((await liveIsAdmin(999_000_111)) === false, "liveIsAdmin must be false (fail-closed) for a missing participation");

  // --- end-to-end over ONE reused MCP session: no reconnect between flips ---
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = new Client({ name: "liveadmin", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport); // connects while is_admin=true (the snapshot the session would cache)
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  // whoami reflects the connect-time state.
  check(parse(await raw("whoami")).is_admin === true, "whoami should be admin at connect");

  // Owner REVOKES admin mid-session (DB flip). No reconnect.
  await setAdmin(false);
  check(parse(await raw("whoami")).is_admin === false, "whoami must reflect the live revoke WITHOUT a reconnect");
  const provDenied = await raw("admin_provision", { participant_name: `t-${randomBytes(3).toString("hex")}` });
  check(
    /requires a project-admin token/.test(errText(provDenied)),
    `admin_provision must be denied after a live revoke, got ${JSON.stringify(provDenied)}`,
  );

  // Owner RE-GRANTS admin mid-session. The same session can now provision again.
  await setAdmin(true);
  check(parse(await raw("whoami")).is_admin === true, "whoami must reflect the live re-grant WITHOUT a reconnect");
  const provOk = parse(await raw("admin_provision", { participant_name: `mate-${randomBytes(3).toString("hex")}` }));
  check(typeof provOk.token === "string" && provOk.token.length > 0, "admin_provision should succeed after a live re-grant");

  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();

  if (errors.length) {
    console.error(`FAIL admin.live-propagation:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK admin.live-propagation: liveIsAdmin re-reads (grant/revoke/delete->fail-closed); over one reused session, " +
      "whoami + admin_provision follow a live is_admin flip with NO reconnect.",
  );
}

main().catch((err) => {
  console.error("admin.live-propagation test errored:", err);
  process.exit(1);
});
