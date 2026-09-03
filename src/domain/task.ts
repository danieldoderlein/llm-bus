import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";
import { query } from "../db.js";
import { postReviewAnswerFromAgent } from "./post.js";
import { normalizeLinks } from "./links.js";

// The task graph state machine (decision 039, v2). Persisted BASE status is one of:
//   todo --start--> in_progress --ship/answer--> done
//   (any non-terminal) --cancel--> cancelled ; done/cancelled --reopen--> todo
// `blocked` is DERIVED, never a persisted base status: a task is effectively blocked when its base status
// is todo/in_progress AND it has an unmet dependency edge (task_deps -> a target not yet 'done') OR an open
// manual blocker (task_blockers row). Assignment is an editable FIELD (an agent participation OR a human
// member owner, or unassigned), orthogonal to status. Transitions read the current row (project-scoped)
// FIRST and throw on an illegal move, so an invalid call never mutates state.

const TERMINAL = new Set(["done", "cancelled"]);

// SQL fragments for the DERIVED blocked state, expressed against a `tasks` alias `t`. A task with an unmet
// dependency (a dep target not yet done) OR an open manual blocker is blocked - but only while its base
// status is actionable (todo/in_progress); a done/cancelled task is never "blocked". Kept as ONE shared
// expression so list_tasks, the board, whats_new, and the start-guard all agree (spec risk 8.3).
const UNMET_DEP_SQL = `EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id
                                WHERE d.task_id = t.id AND dt.status <> 'done')`;
const OPEN_MANUAL_BLOCK_SQL = `EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = t.id AND b.resolved_at IS NULL)`;
export const IS_BLOCKED_SQL = `(t.status IN ('todo','in_progress') AND (${UNMET_DEP_SQL} OR ${OPEN_MANUAL_BLOCK_SQL}))`;
export const EFFECTIVE_STATUS_SQL = `CASE WHEN ${IS_BLOCKED_SQL} THEN 'blocked' ELSE t.status END`;

interface TaskRow {
  status: string;
  owner_participation_id: number | null;
  assignee_owner_id: number | null;
  options: string[] | null;
  created_by_id: number | null;
}

/** Read a task (project-scoped) with the fields the state machine needs. Throws if it does not exist. */
async function loadTask(client: pg.PoolClient, ctx: Ctx, taskId: number): Promise<TaskRow> {
  const res = await client.query<{
    status: string;
    owner_participation_id: string | null;
    assignee_owner_id: string | null;
    options: string[] | null;
    created_by_id: string | null;
  }>(
    `SELECT status, owner_participation_id, assignee_owner_id, options, created_by_id
       FROM tasks WHERE project_id = $1 AND id = $2`,
    [ctx.project.id, taskId],
  );
  if (res.rows.length === 0) throw new Error(`task ${taskId} not found in project ${ctx.project.id}`);
  const r = res.rows[0];
  return {
    status: r.status,
    owner_participation_id: r.owner_participation_id != null ? Number(r.owner_participation_id) : null,
    assignee_owner_id: r.assignee_owner_id != null ? Number(r.assignee_owner_id) : null,
    options: r.options,
    created_by_id: r.created_by_id != null ? Number(r.created_by_id) : null,
  };
}

