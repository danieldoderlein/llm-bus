// One-off backfill for decision 018: assign a globally-unique handle to every owner that lacks one,
// and mirror participants.label from name. Idempotent - safe to re-run; only touches NULL rows.
// Run against the target DB via DATABASE_URL. Reversible: `UPDATE owners SET username = NULL` (and
// `UPDATE participants SET label = NULL`) restores the pre-backfill state.
import { query, closePool } from "../src/db.js";
import { ensureUsername } from "../src/admin/username.js";

async function main(): Promise<void> {
  const owners = await query<{ id: string; email: string }>(
    `SELECT id, email FROM owners WHERE username IS NULL ORDER BY id`,
  );
  let assigned = 0;
  for (const o of owners.rows) {
    const handle = await ensureUsername(Number(o.id), o.email);
    assigned++;
    console.log(`  owner ${o.id} (${o.email}) -> ${handle}`);
  }
  const labels = await query(`UPDATE participants SET label = name WHERE label IS NULL`);
  console.log(`[backfill-handles] ${assigned} owner handle(s) assigned; ${labels.rowCount} participant label(s) mirrored.`);
  await closePool();
}

main().catch((err) => {
  console.error("[backfill-handles] failed:", err);
  process.exit(1);
});
