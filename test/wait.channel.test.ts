// The wake channel (decision 079).
//
// The thing under test is a NEGATIVE most of the time - "it stayed asleep" - which is exactly the shape
// that passes for the wrong reason. So every case here pins TIMING, not just the return value: a waiter
// that woke instantly and one that slept the full window return the same object, and only the clock tells
// them apart. Each case is mutation-controlled against the specific line it guards.
import { freshProject, createParticipation } from "./_setup.js";
import { taskCreate } from "../src/domain/task.js";
import { post } from "../src/domain/post.js";
import { waitForWork, pendingWork, closeWaitChannel } from "../src/domain/wait.js";
import { withTx, closePool, getPool } from "../src/db.js";

function check(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const A = await freshProject("wait");
  const B = await createParticipation(A, "other-agent");

  // ── 1. An empty queue sleeps the whole window and says so ──────────────────────────────────────
  {
    const t0 = Date.now();
    const r = await waitForWork(A, 900);
    const elapsed = Date.now() - t0;
    check(r.work === false && r.timedOut === true, "1a empty queue reports no work");
    check(elapsed >= 850, `1b empty queue actually WAITED (${elapsed}ms) rather than returning instantly`);
  }

  // ── 2. Work already on the plate returns immediately, no waiting ───────────────────────────────
  {
    await withTx((c) => taskCreate(c, A, { title: "already here", owner: A.participant.name }));
    const t0 = Date.now();
    const r = await waitForWork(A, 5000);
    const elapsed = Date.now() - t0;
    check(r.work === true && r.tasks >= 1, "2a pre-existing work is reported");
    check(elapsed < 400, `2b returned immediately (${elapsed}ms), did not sit out the window`);
  }

  // ── 3. THE FEATURE: work arriving DURING the wait wakes it ─────────────────────────────────────
  // A second project so A's plate starts clean again.
  const C = await freshProject("wait-live");
  const D = await createParticipation(C, "peer-agent");
  {
    const before = await pendingWork(getPool(), C);
    check(before.work === false, "3a fixture starts with an empty plate");

    const t0 = Date.now();
    const waiting = waitForWork(C, 8000);
    // Land the work only after the waiter is genuinely parked.
    setTimeout(() => {
      void withTx((c) => taskCreate(c, D, { title: "handoff", owner: C.participant.name }));
    }, 250);
    const r = await waiting;
    const elapsed = Date.now() - t0;
    check(r.work === true && r.tasks >= 1, "3b woke with the new task");
    check(elapsed < 4000, `3c woke promptly (${elapsed}ms) - not by sitting out the 8s window`);
    check(elapsed >= 200, `3d did not return before the work existed (${elapsed}ms)`);
  }

  // ── 4. Someone ELSE's work must not wake me ────────────────────────────────────────────────────
  // The trigger is deliberately dumb - it notifies the whole project - so this is the case that proves
  // the per-caller filter is real and not decorative. Without it every agent wakes on every event.
  const E = await freshProject("wait-isolation");
  const F = await createParticipation(E, "busy-neighbour");
  {
    const t0 = Date.now();
    const waiting = waitForWork(E, 1200);
    // Three events in E, none of them for E's own participation.
    setTimeout(() => {
      void withTx(async (c) => {
        await taskCreate(c, E, { title: "neighbour work 1", owner: F.participant.name });
        await taskCreate(c, E, { title: "neighbour work 2", owner: F.participant.name });
      });
    }, 200);
    const r = await waiting;
    const elapsed = Date.now() - t0;
    check(r.work === false && r.timedOut === true, "4a another agent's task did not count as mine");
    check(elapsed >= 1100, `4b stayed asleep for the whole window (${elapsed}ms) despite the traffic`);
  }

  // ── 5. A directed post is work too, and wakes ──────────────────────────────────────────────────
  const G = await freshProject("wait-post");
  const H = await createParticipation(G, "sender");
  {
    const t0 = Date.now();
    const waiting = waitForWork(G, 8000);
    setTimeout(() => {
      void withTx((c) => post(c, H, { body: "you have mail", to_actor: G.participant.name }));
    }, 250);
    const r = await waiting;
    check(r.work === true && r.unread >= 1, "5a a directed post wakes the waiter");
    check(Date.now() - t0 < 4000, "5b woke on the post rather than timing out");
  }

  // ── 6. Pointer, not content ────────────────────────────────────────────────────────────────────
  // If this ever carries titles, agents will act on the notification and stop reading the board, and the
  // bus will have grown a second inbox. Asserted as a shape so the regression is loud.
  {
    const r = await waitForWork(G, 200);
    const keys = Object.keys(r).sort().join(",");
    check(
      keys === "tasks,timedOut,unassigned,unread,work",
      `6 response is counts only, no content (got: ${keys})`,
    );
  }

  await closeWaitChannel();
  await closePool();
  console.log(
    "OK wait.channel: an empty queue sleeps out its window and says timedOut; work already on the plate " +
      "returns in <400ms; work LANDING MID-WAIT wakes it in well under the window (the feature); another " +
      "agent's traffic in the same project does NOT wake it, which is what makes the deliberately dumb " +
      "project-wide trigger safe; a directed post counts as work; and the payload is counts only, never " +
      "content, so it can never become a second inbox. Every case pins ELAPSED TIME, because a waiter " +
      "that woke instantly and one that slept the whole window return identical objects.",
  );
}

void main();