/** True if the task currently has an unmet dependency or an open manual blocker (derived-blocked). */
async function isBlocked(client: pg.PoolClient, taskId: number): Promise<boolean> {
  const res = await client.query<{ blocked: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id
                      WHERE d.task_id = $1 AND dt.status <> 'done')
         OR  EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = $1 AND b.resolved_at IS NULL)) AS blocked`,
    [taskId],
  );
  return res.rows[0].blocked;
}

/** Find an AGENT participant in this project by bare label or qualified actor (decision 018). Returns null
 *  on a miss - the CALLER decides what to throw, so the two assign namespaces can point at each other (see
 *  resolveAssignee). `actor` is the agent's OWN qualified identity: the BOUND human
 *  (participations.human_owner_id, canonical per 038/056), then the provisioner, then the bare label - the
 *  same COALESCE list_participants and scripts/backfill-actor-snapshots.ts use, so the write path and the
 *  repair tool converge on ONE canonical string (decision 061). It is emphatically NOT the caller's handle:
 *  composing the assignee's snapshot from `ctx` stamped the assigner onto someone else's agent. */
async function findAgent(
  client: pg.PoolClient,
  ctx: Ctx,
  owner: string,
): Promise<{ id: number; name: string; actor: string; boundHandle: string | null; lastSeen: Date | null } | null> {
  const label = owner.includes("/") ? owner.slice(owner.lastIndexOf("/") + 1) : owner;
  // Resolves deterministically without an ORDER BY because `pt.name` is unique per PROJECT: every
  // participation-creation path binds the participant to the project owner, so `UNIQUE(owner_id, name)`
  // on participants makes the label unique within the project. That is an INVARIANT OF THE WRITE PATHS,
  // not a constraint on this table - if an agent is ever created under a non-project owner, revisit this.
  // `presence.participation_id` is the PK, so the liveness join is a free PK lookup in a query we already
  // run - it costs no extra round-trip and powers the dormant-queue warning below.
  const res = await client.query<{
    id: string;
    name: string;
    actor: string;
    bound_handle: string | null;
    last_seen: Date | null;
  }>(
    `SELECT pa.id, pt.name,
            COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
            ho.username AS bound_handle, pr.last_seen
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o ON o.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pa.human_owner_id
       LEFT JOIN presence pr ON pr.participation_id = pa.id
      WHERE pa.project_id = $1 AND pt.name = $2`,
    [ctx.project.id, label],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return { id: Number(r.id), name: r.name, actor: r.actor, boundHandle: r.bound_handle, lastSeen: r.last_seen };
}

/** An agent queue nobody is polling. The reported incident was NOT a name collision - the agent label
 *  RESOLVED, so the assign succeeded and the work sat in a queue no process reads (decision 061). A miss in
 *  the other namespace cannot catch that; liveness can. An agent never seen on the bus, or silent for
 *  DORMANT_DAYS, is the signal - active agents never trip it, so it stays quiet enough to be worth reading. */
const DORMANT_DAYS = 14;
function dormantQueueWarning(a: { actor: string; boundHandle: string | null; lastSeen: Date | null }): string | undefined {
  const silentMs = a.lastSeen ? Date.now() - new Date(a.lastSeen).getTime() : Infinity;
  if (silentMs <= DORMANT_DAYS * 86_400_000) return undefined;
  const since = a.lastSeen
    ? `has not been seen on the bus since ${new Date(a.lastSeen).toISOString().slice(0, 10)}`
    : `has never been seen on the bus`;
  return (
    `assigned to the AGENT ${a.actor}, which ${since} - an agent only sees a task if its process polls, so ` +
    `this may sit unread.` +
    (a.boundHandle
      ? ` If a PERSON must do this, assign human:"${a.boundHandle}" instead - that reaches their web board.`
      : ``)
  );
}

/** Find a human MEMBER of this project by handle or email (decision 037). Returns null on a miss. Strictly
 *  project-scoped: it can only ever see members of THIS project, so it is not a cross-tenant existence
 *  oracle (invariant 3) - it reveals nothing list_participants does not already return to the same caller. */
async function findHumanMember(
  client: pg.PoolClient,
  ctx: Ctx,
  handleOrEmail: string,
): Promise<{ id: number; name: string } | null> {
  const res = await client.query<{ id: string; username: string | null; email: string }>(
    `SELECT o.id, o.username, o.email
       FROM project_members pm JOIN owners o ON o.id = pm.owner_id
      WHERE pm.project_id = $1 AND (lower(o.username) = lower($2) OR lower(o.email) = lower($2))`,
    [ctx.project.id, handleOrEmail],
  );
  if (res.rows.length === 0) return null;
  return { id: Number(res.rows[0].id), name: res.rows[0].username ?? res.rows[0].email };
}

/**
 * Resolve the assignee fields from an assign request. Exactly one of agent/human is set, or both null
 * (unassigned). Returns the resolved columns + the display snapshot written to `tasks.owner_name`.
 *
 * THE TWO NAMESPACES (decision 061). `owner:` addresses an AGENT participation - a process, which only ever
 * sees the task if it polls `list_tasks(mine=true)`. `human:` addresses a project MEMBER - a person, whose
 * work reaches them on the web board (which filters `assignee_owner_id`). Naming one namespace's target in
 * the OTHER field used to be SILENT: the assign succeeded, returned a plausible owner, and the work reached
 * nobody until the person said "my board is empty" (the imeo cross-rig report, 2026-08-19). So a miss in one
 * namespace now probes the other and throws a directive error naming the exact corrective call.
 *
 * Both probes are pinned to `ctx.project.id` (token-derived, never from input), so a name belonging to
 * ANOTHER tenant matches neither and yields the byte-identical generic message - no cross-tenant existence
 * oracle (invariant 3). The probe runs ONLY on the already-failing path, so the happy path costs nothing.
 */
async function resolveAssignee(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { owner?: string; human?: string; unassign?: boolean },
): Promise<{ participationId: number | null; ownerId: number | null; name: string | null; warning?: string }> {
  const namedAgent = opts.owner !== undefined && opts.owner !== "";
  const namedHuman = opts.human !== undefined && opts.human !== "";
  if (namedAgent && namedHuman) throw new Error("assign: name EITHER an agent (owner) OR a human, not both");
  if (opts.unassign || (!namedAgent && !namedHuman)) return { participationId: null, ownerId: null, name: null };
  if (namedHuman) {
    // Strip a `handle/` qualifier here TOO, symmetrically with the agent branch: human:"daniel/alice" must
    // find the member, not fall through to the agent probe and advise the opposite of the intent.
    const rawInput = opts.human as string;
    const raw = rawInput.includes("/") ? rawInput.slice(rawInput.lastIndexOf("/") + 1) : rawInput;
    const h = await findHumanMember(client, ctx, raw);
    if (h) return { participationId: null, ownerId: h.id, name: h.name };
    // Cross-namespace probe (in-project only): they named an agent in the human field.
    const a = await findAgent(client, ctx, raw);
    if (a) {
      throw new Error(
        `"${raw}" is an AGENT in project ${ctx.project.id}, not a human member - assign it with ` +
          `owner:"${a.name}" (human: is for a person who works the web board)`,
      );
    }
    throw new Error(`human member "${raw}" not found in project ${ctx.project.id}`);
  }
  const raw = opts.owner as string;
  const a = await findAgent(client, ctx, raw);
  // The agent RESOLVES here - which is exactly the reported incident: naming a person's agent succeeds and
  // the work lands in a queue nothing polls. A cross-namespace probe cannot catch that (nothing missed), so
  // liveness carries the signal instead.
  if (a) return { participationId: a.id, ownerId: null, name: a.actor, warning: dormantQueueWarning(a) };
  // Cross-namespace probe (in-project only): they named a person in the agent field - THE reported defect.
  // Probe with the slash-stripped label so `owner:"daniel/alice"` still gets the hint, and echo the
  // RESOLVED handle so the suggested call is guaranteed to work (an email in, the username back).
  const label = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const h = await findHumanMember(client, ctx, label);
  if (h) {
    throw new Error(
      `"${label}" is a HUMAN MEMBER of project ${ctx.project.id}, not an agent - assign it with ` +
        `human:"${h.name}" (a person's work goes to human:; only an agent process polls owner:)`,
    );
  }
  throw new Error(`agent "${raw}" not found in project ${ctx.project.id}`);
}

