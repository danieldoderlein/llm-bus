import { withTx, query, closePool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import { acquireLease, release, whoHolds } from "../src/domain/lease.js";

// Proves the advisory-lease contract: acquire shows up in whoHolds; a second actor's
// acquire on the same surface sees the first as an "other" (never blocked); expired leases
// are excluded; release clears the holder.

function assert(cond: boolean, msg: string, errors: string[]): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const ctx = await freshProject("lease");

  // 1. Acquire a lease as "tester" on server.py.
  await withTx((c) => acquireLease(c, ctx, { surface: "server.py", ttl_seconds: 60 }));
  const held = await whoHolds(ctx);
  assert(
    held.some((h) => h.surface === "server.py" && h.actor === "tester"),
    `expected whoHolds to include tester@server.py, got ${JSON.stringify(held)}`,
    errors,
  );

  // 2. A second actor acquiring the same surface sees tester as an "other" (advisory, never blocks).
  const bobCtx = await createParticipation(ctx, "bob");
  const bobResult = await withTx((c) =>
    acquireLease(c, bobCtx, { surface: "server.py", ttl_seconds: 60 }),
  );
  assert(
    bobResult.others.some((o) => o.actor === "tester"),
    `expected bob's others to include tester, got ${JSON.stringify(bobResult.others)}`,
    errors,
  );

  // 3. Expiry: an already-expired lease must be excluded from whoHolds.
  await query(
    `INSERT INTO leases (project_id, surface, participation_id, actor_name, expires_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(secs => 60))`,
    [ctx.project.id, "old.py", ctx.participation.id, ctx.participant.name],
  );
  const oldHeld = await whoHolds(ctx, "old.py");
  assert(
    oldHeld.length === 0,
    `expected no active leases on old.py (expired), got ${JSON.stringify(oldHeld)}`,
    errors,
  );

  // 4. Release: after tester releases server.py, whoHolds no longer lists tester there.
  await withTx((c) => release(c, ctx, "server.py"));
  const afterRelease = await whoHolds(ctx, "server.py");
  assert(
    !afterRelease.some((h) => h.actor === "tester"),
    `expected tester gone from server.py after release, got ${JSON.stringify(afterRelease)}`,
    errors,
  );

  await closePool();

  if (errors.length) {
    console.error(`FAIL lease.expiry:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK lease.expiry: advisory acquire/whoHolds, second-actor 'others', expiry exclusion, and release all verified.",
  );
}

main().catch((err) => {
  console.error("lease.expiry test errored:", err);
  process.exit(1);
});
