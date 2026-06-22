import { getPool, closePool } from "../src/db.js";

/**
 * Promote (or create) an owner as an operator — the bootstrap/superuser owner whose
 * email is trusted by /admin. Idempotent: re-running flips is_operator back to true.
 *   npm run bootstrap-owner -- <email>
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [email] = args;
  if (!email) {
    console.error("usage: npm run bootstrap-owner -- <email>");
    process.exit(2);
  }

  const pool = getPool();
  const res = await pool.query<{ id: string; email: string; is_operator: boolean }>(
    `INSERT INTO owners (email, is_operator) VALUES ($1, true)
     ON CONFLICT (email) DO UPDATE SET is_operator = true
     RETURNING id, email, is_operator`,
    [email],
  );
  await closePool();

  const o = res.rows[0];
  console.log("");
  console.log(`  owner     : ${o.email} (id ${Number(o.id)}, operator)`);
  console.log("");
}

main().catch((err) => {
  console.error("bootstrap-owner failed:", err);
  process.exit(1);
});