/**
 * Create a task. Always starts in `todo` (decision 039: assignment is a field, not a status). An optional
 * agent `owner` or human assignee, optional `options` (a decide-this task), and optional `links` may be set
 * at creation. An unassigned task joins the grabbable backlog pool.
 */
/**
 * WHO IS "YOU" AND WHO IS "I"? An option label is written by an AGENT and read off the web board later by
 * a HUMAN who did not write it, with no speaker attached. So "I will commit it myself" / "You commit just
 * that line, leave my other files" is unresolvable at the moment it matters: the reader cannot tell whether
 * the agent is offering to act or reporting what the human said. Name the actor instead - "AGENT commits
 * ..." / "HUMAN commits ...".
 *
 * WARN, NEVER REFUSE. A refusal here would reject a live decision handoff over prose style, and the whole
 * point is that the decision reaches the decider. Two regexes rather than one because the /i flag needed
 * for "you" would make `\bI\b` match a stray lowercase "i" (e.g. "option i") - a guard that fires on
 * nothing real trains you to ignore it.
 */
const FIRST_PERSON_RE = /\bI\b|\bI'(?:ll|m|ve|d)\b/;
const SECOND_PERSON_RE = /\b(?:me|my|mine|myself|you|your|yours|yourself|you'(?:ll|re|ve|d))\b/i;

export function ambiguousActorWarning(options?: string[] | null): string | undefined {
  if (!options || !options.length) return undefined;
  const flagged = options.filter((o) => FIRST_PERSON_RE.test(o) || SECOND_PERSON_RE.test(o));
  if (!flagged.length) return undefined;
  return (
    `ambiguous actor in ${flagged.length} of ${options.length} option(s): ${flagged.map((o) => JSON.stringify(o)).join(", ")}. ` +
    `Whoever answers this reads it on the board with no speaker attached, so "I"/"you"/"my" has no resolvable ` +
    `referent - name the actor instead ("AGENT commits the line", "HUMAN commits it themselves"). ` +
    `task_edit(task_id, options:[...]) rewrites them; the task was created either way.`
  );
}

export async function taskCreate(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: {
    title: string;
    detail?: string;
    lane?: string;
    owner?: string;
    human?: string;
    options?: string[];
    links?: unknown;
  },
): Promise<{ task_id: number; status: string; warning?: string }> {
  const assignee = await resolveAssignee(client, ctx, { owner: opts.owner, human: opts.human });
  const options = opts.options && opts.options.length ? opts.options.slice(0, 6) : null;
  const links = normalizeLinks(opts.links);
  const res = await client.query<{ id: string; status: string }>(
    `INSERT INTO tasks (project_id, title, detail, lane, owner_participation_id, assignee_owner_id, owner_name,
                        status, options, links, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'todo', $8::jsonb, $9::jsonb, $10)
     RETURNING id, status`,
    [
      ctx.project.id,
      opts.title,
      opts.detail ?? null,
      opts.lane ?? null,
      assignee.participationId,
      assignee.ownerId,
      assignee.name,
      options ? JSON.stringify(options) : null,
      links ? JSON.stringify(links) : null,
      ctx.participation.id,
    ],
  );
  const taskId = Number(res.rows[0].id);
  await appendEvent(client, ctx, "task_create", {
    title: opts.title,
    lane: opts.lane ?? null,
    owner: assignee.name,
  });
  const actorWarning = ambiguousActorWarning(options);
  const warning = [assignee.warning, actorWarning].filter(Boolean).join(" | ") || undefined;
  return { task_id: taskId, status: res.rows[0].status, ...(warning ? { warning } : {}) };
}

/**
 * Assign, reassign, or unassign a task's assignee - legal from ANY non-terminal state (decision 039;
 * assignment is a field, not a status transition). Reassigning an IN-PROGRESS task is a HAND-OFF: the task
 * reverts to `todo` (clearing the soft-lock) so the new assignee re-starts it. Reassigning a todo task just
 * updates the field. The assignee sees it via whats_new.my_open_tasks (the push channel).
 */
export async function taskAssign(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; owner?: string; human?: string; unassign?: boolean },
): Promise<{ task_id: number; owner: string | null; status: string; warning?: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (TERMINAL.has(current.status)) {
    throw new Error(`cannot assign task ${opts.task_id} from terminal status "${current.status}" (reopen it first)`);
  }
  const assignee = await resolveAssignee(client, ctx, opts);
  // Hand-off: reassigning an in-flight task clears the soft-lock (back to todo). A todo task keeps its status.
  const nextStatus = current.status === "in_progress" ? "todo" : current.status;
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET owner_participation_id = $3, assignee_owner_id = $4, owner_name = $5,
                      status = $6, updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id, assignee.participationId, assignee.ownerId, assignee.name, nextStatus],
  );
  await appendEvent(client, ctx, "task_assign", { owner: assignee.name, handoff: current.status === "in_progress" });
  return {
    task_id: opts.task_id,
    owner: assignee.name,
    status: res.rows[0].status,
    ...(assignee.warning ? { warning: assignee.warning } : {}),
  };
}

