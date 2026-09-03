import { freshProject, createParticipation, siblingProject, setDriver } from "./_setup.js";
import { closePool, getPool, withTx, query } from "../src/db.js";
import { post, readPosts, unreadCount } from "../src/domain/post.js";
import {
  listProjects,
  resolveProject,
  UnreachableProjectError,
  AmbiguousProjectError,
  SuspendedProjectError,
} from "../src/domain/projects.js";

// One connection, many projects (decision 070).
//
// The token no longer IS the scope; it resolves to an identity, and that identity's memberships are its
// reach. Two things have to hold at once, and they are opposite failures of the same rule:
//
//   REACH   - a project you have been added to is workable from the token you already have, with no
//             second token minted and no connection re-configured. That is the whole point of the change.
//   REFUSAL - a project you have NOT been added to stays exactly as unreachable as it was before, and the
//             refusal must not double as an existence oracle (invariant 1).
//
// Every reach assertion here is PAIRED with a refusal, and every refusal with a positive control, because
// "you cannot reach it" passes just as happily when the resolver can reach nothing at all.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}
async function refuses(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}
async function setHandle(ownerId: number, handle: string): Promise<void> {
  await getPool().query(`UPDATE owners SET username = $2 WHERE id = $1`, [ownerId, handle]);
}

