// Membership isolation (decision 037, carried onto the v2 task board by decision 039): the cross-project
// surface is MEMBERSHIP-scoped. A project OWNER/ADMIN member sees EVERY task in the project (supervisor); a
// plain MEMBER sees ONLY tasks assigned to THEM; a non-member sees NOTHING - and the SAME predicate gates the
// WRITE (a refused write returns null, the handler 404s, no 403 oracle, no state change). Every NON-task owner
// surface stays owner-scoped: a member gains their task board rows only, never the owned-project surfaces.
// This is the refinement of invariant 3 (owner -> membership isolation), guarded like admin.isolation.
import { closePool, getPool } from "../src/db.js";
import { freshProject } from "./_setup.js";
import {
  listTasksForOwnerBoard,
  loadOwnerBoardTask,
  nextOwnerTaskInProject,
  loadOwnedProject,
  loadProjectForAdminRead,
  listParticipations,
  loadProjectActivity,
  loadProjectBoard,
  listProjects,
} from "../src/admin/queries.js";
import { taskCreateFromOwner, taskEditFromOwner, type OwnerActor } from "../src/admin/task-writes.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const ctx = await freshProject("membership");
  const pool = getPool();
  const P = ctx.project.id;
  const A: OwnerActor = { id: ctx.owner!.id, username: `ownerA-${P}` }; // freshProject inserted A's 'owner' membership
  const agentPid = ctx.participation.id; // freshProject's "tester" agent participation

  // M: a human MEMBER of the project (owners row + project_members 'member').
  const mHandle = `member-p${P}`;
  const m = await pool.query<{ id: string }>(`INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id`, [
    `${mHandle}@test.local`,
    mHandle,
  ]);
  const M: OwnerActor = { id: Number(m.rows[0].id), username: mHandle };
  await pool.query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [P, M.id],
  );

  // X: a human who is NOT a member of the project.
  const xHandle = `stranger-p${P}`;
  const x = await pool.query<{ id: string }>(`INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id`, [
    `${xHandle}@test.local`,
    xHandle,
  ]);
  const X: OwnerActor = { id: Number(x.rows[0].id), username: xHandle };

  // Three tasks authored by owner A: one assigned to M (human), one to the agent, one unassigned.
  const tM = await taskCreateFromOwner(A, P, { title: "for M", assignee: `human:${M.id}` });
  const tAgent = await taskCreateFromOwner(A, P, { title: "for the agent", assignee: `agent:${agentPid}` });
  const tOpen = await taskCreateFromOwner(A, P, { title: "unassigned" });
  check(!!tM && !!tAgent && !!tOpen, "A creates the three seed tasks");
  if (!tM || !tAgent || !tOpen) return finish();

  // ── READ isolation ──
  const aBoard = await listTasksForOwnerBoard(A.id);
  check(
    [tM, tAgent, tOpen].every((t) => aBoard.some((b) => b.taskId === t.taskId)),
    "owner A (supervisor) must see ALL three tasks in the project",
  );

  // Decision 078 (ruling 2026-08-30-3): MEMBERSHIP MEANS SEEING THE PROJECT. This assertion is the reverse
  // of what it said under 037, and the reversal is the decision, not a weakening - a member could already
  // open the project, read its roster and CREATE tasks in it while this predicate hid every task but their
  // own, so they could add a task to a board they could not read. What did NOT move is every isolation
  // assertion below: a NON-member still sees nothing, and a member still cannot WRITE to a task that is not
  // theirs. Those are the checks this file exists for and they are untouched.
  const mBoard = await listTasksForOwnerBoard(M.id);
  check(
    [tM, tAgent, tOpen].every((t) => mBoard.some((b) => b.taskId === t.taskId)),
    `member M must see EVERY task in the project, saw ${mBoard.length}`,
  );
  check(
    mBoard.find((b) => b.taskId === tM.taskId)?.mine === true &&
      mBoard.find((b) => b.taskId === tAgent.taskId)?.mine === false,
    "and `mine` still distinguishes M's own task from the rest - seeing is not owning",
  );

  const xBoard = await listTasksForOwnerBoard(X.id);
  check(xBoard.length === 0, "a NON-MEMBER must see NOTHING on the task board");

  // Decision 048: nextOwnerTaskInProject returns the OLDEST open (todo) task assigned to the owner (FIFO),
  // excluding a given id; null when the queue is empty. Seeded AFTER the mBoard.length===1 check above.
  const tM2 = await taskCreateFromOwner(A, P, { title: "second for M", assignee: `human:${M.id}` });
  check(!!tM2, "A creates a second task for M");
  if (!tM2) return finish();
  check((await nextOwnerTaskInProject(M.id, P, 0)) === tM.taskId, "048: next task for M is the OLDEST of their todos (tM)");
  check((await nextOwnerTaskInProject(M.id, P, tM.taskId)) === tM2.taskId, "048: excluding tM, next task for M is tM2");
  check((await nextOwnerTaskInProject(X.id, P, 0)) === null, "048: a non-member (no assigned tasks) has no next task (null)");

  // ── DETAIL-page loader (decision 041): loadOwnerBoardTask carries the SAME predicate for one task ──
  check((await loadOwnerBoardTask(A.id, P, tAgent.taskId)) !== null, "owner A (supervisor) must load ANY task's detail");
  check((await loadOwnerBoardTask(M.id, P, tM.taskId)) !== null, "member M must load the detail of a task assigned to M");
  // 078: the detail loader carries the SAME predicate as the list, so a member reads any task in the project.
  // If these two ever disagree, one of the two surfaces is lying about what the person is allowed to see.
  check(
    (await loadOwnerBoardTask(M.id, P, tAgent.taskId)) !== null,
    "member M must load an agent-assigned task's detail - the list showed it, the detail must open it",
  );
  check(
    (await loadOwnerBoardTask(M.id, P, tOpen.taskId)) !== null,
    "member M must load an unassigned task's detail too",
  );
  // The boundary that did NOT move: a task in a project M is not in stays invisible, and it is refused the
  // same way a bad id is - no existence oracle. Without this the widening above would have no edge at all.
  check(
    (await loadOwnerBoardTask(X.id, P, tAgent.taskId)) === null,
    "a NON-member still loads nothing, and gets the same null as a bad id",
  );
  check((await loadOwnerBoardTask(X.id, P, tM.taskId)) === null, "a NON-MEMBER must load NO task detail (null)");
  check(
    (await loadOwnerBoardTask(A.id, P, 999999999)) === null && (await loadOwnerBoardTask(A.id, P, Number.NaN)) === null,
    "a missing id and a non-finite id both return null (same 404, no oracle)",
  );

  // Links round-trip as DISCRETE listed items on the detail loader (decision 041).
  const tL = await taskCreateFromOwner(A, P, { title: "with links", links: [{ label: "Spec", url: "https://example.com/s" }] });
  check(!!tL, "A creates a task carrying a link");
  if (tL) {
    const loaded = await loadOwnerBoardTask(A.id, P, tL.taskId);
    check(
      !!loaded && Array.isArray(loaded.links) && loaded.links.length === 1 && loaded.links[0]?.url === "https://example.com/s",
      `a task's links round-trip on the detail loader as discrete items, got ${JSON.stringify(loaded?.links)}`,
    );
  }

  // ── WRITE isolation (a refused write returns null, no state change, no 403 oracle) ──
  const mEditsOwn = await taskEditFromOwner(M, P, tM.taskId, { title: "M edits M's task" });
  check(mEditsOwn !== null, "member M must be able to edit a task assigned to M");

  const mEditsAgent = await taskEditFromOwner(M, P, tAgent.taskId, { title: "hijack" });
  check(mEditsAgent === null, "member M must NOT edit a task NOT assigned to them (null, no oracle)");
  const agentRow = await pool.query<{ title: string }>(`SELECT title FROM tasks WHERE id = $1`, [tAgent.taskId]);
  check(agentRow.rows[0].title === "for the agent", "M's refused edit must leave the agent task unchanged (no state change)");

  const xEdits = await taskEditFromOwner(X, P, tM.taskId, { title: "hijack" });
  check(xEdits === null, "a NON-MEMBER must NOT edit any task (null, no oracle)");

  const aSupervises = await taskEditFromOwner(A, P, tAgent.taskId, { title: "A supervises" });
  check(aSupervises !== null, "owner A (supervisor) must be able to edit the agent-assigned task");

  // ── Non-task surfaces stay OWNER-scoped: a member does not gain the owned-project surfaces ──
  check(
    !(await listProjects(M.id)).some((p) => p.id === P),
    "a member must NOT see the project in their OWNED-projects list (non-task surfaces stay owner-scoped)",
  );
  check(
    (await loadOwnedProject(M.id, P)) === null,
    "a member must NOT load the owner project surface (stays owner-scoped, 404 no oracle)",
  );

  // ── Decision 078's second half: "they see tasks only, if admin, everything" (OI-37) ──────────────
  // The FIRST attempt at this gated the three routes and left every loader behind them on
  // `pr.owner_id = $2`, so a project admin would have reached the overview, Access and settings pages and
  // seen BLANK ones. It passed its tests, because those asserted the LOADER returned a row and never that
  // the PAGE had anything on it. So each assertion below demands CONTENT, not permission.
  check(
    (await loadProjectForAdminRead(M.id, P)) === null,
    "a plain member must NOT read the project's own pages - tasks only",
  );
  check(
    (await loadProjectForAdminRead(X.id, P)) === null,
    "and a non-member reads nothing at all, same null as a bad id",
  );
  // Seed one claim event, so the decision-record assertion below can actually FAIL. Without a row on both
  // sides it reads 0 === 0 and passes however the query is scoped - a check that cannot fail is not a check.
  await getPool().query(
    `INSERT INTO events (project_id, actor_name, type, payload, ts)
     VALUES ($1, 'tester', 'claim', $2, now())`,
    [P, JSON.stringify({ sequence: "decisions", formatted: "D-078" })],
  );
  const ownerParts = await listParticipations(A.id, P);
  check(ownerParts.length > 0, "precondition: the owner sees participations, so an empty admin read means the GATE, not an empty project");

  await getPool().query(`UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND owner_id = $2`, [P, M.id]);
  check((await loadProjectForAdminRead(M.id, P)) !== null, "promoted to admin, the same person reaches the project's pages");
  const adminParts = await listParticipations(M.id, P);
  check(
    adminParts.length === ownerParts.length,
    `and the ACCESS page has content for them: ${adminParts.length} participations vs the owner's ${ownerParts.length}`,
  );
  const adminBoard = await loadProjectBoard(M.id, P);
  const ownerBoardView = await loadProjectBoard(A.id, P);
  // BOTH halves of that page, because it runs two queries and widening only one renders half a page - which
  // is precisely the failure this whole item is about.
  check(
    adminBoard.tasks.length === ownerBoardView.tasks.length && adminBoard.tasks.length > 0,
    `the project board's TASKS have content for an admin: ${adminBoard.tasks.length} vs ${ownerBoardView.tasks.length}`,
  );
  check(
    adminBoard.decisions.length === ownerBoardView.decisions.length && adminBoard.decisions.length > 0,
    `and its DECISION record too, non-empty on both sides: ${adminBoard.decisions.length} vs ${ownerBoardView.decisions.length}`,
  );
  const adminActivity = await loadProjectActivity(M.id, P);
  check(
    adminActivity.events.length === (await loadProjectActivity(A.id, P)).events.length,
    "and the activity panel shows an admin the same events it shows the owner",
  );
  // No participation token VALUE is ever exposed by that page - only whether one is live.
  check(
    adminParts.every((r) => !Object.keys(r).some((k) => /token$/i.test(k))),
    "the access page hands an admin token STATUS, never a token value",
  );
  // The line that matters: reading is not administering. Every mutation still runs through loadOwnedProject.
  check(
    (await loadOwnedProject(M.id, P)) === null,
    "a project ADMIN still does not pass the loader that gates granting, revoking and settings writes",
  );
  await getPool().query(`UPDATE project_members SET role = 'member' WHERE project_id = $1 AND owner_id = $2`, [P, M.id]);
  check((await loadProjectForAdminRead(M.id, P)) === null, "demoted back to member, the project's pages close again");

  finish();
}

function finish(): void {
  void closePool().then(() => {
    if (errors.length) {
      console.error(`FAIL membership.isolation:\n  - ${errors.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(
      "OK membership.isolation: membership means SEEING the project (decision 078) - owner A and member M " +
        "both see ALL three tasks and can open any of their details, while `mine` still marks only M's own; " +
        "a NON-member sees nothing and is refused with the same null as a bad id. Reading is not owning: M " +
        "can edit their own task but NOT an agent-assigned one (null, no state change, no oracle), a " +
        "non-member edits nothing, the owner supervises any. And the project's OWN pages are the admin line " +
        "- a plain member is refused them, a project admin reads them, but still does not pass the " +
        "loadOwnedProject gate that every grant, revoke and settings write runs through.",
    );
  });
}

main().catch((err) => {
  console.error("membership.isolation test errored:", err);
  process.exit(1);
});
