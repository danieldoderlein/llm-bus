import { withTx, closePool, getPool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import { register } from "../src/domain/presence.js";
import {
  taskCreate,
  taskAssign,
  taskStart,
  taskStop,
  taskBlock,
  taskResolve,
  taskShip,
  taskAnswer,
  taskCancel,
  taskReopen,
  taskDepend,
  taskUndepend,
  listTasks,
} from "../src/domain/task.js";

// The v2 five-state task machine (decision 039): todo / in_progress / blocked(DERIVED) / done / cancelled,
// with assignee as an editable field, dependency edges, options+answer, and cancel/reopen. `blocked` is
// derived (an unmet dependency OR an open manual blocker) - surfaced through listTasks' effective status.

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const ctx = await freshProject("task");
  // all_states so these lookups stay independent of the default scope (decision 064 narrowed it to open
  // tasks): a helper that silently stops finding terminal rows would make a future assertion confusing.
  const statusOf = async (id: number): Promise<string | undefined> =>
    (await listTasks(ctx, { all_states: true })).find((r) => r.task_id === id)?.status;
  const blockersOf = async (id: number): Promise<number | undefined> =>
    (await listTasks(ctx, { all_states: true })).find((r) => r.task_id === id)?.blockers;

  // create -> todo (no owner); assignment is a FIELD, not a status
  const created = await withTx((c) => taskCreate(c, ctx, { title: "spec" }));
  check(created.status === "todo", `create: expected "todo", got "${created.status}"`);
  const taskId = created.task_id;

  // assign (from todo) -> still todo, owner set
  const assigned = await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: "tester" }));
  check(assigned.status === "todo" && assigned.owner === "tester", `assign: expected todo+tester, got ${assigned.status}/${assigned.owner}`);

  // Decision 061: the assignee snapshot is composed from the ASSIGNEE's OWN bound human, never the caller's
  // handle. The old qualifyActor() used ctx.participant.handle, so assigning to someone else's agent stamped
  // YOUR handle onto THEIR agent, and list_participants then disagreed with the board about the same row.
  const bot = await createParticipation(ctx, "alicebot");
  const humanRow = await getPool().query<{ id: string; username: string }>(
    `INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id, username`,
    [`task-human-${ctx.project.id}@test.local`, `taskhuman${ctx.project.id}`],
  );
  const humanId = Number(humanRow.rows[0].id);
  const humanHandle = humanRow.rows[0].username;
  await getPool().query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [humanId, bot.participation.id]);
  await getPool().query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [ctx.project.id, humanId],
  );
  const boundAssign = await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: "alicebot" }));
  check(
    boundAssign.owner === `${humanHandle}/alicebot`,
    `assign must qualify with the ASSIGNEE's bound human, not the caller: expected ${humanHandle}/alicebot, got "${boundAssign.owner}"`,
  );
  // Decision 061: the reported incident is NOT a name miss - the agent label RESOLVES, so no cross-namespace
  // probe can catch it. An agent queue nothing polls is caught by LIVENESS instead: alicebot has never
  // registered, so assigning to it warns and names the human whose board would actually receive the work.
  check(
    !!boundAssign.warning && /never been seen/.test(boundAssign.warning) && boundAssign.warning.includes(`human:"${humanHandle}"`),
    `assigning into an unpolled agent queue must warn and name the human: got ${JSON.stringify(boundAssign.warning)}`,
  );
  // An agent that IS on the bus must stay quiet - the signal is worthless if it fires on every assign.
  await withTx((c) => register(c, bot, { lane: "qa" }));
  const liveAssign = await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: "alicebot" }));
  check(!liveAssign.warning, `assigning to a live agent must NOT warn, got ${JSON.stringify(liveAssign.warning)}`);

  // A cross-namespace miss is LOUD and directive, never silent and never merely generic - filing a person's
  // work into an agent queue is exactly what reached nobody in the project-a report.
  let agentNamedInHumanField = "";
  try { await withTx((c) => taskAssign(c, ctx, { task_id: taskId, human: "alicebot" })); }
  catch (e) { agentNamedInHumanField = (e as Error).message; }
  check(
    /owner:/.test(agentNamedInHumanField) && /AGENT/.test(agentNamedInHumanField),
    `an agent named in human: must point at owner:, got "${agentNamedInHumanField}"`,
  );
  let humanNamedInAgentField = "";
  try { await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: humanHandle })); }
  catch (e) { humanNamedInAgentField = (e as Error).message; }
  check(
    /human:/.test(humanNamedInAgentField) && /HUMAN MEMBER/.test(humanNamedInAgentField),
    `a human named in owner: must point at human:, got "${humanNamedInAgentField}"`,
  );
  // Assigning to the human for real lands the BARE handle (what the web board filters on).
  const toHuman = await withTx((c) => taskAssign(c, ctx, { task_id: taskId, human: humanHandle }));
  check(toHuman.owner === humanHandle, `human assign must store the bare handle, got "${toHuman.owner}"`);
  // Restore the original assignment so the state-machine assertions below are unperturbed.
  await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: "tester" }));

  // start -> in_progress
  const started = await withTx((c) => taskStart(c, ctx, { task_id: taskId }));
  check(started.status === "in_progress", `start: expected "in_progress", got "${started.status}"`);

  // manual block -> derived blocked (effective), blockers 1; resolve -> back to base (in_progress)
  await withTx((c) => taskBlock(c, ctx, { task_id: taskId, reason: "waiting on legal", unblock_condition: "legal returns the redline", unblock_owner: ctx.participant.name }));
  check((await statusOf(taskId)) === "blocked", `manual block: expected effective "blocked", got "${await statusOf(taskId)}"`);
  check((await blockersOf(taskId)) === 1, `manual block: expected 1 blocker, got ${await blockersOf(taskId)}`);
  await withTx((c) => taskResolve(c, ctx, { task_id: taskId }));
  check((await statusOf(taskId)) === "in_progress", `resolve: expected back to "in_progress", got "${await statusOf(taskId)}"`);
  check((await blockersOf(taskId)) === 0, `resolve: expected 0 blockers, got ${await blockersOf(taskId)}`);

  // dependency edge -> derived blocked; a blocked task cannot start; the dep completing auto-returns it
  const dep = await withTx((c) => taskCreate(c, ctx, { title: "dependency", owner: "tester" }));
  const waiter = await withTx((c) => taskCreate(c, ctx, { title: "waits on dep", owner: "tester" }));
  await withTx((c) => taskDepend(c, ctx, { task_id: waiter.task_id, depends_on: dep.task_id }));
  check((await statusOf(waiter.task_id)) === "blocked", `dep: waiter should be derived-blocked, got "${await statusOf(waiter.task_id)}"`);
  let cannotStart = false;
  try { await withTx((c) => taskStart(c, ctx, { task_id: waiter.task_id })); } catch { cannotStart = true; }
  check(cannotStart, "dep: starting a blocked task must throw");
  // complete the dependency -> waiter auto-returns to todo (grabbable)
  await withTx((c) => taskStart(c, ctx, { task_id: dep.task_id }));
  await withTx((c) => taskShip(c, ctx, { task_id: dep.task_id }));
  check((await statusOf(waiter.task_id)) === "todo", `dep done: waiter should auto-return to "todo", got "${await statusOf(waiter.task_id)}"`);
  // self-dep + cycle are rejected
  let selfDep = false;
  try { await withTx((c) => taskDepend(c, ctx, { task_id: waiter.task_id, depends_on: waiter.task_id })); } catch { selfDep = true; }
  check(selfDep, "a task cannot depend on itself");

  // grab: an unassigned task is self-assigned on start
  const pool = await withTx((c) => taskCreate(c, ctx, { title: "backlog item" }));
  const grabbed = await withTx((c) => taskStart(c, ctx, { task_id: pool.task_id }));
  check(grabbed.status === "in_progress", "grab: starting an unassigned task moves it to in_progress");
  check(
    (await listTasks(ctx, { mine: true })).some((r) => r.task_id === pool.task_id),
    "grab: the grabbed task is now assigned to the caller (mine=true)",
  );

  // reassign in-flight = hand-off: an in_progress task reverts to todo under the new assignee
  await createParticipation(ctx, "backend");
  const handoff = await withTx((c) => taskAssign(c, ctx, { task_id: pool.task_id, owner: "backend" }));
  check(handoff.status === "todo" && handoff.owner === "backend", `handoff: expected todo+backend, got ${handoff.status}/${handoff.owner}`);

  // taskStop (decision 042): in_progress -> todo ("un-start", keeps the assignee). Illegal from todo/terminal.
  const stoppable = await withTx((c) => taskCreate(c, ctx, { title: "stoppable", owner: "tester" }));
  await withTx((c) => taskStart(c, ctx, { task_id: stoppable.task_id }));
  const stopped = await withTx((c) => taskStop(c, ctx, { task_id: stoppable.task_id }));
  check(stopped.status === "todo", `stop: in_progress -> todo, got "${stopped.status}"`);
  let illegalStop = false;
  try { await withTx((c) => taskStop(c, ctx, { task_id: stoppable.task_id })); } catch { illegalStop = true; }
  check(illegalStop, "stop: un-starting a todo task must throw");

  // taskAnswer notifies the ASKER (created_by), not just dependents (decision 042). tester creates it (asker),
  // a second agent answers it -> tester (the asker) receives a delivered post, so an "ask me" round-trip closes.
  const backendCtx = await createParticipation(ctx, "backend2");
  const asked = await withTx((c) => taskCreate(c, ctx, { title: "decide for me", options: ["a", "b"] }));
  await withTx((c) => taskAnswer(c, backendCtx, { task_id: asked.task_id, option: "a" }));
  const askerPosts = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM posts WHERE to_participation_id = $1 AND ref = $2`,
    [ctx.participation.id, `task:${asked.task_id}`],
  );
  check(Number(askerPosts.rows[0].n) === 1, `answer: the asker (created_by) is notified, got ${askerPosts.rows[0].n} posts`);

  // cancel + reopen
  const doomed = await withTx((c) => taskCreate(c, ctx, { title: "redundant" }));
  const cancelled = await withTx((c) => taskCancel(c, ctx, { task_id: doomed.task_id }));
  check(cancelled.status === "cancelled", `cancel: expected "cancelled", got "${cancelled.status}"`);
  const reopened = await withTx((c) => taskReopen(c, ctx, { task_id: doomed.task_id }));
  check(reopened.status === "todo", `reopen: expected "todo", got "${reopened.status}"`);

  // options + answer: a decide-this task records the chosen option and completes
  const decision = await withTx((c) => taskCreate(c, ctx, { title: "pick a db", owner: "tester", options: ["postgres", "sqlite"] }));
  let badOption = false;
  try { await withTx((c) => taskAnswer(c, ctx, { task_id: decision.task_id, option: "mysql" })); } catch { badOption = true; }
  check(badOption, "answer: an option not in the list (and not 'other') must be rejected");
  const answered = await withTx((c) => taskAnswer(c, ctx, { task_id: decision.task_id, option: "postgres", note: "fits" }));
  check(answered.status === "done", `answer: expected "done", got "${answered.status}"`);
  const selRow = await getPool().query<{ selected_option: string | null; answer_note: string | null }>(
    `SELECT selected_option, answer_note FROM tasks WHERE id = $1`,
    [decision.task_id],
  );
  check(selRow.rows[0].selected_option === "postgres" && selRow.rows[0].answer_note === "fits", "answer: records the choice + note");

  // ILLEGAL: ship a todo task throws; assign a cancelled task throws
  const untouched = await withTx((c) => taskCreate(c, ctx, { title: "untouched" }));
  let illegalShip = false;
  try { await withTx((c) => taskShip(c, ctx, { task_id: untouched.task_id })); } catch { illegalShip = true; }
  check(illegalShip, "illegal: shipping a todo task must throw");
  await withTx((c) => taskCancel(c, ctx, { task_id: untouched.task_id }));
  let illegalAssign = false;
  try { await withTx((c) => taskAssign(c, ctx, { task_id: untouched.task_id, owner: "tester" })); } catch { illegalAssign = true; }
  check(illegalAssign, "illegal: assigning a cancelled (terminal) task must throw");

  // undepend removes the edge (sanity)
  await withTx((c) => taskUndepend(c, ctx, { task_id: waiter.task_id, depends_on: dep.task_id }));

  // owner filter accepts BOTH the bare label and the qualified handle/label form (regression #018)
  const owned = await withTx((c) => taskCreate(c, ctx, { title: "owned", owner: "tester" }));
  await getPool().query(`UPDATE tasks SET owner_name = 'somehandle/tester' WHERE id = $1`, [owned.task_id]);
  check((await listTasks(ctx, { owner: "tester" })).some((r) => r.task_id === owned.task_id), "owner=bare matches a qualified owner_name");
  check((await listTasks(ctx, { owner: "somehandle/tester" })).some((r) => r.task_id === owned.task_id), "owner=qualified matches too");
  check(!(await listTasks(ctx, { owner: "someone-else" })).some((r) => r.task_id === owned.task_id), "owner=other does NOT match");

  await closePool();
  if (errors.length) {
    console.error(`FAIL task.statemachine:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK task.statemachine (v2, decision 039): create->todo; assign is a field; start (+grab); manual block " +
      "and dependency edges both derive 'blocked' (a blocked task cannot start; a completed dependency " +
      "auto-returns the waiter to todo; self-dep rejected); reassign-in-flight hands off to todo; cancel/reopen; " +
      "options+answer records the choice and completes (bad option rejected); illegal ship(todo)/assign(cancelled) " +
      "rejected; owner filter matches bare + qualified.",
  );
}

main().catch((err) => {
  console.error("task.statemachine test errored:", err);
  process.exit(1);
});