async function main(): Promise<void> {
  // ── 1. Reach: a second project under the same owner is workable from the first project's token ─────
  const a = await freshProject("mp-home");
  const b = await siblingProject(a, "mp-second");

  const inB = await resolveProject(a, b.project.slug);
  check(inB.project.id === b.project.id, "a sibling project resolves from the home token");
  check(
    inB.participation.id === b.participation.id,
    "and it acts as the membership THERE, not as the home membership",
  );

  const bobB = await createParticipation(b, "bob-b");
  const sent = await withTx((c) => post(c, inB, { to_actor: "bob-b", body: "work in the second project" }));
  const landedIn = await query<{ project_id: string }>(`SELECT project_id FROM posts WHERE id = $1`, [sent.post_id]);
  check(
    Number(landedIn.rows[0].project_id) === b.project.id,
    "a post written through the resolved ctx lands in the SECOND project",
  );
  const homeFeed = await readPosts(a, {});
  check(
    !homeFeed.some((p) => p.post_id === sent.post_id),
    "and is absent from the home project - switching projects must not leak the write back",
  );
  check((await readPosts(bobB, { to_me: true })).some((p) => p.post_id === sent.post_id), "bob receives it in B");

  // Positive control: the same call WITHOUT switching stays home. Without this, section 1 would pass even
  // if resolveProject silently returned the home ctx and the post had gone nowhere near B.
  const homeSent = await withTx((c) => post(c, a, { to_actor: "tester", body: "stays home" }));
  const homeLanded = await query<{ project_id: string }>(`SELECT project_id FROM posts WHERE id = $1`, [
    homeSent.post_id,
  ]);
  check(
    Number(homeLanded.rows[0].project_id) === a.project.id,
    "positive control: an unswitched call still writes to the home project",
  );

  // ── 2. Refusal is not an existence oracle ──────────────────────────────────────────────────────────
  // A project that EXISTS but is not yours must be indistinguishable from one that does not exist at all.
  const stranger = await freshProject("mp-stranger");
  const realButForeign = await refuses(() => resolveProject(a, stranger.project.slug));
  const pureFiction = await refuses(() => resolveProject(a, "no-such-project-anywhere"));
  check(realButForeign instanceof UnreachableProjectError, "a foreign project is refused");
  check(pureFiction instanceof UnreachableProjectError, "a nonexistent project is refused");
  const normalise = (e: Error | null, asked: string) => (e?.message ?? "").split(asked).join("<ASKED>");
  check(
    normalise(realButForeign, stranger.project.slug) === normalise(pureFiction, "no-such-project-anywhere"),
    "the two refusals must be the SAME message once the asked name is removed - any difference tells an " +
      "outsider whether a project exists (invariant 1). " +
      `Got:\n    ${realButForeign?.message}\n    ${pureFiction?.message}`,
  );
  check(
    !(realButForeign?.message ?? "").includes(stranger.project.name) || stranger.project.name === stranger.project.slug,
    "the refusal never leaks the foreign project's display name",
  );

  // Decision 077: reach follows the AGENT's own seats, so a fixture that used to bridge two owners through
  // the driving human must now give the acting participant a real seat there - which is what an owner adding
  // your agent actually does. Returns the new participation id.
  const addSeat = async (projectId: number, participantId: number, driver: number | null, isAdmin = false): Promise<number> => {
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO participations (participant_id, project_id, is_admin, human_owner_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (participant_id, project_id) DO UPDATE SET is_admin = EXCLUDED.is_admin RETURNING id`,
      [participantId, projectId, isAdmin, driver],
    );
    return Number(r.rows[0].id);
  };

  // ── 3. Two of your projects share a slug: refuse rather than guess ─────────────────────────────────
  const human = await freshProject("mp-human-owner");
  const humanId = human.project.ownerId;
  const dual1 = await freshProject("mp-dual");
  await setHandle(dual1.project.ownerId, `h1${dual1.project.slug.slice(-8)}`);
  const dualHome = await setDriver(dual1, humanId);
  // A second owner, a project with the SAME slug, driven by the same human.
  const otherOwner = await freshProject("mp-dual-other");
  await setHandle(otherOwner.project.ownerId, `h2${otherOwner.project.slug.slice(-8)}`);
  await getPool().query(`UPDATE projects SET slug = $2, name = $2 WHERE id = $1`, [
    otherOwner.project.id,
    dual1.project.slug,
  ]);
  await getPool().query(`UPDATE participations SET human_owner_id = $2 WHERE id = $1`, [
    otherOwner.participation.id,
    humanId,
  ]);
  // The ambiguity that matters is still real under 077 - it just has to be built the way it now arises:
  // THIS agent holding a seat in two projects that share a slug under different owners.
  await addSeat(otherOwner.project.id, dualHome.participant.id, humanId);

  const ambiguous = await refuses(() => resolveProject(dualHome, dual1.project.slug));
  check(ambiguous instanceof AmbiguousProjectError, `a slug held twice is refused, not guessed. Got: ${ambiguous}`);
  const h1 = `h1${dual1.project.slug.slice(-8)}`;
  const qualified = await resolveProject(dualHome, `${h1}/${dual1.project.slug}`);
  check(
    qualified.project.id === dual1.project.id,
    "positive control: the qualified <handle>/<slug> form resolves the ambiguity",
  );

  // ── 4. A token NEVER borrows another agent's seat, even one the same human drives (decision 077) ────
  // This replaces the old "cross-owner reach travels on the driving human" case, which was the escalation:
  // reach used to include every seat bound to the same HUMAN, whichever agent held it, and the resolved ctx
  // is composed from the row that is reached - so landing on another agent's seat handed over that agent's
  // NAME and its is_admin flag. A token minted for a deliberately non-admin agent acted as an admin agent
  // elsewhere. Measured on prod before the fix: 10 live tokens, every one an admin key to four projects.
  //
  // The escalation shape is reproduced EXACTLY here (different agent, same human, admin over there) rather
  // than a generic refusal, because the generic version passes just as happily when reach is broken outright.
  const guestHome = await freshProject("mp-guest");
  const guest = await setDriver(guestHome, humanId);
  // freshProject makes you admin at home; the escalation shape needs a caller that is NOT.
  await getPool().query(`UPDATE participations SET is_admin = false WHERE id = $1`, [guest.participation.id]);
  guest.participation.isAdmin = false;
  const hosted = await siblingProject(guest, "mp-hosted", { ownerId: stranger.project.ownerId, humanOwnerId: humanId, isAdmin: true });
  check(
    hosted.participant.id !== guest.participant.id,
    "precondition: a different owner means a DIFFERENT participant row - this is another AGENT's seat",
  );
  check(
    guest.participation.isAdmin === false && hosted.participation.isAdmin === true,
    "precondition: the caller is NOT admin at home and the seat it must not reach IS admin",
  );
  const borrowed = await refuses(() => resolveProject(guest, hosted.project.slug));
  check(
    borrowed instanceof UnreachableProjectError,
    `another AGENT's seat is not reachable, even driven by the same human. Got: ${borrowed}`,
  );
  // Positive control on the same fixture: add THIS agent to that project and it becomes reachable - so the
  // refusal above is about whose seat it is, not about the project being unreachable for any reason.
  const ownSeat = await getPool().query<{ id: string }>(
    `INSERT INTO participations (participant_id, project_id, is_admin, human_owner_id) VALUES ($1,$2,false,$3)
     RETURNING id`,
    [guest.participant.id, hosted.project.id, humanId],
  );
  const nowMine = await resolveProject(guest, hosted.project.slug);
  check(
    nowMine.participation.id === Number(ownSeat.rows[0].id),
    "positive control: once THIS agent has its own seat there, the same project resolves - to ITS OWN seat",
  );
  check(
    nowMine.participation.isAdmin === false && nowMine.participant.id === guest.participant.id,
    "and it acts as ITSELF with its own privileges, never as the admin agent sitting in the same project",
  );

  // ── 4b. An UNCLAIMED seat of the same agent is reachable ───────────────────────────────────────────
  // Most provisioned memberships have no driving human at all (they were minted, not invited). If arm 1
  // demanded an exact driver match, a bound token would not reach its own agent's unbound memberships -
  // which is the majority of the fleet, so the feature would appear to work and mostly not.
  const boundHome = await setDriver(await freshProject("mp-bound"), humanId);
  const unclaimed = await siblingProject(boundHome, "mp-unclaimed", { humanOwnerId: null });
  check(
    (await resolveProject(boundHome, unclaimed.project.slug)).project.id === unclaimed.project.id,
    "a bound token reaches its own agent's UNCLAIMED membership",
  );

  // ── 5. The driver guard: a seat whose driver differs never bridges two humans ──────────────────────
  const other = await freshProject("mp-other-human");
  const otherHumanId = other.project.ownerId;
  const guarded = await freshProject("mp-guarded");
  const guardedHome = await setDriver(guarded, humanId);
  const foreignDriver = await siblingProject(guardedHome, "mp-foreign-driver", { humanOwnerId: otherHumanId });
  check(
    foreignDriver.participant.id === guardedHome.participant.id,
    "precondition: same owner, so this IS the same participant row - only the driver differs",
  );
  const bridged = await refuses(() => resolveProject(guardedHome, foreignDriver.project.slug));
  check(
    bridged instanceof UnreachableProjectError,
    `a membership of the same participant driven by ANOTHER human is not reachable. Got: ${bridged}`,
  );
  // Positive control: flip only the driver to match, and the very same project becomes reachable. Without
  // this the check above would pass even if arm 1 of the reach predicate were broken outright.
  await getPool().query(`UPDATE participations SET human_owner_id = $2 WHERE id = $1`, [
    foreignDriver.participation.id,
    humanId,
  ]);
  const nowReachable = await resolveProject(guardedHome, foreignDriver.project.slug);
  check(
    nowReachable.project.id === foreignDriver.project.id,
    "positive control: matching the driver makes that same project reachable",
  );

  // The same guard from the other side: a token with NO driver must not reach a seat someone IS bound to.
  // 4b deliberately allows an unclaimed TARGET, so this is the direction that keeps that from meaning
  // "unbound tokens go anywhere their participant was ever invited".
  const unbound = await freshProject("mp-unbound-caller");
  check(unbound.participation.humanOwnerId === null, "precondition: the caller has no driver");
  const claimedByOther = await siblingProject(unbound, "mp-claimed-by-other", { humanOwnerId: otherHumanId });
  const upBridge = await refuses(() => resolveProject(unbound, claimedByOther.project.slug));
  check(
    upBridge instanceof UnreachableProjectError,
    `a driver-less token must not reach a seat BOUND to a human. Got: ${upBridge}`,
  );

  // ── 6. A driver-less token reaches only its OWN participant's rows ─────────────────────────────────
  // Arm 2 is null-guarded; without that guard, every unbound membership on the platform would match every
  // other unbound token, which is a cross-tenant breach rather than a convenience.
  const orphanHome = await freshProject("mp-orphan");
  check(orphanHome.participation.humanOwnerId === null, "precondition: this token has no driving human");
  const unboundElsewhere = await freshProject("mp-unbound-elsewhere");
  check(unboundElsewhere.participation.humanOwnerId === null, "precondition: so does the other one");
  const notMine = await refuses(() => resolveProject(orphanHome, unboundElsewhere.project.slug));
  check(
    notMine instanceof UnreachableProjectError,
    `a driver-less token must NOT reach another driver-less membership. Got: ${notMine}`,
  );
  const ownSibling = await siblingProject(orphanHome, "mp-orphan-sibling");
  check(
    (await resolveProject(orphanHome, ownSibling.project.slug)).project.id === ownSibling.project.id,
    "positive control: it still reaches its own participant's other project",
  );

  // ── 7. Suspension is re-checked against the TARGET project's owner ─────────────────────────────────
  // One connection can now span owners, so a gate applied only at connect would let a suspended tenant be
  // written to through a healthy tenant's token.
  const payer = await freshProject("mp-payer");
  const payerHome = await setDriver(payer, humanId);
  const debtor = await siblingProject(payerHome, "mp-debtor", { ownerId: other.project.ownerId, humanOwnerId: humanId });
  // Under 077 the payer's agent reaches the debtor project only through its OWN seat there (an owner adding
  // it), not through the shared human - so the gate is exercised on a membership that really exists.
  await addSeat(debtor.project.id, payerHome.participant.id, humanId);
  const wasBetaFree = process.env.BETA_FREE;
  delete process.env.BETA_FREE;
  await getPool().query(`UPDATE owners SET suspended_at = now(), plan = 'free' WHERE id = $1`, [other.project.ownerId]);
  try {
    const blocked = await refuses(() => resolveProject(payerHome, debtor.project.slug));
    check(
      blocked instanceof SuspendedProjectError,
      `a suspended target project is refused, distinctly from unreachable. Got: ${blocked}`,
    );
    check(
      (await resolveProject(payerHome, payerHome.project.slug)).project.id === payerHome.project.id,
      "positive control: the healthy home project still works while the other is blocked",
    );
    check(
      (await listProjects(payerHome)).find((p) => p.project === debtor.project.slug)?.suspended === true,
      "and list_projects marks it suspended rather than hiding it",
    );
  } finally {
    await getPool().query(`UPDATE owners SET suspended_at = NULL WHERE id = $1`, [other.project.ownerId]);
    if (wasBetaFree !== undefined) process.env.BETA_FREE = wasBetaFree;
  }

  // ── 7b. TWO SEATS IN ONE PROJECT resolve to you, not to an unfollowable instruction ────────────────
  // Found in prod data, not in a test: one human drives both `agent-two` and `agent-one` in the
  // project `owner-workspace`, so the raw reach query returns that project TWICE. Treated as ambiguity it would be
  // refused with "name it in full" - and the qualified form resolves to the same two rows, so the advice
  // cannot be followed and the project is unreachable. The project is not ambiguous; only the seat is.
  const twoSeats = await freshProject("mp-two-seats");
  const seatHome = await setDriver(twoSeats, humanId);
  const shared = await siblingProject(seatHome, "mp-shared-project", { humanOwnerId: humanId });
  // A SECOND seat in that same project, a different participant, driven by the same human -> also reachable.
  const otherSeat = await createParticipation(shared, "other-seat");
  await getPool().query(`UPDATE participations SET human_owner_id = $2 WHERE id = $1`, [
    otherSeat.participation.id,
    humanId,
  ]);
  const resolvedShared = await resolveProject(seatHome, shared.project.slug);
  check(
    resolvedShared.project.id === shared.project.id,
    `a project where you hold two seats must still resolve, not refuse as ambiguous. Got: ${resolvedShared.project.slug}`,
  );
  check(
    resolvedShared.participation.id === shared.participation.id,
    "and it resolves to YOUR OWN seat, never another of your identity's seats",
  );
  const sharedListed = (await listProjects(seatHome)).filter((p) => p.project === shared.project.slug);
  check(
    sharedListed.length === 1,
    `list_projects must show that project ONCE, not once per seat, got ${sharedListed.length}`,
  );
  check(
    sharedListed[0]?.you === shared.actor || (sharedListed[0]?.you ?? "").endsWith(seatHome.participant.name),
    `and the row names YOUR seat, got ${JSON.stringify(sharedListed[0]?.you)}`,
  );

  // ── 8. list_projects shows exactly the reach, and what is waiting in each ──────────────────────────
  const listed = await listProjects(a);
  const slugs = listed.map((p) => p.project).sort();
  check(
    JSON.stringify(slugs) === JSON.stringify([a.project.slug, b.project.slug].sort()),
    `list_projects lists exactly the reachable set, got ${JSON.stringify(slugs)}`,
  );
  check(
    !listed.some((p) => p.project === stranger.project.slug),
    "and never a project this identity is not a member of",
  );
  check(listed.filter((p) => p.is_default).length === 1, "exactly one project is flagged as the default");
  check(listed.find((p) => p.is_default)?.project === a.project.slug, "and it is the token's own project");

  // The per-project count must agree with the number the per-call nudge shows, since both are what an
  // agent uses to decide there is nothing waiting. Same function, so this guards the wiring, not the maths.
  await withTx((c) => post(c, bobB, { to_actor: "tester", body: "waiting for you in the second project" }));
  const relisted = await listProjects(a);
  const bRow = relisted.find((p) => p.project === b.project.slug);
  check((bRow?.unread_posts ?? 0) >= 1, `unread in the OTHER project is surfaced, got ${bRow?.unread_posts}`);
  check(
    bRow?.unread_posts === (await unreadCount(inB)),
    "and it equals the count the nudge would show there - two ways to count the same thing is how they drift",
  );

  // ── 9. Your role is per project ────────────────────────────────────────────────────────────────────
  // freshProject makes you admin at home; siblingProject defaults you to a plain member.
  check(a.participation.isAdmin, "precondition: admin at home");
  check(
    (await resolveProject(a, b.project.slug)).participation.isAdmin === false,
    "admin at home does NOT make you admin in another project - the flag follows the membership",
  );
  const adminThere = await siblingProject(a, "mp-admin-there", { isAdmin: true });
  check(
    (await resolveProject(a, adminThere.project.slug)).participation.isAdmin === true,
    "positive control: where the membership IS admin, the resolved ctx says so",
  );

  if (errors.length) {
    console.error("FAIL multiproject:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log(
    "OK multiproject: one token reaches every project ITS OWN AGENT is a member of and acts there as that " +
      "membership (decision 077). A seat belonging to ANOTHER agent is refused even when the same human " +
      "drives it - the escalation that let a non-admin token act as an admin agent elsewhere - and the " +
      "positive control proves the same project resolves once THIS agent has its own seat there. A project " +
      "it is NOT in is refused with a message identical to one for a project that does not exist; a slug " +
      "held twice is refused rather than guessed and the qualified form resolves it; a seat driven by " +
      "another human never bridges the two; a driver-less token reaches only its own participant's rows; " +
      "suspension is re-checked against the target owner; list_projects shows exactly the reach with " +
      "per-project unread agreeing with the nudge; the admin flag follows the membership. Every refusal is " +
      "paired with a positive control.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(closePool);
