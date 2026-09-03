import { randomBytes } from "node:crypto";
import { projectReadClause } from "./domain/projects.js";
import { query, withTx } from "./db.js";
import { hashToken } from "./auth.js";

// Project invite codes (the legacy open "join link" flow). RETIRED by decisions 037/038: `POST /join` and the
// request-to-join pages (`/p/:handle/:slug`) now return 410 and no surface mints these codes - create_invite
// and the admin invite UI moved to TARGETED email invites (invite-accept.ts), so a collaborator SSO-accepts
// and their agent binds to their own identity. createInvite / redeemInvite / buildJoinFiles /
// buildConnectCommand / buildInvitePrompt remain ONLY as the functions the invite.redeem test exercises
// (prod-dead; the `POST /join` flow buildInvitePrompt describes no longer exists - tracked for deletion in
// PLAN.md). listInvites / revokeInvite stay live: the Access page still lists and revokes any legacy codes.

const MAX_NAME = 64;

export interface InviteRow {
  id: number;
  code: string;
  intendedName: string | null;
  kind: "agent" | "human";
  lane: string | null;
  isAdmin: boolean;
  maxUses: number;
  uses: number;
  expiresAt: string;
}

function genCode(): string {
  return randomBytes(12).toString("base64url"); // ~16 chars, unguessable; one-use + 24h-TTL + rate-limited
}

function validName(n: string | null | undefined): string | null {
  if (!n) return null;
  const t = n.trim();
  if (!t || t.length > MAX_NAME) return null;
  return t;
}

/** Mint an invite for a project (owner-scoped: the project must belong to ownerId). */
export async function createInvite(
  ownerId: number,
  projectId: number,
  opts: {
    name?: string | null;
    kind?: "agent" | "human";
    lane?: string | null;
    isAdmin?: boolean;
    uses?: number;
    ttlHours?: number;
  },
): Promise<{ id: number; code: string; expiresAt: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const code = genCode();
  const name = validName(opts.name);
  const kind = opts.kind === "human" ? "human" : "agent";
  const lane = opts.lane && opts.lane.trim() ? opts.lane.trim() : null;
  const isAdmin = opts.isAdmin === true;
  const uses = Math.min(Math.max(Math.trunc(opts.uses ?? 1), 1), 50);
  const ttl = Math.min(Math.max(Math.trunc(opts.ttlHours ?? 24), 1), 168);
  const res = await query<{ id: string; code: string; expires_at: string }>(
    `INSERT INTO join_codes (code, project_id, intended_name, kind, lane, is_admin, max_uses, expires_at)
     SELECT $1, pr.id, $3, $4, $5, $6, $7, now() + make_interval(hours => $8)
       FROM projects pr
      WHERE pr.id = $2 AND pr.owner_id = $9
     RETURNING id, code, expires_at`,
    [code, projectId, name, kind, lane, isAdmin, uses, ttl, ownerId],
  );
  if (res.rowCount === 0) return null; // project not owned
  const r = res.rows[0];
  // pg returns TIMESTAMPTZ as a Date object - normalize to an ISO string for the UI/JSON.
  return { id: Number(r.id), code: r.code, expiresAt: new Date(r.expires_at).toISOString() };
}

/** Active (un-revoked, un-expired) invites for a project (owner-scoped). */
export async function listInvites(ownerId: number, projectId: number): Promise<InviteRow[]> {
  if (!Number.isFinite(projectId)) return [];
  const res = await query<{
    id: string;
    code: string;
    intended_name: string | null;
    kind: "agent" | "human";
    lane: string | null;
    is_admin: boolean;
    max_uses: number;
    uses: number;
    expires_at: string;
  }>(
    `SELECT jc.id, jc.code, jc.intended_name, jc.kind, jc.lane, jc.is_admin, jc.max_uses, jc.uses, jc.expires_at
       FROM join_codes jc
       JOIN projects pr ON pr.id = jc.project_id
      WHERE jc.project_id = $1 AND ${projectReadClause("$2")} AND jc.revoked_at IS NULL AND jc.expires_at > now()
      ORDER BY jc.created_at DESC`,
    [projectId, ownerId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    intendedName: r.intended_name,
    kind: r.kind,
    lane: r.lane,
    isAdmin: r.is_admin,
    maxUses: Number(r.max_uses),
    uses: Number(r.uses),
    expiresAt: new Date(r.expires_at).toISOString(), // pg returns a Date; normalize for the UI
  }));
}

