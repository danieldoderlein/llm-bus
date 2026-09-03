import { freshProject, createParticipation } from "./_setup.js";
import { closePool, getPool, withTx, query } from "../src/db.js";
import { post, readPosts } from "../src/domain/post.js";
import { taskCreate, taskAssign } from "../src/domain/task.js";
import {
  deleteParticipant,
  listReassignCandidates,
  countOpenTasksForParticipant,
} from "../src/admin/queries.js";

// Deleting a participant (decision 069). Two things are proven here:
//
// 1. IT WORKS AT ALL. Deleting cascades to the participant's participations, which SET NULL on
//    posts.to_participation_id - and a DIRECTED post (an actor, no lane: the ordinary handoff shape) then
//    had BOTH addressing columns null and tripped the posts CHECK. The delete threw, the admin UI rendered
//    a bare 400, and any agent that had ever RECEIVED a directed post could not be removed. Reported by the
//    operator against a live participant.
// 2. THE WORK GOES SOMEWHERE DELIBERATE. Open tasks either move to a chosen successor or return to the
//    board unassigned. Never cancelled, and never left pointing at a deleted row.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  // ── 1. The crash: a directed post must not make its recipient undeletable ──────────────────────────
  const ctx = await freshProject("del-post");
  const bob = await createParticipation(ctx, "bob");
  const directed = await withTx((c) => post(c, ctx, { to_actor: "bob", body: "directed, no lane" }));

  // The addressee's name is kept alongside the id, the way from_actor_name always was for the sender.
  const stored = await query<{ to_actor_name: string | null }>(
    `SELECT to_actor_name FROM posts WHERE id = $1`,
    [directed.post_id],
  );
  check(
    (stored.rows[0].to_actor_name ?? "").endsWith("bob"),
    `a directed post must record its addressee's name, got ${JSON.stringify(stored.rows[0].to_actor_name)}`,
  );

  let threw = "";
  let deleted = false;
  try {
    deleted = await deleteParticipant(ctx.project.ownerId, bob.participant.id);
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw === "", `deleting a participant that received a directed post must not throw, got ${threw}`);
  check(deleted, "the participant is actually deleted");

  // The post SURVIVES with a readable addressee - history is never orphaned (invariant 6).
  const after = await query<{ to_participation_id: string | null; to_actor_name: string | null; body: string }>(
    `SELECT to_participation_id, to_actor_name, body FROM posts WHERE id = $1`,
    [directed.post_id],
  );
  check(after.rowCount === 1, "the post survives the recipient's deletion");
  check(after.rows[0].to_participation_id === null, "its participation link is cleared");
  check(
    (after.rows[0].to_actor_name ?? "").endsWith("bob"),
    "but it still says who it was for - otherwise the row loses all trace of its addressee",
  );

  // ── 2. Hand-over: open work moves to a chosen successor ───────────────────────────────────────────
  const ctx2 = await freshProject("del-reassign");
  const leaving = await createParticipation(ctx2, "leaving-agent");
  const staying = await createParticipation(ctx2, "staying-agent");
  const t1 = await withTx((c) => taskCreate(c, ctx2, { title: "in flight" }));
  const t2 = await withTx((c) => taskCreate(c, ctx2, { title: "also in flight" }));
  await withTx((c) => taskAssign(c, ctx2, { task_id: t1.task_id, owner: "leaving-agent" }));
  await withTx((c) => taskAssign(c, ctx2, { task_id: t2.task_id, owner: "leaving-agent" }));

  check(
    (await countOpenTasksForParticipant(ctx2.project.ownerId, leaving.participant.id)) === 2,
    "the open-task count that informs the choice is right",
  );
  const candidates = await listReassignCandidates(ctx2.project.ownerId, leaving.participant.id);
  check(
    candidates.some((c) => c.name === "staying-agent") && !candidates.some((c) => c.name === "leaving-agent"),
    `the successor list offers others and never the agent being deleted, got ${JSON.stringify(candidates)}`,
  );

  await deleteParticipant(ctx2.project.ownerId, leaving.participant.id, staying.participant.id);
  const moved = await query<{ id: string; owner_name: string | null; owner_participation_id: string | null; status: string }>(
    `SELECT id, owner_name, owner_participation_id, status FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [[t1.task_id, t2.task_id]],
  );
  check(
    moved.rows.every((r) => Number(r.owner_participation_id) === staying.participation.id),
    `both tasks move to the successor, got ${JSON.stringify(moved.rows.map((r) => r.owner_participation_id))}`,
  );
  check(
    moved.rows.every((r) => (r.owner_name ?? "").endsWith("staying-agent")),
    `and the board shows the new owner, got ${JSON.stringify(moved.rows.map((r) => r.owner_name))}`,
  );
  check(moved.rows.every((r) => r.status !== "cancelled"), "work is never cancelled by a deletion");

  // ── 3. No successor chosen: the work goes back on the board rather than nowhere ────────────────────
  const ctx3 = await freshProject("del-unassign");
  const gone = await createParticipation(ctx3, "gone-agent");
  const t3 = await withTx((c) => taskCreate(c, ctx3, { title: "orphan candidate" }));
  await withTx((c) => taskAssign(c, ctx3, { task_id: t3.task_id, owner: "gone-agent" }));
  await deleteParticipant(ctx3.project.ownerId, gone.participant.id, null);
  const pooled = await query<{ status: string; owner_participation_id: string | null; owner_name: string | null }>(
    `SELECT status, owner_participation_id, owner_name FROM tasks WHERE id = $1`,
    [t3.task_id],
  );
  check(pooled.rows[0].status === "todo", `unclaimed work returns to todo, got ${pooled.rows[0].status}`);
  check(pooled.rows[0].owner_participation_id === null, "and is unassigned");
  check(pooled.rows[0].owner_name === null, "with no departed agent still shown as its owner");

  // ── 4. A successor from ANOTHER owner is refused; the work falls back to the pool ──────────────────
  // The dropdown cannot offer it, but the write must not trust the form (invariant 3).
  const ctx4 = await freshProject("del-foreign");
  const leaving4 = await createParticipation(ctx4, "leaving-4");
  const foreign = await freshProject("del-foreign-other");
  const t4 = await withTx((c) => taskCreate(c, ctx4, { title: "must not cross tenants" }));
  await withTx((c) => taskAssign(c, ctx4, { task_id: t4.task_id, owner: "leaving-4" }));
  await deleteParticipant(ctx4.project.ownerId, leaving4.participant.id, foreign.participant.id);
  const notCrossed = await query<{ owner_participation_id: string | null; status: string }>(
    `SELECT owner_participation_id, status FROM tasks WHERE id = $1`,
    [t4.task_id],
  );
  check(
    notCrossed.rows[0].owner_participation_id === null,
    "work must never be handed to another owner's agent - it falls back to unassigned",
  );
  check(notCrossed.rows[0].status === "todo", "and stays actionable");

  // Positive control for section 4: the refusal above must not be a query that simply never matches.
  const ctx5 = await freshProject("del-control");
  const leaving5 = await createParticipation(ctx5, "leaving-5");
  const staying5 = await createParticipation(ctx5, "staying-5");
  const t5 = await withTx((c) => taskCreate(c, ctx5, { title: "same owner, must move" }));
  await withTx((c) => taskAssign(c, ctx5, { task_id: t5.task_id, owner: "leaving-5" }));
  await deleteParticipant(ctx5.project.ownerId, leaving5.participant.id, staying5.participant.id);
  const crossedOk = await query<{ owner_participation_id: string | null }>(
    `SELECT owner_participation_id FROM tasks WHERE id = $1`,
    [t5.task_id],
  );
  check(
    Number(crossedOk.rows[0].owner_participation_id) === staying5.participation.id,
    "positive control: a same-owner successor DOES receive the work",
  );

  // Reading still works after all this - the surviving posts render without their participation.
  const stillReadable = await readPosts(ctx, {});
  check(stillReadable.length >= 1, "posts remain readable after their recipient is deleted");

  if (errors.length) {
    console.error("FAIL participant.delete:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log(
    "OK participant.delete: a directed post no longer makes its recipient undeletable (the post survives with a readable addressee); open work moves to a chosen successor with the board updated, or returns to todo unassigned when none is chosen; a cross-owner successor is refused and the work falls back to the pool, with a positive control proving the refusal is real; work is never cancelled.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(closePool);
