// Decision 062: THE PLATE IS NEVER TRUNCATED. Every surface that answers "what is on me?" used to apply one
// flat row budget across every status, so the done/cancelled archive - the fast-growing majority - crowded
// out the open work the surface exists to show, silently and with no signal that anything was missing.
//
// Measured on prod 2026-08-19, before this fix:
//   /admin/tasks        LIMIT 300 over all statuses, ORDER BY project id -> 194 of 494 rows never reached the
//                       renderer; SIX entire projects invisible; 47 open tasks gone, including a decision task
//                       the operator had been asked to answer and reported as "not on the bus for me".
//   list_tasks()        LIMIT 50, ORDER BY id DESC -> 10 open tasks hidden in project-c, 10 in project-b, 1 in project-a
//                       from the DOCUMENTED default call.
//   whats_new           LIMIT 20 with no total -> one agent sat at exactly 20, one task from silent loss.
//
// The fix is structural, not a bigger number: actionable rows are returned in FULL (the board caps ONLY the
// archive; list_tasks sorts terminal rows last so a limit can only eat archive), and wherever a cap does bite
// the surface reports it. This test pins all three, with an archive far deeper than any cap - so it fails if
// anyone reintroduces a single shared budget, however generous.
import { closePool, getPool, withTx } from "../src/db.js";
import { freshProject } from "./_setup.js";
import { listTasksForOwnerBoard } from "../src/admin/queries.js";
import { listTasks, LIST_TASKS_DEFAULT_LIMIT } from "../src/domain/task.js";
import { whatsNew } from "../src/domain/digest.js";
import { tasksPage } from "../src/admin/html.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

// Deeper than every cap in play (board archive 60 / 1000-on-alldone, list_tasks 50, digest 20) and deeper
// than the retired flat LIMIT 300, so a single shared budget cannot pass this test by being large.
const ARCHIVE_DEPTH = 420;

