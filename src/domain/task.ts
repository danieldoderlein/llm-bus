import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";
import { query } from "../db.js";

// The task graph state machine. Status flows:
//   open --assign--> assigned --start--> in_progress --block--> blocked
//                       ^                     |  ^                  |
//                       |                     | (resolve, last)     |
//                       +---------------------+------ship-> done    +-> in_progress
// Transitions are enforced by reading the current row (project-scoped) FIRST and
// throwing on an illegal move, so an invalid call never mutates state.

interface TaskRow {
  status: string;
}

/** Read a task's current status, scoped to the project. Throws if it does not exist. */
async function loadTask(client: pg.PoolClient, ctx: Ctx, taskId: number): Promise<TaskRow> {
  const res = await client.query<TaskRow>(
    `SELECT status FROM tasks WHERE project_id = $1 AND id = $2`,
    [ctx.project.id, taskId],
  );
  if (res.rows.length === 0) {
    throw new Error(`task ${taskId} not found in project ${ctx.project.id}`);
  }
  return res.rows[0];
}

/** Resolve a participant name to its participation id within the project. Throws if no such participant.
 *  Accepts either the bare label ("backend-agent") or the qualified actor ("handle/backend-agent") -
 *  decision 018; the stored participant name is the bare label. */
async function resolveOwner(
  client: pg.PoolClient,
  ctx: Ctx,
  owner: string,
): Promise<{ id: number; name: string }> {
  const label = owner.includes("/") ? owner.slice(owner.lastIndexOf("/") + 1) : owner;
  const res = await client.query<{ id: string; name: string }>(
    `SELECT pa.id, pt.name
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
      WHERE pa.project_id = $1 AND pt.name = $2`,
    [ctx.project.id, label],
  );
  if (res.rows.length === 0) {
    throw new Error(`owner "${owner}" not found in project ${ctx.project.id}`);
  }
  return { id: Number(res.rows[0].id), name: res.rows[0].name };
}

/** Qualify a project participant's bare label into the displayed actor `handle/label`. The assignee
 *  shares the project owner (R3), whose handle is the caller's handle. Bare fallback during the
 *  pre-handle migration window (decision 018). */
function qualifyActor(ctx: Ctx, label: string): string {
  return ctx.participant.handle ? `${ctx.participant.handle}/${label}` : label;
}

/** Count open (unresolved) blockers for a task. */
async function openBlockerCount(client: pg.PoolClient, taskId: number): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM task_blockers
      WHERE task_id = $1 AND resolved_at IS NULL`,
    [taskId],
  );
  return Number(res.rows[0].count);
}

/**
 * Create a task. If `owner` is given it is resolved within the project and the task
 * starts "assigned"; otherwise it starts "open".
 */
export async function taskCreate(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { title: string; detail?: string; lane?: string; owner?: string },
): Promise<{ task_id: number; status: string }> {
  let ownerId: number | null = null;
  let ownerName: string | null = null;
  let status = "open";
  if (opts.owner) {
    const owner = await resolveOwner(client, ctx, opts.owner);
    ownerId = owner.id;
    ownerName = qualifyActor(ctx, owner.name);
    status = "assigned";
  }

  const res = await client.query<{ id: string; status: string }>(
    `INSERT INTO tasks (project_id, title, detail, lane, owner_participation_id, owner_name, status, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, status`,
    [
      ctx.project.id,
      opts.title,
      opts.detail ?? null,
      opts.lane ?? null,
      ownerId,
      ownerName,
      status,
      ctx.participation.id,
    ],
  );
  const taskId = Number(res.rows[0].id);
  await appendEvent(client, ctx, "task_create", {
    title: opts.title,
    lane: opts.lane ?? null,
    owner: opts.owner ?? null,
  });
  return { task_id: taskId, status: res.rows[0].status };
}

/** Assign (or reassign) a task's owner. Legal only from open or assigned. */
export async function taskAssign(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; owner: string },
): Promise<{ task_id: number; owner: string; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "open" && current.status !== "assigned") {
    throw new Error(`cannot assign task ${opts.task_id} from status "${current.status}"`);
  }
  const owner = await resolveOwner(client, ctx, opts.owner);
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET owner_participation_id = $3, owner_name = $4, status = 'assigned', updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id, owner.id, qualifyActor(ctx, owner.name)],
  );
  await appendEvent(client, ctx, "task_assign", { owner: opts.owner });
  return { task_id: opts.task_id, owner: owner.name, status: res.rows[0].status };
}

/** Start work on a task. Legal only from assigned. */
export async function taskStart(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "assigned") {
    throw new Error(`cannot start task ${opts.task_id} from status "${current.status}"`);
  }
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET status = 'in_progress', updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_start", {});
  return { task_id: opts.task_id, status: res.rows[0].status };
}

/** Mark a task blocked, recording the blocker. Legal only from in_progress. */
export async function taskBlock(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; on?: number; reason: string },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);
  if (current.status !== "in_progress") {
    throw new Error(`cannot block task ${opts.task_id} from status "${current.status}"`);
  }
  // The blocked-on task, if given, must belong to THIS project (no cross-tenant
  // references or existence oracle). loadTask throws if it is absent from the project.
  if (opts.on !== undefined) {
    await loadTask(client, ctx, opts.on);
  }
  await client.query(
    `INSERT INTO task_blockers (task_id, blocked_on_task_id, reason)
     VALUES ($1, $2, $3)`,
    [opts.task_id, opts.on ?? null, opts.reason],
  );
  const res = await client.query<{ status: string }>(
    `UPDATE tasks SET status = 'blocked', updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_block", { on: opts.on ?? null, reason: opts.reason });
  return { task_id: opts.task_id, status: res.rows[0].status };
}

