import type pg from "pg";
import { withTx } from "../db.js";
import { appendOwnerEvent } from "../events.js";
import { postFromOwner, laneAudience } from "../domain/post.js";
import { normalizeLinks } from "../domain/links.js";

// Owner-authored task mutators for the human web control surface (decision 039). A human on /admin holds no
// bus token and is not a participation, so these live in the owner-keyed admin/ layer (not Ctx-keyed domain/,
// which must not import admin/) - the exact split answerReview/postFromOwner already use. Each write:
//   1. locks the task in ONE transaction and re-proves the caller's authority in the SAME statement
//      (invariant 3, decision-037 membership predicate); zero rows -> null -> the handler 404s (no 403 oracle);
//   2. mirrors the domain state machine's transition rules line-for-line (single source of truth is the model
//      in domain/task.ts; any divergence is a bug the parity tests catch);
//   3. attributes via appendOwnerEvent (participation_id NULL, actor_name = the owner handle - invariant 1/6).
// null is the ONE failure signal (not-found, not-authorized, illegal transition, invalid input all collapse to
// it, exactly like answerReview) so the web surface can never leak a cross-tenant existence oracle.

const TERMINAL = new Set(["done", "cancelled"]);

/** The SSO caller: an owner row (id + display handle). Mirrors answerReview's `owner` param. */
export interface OwnerActor {
  id: number;
  username: string;
}

interface LockedTask {
  status: string;
  owner_participation_id: number | null;
  assignee_owner_id: number | null;
  options: string[] | null;
  created_by_id: number | null; // the agent that ASKED (for routing an answer/hand-off back to it, decision 042)
}

/**
 * Lock a task FOR UPDATE and re-prove WRITE authority in the same statement (decision 037): the project
 * OWNER or an ADMIN member may act on ANY task in the project (supervisor); a plain MEMBER may act ONLY on a
 * task assigned to THEM (`assignee_owner_id = owner`). Zero rows (not found OR not authorized) -> null, an
 * on-purpose no-oracle collapse. The row is locked so the follow-up UPDATE is race-free.
 */