/**
 * Start (or grab) a task: todo -> in_progress, acquiring the soft-lock. An UNASSIGNED task is grabbed
 * (self-assigned to the caller's participation) then started - the backlog-pull path (decision 039). A
 * derived-blocked task (unmet dependency or open manual blocker) cannot be started.
 */
export async function taskStart(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "todo") {
    throw new Error(`cannot start task ${opts.task_id} from status "${current.status}" (only todo)`);
  }
  if (await isBlocked(client, opts.task_id)) {
    throw new Error(`cannot start task ${opts.task_id}: it is blocked (resolve its dependencies/blockers first)`);
  }
  // Grab: an unassigned task is self-assigned to the caller on start.
  const grabParticipation = current.owner_participation_id == null && current.assignee_owner_id == null;
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET status = 'in_progress',
                      owner_participation_id = CASE WHEN $3 THEN $4 ELSE owner_participation_id END,
                      owner_name = CASE WHEN $3 THEN $5 ELSE owner_name END,
                      updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id, grabParticipation, ctx.participation.id, ctx.actor],
  );
  await appendEvent(client, ctx, "task_start", { grabbed: grabParticipation });
  return { task_id: opts.task_id, status: res.rows[0].status };
}

/** Ship a task (mark done). Legal only from in_progress. For a decide-this task (options set) use
 *  task_answer instead (it records the choice + delivers it to dependents). */
