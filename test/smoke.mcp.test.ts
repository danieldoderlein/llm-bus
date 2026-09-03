import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshProject, createParticipation, siblingProject } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { hashToken, authenticate } from "../src/auth.js";
import { resolveOwner } from "../src/admin/owner.js";
import { createHttpServer } from "../src/http.js";
import { legacyEndpointNotice } from "../src/mcp.js";

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

  // Stateless transport (decision 030): GET /mcp has no session stream to open, so it returns 405 (with a
  // valid token, so auth passes first). Locks the stateful -> stateless contract change.
  const getMcp = await fetch(`${base}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (getMcp.status !== 405) errors.push(`expected 405 from GET /mcp (stateless), got ${getMcp.status}`);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name, arguments: args }));

  const reg = await call("register", { lane: "backend", status: "reviewing" });
  if (reg.actor !== "tester" || reg.lane !== "backend") errors.push(`register: ${JSON.stringify(reg)}`);

  await call("seed_sequence", { sequence: "adr", current: 102, prefix: "R" });
  const claim = await call("claim", { sequence: "adr", note: "terms pages" });
  if (claim.number !== 103 || claim.formatted !== "R103") errors.push(`claim: ${JSON.stringify(claim)}`);
  // 044: claim also returns the auto-qualified cross-project id; this owner has no handle -> slug#id form.
  if (claim.qualified !== `${ctx.project.slug}#R103`) errors.push(`claim.qualified expected "${ctx.project.slug}#R103", got "${claim.qualified}"`);

  // list_sequences exposes the shape (name/prefix/pad/last_used/next) so agents never guess.
  const seqs = (await call("list_sequences", {})).sequences;
  const adr = seqs?.find((s: any) => s.name === "adr");
  if (!adr || adr.prefix !== "R" || adr.last_used !== 103 || adr.next !== 104 || adr.next_formatted !== "R104")
    errors.push(`list_sequences: ${JSON.stringify(seqs)}`);
  // 044: list_sequences carries the qualified next id too (this owner has no handle -> slug#id form).
  if (adr && adr.next_qualified !== `${ctx.project.slug}#R104`)
    errors.push(`list_sequences.next_qualified expected "${ctx.project.slug}#R104", got "${adr?.next_qualified}"`);

  const p = await call("post", { to_lane: "backend", body: "heads up", ref: "R103" });
  if (typeof p.post_id !== "number") errors.push(`post: ${JSON.stringify(p)}`);
  // Decision 065 over the wire: every post reports its reach, so a caller cannot miss an empty audience by
  // not parsing prose. tester is alone in "backend" here, and you are never mail to yourself (062).
  if (p.reaches !== 0) errors.push(`expected reaches 0 for a solo lane, got ${JSON.stringify(p.reaches)}`);
  if (!Array.isArray(p.recipients)) errors.push(`post must always carry recipients, got ${JSON.stringify(p.recipients)}`);
  // ...and an unknown lane is refused on the MCP surface, naming the lanes that do exist.
  // The refusal comes back as an MCP error (text, not a JSON envelope), so read the raw tool result.
  const badLaneText = JSON.stringify(
    await client.callTool({ name: "post", arguments: { to_lane: "nosuchlane", body: "typo" } }),
  );
  if (!/does not exist in this project/.test(badLaneText) || !/backend/.test(badLaneText))
    errors.push(`an unknown lane must be refused over the wire, naming known lanes: ${badLaneText}`);
  // The unread fixture must come from SOMEONE ELSE (decision 062). This used to reuse the caller's own
  // post above, which quietly asserted that an agent nags itself about its own handoff - the very bug 062
  // fixes. A teammate posting into the caller's lane is what the push actually exists for.
  const mate = await createParticipation(ctx, "mate");
  const mateToken = await mintToken(mate.participation.id);
  const mateClient = new Client({ name: "mate", version: "0" });
  await mateClient.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${mateToken}` } },
    }),
  );
  const mateSent = parse(
    await mateClient.callTool({ name: "post", arguments: { to_lane: "backend", body: "from a teammate", ref: "R103" } }),
  );
  // The teammate's post reaches the caller, and says so by name - the reach report is what turns "did that
  // land?" from a guess into a number.
  if (mateSent.reaches !== 1) errors.push(`expected the teammate's lane post to reach 1, got ${JSON.stringify(mateSent.reaches)}`);
  if (!Array.isArray(mateSent.recipients) || !mateSent.recipients.some((r: string) => r === "tester" || r.endsWith("/tester")))
    errors.push(`expected tester named in recipients, got ${JSON.stringify(mateSent.recipients)}`);
  await mateClient.close();
  // Unread push (decision 039: reading IS the receipt; ack retired): with an unread post addressed to me, any
  // (non-self-reporting) tool response carries _unread_posts; READING it (read_posts) clears the field.
  const nudged = await call("who_is_active", {});
  if (nudged._unread_posts !== 1) errors.push(`unread push expected _unread_posts=1, got ${JSON.stringify(nudged._unread_posts)}`);
  let posts = (await call("read_posts", { to_lane: "backend" })).posts;
  // `read` reflects the state BEFORE this read, so the first read shows read:false and simultaneously marks it read.
  if (!posts.length || posts[0].read !== false) errors.push(`read_posts pre-read: ${JSON.stringify(posts)}`);
  const quiet = await call("who_is_active", {});
  if ("_unread_posts" in quiet) errors.push(`unread push should be absent after reading: ${JSON.stringify(quiet)}`);
  posts = (await call("read_posts", { to_lane: "backend" })).posts;
  if (!posts[0].read) errors.push(`read_posts post-read not marked read: ${JSON.stringify(posts)}`);

  // Retirement tombstones (decision 040): a cached pre-v2 call to review/answer_review/ack must return an
  // ERROR redirecting to the replacement - NOT vanish (which the host renders as "the server disconnected",
  // a phantom-infra mis-diagnosis a peer rig actually chased). One round trip, self-correcting.
  for (const [name, needle] of [
    ["review", "task_create"],
    ["answer_review", "task_answer"],
    ["ack", "read_posts"],
  ] as const) {
    const r: any = await client.callTool({ name, arguments: { task_id: 1, post_id: 1 } });
    if (!r?.isError) errors.push(`tombstone ${name}: expected isError, got ${JSON.stringify(r)}`);
    const text = String(r?.content?.[0]?.text ?? "");
    if (!text.includes(needle)) errors.push(`tombstone ${name} must redirect to ${needle}: ${text}`);
  }
  // ...and they are LISTED (so ToolSearch finds them as retired, not "missing").
  const listedNames = (await client.listTools()).tools.map((t: any) => t.name);
  for (const name of ["review", "answer_review", "ack"]) {
    if (!listedNames.includes(name)) errors.push(`tombstone ${name} should be listed (retired, not absent)`);
  }

  const whoActive = await call("who_is_active", {});
  const active = whoActive.active;
  if (!active.some((a: any) => a.actor === "tester" && a.lane === "backend")) errors.push(`who_is_active: ${JSON.stringify(active)}`);
  // Presence is recency, not proof of presence (task 15): each row carries seen_ago_seconds and the
  // response carries the "stale != offline" note so a reader never gates work on a stale/absent row.
  const me = active.find((a: any) => a.actor === "tester");
  if (typeof me?.seen_ago_seconds !== "number" || me.seen_ago_seconds < 0)
    errors.push(`who_is_active seen_ago_seconds missing/invalid: ${JSON.stringify(me)}`);
  if (typeof whoActive.note !== "string" || !/not proof of offline|not 'offline'|offline/i.test(whoActive.note))
    errors.push(`who_is_active note (stale != offline) missing: ${JSON.stringify(whoActive.note)}`);

  const lease = await call("lease", { surface: "server.py", ttl_seconds: 60 });
  if (typeof lease.lease_id !== "number") errors.push(`lease: ${JSON.stringify(lease)}`);
  const holds = (await call("who_holds", {})).leases;
  if (!holds.some((l: any) => l.surface === "server.py")) errors.push(`who_holds: ${JSON.stringify(holds)}`);
  const held = holds.find((l: any) => l.surface === "server.py");
  if (!held || typeof held.expires_in_seconds !== "number" || held.expires_in_seconds <= 0 || held.expires_in_seconds > 60)
    errors.push(`who_holds expiry visibility: ${JSON.stringify(held)}`);

  const task = await call("task_create", { title: "ship login", detail: "wire the OAuth callback + add the round-trip test" });
  if (typeof task.task_id !== "number" || task.status !== "todo") errors.push(`task_create: ${JSON.stringify(task)}`);
  const tasks = (await call("list_tasks", {})).tasks;
  const listed = tasks.find((t: any) => t.task_id === task.task_id);
  if (!listed) errors.push(`list_tasks: ${JSON.stringify(tasks)}`);
  // list_tasks must surface the task DETAIL (the DoD/spec), not just the title - otherwise an assignee
  // cannot read what a task filed by another agent actually requires.
  if (listed && listed.detail !== "wire the OAuth callback + add the round-trip test")
    errors.push(`list_tasks must return task detail, got ${JSON.stringify(listed.detail)}`);

  // A response that CUTS a body must carry the way to read it in full, on the response itself - not only in
  // the tool schema. An MCP client caches the schema at connect time, so an agent connected before 064 shipped
  // gets previews with no `task_ids` parameter to expand them, which is worse than the dump 064 replaced.
  // The note is the only channel that reaches a stale client, so it is asserted at the WIRE, not in domain.
  const bigDetail = await call("task_create", { title: "big body", detail: "x".repeat(400) });
  const cutList = await call("list_tasks", {});
  const cutRow = cutList.tasks.find((t: any) => t.task_id === bigDetail.task_id);
  if (!cutRow?.detail_truncated) errors.push(`expected a 400-char body to be cut, got ${JSON.stringify(cutRow)}`);
  if (!cutList.reading_a_full_body || !/task_ids/.test(cutList.reading_a_full_body))
    errors.push(`a cut list must say how to read a full body, got ${JSON.stringify(cutList.reading_a_full_body)}`);
  if (!/RECONNECT/i.test(cutList.reading_a_full_body ?? ""))
    errors.push(`the note must name the stale-schema recovery, got ${JSON.stringify(cutList.reading_a_full_body)}`);
  // MEASURED, because a rule about this was written into architecture.md on reasoning alone and was WRONG:
  // a cached tool schema does NOT gate what a client can SEND. The SDK client transmits an argument absent
  // from its cached inputSchema and the server receives it. That is what makes a stale schema an
  // INFORMATIONAL gap (the agent is never told the parameter exists) rather than a mechanical one, and it
  // is why naming the parameter in the response is a complete fix. If this ever starts failing, the
  // reading_a_full_body note stops being sufficient and the guidance in architecture.md must change with it.
  const unknownArg: any = await client.callTool({
    name: "list_tasks",
    arguments: { totally_unknown_param: "xyz", limit: 3 },
  });
  if (unknownArg.isError)
    errors.push(`a client must be able to send an argument outside its cached schema, got ${JSON.stringify(unknownArg.content?.[0]?.text)}`);
  // ...and because it CAN be sent and is then silently discarded, the response must say so (decision 066).
  // Without this, task_id:[606] instead of task_ids:[606] returns a full unfiltered index and the caller
  // reads row one as the answer to a question it never asked.
  const ignoredText = String(unknownArg.content?.[0]?.text ?? "");
  if (!/_ignored_params/.test(ignoredText) || !/totally_unknown_param/.test(ignoredText))
    errors.push(`a discarded parameter must be reported back, got ${ignoredText.slice(0, 200)}`);
  // A near-miss must name the parameter the caller almost certainly meant.
  const typo: any = await client.callTool({ name: "list_tasks", arguments: { task_id: 1 } });
  if (!/did you mean task_ids/.test(String(typo.content?.[0]?.text ?? "")))
    errors.push(`a near-miss must suggest the real parameter, got ${String(typo.content?.[0]?.text ?? "").slice(0, 200)}`);
  // A correct call must stay clean - a nag that fires on good calls is noise and gets ignored.
  const clean: any = await client.callTool({ name: "list_tasks", arguments: { limit: 3 } });
  if (/_ignored_params/.test(String(clean.content?.[0]?.text ?? "")))
    errors.push(`a correct call must not be nagged, got ${String(clean.content?.[0]?.text ?? "").slice(0, 200)}`);

  // ...and it must NOT nag when nothing was cut.
  const uncut = await call("list_tasks", { task_ids: [bigDetail.task_id] });
  if (uncut.reading_a_full_body) errors.push(`no cut row means no note, got ${JSON.stringify(uncut.reading_a_full_body)}`);
  if (uncut.tasks?.[0]?.detail?.length !== 400)
    errors.push(`task_ids must return the FULL body, got ${uncut.tasks?.[0]?.detail?.length} chars`);
  // Retire the fixture so it does not disturb the open_unassigned / _open_tasks counts asserted below.
  await call("task_cancel", { task_id: bigDetail.task_id });

  // _open_tasks push (parallel to the _unread_posts channel): a todo task OWNED by me that is not blocked
  // makes any non-task-reporting tool response carry _open_tasks; list_tasks and whats_new suppress it (they
  // already carry task state). "ship login" above is unowned so it does NOT nudge - only the assigned one does.
  const owned = await call("task_create", { title: "wire billing", owner: "tester" });
  if (owned.status !== "todo") errors.push(`task_create(owner): ${JSON.stringify(owned)}`);
  const taskNudge = await call("who_is_active", {});
  if (taskNudge._open_tasks !== 1) errors.push(`open-task push expected _open_tasks=1, got ${JSON.stringify(taskNudge._open_tasks)}`);
  if ("_open_tasks" in (await call("list_tasks", {}))) errors.push("list_tasks must suppress _open_tasks (it already lists tasks)");

  const evs = (await call("query_events", { type: "claim", sequence: "adr" })).events;
  if (!evs.some((e: any) => e.payload.formatted === "R103")) errors.push(`query_events: ${JSON.stringify(evs)}`);

  const dig = await call("whats_new", {});
  if (dig.latest_claims?.adr !== "R103") errors.push(`whats_new latest_claims: ${JSON.stringify(dig.latest_claims)}`);
  // whats_new pushes your plate: the assigned "wire billing" in my_open_tasks, the unowned "ship login" in
  // open_unassigned; and it suppresses the _open_tasks nudge (it already lists them).
  if (!dig.my_open_tasks?.some((t: any) => t.title === "wire billing" && t.status === "todo"))
    errors.push(`whats_new my_open_tasks: ${JSON.stringify(dig.my_open_tasks)}`);
  if (dig.open_unassigned !== 1) errors.push(`whats_new open_unassigned expected 1, got ${JSON.stringify(dig.open_unassigned)}`);
  if ("_open_tasks" in dig) errors.push("whats_new must suppress _open_tasks (it already lists them)");
  const latest = await call("latest_claims", {});
  if (!latest.sequences.some((s: any) => s.sequence === "adr" && s.formatted === "R103")) errors.push(`latest_claims: ${JSON.stringify(latest)}`);

  // Decide-this task over the REAL MCP wire (decision 039): the v2 replacement for the retired review/
  // answer_review round-trip. Create a task carrying options, answer it, and assert it completes with the
  // recorded choice (a fresh read, not just the returned envelope).
  const decTask = await call("task_create", { title: "which path?", options: ["ship", "hold"] });
  const dAns = await call("task_answer", { task_id: decTask.task_id, option: "ship", note: "go" });
  if (dAns.status !== "done") errors.push(`task_answer envelope wrong: ${JSON.stringify(dAns)}`);
  const decRow = (
    await getPool().query<{ status: string; selected_option: string | null }>(
      `SELECT status, selected_option FROM tasks WHERE id = $1`,
      [decTask.task_id],
    )
  ).rows[0];
  if (decRow.status !== "done" || decRow.selected_option !== "ship")
    errors.push(`task_answer must complete the task with the chosen option, got ${JSON.stringify(decRow)}`);
  // Bug #545: the answer must be readable through list_tasks (the tool), not only in the DB / the decision
  // post - so the agent that asked the decision reads the option + note inline on its own task.
  const answered = (await call("list_tasks", { status: "done" })).tasks.find(
    (t: { task_id: number }) => t.task_id === decTask.task_id,
  );
  if (
    !answered ||
    answered.selected_option !== "ship" ||
    answered.answer_note !== "go" ||
    !Array.isArray(answered.options) ||
    !answered.options.includes("hold")
  )
    errors.push(`list_tasks must expose the decision answer (options/selected_option/answer_note), got ${JSON.stringify(answered)}`);

  // Dependency + derived-blocked over the wire (decision 039): a task depending on an unfinished one lists as
  // 'blocked'; the base task is not.
  const depBase = await call("task_create", { title: "dep base", owner: "tester" });
  const depWaiter = await call("task_create", { title: "dep waiter", owner: "tester" });
  await call("task_depend", { task_id: depWaiter.task_id, depends_on: depBase.task_id });
  const blockedList = await call("list_tasks", { status: "blocked" });
  if (!blockedList.tasks?.some((t: any) => t.task_id === depWaiter.task_id))
    errors.push(`task_depend must derive 'blocked' on the waiter over MCP: ${JSON.stringify(blockedList.tasks)}`);

  // guide(): the pullable coordination protocol (refresher tool). Returns the current guide text.
  const gd = await call("guide", {});
  if (typeof gd.protocol !== "string" || !gd.protocol.includes("coordination protocol") || !gd.protocol.includes("TRACK WORK AS TASKS"))
    errors.push(`guide protocol malformed: ${JSON.stringify(gd).slice(0, 160)}`);

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
  // decision 038: a provisioned agent is NEVER human-less - it binds to its human (the project owner),
  // so it can be surfaced on a board and is a real member of the project's human, not an orphan token.
  const { getPool: poolForBind } = await import("../src/db.js");
  const bindRow = await poolForBind().query<{ human_owner_id: string | null }>(
    `SELECT human_owner_id FROM participations WHERE id = $1`,
    [tctx!.participation.id],
  );
  if (!bindRow.rows[0] || Number(bindRow.rows[0].human_owner_id) !== ctx.owner!.id)
    errors.push(`admin_provision must bind human_owner_id to the project owner (decision 038): ${JSON.stringify(bindRow.rows[0])}`);

  // Cross-human derivation (decision 052 follow-up, bus task 508): an agent PROVISIONED under this project's
  // owner but BOUND to a DIFFERENT human must surface under the BOUND human on BOTH list_participants and
  // who_is_active - the COALESCE(human_owner_id, owner_id) the access page already uses. Seed the divergence
  // on the teammate participation ONLY, so the bare-label `tester` (owner has no handle) must stay bare.
  const member = await resolveOwner(`smoke-member-${randomBytes(4).toString("hex")}@test.local`);
  await getPool().query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [member.id, tctx!.participation.id]);
  await getPool().query(
    `INSERT INTO presence (participation_id, project_id, lane, last_seen) VALUES ($1, $2, 'qa', now())
     ON CONFLICT (participation_id) DO UPDATE SET last_seen = now()`,
    [tctx!.participation.id, ctx.project.id],
  );
  const roster = (await call("list_participants", {})).participants;
  const teammateRow = roster.find((p: any) => p.name === "teammate");
  if (teammateRow?.actor !== `${member.username}/teammate`)
    errors.push(`list_participants bound-human actor: expected ${member.username}/teammate, got ${JSON.stringify(teammateRow)}`);
  if (roster.find((p: any) => p.name === "tester")?.actor !== "tester")
    errors.push(`list_participants: bare-label tester regressed: ${JSON.stringify(roster.find((p: any) => p.name === "tester"))}`);
  const activeCross = (await call("who_is_active", {})).active;
  if (!activeCross.some((a: any) => a.actor === `${member.username}/teammate`))
    errors.push(`who_is_active bound-human actor missing: ${JSON.stringify(activeCross)}`);

  // Decision 061: the roster returns HUMAN MEMBERS as well as agents, each row naming the field that
  // actually routes work to it. Humans were invisible here, so the only assignable-to-a-person string was
  // undiscoverable while the one that mis-routes (the agent label) was a first-class `name` - which is how a
  // person's tasks ended up in an agent queue that nothing polls (the project-a cross-rig report, 2026-08-19).
  await getPool().query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [ctx.project.id, member.id],
  );
  // A member with NO username pins the documented email fallback (a handle-less member must stay assignable).
  const noHandle = await getPool().query<{ id: string; email: string }>(
    `INSERT INTO owners (email) VALUES ($1) RETURNING id, email`,
    [`smoke-nohandle-${randomBytes(4).toString("hex")}@test.local`],
  );
  await getPool().query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [ctx.project.id, Number(noHandle.rows[0].id)],
  );
  const roster2 = (await call("list_participants", {})).participants;
  const humanRow = roster2.find((p: any) => p.name === member.username);
  if (
    !humanRow ||
    humanRow.kind !== "human" ||
    humanRow.assign_with !== "human" ||
    humanRow.actor !== member.username ||
    humanRow.token_active !== false ||
    humanRow.role !== "member"
  )
    errors.push(`list_participants must return the human member with assign_with=human + no token: ${JSON.stringify(humanRow)}`);
  if (!roster2.some((p: any) => p.name === noHandle.rows[0].email && p.kind === "human"))
    errors.push(`list_participants: a member with no username must fall back to their email (stays assignable)`);
  const agentRows = roster2.filter((p: any) => p.kind === "agent");
  if (!agentRows.length || !agentRows.every((p: any) => p.assign_with === "owner"))
    errors.push(`list_participants: every agent row must carry assign_with=owner: ${JSON.stringify(agentRows)}`);
  if (roster2.find((p: any) => p.name === "teammate")?.actor !== `${member.username}/teammate`)
    errors.push(`list_participants: the agent actor must survive the human union unchanged`);
  // Order by assign_with, NOT kind: the code deliberately ranks by the row SOURCE because a legacy
  // kind='human' participation would otherwise sort into the human block and make this assertion misfire.
  const lastAgent = roster2.map((p: any) => p.assign_with).lastIndexOf("owner");
  const firstHuman = roster2.map((p: any) => p.assign_with).indexOf("human");
  if (firstHuman !== -1 && lastAgent > firstHuman)
    errors.push(`list_participants: agents must sort before humans: ${JSON.stringify(roster2.map((p: any) => [p.assign_with, p.name]))}`);
  // Restore the original binding so the rotate/revoke assertions below run against the provisioned state.
  await getPool().query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [ctx.owner!.id, tctx!.participation.id]);

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

  // Decision 061: the roster now reaches project_members, a table it never touched before. Prove that reach
  // is tenant-scoped - project B's human member must NOT appear in project A's roster (invariant 3).
  const foreignMember = await resolveOwner(`smoke-foreign-${randomBytes(4).toString("hex")}@test.local`);
  await getPool().query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [ctxB.project.id, foreignMember.id],
  );
  const rosterA = (await call("list_participants", {})).participants;
  if (rosterA.some((p: any) => p.name === foreignMember.username || p.actor === foreignMember.username))
    errors.push(`list_participants leaked another project's human member: ${foreignMember.username}`);
  if (rosterA.some((p: any) => p.name === "ghost"))
    errors.push(`list_participants leaked another project's agent: ghost`);

  // ── Decision 070 over the wire: one connection, many projects ───────────────────────────────────────
  // The domain rules are proven in multiproject.test.ts; what is proven HERE is the MCP wiring, which that
  // test cannot see: that `project` reaches the tool surface at all, that a call carrying it acts elsewhere,
  // and that doing so is VISIBLE in the response rather than looking exactly like a local call.
  const sib = await siblingProject(ctx, "smoke-sib");
  const toolList = await client.listTools();
  const postTool = toolList.tools.find((t) => t.name === "post");
  const postProps = Object.keys((postTool?.inputSchema as { properties?: object })?.properties ?? {});
  if (!postProps.includes("project")) errors.push(`every tool must offer 'project', post has: ${postProps.join(",")}`);
  if (!toolList.tools.some((t) => t.name === "list_projects")) errors.push("list_projects is not on the tool surface");

  const projects = (await call("list_projects", {})).projects;
  const listedSlugs = (projects ?? []).map((p: any) => p.project);
  if (!listedSlugs.includes(ctx.project.slug) || !listedSlugs.includes(sib.project.slug))
    errors.push(`list_projects must show both memberships, got ${JSON.stringify(listedSlugs)}`);
  if (listedSlugs.includes(ctxB.project.slug))
    errors.push(`list_projects leaked a project this token is not a member of: ${ctxB.project.slug}`);
  if (!(projects ?? []).some((p: any) => p.is_default && p.project === ctx.project.slug))
    errors.push(`the token's own project must be flagged is_default, got ${JSON.stringify(projects)}`);

  const away = await call("post", { project: sib.project.slug, to_actor: "tester", body: "cross-project handoff" });
  if (away._project !== sib.project.slug)
    errors.push(`a cross-project call must echo _project so it cannot pass for a local one, got ${JSON.stringify(away._project)}`);
  const awayRow = await getPool().query<{ project_id: string }>(`SELECT project_id FROM posts WHERE id = $1`, [away.post_id]);
  if (Number(awayRow.rows[0].project_id) !== sib.project.id)
    errors.push(`the cross-project post landed in ${awayRow.rows[0].project_id}, expected ${sib.project.id}`);
  // ...and a LOCAL call must not carry the echo, or the signal means nothing.
  const local = await call("who_is_active", {});
  if ("_project" in local) errors.push(`a local call must NOT echo _project, got ${JSON.stringify(local._project)}`);

  // A project that exists but this token is not a member of stays refused on the live surface (invariant 1).
  const foreignText = JSON.stringify(
    await client.callTool({ name: "post", arguments: { project: ctxB.project.slug, to_actor: "ghost", body: "should not land" } }),
  );
  if (!/not a project this connection can act in/.test(foreignText))
    errors.push(`naming a non-member project must be refused over the wire: ${foreignText}`);
  const leaked = await getPool().query(`SELECT 1 FROM posts WHERE project_id = $1 AND body = 'should not land'`, [ctxB.project.id]);
  if (leaked.rowCount !== 0) errors.push("a refused cross-project post still wrote into the foreign project");

  // A caller on a NON-CANONICAL hostname is told so, on every call. A hostname cannot be retired while
  // agents still point at it, and the server could not say WHO was still on an old one: the legacy vhost's
  // access log showed one real client in 47 hours, and the ledger could not identify it (a notification
  // frame writes no event and stamps no presence). So the endpoint tells the only party that can act.
  //
  // Exercised over a REAL request with a real Host header rather than by calling the predicate, because the
  // plumbing (req.headers.host -> RawCall -> the response extra) is the half that can silently not work -
  // and a notice nobody receives looks exactly like a caller who is already on the canonical name.
  // Raw node:http, NOT fetch and NOT the SDK client: `Host` is a forbidden header name in the fetch spec,
  // so undici silently DROPS it. Setting it through either would have produced a call on the canonical host
  // and a test that passes by asserting nothing - the exact shape section 06 warns about.
  const callOverHost = async (host: string): Promise<Record<string, any>> => {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            host,
          },
        },
        (resp) => {
          let d = "";
          resp.on("data", (c) => (d += c));
          resp.on("end", () => resolve({ status: resp.statusCode ?? 0, body: d }));
        },
      );
      r.on("error", reject);
      r.end(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "whoami", arguments: {} } }));
    });
    // SSE framing when the transport answers as a stream; JSON when it answers directly.
    const json = body.startsWith("event:") || body.startsWith("data:")
      ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      : body;
    if (!json) throw new Error(`empty MCP response over host "${host}" (status ${status}): ${JSON.stringify(body)}`);
    const env = JSON.parse(json) as { result?: ToolResult };
    return JSON.parse(env.result!.content[0].text);
  };

  const legacyCall = await callOverHost("yolo.example.com");
  if (typeof legacyCall._endpoint !== "string")
    errors.push(`a call on a non-canonical host must carry _endpoint, got ${JSON.stringify(legacyCall)}`);
  if (!/yolo\.example\.com/.test(legacyCall._endpoint ?? ""))
    errors.push("the notice must name the host they actually used, or they cannot tell which config is wrong");
  if (!/127\.0\.0\.1:8787\/mcp/.test(legacyCall._endpoint ?? ""))
    errors.push(`the notice must give the canonical URL to move TO, got: ${legacyCall._endpoint}`);
  // ...and the canonical/loopback case stays SILENT, or every caller gets nagged forever and tunes it out.
  const canonicalCall = await callOverHost("127.0.0.1");
  if (canonicalCall._endpoint !== undefined)
    errors.push(`a caller on the canonical host must get NO notice, got: ${canonicalCall._endpoint}`);

  // Edge cases that CANNOT be produced over the wire, so they are asserted against the predicate directly:
  // Node's HTTP parser rejects a malformed Host with 400 before any handler runs (verified - a `<` in the
  // header never reaches the app). The sanitizer is defence in depth for that, and the IPv6 case is a real
  // bug this catches: splitting a Host on ":" turns "[::1]:8787" into "[", which would nag every local dev
  // session as if it were on a deprecated endpoint.
  const canon = "https://mcp.example.com/mcp";
  if (legacyEndpointNotice("yolo.example.com", canon) === null)
    errors.push("a non-canonical host must produce a notice");
  if (legacyEndpointNotice("mcp.example.com", canon) !== null) errors.push("the canonical host must be silent");
  if (legacyEndpointNotice("mcp.example.com:443", canon) !== null) errors.push("a port must not make the canonical host look foreign");
  if (legacyEndpointNotice("MCP.EXAMPLE.COM", canon) !== null) errors.push("host comparison must be case-insensitive");
  if (legacyEndpointNotice("[::1]:8787", canon) !== null) errors.push("IPv6 loopback must be silent (a ':' split would mangle it)");
  if (legacyEndpointNotice("localhost:8787", canon) !== null) errors.push("localhost must be silent");
  if (legacyEndpointNotice(undefined, canon) !== null) errors.push("a missing Host must be silent, never a crash");
  if (legacyEndpointNotice("x.example.com", "not a url") !== null) errors.push("a malformed PUBLIC_URL must not break a tool call");
  if (/[<>]/.test(legacyEndpointNotice("evil<script>.example.com", canon) ?? ""))
    errors.push("the echoed host must be sanitized before it is reflected back");

  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();

  if (errors.length) {
    console.error(`FAIL smoke.mcp:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("OK smoke.mcp: 401 enforced; full round-trip (register/seed/claim/post/read/presence/lease/task/query/digest) + the v2 decide-this task (task_create options -> task_answer completes with the recorded option) + task_depend derives 'blocked' over the wire + reading marks a post read (ack retired) + admin list_participants/admin_provision/admin_rotate/admin_revoke (teammate token authenticates, rotate mints-before-revoke, revoke kills it, hand-out built, cross-project revoke/rotate refused) verified.");
}

main().catch((err) => {
  console.error("smoke test errored:", err);
  process.exit(1);
});
