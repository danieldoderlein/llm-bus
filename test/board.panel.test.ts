import { freshProject } from "./_setup.js";
import { withTx, closePool, getPool } from "../src/db.js";
import { taskCreate, taskStart, taskBlock, taskShip, taskDepend } from "../src/domain/task.js";
import { claimSequence } from "../src/domain/claim.js";
import { loadProjectBoard, loadOwnerBoardTask } from "../src/admin/queries.js";
import { projectBoardPage, taskDetailPage } from "../src/admin/html.js";

// Slice 1 (decision 022): the read-only project Board. loadProjectBoard is owner-scoped - it groups tasks
// by status (with assignee) and lists the decision record (claim events). A non-owned project id must
// return empty lists (no cross-tenant leak, invariant 3), and every rendered value goes through esc()
// (invariant 4). All read; no schema of its own.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  const ctx = await freshProject("board");
  const me = ctx.participant.name; // "tester" (un-backfilled ctx -> bare assignee label)

  // Seed tasks across the v2 statuses via the real state machine, plus one claimed decision. Assignment is a
  // FIELD now (decision 039), so both an unassigned and an assigned created task are `todo`.
  let blockedId = 0;
  await withTx(async (c) => {
    await taskCreate(c, ctx, { title: "design the schema" }); // todo (no owner)
    await taskCreate(c, ctx, { title: "write the loader", owner: me }); // todo (assigned, not started)
    const inprog = await taskCreate(c, ctx, { title: "render the board", owner: me });
    await taskStart(c, ctx, { task_id: inprog.task_id }); // in_progress
    const blocked = await taskCreate(c, ctx, { title: "wire the route", owner: me });
    await taskStart(c, ctx, { task_id: blocked.task_id });
    await taskBlock(c, ctx, {
      task_id: blocked.task_id,
      reason: "waiting on review",
      unblock_condition: "the reviewer approves the PR",
      unblock_owner: me,
    }); // blocked (manual)
    blockedId = blocked.task_id;
    const done = await taskCreate(c, ctx, { title: "ship it", owner: me });
    await taskStart(c, ctx, { task_id: done.task_id });
    await taskShip(c, ctx, { task_id: done.task_id }); // done
    await claimSequence(c, ctx, { sequence: "decisions", note: "adopt the board" });
  });

  const b = await loadProjectBoard(ctx.owner!.id, ctx.project.id);
  const byStatus = (s: string): typeof b.tasks => b.tasks.filter((t) => t.status === s);

  check(b.tasks.length === 5, `expected 5 tasks, got ${b.tasks.length}`);
  check(byStatus("todo").length === 2, `expected 2 todo tasks (assignment is a field), got ${byStatus("todo").length}`);
  for (const s of ["in_progress", "blocked", "done"]) {
    check(byStatus(s).length === 1, `expected exactly one ${s} task, got ${byStatus(s).length}`);
  }
  check(byStatus("todo").some((t) => t.assignee === null), "an unassigned todo task should have a null assignee");
  check(byStatus("todo").some((t) => !!t.assignee?.includes(me)), "an assigned-but-unstarted task stays todo, keeping its assignee");
  check(!!byStatus("in_progress")[0]?.assignee?.includes(me), `in_progress task should be assigned to ${me}`);
  check(!!byStatus("done")[0]?.assignee?.includes(me), `done task should carry its historical assignee ${me}`);
  check(byStatus("blocked")[0]?.blockers === 1, `blocked task should have 1 open blocker (derived-blocked via a manual block), got ${byStatus("blocked")[0]?.blockers}`);

  // Decision 073: the human's question is never "how many blockers" - it is WHAT is blocking it. The reason
  // was stored from the start and never rendered, and a dependency's target was never linked, so the page
  // said "blocked" and left the reader exactly where they arrived. Both shapes are asserted here.
  const manualDetail = await loadOwnerBoardTask(ctx.owner!.id, ctx.project.id, blockedId);
  check(manualDetail !== null, "the blocked task's detail must load");
  check(
    (manualDetail?.blockerRows ?? []).length === 1,
    `the detail must carry the blocker ROWS, not just a count, got ${JSON.stringify(manualDetail?.blockerRows)}`,
  );
  check(
    manualDetail?.blockerRows?.[0]?.reason === "waiting on review",
    `and the reason text itself, got ${JSON.stringify(manualDetail?.blockerRows?.[0]?.reason)}`,
  );
  check(
    manualDetail?.blockerRows?.[0]?.blockedOnTaskId === null,
    "a manual block has no target task - that is exactly what the page must say out loud",
  );
  const ownerStub = { id: ctx.owner!.id, email: ctx.owner!.email, username: "t", usernameConfirmed: true, isOperator: false, plan: "free" as const, suspendedAt: null, tokenBalance: 0, autoRechargeAmount: null, hasCard: false };
  const proj = { id: ctx.project.id, name: ctx.project.name };
  const manualHtml = taskDetailPage(ownerStub, manualDetail!, proj, [], "csrf");
  check(manualHtml.includes("waiting on review"), "the rendered page must show the blocker's REASON");
  check(
    /BY HAND/i.test(manualHtml),
    "a manual block must say nothing will lift it automatically, or it can sit blocked forever unnoticed",
  );

  // Decision 074: the block also carries what would LIFT it and who owns lifting it.
  check(
    manualDetail?.blockerRows?.[0]?.unblockCondition === "the reviewer approves the PR",
    `the detail must carry the exit condition, got ${JSON.stringify(manualDetail?.blockerRows?.[0]?.unblockCondition)}`,
  );
  check(manualHtml.includes("the reviewer approves the PR"), "the page must show what would lift the block");
  check(/Lifts when/i.test(manualHtml) && /Owned by/i.test(manualHtml), "and label both, so neither reads as prose");

  // A block written BEFORE 074 has neither field. Those rows must say so out loud: a blank reads exactly
  // like a block nobody has to act on, which is the state 074 exists to end. Written straight to the table
  // because taskBlock can no longer produce this shape - which is the point.
  await getPool().query(
    `INSERT INTO task_blockers (task_id, blocked_on_task_id, reason) VALUES ($1, NULL, $2)`,
    [blockedId, "paused during the demo"],
  );
  const legacy = await loadOwnerBoardTask(ctx.owner!.id, ctx.project.id, blockedId);
  const legacyRow = (legacy?.blockerRows ?? []).find((b) => b.reason === "paused during the demo");
  check(!!legacyRow, "a pre-074 blocker row must still load, not be dropped by the new columns");
  check(
    legacyRow?.unblockCondition === null && legacyRow?.unblockOwner === null,
    "and carry nulls rather than being back-filled with a guess nobody can make",
  );
  const legacyHtml = taskDetailPage(ownerStub, legacy!, proj, [], "csrf");
  check(
    /No exit condition was recorded/i.test(legacyHtml) && /Nobody owns lifting this/i.test(legacyHtml),
    "a pre-074 block must name BOTH gaps explicitly - a blank is indistinguishable from a block with no work to do",
  );

  // Those two strings live in `.bb-gap`, which sets `white-space: pre-wrap` so a user-supplied
  // unblock_condition keeps its line breaks. That makes the SOURCE formatting of these fallback literals
  // visible too: written as one wrapped template literal, they rendered with a hard newline and ~32 spaces
  // of indentation on every pre-074 block (prod carries 7). Caught by independent review, 2026-08-28.
  for (const phrase of ["No exit condition was recorded", "Nobody owns lifting this"]) {
    const at = legacyHtml.indexOf(phrase);
    const chunk = legacyHtml.slice(at, legacyHtml.indexOf("</div>", at));
    check(
      !/\n|\s{4,}/.test(chunk),
      `a pre-wrap gap message must not ship source indentation, got: ${JSON.stringify(chunk.slice(0, 120))}`,
    );
  }

  // Task #1002: the operator read task bodies for a long stretch and reported the text as hard to read,
  // naming the colour (#1b1e22 via the --ink-800 alias). The colour was 16.5:1 on white and was never the
  // cause - `-webkit-font-smoothing: antialiased` on <body> was, because on macOS it disables subpixel
  // rendering and thins every glyph. Both halves are pinned here: the thinning must not come back (it is
  // an easy "looks cleaner" edit), and the longest-read prose in the product keeps the darkest ink.
  //
  // Assert against DECLARATIONS, not the page text: the STYLE block ships its own CSS comments to the
  // browser, so a rule explained in a comment would otherwise satisfy a test looking for the rule.
  const css = manualHtml.replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    !/-webkit-font-smoothing\s*:/.test(css),
    "the admin shell must not set -webkit-font-smoothing - antialiased thins body text on macOS",
  );
  check(
    /\.detailbody\s*\{[^}]*color:\s*var\(--ink\)/.test(css),
    "the task body must render in the darkest canonical ink, not a lighter alias",
  );
  check(
    !/\.bb-why\s*\{[^}]*opacity/.test(css),
    "a blocker reason must not be faded behind an opacity - it is prose the reader has to act on",
  );

  // A DEPENDENCY block: the target task is named and linked, so the reader can go look at it.
  const dep = await withTx(async (c) => {
    const upstream = await taskCreate(c, ctx, { title: "upstream thing", owner: me });
    const downstream = await taskCreate(c, ctx, { title: "downstream thing", owner: me });
    await taskDepend(c, ctx, { task_id: downstream.task_id, depends_on: upstream.task_id });
    return { upstream: upstream.task_id, downstream: downstream.task_id };
  });
  const depDetail = await loadOwnerBoardTask(ctx.owner!.id, ctx.project.id, dep.downstream);
  check(
    depDetail?.blockerRows?.[0]?.blockedOnTaskId === dep.upstream,
    `a dependency block must carry its TARGET task id, got ${JSON.stringify(depDetail?.blockerRows)}`,
  );
  check(
    depDetail?.blockerRows?.[0]?.blockedOnTitle === "upstream thing",
    `and the target's title, so the link can be readable, got ${JSON.stringify(depDetail?.blockerRows?.[0]?.blockedOnTitle)}`,
  );
  const depHtml = taskDetailPage(ownerStub, depDetail!, proj, [], "csrf");
  check(
    depHtml.includes(`/tasks/${dep.upstream}`),
    "the rendered page must LINK to the blocking task, not just mention that one exists",
  );
  check(depHtml.includes("upstream thing"), "and name it, so the link reads as something");

  check(b.decisions.length === 1, `expected 1 decision claim, got ${b.decisions.length}`);
  check(
    b.decisions[0]?.sequence === "decisions" && b.decisions[0]?.formatted === "1",
    `decision should be sequence "decisions" at formatted "1", got ${JSON.stringify(b.decisions[0])}`,
  );

  // Owner isolation (invariant 3): a different owner sees NONE of this project's board (no cross-tenant leak).
  const other = await freshProject("board-other");
  const empty = await loadProjectBoard(other.owner!.id, ctx.project.id);
  check(
    empty.tasks.length === 0 && empty.decisions.length === 0,
    `a non-owner must see an empty board for someone else's project, got ${JSON.stringify(empty)}`,
  );

  // Non-finite project id short-circuits to empty (defensive, like loadProjectActivity).
  const nan = await loadProjectBoard(ctx.owner!.id, Number.NaN);
  check(nan.tasks.length === 0 && nan.decisions.length === 0, "a non-finite project id must return an empty board");

  // Render escaping (invariant 4): task titles are attacker-influenceable via MCP writes, so they must be
  // HTML-escaped by the esc() chokepoint when the Board renders.
  const owner = {
    id: 1,
    email: "t@test.local",
    username: "tester",
    usernameConfirmed: true,
    isOperator: false,
    plan: "free" as const,
    suspendedAt: null,
    tokenBalance: 0,
    autoRechargeAmount: null,
    hasCard: false,
  };
  // Every board-borne value is attacker-influenceable via MCP writes (title/assignee from task_*,
  // note/sequence/actor from claim), so all must pass through esc() on render.
  const xssBoard = {
    tasks: [{ id: 1, title: "<b>pwn</b>", status: "todo", assignee: "<i>evil</i>", lane: null, blockers: 0 }],
    decisions: [
      {
        sequence: "<u>seq</u>",
        formatted: "<s>1</s>",
        number: 1,
        actor: "<em>who</em>",
        note: "<b>note</b>",
        ts: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const html = projectBoardPage(owner, { id: 1, slug: "s", name: "N" }, undefined, undefined, xssBoard);
  for (const [raw, escd, label] of [
    ["<b>pwn</b>", "&lt;b&gt;pwn&lt;/b&gt;", "task title"],
    ["<i>evil</i>", "&lt;i&gt;evil&lt;/i&gt;", "assignee"],
    ["<u>seq</u>", "&lt;u&gt;seq&lt;/u&gt;", "decision sequence"],
    ["<s>1</s>", "&lt;s&gt;1&lt;/s&gt;", "decision formatted id"],
    ["<b>note</b>", "&lt;b&gt;note&lt;/b&gt;", "decision note"],
    ["<em>who</em>", "&lt;em&gt;who&lt;/em&gt;", "decision actor"],
  ] as const) {
    check(html.includes(escd), `board ${label} must be HTML-escaped`);
    check(!html.includes(raw), `raw ${label} markup must not appear in the rendered Board`);
  }
  // First-run safety-net (#125): the example preview must NOT show once the board has real data (it
  // self-retires the instant anything real lands), so the xssBoard render above must omit it.
  check(!html.includes("Example <span"), "the first-run example must NOT render when the board has real tasks");

  // ...and it MUST show for a brand-new project with no board + no activity (the empty-bus safety-net).
  // Display-only: it is a static preview, so it must carry the 'preview' label and must not have created
  // any real rows (this render takes empty board/activity - there is nothing to pollute the #114 funnel).
  const firstRun = projectBoardPage(owner, { id: 2, slug: "fresh", name: "Fresh" }, undefined, undefined, undefined);
  check(firstRun.includes("Example <span"), "a brand-new project must show the first-run example preview");
  check(firstRun.includes("handed off to writer-agent"), "the example must illustrate a real coordination handoff");
  check(firstRun.includes("border-style:dashed"), "the example must be visually marked as a preview (dashed)");
  await closePool();
  if (errors.length) {
    console.error(`FAIL board.panel:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK board.panel: the read-only v2 Board groups tasks by effective status (+assignee) over the task " +
      "state machine (5 columns, blocked derived), lists the decision record (claims), is owner-scoped (a " +
      "non-owner sees empty), esc()s every rendered value (invariant 4), and shows the first-run example " +
      "preview on an empty project that self-retires once real data lands (#125).",
  );
}

main().catch((e) => {
  console.error("board.panel test errored:", e);
  process.exit(1);
});
