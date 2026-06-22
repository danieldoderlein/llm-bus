import { withTx, closePool } from "../src/db.js";
import { freshProject } from "./_setup.js";
import {
  taskCreate,
  taskAssign,
  taskStart,
  taskBlock,
  taskResolve,
  taskShip,
  listTasks,
} from "../src/domain/task.js";

// Drive the full legal task lifecycle in one fresh, isolated project, asserting the
// status after each transition, then prove an illegal transition (ship from open) throws.

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const ctx = await freshProject("task");

  // create -> open
  const created = await withTx((c) => taskCreate(c, ctx, { title: "spec" }));
  check(created.status === "open", `create: expected status "open", got "${created.status}"`);
  const taskId = created.task_id;

  // assign -> assigned (owner "tester" is the project admin participant)
  const assigned = await withTx((c) => taskAssign(c, ctx, { task_id: taskId, owner: "tester" }));
  check(assigned.status === "assigned", `assign: expected "assigned", got "${assigned.status}"`);
  check(assigned.owner === "tester", `assign: expected owner "tester", got "${assigned.owner}"`);

  // start -> in_progress
  const started = await withTx((c) => taskStart(c, ctx, { task_id: taskId }));
  check(started.status === "in_progress", `start: expected "in_progress", got "${started.status}"`);

  // second task to block on
  const t2 = await withTx((c) => taskCreate(c, ctx, { title: "dependency" }));
  const t2Id = t2.task_id;

  // block -> blocked, and listTasks shows blockers 1 for the blocked task
  const blocked = await withTx((c) =>
    taskBlock(c, ctx, { task_id: taskId, on: t2Id, reason: "needs t2" }),
  );
  check(blocked.status === "blocked", `block: expected "blocked", got "${blocked.status}"`);

  const listed = await listTasks(ctx, {});
  const row = listed.find((r) => r.task_id === taskId);
  check(row !== undefined, `listTasks: task ${taskId} missing from list`);
  check(
    row?.blockers === 1,
    `listTasks: expected blockers 1 for task ${taskId}, got ${row?.blockers}`,
  );

  // resolve -> in_progress (no open blockers remain)
  const resolved = await withTx((c) => taskResolve(c, ctx, { task_id: taskId }));
  check(
    resolved.status === "in_progress",
    `resolve: expected "in_progress", got "${resolved.status}"`,
  );
  const listedAfter = await listTasks(ctx, {});
  const rowAfter = listedAfter.find((r) => r.task_id === taskId);
  check(
    rowAfter?.blockers === 0,
    `listTasks: expected blockers 0 after resolve, got ${rowAfter?.blockers}`,
  );

  // ship -> done
  const shipped = await withTx((c) => taskShip(c, ctx, { task_id: taskId }));
  check(shipped.status === "done", `ship: expected "done", got "${shipped.status}"`);

  // ILLEGAL: ship a freshly-created (open) task must throw
  const fresh = await withTx((c) => taskCreate(c, ctx, { title: "untouched" }));
  let threw = false;
  try {
    await withTx((c) => taskShip(c, ctx, { task_id: fresh.task_id }));
  } catch {
    threw = true;
  }
  check(threw, `illegal: taskShip on an "open" task should throw, but it did not`);

  await closePool();

  if (errors.length) {
    console.error(`FAIL task.statemachine:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK task.statemachine: open -> assigned -> in_progress -> blocked(1) -> in_progress -> done; illegal ship(open) rejected.",
  );
}

main().catch((err) => {
  console.error("task.statemachine test errored:", err);
  process.exit(1);
});