export async function taskShip(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "in_progress") {
    throw new Error(`cannot ship task ${opts.task_id} from status "${current.status}"`);
  }
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET status = 'done', updated_at = now() WHERE project_id = $1 AND id = $2 RETURNING status`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_ship", {});
  return { task_id: opts.task_id, status: res.rows[0].status };
}

/**
 * Answer a decide-this task: record the chosen option (or free-form note) and complete it (-> done),
 * delivering the result to the assignees of every task that DEPENDS on this one (which also unblocks them,
 * since blocked is derived from the now-done dependency). Legal from todo or in_progress (the decider need
 * not have "started" a quick decision). If the task carries options, the option must be one of them or
 * 'other' with a note; a task without options accepts a free-form note.
 */
export async function taskAnswer(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; option?: string; note?: string | null },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (TERMINAL.has(current.status)) {
    throw new Error(`cannot answer task ${opts.task_id} from terminal status "${current.status}"`);
  }
  const note = (opts.note ?? "").trim() || null;
  const option = (opts.option ?? "").trim() || null;
  if (current.options && current.options.length) {
    if (!option) throw new Error("task_answer: this task has options - pick one (or 'other' with a note)");
    if (option !== "other" && !current.options.includes(option)) {
      throw new Error("task_answer: option must be one of the task's options, or 'other' with a note");
    }
    if (option === "other" && !note) throw new Error("task_answer: 'other' requires a note describing your choice");
  } else if (!option && !note) {
    throw new Error("task_answer: provide an option or a note");
  }

  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET status = 'done', selected_option = $3, answer_note = $4,
                      answered_by_participation_id = $5, answered_at = now(), updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id, option, note, ctx.participation.id],
  );

  // Deliver the decision to: the assignee of each dependent task (they were derived-blocked on this; now
  // unblocked) AND the agent that ASKED (created_by_id) - so the requester of an "ask me" task learns the
  // answer without polling (decision 042). Dedupe, and never notify the answerer themselves.
  const deps = await client.query<{ owner_participation_id: string | null }>(
    `SELECT t.owner_participation_id
       FROM task_deps d JOIN tasks t ON t.id = d.task_id
      WHERE d.depends_on_task_id = $1 AND t.owner_participation_id IS NOT NULL`,
    [opts.task_id],
  );
  const notify = new Set<number>();
  for (const dep of deps.rows) if (dep.owner_participation_id != null) notify.add(Number(dep.owner_participation_id));
  if (current.created_by_id != null) notify.add(current.created_by_id);
  notify.delete(ctx.participation.id); // the answerer already knows
  const body = `Decision on task #${opts.task_id}: ${option ?? "(note)"}${note ? ` - ${note}` : ""}`;
  for (const pid of notify) {
    await postReviewAnswerFromAgent(client, ctx, {
      toParticipationId: pid,
      toLane: null,
      body,
      ref: `task:${opts.task_id}`,
      tag: "task",
    });
  }

  await appendEvent(client, ctx, "task_answer", { option, has_note: note != null, notified: notify.size });
  return { task_id: opts.task_id, status: res.rows[0].status };
}

/** Un-start a task: in_progress -> todo, keeping the assignee (the "I started it but am putting it back"
 *  transition, decision 042). Legal only from in_progress; a derived-blocked task is already effectively not
 *  running. The owner web exposes this via the Status control; the MCP surface leaves it to reassign/block. */
export async function taskStop(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "in_progress") {
    throw new Error(`cannot stop task ${opts.task_id} from status "${current.status}" (only in_progress)`);
  }
  await client.query(
    `UPDATE tasks SET status = 'todo', updated_at = now() WHERE project_id = $1 AND id = $2`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_stop", {});
  return { task_id: opts.task_id, status: "todo" };
}