async function lockTaskForWrite(
  client: pg.PoolClient,
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<LockedTask | null> {
  if (!Number.isFinite(taskId) || !Number.isFinite(projectId)) return null;
  const res = await client.query<{
    status: string;
    owner_participation_id: string | null;
    assignee_owner_id: string | null;
    options: string[] | null;
    created_by_id: string | null;
  }>(
    `SELECT t.status, t.owner_participation_id, t.assignee_owner_id, t.options, t.created_by_id
       FROM tasks t
       JOIN projects pr ON pr.id = t.project_id
       LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $3
      WHERE t.id = $1 AND t.project_id = $2
        AND (
          pr.owner_id = $3
          OR pm.role = 'admin'
          OR (pm.role = 'member' AND t.assignee_owner_id = $3)
        )
      FOR UPDATE OF t`,
    [taskId, projectId, owner.id],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    status: r.status,
    owner_participation_id: r.owner_participation_id != null ? Number(r.owner_participation_id) : null,
    assignee_owner_id: r.assignee_owner_id != null ? Number(r.assignee_owner_id) : null,
    options: r.options,
    created_by_id: r.created_by_id != null ? Number(r.created_by_id) : null,
  };
}

/**
 * Re-prove CREATE authority: any member of the project (owner, admin, or plain member) may author a task.
 * Zero rows -> null. (Distinct from the per-task predicate: creation has no existing task to scope a plain
 * member against, so membership existence is the gate.)
 */
async function proveProjectMembership(
  client: pg.PoolClient,
  owner: OwnerActor,
  projectId: number,
): Promise<boolean> {
  if (!Number.isFinite(projectId)) return false;
  const res = await client.query(
    `SELECT 1
       FROM projects pr
       LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $2
      WHERE pr.id = $1 AND (pr.owner_id = $2 OR pm.role IN ('admin', 'member'))`,
    [projectId, owner.id],
  );
  return (res.rowCount ?? 0) > 0;
}

interface ResolvedAssignee {
  participationId: number | null;
  ownerId: number | null;
  name: string | null;
}

/**
 * Resolve the dropdown value tag to assignee columns, re-proving the target is IN THIS PROJECT (invariant 1:
 * the tag is user input and grants no identity). `agent:<pid>` -> a participation in the project; `human:<oid>`
 * -> a member owner of the project; "" / undefined -> unassigned (a legitimate triple of nulls). An out-of-
 * project or malformed tag -> undefined, which the caller turns into null (404). Returns the display snapshot
 * `name` too (qualified `handle/label` for an agent, username/email for a human).
 */
async function resolveAssigneeTag(
  client: pg.PoolClient,
  projectId: number,
  tag: string | undefined,
): Promise<ResolvedAssignee | undefined> {
  if (tag === undefined || tag === "" || tag === "unassigned") {
    return { participationId: null, ownerId: null, name: null };
  }
  const agentMatch = /^agent:(\d+)$/.exec(tag);
  if (agentMatch) {
    const pid = Number(agentMatch[1]);
    // The handle is the agent's OWN human: the BOUND human (participations.human_owner_id, canonical per
    // 038/056) then the provisioner - NOT whoever is assigning. Composing from the provisioner alone stamped
    // the wrong human onto a cross-provisioned agent (e.g. `daniel/imeo-alice-agent` for Alice's agent),
    // diverging from list_participants and from the MCP write path (decision 061, the imeo report).
    const r = await client.query<{ label: string; handle: string | null }>(
      `SELECT pt.name AS label, COALESCE(ho.username, o.username) AS handle
         FROM participations pa
         JOIN participants pt ON pt.id = pa.participant_id
         LEFT JOIN owners o ON o.id = pt.owner_id
         LEFT JOIN owners ho ON ho.id = pa.human_owner_id
        WHERE pa.id = $1 AND pa.project_id = $2`,
      [pid, projectId],
    );
    if (r.rowCount === 0) return undefined;
    const { label, handle } = r.rows[0];
    return { participationId: pid, ownerId: null, name: handle ? `${handle}/${label}` : label };
  }
  const humanMatch = /^human:(\d+)$/.exec(tag);
  if (humanMatch) {
    const oid = Number(humanMatch[1]);
    const r = await client.query<{ username: string | null; email: string }>(
      `SELECT o.username, o.email
         FROM project_members pm JOIN owners o ON o.id = pm.owner_id
        WHERE pm.owner_id = $1 AND pm.project_id = $2`,
      [oid, projectId],
    );
    if (r.rowCount === 0) return undefined;
    return { participationId: null, ownerId: oid, name: r.rows[0].username ?? r.rows[0].email };
  }
  return undefined;
}

/** True if the task is derived-blocked (unmet dependency or open manual blocker). Mirrors domain isBlocked. */
async function taskIsBlocked(client: pg.PoolClient, taskId: number): Promise<boolean> {
  const res = await client.query<{ blocked: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id
                      WHERE d.task_id = $1 AND dt.status <> 'done')
         OR  EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = $1 AND b.resolved_at IS NULL)) AS blocked`,
    [taskId],
  );
  return res.rows[0].blocked;
}

/** Create a task as the SSO owner (-> todo). Any project member may author. Returns null if not a member or
 *  the assignee tag names a target outside the project. */
export async function taskCreateFromOwner(
  owner: OwnerActor,
  projectId: number,
  input: { title: string; detail?: string; lane?: string; assignee?: string; options?: string[]; links?: unknown },
): Promise<{ taskId: number } | null> {
  const title = (input.title ?? "").trim();
  if (!title) return null;
  return withTx(async (client) => {
    if (!(await proveProjectMembership(client, owner, projectId))) return null;
    const assignee = await resolveAssigneeTag(client, projectId, input.assignee);
    if (assignee === undefined) return null;
    const options = input.options && input.options.length ? input.options.slice(0, 6) : null;
    const links = normalizeLinks(input.links);
    const res = await client.query<{ id: string }>(
      // created_by_owner_id = the authoring human (decision 055 / task 541): a human authors via /admin and is
      // not a participation, so created_by_id stays NULL; recording the owner here lets the board show "from me".
      `INSERT INTO tasks (project_id, title, detail, lane, owner_participation_id, assignee_owner_id, owner_name,
                          status, options, links, created_by_owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'todo', $8::jsonb, $9::jsonb, $10)
       RETURNING id`,
      [
        projectId,
        title,
        input.detail?.trim() || null,
        input.lane?.trim() || null,
        assignee.participationId,
        assignee.ownerId,
        assignee.name,
        options ? JSON.stringify(options) : null,
        links ? JSON.stringify(links) : null,
        owner.id,
      ],
    );
    const taskId = Number(res.rows[0].id);
    await appendOwnerEvent(client, projectId, owner.username, "task_create", {
      title,
      lane: input.lane?.trim() || null,
      owner: assignee.name,
    });
    return { taskId };
  });
}

/** Edit a task's fields (title/detail/lane/links/options) as the SSO owner. */
export async function taskEditFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  fields: { title?: string; detail?: string; lane?: string; links?: unknown; options?: string[] },
): Promise<{ taskId: number } | null> {
  return withTx(async (client) => {
    if ((await lockTaskForWrite(client, owner, projectId, taskId)) === null) return null;
    const sets: string[] = [];
    const params: unknown[] = [taskId, projectId];
    const push = (val: unknown): string => {
      params.push(val);
      return `$${params.length}`;
    };
    if (fields.title !== undefined) {
      const t = fields.title.trim();
      if (!t) return null;
      sets.push(`title = ${push(t)}`);
    }
    if (fields.detail !== undefined) sets.push(`detail = ${push(fields.detail.trim() || null)}`);
    if (fields.lane !== undefined) sets.push(`lane = ${push(fields.lane.trim() || null)}`);
    if (fields.links !== undefined) sets.push(`links = ${push(JSON.stringify(normalizeLinks(fields.links)))}::jsonb`);
    if (fields.options !== undefined) {
      const options = fields.options && fields.options.length ? fields.options.slice(0, 6) : null;
      sets.push(`options = ${push(options ? JSON.stringify(options) : null)}::jsonb`);
    }
    if (sets.length === 0) return null;
    await client.query(
      `UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND project_id = $2`,
      params,
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_edit", { fields: sets.length });
    return { taskId };
  });
}

/** Assign / reassign / unassign a task as the SSO owner. Reassigning an in-flight task is a HAND-OFF (reverts
 *  to todo, clearing the soft-lock), mirroring domain taskAssign. Terminal tasks reject (null). */
export async function taskAssignFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  assigneeTag: string | undefined,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (TERMINAL.has(current.status)) return null;
    const assignee = await resolveAssigneeTag(client, projectId, assigneeTag);
    if (assignee === undefined) return null;
    const nextStatus = current.status === "in_progress" ? "todo" : current.status;
    const res = await client.query<{ status: string }>(
      `UPDATE tasks SET owner_participation_id = $3, assignee_owner_id = $4, owner_name = $5,
                        status = $6, updated_at = now()
        WHERE id = $1 AND project_id = $2 RETURNING status`,
      [taskId, projectId, assignee.participationId, assignee.ownerId, assignee.name, nextStatus],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_assign", {
      owner: assignee.name,
      handoff: current.status === "in_progress",
    });
    return { taskId, status: res.rows[0].status };
  });
}

/** Start a task (todo -> in_progress) as the SSO owner, acquiring the soft-lock. An UNASSIGNED task is grabbed
 *  to the human (assignee_owner_id = owner). A derived-blocked task cannot start (null). */
export async function taskStartFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (current.status !== "todo") return null;
    if (await taskIsBlocked(client, taskId)) return null;
    const grab = current.owner_participation_id == null && current.assignee_owner_id == null;
    const res = await client.query<{ status: string }>(
      `UPDATE tasks SET status = 'in_progress',
                        assignee_owner_id = CASE WHEN $3 THEN $4 ELSE assignee_owner_id END,
                        owner_name = CASE WHEN $3 THEN $5 ELSE owner_name END,
                        updated_at = now()
        WHERE id = $1 AND project_id = $2 RETURNING status`,
      [taskId, projectId, grab, owner.id, owner.username],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_start", { grabbed: grab });
    return { taskId, status: res.rows[0].status };
  });
}

/** Ship a task (in_progress -> done) as the SSO owner. A decide-this task (options set) uses answer instead. */
export async function taskShipFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (current.status !== "in_progress") return null;
    await client.query(
      `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = $1 AND project_id = $2`,
      [taskId, projectId],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_ship", {});
    return { taskId, status: "done" };
  });
}

/**
 * Answer a decide-this task as the SSO owner: record the choice/note, complete it (-> done), and DELIVER the
 * decision to the assignee of every dependent task (which also unblocks them, blocked being derived). Mirrors
 * domain taskAnswer, but the answer is owner-authored (answered_by_owner_id) and delivered via postFromOwner.
 */
export async function taskAnswerFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  input: { option?: string; note?: string | null },
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (TERMINAL.has(current.status)) return null;
    const note = (input.note ?? "").trim() || null;
    const option = (input.option ?? "").trim() || null;
    if (current.options && current.options.length) {
      if (!option) return null;
      if (option !== "other" && !current.options.includes(option)) return null;
      if (option === "other" && !note) return null;
    } else if (!option && !note) {
      return null;
    }
    await client.query(
      `UPDATE tasks SET status = 'done', selected_option = $3, answer_note = $4,
                        answered_by_owner_id = $5, answered_at = now(), updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      [taskId, projectId, option, note, owner.id],
    );
    // Deliver the decision to each dependent task's AGENT assignee (now unblocked) AND to the agent that
    // ASKED (created_by_id) - so the requester of an "ask me" task learns the human's answer without polling
    // (decision 042). Dedupe.
    const deps = await client.query<{ owner_participation_id: string | null }>(
      `SELECT t.owner_participation_id
         FROM task_deps d JOIN tasks t ON t.id = d.task_id
        WHERE d.depends_on_task_id = $1 AND t.owner_participation_id IS NOT NULL`,
      [taskId],
    );
    const notify = new Set<number>();
    for (const dep of deps.rows) if (dep.owner_participation_id != null) notify.add(Number(dep.owner_participation_id));
    if (current.created_by_id != null) notify.add(current.created_by_id);
    const body = `Decision on task #${taskId}: ${option ?? "(note)"}${note ? ` - ${note}` : ""}`;
    for (const pid of notify) {
      await postFromOwner(client, {
        projectId,
        fromActorName: owner.username,
        toParticipationId: pid,
        toLane: null,
        body,
        ref: `task:${taskId}`,
        tag: "task",
      });
    }
    await appendOwnerEvent(client, projectId, owner.username, "task_answer", {
      option,
      has_note: note != null,
      notified: notify.size,
    });
    return { taskId, status: "done" };
  });
}

