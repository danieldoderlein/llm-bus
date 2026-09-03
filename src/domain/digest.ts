import type pg from "pg";
import type { Ctx } from "../context.js";
import { query } from "../db.js";
import type { LedgerEvent } from "./query.js";
import { EFFECTIVE_STATUS_SQL } from "./task.js";
import { LANE_FALLBACK_FROM, laneDeliverySql } from "./post.js";
import { formatId, qualifyId } from "./claim.js";
import { ANNOUNCEMENTS, type Announcement } from "../announcements.js";

// One-time orientation returned by whats_new on a participation's FIRST check-in (see whatsNew).
// Mirrors the coordination protocol so a freshly-connected agent is oriented before it has read the
// repo's CLAUDE.md. Keep in sync with coordinationGuide() in invite.ts and the kit/ CLAUDE blocks.
const WELCOME =
  "Welcome to LLM Bus. It is the live source of truth for coordinating agents and the small project STATE " +
  "a human watches on a BOARD: tasks by status, the decision record, and activity. Start each session with " +
  "whats_new + who_is_active + read_posts(to_me=true) - reading a message addressed to you MARKS IT READ " +
  "(there is no separate ack). TRACK your work as tasks (task_create/assign/start/ship, plus edit/cancel/" +
  "reopen and depend for dependencies) and RECORD decisions (list_sequences, then claim the decision/ADR " +
  "sequence it names) so the Board reflects reality - connected-but-silent is the failure mode. Your pending " +
  "work is PUSHED, not polled: whats_new lists your open tasks (my_open_tasks) and grabbable work " +
  "(open_unassigned), and every tool response carries _open_tasks when you owe action - so keep the Board " +
  "honest and there is nothing to parse. When you need a DECISION or SIGNOFF, make it a TASK: create one with " +
  "options (task_create ... options:[...]) and assign it to whoever must decide - a teammate agent, or a HUMAN " +
  "(assign human:<handle>; the human drives tasks from /admin/tasks on the web). Whoever answers picks an " +
  "option with task_answer(task_id, option?, note?); every task that DEPENDS on it then unblocks, and the " +
  "answer is delivered to each dependent's assignee. Attach a LINK not a blob (tasks and posts take links:" +
  "[{label,url}] - attach links rather than pasting detail, and give a decision task OPTIONS with a " +
  "recommended one). Write every task for someone arriving with NO context, and state a decision's " +
  "consequences as a short flow (\"if we do A, then B\") so a human can answer it from the board. Check the " +
  "bus before you start a unit of work and again when you finish - the instruction may have changed, and " +
  "the next thing comes from that check. TWO WORK SURFACES, and they do not sync: if a task was answered or " +
  "done in CHAT, update it here too or someone does it twice. A LANE IS A SHARED ROOM, NOT A WALL: several agents share one lane normally; prevent " +
  "clashes over the same WORK with the right tool - lease a FILE, claim() a NUMBER (atomic, gap-free), or give " +
  "a task to one named owner. Your lane is the one you were provisioned with until you register(lane:) a " +
  "different one, which MOVES you; a lane must exist before you can post to it, and every post reports how " +
  "many other inboxes it reaches. Big knowledge/content stays in git (referenced, not hosted here). The bus is " +
  "advisory and fail-open. Call guide() any time for the full protocol, and append it to this repo's CLAUDE.md.";

export interface SequenceDigest {
  sequence: string;
  number: number;
  formatted: string;
  /** The auto-qualified cross-project id `<ownerHandle>/<slug>#<formatted>` (decision 044). */
  qualified: string;
  /** Who/when of the most recent claim EVENT, or null when the ledger was flushed (the counter survives). */
  by: string | null;
  at: string | null;
}

/**
 * The latest number per sequence in this project, read from the AUTHORITATIVE counter (the `sequences`
 * table) - not reconstructed from the `events` ledger.
 *
 * WHY the source matters (decision 040, project-b-platform field report): a ledger flush (decision 039)
 * empties `events` but PRESERVES `sequences`. An event-derived view therefore reported `{}` for a fully
 * populated registry - a FALSE "your sequences are gone" signal that nearly drove a reconnecting agent to
 * seed_sequence over 75 live decision numbers (a silent, unrewindable collision). Reading the counter
 * directly makes latest_claims agree with list_sequences and survive any flush; the newest claim event
 * only DECORATES each row with who/when (null after a flush), never gates whether the row appears.
 */