/** Cancel a task (soft): any non-terminal -> cancelled. Keeps history (append-only ledger, invariant 6). */
export async function taskCancel(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (TERMINAL.has(current.status)) {
    throw new Error(`task ${opts.task_id} is already ${current.status}`);
  }
  await client.query(
    `UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE project_id = $1 AND id = $2`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_cancel", {});
  return { task_id: opts.task_id, status: "cancelled" };
}

/** Reopen a done/cancelled task back to todo, clearing any recorded decision answer. */
export async function taskReopen(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (!TERMINAL.has(current.status)) {
    throw new Error(`task ${opts.task_id} is not terminal (status "${current.status}"); nothing to reopen`);
  }
  await client.query(
    `UPDATE tasks SET status = 'todo', selected_option = NULL, answer_note = NULL,
                      answered_by_participation_id = NULL, answered_by_owner_id = NULL, answered_at = NULL,
                      updated_at = now()
      WHERE project_id = $1 AND id = $2`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_reopen", {});
  return { task_id: opts.task_id, status: "todo" };
}

/** Edit a task's fields (title/detail/lane/links/options) - any provided field, at any state. */
export async function taskEdit(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; title?: string; detail?: string; lane?: string; links?: unknown; options?: string[] },
): Promise<{ task_id: number; warning?: string }> {
  await loadTask(client, ctx, opts.task_id); // project-scoped existence (throws otherwise)
  const sets: string[] = [];
  const params: unknown[] = [ctx.project.id, opts.task_id];
  const push = (val: unknown): string => {
    params.push(val);
    return `$${params.length}`;
  };
  if (opts.title !== undefined) sets.push(`title = ${push(opts.title)}`);
  if (opts.detail !== undefined) sets.push(`detail = ${push(opts.detail)}`);
  if (opts.lane !== undefined) sets.push(`lane = ${push(opts.lane)}`);
  if (opts.links !== undefined) sets.push(`links = ${push(JSON.stringify(normalizeLinks(opts.links)))}::jsonb`);
  if (opts.options !== undefined) {
    const options = opts.options && opts.options.length ? opts.options.slice(0, 6) : null;
    sets.push(`options = ${push(options ? JSON.stringify(options) : null)}::jsonb`);
  }
  if (sets.length === 0) throw new Error("task_edit: nothing to change");
  await client.query(
    `UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE project_id = $1 AND id = $2`,
    params,
  );
  await appendEvent(client, ctx, "task_edit", { fields: sets.length });
  const editWarning = ambiguousActorWarning(opts.options);
  return { task_id: opts.task_id, ...(editWarning ? { warning: editWarning } : {}) };
}

/** Add a dependency edge: `task_id` depends on `depends_on` (both in this project). While the target is not
 *  done, `task_id` is derived-blocked. Rejects self-deps and cycles (which would deadlock). */
export async function taskDepend(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; depends_on: number },
): Promise<{ task_id: number; depends_on: number }> {
  if (opts.task_id === opts.depends_on) throw new Error("a task cannot depend on itself");
  await loadTask(client, ctx, opts.task_id);
  await loadTask(client, ctx, opts.depends_on); // both must be in-project (no cross-tenant oracle)
  // Cycle guard: reject if `task_id` is already reachable FROM `depends_on` (adding the edge would close a loop).
  const cycle = await client.query<{ hit: boolean }>(
    `WITH RECURSIVE reach(id) AS (
       SELECT depends_on_task_id FROM task_deps WHERE task_id = $1
       UNION
       SELECT d.depends_on_task_id FROM task_deps d JOIN reach r ON d.task_id = r.id)
     SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2) AS hit`,
    [opts.depends_on, opts.task_id],
  );
  if (cycle.rows[0].hit) throw new Error("that dependency would create a cycle");
  await client.query(
    `INSERT INTO task_deps (task_id, depends_on_task_id, created_by_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [opts.task_id, opts.depends_on, ctx.participation.id],
  );
  await appendEvent(client, ctx, "task_depend", { depends_on: opts.depends_on });
  return { task_id: opts.task_id, depends_on: opts.depends_on };
}

/** Remove a dependency edge. */
export async function taskUndepend(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; depends_on: number },
): Promise<{ task_id: number; depends_on: number }> {
  await loadTask(client, ctx, opts.task_id);
  await client.query(`DELETE FROM task_deps WHERE task_id = $1 AND depends_on_task_id = $2`, [
    opts.task_id,
    opts.depends_on,
  ]);
  await appendEvent(client, ctx, "task_undepend", { depends_on: opts.depends_on });
  return { task_id: opts.task_id, depends_on: opts.depends_on };
}

/** Manual block hatch (decision 039): record a "waiting on a non-task thing" reason. This adds an open
 *  task_blockers row (no task target) and NO status write - the task is derived-blocked while the row is
 *  open. Legal from any non-terminal state. (Task-to-task dependencies use task_depend, not this.) */
export async function taskBlock(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; reason: string; unblock_condition?: string; unblock_owner?: string; unblock_human?: string },
): Promise<{ task_id: number; status: string; unblock_owner: string | null; warning?: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (TERMINAL.has(current.status)) {
    throw new Error(`cannot block task ${opts.task_id} from terminal status "${current.status}"`);
  }
  // Decision 074. Both are validated HERE rather than declared required in the tool schema, deliberately:
  // an agent whose client cached the pre-074 tool list still sends the old two-argument call, and a bare
  // schema rejection tells it only that something is invalid. A directive error naming the exact corrective
  // call turns that into one round trip (the decision 040 tombstone lesson).
  const condition = (opts.unblock_condition ?? "").trim();
  if (!condition) {
    throw new Error(
      `task_block now requires unblock_condition: what would LIFT this block, so it cannot sit forever ` +
        `(decision 074). Retry as task_block(task_id:${opts.task_id}, reason:"...", unblock_condition:"...", ` +
        `unblock_owner:"<agent>") - or unblock_human:"<handle>" if a person owns it.`,
    );
  }
  const named = (opts.unblock_owner ?? "") !== "" || (opts.unblock_human ?? "") !== "";
  if (!named) {
    throw new Error(
      `task_block now requires an owner of the UNBLOCK: unblock_owner:"<agent>" or unblock_human:"<handle>" ` +
        `(decision 074). An unowned block points into the dark - it need not be the final assignee, only ` +
        `someone who has to process it. list_participants shows both namespaces and which field routes to each.`,
    );
  }
  // Same resolver the assignee field uses, so one vocabulary covers assigning and unblocking, and naming an
  // agent in the human field (or the reverse) gets the same corrective error instead of a silent mis-route.
  const who = await resolveAssignee(client, ctx, { owner: opts.unblock_owner, human: opts.unblock_human });
  await client.query(
    `INSERT INTO task_blockers
       (task_id, blocked_on_task_id, reason, unblock_condition,
        unblock_participation_id, unblock_owner_id, unblock_name)
     VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
    [opts.task_id, opts.reason, condition, who.participationId, who.ownerId, who.name],
  );
  await appendEvent(client, ctx, "task_block", {
    reason: opts.reason,
    unblock_condition: condition,
    unblock_owner: who.name,
  });
  return {
    task_id: opts.task_id,
    status: "blocked",
    unblock_owner: who.name,
    ...(who.warning ? { warning: who.warning } : {}),
  };
}

