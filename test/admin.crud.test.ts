// Importing _setup first establishes the default DATABASE_URL (its top-level side effect) before
// db.ts is loaded by any admin module. We don't use freshProject here — the admin layer creates
// its own owners via resolveOwner — but the import wiring guarantees the DB env is set.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool, query } from "../src/db.js";
import { authenticate, hashToken } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { resolveOwner } from "../src/admin/owner.js";
import {
  createProject,
  createParticipant,
  grant,
  loadOwnedProject,
  listParticipations,
  setParticipationAdmin,
  setParticipationLane,
} from "../src/admin/queries.js";
import { handoutCard, projectAccessPage } from "../src/admin/html.js";
import { createInvite, listInvites } from "../src/invite.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const owner = await resolveOwner(`crud-${tag}@test.local`);
  check(Number.isInteger(owner.id) && owner.id > 0, `owner id not set: ${JSON.stringify(owner)}`);

  // resolveOwner is idempotent.
  const owner2 = await resolveOwner(`crud-${tag}@test.local`);
  check(owner2.id === owner.id, `resolveOwner not idempotent: ${owner.id} vs ${owner2.id}`);

  const project = await createProject(owner.id, `crud-${tag}`, `Crud ${tag}`);
  check(Number.isInteger(project.id) && project.id > 0, `project not created: ${JSON.stringify(project)}`);

  const participant = await createParticipant(owner.id, `agent-${tag}`, "agent");
  check(participant.kind === "agent", `participant kind: ${JSON.stringify(participant)}`);

  // Grant -> a participation + a minted token.
  const result = await grant(owner.id, project.id, participant.id, "backend", false);
  check(result !== null, "grant returned null");
  if (!result) {
    fail();
    return;
  }
  check(
    Number.isInteger(result.participation.id) && result.participation.id > 0,
    `participation not created: ${JSON.stringify(result.participation)}`,
  );
  check(result.participation.lane === "backend", `lane not set: ${result.participation.lane}`);
  check(typeof result.plaintextToken === "string" && result.plaintextToken.length >= 20,
    `token looks wrong: ${result.plaintextToken}`);
  check(!result.alreadyConnected, "a brand-new agent's FIRST grant must mint - it has nothing to connect with");
  const firstToken = result.plaintextToken ?? "";

  // The plaintext token authenticates and resolves to THIS project/participation.
  const ctx = await authenticate(`Bearer ${firstToken}`);
  check(ctx !== null, "authenticate returned null for a freshly minted token");
  if (ctx) {
    check(ctx.project.id === project.id, `ctx project mismatch: ${ctx.project.id} vs ${project.id}`);
    check(
      ctx.participation.id === result.participation.id,
      `ctx participation mismatch: ${ctx.participation.id} vs ${result.participation.id}`,
    );
    check(ctx.participant.name === `agent-${tag}`, `ctx participant name: ${ctx.participant.name}`);
    check(ctx.owner?.id === owner.id, `ctx owner mismatch: ${ctx.owner?.id} vs ${owner.id}`);
  }

  // The hand-out card HTML is self-contained: token + PUBLIC_URL/mcp + the one-command connect + protocol.
  const mcpUrl = `${loadConfig().PUBLIC_URL}/mcp`;
  const card = handoutCard(owner, project, participant.name, firstToken, mcpUrl, false);
  check(card.includes(firstToken), "hand-out card missing the plaintext token");
  check(card.includes(mcpUrl), `hand-out card missing the MCP url (${mcpUrl})`);
  check(
    card.includes(`claude mcp add --transport http llm-bus ${mcpUrl} --header`),
    "hand-out card missing the deterministic `claude mcp add` connect command",
  );
  check(card.includes("coordination protocol"), "hand-out card missing the coordination protocol");
  check(card.includes("OKF") && card.includes("okf/SPEC.md"), "hand-out card missing the OKF knowledge-layer pointer");
  check(!card.includes("you onboard teammates"), "non-admin card should NOT include admin powers");
  // The admin (lead) variant additionally embeds the admin powers.
  const adminCard = handoutCard(owner, project, participant.name, firstToken, mcpUrl, true);
  check(adminCard.includes("create_invite") && adminCard.toLowerCase().includes("admin (lead)"),
    "admin hand-out card missing the lead/admin powers");

  // Legacy open invites still LIST + revoke on the Access page (createInvite/listInvites retained; decision
  // 037 retired only the /join redemption + the create UI). Guards the expiresAt `.slice` render on the row.
  const inv = await createInvite(owner.id, project.id, { ttlHours: 24 });
  check(inv !== null, "createInvite returned null");
  const invites = await listInvites(owner.id, project.id);
  check(invites.some((i) => i.code === inv!.code), "listInvites missing the new invite");
  const projHtml = projectAccessPage(owner, project, [], invites, [], "csrf-x");
  check(projHtml.includes(inv!.code), "project Access page did not render the invite row");

  // loadOwnedProject sees it.
  const loaded = await loadOwnedProject(owner.id, project.id);
  check(loaded !== null && loaded.id === project.id, "loadOwnedProject failed for an owned project");

  // listParticipations shows the active token.
  const parts = await listParticipations(owner.id, project.id);
  const row = parts.find((p) => p.participationId === result.participation.id);
  check(row !== undefined && row.tokenActive === true, `participation not listed active: ${JSON.stringify(parts)}`);

  // Promote/demote the lead flag -> the token resolves admin true/false on the next auth.
  check((await setParticipationAdmin(owner.id, result.participation.id, true)) === true, "promote to lead failed");
  const promoted = await authenticate(`Bearer ${firstToken}`);
  check(promoted?.participation.isAdmin === true, "token not admin after promote");
  check((await setParticipationAdmin(owner.id, result.participation.id, false)) === true, "demote failed");
  const demoted = await authenticate(`Bearer ${firstToken}`);
  check(demoted?.participation.isAdmin === false, "token still admin after demote");

  // Decision 065: the lane ROUTES now, so it must be settable AND clearable. Every provisioning write uses
  // COALESCE(EXCLUDED.lane, participations.lane), so a NULL there can never clear one - without this path a
  // lane typo'd at provision time is a subscription the agent cannot leave.
  check((await setParticipationLane(owner.id, result.participation.id, "markting")) === true, "set lane failed");
  const laneSet = await query<{ lane: string | null }>(`SELECT lane FROM participations WHERE id = $1`, [
    result.participation.id,
  ]);
  check(laneSet.rows[0].lane === "markting", `expected lane 'markting', got ${laneSet.rows[0].lane}`);
  check((await setParticipationLane(owner.id, result.participation.id, "marketing")) === true, "correct lane failed");
  check((await setParticipationLane(owner.id, result.participation.id, null)) === true, "clear lane failed");
  const laneCleared = await query<{ lane: string | null }>(`SELECT lane FROM participations WHERE id = $1`, [
    result.participation.id,
  ]);
  check(laneCleared.rows[0].lane === null, `an empty lane must CLEAR it, got ${laneCleared.rows[0].lane}`);

  // Rotate -> mint-before-revoke: the OLD token stops authenticating, a NEW one works, same
  // participation, and exactly one active token remains (no lockout gap, no token pile-up).
  const { rotateParticipation } = await import("../src/admin/queries.js");
  const { getPool: poolForRotate } = await import("../src/db.js");
  const oldToken = result.plaintextToken;
  const rot = await rotateParticipation(owner.id, result.participation.id);
  check(rot !== null, "rotateParticipation returned null for an owned participation");
  if (rot) {
    check(rot.plaintextToken !== oldToken, "rotate did not mint a new token");
    check((await authenticate(`Bearer ${oldToken}`)) === null, "old token still authenticates after rotate");
    const nctx = await authenticate(`Bearer ${rot.plaintextToken}`);
    check(
      nctx !== null && nctx.participation.id === result.participation.id,
      "rotated token does not resolve to the same participation",
    );
    const active = await poolForRotate().query<{ n: string }>(
      `SELECT count(*)::int AS n FROM tokens WHERE participation_id = $1 AND revoked_at IS NULL`,
      [result.participation.id],
    );
    check(Number(active.rows[0].n) === 1, `expected exactly 1 active token after rotate, got ${active.rows[0].n}`);
  }
  // A non-owned rotate matches no row -> null (no 403 oracle).
  check(
    (await rotateParticipation(owner.id + 999999, result.participation.id)) === null,
    "rotate succeeded for a non-owner",
  );

  // Revoke -> authenticate now returns null (revokes whatever token is currently active).
  const { revokeParticipation } = await import("../src/admin/queries.js");
  const activeToken = rot ? rot.plaintextToken : result.plaintextToken;
  const revoked = await revokeParticipation(owner.id, result.participation.id);
  check(revoked >= 1, `expected >=1 token revoked, got ${revoked}`);
  const ctxAfter = await authenticate(`Bearer ${activeToken}`);
  check(ctxAfter === null, "authenticate still succeeds after revoke");

  // ── Adding an already-connected agent to a SECOND project mints nothing (decision 070) ──
  // The operator's complaint that started 070: granting access to another project handed back a token to
  // install, when the agent was already connected and one connection now reaches every project it belongs
  // to. The grant is the membership row; the secret is not part of it.
  const secondProject = await createProject(owner.id, `crud2-${tag}`, `Crud2 ${tag}`);
  const connected = await createParticipant(owner.id, `wired-${tag}`, "agent");
  const firstGrant = await grant(owner.id, project.id, connected.id, null, false);
  check(firstGrant?.plaintextToken != null, "precondition: the first grant mints (the agent has no token yet)");
  const secondGrant = await grant(owner.id, secondProject.id, connected.id, null, false);
  check(secondGrant !== null, "the second grant must succeed");
  check(
    secondGrant?.alreadyConnected === true && secondGrant?.plaintextToken === null,
    `granting an already-connected agent must NOT mint a second token, got ${JSON.stringify(secondGrant?.plaintextToken)}`,
  );
  check(
    Number.isInteger(secondGrant?.participation.id) && secondGrant?.participation.projectId === secondProject.id,
    "...but the membership itself IS created - that is the whole grant",
  );
  // Positive control: the token it already had now authenticates, and the reach rule opens the new project
  // to it. Without this, "no token minted" would pass just as happily if the grant had done nothing at all.
  const stillWorks = await authenticate(`Bearer ${firstGrant?.plaintextToken ?? ""}`);
  check(stillWorks !== null, "the agent's existing token still authenticates after the second grant");
  const { resolveProject: resolveTo } = await import("../src/domain/projects.js");
  if (stillWorks) {
    const there = await resolveTo(stillWorks, `crud2-${tag}`);
    check(
      there.project.id === secondProject.id,
      "and it reaches the newly granted project on that same token - no new token, no reconnect",
    );
  }

  // ── ...but "already connected" must mean CAN REACH, not merely HAS A TOKEN ──
  // The case above passes trivially because grant() bound BOTH seats to the same human. The seat an agent
  // actually arrives with is often UNBOUND (provisioned before human binding existed), and grant() binds
  // the new one to the granting human - so the driver guard, correctly, refuses to bridge them. Deciding
  // to mint on participant_id alone therefore skipped the token for exactly the agent that needed one, and
  // the admin card said it was ready. Reported live: the operator added this rig to a project and its
  // list_projects still showed one. Four such seats existed on prod, three holding live tokens that could
  // not reach their own membership.
  const legacyPart = await createParticipant(owner.id, `unbound-${tag}`, "agent");
  const legacyProject = await createProject(owner.id, `crud3-${tag}`, `Crud3 ${tag}`);
  const unboundPa = await query<{ id: string }>(
    `INSERT INTO participations (participant_id, project_id, human_owner_id) VALUES ($1, $2, NULL) RETURNING id`,
    [legacyPart.id, legacyProject.id],
  );
  const unboundToken = randomUUID().replace(/-/g, "");
  await query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, 'legacy')`, [
    Number(unboundPa.rows[0].id),
    hashToken(unboundToken),
  ]);
  const boundProject = await createProject(owner.id, `crud4-${tag}`, `Crud4 ${tag}`);
  const asymGrant = await grant(owner.id, boundProject.id, legacyPart.id, null, false);
  check(asymGrant !== null, "the grant onto an unbound-seat agent must succeed");
  check(
    asymGrant?.alreadyConnected === false && typeof asymGrant?.plaintextToken === "string",
    `an existing token that CANNOT reach the new seat is not "already connected" - a token must be minted, got ${JSON.stringify(
      { already: asymGrant?.alreadyConnected, minted: asymGrant?.plaintextToken !== null },
    )}`,
  );
  // The minted token must actually open the new project, or minting it was theatre.
  const asymCtx = await authenticate(`Bearer ${asymGrant?.plaintextToken ?? ""}`);
  check(asymCtx !== null, "the newly minted token authenticates");
  if (asymCtx) {
    const opened = await resolveTo(asymCtx, `crud4-${tag}`);
    check(opened.project.id === boundProject.id, "and it opens the newly granted project");
  }
  // And the CONTROL that explains WHY one was needed: the old unbound token still cannot reach it. That is
  // the driver guard working as designed (decision 070) - the defect was never the guard, it was grant()
  // asking a different question than the guard answers.
  const oldCtx = await authenticate(`Bearer ${unboundToken}`);
  check(oldCtx !== null, "the pre-existing unbound token still authenticates");
  if (oldCtx) {
    let refused = false;
    try {
      await resolveTo(oldCtx, `crud4-${tag}`);
    } catch {
      refused = true;
    }
    check(refused, "the unbound token must still be refused the bound seat - otherwise the guard is gone");
  }

  // ── The Access page must tell those three states apart (decision 075) ──
  // It rendered `tokenActive ? "active" : "revoked"`, which is two labels for three states and wrong on
  // two of them: a second-project seat normally has NO token of its own and is reached by the agent's
  // token elsewhere, so "revoked" named an action nobody took - and a genuinely stranded seat looked
  // exactly the same. The page an operator checks to answer "can this agent work here?" could not tell
  // healthy from broken.
  const healthyRows = await listParticipations(owner.id, secondProject.id);
  const healthy = healthyRows.find((r) => r.participantName === `wired-${tag}`);
  check(healthy !== undefined, "precondition: the already-connected agent is listed on its second project");
  check(
    healthy?.tokenActive === false && healthy?.reachable === true,
    `a second-project seat has no token of its own but IS reachable, got ${JSON.stringify(healthy)}`,
  );
  const strandedRows = await listParticipations(owner.id, boundProject.id);
  const stranded = strandedRows.find((r) => r.participantName === `unbound-${tag}`);
  // After the fix this seat got a minted token, so assert the DISTINCTION on the row the query computes:
  // reachable must be true here, and the pill must not say "revoked" for either healthy shape.
  check(stranded?.reachable === true, `a freshly granted seat must be reachable, got ${JSON.stringify(stranded)}`);
  const accessHtml = projectAccessPage(owner, secondProject, healthyRows, [], [], "csrf-y");
  check(
    !/>revoked</.test(accessHtml),
    "a seat reached on the agent's existing token must NOT be labelled revoked - nobody revoked anything",
  );
  check(/>connected</.test(accessHtml), "it must say connected, so the operator can see it is fine");
  // ...and the stranded shape must be visibly different. Built by hand because the fixed grant() can no
  // longer produce it - which is the point of the fix.
  const strandedHtml = projectAccessPage(
    owner,
    boundProject,
    [{ ...(stranded ?? healthyRows[0]), tokenActive: false, reachable: false }],
    [],
    [],
    "csrf-y",
  );
  check(/>unreachable</.test(strandedHtml), "a seat no token can reach must say so, not share a label with a healthy one");

  // ── AN EXPIRED TOKEN IS NOT AN ACTIVE ONE. Independent review, 2026-08-28.
  //    `token_active` checked only `revoked_at`, while the `reachable` subquery two lines below it checked
  //    revoked AND expired. Nothing stamps `revoked_at` when a token merely lapses - the OAuth AS mints a
  //    fresh 1h row per exchange AND per refresh and never revokes the old one - so a seat whose every
  //    token had expired rendered `active` forever, and because the pill tests tokenActive FIRST, the
  //    `unreachable` state 075 shipped could never be reached for any OAuth-connected seat at all.
  //    The assertions above could not see it: they build the stranded row BY HAND. This one drives it from
  //    a real expired token, which is the only version that would have caught the bug.
  const { getPool: poolForExpiry } = await import("../src/db.js");
  // A DEDICATED seat: the one above has already been revoked by the revoke test, and a precondition that
  // silently starts false would make this whole case vacuous.
  const expiringPart = await createParticipant(owner.id, `expiring-${tag}`, "agent");
  const expiringGrant = await grant(owner.id, project.id, expiringPart.id, null, false);
  check(expiringGrant !== null, "grant for the expiry case returned null");
  const expiredSeat = expiringGrant!.participation.id;
  const beforeExpiry = (await listParticipations(owner.id, project.id)).find((r) => r.participationId === expiredSeat);
  check(beforeExpiry?.tokenActive === true, "precondition: the seat starts with a live token");
  await poolForExpiry().query(
    `UPDATE tokens SET expires_at = now() - interval '1 hour' WHERE participation_id = $1`,
    [expiredSeat],
  );
  const afterExpiry = (await listParticipations(owner.id, project.id)).find((r) => r.participationId === expiredSeat);
  check(
    afterExpiry?.tokenActive === false,
    `a seat whose every token has EXPIRED must not read as active, got ${JSON.stringify(afterExpiry)}`,
  );
  // And the page must now say so rather than offering Revoke on a credential that cannot authenticate.
  const expiredHtml = projectAccessPage(owner, project, [afterExpiry!], [], [], "csrf-expired");
  check(!/>active</.test(expiredHtml), "an all-expired seat must not render the active pill");

  // ── rename + delete (CRUD completion) ──
  const { getPool } = await import("../src/db.js");
  const { renameParticipant, deleteParticipant, renameProject, deleteProject, loadOwnedParticipant } =
    await import("../src/admin/queries.js");

  // rename participant (ok), then a conflicting rename is rejected.
  check((await renameParticipant(owner.id, participant.id, `agent-${tag}-renamed`)) === "ok", "renameParticipant ok failed");
  const reloaded = await loadOwnedParticipant(owner.id, participant.id);
  check(reloaded?.name === `agent-${tag}-renamed`, `participant not renamed: ${JSON.stringify(reloaded)}`);
  const p2 = await createParticipant(owner.id, `agent-${tag}-two`, "agent");
  check((await renameParticipant(owner.id, p2.id, `agent-${tag}-renamed`)) === "conflict", "duplicate rename not rejected");

  // rename project (name + slug).
  check((await renameProject(owner.id, project.id, `Crud ${tag} v2`, `crud-${tag}-v2`)) === "ok", "renameProject ok failed");

  // delete participant PRESERVES the ledger: log an event for its participation, delete, assert kept.
  await getPool().query(
    `INSERT INTO events (project_id, participation_id, actor_name, type, payload) VALUES ($1,$2,$3,'claim','{}'::jsonb)`,
    [project.id, result.participation.id, `agent-${tag}-renamed`],
  );
  // owner-leave (decision 039): an in-flight task owned by the departing participant reverts to todo/unassigned.
  const leaveTask = await getPool().query<{ id: string }>(
    `INSERT INTO tasks (project_id, title, status, owner_participation_id, owner_name)
     VALUES ($1, 'owned by the leaver', 'in_progress', $2, 'x') RETURNING id`,
    [project.id, result.participation.id],
  );
  check((await deleteParticipant(owner.id, participant.id)) === true, "deleteParticipant did not delete");
  const leftRow = await getPool().query<{ status: string; owner_participation_id: string | null }>(
    `SELECT status, owner_participation_id FROM tasks WHERE id = $1`,
    [Number(leaveTask.rows[0].id)],
  );
  check(
    leftRow.rows[0].status === "todo" && leftRow.rows[0].owner_participation_id === null,
    `owner-leave: the leaver's in-flight task must revert to todo/unassigned, got ${JSON.stringify(leftRow.rows[0])}`,
  );
  check((await loadOwnedParticipant(owner.id, participant.id)) === null, "participant still loadable after delete");
  const ev = await getPool().query<{ participation_id: string | null; actor_name: string }>(
    `SELECT participation_id, actor_name FROM events WHERE project_id=$1 AND actor_name=$2 ORDER BY id DESC LIMIT 1`,
    [project.id, `agent-${tag}-renamed`],
  );
  check(
    ev.rowCount === 1 && ev.rows[0].participation_id === null && ev.rows[0].actor_name === `agent-${tag}-renamed`,
    `event not preserved with NULL participation_id after participant delete: ${JSON.stringify(ev.rows[0])}`,
  );

  // delete project cascades all its data.
  check((await deleteProject(owner.id, project.id)) === true, "deleteProject did not delete");
  check((await loadOwnedProject(owner.id, project.id)) === null, "project still loadable after delete");

  finish();
}

function fail(): void {
  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL admin.crud:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK admin.crud: resolveOwner idempotent; create project+participant; grant mints a token that " +
      "authenticates to the right project/participation; hand-out card carries token + PUBLIC_URL/mcp + OKF pointer; " +
      "rotate mints-before-revoke (old dies, new works, exactly 1 active, non-owner -> null); " +
      "revoke kills the token; granting an ALREADY-CONNECTED agent a second project mints no token and it "
      + "reaches the new project on the token it already had (decision 070); rename (ok + duplicate-rejected) for participant & project; delete " +
      "participant preserves the ledger (actor_name kept, participation_id -> NULL); delete project cascades.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("admin.crud test errored:", err);
  process.exit(1);
});
