// Decision 018: the global handle identity model. Proves handle derivation + collision allocation,
// that the qualified actor `handle/label` is composed from the token (invariant 1) and is what gets
// WRITTEN to the ledger, and the dual-read fallback to the bare label for un-backfilled owners.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool, query, withTx } from "../src/db.js";
import { authenticateResult } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { resolveOwner } from "../src/admin/owner.js";
import { createProject, createParticipant, grant } from "../src/admin/queries.js";
import { deriveUsername, changeUsername } from "../src/admin/username.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const tag = randomUUID().slice(0, 8);

  // (1) deriveUsername sanitizes the email local-part to a safe handle charset.
  check(
    deriveUsername("Daniel.Doderlein+x@doderlein.com") === "daniel-doderlein-x",
    `derive: got "${deriveUsername("Daniel.Doderlein+x@doderlein.com")}"`,
  );
  check(deriveUsername("@@@@@x.test") === "user", `derive fallback: got "${deriveUsername("@@@@@x.test")}"`);

  // (2) resolveOwner assigns a globally-unique handle; a same-base collision gets a -N suffix.
  const a = await resolveOwner(`dup-${tag}@a.test`);
  const b = await resolveOwner(`dup-${tag}@b.test`); // same local-part -> base collides -> "-2"
  check(!!a.username, "owner a should have a handle");
  check(a.username !== b.username, `handles must differ globally: ${a.username} vs ${b.username}`);
  check(b.username === `${a.username}-2`, `collision should suffix -2: got "${b.username}"`);

  // (3) The qualified actor is composed from the token (never input) through authenticate.
  const owner = await resolveOwner(`han-${tag}@test.local`);
  const project = await createProject(owner.id, `han-${tag}`, `Han ${tag}`);
  const part = await createParticipant(owner.id, "claude-1", "agent");
  const g = await grant(owner.id, project.id, part.id, null, true);
  check(!!g, "grant should mint a token");
  const res = await authenticateResult(`Bearer ${g!.plaintextToken}`);
  check(res.ok, "token should authenticate");
  if (res.ok) {
    const want = `${owner.username}/claude-1`;
    check(res.ctx.actor === want, `ctx.actor expected "${want}", got "${res.ctx.actor}"`);
    check(res.ctx.participant.handle === owner.username, `handle on participant: got "${res.ctx.participant.handle}"`);
    check(res.ctx.participant.name === "claude-1", `bare label preserved: got "${res.ctx.participant.name}"`);

    // (4) ...and that qualified actor is what gets WRITTEN to the ledger.
    await withTx((c) => appendEvent(c, res.ctx, "register", {}));
    const ev = await query<{ actor_name: string }>(
      `SELECT actor_name FROM events WHERE project_id = $1 AND type = 'register' ORDER BY id DESC LIMIT 1`,
      [project.id],
    );
    check(ev.rows[0]?.actor_name === want, `ledger actor_name expected "${want}", got "${ev.rows[0]?.actor_name}"`);
  }

  // (5) Dual-read: an owner with no handle yet resolves to the bare label (migration safety).
  await query(`UPDATE owners SET username = NULL WHERE id = $1`, [owner.id]);
  const res2 = await authenticateResult(`Bearer ${g!.plaintextToken}`);
  check(
    res2.ok && res2.ctx.actor === "claude-1" && res2.ctx.participant.handle === null,
    `dual-read should fall back to bare "claude-1", got "${res2.ok ? res2.ctx.actor : "n/a"}"`,
  );

  // (6) changeUsername: rejects bad format + taken handles; accepts a valid one; idempotent on self.
  const c = await resolveOwner(`chg-${tag}@test.local`);
  check(!(await changeUsername(c.id, "Bad Handle!")).ok, "invalid handle format should be rejected");
  check(!(await changeUsername(c.id, a.username)).ok, "a globally-taken handle should be rejected");
  const okc = await changeUsername(c.id, `chosen-${tag}`);
  check(okc.ok && okc.username === `chosen-${tag}`, `valid change should succeed: ${JSON.stringify(okc)}`);
  check((await changeUsername(c.id, `chosen-${tag}`)).ok, "setting a handle to its own value should succeed");

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL identity.handle:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK identity.handle: deriveUsername sanitizes; resolveOwner allocates globally-unique handles with " +
      "-N collision suffix; the qualified handle/label actor is composed from the token and written to the " +
      "ledger; un-backfilled owners dual-read to the bare label.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("identity.handle test errored:", err);
  process.exit(1);
});