/** Clear a task's open MANUAL blockers (task_blockers rows). No status write - blocked is derived, so the
 *  task returns to its base status automatically once no manual block and no unmet dependency remain. */
export async function taskResolve(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  await client.query(
    `UPDATE task_blockers SET resolved_at = now() WHERE task_id = $1 AND resolved_at IS NULL`,
    [opts.task_id],
  );
  await appendEvent(client, ctx, "task_resolve", {});
  const blocked = await isBlocked(client, opts.task_id);
  return { task_id: opts.task_id, status: blocked ? "blocked" : current.status };
}

/**
 * Count of tasks the caller (agent) owns that are ACTIONABLE now - assigned to this participation, base
 * status `todo`, and NOT derived-blocked (so it can actually be started). Powers the per-call `_open_tasks`
 * nudge. Excludes in_progress (in-flight, banner-blindness) and blocked (cannot act yet). The fuller plate
 * is whats_new.my_open_tasks.
 */
export async function ownedActionableTaskCount(ctx: Ctx): Promise<number> {
  const res = await query<{ count: string }>(
    // A todo task assigned to me that is not derived-blocked is owed action now.
    `SELECT count(*)::text AS count FROM tasks t
      WHERE t.project_id = $1 AND t.owner_participation_id = $2
        AND t.status = 'todo' AND NOT ${IS_BLOCKED_SQL}`,
    [ctx.project.id, ctx.participation.id],
  );
  return Number(res.rows[0].count);
}

export interface TaskListItem {
  task_id: number;
  title: string;
  detail: string | null;
  lane: string | null;
  owner: string | null;
  status: string;
  blockers: number;
  // Decision task ("decide X") fields, so an agent reads the ask AND its answer inline instead of only via
  // the decision post (bug #545): `options` = the proposed chips (null for a plain/signoff task); once
  // answered, `selected_option` = the chosen chip (or "other") and `answer_note` = the human's free-form steer.
  options: string[] | null;
  selected_option: string | null;
  answer_note: string | null;
  // Present ONLY when the body was cut (decision 064), so a row with a short detail stays clean. Together
  // they answer "is there more, and is it worth fetching?" without shipping the body to find out.
  detail_truncated?: true;
  detail_chars?: number;
}

/** How much of each task BODY a list carries (decision 064). A list is an index, not a document: measured
 *  on prod, 93.5% of a bare list_tasks() payload was `detail` bodies (86,973 of ~93,000 chars in bu2), which
 *  overflowed a consuming agent's context at 101,865 characters. */
export type DetailMode = "preview" | "full" | "none";

/** Preview budget per row. Enough to recognize a task you already know and to judge relevance on one you
 *  do not; small enough that 50 of them cost ~7k characters instead of ~87k. */
export const DETAIL_PREVIEW_CHARS = 140;

/** Normalize whatever a client actually sent for `task_ids` into ids (decision 064).
 *
 *  Accepts an array of numbers AND a string, because a real client sends the latter: Claude Code - the
 *  primary consumer - serialized `task_ids:[536]` as the STRING "[536]" on the live tool, twice. A parameter
 *  the main client cannot express is a parameter that does not exist, and this one is the ONLY path to a task
 *  body, so rejecting the string would have left bodies unreachable - precisely the failure this decision
 *  set out to prevent. Tolerant on the way in, strict on what it yields: bracket/space noise is stripped,
 *  non-positive and non-integer entries are dropped, and the batch is capped. */
export function parseTaskIds(input: unknown): number[] {
  const raw: unknown[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.replace(/[[\]\s]/g, "").split(",").filter((p) => p.length > 0)
      : [];
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_TASK_IDS);
}

/** Batch ceiling for task_ids. A body read is deliberately bounded - 20 full details is already a large
 *  read, and an agent wanting more should be filtering, not fetching. */
export const MAX_TASK_IDS = 20;

