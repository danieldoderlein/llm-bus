// admin.taskwrites (decision 039, Stage C) - the highest-risk surface: a human WEB write layer that authors
// and drives tasks across a human's projects. The single non-negotiable property: a non-member write and a
// non-owner (wrong-project, or member-out-of-scope) write both return null (the handler 404s), leave the
// target row BYTE-IDENTICAL, and are INDISTINGUISHABLE from a bad id (no 403 oracle) - the membership
// predicate (decision 037) carried onto the write path. Plus: the assignee dropdown tag is user input and
// grants no identity (invariant 1) - an out-of-project agent/human tag is refused. Guarded like admin.isolation.
import { closePool, getPool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import {
  taskCreateFromOwner,
  taskEditFromOwner,
  taskAssignFromOwner,
  taskStartFromOwner,
  taskStopFromOwner,
  taskShipFromOwner,
  taskAnswerFromOwner,
  taskHandoffFromOwner,
  taskCancelFromOwner,
  taskReopenFromOwner,
  taskDependFromOwner,
  taskUndependFromOwner,
  type OwnerActor,
} from "../src/admin/task-writes.js";
import { listTasksForOwnerBoard, listProjectMembersForAssign, createProject } from "../src/admin/queries.js";
import { resolveOwner } from "../src/admin/owner.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

interface Row {
  status: string;
  title: string;
  owner_participation_id: string | null;
  assignee_owner_id: string | null;
  owner_name: string | null;
}
async function taskRow(id: number): Promise<Row> {
  const r = await getPool().query<Row>(
    `SELECT status, title, owner_participation_id, assignee_owner_id, owner_name FROM tasks WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}
function sameRow(a: Row, b: Row): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.owner_participation_id === b.owner_participation_id &&
    a.assignee_owner_id === b.assignee_owner_id &&
    a.owner_name === b.owner_name
  );
}

async function main(): Promise<void> {
  const pool = getPool();
  const ctx = await freshProject("taskwrites"); // owner A owns project P; A's agent = "tester" participation
  const P = ctx.project.id;
  const A: OwnerActor = { id: ctx.owner!.id, username: `ownerA-${P}` };
  const testerPid = ctx.participation.id;
  const backend = await createParticipation(ctx, "backend"); // a 2nd agent in P
  const backendPid = backend.participation.id;

  // M: a human MEMBER of P (owners row + project_members 'member').
  const mHandle = `member-p${P}`;
  const m = await pool.query<{ id: string }>(`INSERT INTO owners (email, username) VALUES ($1,$2) RETURNING id`, [
    `${mHandle}@test.local`,
    mHandle,
  ]);
  const M: OwnerActor = { id: Number(m.rows[0].id), username: mHandle };
  await pool.query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
    [P, M.id],
  );

  // X: a human who is NOT a member of P.
  const xHandle = `stranger-p${P}`;
  const x = await pool.query<{ id: string }>(`INSERT INTO owners (email, username) VALUES ($1,$2) RETURNING id`, [
    `${xHandle}@test.local`,
    xHandle,
  ]);
  const X: OwnerActor = { id: Number(x.rows[0].id), username: xHandle };

  // B: a different owner with their own project PB (cross-tenant), plus an agent in PB.
  const ctxB = await freshProject("taskwritesB");
  const PB = ctxB.project.id;
  const B: OwnerActor = { id: ctxB.owner!.id, username: `ownerB-${PB}` };
  const pbTesterPid = ctxB.participation.id;

  // ── Seed tasks in P (authored by owner A) ──
  const tAgent = await taskCreateFromOwner(A, P, { title: "agent task", assignee: `agent:${testerPid}` });
  check(tAgent !== null, "A creates an agent-assigned task");
  const tM = await taskCreateFromOwner(A, P, { title: "M task", assignee: `human:${M.id}` });
  check(tM !== null, "A creates an M-assigned task");
  if (!tAgent || !tM) {
    return finish();
  }
  const agentRow0 = await taskRow(tAgent.taskId);
  check(agentRow0.owner_participation_id === String(testerPid), "agent task bound to the agent participation");
  check(agentRow0.assignee_owner_id === null, "agent task has no human assignee");
  const mRow0 = await taskRow(tM.taskId);
  check(mRow0.assignee_owner_id === String(M.id), "M task bound to member M as the human assignee");

  // ── 1. X (non-member): EVERY mutator null + row byte-identical ──
  const beforeAgent = await taskRow(tAgent.taskId);
  check((await taskEditFromOwner(X, P, tAgent.taskId, { title: "hijack" })) === null, "X cannot edit");
  check((await taskCancelFromOwner(X, P, tAgent.taskId)) === null, "X cannot cancel");
  check((await taskStartFromOwner(X, P, tAgent.taskId)) === null, "X cannot start");
  check((await taskAssignFromOwner(X, P, tAgent.taskId, `human:${X.id}`)) === null, "X cannot assign");
  check((await taskAnswerFromOwner(X, P, tAgent.taskId, { note: "x" })) === null, "X cannot answer");
  check((await taskReopenFromOwner(X, P, tAgent.taskId)) === null, "X cannot reopen");
  check((await taskDependFromOwner(X, P, tAgent.taskId, tM.taskId)) === null, "X cannot depend");
  check((await taskUndependFromOwner(X, P, tAgent.taskId, tM.taskId)) === null, "X cannot undepend");
  check(sameRow(beforeAgent, await taskRow(tAgent.taskId)), "X's refused writes leave the row byte-identical");
  check((await taskCreateFromOwner(X, P, { title: "sneak" })) === null, "X (non-member) cannot create in P");

  // No-oracle: a refused write by X is indistinguishable from a bad task id used by the legit owner A.
  const bogusId = tAgent.taskId + 9_000_000;
  check((await taskEditFromOwner(X, P, tAgent.taskId, { title: "z" })) === (await taskEditFromOwner(A, P, bogusId, { title: "z" })),
    "X's refusal returns the SAME null as a bad id (no existence oracle)");

  // ── 2. B (cross-owner): null on P's task + no-op; but B is a valid owner of PB ──
  check((await taskEditFromOwner(B, P, tAgent.taskId, { title: "cross" })) === null, "B cannot edit a task in A's project");
  check(sameRow(beforeAgent, await taskRow(tAgent.taskId)), "B's refused write leaves the row unchanged");
  check((await taskCancelFromOwner(A, PB, tAgent.taskId)) === null, "a P task id under project PB is not found (cross-project id confusion refused)");
  check((await taskCreateFromOwner(B, PB, { title: "B's own" })) !== null, "B CAN author in B's own project PB (positive control)");

  // ── 3. Assignee-tag re-proof (invariant 1): out-of-project agent/human tags refused, no state change ──
  const beforeAssign = await taskRow(tAgent.taskId);
  check((await taskAssignFromOwner(A, P, tAgent.taskId, `human:${X.id}`)) === null, "assign to a non-member human is refused");
  check((await taskAssignFromOwner(A, P, tAgent.taskId, `agent:${pbTesterPid}`)) === null, "assign to an agent from another project is refused");
  check((await taskAssignFromOwner(A, P, tAgent.taskId, "agent:not-a-number")) === null, "a malformed assignee tag is refused");
  check(sameRow(beforeAssign, await taskRow(tAgent.taskId)), "refused assignments leave the assignee unchanged");
  check((await taskCreateFromOwner(A, P, { title: "bad assignee", assignee: `human:${X.id}` })) === null, "create with a non-member assignee is refused");

  // ── 4. M (plain member): may author; may act ONLY on tasks assigned to M ──
  check((await taskCreateFromOwner(M, P, { title: "M authored" })) !== null, "member M may author a task");
  // M acts on M's own task: start -> ship.
  const mStart = await taskStartFromOwner(M, P, tM.taskId);
  check(mStart !== null && mStart.status === "in_progress", "M starts M's own task");
  const mShip = await taskShipFromOwner(M, P, tM.taskId);
  check(mShip !== null && mShip.status === "done", "M ships M's own task");
  // M cannot touch the agent-assigned task.
  const beforeAgent2 = await taskRow(tAgent.taskId);
  check((await taskEditFromOwner(M, P, tAgent.taskId, { title: "M hijack" })) === null, "M cannot edit an agent-assigned task");
  check((await taskCancelFromOwner(M, P, tAgent.taskId)) === null, "M cannot cancel an agent-assigned task");
  check((await taskDependFromOwner(M, P, tAgent.taskId, tM.taskId)) === null, "M cannot add a dep to a task not theirs");
  check(sameRow(beforeAgent2, await taskRow(tAgent.taskId)), "M's refused writes leave the agent task unchanged");

  // A decision task awaiting M: M may answer it; the same decision task assigned to an AGENT, M may not.
  const tDecideM = await taskCreateFromOwner(A, P, { title: "decide (M)", assignee: `human:${M.id}`, options: ["red", "blue"] });
  const tDecideAgent = await taskCreateFromOwner(A, P, { title: "decide (agent)", assignee: `agent:${backendPid}`, options: ["red", "blue"] });
  check(tDecideM !== null && tDecideAgent !== null, "A creates two decision tasks");
  if (tDecideM && tDecideAgent) {
    check((await taskAnswerFromOwner(M, P, tDecideAgent.taskId, { option: "red" })) === null, "M cannot answer a decision awaiting an agent");
    const mAns = await taskAnswerFromOwner(M, P, tDecideM.taskId, { option: "red" });
    check(mAns !== null && mAns.status === "done", "M answers a decision task awaiting M");
    const decRow = await taskRow(tDecideM.taskId);
    check(decRow.status === "done", "M's answered decision is done");
    const sel = await pool.query<{ selected_option: string | null; answered_by_owner_id: string | null }>(
      `SELECT selected_option, answered_by_owner_id FROM tasks WHERE id = $1`,
      [tDecideM.taskId],
    );
    check(sel.rows[0].selected_option === "red" && sel.rows[0].answered_by_owner_id === String(M.id),
      "M's answer records the option + owner attribution");
    // An invalid option (not in the task's options) is refused with no oracle - same null as a bad id.
    check((await taskAnswerFromOwner(A, P, tDecideAgent.taskId, { option: "green" })) === null, "an option not in the task's options is refused");
  }

  // ── 5. A (owner): full authority + supervisor override on an agent-assigned task ──
  const aEdit = await taskEditFromOwner(A, P, tAgent.taskId, { title: "A edited" });
  check(aEdit !== null && (await taskRow(tAgent.taskId)).title === "A edited", "owner A edits any task (supervisor)");
  const aCancel = await taskCancelFromOwner(A, P, tAgent.taskId);
  check(aCancel !== null && aCancel.status === "cancelled", "owner A cancels an agent-assigned task");
  const aReopen = await taskReopenFromOwner(A, P, tAgent.taskId);
  check(aReopen !== null && aReopen.status === "todo", "owner A reopens the cancelled task to todo");

  // ── 6. Dependency edges via the owner path: self-dep + cycle refused ──
  const d1 = await taskCreateFromOwner(A, P, { title: "dep1" });
  const d2 = await taskCreateFromOwner(A, P, { title: "dep2" });
  if (d1 && d2) {
    check((await taskDependFromOwner(A, P, d1.taskId, d1.taskId)) === null, "self-dependency refused");
    check((await taskDependFromOwner(A, P, d1.taskId, d2.taskId)) !== null, "A adds d1 -> d2");
    check((await taskDependFromOwner(A, P, d2.taskId, d1.taskId)) === null, "the reverse edge (cycle) is refused");
    // d1 is now derived-blocked on d2 (not done) -> cannot start.
    check((await taskStartFromOwner(A, P, d1.taskId)) === null, "a derived-blocked task cannot be started");
    // undepend clears it -> startable.
    check((await taskUndependFromOwner(A, P, d1.taskId, d2.taskId)) !== null, "A removes the edge");
    check((await taskStartFromOwner(A, P, d1.taskId)) !== null, "after undepend, d1 starts");
  }

  // ── 7. Read-board isolation: the decision-037 predicate carried onto /admin/tasks (listTasksForOwnerBoard) ──
  const aBoard = await listTasksForOwnerBoard(A.id);
  check(
    aBoard.some((t) => t.taskId === tAgent.taskId) && aBoard.some((t) => t.taskId === tM.taskId),
    "owner A's board shows every task in P (supervisor)",
  );
  const mBoard = await listTasksForOwnerBoard(M.id);
  check(mBoard.some((t) => t.taskId === tM.taskId), "member M's board shows a task assigned to M");
  // Decision 078 (ruling 2026-08-30-3): a member READS the whole project. What the board must still do is
  // tell them which rows are theirs - seeing is not owning, and the write assertions further down are what
  // enforce the difference.
  check(mBoard.some((t) => t.taskId === tAgent.taskId), "member M's board shows an agent-assigned task too (078)");
  check(
    mBoard.find((t) => t.taskId === tM.taskId)?.mine === true &&
      mBoard.find((t) => t.taskId === tAgent.taskId)?.mine === false,
    "and `mine` marks only the rows actually assigned to M",
  );
  check((await listTasksForOwnerBoard(X.id)).length === 0, "a non-member's task board is empty");

  // ── 7b. A block that names a PERSON is visible as such on their board (074, ruling 2026-08-30-1) ──
  // Until now a block naming a human reached no human surface at all: the agent arm was delivered via
  // whats_new.waiting_on_you and the person was told nowhere. On the board the row was indistinguishable
  // from any other blocked task, so the one person who could clear it had no way to pick it out.
  await getPool().query(
    `INSERT INTO task_blockers (task_id, blocked_on_task_id, reason, unblock_condition, unblock_owner_id)
     VALUES ($1, NULL, 'needs a person', 'A signs it off', $2)`,
    [tAgent.taskId, A.id],
  );
  const aBoard2 = await listTasksForOwnerBoard(A.id);
  const flagged = aBoard2.find((t) => t.taskId === tAgent.taskId);
  check(!!flagged && flagged.waitingOnMe === true, "the blocked task is marked as waiting on A specifically");
  check(!!flagged && flagged.mine === false, "and it is NOT folded into `mine` - the task is still someone else's work");
  check(
    aBoard2.filter((t) => t.waitingOnMe).length === 1,
    "only the task actually naming A is flagged - the flag is per-row, not per-board",
  );
  // THE GAP THIS USED TO PIN IS NOW CLOSED, which is why the assertion is inverted rather than deleted.
  // When #1317 shipped, a block naming a plain member reached them in the EMAIL and then deep-linked to a
  // task their board would not open - an email saying "you are holding this up" with a dead link. That was
  // filed as its own problem (OI-35) and the operator answered it by fixing the model underneath instead:
  // decision 078 gives a member the project. The dead link is gone as a consequence, not as a carve-out.
  await getPool().query(
    `INSERT INTO task_blockers (task_id, blocked_on_task_id, reason, unblock_condition, unblock_owner_id)
     VALUES ($1, NULL, 'needs a person', 'M signs it off', $2)`,
    [tAgent.taskId, M.id],
  );
  const mSees = await listTasksForOwnerBoard(M.id);
  check(
    mSees.some((t) => t.taskId === tAgent.taskId && t.waitingOnMe === true),
    "a block naming M shows on M's board, flagged as waiting on them - the brief's link now resolves",
  );
  check(
    mSees.find((t) => t.taskId === tAgent.taskId)?.mine === false,
    "and it is still not THEIRS - being named on a block is not being assigned the work",
  );
  check(!(await listTasksForOwnerBoard(B.id)).some((t) => t.projectId === P), "cross-owner B never sees P's tasks");
  check(
    (await listTasksForOwnerBoard(A.id, { projectId: P })).every((t) => t.projectId === P),
    "the projectId filter scopes A's board to P",
  );

  // The assign roster is membership-gated: A (owner) sees the project agents + human member M; X (non-member)
  // gets nothing (invariant 3 - no roster leak).
  const roster = await listProjectMembersForAssign(A.id, P);
  check(
    roster.some((r) => r.tag === `agent:${testerPid}`) && roster.some((r) => r.tag === `agent:${backendPid}`),
    "A's assign roster lists the project agents",
  );
  check(roster.some((r) => r.tag === `human:${M.id}` && r.kind === "human"), "A's assign roster lists human member M");
  check((await listProjectMembersForAssign(X.id, P)).length === 0, "a non-member gets no assign roster");

  // ── 8. Decision 042: answering routes to the ASKER; hand-off to an agent; stop (un-start) ──
  // A task ASKED by an agent (created_by_id set) - answering it notifies that agent, closing the "ask me" loop.
  const asked = await taskCreateFromOwner(A, P, { title: "agent asks the human", options: ["yes", "no"] });
  check(asked !== null, "A seeds a decision task");
  if (asked) {
    await pool.query(`UPDATE tasks SET created_by_id = $1 WHERE id = $2`, [backendPid, asked.taskId]); // asked by 'backend'
    const ans = await taskAnswerFromOwner(A, P, asked.taskId, { option: "yes" });
    check(ans !== null && ans.status === "done", "A answers the agent's ask");
    const askerPost = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM posts WHERE to_participation_id = $1 AND ref = $2`,
      [backendPid, `task:${asked.taskId}`],
    );
    check(Number(askerPost.rows[0].n) === 1, `answer notifies the asking agent (created_by), got ${askerPost.rows[0].n}`);

    // Decision 054: the board's created_by_name ("who asked") derives the CREATOR participation's qualified
    // actor, preferring its BOUND human (human_owner_id) over the provisioner - same COALESCE as every roster
    // surface. Rebind backend to a second human with a handle, assert the board renders member/backend, then
    // RESTORE the binding so the downstream isolation/handoff assertions run against the original state.
    const origBind = (
      await pool.query<{ human_owner_id: string | null }>(`SELECT human_owner_id FROM participations WHERE id = $1`, [backendPid])
    ).rows[0].human_owner_id;
    const askMember = await resolveOwner(`taskwrites-ask-member-${P}@test.local`);
    await pool.query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [askMember.id, backendPid]);
    const boardRow = (await listTasksForOwnerBoard(A.id, { projectId: P })).find((t) => t.taskId === asked.taskId);
    check(
      boardRow?.createdByName === `${askMember.username}/backend`,
      `created_by_name bound-human: expected ${askMember.username}/backend, got ${JSON.stringify(boardRow?.createdByName)}`,
    );
    // Decision 061: the ASSIGNEE snapshot must derive from the same bound human. resolveAssigneeTag joined
    // only the PROVISIONER (participants.owner_id), so the web board stamped the provisioner's handle onto a
    // cross-provisioned agent - the same split rendering as the MCP path, reachable from /admin/tasks.
    const probe = await taskCreateFromOwner(A, P, { title: "assign snapshot probe" });
    if (probe) {
      await taskAssignFromOwner(A, P, probe.taskId, `agent:${backendPid}`);
      const probeRow = (await listTasksForOwnerBoard(A.id, { projectId: P })).find((t) => t.taskId === probe.taskId);
      check(
        probeRow?.assignee === `${askMember.username}/backend`,
        `assign snapshot must use the ASSIGNEE's bound human, not the provisioner: expected ${askMember.username}/backend, got ${JSON.stringify(probeRow?.assignee)}`,
      );
    }
    await pool.query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [origBind, backendPid]);
  }

  // Hand-off: reassign to an agent WITH a note -> the task is now agent-owned + the agent got the note.
  const toHand = await taskCreateFromOwner(A, P, { title: "hand me off", assignee: `human:${M.id}` });
  check(toHand !== null, "A seeds a task to hand off");
  if (toHand) {
    const handed = await taskHandoffFromOwner(A, P, toHand.taskId, `agent:${backendPid}`, "please take this, use approach X");
    check(handed !== null, "A hands the task to an agent");
    const hr = await taskRow(toHand.taskId);
    check(
      hr.owner_participation_id === String(backendPid) && hr.assignee_owner_id === null,
      "hand-off reassigns the task to the agent (clears the human assignee)",
    );
    const handPost = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM posts WHERE to_participation_id = $1 AND ref = $2`,
      [backendPid, `task:${toHand.taskId}`],
    );
    check(Number(handPost.rows[0].n) === 1, `hand-off delivers the note to the agent, got ${handPost.rows[0].n}`);
    check((await taskHandoffFromOwner(A, P, toHand.taskId, `human:${M.id}`, "x")) === null, "hand-off to a human tag is refused (must be an agent)");
    check((await taskHandoffFromOwner(A, P, toHand.taskId, `agent:${pbTesterPid}`, "x")) === null, "hand-off to an out-of-project agent is refused");
    check((await taskHandoffFromOwner(X, P, toHand.taskId, `agent:${backendPid}`, "x")) === null, "a non-member cannot hand off (null, no oracle)");
  }

  // Stop (un-start): in_progress -> todo; illegal from todo; a non-member cannot.
  const toStop = await taskCreateFromOwner(A, P, { title: "start then stop" });
  check(toStop !== null, "A seeds a task to stop");
  if (toStop) {
    await taskStartFromOwner(A, P, toStop.taskId);
    const st = await taskStopFromOwner(A, P, toStop.taskId);
    check(st !== null && st.status === "todo", "stop un-starts an in_progress task back to todo");
    check((await taskStopFromOwner(A, P, toStop.taskId)) === null, "stop from todo is refused (null)");
    check((await taskStopFromOwner(X, P, toStop.taskId)) === null, "a non-member cannot stop (null, no oracle)");
  }

  // Task 541 / decision 055: a HUMAN-authored task (created_by_id is NULL - a human is not a participation) now
  // records the authoring human in created_by_owner_id, so the board shows "from <human>" instead of nothing.
  // Isolated owner+project (a handled owner) so the assertion is self-contained.
  const author = await resolveOwner(`taskwrites-author-${P}@test.local`);
  const authorActor: OwnerActor = { id: author.id, username: author.username };
  const authorProj = await createProject(author.id, `authproj-${P}`, `Auth ${P}`);
  const authored = await taskCreateFromOwner(authorActor, authorProj.id, { title: "human authored, no participation" });
  check(authored !== null, "541: a human authors a task via the web");
  if (authored) {
    const authoredRow = (await listTasksForOwnerBoard(author.id, { projectId: authorProj.id })).find(
      (t) => t.taskId === authored.taskId,
    );
    check(
      authoredRow?.createdByName === author.username,
      `541: a human-authored task shows the author (${author.username}) as "from", got ${JSON.stringify(authoredRow?.createdByName)}`,
    );
  }

  finish();
}

function finish(): void {
  void closePool().then(() => {
    if (errors.length) {
      console.error(`FAIL admin.taskwrites:\n  - ${errors.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(
      "OK admin.taskwrites: the owner web write layer is membership-scoped (decision 037/039) - a non-member " +
        "(X) and a cross-owner (B) get null from every mutator with the target row byte-identical and " +
        "indistinguishable from a bad id (no oracle); the assignee tag grants no identity (out-of-project " +
        "agent/human tags refused, invariant 1); a plain member may author + act ONLY on tasks assigned to them; " +
        "the owner has full authority + supervisor override; self-dep and cycle edges are refused.",
    );
  });
}

main().catch((err) => {
  console.error("admin.taskwrites test errored:", err);
  process.exit(1);
});