/**
 * Hand a task to an AGENT with the human's note as context (decision 042): reassign the task to the chosen
 * agent (an in-progress task reverts to `todo` so the agent re-starts it - the same soft-lock rule as
 * taskAssign) and DELIVER the note to that agent as an owner-authored post. This is "make the outcome into a
 * task for an agent to handle" - the task stays ACTIVE, now owned by the agent. `agentTag` must resolve to an
 * `agent:<pid>` IN this project (a human tag or an out-of-project tag -> null; invariant 1). Membership-gated
 * like every write. Defaults to the ASKER when the UI passes the asking agent's tag.
 */
export async function taskHandoffFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  agentTag: string | undefined,
  note: string | null,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (TERMINAL.has(current.status)) return null;
    const assignee = await resolveAssigneeTag(client, projectId, agentTag);
    if (assignee === undefined || assignee.participationId == null) return null; // must be an in-project AGENT
    const nextStatus = current.status === "in_progress" ? "todo" : current.status;
    await client.query(
      `UPDATE tasks SET owner_participation_id = $3, assignee_owner_id = NULL, owner_name = $4,
                        status = $5, updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      [taskId, projectId, assignee.participationId, assignee.name, nextStatus],
    );
    const trimmed = (note ?? "").trim();
    if (trimmed) {
      await postFromOwner(client, {
        projectId,
        fromActorName: owner.username,
        toParticipationId: assignee.participationId,
        toLane: null,
        body: `Handed you task #${taskId}: ${trimmed}`,
        ref: `task:${taskId}`,
        tag: "task",
      });
    }
    await appendOwnerEvent(client, projectId, owner.username, "task_assign", {
      owner: assignee.name,
      handoff: true,
      has_note: trimmed.length > 0,
    });
    return { taskId, status: nextStatus };
  });
}