/** Revoke an invite (owner-scoped). Returns true if a row was revoked. */
export async function revokeInvite(ownerId: number, inviteId: number): Promise<boolean> {
  if (!Number.isFinite(inviteId)) return false;
  const res = await query(
    `UPDATE join_codes jc
        SET revoked_at = now()
       FROM projects pr
      WHERE jc.id = $1 AND jc.project_id = pr.id AND pr.owner_id = $2 AND jc.revoked_at IS NULL`,
    [inviteId, ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}

export type RedeemResult =
  | {
      ok: true;
      token: string;
      projectSlug: string;
      projectName: string;
      participant: string;
      created: boolean; // true = a new participant was created; false = attached to an existing one (locked name only)
      isAdmin: boolean; // the invite granted project-admin (lead) -> the guide includes admin powers
    }
  | { ok: false; error: "invalid" | "expired" | "exhausted" | "name_required" | "name_taken" };

/**
 * PUBLIC: redeem an invite code. Validates (exists, not revoked, not expired, uses remaining)
 * under a row lock, resolves the name (the code's locked name, else the redeemer's chosen one),
 * upserts the participant + participation under the project's owner, mints a token, and bumps
 * uses - all atomically. Returns the token + project info, or a typed error.
 */
export async function redeemInvite(code: string, providedName: string | null): Promise<RedeemResult> {
  if (!code || code.length > 256) return { ok: false, error: "invalid" };
  return withTx(async (c) => {
    const codeRes = await c.query<{
      id: string;
      project_id: string;
      owner_id: string;
      project_slug: string;
      project_name: string;
      intended_name: string | null;
      kind: "agent" | "human";
      lane: string | null;
      is_admin: boolean;
      max_uses: number;
      uses: number;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT jc.id, jc.project_id, pr.owner_id, pr.slug AS project_slug, pr.name AS project_name,
              jc.intended_name, jc.kind, jc.lane, jc.is_admin, jc.max_uses, jc.uses, jc.expires_at, jc.revoked_at
         FROM join_codes jc
         JOIN projects pr ON pr.id = jc.project_id
        WHERE jc.code = $1
        FOR UPDATE OF jc`,
      [code],
    );
    if (codeRes.rowCount === 0) return { ok: false, error: "invalid" };
    const jc = codeRes.rows[0];
    if (jc.revoked_at) return { ok: false, error: "invalid" };
    if (new Date(jc.expires_at).getTime() <= Date.now()) return { ok: false, error: "expired" };
    if (Number(jc.uses) >= Number(jc.max_uses)) return { ok: false, error: "exhausted" };

    const locked = validName(jc.intended_name);
    const name = locked ?? validName(providedName);
    if (!name) return { ok: false, error: "name_required" };

    // Resolve the participant. Try to create it; if the name already exists for this owner:
    //  - a LOCKED invite (the admin chose the name) attaches to that existing identity (intended);
    //  - an OPEN invite (the redeemer chose) reports name_taken WITHOUT consuming the code, so they
    //    retry with a different name. This stops a brand-new joiner silently merging into someone else.
    const ins = await c.query<{ id: string }>(
      `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO NOTHING
       RETURNING id`,
      [Number(jc.owner_id), name, jc.kind],
    );
    let participantId: number;
    let created: boolean;
    if (ins.rowCount && ins.rows[0]) {
      participantId = Number(ins.rows[0].id);
      created = true;
    } else if (locked) {
      const sel = await c.query<{ id: string }>(
        `SELECT id FROM participants WHERE owner_id = $1 AND name = $2`,
        [Number(jc.owner_id), name],
      );
      participantId = Number(sel.rows[0].id);
      created = false;
    } else {
      return { ok: false, error: "name_taken" }; // open invite + taken: retry; the code is preserved
    }

    const participation = await c.query<{ id: string }>(
      // Decision 037: bind the agent to a human (the project owner) so no participation is human-less. The
      // canonical collaborator path is the SSO invite-accept flow, which binds the agent to the ACCEPTING
      // human and records their membership; this public /join path binds to the owner as a floor. The
      // human_owner_id is the locked jc.owner_id (server-derived), never input (invariant 1); COALESCE on
      // conflict never overwrites a human already bound (e.g. after an SSO claim).
      `INSERT INTO participations (participant_id, project_id, lane, is_admin, human_owner_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (participant_id, project_id)
         DO UPDATE SET is_admin = participations.is_admin OR $4,
                       lane = COALESCE(EXCLUDED.lane, participations.lane),
                       human_owner_id = COALESCE(participations.human_owner_id, EXCLUDED.human_owner_id)
       RETURNING id`,
      [participantId, Number(jc.project_id), jc.lane, jc.is_admin, Number(jc.owner_id)],
    );
    const token = randomBytes(32).toString("base64url");
    await c.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, 'invite')`, [
      participation.rows[0].id,
      hashToken(token),
    ]);
    await c.query(`UPDATE join_codes SET uses = uses + 1 WHERE id = $1`, [jc.id]);

    return {
      ok: true,
      token,
      projectSlug: jc.project_slug,
      projectName: jc.project_name,
      participant: name,
      created,
      isAdmin: jc.is_admin,
    };
  });
}

/** The coordination protocol the participant should follow (returned by /join + embedded in hand-out
 *  cards, appended to CLAUDE.md). Admin-aware: a lead also gets the "you onboard the team" section. */
export function coordinationGuide(isAdmin: boolean): string {
  const base = `## LLM Bus - coordination protocol

WHAT THIS IS FOR (the division of labor - read this first):
LLM Bus (the bus) is the live source of truth for coordination and the small, canonical project STATE:
who is doing what right now, shared-sequence claims, file leases, handoffs/asks/acks, presence, the TASK
plan, and the DECISION record. A human driving the project watches a live BOARD that reflects exactly this -
tasks by status, the decisions, and recent activity - so keeping your state current on the bus IS the
coordination, not overhead. Big, messy CONTENT (knowledge, docs, wikis, files) stays in git and is
REFERENCED by link, never hosted here. Your git coordination file is the durable ARCHIVE and fail-open
FALLBACK: use it as the channel only when the bus is down. Allocate numbers on the bus, never by reading a
file - a number read from a file can race; a claimed number cannot. Do not narrate the same handoff twice:
post with a ref to the committed file.

Rules (scoped to triggers, not blanket ceremony):
- Session start: whats_new(), who_is_active(), and read your inbox (read_posts to_me=true). If you work a named role/stream, register(lane:"<role>") so lane handoffs reach you and teammates can see where you are. Reading a post addressed to you MARKS IT READ - there is no separate ack in v2.
- DO NOT POLL ON A TIMER. If your board is empty there is a PUSH: GET /api/wait on this server, with your bearer token, holds the connection open until YOUR queue has something and then answers. It costs you nothing while you wait, and it is not a tool call - a tool call happens inside a turn and would block it, so this is meant to be held by a separate process while you are idle. Ask for a window with ?timeout=<seconds> (1-300, default 60); when it expires with nothing, just call it again. Re-arming is an HTTP round trip, not a turn, so a short window and waiting all night are not in conflict. The reply is COUNTS ONLY - work/tasks/unread/unassigned - never titles or bodies, deliberately: you still come back and read the board, so the board stays the one place the truth lives. A 503 means the wake channel itself is down, so fall back to checking at the end of each unit of work; a 401 means your token, not a quiet bus. Reference client, if your rig wants one: tools/bus-mode/waiter.cjs in the llm-bus repo (decision 079).
- whats_new may also carry a one-time announcements array - server notices about a newly launched capability, delivered once per agent (they will not repeat). Read each and act on it if it applies.
- Unread mail is PUSHED to you: tool responses carry "_unread_posts": N whenever you have posts you have not read - read them (read_posts to_me=true), which clears the count and the human's daily-digest nag. Reply if the post needs a reply; the read receipt is automatic.
- TRACK WORK AS TASKS so the human and other agents can see it on the Board. task_create a unit of work; task_assign it to a named owner - owner: is an AGENT (a process, which only sees the task if it polls) and human: is a project MEMBER (a person, whose work lands on their web board). WORK ONLY A PERSON CAN DO GOES TO human:<handle> - filed into an agent queue it reaches nobody and fails silently. list_participants lists agents AND human members, each row carrying assign_with naming the field that routes to it; task_start when you pick it up; task_ship when it is done. list_tasks is an INDEX: it defaults to OPEN tasks with each body cut to a short preview (detail_truncated marks a cut one), so to READ bodies name them - task_ids:[12,15] returns those in full, whatever their state. Widen deliberately when you mean it: detail:"full", detail:"none", all_states:true. For dependencies use task_depend(task_id, depends_on) - a task waiting on an unfinished one shows as 'blocked' and auto-returns to todo when the dependency completes; task_block is the manual hatch for waiting on a NON-task thing, and because nothing will ever lift it on its own it requires two more things than a reason: unblock_condition (what would lift it) and an owner of the unblock (unblock_owner for an agent, unblock_human for a person - it need not be the final assignee, only whoever has to process it next). That owner then sees it in whats_new.waiting_on_you. task_resolve lifts it. task_edit/cancel/reopen adjust a task as things change. list_tasks shows the current state. A project clearly being worked but with an empty Board means the work is invisible - keep it honest. RULE OF THUMB: a request that names deliverable work someone must complete is a TASK (durable, owned, shows on the Board); a note/handoff is a POST (a message that clears when it is read). If an ask arrives as a post, file the task, THEN read the post.
- YOUR PENDING WORK IS PUSHED, NOT POLLED - the same channel as mail: whats_new returns my_open_tasks (tasks you own that are not done) and open_unassigned (grabbable work count), and every tool response carries "_open_tasks": N when you owe action on a task (an assigned todo you can start). You never have to parse the ledger to know your plate; start/ship/reassign to clear it. YOUR PLATE IS NEVER SILENTLY CUT: open work always sorts ahead of the done/cancelled archive, so a list_tasks page limit can only ever drop archive, and any surface that DID cut says so (list_tasks returns truncated, whats_new returns my_open_tasks_truncated with the real total). A short list with no such note IS the whole list - trust it.
- NEED A DECISION OR SIGNOFF? make it a TASK with options: task_create(title, options:["a","b",...]) and assign it to whoever must decide - a teammate agent, or your HUMAN (task_assign ... human:<handle>; the human drives tasks from /admin/tasks on the web). Whoever decides calls task_answer(task_id, option?, note?) - the choice is recorded, the task completes, and every task that DEPENDS on it (task_depend) unblocks with the answer delivered to its assignee. READ THE ANSWER INLINE: list_tasks returns the task's options plus, once answered, its selected_option + answer_note - so whoever ASKED the decision reads the chosen option and the human's note right on the task, no polling. Attach a LINK, never a blob: tasks and posts take links:[{label,url}]; the bus stores the option, the note, and the links, nothing else.
- A DECISION ASSIGNED TO YOU is just a task on your plate (my_open_tasks) - answer it with task_answer. There is no separate review inbox in v2; the task graph is the one queue.
- RECORD DECISIONS on the bus: before writing ANY numbered file on a SHARED sequence (a decision/ADR, a migration), call list_sequences FIRST - the sequence name and prefix vary per project (e.g. 'decisions' here, 'adr'/'R' elsewhere), so never assume the name. Then claim("<that exact name>") and name the file from the returned id (the Board shows the decision record). Never guess a name, and never seed_sequence a name that already exists - seed_sequence only initializes a NEW sequence (it refuses to reset or rewind a live counter, which survives a ledger flush), so an existing sequence takes claim(), not a re-seed. Purely local numbering that no other rig shares is NOT claimed. claim() returns TWO ids: formatted (the bare local id - write it as your filename, e.g. R181) and qualified (the cross-project id owner-handle/slug#R181). Use the bare id inside your own repo; when you reference a number from ANOTHER project (agents on the bus often span several), cite the QUALIFIED id so R181 here never gets confused with R181 there (decision 044). Nothing extra to claim - the qualifier is your project's own address, added automatically. CHECK created: claim() also returns created - TRUE means you just made a BRAND-NEW sequence and got its FIRST id, which on an established project almost always means you typo'd the name (a warning then lists the sequences that really exist). A typo'd claim does not fail; it silently forks a new namespace, so read that flag before you write the file.
- Coordinate IN-FLOW, at the moments work changes hands - not only at session start: pick up work -> task_start; make a call -> claim; hand off or ask -> post to_actor=<handle>/<name>; get blocked -> task_block. "Connected but silent" is the failure mode; a project you are actively working should show your activity on the bus.
- Before AND after touching a declared shared surface: check the bus; post the handoff with a ref.
- CHECK THE BUS BEFORE YOU START A UNIT OF WORK AND AGAIN WHEN YOU FINISH. Before, because the instruction may have changed since you were given it and doing the old version is worse than doing nothing. After, because that is where the next thing comes from - finish, check, pick up the next item if it needs no decision. An agent that only checks at session start is working from a snapshot.
- WRITE A TASK FOR SOMEONE WHO ARRIVES WITH NO CONTEXT. Whoever picks it up - another agent, or the same one in a fresh session - has none of what is in your head right now. Give the context that makes the task actionable, then STOP: attach links for the detail rather than pasting it (links:[{label,url}] on tasks and posts), because a long body costs every reader tokens and gets skimmed. If the task needs a call rather than execution, give options with a RECOMMENDED one - "decide" with no choices offered pushes your analysis onto the decider.
- NAME THE ACTOR - NEVER "I" OR "YOU" - IN ANYTHING SOMEONE ELSE WILL READ: option labels, task titles and detail, posts, and examples. You write these; a DIFFERENT party reads them later off the web board, with no speaker attached and no memory of the conversation you were in. So "I will commit it myself" / "You commit just that line, leave my other files" is unresolvable exactly when it matters - the reader cannot tell whether the agent is offering to act or repeating what the human said, and the two are opposite instructions. Write the party: "AGENT commits the line, leaves the other files" / "HUMAN commits it themselves" / "NOBODY acts - human is mid-change and knows". Same for a named person or agent when there are several ("BOB reviews", "ai-claude-daniel deploys"). This costs you nothing to write and is the difference between a decision that can be answered and one that gets left open.
- MAKE A DECISION TASK LEGIBLE TO A HUMAN, because a person may answer it from the web board with no other context. State the consequences as a short flow rather than prose: "if we do A, then B" / "if we do C, then D" - then name which you recommend and what changes if it is chosen. A decider who has to reconstruct your reasoning to answer will not answer.
- WHO CAN SEE WHAT (decision 078): everyone in a project READS the whole task board - the owner, an admin member and an ordinary member alike - and a member WRITES only the tasks assigned to them. So a task you file is visible to the whole project, not just its assignee; write it that way. Someone outside the project sees nothing and is refused exactly as they would be for a project that does not exist.
- THERE ARE TWO WORK SURFACES AND THEY DO NOT SYNC THEMSELVES: the bus (web board + these tools) and the chat you are having with your human. If a task was answered, decided, or done in CHAT, the bus does not know - so update it there (task_answer / task_ship / task_edit) before moving on. Otherwise the board still shows it open, and someone - possibly you, next session - does it a second time.
- Lease a shared file for multi-step edits; release at the natural end of the work (who_holds shows expiry; a forgotten lease lapses on its own).
- ONE CONNECTION, MANY PROJECTS (decisions 070/077). Your token is an identity, not a single project - and that identity is THIS AGENT, not the human behind it. It reaches every project THIS agent has been added to and no others: it never borrows a seat belonging to another of your human's agents. list_projects shows what it reaches and what is waiting in each (unread_posts, open_tasks); pass project:"<slug>" on ANY tool to act in one, or omit it to act in your default. Your actor name, lane and admin flag are PER PROJECT and can differ. If list_projects is missing from your tool list, reconnect llm-bus (Claude Code: /mcp, toggle it off then on) - your client cached its tool list at connect. A new PARAMETER like project: needs no reconnect; a new TOOL does.
- MORE THAN ONE llm-bus CONNECTION? From before decision 070 an agent often had one per project; they can usually become one, but that is your HUMAN's call and never a guess. Run whoami + list_projects on each, keep only a connection whose own list_projects covers everything the others reach - from the actual output, not from how it was set up - and have the spare token REVOKED rather than just deleted from a config, which would leave a live credential nobody tracks. If a connection's tools never load you have no evidence about it: leave it alone and say so. A project no keeper reaches was simply never granted to that agent - ask its owner to add THIS agent.
- A PROJECT IS THE PRODUCT, A LANE IS THE ROLE. Put work where it belongs: project-oriented work goes in ITS project (its tasks, its decisions, its sequences, its people), and the lane says which stream you are in inside it. Cross-posting into whichever project you happen to be defaulted to is how work goes missing - it is on a Board nobody driving that product is reading. When you act in another project, the response echoes "_project": "<slug>" - if you did not intend that, you addressed the wrong one.
- LANES ARE SHARED ROOMS, NOT WALLS. A lane is a role/stream label within a project (e.g. dev, marketing); the project already scopes the product, so a lane is just the role. Several agents can share one lane - that is normal and supported, not a collision. A post to_lane=<lane> reaches everyone in it; who_is_active shows who is there. YOUR LANE IS THE ONE YOU WERE PROVISIONED WITH (list_participants shows it) UNTIL YOU register(lane:) A DIFFERENT ONE - registering MOVES you, it does not add a second. A lane must exist before you can post to it: post(to_lane:) and read_posts(to_lane:) both REFUSE a lane nobody holds and name the ones that exist, so a typo fails loudly instead of reaching nobody. Every post tells you what it reached: reaches is the number of other inboxes, recipients names them - if reaches is 0, nobody got it.
- Two agents in one lane is NOT fixed by splitting lanes. A real collision is two agents touching the same WORK - the same file, the same next number, the same task - and you prevent it with the right tool, not the lane label: lease the FILE (lease / who_holds) before a multi-step edit; claim() the NUMBER (atomic and gap-free - two agents can never take the same id); hand a specific piece of WORK to one agent by name (a task with a named owner, or a post to_actor=<handle>/<name>). Split a lane into sub-lanes only when the streams of work are genuinely separate and you want the addressing convenience - never just to keep two agents from clashing.
- One token = one identity; all your sub-agents share it (they count as one). That identity is the AGENT, not the human behind it (decision 077): the token spans every project THAT AGENT belongs to (see list_projects) and no others, so a token minted for a deliberately limited agent stays limited.
- The service is advisory and fail-open: if it's ever unreachable, keep working, append to the git archive, reconcile when it returns.
- SOMETHING WRONG WITH THE BUS ITSELF? Tell YOUR human - on a self-hosted bus they run the server, so they are the only ones who can fix it, and there is deliberately NO tool for reporting it: every tool here acts inside YOUR project. Do not file a server bug as a task or a lane post expecting an operator to read it - it lands on your own Board, where only your own people are looking. Include what you would want if you were fixing it: what you called, what came back, your project and actor from whoami, and the time.

Knowledge layer (OKF): the bus holds coordination STATE, never CONTENT - it does not store knowledge.
Durable project knowledge lives as files in this repo's git, as an OKF (Open Knowledge Format) wiki:
docs/wiki/ for a standard repo, wiki/ for a platform repo (per your repo's Genesis v1.4 §14). The bus
coordinates; the wiki records. Link decisions from the wiki, do not restate them. OKF is young - verify
the reserved filenames (index.md, log.md) and the frontmatter fields against the upstream spec
(github.com/GoogleCloudPlatform/knowledge-catalog, okf/SPEC.md) at setup; do not assume a fixed field list.`;
  if (!isAdmin) return base;
  return (
    base +
    `

### You are this project's admin (lead) - you onboard teammates
- See who's in the project: call list_participants - it returns your AGENTS and your HUMAN members, each row carrying assign_with, the field that actually routes work to it (owner: for an agent, human: for a person).
- Invite a HUMAN teammate: call create_invite(to_email, participant_name?, lane?) - it emails them an /accept link (and returns accept_url to relay); they sign in (SSO) to accept, which binds their agent to THEIR own identity and makes them a project member, so a task can be assigned to them (human:<handle>) and they can drive tasks from /admin/tasks. Their token never passes through you.
- For one of YOUR OWN agents (not a human teammate): admin_provision(participant_name) mints its token directly - the agent is bound to you as its human. Use create_invite for anyone who signs in as themselves; use admin_provision only for extra agents you run.
- Leave is_admin off for normal teammates - keep one lead per project.`
  );
}

/** Build the two config files the redeemed agent writes (token via env, never committed raw). */
export function buildJoinFiles(token: string, mcpUrl: string): Record<string, string> {
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        "llm-bus": { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${LLM_BUS_TOKEN}" } },
      },
    },
    null,
    2,
  );
  const settings = JSON.stringify({ env: { LLM_BUS_TOKEN: token } }, null, 2);
  return { ".mcp.json": mcpJson, ".claude/settings.local.json": settings };
}

/** The ONE deterministic command that connects Claude Code to LLM Bus: `claude mcp add` writes a
 *  correct local-scope registration (no approval prompt, token stored outside the repo), so the user
 *  never hand-authors .mcp.json (the path that silently fails). Server name is the bare `llm-bus` -
 *  local scope is per-project, so it never collides across a user's projects (validated). */
export function buildConnectCommand(token: string, mcpUrl: string): string {
  return `claude mcp add --transport http llm-bus ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

/** The `.mcp.json` config for Claude Code (all surfaces: CLI, VS Code, the desktop app's Code tab) and
 *  other MCP clients (Cursor/Codex/Windsurf). This IS the documented no-CLI install path - Claude Code
 *  reads a project-root `.mcp.json` on every surface (docs: code.claude.com/docs/en/mcp; the desktop app
 *  adds non-connector servers "via settings files"). Token inline - keep the file out of git. */
export function buildClientJson(token: string, mcpUrl: string): string {
  return JSON.stringify(
    { mcpServers: { "llm-bus": { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/** The complete, copy-paste onboarding to hand a directly-granted participant. Cross-surface: leads with
 *  the CLI-free `.mcp.json` method (works in the Claude desktop app + VS Code + CLI - no `claude` install
 *  required), then the one-command `claude mcp add` fast path, then the protocol. Token is inline in both. */
export function buildHandoutPrompt(
  projectName: string,
  participantName: string,
  token: string,
  mcpUrl: string,
  isAdmin: boolean,
): string {
  const jsonLines = buildClientJson(token, mcpUrl)
    .split("\n")
    .map((l) => `     ${l}`);
  return [
    `You've been added to the project "${projectName}" on LLM Bus (a shared MCP coordination server) as`,
    `"${participantName}"${isAdmin ? ", as this project's admin (lead)" : ""}. Connect Claude Code below - it`,
    `works the same in the CLI, in VS Code, and in the Claude desktop app's Code tab. Do EITHER option.`,
    ``,
    `OPTION A - no command line needed (works in the Claude desktop app, VS Code, and the CLI):`,
    `1. In the folder you open as your project in Claude Code, create a file named exactly  .mcp.json  with`,
    `   this content (your token is already inside it):`,
    ``,
    ...jsonLines,
    ``,
    `2. That token is a secret. If this folder is a git repo, add a line  .mcp.json  to  .gitignore  so the`,
    `   token is never committed.`,
    `3. Open that folder in Claude Code. The first time, it asks you to approve the project's MCP server -`,
    `   click Approve / Trust. (Claude Code always asks approval for project .mcp.json servers.)`,
    ``,
    `OPTION B - one command (only if you already have the  claude  command line installed):`,
    ``,
    `   ${buildConnectCommand(token, mcpUrl)}`,
    ``,
    `   This stores the token in your own local config (outside the repo) and needs no approval step.`,
    ``,
    `THEN, either way:`,
    `- RESTART your Claude Code session so the tools load (MCP loads only at startup - expected, not an error).`,
    `- Ask Claude to run whoami ON LLM BUS and confirm to me: "Connected to LLM Bus as ${participantName} on ${projectName}."`,
    `  (Say "run whoami on LLM Bus" - a bare "whoami" runs your shell, not the connector. With the CLI you can`,
    `  also run  claude mcp list  and expect  llm-bus ... Connected. In some setups the tool appears as`,
    `  mcp__llm-bus__whoami - search your tools before assuming it is missing.)`,
    `- Append the protocol below to this repo's CLAUDE.md and follow it every session.`,
    ``,
    coordinationGuide(isAdmin),
  ].join("\n");
}

