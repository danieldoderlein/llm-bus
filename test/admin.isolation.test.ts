// Cross-owner isolation: owner B must never read or mutate owner A's data. Every owner-scoped
// query is the authorization boundary, so we exercise it directly with two real owners.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { resolveOwner } from "../src/admin/owner.js";
import {
  createProject,
  createParticipant,
  grant,
  loadOwnedProject,
  listProjects,
  listParticipations,
  revokeParticipation,
  loadOwnedParticipant,
  renameParticipant,
  deleteParticipant,
  renameProject,
  deleteProject,
  setParticipationAdmin,
} from "../src/admin/queries.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const tag = randomUUID().slice(0, 8);

  const a = await resolveOwner(`iso-a-${tag}@test.local`);
  const b = await resolveOwner(`iso-b-${tag}@test.local`);
  check(a.id !== b.id, "two owners collapsed to one id");

  // Owner A: project + participant + grant (active token).
  const aProject = await createProject(a.id, `iso-a-${tag}`, `Iso A ${tag}`);
  const aParticipant = await createParticipant(a.id, `a-agent-${tag}`, "agent");
  const aGrant = await grant(a.id, aProject.id, aParticipant.id, "backend", false);
  check(aGrant !== null, "owner A grant failed");
  if (!aGrant) {
    finish();
    return;
  }

  // Owner B: their own project + participant (used to prove B is a real, populated owner).
  const bProject = await createProject(b.id, `iso-b-${tag}`, `Iso B ${tag}`);
  await createParticipant(b.id, `b-agent-${tag}`, "agent");

  // 1) As B, loading A's project returns null (no 403 oracle).
  const crossLoad = await loadOwnedProject(b.id, aProject.id);
  check(crossLoad === null, "owner B could load owner A's project");

  // 2) As B, listParticipations on A's project returns nothing (owner-scoped join).
  const crossParts = await listParticipations(b.id, aProject.id);
  check(crossParts.length === 0, `owner B saw A's participations: ${JSON.stringify(crossParts)}`);

  // 3) As B, revoking A's participation is a no-op AND A's token still works.
  const revoked = await revokeParticipation(b.id, aGrant.participation.id);
  check(revoked === 0, `cross-owner revoke affected ${revoked} tokens (must be 0)`);
  const ctxStillValid = await authenticate(`Bearer ${aGrant.plaintextToken}`);
  check(ctxStillValid !== null, "owner A's token was killed by owner B's revoke attempt");
  check(
    ctxStillValid?.project.id === aProject.id,
    `A's token resolves to the wrong project after B's attempt: ${ctxStillValid?.project.id}`,
  );

  // 4) listProjects(B) excludes A's project and includes B's own.
  const bProjects = await listProjects(b.id);
  check(
    !bProjects.some((p) => p.id === aProject.id),
    "listProjects(B) leaked owner A's project",
  );
  check(
    bProjects.some((p) => p.id === bProject.id),
    "listProjects(B) is missing owner B's own project",
  );

  // 5) Symmetry: A cannot load B's project either.
  const reverseLoad = await loadOwnedProject(a.id, bProject.id);
  check(reverseLoad === null, "owner A could load owner B's project");

  // 6) The new mutators are owner-scoped too: B cannot rename or delete A's project/participant.
  check((await loadOwnedParticipant(b.id, aParticipant.id)) === null, "owner B could load owner A's participant");
  check((await renameParticipant(b.id, aParticipant.id, `hijacked-${tag}`)) === "notfound", "owner B renamed owner A's participant");
  check((await renameProject(b.id, aProject.id, "Hijacked", `hijacked-${tag}`)) === "notfound", "owner B renamed owner A's project");
  check((await deleteParticipant(b.id, aParticipant.id)) === false, "owner B deleted owner A's participant");
  check((await deleteProject(b.id, aProject.id)) === false, "owner B deleted owner A's project");
  check((await setParticipationAdmin(b.id, aGrant.participation.id, true)) === false, "owner B promoted owner A's participation");
  // A's resources survived every cross-owner attempt.
  check((await loadOwnedProject(a.id, aProject.id)) !== null, "owner A's project vanished after B's attempts");
  const ctxFinal = await authenticate(`Bearer ${aGrant.plaintextToken}`);
  check(
    ctxFinal !== null && ctxFinal.participant.name === `a-agent-${tag}` && ctxFinal.participation.isAdmin === false,
    "owner A's participant/token was corrupted by owner B's attempts",
  );

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL admin.isolation:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK admin.isolation: B cannot load/list A's project, cross-owner revoke is a no-op and A's token " +
      "still authenticates, listProjects is owner-partitioned, isolation is symmetric, and B cannot " +
      "rename/delete A's project or participant (A's resources survive intact).",
  );
  void closePool();
}

main().catch((err) => {
  console.error("admin.isolation test errored:", err);
  process.exit(1);
});