async function main(): Promise<void> {
  const ctx = await freshProject("boardtrunc");
  const pool = getPool();
  const ownerId = ctx.owner!.id;
  const P1 = ctx.project.id;

  // A SECOND project owned by the same human, created after P1 so it sorts later under the retired
  // `ORDER BY pr.id` - this is the exact shape that made six projects invisible in prod.
  const p2 = await pool.query<{ id: string }>(
    `INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $2) RETURNING id`,
    [ownerId, `boardtrunc-late-${P1}`],
  );
  const P2 = Number(p2.rows[0].id);
  await pool.query(`INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'owner')`, [P2, ownerId]);

  // P1 gets a deep archive FIRST, so every later-created open task has a higher id and would fall outside a
  // newest-first page, and every P2 row would fall outside a project-ordered one.
  await pool.query(
    `INSERT INTO tasks (project_id, title, status)
     SELECT $1, 'archived ' || g, 'done' FROM generate_series(1, $2) g`,
    [P1, ARCHIVE_DEPTH],
  );
  const openIds: number[] = [];
  for (const [proj, title] of [
    [P1, "open in the deep-archive project"],
    [P2, "open in the later project"],
    [P2, "a decision the operator must answer"],
  ] as const) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, status, assignee_owner_id) VALUES ($1, $2, 'todo', $3) RETURNING id`,
      [proj, title, ownerId],
    );
    openIds.push(Number(r.rows[0].id));
  }

  // ── 1. The board: every open task survives an archive 7x deeper than the retired flat limit ──
  const board = await listTasksForOwnerBoard(ownerId);
  for (const id of openIds) {
    check(
      board.some((t) => t.taskId === id),
      `board returns open task ${id} despite an archive of ${ARCHIVE_DEPTH} (the plate is never truncated)`,
    );
  }
  check(
    board.some((t) => t.projectId === P2 && t.status === "todo"),
    "the LATER project's open work is reachable (the retired ORDER BY pr.id starved exactly this)",
  );
  const doneRows = board.filter((t) => t.status === "done");
  check(
    doneRows.length < ARCHIVE_DEPTH,
    `the archive IS still bounded (${doneRows.length} of ${ARCHIVE_DEPTH} loaded) - two budgets, not none`,
  );
  check(
    doneRows.length > 0 && doneRows[0].groupTotal === ARCHIVE_DEPTH,
    `a capped column reports its TRUE depth (${doneRows[0]?.groupTotal} should be ${ARCHIVE_DEPTH}), not the rows that loaded`,
  );

  // ── 2. Narrowing to the deep project must not resurrect the starvation ──
  const p1Board = await listTasksForOwnerBoard(ownerId, { projectId: P1 });
  check(
    p1Board.some((t) => t.taskId === openIds[0]),
    "a project-filtered board still returns that project's open task",
  );

  // ── 3. ?alldone=1 loads MORE archive, so "Load more" cannot expand into rows that were never fetched ──
  const allDone = await listTasksForOwnerBoard(ownerId, { allDone: true });
  check(
    allDone.filter((t) => t.status === "done").length > doneRows.length,
    "alldone raises the archive budget (the render cap and the fetch cap move together)",
  );

  // ── 4. The rendered page states the true archive depth, and never hides open work ──
  // assignee "" = the Everyone lens: the pre-cap total describes this row set, so the header can use it.
  const html = tasksPage(
    { id: ownerId, email: "t@test.local", username: "t" } as never,
    board,
    [{ id: P1, name: "p1" }],
    { assignee: "" },
  );
  check(
    html.includes(`>${ARCHIVE_DEPTH}</span>`),
    `the Done column header states the true depth ${ARCHIVE_DEPTH}, not the loaded count`,
  );
  check(
    html.includes("a decision the operator must answer"),
    "the open decision task is actually rendered (the reported symptom, end to end)",
  );

  // ── 5. list_tasks: a bare default call cannot bury an agent's open work under the archive ──
  // The archive has to be NEWER than the open work to reproduce the real shape: agents keep shipping, so
  // done rows accumulate on top and a newest-first page fills with them while the open task ages out the
  // bottom. (An archive that is merely DEEP does not exercise this - the ordering is what fails, not the size.)
  await pool.query(
    `INSERT INTO tasks (project_id, title, status)
     SELECT $1, 'shipped later ' || g, 'done' FROM generate_series(1, 80) g`,
    [P1],
  );
  // Decision 064 narrowed the DEFAULT to open tasks, so the archive cannot crowd it out at all any more.
  const bare = await listTasks(ctx, {});
  check(
    bare.some((t) => t.task_id === openIds[0]) && !bare.some((t) => t.status === "done"),
    "the default list surfaces the open task and carries none of the 500 archived ones (decision 064)",
  );
  // The 062 ordering guarantee still has to hold wherever terminal rows ARE in scope - that is where a page
  // limit can still bite, and it must bite the archive rather than the plate.
  const wide = await listTasks(ctx, { all_states: true });
  check(wide.length === LIST_TASKS_DEFAULT_LIMIT, "an all_states list still returns one page");
  check(
    wide.some((t) => t.task_id === openIds[0]),
    "all_states surfaces the open task under 80 MORE-RECENT archived ones (actionable-first)",
  );
  const firstTerminal = wide.findIndex((t) => t.status === "done" || t.status === "cancelled");
  const lastActionable = wide.reduce((acc, t, i) => (t.status === "done" || t.status === "cancelled" ? acc : i), -1);
  check(
    firstTerminal === -1 || lastActionable < firstTerminal,
    "no terminal row sorts ahead of an actionable one, so the page limit can only ever eat archive",
  );

  // ── 6. whats_new reports the true size of a plate it had to cut ──
  await pool.query(
    `INSERT INTO tasks (project_id, title, status, owner_participation_id)
     SELECT $1, 'mine ' || g, 'todo', $2 FROM generate_series(1, 25) g`,
    [P1, ctx.participation.id],
  );
  const digest = await withTx((c) => whatsNew(c, ctx, {}));
  check(digest.my_open_tasks.length === 20, "the pushed plate still shows one glance-sized page");
  check(
    typeof digest.my_open_tasks_truncated === "string" && digest.my_open_tasks_truncated.includes("of 25"),
    `whats_new says it cut and by how much (got: ${digest.my_open_tasks_truncated ?? "no signal at all"})`,
  );

  finish();
}

function finish(): void {
  void closePool().then(() => {
    if (errors.length) {
      console.error(`FAIL board.truncation:\n  - ${errors.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(
      "OK board.truncation: decision 062 - the plate cannot be truncated. Against an archive of 420, the board " +
        "returns every open task in both an early and a late project, bounds ONLY the archive, and reports its " +
        "true depth; list_tasks sorts actionable ahead of terminal so a page limit can never eat open work; and " +
        "whats_new states the true size of a plate it cut instead of returning a quietly short list.",
    );
  });
}

main().catch((err) => {
  console.error("board.truncation test errored:", err);
  process.exit(1);
});