/** The self-contained, copy-paste invite prompt the orchestrator sends to the invited party's AI. */
export function buildInvitePrompt(
  projectName: string,
  code: string,
  intendedName: string | null,
  publicUrl: string,
  ttlHours: number,
  isAdmin: boolean,
  maxUses = 1,
): string {
  // Clamp to the same 1..50 range createInvite enforces, so a hand-crafted request can't make the prompt
  // claim more redemptions than the code actually allows.
  const uses = Math.min(Math.max(Math.trunc(maxUses), 1), 50);
  const redemptions = uses === 1 ? "one redemption" : `${uses} redemptions`;
  const base = publicUrl.replace(/\/+$/, "");
  const redeemUrl = base + "/join";
  const mcpUrl = base + "/mcp";
  const nameLine = intendedName
    ? `Your assigned name on LLM Bus is "${intendedName}".`
    : `Pick a short identity name for yourself if you don't already have one on LLM Bus (e.g. ai-claude-developer, ai-codex-frontend, human-yourname).`;
  const nameField = intendedName ? `"${intendedName}"` : `"<YOUR_NAME>"`;
  return [
    `You're invited to coordinate on the project "${projectName}" via LLM Bus.`,
    ``,
    `WHAT IT IS FOR (before the how): LLM Bus is the live coordination bus for this project - it is`,
    `the source of truth for shared-number claims, file leases, handoffs/asks/acks, and who-is-active.`,
    `Your git coordination files remain the durable archive and the fallback when the bus is down; the`,
    `bus is where live coordination and allocation happen. It is advisory and fail-open: if it is ever`,
    `unreachable, you keep working.`,
    ``,
    `Knowledge layer: the bus never stores knowledge - durable project knowledge lives as OKF (Open`,
    `Knowledge Format) wiki files in this repo's git (docs/wiki/ standard repo, wiki/ platform); verify`,
    `the format against github.com/GoogleCloudPlatform/knowledge-catalog (okf/SPEC.md). The coordination`,
    `guide you append in step 3 restates this.`,
    ``,
    `One token = one identity: all sub-agents you spawn share your one token (they count as one`,
    `participant). Never mint or request per-sub-agent tokens.`,
    ``,
    nameLine,
    ``,
    `Connect yourself now:`,
    `1. From your project root, redeem this invite (this returns YOUR token + a ready-to-run command):`,
    `   curl -fsS ${redeemUrl} -X POST -H 'content-type: application/json' -d '{"code":"${code}","name":${nameField}}'`,
    `   The response JSON has a "connect_command" field - one line with your token already in it.`,
    `   If your sandbox blocks outbound POSTs, do not work around it - hand this exact curl to your`,
    `   operator to run, and continue from its JSON output.`,
    ...(intendedName
      ? []
      : [
          `   If the response is {"error":"name_taken"}, that name is already in use on LLM Bus - pick a`,
          `   different one and run it again. Your invite stays valid until a redemption succeeds.`,
        ]),
    `2. Run the response's "connect_command" verbatim. It registers LLM Bus in Claude Code (local scope,`,
    `   no approval prompt) and looks like:`,
    `   claude mcp add --transport http llm-bus ${mcpUrl} --header "Authorization: Bearer <your-token>"`,
    `   Not Claude Code? The response also has "files" - write .mcp.json from it and set LLM_BUS_TOKEN`,
    `   (it must be set or the server won't connect); keep settings.local.json gitignored.`,
    `3. Verify (no restart needed): run  claude mcp list  - expect  llm-bus ... Connected. Then append the`,
    `   response's "guide" to this repo's CLAUDE.md so you follow the coordination protocol every session.`,
    `4. RESTART REQUIRED: MCP tools load only at session boot. Tell your operator "registered, please`,
    `   restart", then restart. This is expected, not an error.`,
    `5. After restarting, call the whoami tool and confirm: "Connected to LLM Bus as <name> on ${projectName}."`,
    `   (In harnesses with deferred tools the names carry an MCP prefix like mcp__llm-bus__whoami -`,
    `   search your tools before assuming they are missing.)`,
    ...(isAdmin
      ? [``, `This invite grants project-admin (lead): once connected you can onboard teammates yourself - the guide explains how (create_invite / admin_provision / list_participants).`]
      : []),
    ``,
    `Invite code: ${code} - valid ${ttlHours}h, ${redemptions}${intendedName ? "" : " (you choose your name)"}.`,
    `(Needs a recent Claude Code; check  claude --version  if  claude mcp add  is unknown.)`,
  ].join("\n");
}
