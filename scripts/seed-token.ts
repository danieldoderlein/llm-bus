import { randomBytes } from "node:crypto";
import { closePool, withTx } from "../src/db.js";
import { hashToken } from "../src/auth.js";

/**
 * Provision an owner + project + participant + participation + bearer token (v2 model).
 * Every step is an idempotent upsert keyed by the owner, so re-running with the same args
 * mints a fresh token without duplicating identity rows. Prints the token once.
 *   npm run seed-token -- <owner-email> <project-slug> <participant-name> [agent|human] [--admin]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [email, slug, name, kindArg] = args.filter((a) => !a.startsWith("--"));
  const kind = (kindArg ?? "agent") as "agent" | "human";
  const isAdmin = flags.has("--admin");
  if (!email || !slug || !name || (kind !== "agent" && kind !== "human")) {
    console.error(
      "usage: npm run seed-token -- <owner-email> <project-slug> <participant-name> [agent|human] [--admin]",
    );
    process.exit(2);
  }

  const token = randomBytes(32).toString("base64url");
  await withTx(async (client) => {
    const owner = await client.query<{ id: string }>(
      `INSERT INTO owners (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email],
    );
    const ownerId = owner.rows[0].id;
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $2)
       ON CONFLICT (owner_id, slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id`,
      [ownerId, slug],
    );
    const participant = await client.query<{ id: string }>(
      `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO UPDATE SET kind = EXCLUDED.kind
       RETURNING id`,
      [ownerId, name, kind],
    );
    const participation = await client.query<{ id: string }>(
      `INSERT INTO participations (participant_id, project_id, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (participant_id, project_id) DO UPDATE SET is_admin = participations.is_admin OR $3
       RETURNING id`,
      [participant.rows[0].id, project.rows[0].id, isAdmin],
    );
    await client.query(
      `INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`,
      [participation.rows[0].id, hashToken(token)],
    );
  });
  await closePool();

  console.log("");
  console.log(`  owner     : ${email}`);
  console.log(`  project   : ${slug}`);
  console.log(`  participant: ${name} (${kind}${isAdmin ? ", admin" : ""})`);
  console.log(`  token     : ${token}`);
  console.log("");
  console.log("  Store this token now — only its hash is stored.");
  console.log("  Use it as:  Authorization: Bearer <token>");
}

main().catch((err) => {
  console.error("seed-token failed:", err);
  process.exit(1);
});
