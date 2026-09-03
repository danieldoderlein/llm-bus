import { freshProject, createParticipation, setDriver } from "./_setup.js";
import { withTx, getPool, closePool } from "../src/db.js";
import { taskCreate, taskStart, taskBlock, taskResolve, taskCancel } from "../src/domain/task.js";
import { whatsNew } from "../src/domain/digest.js";

// Decision 074: a manual block says WHAT would lift it and WHO owns lifting it.
//
// Decision 073 made the reason visible and, in doing so, had to print the honest sentence that nothing
// would ever lift it - a manual block recorded a reason and nothing else. Production carried 7 open manual
// blocks, the oldest 10 days old, every one legitimate and none with any mechanism that would bring it
// back. The operator's ruling on task #980 was A and B together: an explanation AND an owner, because
// "even if the assigned party is not the right or final assignee, at least it is assigned and someone
// needs to process it."
//
// The two halves are tested for different failure modes. The REQUIREMENT half must refuse, and refuse with
// a message that names the corrective call - a bare rejection would strand an agent whose client cached
// the pre-074 tool list (decision 040's tombstone lesson). The OWNER half must actually reach the person
// named: a name recorded on a detail page nobody opens is the same dead end 074 exists to close, so the
// block has to appear on that owner's own plate.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

async function main(): Promise<void> {
  const ctx = await freshProject("blockers");
  const me = ctx.participant.name;
  const peer = await createParticipation(ctx, "unblocker-agent");

  const newBlockedTask = async (title: string): Promise<number> =>
    withTx(async (c) => {
      const t = await taskCreate(c, ctx, { title, owner: me });
      await taskStart(c, ctx, { task_id: t.task_id });
      return t.task_id;
    });

  // ── 1. Both fields are REQUIRED, and each refusal teaches the corrective call ──
  const t1 = await newBlockedTask("needs a condition");
  const noCondition = await refusal(() =>
    withTx((c) => taskBlock(c, ctx, { task_id: t1, reason: "waiting on hardware" })),
  );
  check(noCondition !== "", "a block with no exit condition must be REFUSED, not recorded");
  check(
    /unblock_condition/.test(noCondition) && /task_block\(/.test(noCondition),
    `the refusal must name the parameter AND show the corrective call, got: ${noCondition}`,
  );
  const noOwner = await refusal(() =>
    withTx((c) => taskBlock(c, ctx, { task_id: t1, reason: "waiting", unblock_condition: "the box arrives" })),
  );
  check(noOwner !== "", "a block with no owner of the unblock must be REFUSED");
  check(
    /unblock_owner/.test(noOwner) && /unblock_human/.test(noOwner),
    `the refusal must name BOTH namespaces - an agent or a person can own it, got: ${noOwner}`,
  );
  // A refused block must leave NO trace. A half-written blocker would show the task as blocked with
  // nothing to act on, which is strictly worse than the state 074 replaced.
  const stray = await getPool().query(`SELECT count(*)::int AS n FROM task_blockers WHERE task_id = $1`, [t1]);
  check(stray.rows[0].n === 0, `a refused block must write nothing, found ${stray.rows[0].n} blocker row(s)`);

  // ── 2. A complete block records both, and names an owner in either namespace ──
  const t2 = await newBlockedTask("waiting on the peer");
  const blocked = await withTx((c) =>
    taskBlock(c, ctx, {
      task_id: t2,
      reason: "the render farm is down",
      unblock_condition: "the farm is back and the frame renders",
      unblock_owner: "unblocker-agent",
    }),
  );
  check(blocked.status === "blocked", "a complete block still blocks the task");
  check(blocked.unblock_owner === "unblocker-agent", `the call reports who owns the unblock, got ${blocked.unblock_owner}`);
  const row = await getPool().query<{ unblock_condition: string; unblock_name: string; pid: string | null }>(
    `SELECT unblock_condition, unblock_name, unblock_participation_id::text AS pid
       FROM task_blockers WHERE task_id = $1 AND resolved_at IS NULL`,
    [t2],
  );
  check(
    row.rows[0]?.unblock_condition === "the farm is back and the frame renders",
    `the exit condition is stored verbatim, got ${JSON.stringify(row.rows[0]?.unblock_condition)}`,
  );
  check(
    Number(row.rows[0]?.pid) === peer.participation.id,
    "the owner resolves to a real participation, not just a display string - otherwise it cannot be routed",
  );

  // ── 3. The owner actually HEARS about it: it lands on THEIR plate, not the blocker's ──
  const peerDigest = await withTx((c) => whatsNew(c, peer, { advance_cursor: false }));
  check(
    (peerDigest.waiting_on_you ?? []).some((w) => w.task_id === t2),
    `the named owner must see the block on their own plate, got ${JSON.stringify(peerDigest.waiting_on_you)}`,
  );
  check(
    peerDigest.waiting_on_you?.[0]?.lifts_when === "the farm is back and the frame renders",
    "and must be told what would lift it, or they cannot act on it",
  );
  check(
    !(peerDigest.my_open_tasks ?? []).some((t) => t.task_id === t2),
    "it must NOT appear as their own task - it is someone else's work that their action unblocks",
  );
  const mineDigest = await withTx((c) => whatsNew(c, ctx, { advance_cursor: false }));
  check(
    !(mineDigest.waiting_on_you ?? []).some((w) => w.task_id === t2),
    "the agent who SET the block is not waiting on itself - only the named owner is",
  );

  // ── 4. Resolving the block clears it from that owner's plate ──
  await withTx((c) => taskResolve(c, ctx, { task_id: t2 }));
  const afterResolve = await withTx((c) => whatsNew(c, peer, { advance_cursor: false }));
  check(
    !(afterResolve.waiting_on_you ?? []).some((w) => w.task_id === t2),
    "a resolved block must leave the owner's plate, or the queue only ever grows",
  );

  // ── 5. A block on a task that goes TERMINAL leaves the owner's plate ──
  // Found on prod immediately after 074 deployed: llm-bus task 384 is cancelled and its manual block is
  // still open, because nothing resolves blockers when a task ships or is cancelled. Without this the owner
  // would carry an item they can NEVER clear by doing the work - a queue that only grows, which is exactly
  // the failure 074 was built to prevent rather than reproduce.
  const t4 = await newBlockedTask("this one gets cancelled");
  await withTx((c) =>
    taskBlock(c, ctx, {
      task_id: t4,
      reason: "waiting on a call",
      unblock_condition: "the call happens",
      unblock_owner: "unblocker-agent",
    }),
  );
  const beforeCancel = await withTx((c) => whatsNew(c, peer, { advance_cursor: false }));
  check(
    (beforeCancel.waiting_on_you ?? []).some((w) => w.task_id === t4),
    "precondition: the block is on the owner's plate before the task is cancelled",
  );
  await withTx((c) => taskCancel(c, ctx, { task_id: t4 }));
  const stillOpen = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM task_blockers WHERE task_id = $1 AND resolved_at IS NULL`,
    [t4],
  );
  check(stillOpen.rows[0].n === 1, "the blocker row is deliberately NOT auto-resolved - the record is kept");
  const afterCancel = await withTx((c) => whatsNew(c, peer, { advance_cursor: false }));
  check(
    !(afterCancel.waiting_on_you ?? []).some((w) => w.task_id === t4),
    "but a cancelled task must leave the owner's plate - nothing they do could ever clear it otherwise",
  );

  // ── 6. A human can own the unblock, via the same vocabulary that assigns to a human (decision 061) ──
  const t3 = await newBlockedTask("waiting on a person");
  const humanBlocked = await refusal(() =>
    withTx((c) =>
      taskBlock(c, ctx, {
        task_id: t3,
        reason: "needs a policy call",
        unblock_condition: "the operator rules on it",
        unblock_human: "definitely-not-a-member",
      }),
    ),
  );
  check(
    humanBlocked !== "" && /human member .* not found/i.test(humanBlocked),
    `naming a non-member as the unblock owner must be refused, got: ${humanBlocked}`,
  );

  // ── 7. THE HUMAN ARM, ASSERTED POSITIVELY. Section 6 above only proves a non-member is REFUSED, and every
  //    ctx this file builds has humanOwnerId null - so the human half of the waiting_on_you predicate
  //    ($3 IS NOT NULL AND b.unblock_owner_id = $3) never executed anywhere in the suite. Deleting that arm
  //    outright would have left the tests byte-identical: a check that cannot fail is not a check (CLAUDE.md
  //    section 06). Independent review caught it; this is the missing positive control. ──
  const humanId = ctx.owner!.id;
  // Unique per run: owners.username carries a UNIQUE index, so a fixed literal passes ONCE and then errors
  // on every later run - and an erroring test is indistinguishable from a passing one at a glance, which is
  // how a mutation control silently stops controlling anything.
  const humanHandle = `blockboss-${humanId}`;
  await getPool().query(`UPDATE owners SET username = $2 WHERE id = $1`, [humanId, humanHandle]);
  await getPool().query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
    [ctx.project.id, humanId],
  );
  const t5 = await newBlockedTask("waiting on a person, for real this time");
  await withTx((c) =>
    taskBlock(c, ctx, {
      task_id: t5,
      reason: "needs a policy call",
      unblock_condition: "the operator rules on it",
      unblock_human: humanHandle,
    }),
  );
  // An agent DRIVEN BY that human must see it - this is the arm that never ran.
  const driven = await setDriver(await createParticipation(ctx, "driven-agent"), humanId);
  const drivenDigest = await withTx((c) => whatsNew(c, driven, { advance_cursor: false }));
  check(
    (drivenDigest.waiting_on_you ?? []).some((w) => w.task_id === t5),
    "a block naming a HUMAN must reach an agent bound to that human - the human arm of waiting_on_you",
  );
  // Control: an agent bound to NOBODY must not see it, so the arm is not just matching everything.
  const unbound = await createParticipation(ctx, "unbound-agent");
  const unboundDigest = await withTx((c) => whatsNew(c, unbound, { advance_cursor: false }));
  check(
    !(unboundDigest.waiting_on_you ?? []).some((w) => w.task_id === t5),
    "an agent bound to no human must NOT inherit a human-owned block",
  );

  // ── 8. THE CAP MUST ANNOUNCE ITSELF. guide() promises "your plate is never silently cut - a short list
  //    with no such note IS the whole list, trust it". This list was capped at 20 with no total and no note,
  //    and unlike my_open_tasks there is NO wider read to fall back on: list_tasks exposes no unblock
  //    fields, so a cut row was unreachable from any MCP call at all. ──
  const capped = await createParticipation(ctx, "swamped-agent");
  for (let i = 0; i < 21; i++) {
    const tN = await newBlockedTask(`swamp ${i}`);
    await withTx((c) =>
      taskBlock(c, ctx, {
        task_id: tN,
        reason: `swamp ${i}`,
        unblock_condition: "someone digs out",
        unblock_owner: "swamped-agent",
      }),
    );
  }
  const swamped = await withTx((c) => whatsNew(c, capped, { advance_cursor: false }));
  check((swamped.waiting_on_you ?? []).length === 20, `the cap still holds at 20, got ${(swamped.waiting_on_you ?? []).length}`);
  check(
    typeof swamped.waiting_on_you_truncated === "string" && /21/.test(swamped.waiting_on_you_truncated),
    `a cut list must say so and name the true total, got: ${String(swamped.waiting_on_you_truncated)}`,
  );

  await closePool();
  if (errors.length) {
    console.error(`FAIL blockers.accountable:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK blockers.accountable: decision 074 - a manual block is refused unless it says what would LIFT it " +
      "and names who owns lifting it (each refusal naming the corrective call, and writing no partial row); " +
      "the owner resolves to a real participation in either namespace; and the block lands on THAT owner's " +
      "plate as waiting_on_you (not as their own task, not on the blocker's plate) until it is resolved - "
      + "or until the task itself goes terminal, which also clears it, since no amount of doing the work "
      + "could ever clear a block on a cancelled task.",
  );
}

main().catch((e) => {
  console.error("blockers.accountable test errored:", e);
  process.exit(1);
});
