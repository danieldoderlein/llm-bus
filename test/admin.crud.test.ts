// Importing _setup first establishes the default DATABASE_URL (its top-level side effect) before
// db.ts is loaded by any admin module. We don't use freshProject here — the admin layer creates
// its own owners via resolveOwner — but the import wiring guarantees the DB env is set.
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { resolveOwner } from "../src/admin/owner.js";
import {
  createProject,
  createParticipant,
  grant,
  loadOwnedProject,
  listParticipations,
  setParticipationAdmin,
} from "../src/admin/queries.js";
import { handoutCard, projectPage, invitePromptPage } from "../src/admin/html.js";
import { createInvite, listInvites, buildInvitePrompt } from "../src/invite.js";

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

  // The plaintext token authenticates and resolves to THIS project/participation.
  const ctx = await authenticate(`Bearer ${result.plaintextToken}`);
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
  const card = handoutCard(owner, project, participant.name, result.plaintextToken, mcpUrl, false);
  check(card.includes(result.plaintextToken), "hand-out card missing the plaintext token");
  check(card.includes(mcpUrl), `hand-out card missing the MCP url (${mcpUrl})`);
  check(
    card.includes(`claude mcp add --transport http llm-bus ${mcpUrl} --header`),
    "hand-out card missing the deterministic `claude mcp add` connect command",
  );
  check(card.includes("coordination protocol"), "hand-out card missing the coordination protocol");
  check(card.includes("OKF") && card.includes("okf/SPEC.md"), "hand-out card missing the OKF knowledge-layer pointer");
  check(!card.includes("you onboard teammates"), "non-admin card should NOT include admin powers");
  // The admin (lead) variant additionally embeds the admin powers.
  const adminCard = handoutCard(owner, project, participant.name, result.plaintextToken, mcpUrl, true);
  check(adminCard.includes("create_invite") && adminCard.toLowerCase().includes("admin (lead)"),
    "admin hand-out card missing the lead/admin powers");

  // Invites: create one, then RENDER the surfaces that touch its expiresAt (a Date from pg) —
  // guards the timestamp `.slice` regression (project page invite rows + the invite-created page).
  const inv = await createInvite(owner.id, project.id, { ttlHours: 24 });
  check(inv !== null, "createInvite returned null");
  const invites = await listInvites(owner.id, project.id);
  check(invites.some((i) => i.code === inv!.code), "listInvites missing the new invite");
  const projHtml = projectPage(owner, project, [], invites, "csrf-x");
  check(projHtml.includes(inv!.code), "project page did not render the invite row");
  const promptHtml = invitePromptPage(
    owner,
    project,
    buildInvitePrompt(project.name, inv!.code, null, "https://x", 24, false),
    inv!.expiresAt,
  );
  check(promptHtml.includes(inv!.code), "invite-created page did not render the prompt");

  // loadOwnedProject sees it.
  const loaded = await loadOwnedProject(owner.id, project.id);
  check(loaded !== null && loaded.id === project.id, "loadOwnedProject failed for an owned project");

  // listParticipations shows the active token.
  const parts = await listParticipations(owner.id, project.id);
  const row = parts.find((p) => p.participationId === result.participation.id);
  check(row !== undefined && row.tokenActive === true, `participation not listed active: ${JSON.stringify(parts)}`);

  // Promote/demote the lead flag -> the token resolves admin true/false on the next auth.
  check((await setParticipationAdmin(owner.id, result.participation.id, true)) === true, "promote to lead failed");
  const promoted = await authenticate(`Bearer ${result.plaintextToken}`);
  check(promoted?.participation.isAdmin === true, "token not admin after promote");
  check((await setParticipationAdmin(owner.id, result.participation.id, false)) === true, "demote failed");
  const demoted = await authenticate(`Bearer ${result.plaintextToken}`);
  check(demoted?.participation.isAdmin === false, "token still admin after demote");

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
  check((await deleteParticipant(owner.id, participant.id)) === true, "deleteParticipant did not delete");
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
      "revoke kills the token; rename (ok + duplicate-rejected) for participant & project; delete " +
      "participant preserves the ledger (actor_name kept, participation_id -> NULL); delete project cascades.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("admin.crud test errored:", err);
  process.exit(1);
});
