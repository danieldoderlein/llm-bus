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

  // 044: claim carries an auto-qualified cross-project id <ownerHandle>/<slug>#<formatted>; the bare id is
  // unchanged, and the SAME bare id in two DIFFERENT projects yields DISTINCT qualified ids (the whole point).
  ctx.project.ownerHandle = "acme";
  const q1 = await withTx((c) => claimSequence(c, ctx, { sequence: "qseq" }));
  if (q1.formatted !== "1") fail(`qseq bare formatted expected "1", got "${q1.formatted}"`);
  if (q1.qualified !== `acme/${ctx.project.slug}#1`) fail(`qseq qualified expected "acme/${ctx.project.slug}#1", got "${q1.qualified}"`);
  const other = await freshProject("claim2");
  other.project.ownerHandle = "acme"; // same owner handle, DIFFERENT slug -> must NOT collide
  const q2 = await withTx((c) => claimSequence(c, other, { sequence: "qseq" }));
  if (q2.formatted !== "1") fail(`other qseq bare expected "1", got "${q2.formatted}"`);
  if (q2.qualified === q1.qualified) fail(`two projects' qseq#1 must have DISTINCT qualified ids; both got "${q1.qualified}"`);
  if (q2.qualified !== `acme/${other.project.slug}#1`) fail(`other qseq qualified expected "acme/${other.project.slug}#1", got "${q2.qualified}"`);
  // pre-backfill (no owner handle) degrades to slug#id
  ctx.project.ownerHandle = null;
  const q3 = await withTx((c) => claimSequence(c, ctx, { sequence: "qseq" }));
  if (q3.qualified !== `${ctx.project.slug}#2`) fail(`null-handle qualified expected "${ctx.project.slug}#2", got "${q3.qualified}"`);

  await closePool();
  console.log(
    `OK concurrency.claim: ${N} concurrent claims -> ${unique.size} distinct, gap-free [1..${N}]; ` +
      `${N} events logged; seed+claim -> R103, padded -> 0001; 044 qualified id <handle>/<slug>#id is unique ` +
      `across projects while the bare id is unchanged.`,
  );
}

main().catch((err) => {
  console.error("concurrency test errored:", err);
  process.exit(1);
});
