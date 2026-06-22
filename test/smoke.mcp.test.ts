import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshProject, createParticipation } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { hashToken, authenticate } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

interface ToolResult {
  content: { type: string; text: string }[];
}
function parse(result: unknown): Record<string, any> {
  return JSON.parse((result as ToolResult).content[0].text);
}

async function mintToken(participationId: number): Promise<string> {
  const t = randomBytes(24).toString("base64url");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [participationId, hashToken(t)]);
  return t;
}

async function main(): Promise<void> {
  const ctx = await freshProject("smoke");
  const token = await mintToken(ctx.participation.id);
  const errors: string[] = [];

  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Auth enforced.
  const unauth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (unauth.status !== 401) errors.push(`expected 401 without token, got ${unauth.status}`);
  const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
  if (!/resource_metadata="/.test(wwwAuth)) errors.push(`401 missing PRM challenge: ${wwwAuth}`);

  // RFC 9728 protected-resource metadata (forward-compat for MCP OAuth discovery).
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const prmBody = (await prm.json()) as { resource?: unknown; authorization_servers?: unknown };
  if (prm.status !== 200) errors.push(`expected 200 from PRM, got ${prm.status}`);
  if (typeof prmBody.resource !== "string" || !Array.isArray(prmBody.authorization_servers)) {
    errors.push(`PRM body shape: ${JSON.stringify(prmBody)}`);
  }

  const client = new Client({ name: "smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name, arguments: args }));

  const reg = await call("register", { lane: "backend", status: "reviewing" });
  if (reg.actor !== "tester" || reg.lane !== "backend") errors.push(`register: ${JSON.stringify(reg)}`);

  await call("seed_sequence", { sequence: "adr", current: 102, prefix: "R" });
  const claim = await call("claim", { sequence: "adr", note: "terms pages" });
  if (claim.number !== 103 || claim.formatted !== "R103") errors.push(`claim: ${JSON.stringify(claim)}`);

  // list_sequences exposes the shape (name/prefix/pad/last_used/next) so agents never guess.
  const seqs = (await call("list_sequences", {})).sequences;
  const adr = seqs?.find((s: any) => s.name === "adr");
  if (!adr || adr.prefix !== "R" || adr.last_used !== 103 || adr.next !== 104 || adr.next_formatted !== "R104")
    errors.push(`list_sequences: ${JSON.stringify(seqs)}`);

  const p = await call("post", { to_lane: "backend", body: "heads up", ref: "R103" });
  if (typeof p.post_id !== "number") errors.push(`post: ${JSON.stringify(p)}`);
  // Unread push: with an unacked post addressed to me, any (non-self-reporting) tool response
  // carries _unread_posts; after ack the field disappears.
  const nudged = await call("who_is_active", {});
  if (nudged._unread_posts !== 1) errors.push(`unread push expected _unread_posts=1, got ${JSON.stringify(nudged._unread_posts)}`);
  let posts = (await call("read_posts", { to_lane: "backend" })).posts;
  if (!posts.length || posts[0].acked !== false) errors.push(`read_posts pre-ack: ${JSON.stringify(posts)}`);
  await call("ack", { post_id: p.post_id });
  const quiet = await call("who_is_active", {});
  if ("_unread_posts" in quiet) errors.push(`unread push should be absent after ack: ${JSON.stringify(quiet)}`);
  posts = (await call("read_posts", { to_lane: "backend" })).posts;
  if (!posts[0].acked) errors.push(`read_posts post-ack not acked: ${JSON.stringify(posts)}`);

  const active = (await call("who_is_active", {})).active;
  if (!active.some((a: any) => a.actor === "tester" && a.lane === "backend")) errors.push(`who_is_active: ${JSON.stringify(active)}`);

  const lease = await call("lease", { surface: "server.py", ttl_seconds: 60 });
  if (typeof lease.lease_id !== "number") errors.push(`lease: ${JSON.stringify(lease)}`);
  const holds = (await call("who_holds", {})).leases;
  if (!holds.some((l: any) => l.surface === "server.py")) errors.push(`who_holds: ${JSON.stringify(holds)}`);
  const held = holds.find((l: any) => l.surface === "server.py");
  if (!held || typeof held.expires_in_seconds !== "number" || held.expires_in_seconds <= 0 || held.expires_in_seconds > 60)
    errors.push(`who_holds expiry visibility: ${JSON.stringify(held)}`);

  const task = await call("task_create", { title: "ship login" });
  if (typeof task.task_id !== "number" || task.status !== "open") errors.push(`task_create: ${JSON.stringify(task)}`);
  const tasks = (await call("list_tasks", {})).tasks;
  if (!tasks.some((t: any) => t.task_id === task.task_id)) errors.push(`list_tasks: ${JSON.stringify(tasks)}`);

  const evs = (await call("query_events", { type: "claim", sequence: "adr" })).events;
  if (!evs.some((e: any) => e.payload.formatted === "R103")) errors.push(`query_events: ${JSON.stringify(evs)}`);

  const dig = await call("whats_new", {});
  if (dig.latest_claims?.adr !== "R103") errors.push(`whats_new latest_claims: ${JSON.stringify(dig.latest_claims)}`);
  const latest = await call("latest_claims", {});
  if (!latest.sequences.some((s: any) => s.sequence === "adr" && s.formatted === "R103")) errors.push(`latest_claims: ${JSON.stringify(latest)}`);

  // Admin self-service: roster, provision a teammate, verify the minted token + hand-out.
  const before = (await call("list_participants", {})).participants;
  if (!before.some((p: any) => p.name === "tester")) errors.push(`list_participants(before): ${JSON.stringify(before)}`);
  const prov = await call("admin_provision", { participant_name: "teammate", lane: "qa" });
  if (typeof prov.token !== "string") errors.push(`admin_provision token: ${JSON.stringify(prov)}`);
  if (prov.setup?.mcp_json?.mcpServers?.["llm-bus"]?.url !== prov.setup?.mcp_url || !prov.setup?.env?.includes(prov.token))
    errors.push(`admin_provision setup hand-out malformed: ${JSON.stringify(prov.setup)}`);
  // the minted token authenticates as a DISTINCT participation in the SAME project
  const tctx = await authenticate(`Bearer ${prov.token}`);
  if (!tctx || tctx.project.id !== ctx.project.id || tctx.participant.name !== "teammate" || tctx.participation.id === ctx.participation.id)
    errors.push(`provisioned token resolve wrong: ${JSON.stringify(tctx && { proj: tctx.project.id, name: tctx.participant.name })}`);
  const after = (await call("list_participants", {})).participants;
  if (!after.some((p: any) => p.name === "teammate" && p.token_active === true)) errors.push(`list_participants(after): ${JSON.stringify(after)}`);

  // admin_rotate: mint-before-revoke by name. Old token dies, new one works as the same teammate, hand-out shaped.
  const oldTeammateToken = prov.token;
  const rotated = await call("admin_rotate", { participant_name: "teammate" });
  if (typeof rotated.token !== "string" || rotated.token === oldTeammateToken) errors.push(`admin_rotate token: ${JSON.stringify(rotated)}`);
  if (rotated.setup?.mcp_json?.mcpServers?.["llm-bus"]?.url !== rotated.setup?.mcp_url || !rotated.setup?.env?.includes(rotated.token))
    errors.push(`admin_rotate setup hand-out malformed: ${JSON.stringify(rotated.setup)}`);
  if ((await authenticate(`Bearer ${oldTeammateToken}`)) !== null) errors.push("admin_rotate: old teammate token still authenticates");
  const rctx = await authenticate(`Bearer ${rotated.token}`);
  if (!rctx || rctx.project.id !== ctx.project.id || rctx.participant.name !== "teammate")
    errors.push(`admin_rotate new token resolve wrong: ${JSON.stringify(rctx && { proj: rctx.project.id, name: rctx.participant.name })}`);

  // admin_revoke: revoke the teammate by name -> the rotated token then stops authenticating.
  const rev = await call("admin_revoke", { participant_name: "teammate" });
  if (typeof rev.revoked !== "number" || rev.revoked < 1) errors.push(`admin_revoke count: ${JSON.stringify(rev)}`);
  if ((await authenticate(`Bearer ${rotated.token}`)) !== null) errors.push("admin_revoke: token still authenticates after revoke");

  // Cross-project isolation (invariant 1): an admin in THIS project must not touch a same-named
  // participant living in a DIFFERENT project. Set up an isolated project B with a "ghost" + token.
  const ctxB = await freshProject("smoke-b");
  const ghostB = await createParticipation(ctxB, "ghost");
  const ghostToken = await mintToken(ghostB.participation.id);
  const crossRev = await call("admin_revoke", { participant_name: "ghost" });
  if (crossRev.revoked !== 0) errors.push(`cross-project admin_revoke affected another project: ${JSON.stringify(crossRev)}`);
  let rotateRejected = false;
  try {
    const r: any = await client.callTool({ name: "admin_rotate", arguments: { participant_name: "ghost" } });
    if (r?.isError) rotateRejected = true;
  } catch {
    rotateRejected = true;
  }
  if (!rotateRejected) errors.push("cross-project admin_rotate did not reject a foreign-project participant");
  if ((await authenticate(`Bearer ${ghostToken}`)) === null) errors.push("cross-project op revoked a foreign project's token");

  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();

  if (errors.length) {
    console.error(`FAIL smoke.mcp:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("OK smoke.mcp: 401 enforced; full round-trip (register/seed/claim/post/ack/presence/lease/task/query/digest) + admin list_participants/admin_provision/admin_rotate/admin_revoke (teammate token authenticates, rotate mints-before-revoke, revoke kills it, hand-out built, cross-project revoke/rotate refused) verified.");
}

main().catch((err) => {
  console.error("smoke test errored:", err);
  process.exit(1);
});