/** List tasks in the project - ACTIONABLE first, then newest - with each task's effective status (blocked
 *  derived) and open manual-blocker count. `status` filters on the EFFECTIVE status (so status='blocked'
 *  selects derived-blocked tasks); `mine` narrows to tasks assigned to the calling participation.
 *
 *  A LIST IS AN INDEX, NOT A DOCUMENT (decision 064). Every row used to carry its FULL body (up to 4000
 *  chars), so the documented default call returned ~93,000 characters in a busy project and overflowed a
 *  consuming agent's context. Scope was not the lever - measured, narrowing to one agent's own actionable
 *  tasks still returned ~36,000 characters, because the bodies came too. So the body is PREVIEWED by
 *  default and trimmed IN SQL (`left(...)`), which means the full text never crosses the wire rather than
 *  being fetched and thrown away. `task_ids` is the paired precise read: naming a task IS asking for its
 *  body, so those rows always come back full, whatever the mode and whatever their state.
 *
 *  The default also drops the terminal archive: an agent asking "what is on the board" means open work, and
 *  `all_states`/`status` bring it back. Raw `t.status` (not the effective one) is used for that predicate -
 *  it is indexable, and every legacy/derived state resolves to non-terminal, which is the safe direction.
 *
 *  ORDERING IS LOAD-BEARING, NOT COSMETIC (decision 062). This was `ORDER BY t.id DESC` under a default
 *  LIMIT 50, so in a project whose archive had outgrown the page, a bare list_tasks() returned the newest 50
 *  rows - mostly done/cancelled - and an agent's own open work fell off the end with nothing to signal it.
 *  Measured on prod 2026-08-19: 10 open tasks hidden in bu2, 10 in project-b, 1 in imeo from the DOCUMENTED
 *  default call. Sorting terminal rows last means the limit can only ever eat archive, never the plate. */
/** Default page size for list_tasks. Shared with the MCP surface (decision 062) so the tool's
 *  truncation probe can never drift from the page it is probing. */
export const LIST_TASKS_DEFAULT_LIMIT = 50;

export async function listTasks(
  ctx: Ctx,
  filter: {
    status?: string;
    owner?: string;
    lane?: string;
    mine?: boolean;
    limit?: number;
    detail?: DetailMode;
    all_states?: boolean;
    task_ids?: unknown; // array OR string - see parseTaskIds
  } = {},
): Promise<TaskListItem[]> {
  const params: unknown[] = [ctx.project.id];
  const clauses: string[] = [`t.project_id = $1`];
  const push = (val: unknown): string => {
    params.push(val);
    return `$${params.length}`;
  };

  // Naming tasks outranks every scope default: you asked for THESE, so state is irrelevant and the body is
  // what you came for.
  const ids = parseTaskIds(filter.task_ids);
  const byId = ids.length > 0;
  const mode: DetailMode = byId ? "full" : (filter.detail ?? "preview");
  if (byId) clauses.push(`t.id = ANY(${push(ids)}::bigint[])`);

  if (filter.status) clauses.push(`${EFFECTIVE_STATUS_SQL} = ${push(filter.status)}`);
  else if (!byId && !filter.all_states) clauses.push(`t.status NOT IN ('done','cancelled')`);
  if (filter.owner) {
    const label = filter.owner.includes("/") ? filter.owner.slice(filter.owner.lastIndexOf("/") + 1) : filter.owner;
    clauses.push(`regexp_replace(t.owner_name, '^.*/', '') = ${push(label)}`);
  }
  if (filter.lane) clauses.push(`t.lane = ${push(filter.lane)}`);
  if (filter.mine) clauses.push(`t.owner_participation_id = ${push(ctx.participation.id)}`);

  const limitPlaceholder = push(filter.limit ?? LIST_TASKS_DEFAULT_LIMIT);
  // Trim in SQL, not in JS: `left()` means Postgres never sends the 4000-char body we would immediately
  // discard. Trimming after transfer would fix the agent's context and leave the wire cost untouched.
  const detailExpr =
    mode === "full" ? "t.detail" : mode === "none" ? "NULL::text" : `left(t.detail, ${DETAIL_PREVIEW_CHARS})`;

  const res = await query<{
    task_id: string;
    title: string;
    detail: string | null;
    lane: string | null;
    owner: string | null;
    status: string;
    blockers: string;
    options: string[] | null;
    selected_option: string | null;
    answer_note: string | null;
    detail_chars: string;
  }>(
    `SELECT t.id AS task_id, t.title, ${detailExpr} AS detail,
            length(coalesce(t.detail, ''))::text AS detail_chars,
            t.lane, t.owner_name AS owner,
            ${EFFECTIVE_STATUS_SQL} AS status,
            (SELECT count(*) FROM task_blockers b WHERE b.task_id = t.id AND b.resolved_at IS NULL)::text AS blockers,
            t.options, t.selected_option, t.answer_note
       FROM tasks t
      WHERE ${clauses.join(" AND ")}
      ORDER BY (t.status IN ('done','cancelled')) ASC, t.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );

  return res.rows.map((r) => {
    const chars = Number(r.detail_chars);
    // "Truncated" is derived from what actually came back, not from the mode, so a short body under preview
    // is reported as complete and never nags a fetch that would return the same text.
    const cut = chars > (r.detail?.length ?? 0);
    return {
      task_id: Number(r.task_id),
      title: r.title,
      detail: r.detail,
      lane: r.lane,
      owner: r.owner,
      status: r.status,
      blockers: Number(r.blockers),
      options: r.options,
      selected_option: r.selected_option,
      answer_note: r.answer_note,
      ...(cut ? { detail_truncated: true as const, detail_chars: chars } : {}),
    };
  });
}
