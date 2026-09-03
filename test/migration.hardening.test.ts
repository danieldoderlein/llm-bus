import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshProject } from "./_setup.js";
import { withTx, query, closePool, getPool } from "../src/db.js";
import { claimSequence, seedSequence } from "../src/domain/claim.js";
import { latestClaims, whatsNew } from "../src/domain/digest.js";
import { coordinationGuide } from "../src/invite.js";

// Decision 040 (project-b-platform field report). The load-bearing regression: after a v2-style ledger flush
// (events cleared, sequences PRESERVED), latest_claims must still report the live counters - NOT the empty
// object that nearly drove a reconnecting agent to seed_sequence over 75 live decision numbers. Plus: the
// seed guard refuses a reset/rewind of a live counter (and says so), and guide() teaches the current model
// without the retired migration banner.

function fail(msg: string): never {
  console.error(`FAIL migration.hardening: ${msg}`);
  process.exit(1);
}

/** Run `fn`, returning the thrown Error (or null if it did not throw). Keeps CFA narrowing clean. */
async function caught(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

async function main(): Promise<void> {
  const ctx = await freshProject("mig-hard");

  // A populated registry: adr SEEDED at 75 (no claim event), decisions CLAIMED up to 3 (has claim events).
  await withTx((c) => seedSequence(c, ctx, { sequence: "adr", current: 75 }));
  await withTx((c) => claimSequence(c, ctx, { sequence: "decisions" }));
  await withTx((c) => claimSequence(c, ctx, { sequence: "decisions" }));
  await withTx((c) => claimSequence(c, ctx, { sequence: "decisions" }));

  // Before the flush: both sequences present; decisions carries by/at from its claim event, seeded adr does not.
  const before = await latestClaims(ctx);
  const adrBefore = before.sequences.find((s) => s.sequence === "adr");
  const decBefore = before.sequences.find((s) => s.sequence === "decisions");
  if (!adrBefore || adrBefore.number !== 75) fail(`pre-flush adr expected 75, got ${adrBefore?.number}`);
  if (!decBefore || decBefore.number !== 3) fail(`pre-flush decisions expected 3, got ${decBefore?.number}`);
  if (decBefore.by === null) fail(`pre-flush decisions should carry 'by' from its claim event`);
  if (adrBefore.by !== null) fail(`seeded adr has no claim event -> 'by' should be null, got ${adrBefore.by}`);

  // THE NEAR-MISS: flush the coordination ledger (events) but PRESERVE sequences, exactly as decision 039 does.
  await query(`DELETE FROM events WHERE project_id = $1`, [ctx.project.id]);

  const after = await latestClaims(ctx);
  if (after.sequences.length !== 2) {
    fail(`post-flush latest_claims MUST NOT be empty; got ${after.sequences.length} sequences (this is the near-miss)`);
  }
  const adrAfter = after.sequences.find((s) => s.sequence === "adr");
  const decAfter = after.sequences.find((s) => s.sequence === "decisions");
  if (!adrAfter || adrAfter.number !== 75) fail(`post-flush adr MUST still be 75 (counter survives), got ${adrAfter?.number}`);
  if (!decAfter || decAfter.number !== 3) fail(`post-flush decisions MUST still be 3, got ${decAfter?.number}`);
  if (decAfter.formatted !== "3") fail(`post-flush decisions formatted expected "3", got "${decAfter.formatted}"`);
  if (decAfter.by !== null || decAfter.at !== null) fail(`post-flush by/at must be null (events gone), got by=${decAfter.by}`);

  // whats_new.latest_claims (built from the same source) also survives the flush.
  const wn = await withTx((c) => whatsNew(c, ctx, {}));
  if (wn.latest_claims["adr"] !== "75") fail(`whats_new.latest_claims.adr expected "75", got ${JSON.stringify(wn.latest_claims)}`);
  if (wn.latest_claims["decisions"] !== "3") fail(`whats_new.latest_claims.decisions expected "3", got ${JSON.stringify(wn.latest_claims)}`);

  // SEED GUARD: resetting the live (post-flush) adr counter is refused - loudly, naming the intact value.
  const rewind = await caught(() => withTx((c) => seedSequence(c, ctx, { sequence: "adr", current: 1 })));
  if (!rewind) fail(`seeding adr back to 1 MUST throw`);
  if (!/intact/.test(rewind.message) || !/\b75\b/.test(rewind.message)) {
    fail(`seed refusal must name the intact stored value 75: "${rewind.message}"`);
  }

  // Equal value also refused (a no-op reset that would clobber prefix/pad).
  const equal = await caught(() => withTx((c) => seedSequence(c, ctx, { sequence: "adr", current: 75 })));
  if (!equal) fail(`re-seeding adr at the same value 75 MUST throw`);

  // A genuine ADVANCE (strictly higher) is still allowed - a real backfill.
  const advanced = await withTx((c) => seedSequence(c, ctx, { sequence: "adr", current: 80 }));
  if (advanced.current !== 80) fail(`advancing adr to 80 should succeed, got ${advanced.current}`);

  // A brand-new sequence seeds fine.
  const fresh = await withTx((c) => seedSequence(c, ctx, { sequence: "oi", current: 50 }));
  if (fresh.current !== 50) fail(`seeding new sequence oi at 50 should succeed, got ${fresh.current}`);

  // Decision 061: claim() is an upsert, so a TYPO'd sequence name silently forked a brand-new namespace and
  // handed back a confident "1" - and CLAUDE.md §02 requires decision numbers to come from claim("decisions"),
  // so one typo can fork the numbering a whole fleet shares. A create beside existing sequences now says so.
  const typo = await withTx((c) => claimSequence(c, ctx, { sequence: "decisons" }));
  if (typo.number !== 1 || typo.created !== true)
    fail(`a typo'd sequence creates a new counter at 1: got number=${typo.number} created=${typo.created}`);
  if (!typo.warning || !/already has/.test(typo.warning) || !/decisions/.test(typo.warning))
    fail(`a NEW sequence beside existing ones must warn and name them, got ${JSON.stringify(typo.warning)}`);
  // Advancing a real sequence is not a create and must stay quiet.
  const real = await withTx((c) => claimSequence(c, ctx, { sequence: "decisions" }));
  if (real.created !== false || real.warning !== undefined)
    fail(`advancing an existing sequence must not warn: created=${real.created} warning=${JSON.stringify(real.warning)}`);

  // ── db/schema.sql must be RE-RUNNABLE, not merely runnable ────────────────────────────────────────
  // CLAUDE.md section 02 requires idempotent migrations because there is a production DB, but nothing
  // asserted it: a statement that succeeds once and throws forever after looks completely healthy on the
  // deploy that introduces it. Decision 069 shipped exactly that - `ALTER TABLE posts ADD CONSTRAINT
  // posts_addressed_check` with no guard (Postgres has no ADD CONSTRAINT IF NOT EXISTS for a CHECK) - and it
  // was not found until the NEXT deploy failed on a live VM mid-release. Applying the file a second time is
  // the only check that can tell "idempotent" from "has been applied once".
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  for (const pass of [1, 2]) {
    try {
      await getPool().query(schema);
    } catch (e) {
      fail(
        `db/schema.sql is not idempotent: pass ${pass} threw ${(e as Error).message}. Every ALTER must be ` +
          `guarded (IF NOT EXISTS, or DROP IF EXISTS before ADD for a CHECK constraint).`,
      );
    }
  }

  // GUIDE orientation surface: what an agent pulls when it senses something changed.
  //
  // The "MIGRATED TO v2" banner this used to require was RETIRED on 2026-08-30, 19 days after the launch it
  // described, on the operator's instruction ("our guide refers to an old upgrade - who cares, just explain
  // in short how the system works"). It was a transitional notice about a one-time ledger flush, and the
  // durable half of 040's migration contract is the TOMBSTONES - review/answer_review/ack still answer with
  // a one-line redirect to their v2 replacement, which is what an agent running a stale CLAUDE.md actually
  // hits. Those are asserted above and are unchanged. What stays required here is that the guide still
  // teaches the current model rather than a dead one.
  const guide = coordinationGuide(false);
  for (const needle of ["seed_sequence", "task_answer", "reconnect llm-bus"]) {
    if (!guide.includes(needle)) fail(`guide() is missing "${needle}"`);
  }
  // And it must NOT have drifted back into describing the migration as current news.
  for (const stale of ["MIGRATED TO v2", "was FLUSHED"]) {
    if (guide.includes(stale)) fail(`guide() still carries the retired transitional banner "${stale}"`);
  }

  await closePool();
  console.log(
    "OK migration.hardening: latest_claims authoritative post-flush (adr 75, decisions 3, by/at null); " +
      "seed guard refuses reset/rewind (names intact value), allows advance + new; db/schema.sql applies " +
      "TWICE without error (idempotent, not merely applied-once); guide() teaches the CURRENT model and has " +
      "NOT drifted back into carrying the retired v2 migration banner.",
  );
}

main().catch((err) => {
  console.error("migration.hardening test errored:", err);
  process.exit(1);
});