/** Un-start a task (in_progress -> todo, keeping the assignee) as the SSO owner - the "put it back to Todo"
 *  transition (decision 042). Mirrors domain taskStop. Only legal from in_progress; else null. */
export async function taskStopFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (current.status !== "in_progress") return null;
    await client.query(
      `UPDATE tasks SET status = 'todo', updated_at = now() WHERE id = $1 AND project_id = $2`,
      [taskId, projectId],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_stop", {});
    return { taskId, status: "todo" };
  });
}

/** Cancel a task (any non-terminal -> cancelled) as the SSO owner. Soft delete; keeps history. */
export async function taskCancelFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (TERMINAL.has(current.status)) return null;
    await client.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND project_id = $2`,
      [taskId, projectId],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_cancel", {});
    return { taskId, status: "cancelled" };
  });
}

/** Reopen a done/cancelled task back to todo (clearing any recorded decision answer) as the SSO owner. */
export async function taskReopenFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
): Promise<{ taskId: number; status: string } | null> {
  return withTx(async (client) => {
    const current = await lockTaskForWrite(client, owner, projectId, taskId);
    if (current === null) return null;
    if (!TERMINAL.has(current.status)) return null;
    await client.query(
      `UPDATE tasks SET status = 'todo', selected_option = NULL, answer_note = NULL,
                        answered_by_participation_id = NULL, answered_by_owner_id = NULL, answered_at = NULL,
                        updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      [taskId, projectId],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_reopen", {});
    return { taskId, status: "todo" };
  });
}

