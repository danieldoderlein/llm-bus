// _setup FIRST: it defaults DATABASE_URL to the local test cluster before db.ts is evaluated.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool, query, withTx } from "../src/db.js";
import { resolveOwner } from "../src/admin/owner.js";
import { createProject, createParticipant, grant, renameParticipant, listTasksForOwnerBoard } from "../src/admin/queries.js";
import { authenticate } from "../src/auth.js";
import { taskCreateFromOwner, taskAnswerFromOwner } from "../src/admin/task-writes.js";
import { listTasks, taskShip, taskStart } from "../src/domain/task.js";
import { listRoster } from "../src/domain/roster.js";
import { whatsNew } from "../src/domain/digest.js";
import type { Ctx } from "../src/context.js";

// THE ONBOARDING JOURNEY, end to end, as a person actually walks it:
// enroll -> create a project -> create + connect an agent -> assign work both ways -> answer on BOTH
// surfaces (web board and agent chat) -> confirm the two agree. Every other test here covers one function;
// this one covers the PATH, which is where the gaps between correct functions live.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  // A UUID slice, like every other test fixture. The previous tag was a CONSTANT date plus
  // `hrtime() % 10000`, so it drew from only 10k values and reused them on every run - while
  // `resolveOwner` is idempotent and hands back the SAME owner for a repeated address. The two together
  // collide on `projects_owner_id_slug_key` by birthday paradox after a few hundred local runs, which is a
  // red `verify` caused entirely by its own history rather than by the change under test.
  const tag = randomUUID().slice(0, 8);

  // ── 1. A human enrolls (SSO resolves them to an owner) and creates a project ───────────────────────
  const human = await resolveOwner(`flow-${tag}@test.local`);
  check(human.id > 0, "enrolling a human yields an owner");
  const project = await createProject(human.id, `flow-${tag}`, `Flow ${tag}`);
  check(project.id > 0, "the human can create a project");
  // Creating a project must make its creator a MEMBER, or their own board is empty (decision 037).
  const membership = await query<{ role: string }>(
    `SELECT role FROM project_members WHERE project_id = $1 AND owner_id = $2`,
    [project.id, human.id],
  );
  check(membership.rows[0]?.role === "owner", "the creator is a member of their own project");

  // ── 2. They create an agent and connect it ────────────────────────────────────────────────────────
  // Named for what it does, NOT prefixed with the human's handle - the handle is added automatically, and
  // putting it in the name yields it twice. This is the convention the New participant screen advises.
  const agent = await createParticipant(human.id, "claude-backend", "agent");
  check(agent !== null && agent.id > 0, "the human can create an agent participant");
  const granted = await grant(human.id, project.id, agent!.id, null, false);
  check(granted !== null && !!granted.plaintextToken, "granting mints a token to hand to the agent");

  // The token is the agent's whole identity: it must authenticate to THIS project as THIS participation.
  const ctx = (await authenticate(`Bearer ${granted!.plaintextToken}`)) as Ctx;
  check(ctx !== null, "the minted token authenticates");
  check(ctx.project.id === project.id, "the token resolves to the project it was granted into");
  check(ctx.participant.name === "claude-backend", "the token resolves to the named agent");

  // ── 3. The human sees their agent, and knows what to type to assign to it ─────────────────────────
  const roster = await listRoster(ctx);
  const agentRow = roster.find((r) => r.name === "claude-backend");
  check(agentRow?.assign_with === "owner", "the roster says which field routes to the agent");
  const humanRow = roster.find((r) => r.kind === "human");
  check(humanRow?.assign_with === "human", "and that a person takes human: instead");
  // The address is handle/name - what the human types, and what boards render.
  check(
    agentRow!.actor.endsWith("/claude-backend") || agentRow!.actor === "claude-backend",
    `the agent's address is its qualified actor, got ${agentRow!.actor}`,
  );

  // ── 4. SURFACE ONE: the human assigns work from the web board ─────────────────────────────────────
  // A freshly enrolled owner has no handle until they pick one; the address falls back to their email,
  // which is what the roster renders and what human: accepts (decision 061 validates both forms).
  const humanAddress = (human.username ?? human.email) as string;
  const owner = { id: human.id, username: humanAddress };
  const assigned = await taskCreateFromOwner(owner, project.id, {
    title: "wire the callback",
    detail: "context for someone arriving cold; detail lives behind the link",
    // The WEB form assigns by participation id, because its assignee control is a dropdown - the human
    // never types an address. An AGENT assigning over MCP uses the NAME instead. Two input formats, one
    // stored foreign key, so both surfaces agree about who owns the task.
    assignee: `agent:${granted!.participation.id}`,
  });
  check(assigned !== null, "the human can file a task from the web and assign it to their agent");

  // The agent sees it WITHOUT being told - its plate is pushed, not polled.
  const pushed = await withTx((c) => whatsNew(c, ctx));
  check(
    pushed.my_open_tasks.some((t: { task_id: number }) => t.task_id === assigned!.taskId),
    `the agent's plate carries the task the human just filed, got ${JSON.stringify(pushed.my_open_tasks)}`,
  );

  // ── 5. SURFACE TWO: the agent answers a DECISION the human filed for itself ───────────────────────
  // A decision routed to the HUMAN is answered on the web board; one routed to an AGENT is ordinary work.
  const decision = await taskCreateFromOwner(owner, project.id, {
    title: "which cache strategy",
    options: ["write-through", "write-back"],
    assignee: `human:${human.id}`,
  });
  check(decision !== null, "the human can file a decision for themselves");
  const answered = await taskAnswerFromOwner(owner, project.id, decision!.taskId, {
    option: "write-through",
    note: "simpler to reason about",
  });
  check(answered?.status === "done", "answering a decision on the web completes it");

  // The AGENT must be able to read that answer without asking - otherwise the human answered into a void.
  const seen = await listTasks(ctx, { task_ids: [decision!.taskId], all_states: true });
  check(seen[0]?.selected_option === "write-through", `the agent reads the chosen option, got ${JSON.stringify(seen[0]?.selected_option)}`);
  check(seen[0]?.answer_note === "simpler to reason about", "and the human's note alongside it");

  // ── 6. THE TWO SURFACES MUST AGREE: work done in chat has to land on the board ────────────────────
  // The failure this guards: an agent does the work in chat, never updates the bus, the board still shows
  // it open, and someone does it twice. The guide tells agents to close the loop; this asserts it is
  // POSSIBLE to - i.e. the agent's own update is visible on the human's board.
  await withTx((c) => taskStart(c, ctx, { task_id: assigned!.taskId }));
  await withTx((c) => taskShip(c, ctx, { task_id: assigned!.taskId }));
  const board = await listTasksForOwnerBoard(human.id, { projectId: project.id });
  const onBoard = board.find((t) => t.taskId === assigned!.taskId);
  check(onBoard?.status === "done", `work the agent shipped shows done on the human's board, got ${onBoard?.status}`);

  // ── 7. Renaming the agent must not strand its work ───────────────────────────────────────────────
  // Assignment routes on a stable id, so a rename cannot break delivery - but the DISPLAY snapshot on the
  // task is a stored string, and if it is not refreshed the board shows the old name forever.
  const renamed = await renameParticipant(human.id, agent!.id, "claude-platform");
  check(renamed === "ok", "the human can rename their agent");
  const afterRename = await listTasksForOwnerBoard(human.id, { projectId: project.id });
  const renamedTask = afterRename.find((t) => t.taskId === assigned!.taskId);
  check(
    (renamedTask?.assignee ?? "").endsWith("/claude-platform"),
    `the board shows the agent's NEW name after a rename, got ${JSON.stringify(renamedTask?.assignee)}`,
  );
  // ...and the same token still works, because identity never depended on the name.
  const afterCtx = await authenticate(`Bearer ${granted!.plaintextToken}`);
  check(afterCtx?.participant.name === "claude-platform", "the token still authenticates after a rename");

  if (errors.length) {
    console.error("FAIL onboarding.flow:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log(
    "OK onboarding.flow: enroll -> project (creator is a member) -> agent created + granted a working token -> roster says which field routes to whom -> human assigns from the web and the agent's plate is PUSHED it -> a decision answered on the board is readable by the agent with its note -> work the agent ships shows done on the human's board -> renaming the agent keeps its token AND refreshes the display name on its tasks.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(closePool);
