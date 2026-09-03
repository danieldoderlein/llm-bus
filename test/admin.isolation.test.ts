// Cross-owner isolation: owner B must never read or mutate owner A's data. Every owner-scoped
// query is the authorization boundary, so we exercise it directly with two real owners.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool, withTx, getPool } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { resolveOwner } from "../src/admin/owner.js";
import { taskCreate, taskStart, taskBlock } from "../src/domain/task.js";
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
  setParticipationLane,
  loadProjectBoard,
  ownerNeedsYou,
} from "../src/admin/queries.js";
import { listInvites } from "../src/invite.js";

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

  // 2b) The queries behind the new project sub-routes (decision 023) are equally owner-scoped: B, hitting
  // A's project id on the Access (invites, requests) and Board queries, sees nothing (no cross-tenant leak).
  check((await listInvites(b.id, aProject.id)).length === 0, "owner B saw A's invites");
  const crossBoard = await loadProjectBoard(b.id, aProject.id);
  check(crossBoard.tasks.length === 0 && crossBoard.decisions.length === 0, "owner B saw A's board");

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
  // Same for the routing lane (decision 065): owner B cannot re-lane A's agent, and the false it gets back
  // is byte-identical to what a nonexistent id returns - no existence oracle (invariant 3).
  check((await setParticipationLane(b.id, aGrant.participation.id, "hijack")) === false, "owner B re-laned owner A's participation");
  check((await setParticipationLane(b.id, 999999999, "hijack")) === false, "a nonexistent participation must look the same");
  // Positive control: A's own owner CAN, so the refusal above is a real boundary and not a broken query.
  check((await setParticipationLane(a.id, aGrant.participation.id, "ops")) === true, "owner A could not set its own participation's lane");
  // A's resources survived every cross-owner attempt.
  check((await loadOwnedProject(a.id, aProject.id)) !== null, "owner A's project vanished after B's attempts");
  const ctxFinal = await authenticate(`Bearer ${aGrant.plaintextToken}`);
  check(
    ctxFinal !== null && ctxFinal.participant.name === `a-agent-${tag}` && ctxFinal.participation.isAdmin === false,
    "owner A's participant/token was corrupted by owner B's attempts",
  );

  // 8) ownerNeedsYou project filter (FIX B): the /admin/review project filter must narrow the "Also needs
  // you" section too, not only the reviews. Give owner A a SECOND project, put one blocked task in each of A's
  // two projects, then prove: unfiltered -> both; projectId=P1 -> only P1's; projectId=P2 -> only P2's; and the
  // owner boundary (invariant 3) HOLDS through the new projectId path - B filtering to A's project sees nothing.
  const aProject2 = await createProject(a.id, `iso-a2-${tag}`, `Iso A2 ${tag}`);
  const aAgent2 = await createParticipant(a.id, `a-agent2-${tag}`, "agent");
  const aGrant2 = await grant(a.id, aProject2.id, aAgent2.id, "backend", false);
  const ctxA2 = aGrant2 ? await authenticate(`Bearer ${aGrant2.plaintextToken}`) : null;
  const ctxA8 = await authenticate(`Bearer ${aGrant.plaintextToken}`);
  check(ctxA2 !== null && ctxA8 !== null, "the FIX B setup grants must authenticate");
  if (ctxA2 && ctxA8) {
    const blockOne = async (ctx: NonNullable<typeof ctxA2>, agentName: string, label: string): Promise<void> => {
      const on = await withTx((c) => taskCreate(c, ctx, { title: `blocker-${label}-${tag}` }));
      const victim = await withTx((c) => taskCreate(c, ctx, { title: `blocked-${label}-${tag}`, owner: agentName }));
      await withTx((c) => taskStart(c, ctx, { task_id: victim.task_id }));
      await withTx((c) => taskBlock(c, ctx, { task_id: victim.task_id, reason: "waiting", unblock_condition: "legal signs off", unblock_owner: ctx.participant.name }));
    };
    await blockOne(ctxA8, `a-agent-${tag}`, "P1"); // blocked task in aProject
    await blockOne(ctxA2, `a-agent2-${tag}`, "P2"); // blocked task in aProject2

    // Unfiltered: owner A sees the blocked task from BOTH of their projects.
    const allNeeds = await ownerNeedsYou(a.id);
    const allTitles = allNeeds.blocked.map((x) => x.title);
    check(
      allTitles.includes(`blocked-P1-${tag}`) && allTitles.includes(`blocked-P2-${tag}`),
      `unfiltered ownerNeedsYou must include blocked tasks from BOTH A projects, got ${JSON.stringify(allTitles)}`,
    );

    // projectId narrows the blocked bucket to that ONE project (within the owner's projects, invariant 3 kept).
    const p1Needs = await ownerNeedsYou(a.id, { projectId: aProject.id });
    check(
      p1Needs.blocked.length > 0 && p1Needs.blocked.every((x) => x.projectId === aProject.id),
      `projectId=aProject must narrow the blocked bucket to that project only, got ${JSON.stringify(p1Needs.blocked)}`,
    );
    check(
      p1Needs.blocked.some((x) => x.title === `blocked-P1-${tag}`) && !p1Needs.blocked.some((x) => x.title === `blocked-P2-${tag}`),
      "the project filter must keep P1's blocked task and drop P2's",
    );
    const p2Needs = await ownerNeedsYou(a.id, { projectId: aProject2.id });
    check(
      p2Needs.blocked.length > 0 && p2Needs.blocked.every((x) => x.projectId === aProject2.id) && p2Needs.blocked.some((x) => x.title === `blocked-P2-${tag}`),
      `projectId=aProject2 must narrow the blocked bucket to P2 only, got ${JSON.stringify(p2Needs.blocked)}`,
    );

    // Owner isolation (invariant 3) holds THROUGH the new projectId path: B filtering to A's project id sees
    // NOTHING in any bucket (the projectId narrows within B's projects; A's project is not one of them).
    const bFilteredToA = await ownerNeedsYou(b.id, { projectId: aProject.id });
    check(
      bFilteredToA.blocked.length === 0 && bFilteredToA.unacked.length === 0,
      `owner B must see NOTHING even when filtering ownerNeedsYou to owner A's project, got ${JSON.stringify(bFilteredToA)}`,
    );
  }

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
      "still authenticates, listProjects is owner-partitioned, isolation is symmetric, B cannot " +
      "rename/delete A's project or participant, and A's resources survive intact; ownerNeedsYou's projectId " +
      "filter narrows the 'needs you' buckets to one project while staying owner-scoped (B filtering to A's " +
      "project sees nothing).",
  );
  void closePool();
}

main().catch((err) => {
  console.error("admin.isolation test errored:", err);
  process.exit(1);
});