/** Add a dependency edge (task_id depends on dependsOn) as the SSO owner. BOTH tasks must be writable by the
 *  caller in this project; rejects self-deps and cycles (null), mirroring domain taskDepend. */
export async function taskDependFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  dependsOn: number,
): Promise<{ taskId: number; dependsOn: number } | null> {
  if (!Number.isFinite(dependsOn) || taskId === dependsOn) return null;
  return withTx(async (client) => {
    if ((await lockTaskForWrite(client, owner, projectId, taskId)) === null) return null;
    // The dependency TARGET must also be in-project + writable by the caller (no cross-tenant oracle).
    if ((await lockTaskForWrite(client, owner, projectId, dependsOn)) === null) return null;
    const cycle = await client.query<{ hit: boolean }>(
      `WITH RECURSIVE reach(id) AS (
         SELECT depends_on_task_id FROM task_deps WHERE task_id = $1
         UNION
         SELECT d.depends_on_task_id FROM task_deps d JOIN reach r ON d.task_id = r.id)
       SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2) AS hit`,
      [dependsOn, taskId],
    );
    if (cycle.rows[0].hit) return null;
    await client.query(
      `INSERT INTO task_deps (task_id, depends_on_task_id, created_by_owner_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [taskId, dependsOn, owner.id],
    );
    await appendOwnerEvent(client, projectId, owner.username, "task_depend", { depends_on: dependsOn });
    return { taskId, dependsOn };
  });
}

/**
 * Send a prose message as the SSO owner (the web twin of the `post` MCP tool). Membership-gated: any member
 * of the project may message. Resolves an optional `toActor` to a participation IN THE PROJECT (invariant 1:
 * the name grants no identity); addressed to a lane and/or that actor. Owner-authored via postFromOwner.
 */
export async function sendMessageFromOwner(
  owner: OwnerActor,
  projectId: number,
  input: { toLane?: string; toActor?: string; subject?: string; body: string; ref?: string },
): Promise<{ postId: number; reaches: number } | { error: string } | null> {
  const body = (input.body ?? "").trim();
  if (!body) return null;
  const toLane = input.toLane?.trim() || null;
  const toActorRaw = input.toActor?.trim() || null;
  if (!toLane && !toActorRaw) return null;
  return withTx(async (client) => {
    if (!(await proveProjectMembership(client, owner, projectId))) return null;
    let toParticipationId: number | null = null;
    if (toActorRaw) {
      const label = toActorRaw.includes("/") ? toActorRaw.slice(toActorRaw.lastIndexOf("/") + 1) : toActorRaw;
      const t = await client.query<{ id: string }>(
        `SELECT pa.id FROM participations pa JOIN participants pt ON pt.id = pa.participant_id
          WHERE pa.project_id = $1 AND pt.name = $2`,
        [projectId, label],
      );
      if (t.rowCount === 0) return null; // an out-of-project actor grants no target (no cross-tenant oracle)
      toParticipationId = Number(t.rows[0].id);
    }
    // Decision 065: this path used to have NO reachability check at all while telling the operator "Sent.
    // Your agent picks it up on its next check-in" - a stronger promise than the MCP path, with nothing
    // behind it. A lane-only message to a lane nobody resolves to is refused here for the same reason it is
    // refused on the MCP path: a success screen for a message that reached nobody is the failure this
    // decision exists to end.
    let reaches = toParticipationId != null ? 1 : 0;
    if (toParticipationId == null && toLane) {
      // Consumes the SAME laneAudience the MCP path uses. Re-implementing the live-then-provisioned
      // resolution here would be the sixth hand-copy of the rule, and five hand-copies are what produced
      // the bug 065 fixes.
      // -1 excludes nobody: the sender here is the OWNER, a human with no participation, so unlike an
      // agent posting to its own lane there is no self to leave out (decision 062 does not apply).
      const audience = await laneAudience(client, projectId, -1, toLane);
      reaches = audience.recipients.length;
      if (!audience.known.includes(toLane)) {
        return {
          error:
            `Lane "${toLane}" does not exist in this project` +
            (audience.known.length ? ` - lanes in use: ${audience.known.join(", ")}.` : " - this project has no lanes.") +
            ` Pick one of those, or address one agent directly.`,
        };
      }
      if (reaches === 0) {
        return {
          error:
            `Lane "${toLane}" exists but no agent currently resolves to it, so this message would reach ` +
            `nobody. Address an agent directly, or wait until one joins the lane.`,
        };
      }
    }
    const res = await postFromOwner(client, {
      projectId,
      fromActorName: owner.username,
      toParticipationId,
      toLane: toParticipationId != null ? null : toLane,
      subject: input.subject?.trim() || null,
      body,
      ref: input.ref?.trim() || null,
      tag: null,
    });
    return { postId: res.post_id, reaches };
  });
}

/** Remove a dependency edge as the SSO owner. */
export async function taskUndependFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  dependsOn: number,
): Promise<{ taskId: number; dependsOn: number } | null> {
  return withTx(async (client) => {
    if ((await lockTaskForWrite(client, owner, projectId, taskId)) === null) return null;
    await client.query(`DELETE FROM task_deps WHERE task_id = $1 AND depends_on_task_id = $2`, [taskId, dependsOn]);
    await appendOwnerEvent(client, projectId, owner.username, "task_undepend", { depends_on: dependsOn });
    return { taskId, dependsOn };
  });
}