export async function latestClaims(ctx: Ctx): Promise<{ sequences: SequenceDigest[] }> {
  const res = await query<{
    sequence: string;
    number: string;
    prefix: string;
    pad: number;
    by: string | null;
    at: string | null;
  }>(
    `SELECT s.name AS sequence, s.current AS number, s.prefix, s.pad, e.by, e.at
       FROM sequences s
       LEFT JOIN LATERAL (
         SELECT actor_name AS by, ts AS at
           FROM events
          WHERE project_id = s.project_id AND type = 'claim' AND payload->>'sequence' = s.name
          ORDER BY id DESC
          LIMIT 1
       ) e ON true
      WHERE s.project_id = $1
      ORDER BY s.name`,
    [ctx.project.id],
  );

  return {
    sequences: res.rows.map((r) => {
      const number = Number(r.number);
      const formatted = formatId(r.prefix, Number(r.pad), number);
      return {
        sequence: r.sequence,
        number,
        formatted,
        qualified: qualifyId(ctx.project.ownerHandle, ctx.project.slug, formatted),
        by: r.by,
        at: r.at,
      };
    }),
  };
}

/**
 * The session digest for the calling participation: everything appended since its cursor,
 * plus the small counts an agent needs to orient (mail addressed to it but unread, active
 * leases, and the latest claim per sequence). Advances the cursor to the newest event seen
 * unless `advance_cursor === false`. Takes a client so the read + cursor advance commit
 * atomically with the caller's transaction.
 */
export interface OpenTaskDigest {
  task_id: number;
  title: string;
  status: string;
  blockers: number;
}

/** A manual block whose UNBLOCK you own (decision 074). Someone else's task is stopped until you act, so
 *  this is separate from my_open_tasks - it is not your work, it is your turn. */
export interface WaitingOnYou {
  task_id: number;
  title: string;
  /** What the blocker said would lift it. Null only on a block recorded before 074 required one. */
  lifts_when: string | null;
}

export interface ActivePeer {
  actor: string;
  lane: string;
  seen_ago_seconds: number;
}