/**
 * Resolve a task's blocker(s). Resolves the matching open blocker(s); if none remain
 * open and the task is blocked, it returns to in_progress.
 */
export async function taskResolve(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { task_id: number; blocker?: number },
): Promise<{ task_id: number; status: string }> {
  const current = await loadTask(client, ctx, opts.task_id);

  const params: unknown[] = [opts.task_id];
  let blockerClause = "";
  if (opts.blocker !== undefined) {
    params.push(opts.blocker);
    blockerClause = `AND blocked_on_task_id = $${params.length}`;
  }
  await client.query(
    `UPDATE task_blockers SET resolved_at = now()
      WHERE task_id = $1 AND resolved_at IS NULL ${blockerClause}`,
    params,
  );

  let status = current.status;
  const remaining = await openBlockerCount(client, opts.task_id);
  if (remaining === 0 && current.status === "blocked") {
    const res = await client.query<{ status: string }>(
      `UPDATE tasks SET status = 'in_progress', updated_at = now()
        WHERE project_id = $1 AND id = $2
        RETURNING status`,
      [ctx.project.id, opts.task_id],
    );
    status = res.rows[0].status;
  }
  await appendEvent(client, ctx, "task_resolve", { blocker: opts.blocker ?? null });
  return { task_id: opts.task_id, status };
}

/** Ship a task (mark done). Legal only from in_progress. */
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
    `UPDATE tasks SET status = 'done', updated_at = now()
      WHERE project_id = $1 AND id = $2
      RETURNING status`,
    [ctx.project.id, opts.task_id],
  );
  await appendEvent(client, ctx, "task_ship", {});
  return { task_id: opts.task_id, status: res.rows[0].status };
}

export interface TaskListItem {
  task_id: number;
  title: string;
  lane: string | null;
  owner: string | null;
  status: string;
  blockers: number;
}

/** List tasks in the project, newest first, with each task's open-blocker count. */
export async function listTasks(
  ctx: Ctx,
  filter: { status?: string; owner?: string; lane?: string; limit?: number } = {},
): Promise<TaskListItem[]> {
  const params: unknown[] = [ctx.project.id];
  const clauses: string[] = [`t.project_id = $1`];
  const push = (val: unknown): string => {
    params.push(val);
    return `$${params.length}`;
  };

  if (filter.status) clauses.push(`t.status = ${push(filter.status)}`);
  if (filter.owner) clauses.push(`t.owner_name = ${push(filter.owner)}`);
  if (filter.lane) clauses.push(`t.lane = ${push(filter.lane)}`);

  const limitPlaceholder = push(filter.limit ?? 50);

  const res = await query<{
    task_id: string;
    title: string;
    lane: string | null;
    owner: string | null;
    status: string;
    blockers: string;
  }>(
    `SELECT t.id AS task_id, t.title, t.lane, t.owner_name AS owner, t.status,
            count(b.task_id)::text AS blockers
       FROM tasks t
       LEFT JOIN task_blockers b ON b.task_id = t.id AND b.resolved_at IS NULL
      WHERE ${clauses.join(" AND ")}
      GROUP BY t.id, t.title, t.lane, t.owner_name, t.status
      ORDER BY t.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );

  return res.rows.map((r) => ({
    task_id: Number(r.task_id),
    title: r.title,
    lane: r.lane,
    owner: r.owner,
    status: r.status,
    blockers: Number(r.blockers),
  }));
}
