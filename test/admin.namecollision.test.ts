// A participant NAME is not an identity, and two credential tools addressed teammates by one.
//
// `participants` is UNIQUE on (owner_id, name), so two different HUMANS can each own a participant called
// the same thing, and both can hold a seat in one project. `admin_revoke` matched on project + name and
// updated EVERY match; `admin_rotate` matched the same way and took rows[0]. Either could change a
// collaborator's access as a side effect of touching your own agent.
//
// Reported by the project-b rig, which refused to run a revoke it could not prove was safe and asked instead.
// Measured afterwards: no name on the production bus is used by more than one human, so the hazard was
// dormant - which is exactly why it needed a test rather than a note. This file BUILDS the collision that
// does not exist yet and proves the tools refuse it.
import { freshProject } from "./_setup.js";
import { resolveOneParticipant } from "../src/mcp.js";
import { getPool, closePool } from "../src/db.js";

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  const pool = getPool();
  const A = await freshProject("collide");
  const SHARED = "shared-agent-name";

  // Give the fixture owner a username. Not cosmetic: the qualified actor is
  // COALESCE(handle || '/' || name, name), so an owner with a NULL username renders a BARE name and the
  // "does the reply carry the qualified identity" assertion below would pass vacuously against a fallback
  // rather than against the real thing. Production owners all have handles.
  // Ctx.owner is optional on the type, so read the project's owner_id - which is NOT NULL - rather than
  // asserting past the compiler on a field that can legitimately be absent.
  const projOwner = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM projects WHERE id = $1`, [
    A.project.id,
  ]);
  const projectOwnerId = Number(projOwner.rows[0].owner_id);
  await pool.query(`UPDATE owners SET username = $2 WHERE id = $1`, [projectOwnerId, `first${Date.now()}`]);

  // A second HUMAN, with a participant of the same name, seated in the SAME project. Legal today: the
  // unique constraint is (owner_id, name), so nothing in the schema prevents this.
  const other = await pool.query<{ id: string }>(
    `INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id`,
    [`collide-second-${Date.now()}@test.local`, `second${Date.now()}`],
  );
  const otherOwnerId = Number(other.rows[0].id);

  const mkSeat = async (ownerId: number): Promise<number> => {
    const pt = await pool.query<{ id: string }>(
      `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, 'agent') RETURNING id`,
      [ownerId, SHARED],
    );
    const pa = await pool.query<{ id: string }>(
      `INSERT INTO participations (project_id, participant_id) VALUES ($1, $2) RETURNING id`,
      [A.project.id, Number(pt.rows[0].id)],
    );
    const paId = Number(pa.rows[0].id);
    await pool.query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [
      paId,
      `hash-${paId}-${Date.now()}`,
    ]);
    return paId;
  };
  const mine = await mkSeat(projectOwnerId);
  const theirs = await mkSeat(otherOwnerId);

  // 1. THE HAZARD IS REAL, not theoretical. The predicate the old tools used - project + name - selects
  // BOTH people's live tokens. Asserted first, so the guard below is proven to be guarding something.
  {
    const r = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM tokens t
         JOIN participations pa ON pa.id = t.participation_id
         JOIN participants pt   ON pt.id = pa.participant_id
        WHERE pa.project_id = $1 AND pt.name = $2 AND t.revoked_at IS NULL`,
      [A.project.id, SHARED],
    );
    check(
      Number(r.rows[0].count) === 2,
      `1 the OLD name-only predicate reaches ${r.rows[0].count} live tokens across two humans (expected 2)`,
    );
  }

  // 2. The resolver REFUSES the ambiguous name instead of picking one.
  {
    let threw = "";
    try {
      await resolveOneParticipant(A.project.id, SHARED, "admin_revoke");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(threw !== "", "2a an ambiguous name is refused, not resolved");
    check(threw.includes("ambiguous"), `2b the refusal says why: ${threw}`);
    // The refusal must NAME them - "ambiguous" alone leaves the admin unable to act on it.
    check(
      threw.includes("/" + SHARED),
      `2c the refusal names the qualified actors so the caller can see whose access was at stake: ${threw}`,
    );
  }

  // 3. An UNAMBIGUOUS name still resolves, and reports the qualified identity rather than the bare name.
  // Without this the guard could pass by refusing everything.
  {
    const solo = await resolveOneParticipant(A.project.id, "tester", "admin_revoke");
    check(solo !== null, "3a a unique name resolves rather than reading as absent");
    check(solo?.participationId === A.participation.id, "3b it resolves to the right seat");
    check(
      (solo?.actor ?? "").includes("/tester"),
      `3c the reply carries the QUALIFIED actor, not just the typed name: ${solo?.actor}`,
    );
  }

  // 4. Dropping one side of the collision makes the name usable again - the guard tracks the real state
  // rather than latching on a name it once saw as ambiguous.
  {
    await pool.query(`DELETE FROM participations WHERE id = $1`, [theirs]);
    const now = await resolveOneParticipant(A.project.id, SHARED, "admin_revoke");
    check(now?.participationId === mine, "4a once the collision is gone the name resolves to the remaining seat");
    // 5. A name that is not here at all reads as ABSENT, not as an error - the contract admin_revoke's
    // `revoked: 0` rests on, and what makes a name from another project indistinguishable from one that
    // exists nowhere (no existence oracle, invariant 1).
    const nobody = await resolveOneParticipant(A.project.id, "no-such-agent-anywhere", "admin_revoke");
    check(nobody === null, "5 an unknown name resolves to null, so the caller can keep its own contract");
  }

  await closePool();
  if (errors.length) {
    console.error("FAIL admin.namecollision:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(
    "OK admin.namecollision: two HUMANS can legally own a participant with the same name and both sit in " +
      "one project (participants is unique on owner_id+name, not name) - and the predicate admin_revoke " +
      "used reaches BOTH their live tokens, which is asserted here rather than assumed. The resolver now " +
      "REFUSES an ambiguous name and names the qualified actors instead of revoking or re-tokening an " +
      "arbitrary one; a unique name still resolves and reports the qualified actor, so the guard cannot " +
      "pass by refusing everything; and removing one side makes the name usable again.",
  );
}

void main();
