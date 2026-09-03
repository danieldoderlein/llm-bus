// The wake channel (decision 079): an idle agent costs nothing and starts the instant work lands.
//
// WHY THIS EXISTS. Polling cannot be both cheap and fast. A long interval stalls every agent-to-agent
// handoff; the short interval that makes handoffs feel immediate is exactly the one that burns most on
// empty checks. Worse, measured on this bus: 131 cross-agent tasks over 90 days with a p90 pickup of 35
// HOURS. And the interval silently sets task GRANULARITY - if a handoff costs ten minutes, work gets
// batched into large compound tasks to amortize it.
//
// So the bus pushes. A caller holds one HTTP request open; it returns the moment that caller's own queue
// is non-empty, or empty-handed on timeout. The waiting costs one socket and no tokens.
//
// WHAT IT DELIBERATELY DOES NOT DO: carry content. The response is a POINTER - counts only. If it carried
// titles the agent would act on the notification and skip the board, and the bus would have grown a second
// inbox competing with the task board. Reading is what the board is for.
import type pg from "pg";
import { getPool } from "../db.js";
import type { Ctx } from "../context.js";
import { LANE_FALLBACK_FROM, laneDeliverySql } from "./post.js";

/** Pointer-only: what is waiting, never what it says. */
export interface PendingWork {
  work: boolean;
  tasks: number;
  unread: number;
  unassigned: number;
}

/**
 * "Do I have work?" answered with the SAME predicates whats_new uses, deliberately - the trigger that
 * wakes us carries only a project id precisely so that this stays the single definition of work. Three
 * cheap counts; no row bodies leave the server.
 */
export async function pendingWork(client: pg.PoolClient | pg.Pool, ctx: Ctx): Promise<PendingWork> {
  const res = await client.query<{ tasks: string; unread: string; unassigned: string }>(
    `SELECT
       (SELECT count(*) FROM tasks t
         WHERE t.project_id = $1 AND t.owner_participation_id = $2
           AND t.status NOT IN ('done', 'cancelled'))::text AS tasks,
       (SELECT count(*) FROM posts p
         WHERE p.project_id = $1
           AND (p.to_participation_id = $2 OR ${laneDeliverySql("$2", "$3")})
           AND p.from_participation_id IS DISTINCT FROM $2
           AND NOT EXISTS (SELECT 1 FROM post_reads pr
                            WHERE pr.post_id = p.id AND pr.participation_id = $2))::text AS unread,
       (SELECT count(*) FROM tasks t
         WHERE t.project_id = $1 AND t.owner_participation_id IS NULL AND t.assignee_owner_id IS NULL
           AND t.status NOT IN ('done', 'cancelled'))::text AS unassigned`,
    [ctx.project.id, ctx.participation.id, LANE_FALLBACK_FROM],
  );
  const r = res.rows[0];
  const tasks = Number(r.tasks);
  const unread = Number(r.unread);
  const unassigned = Number(r.unassigned);
  return { work: tasks > 0 || unread > 0 || unassigned > 0, tasks, unread, unassigned };
}

// ── The listener ────────────────────────────────────────────────────────────────────────────────────
// ONE dedicated connection LISTENs, and every waiter is a callback in an in-process map keyed by project.
// This is not an optimization, it is the difference between working and not: LISTEN is per-connection and
// Postgres ships with max_connections around 100, so a connection per waiter dies at ~100 idle agents.

type Waiter = () => void;
const waiters = new Map<number, Set<Waiter>>();
let listener: pg.PoolClient | null = null;
let listening: Promise<void> | null = null;

/** Idempotent. Reconnects on error, because a listener that dies silently is a bus that looks quiet. */
async function ensureListening(): Promise<void> {
  if (listening) return listening;
  listening = (async () => {
    const client = await getPool().connect();
    client.on("notification", (msg) => {
      const projectId = Number(msg.payload);
      if (!Number.isFinite(projectId)) return;
      const set = waiters.get(projectId);
      if (!set) return;
      // Copy before iterating: a woken waiter removes itself.
      for (const w of [...set]) {
        try {
          w();
        } catch {
          /* one waiter's failure must not stop the others being woken */
        }
      }
    });
    client.on("error", () => {
      // Drop the handle and let the next waiter rebuild it. Every waiter also has its own timeout, so a
      // dead listener degrades to "returns empty-handed on schedule" rather than to a silent hang.
      try {
        client.release();
      } catch {
        /* already gone */
      }
      listener = null;
      listening = null;
    });
    await client.query("LISTEN bus_wake");
    listener = client;
  })();
  try {
    await listening;
  } catch {
    listening = null;
    throw new Error("wake channel unavailable");
  }
}

/**
 * Block until this caller has work, or `timeoutMs` elapses.
 *
 * THE RACE THIS IS BUILT AROUND, because getting it wrong loses work silently: an event landing between
 * "I checked and it was empty" and "I started listening" would be lost forever, and the agent would sleep
 * through work that had already arrived. So we SUBSCRIBE FIRST and check SECOND. A duplicate wake is
 * free; a missed one is invisible.
 */
export async function waitForWork(ctx: Ctx, timeoutMs: number): Promise<PendingWork & { timedOut: boolean }> {
  await ensureListening();
  const pool = getPool();
  const projectId = ctx.project.id;

  // A RE-ARMABLE wake, not a one-shot promise. The first version of this used a single promise for the
  // whole call: once resolved it stayed resolved, so a wake for somebody else's work spun the loop at
  // full speed instead of going back to sleep. `notify` is consumed on use and re-installed per round.
  let notify: (() => void) | null = null;
  const waiter: Waiter = () => {
    const n = notify;
    notify = null;
    n?.();
  };
  /** Resolves false when woken, true when the window expires. */
  const nextWake = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        notify = null;
        resolve(true);
      }, ms);
      notify = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });

  let set = waiters.get(projectId);
  if (!set) {
    set = new Set();
    waiters.set(projectId, set);
  }
  set.add(waiter);

  const cleanup = () => {
    const s = waiters.get(projectId);
    if (!s) return;
    s.delete(waiter);
    if (s.size === 0) waiters.delete(projectId);
  };

  try {
    // Check AFTER subscribing - see the race note above.
    const first = await pendingWork(pool, ctx);
    if (first.work) return { ...first, timedOut: false };

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (await nextWake(remaining)) break; // window expired
      const now = await pendingWork(pool, ctx);
      if (now.work) return { ...now, timedOut: false };
      // Woken by an event in this project that was not ours - the expected common case, since the
      // trigger is deliberately dumb. Costs one count query, then back to sleep.
    }
    return { work: false, tasks: 0, unread: 0, unassigned: 0, timedOut: true };
  } finally {
    cleanup();
  }
}

/** Test/shutdown hook: drop the shared listener so a suite can close its pool cleanly. */
export async function closeWaitChannel(): Promise<void> {
  waiters.clear();
  const c = listener;
  listener = null;
  listening = null;
  if (c) {
    try {
      await c.query("UNLISTEN bus_wake");
    } catch {
      /* connection already gone */
    }
    try {
      c.release();
    } catch {
      /* already released */
    }
  }
}
