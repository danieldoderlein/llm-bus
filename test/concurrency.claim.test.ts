import { freshProject } from "./_setup.js";
import { withTx, query, closePool } from "../src/db.js";
import { claimSequence, seedSequence } from "../src/domain/claim.js";

// The core v1 proof: N simultaneous claims in one project must yield N distinct,
// gap-free numbers and exactly N logged events — the collision-free guarantee git
// cannot give. Plus: seed sets a counter (never rewinds), and formatting works.
const N = 500;
const SEQ = "race";

function fail(msg: string): never {
  console.error(`FAIL concurrency.claim: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const ctx = await freshProject("claim");

  // Fire N claims concurrently, each in its own transaction on its own connection.
  const results = await Promise.all(
    Array.from({ length: N }, () => withTx((c) => claimSequence(c, ctx, { sequence: SEQ }))),
  );

  if (results.length !== N) fail(`expected ${N} results, got ${results.length}`);

  const numbers = results.map((r) => r.number);
  const unique = new Set(numbers);
  if (unique.size !== N) fail(`DUPLICATES: expected ${N} distinct numbers, got ${unique.size}`);

  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < N; i++) {
    if (sorted[i] !== i + 1) {
      fail(`gap or duplicate at sorted position ${i}: got ${sorted[i]}, expected ${i + 1}`);
    }
  }

  const ev = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events
      WHERE project_id = $1 AND type = 'claim' AND payload->>'sequence' = $2`,
    [ctx.project.id, SEQ],
  );
  if (Number(ev.rows[0].count) !== N) {
    fail(`expected ${N} claim events, got ${ev.rows[0].count}`);
  }

  // Seed an existing-style ADR counter and claim once -> next number is 103, formatted "R103".
  await withTx((c) => seedSequence(c, ctx, { sequence: "adr", current: 102, prefix: "R" }));
  const adr = await withTx((c) => claimSequence(c, ctx, { sequence: "adr" }));
  if (adr.number !== 103) fail(`expected adr number 103, got ${adr.number}`);
  if (adr.formatted !== "R103") fail(`expected adr formatted "R103", got "${adr.formatted}"`);

  // Seed a zero-padded migration counter and claim once -> formatted "0001".
  await withTx((c) => seedSequence(c, ctx, { sequence: "mig", current: 0, prefix: "", pad: 4 }));
  const mig = await withTx((c) => claimSequence(c, ctx, { sequence: "mig" }));
  if (mig.formatted !== "0001") fail(`expected mig formatted "0001", got "${mig.formatted}"`);

  await closePool();
  console.log(
    `OK concurrency.claim: ${N} concurrent claims -> ${unique.size} distinct, gap-free [1..${N}]; ` +
      `${N} events logged; seed+claim -> R103, padded -> 0001.`,
  );
}

main().catch((err) => {
  console.error("concurrency test errored:", err);
  process.exit(1);
});
