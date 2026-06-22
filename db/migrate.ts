import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "../src/db.js";

/** Apply the idempotent schema. schema.sql sits next to this file (copied into dist/ on build). */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, "schema.sql");
  const sql = await readFile(schemaPath, "utf8");
  await getPool().query(sql);
  console.log(`[llm-bus] migrated: ${schemaPath}`);
  await closePool();
}

main().catch((err) => {
  console.error("[llm-bus] migration failed:", err);
  process.exit(1);
});
