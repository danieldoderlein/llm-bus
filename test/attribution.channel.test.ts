import "./_setup.js"; // defaults DATABASE_URL to the local test cluster; must run before db.js
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../src/db.js";
import { resolveOwner } from "../src/admin/owner.js";
import { asChannel } from "../src/admin/session.js";

// Per-channel acquisition attribution (decision 031, task #114). Two things under test:
// (1) asChannel() sanitizes the UNTRUSTED `via` param to [a-z0-9._-]{1,64} or null - the first line of
//     defense (bounds cardinality + strips HTML metacharacters before storage);
// (2) resolveOwner stamps acquisition_channel WRITE-ONCE on first create and NEVER overwrites on a
//     repeat login - identical posture to landing_variant, and never affecting which owner resolves
//     (invariant 1). A garbage/absent channel leaves the owner unattributed (NULL) - fail-open.

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function channelOf(ownerId: number): Promise<string | null> {
  const r = await getPool().query<{ acquisition_channel: string | null }>(
    `SELECT acquisition_channel FROM owners WHERE id = $1`,
    [ownerId],
  );
  return r.rows[0]?.acquisition_channel ?? null;
}

async function main(): Promise<void> {
  // ── (1) asChannel sanitizer ──
  check(asChannel("r-mcp") === "r-mcp", "a clean slug passes through");
  check(asChannel("creator.alice_1") === "creator.alice_1", "dot/underscore/digit allowed");
  check(asChannel("  ShowHN  ") === "showhn", "trimmed + lowercased");
  check(asChannel("R-MCP") === "r-mcp", "uppercased slug is lowercased");
  check(asChannel("") === null, "empty string -> null");
  check(asChannel("   ") === null, "whitespace-only -> null");
  check(asChannel(null) === null, "null -> null");
  check(asChannel(undefined) === null, "undefined -> null");
  check(asChannel("has space") === null, "space is not allowed -> null");
  check(asChannel("<script>") === null, "HTML metacharacters rejected -> null");
  check(asChannel("a/b") === null, "slash rejected -> null");
  check(asChannel("x".repeat(64)) === "x".repeat(64), "exactly 64 chars allowed");
  check(asChannel("x".repeat(65)) === null, "65 chars -> null (length bound)");

  // ── (2) resolveOwner write-once stamping ──
  // (a) A signup carrying via=r-mcp stamps acquisition_channel='r-mcp' on FIRST create.
  const rmcpEmail = `attr-rmcp-${randomUUID().slice(0, 8)}@test.local`;
  const rmcp1 = await resolveOwner(rmcpEmail, { channel: "r-mcp" });
  check((await channelOf(rmcp1.id)) === "r-mcp", "first-create signup should persist acquisition_channel='r-mcp'");

  // (b) A repeat login carrying a DIFFERENT channel must NOT overwrite the original.
  const rmcp2 = await resolveOwner(rmcpEmail, { channel: "showhn" });
  check(rmcp2.id === rmcp1.id, "repeat login resolves the SAME owner (identity from email, not channel)");
  check((await channelOf(rmcp1.id)) === "r-mcp", "repeat login must NOT overwrite the original acquisition_channel");

  // (c) A channel-less repeat login leaves it intact.
  await resolveOwner(rmcpEmail);
  check((await channelOf(rmcp1.id)) === "r-mcp", "a channel-less repeat login must leave acquisition_channel intact");

  // (d) A signup with no channel at all -> NULL (unattributed).
  const noneEmail = `attr-none-${randomUUID().slice(0, 8)}@test.local`;
  const none1 = await resolveOwner(noneEmail);
  check((await channelOf(none1.id)) === null, "signup with no channel should leave acquisition_channel NULL");

  // (e) A garbage channel that slipped past the handler is re-validated in resolveOwner -> NULL.
  const garbageEmail = `attr-garbage-${randomUUID().slice(0, 8)}@test.local`;
  const garbage1 = await resolveOwner(garbageEmail, { channel: "bad value!" });
  check((await channelOf(garbage1.id)) === null, "signup with a garbage channel should leave acquisition_channel NULL");

  await closePool();

  if (errors.length) {
    console.error(`FAIL attribution.channel:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK attribution.channel: asChannel sanitizes the untrusted via param; resolveOwner stamps acquisition_channel write-once on create, never overwrites on repeat, and re-validates garbage to NULL.",
  );
}

main().catch((err) => {
  console.error("attribution.channel test errored:", err);
  process.exit(1);
});