export async function whatsNew(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { advance_cursor?: boolean; limit?: number } = {},
): Promise<{
  since_event_id: number;
  events: LedgerEvent[];
  unread_posts: number;
  active_leases: number;
  my_open_tasks: OpenTaskDigest[];
  my_open_tasks_truncated?: string; // only when the cap actually cut the plate (decision 062)
  waiting_on_you?: WaitingOnYou[]; // decision 074; omitted entirely when nothing waits on you
  waiting_on_you_truncated?: string; // only when the cap actually cut it - guide() promises no silent cut
  open_unassigned: number;
  active_participants: number;
  active_peers: ActivePeer[];
  latest_claims: Record<string, string>;
  welcome?: string;
  announcements?: Announcement[];
}> {
  const limit = opts.limit ?? 100;
  // Page size for the pushed plate. Kept modest on purpose - the digest is a glance, not the board - which is
  // exactly why it has to report when it cut (decision 062).
  const MY_OPEN_TASKS_CAP = 20;
const WAITING_ON_YOU_CAP = 20; // decision 074, capped like the plate above - and it SAYS so when it cuts

  // Read the participation's cursor (the last event id it has already digested), default 0.
  const cursorRes = await client.query<{ last_event_id: string }>(
    `SELECT last_event_id FROM actor_cursors WHERE participation_id = $1`,
    [ctx.participation.id],
  );
  // No cursor row => this participation has never digested: its FIRST check-in. Used to attach a
  // one-time orientation `welcome` so a freshly-connected agent learns how to work here even before
  // it reads the repo's CLAUDE.md. Made exactly-once below by creating the cursor even on an empty
  // first call (unless the caller suppressed advancement).
  const firstCheckIn = cursorRes.rows.length === 0;
  const cursor = cursorRes.rows.length ? Number(cursorRes.rows[0].last_event_id) : 0;

  // Events appended after the cursor, oldest-first so the cursor advances monotonically.
  const evRes = await client.query<{
    id: string;
    ts: string;
    actor: string;
    type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, ts, actor_name AS actor, type, payload
       FROM events
      WHERE project_id = $1
        AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [ctx.project.id, cursor, limit],
  );
  const events: LedgerEvent[] = evRes.rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
  }));

  // Posts in this project addressed to the caller (directly, or via its live-then-provisioned lane -
  // decision 065) that the caller has not yet READ (decision 039 - reading writes post_reads, retiring ack).
  const unreadRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM posts p
      WHERE p.project_id = $1
        AND (p.to_participation_id = $2 OR ${laneDeliverySql("$2", "$3")})
        -- Your own post is not mail to you (decision 062). unreadCount has carried this since 062; this
        -- copy never did, which was dormant only because no lane resolved. 065 makes lanes resolve, so
        -- without it whats_new.unread_posts would count an agent's own broadcasts and disagree with
        -- _unread_posts on the same call.
        AND p.from_participation_id IS DISTINCT FROM $2
        AND NOT EXISTS (
          SELECT 1 FROM post_reads pr
           WHERE pr.post_id = p.id AND pr.participation_id = $2
        )`,
    [ctx.project.id, ctx.participation.id, LANE_FALLBACK_FROM],
  );
  const unread_posts = Number(unreadRes.rows[0].count);

  // Active (unreleased, unexpired) leases in this project.
  const leaseRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leases
      WHERE project_id = $1
        AND released_at IS NULL
        AND expires_at > now()`,
    [ctx.project.id],
  );
  const active_leases = Number(leaseRes.rows[0].count);

  // Your plate: tasks you own that are not yet done, newest first, reported with their EFFECTIVE status
  // (blocked derived via the shared EFFECTIVE_STATUS_SQL, so my_open_tasks agrees with list_tasks and the
  // board - decision 039 §1) plus the open MANUAL-blocker count. This is the pushed answer to "what's on
  // me?" - the Board's content surfaced at session start so an agent never has to poll list_tasks (or parse
  // the ledger). Owner match is by participation, not name, so it is exact even across re-handles.
  // The list is capped, so it also reports its own TRUE size (decision 062): count(*) OVER () is evaluated
  // before LIMIT, so the total costs nothing extra and cannot drift from the rows beside it. A plate that
  // silently stops at 20 is indistinguishable from a plate that IS 20 - and this is the channel an agent is
  // told to trust INSTEAD of polling, so under-reporting here is work quietly falling off the world.
  const myTasksRes = await client.query<{
    task_id: string;
    title: string;
    status: string;
    blockers: string;
    total: string;
  }>(
    `SELECT t.id AS task_id, t.title, (${EFFECTIVE_STATUS_SQL}) AS status,
            count(b.task_id)::text AS blockers,
            count(*) OVER ()::text AS total
       FROM tasks t
       LEFT JOIN task_blockers b ON b.task_id = t.id AND b.resolved_at IS NULL
      WHERE t.project_id = $1
        AND t.owner_participation_id = $2
        AND t.status NOT IN ('done', 'cancelled')
      GROUP BY t.id
      ORDER BY t.id DESC
      LIMIT ${MY_OPEN_TASKS_CAP}`,
    [ctx.project.id, ctx.participation.id],
  );
  const my_open_tasks: OpenTaskDigest[] = myTasksRes.rows.map((r) => ({
    task_id: Number(r.task_id),
    title: r.title,
    status: r.status,
    blockers: Number(r.blockers),
  }));
  const my_open_tasks_total = myTasksRes.rows.length ? Number(myTasksRes.rows[0].total) : 0;

  // Decision 074: blocks whose UNBLOCK you own. This is the half that makes naming an owner mean anything -
  // without it the name sits on a task detail page that only someone already looking at that task will ever
  // open, which is the same dead end 074 exists to close. These are deliberately NOT folded into
  // my_open_tasks: the task is somebody else's work, and yours is the one thing standing in front of it.
  const waitingRes = await client.query<{ task_id: string; title: string; unblock_condition: string | null; total: string }>(
    // TERMINAL TASKS ARE EXCLUDED, and that exclusion is load-bearing. A blocker row is not resolved when
    // its task is shipped or cancelled - prod carries exactly that shape today (llm-bus task 384: cancelled
    // on 2026-08-13, its manual block still open) - so without this clause a block on a task that later
    // goes terminal would sit on its owner's plate forever, and no amount of doing the work could clear it.
    // A queue you cannot empty is the failure 074 exists to prevent, not one to reproduce in its own fix.
    `SELECT b.task_id, t.title, b.unblock_condition,
            count(*) OVER ()::text AS total
       FROM task_blockers b JOIN tasks t ON t.id = b.task_id
      WHERE t.project_id = $1 AND b.resolved_at IS NULL
        AND t.status NOT IN ('done','cancelled')
        AND (b.unblock_participation_id = $2 OR ($3::bigint IS NOT NULL AND b.unblock_owner_id = $3))
      ORDER BY b.created_at
      LIMIT ${WAITING_ON_YOU_CAP}`,
    [ctx.project.id, ctx.participation.id, ctx.participation.humanOwnerId],
  );
  const waiting_on_you: WaitingOnYou[] = waitingRes.rows.map((r) => ({
    task_id: Number(r.task_id),
    title: r.title,
    lifts_when: r.unblock_condition,
  }));
  const waiting_on_you_total = waitingRes.rows.length ? Number(waitingRes.rows[0].total) : 0;

  // Grabbable work: unassigned todo tasks in this project (decision 039: no owner, no human assignee). A
  // non-zero count on an otherwise-quiet Board tells an agent there is work to pick up (task_start grabs it).
  const openRes = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM tasks
      WHERE project_id = $1
        AND status = 'todo'
        AND owner_participation_id IS NULL
        AND assignee_owner_id IS NULL`,
    [ctx.project.id],
  );
  const open_unassigned = Number(openRes.rows[0].count);

  // Active PEERS: other participations seen on the bus within the liveness window (current-state, NOT
  // cursor-gated), so presence self-heals in the digest. Fixes task #21: `events` is consumed by the cursor
  // (a second whats_new returns events:[]), and presence was the ONE cross-agent signal with no current-state
  // mirror here - so an agent leaning on whats_new saw "nothing new" while a peer was plainly active. Excludes
  // the caller (this answers "is anyone else here?"). Mirrors whoIsActive's recency = "quiet != offline".
  const peersRes = await client.query<{ actor: string; lane: string; seen_ago_seconds: number }>(
    // actor prefers the BOUND human (participations.human_owner_id, canonical per 038/052/054) over the
    // provisioner (participants.owner_id), then the bare label - same COALESCE as whoIsActive and
    // list_participants, so active_peers agrees with who_is_active for a cross-human-provisioned agent.
    // lane is the RESOLVED lane (live, else provisioned - decision 065), so the lane shown here is the one
    // a post_to_lane would actually reach. Reporting raw presence.lane made this surface disagree with
    // delivery the moment a provisioned lane started routing.
    `SELECT COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
            COALESCE(NULLIF(p.lane, '(unset)'), pa.lane, '(unset)') AS lane,
            EXTRACT(EPOCH FROM (now() - p.last_seen))::int AS seen_ago_seconds
       FROM presence p
       JOIN participations pa ON pa.id = p.participation_id
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o ON o.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pa.human_owner_id
      WHERE p.project_id = $1
        AND p.participation_id <> $2
        AND p.last_seen >= now() - make_interval(secs => $3)
      ORDER BY p.last_seen DESC
      LIMIT 20`,
    [ctx.project.id, ctx.participation.id, ctx.project.livenessWindowSec],
  );
  const active_peers: ActivePeer[] = peersRes.rows.map((r) => ({
    actor: r.actor,
    lane: r.lane,
    seen_ago_seconds: Number(r.seen_ago_seconds),
  }));
  const active_participants = active_peers.length;

  // Latest claim per sequence, flattened to sequence -> formatted.
  const { sequences } = await latestClaims(ctx);
  const latest_claims: Record<string, string> = {};
  for (const s of sequences) latest_claims[s.sequence] = s.formatted;

  // Advance the cursor to the newest event just returned (unless explicitly suppressed). On a first
  // check-in with no new events we still create the cursor row (at the current cursor, 0) so the
  // one-time `welcome` does not repeat next call.
  if (opts.advance_cursor !== false && (events.length > 0 || firstCheckIn)) {
    const maxId = events.length > 0 ? events[events.length - 1].id : cursor;
    await client.query(
      `INSERT INTO actor_cursors (participation_id, project_id, last_event_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (participation_id)
       DO UPDATE SET last_event_id = EXCLUDED.last_event_id, updated_at = now()`,
      [ctx.participation.id, ctx.project.id, maxId],
    );
  }

  // One-time platform announcements (decision 035). Server-authored notices (src/announcements.ts)
  // delivered to each participation exactly once: unseen = those with id greater than this
  // participation's announced_through marker. The marker is keyed by the token-derived
  // ctx.participation.id, never by input (invariant 1), and only ever compared against a
  // server-authored constant list. Consumed (marker advanced) ONLY on an advancing call, so a peek
  // (advance_cursor:false) surfaces pending announcements without burning delivery - the exact twin of
  // the one-time `welcome` above. Advanced in the caller's transaction so it commits atomically with
  // the event cursor.
  //
  // BEST-EFFORT / fail-open: whats_new is the most-called tool, so this block must NEVER fail the call.
  // A plain try/catch is not enough inside a transaction - a failing statement (e.g. a pre-migration
  // missing column) poisons the whole tx, so every later statement would error too. A SAVEPOINT scopes
  // the failure: on error we ROLLBACK TO it (un-poisoning the caller's tx) and return the real
  // whats_new payload with no announcements. This is the tx-safe analogue of the nudge/count .catch
  // swallowing in mcp.ts.
  let announcements: Announcement[] = [];
  try {
    await client.query("SAVEPOINT announcements");
    const markerRes = await client.query<{ announced_through: string }>(
      `SELECT announced_through FROM participations WHERE id = $1`,
      [ctx.participation.id],
    );
    const through = markerRes.rows.length ? Number(markerRes.rows[0].announced_through) : 0;
    const unseen = ANNOUNCEMENTS.filter((a) => a.id > through);
    if (unseen.length > 0) {
      // Map to the wire shape (id + body only) so a future internal field on Announcement never leaks.
      announcements = unseen.map((a) => ({ id: a.id, body: a.body }));
      if (opts.advance_cursor !== false) {
        const maxSeen = unseen.reduce((mx, a) => Math.max(mx, a.id), through);
        await client.query(`UPDATE participations SET announced_through = $2 WHERE id = $1`, [
          ctx.participation.id,
          maxSeen,
        ]);
      }
    }
    await client.query("RELEASE SAVEPOINT announcements");
  } catch {
    // Un-poison the caller's transaction and drop announcements; the rest of whats_new is unaffected.
    try {
      await client.query("ROLLBACK TO SAVEPOINT announcements");
      await client.query("RELEASE SAVEPOINT announcements");
    } catch {
      /* the tx/connection is already gone - nothing to salvage; the outer withTx will surface it */
    }
    announcements = [];
  }

  return {
    since_event_id: cursor,
    events,
    unread_posts,
    active_leases,
    my_open_tasks,
    ...(waiting_on_you.length ? { waiting_on_you } : {}),
    ...(waiting_on_you_total > waiting_on_you.length
      ? {
          waiting_on_you_truncated: `Showing ${waiting_on_you.length} of ${waiting_on_you_total} blocks waiting on you.`
            + " Oldest first - clearing these reveals the rest; there is no wider read for this list.",
        }
      : {}),
    ...(my_open_tasks_total > my_open_tasks.length
      ? {
          my_open_tasks_truncated: `Showing ${my_open_tasks.length} of ${my_open_tasks_total} open tasks assigned to you - call list_tasks(mine=true) for the rest.`,
        }
      : {}),
    open_unassigned,
    active_participants,
    active_peers,
    latest_claims,
    ...(firstCheckIn ? { welcome: WELCOME } : {}),
    ...(announcements.length > 0 ? { announcements } : {}),
  };
}
