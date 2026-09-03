import { randomBytes } from "node:crypto";
import { freshProject, createParticipation } from "./_setup.js";
import { getPool, withTx, closePool } from "../src/db.js";
import { hashToken, authenticate } from "../src/auth.js";
import { claimSequence } from "../src/domain/claim.js";
import { post, readPosts } from "../src/domain/post.js";
import { acquireLease, whoHolds } from "../src/domain/lease.js";
import { taskCreate, taskStart, taskBlock, taskDepend, taskAssign, listTasks } from "../src/domain/task.js";
import { queryEvents } from "../src/domain/query.js";
import { listProjects, resolveProject } from "../src/domain/projects.js";
import { listRoster } from "../src/domain/roster.js";
import { register, whoIsActive } from "../src/domain/presence.js";

// Two projects must be fully isolated: independent sequence counters, and no read in
// one project ever returns another's events, posts, leases, or tasks.
async function main(): Promise<void> {
  const p1 = await freshProject("iso1");
  const p2 = await freshProject("iso2");
  const errors: string[] = [];

  // Independent counters: both start at 1 for the same sequence name.
  const c1 = await withTx((c) => claimSequence(c, p1, { sequence: "adr" }));
  const c2 = await withTx((c) => claimSequence(c, p2, { sequence: "adr" }));
  if (c1.number !== 1 || c2.number !== 1) errors.push(`independent counters: p1=${c1.number} p2=${c2.number}`);
  const c1b = await withTx((c) => claimSequence(c, p1, { sequence: "adr" }));
  if (c1b.number !== 2) errors.push(`p1 second claim should be 2, got ${c1b.number}`);

  // p1-only activity. The lane has to exist before it can be posted to (decision 065 refuses a lane in
  // neither column); registering is how an agent joins one.
  await withTx((c) => register(c, p1, { lane: "backend" }));
  await withTx((c) => post(c, p1, { to_lane: "backend", body: "p1 only" }));
  await withTx((c) => acquireLease(c, p1, { surface: "p1.py", ttl_seconds: 60 }));
  const p1task = await withTx((c) => taskCreate(c, p1, { title: "p1 task" }));

  // p2 must see NONE of it.
  const p2events = await queryEvents(p2, {});
  if (p2events.length !== 1 || p2events[0].type !== "claim") errors.push(`p2 should see only its own 1 claim event, saw ${p2events.length}`);
  // p1's lane is not p2's lane. Decision 065 refuses a lane that does not exist in the CALLER's project, so
  // p2 gets the same refusal it would get for any made-up name - the message lists p2's own lanes and never
  // reveals that "backend" is real somewhere else (invariant 3, no existence oracle).
  let p2laneErr = "";
  try {
    await readPosts(p2, { to_lane: "backend" });
  } catch (e) {
    p2laneErr = (e as Error).message;
  }
  if (!/does not exist in this project/.test(p2laneErr))
    errors.push(`p2 reading p1's lane must be refused, got ${JSON.stringify(p2laneErr)}`);
  if (/p1|backend.*exists/.test(p2laneErr.replace(/lane "backend"/, "")))
    errors.push(`the refusal must not leak that the lane exists elsewhere: ${p2laneErr}`);
  // Positive control: p2 sees zero of p1's posts through the surface that does not filter by lane.
  const p2posts = await readPosts(p2, {});
  if (p2posts.length !== 0) errors.push(`p2 should see 0 posts, saw ${p2posts.length}`);
  const p2leases = await whoHolds(p2);
  if (p2leases.length !== 0) errors.push(`p2 should see 0 leases, saw ${p2leases.length}`);
  const p2tasks = await listTasks(p2, {});
  if (p2tasks.length !== 0) errors.push(`p2 should see 0 tasks, saw ${p2tasks.length}`);

  // p1 sees its own data.
  const p1tasks = await listTasks(p1, {});
  if (p1tasks.length !== 1) errors.push(`p1 should see 1 task, saw ${p1tasks.length}`);

  // Cross-project task_block must be rejected (no cross-tenant reference/existence oracle).
  const p2task = await withTx((c) => taskCreate(c, p2, { title: "p2 task", owner: "tester" }));
  await withTx((c) => taskStart(c, p2, { task_id: p2task.task_id }));
  let crossBlocked = false;
  try {
    await withTx((c) => taskDepend(c, p2, { task_id: p2task.task_id, depends_on: p1task.task_id }));
  } catch {
    crossBlocked = true;
  }
  if (!crossBlocked) errors.push("p2 was able to block on a p1 task (cross-project reference)");

  // Decision 061: a failed assign now PROBES the other namespace to say "that is a human, use human:" (or
  // vice versa). That probe must never become a cross-tenant existence oracle (invariant 3): both lookups are
  // pinned to ctx.project.id, so a name that exists only in ANOTHER project must fall through to the
  // byte-identical GENERIC message - "exists elsewhere" and "does not exist" must stay indistinguishable.
  await createParticipation(p1, "p1onlybot");
  // Suffix is random, NOT the project id: the error echoes the caller's own input, so an id embedded in the
  // fixture name would make the "never names another project" assertion below a false positive.
  const isoSuffix = randomBytes(4).toString("hex");
  const p1Human = await getPool().query<{ id: string; username: string }>(
    `INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id, username`,
    [`iso-human-${isoSuffix}@test.local`, `isohuman${isoSuffix}`],
  );
  await getPool().query(`INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member')`, [
    p1.project.id,
    Number(p1Human.rows[0].id),
  ]);
  let ownerFieldMsg = "";
  try { await withTx((c) => taskAssign(c, p2, { task_id: p2task.task_id, owner: p1Human.rows[0].username })); }
  catch (e) { ownerFieldMsg = (e as Error).message; }
  if (!/^agent ".*" not found in project/.test(ownerFieldMsg) || /HUMAN MEMBER/.test(ownerFieldMsg))
    errors.push(`p1's human leaked through p2's owner: probe (oracle): "${ownerFieldMsg}"`);
  let humanFieldMsg = "";
  try { await withTx((c) => taskAssign(c, p2, { task_id: p2task.task_id, human: "p1onlybot" })); }
  catch (e) { humanFieldMsg = (e as Error).message; }
  if (!/^human member ".*" not found in project/.test(humanFieldMsg) || /is an AGENT/.test(humanFieldMsg))
    errors.push(`p1's agent leaked through p2's human: probe (oracle): "${humanFieldMsg}"`);
  if (ownerFieldMsg.includes(String(p1.project.id)) || humanFieldMsg.includes(String(p1.project.id)))
    errors.push(`assign errors must never name another project: "${ownerFieldMsg}" / "${humanFieldMsg}"`);

  // ── ROSTER + PRESENCE isolation (the "who is in this project" surfaces) ──
  // These are the surfaces an agent uses to discover WHO it can address, so a leak here hands one tenant the
  // names, handles and emails of another. Both are pinned to ctx.project.id in SQL; nothing asserted it until
  // now, so a dropped WHERE in a refactor would have gone green. list_participants in particular was inline
  // SQL in the tool registration (the only tool that did not delegate), which is exactly why it had no test -
  // it is now domain/roster.ts::listRoster.
  //
  // EVERY absence assertion below is paired with a PRESENCE one on purpose. An isolation test that only
  // checks "the other project's rows are missing" is satisfied by a query that returns NOTHING AT ALL, so it
  // would keep passing through the very refactor most likely to break the feature.
  const p1HumanNoHandle = await getPool().query<{ id: string; email: string }>(
    `INSERT INTO owners (email) VALUES ($1) RETURNING id, email`,
    [`iso-nohandle-${isoSuffix}@test.local`],
  );
  await getPool().query(`INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member')`, [
    p1.project.id,
    Number(p1HumanNoHandle.rows[0].id),
  ]);
  const p2Only = await createParticipation(p2, "p2onlybot");

  const r1 = await listRoster(p1);
  const r2 = await listRoster(p2);
  const names2 = new Set(r2.flatMap((r) => [r.name, r.actor]));

  // Positive controls FIRST: each branch of the UNION actually returns this project's own rows.
  if (!r2.some((r) => r.name === "p2onlybot"))
    errors.push(`roster positive control: p2 does not see its OWN agent (${JSON.stringify(r2.map((r) => r.name))})`);
  if (!r1.some((r) => r.name === p1Human.rows[0].username && r.assign_with === "human"))
    errors.push("roster positive control: p1 does not see its OWN human member (project_members branch dead?)");
  if (!r1.some((r) => r.name === p1HumanNoHandle.rows[0].email))
    errors.push("roster positive control: a member with no handle should surface by email in their OWN project");

  // Absence: nothing of p1's reaches p2's roster - not agents, not members, not a member's EMAIL. The
  // handle-less member matters on its own: COALESCE(username, email) means a leak here is a PII leak.
  if (names2.has("p1onlybot")) errors.push("ROSTER LEAK: p2 can see p1's agent");
  if (names2.has(p1Human.rows[0].username)) errors.push("ROSTER LEAK: p2 can see p1's human member");
  if (names2.has(p1HumanNoHandle.rows[0].email))
    errors.push("ROSTER LEAK: p2 can see a p1 member's EMAIL address");

  // who_is_active: register presence in BOTH projects, then prove each sees only its own.
  await withTx((c) => register(c, p1, { lane: "dev", status: "p1 working" }));
  await withTx((c) => register(c, p2, { lane: "dev", status: "p2 working" }));
  const a1 = await whoIsActive(p1);
  const a2 = await whoIsActive(p2);
  if (!a1.length || !a2.length)
    errors.push(`presence positive control: both projects should show their own registrant (p1=${a1.length}, p2=${a2.length})`);
  if (a2.some((a) => a.status === "p1 working"))
    errors.push("PRESENCE LEAK: p2's who_is_active shows a p1 agent");
  if (a1.some((a) => a.status === "p2 working"))
    errors.push("PRESENCE LEAK: p1's who_is_active shows a p2 agent");

  // Token isolation: a token minted for p1's participation resolves to p1's project, never p2's.
  const t1 = randomBytes(24).toString("base64url");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [p1.participation.id, hashToken(t1)]);
  const resolved = await authenticate(`Bearer ${t1}`);
  if (!resolved || resolved.project.id !== p1.project.id) errors.push(`token resolved to wrong project: ${JSON.stringify(resolved?.project)}`);
  if (resolved && resolved.project.id === p2.project.id) errors.push("p1 token leaked into p2");

  // Invariant 1 after decision 070. The rule USED to be "no tool names a project", which made isolation a
  // property of the token having nowhere else to point. Now a call MAY name a project, so the boundary has
  // to be asserted directly: what a token can enumerate and what it can act in are both its own memberships
  // and nothing else. p1 and p2 are unrelated owners with unrelated participants, so p2 is out of reach.
  const reachable = await listProjects(p1);
  if (!reachable.some((r) => r.project === p1.project.slug))
    errors.push(`positive control: list_projects must include the token's own project, got ${JSON.stringify(reachable.map((r) => r.project))}`);
  if (reachable.some((r) => r.project === p2.project.slug))
    errors.push(`PROJECT LEAK: list_projects exposed another tenant's project ${p2.project.slug}`);
  let reachedP2 = false;
  try {
    await resolveProject(p1, p2.project.slug);
    reachedP2 = true;
  } catch {
    /* expected: not a membership of p1's identity */
  }
  if (reachedP2) errors.push(`PROJECT LEAK: p1's token resolved into p2 by naming its slug`);

  await closePool();

  if (errors.length) {
    console.error(`FAIL isolation.project:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK isolation.project: independent counters; no cross-project reads of events/posts/leases/tasks; the " +
      "ROSTER (agents + human members, incl. a handle-less member's email) and who_is_active never cross a " +
      "project boundary, each verified against a positive control so an empty result cannot pass; assign-probe " +
      "errors are not an existence oracle; token scoped to its project; and after decision 070 a token can " +
      "enumerate and act in ONLY its own memberships - naming another tenant's slug is refused.",
  );
}

main().catch((err) => {
  console.error("isolation test errored:", err);
  process.exit(1);
});
