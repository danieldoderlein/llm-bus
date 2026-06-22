import { randomBytes } from "node:crypto";
import { freshProject } from "./_setup.js";
import { getPool, withTx, closePool } from "../src/db.js";
import { hashToken, authenticate } from "../src/auth.js";
import { claimSequence } from "../src/domain/claim.js";
import { post, readPosts } from "../src/domain/post.js";
import { acquireLease, whoHolds } from "../src/domain/lease.js";
import { taskCreate, taskStart, taskBlock, listTasks } from "../src/domain/task.js";
import { queryEvents } from "../src/domain/query.js";

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

  // p1-only activity.
  await withTx((c) => post(c, p1, { to_lane: "backend", body: "p1 only" }));
  await withTx((c) => acquireLease(c, p1, { surface: "p1.py", ttl_seconds: 60 }));
  const p1task = await withTx((c) => taskCreate(c, p1, { title: "p1 task" }));

  // p2 must see NONE of it.
  const p2events = await queryEvents(p2, {});
  if (p2events.length !== 1 || p2events[0].type !== "claim") errors.push(`p2 should see only its own 1 claim event, saw ${p2events.length}`);
  const p2posts = await readPosts(p2, { to_lane: "backend" });
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
    await withTx((c) => taskBlock(c, p2, { task_id: p2task.task_id, on: p1task.task_id, reason: "cross" }));
  } catch {
    crossBlocked = true;
  }
  if (!crossBlocked) errors.push("p2 was able to block on a p1 task (cross-project reference)");

  // Token isolation: a token minted for p1's participation resolves to p1's project, never p2's.
  const t1 = randomBytes(24).toString("base64url");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [p1.participation.id, hashToken(t1)]);
  const resolved = await authenticate(`Bearer ${t1}`);
  if (!resolved || resolved.project.id !== p1.project.id) errors.push(`token resolved to wrong project: ${JSON.stringify(resolved?.project)}`);
  if (resolved && resolved.project.id === p2.project.id) errors.push("p1 token leaked into p2");

  await closePool();

  if (errors.length) {
    console.error(`FAIL isolation.project:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("OK isolation.project: independent counters; no cross-project reads of events/posts/leases/tasks; token scoped to its project.");
}

main().catch((err) => {
  console.error("isolation test errored:", err);
  process.exit(1);
});
