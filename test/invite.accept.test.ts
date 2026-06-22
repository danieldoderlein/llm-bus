import { randomBytes } from "node:crypto";
import { freshProject } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { hashToken, authenticate } from "../src/auth.js";
import { createOrgInvite, acceptInvite } from "../src/invite-accept.js";
import { listProjects } from "../src/admin/queries.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function ownerIdForEmail(email: string): Promise<number | null> {
  const r = await getPool().query<{ id: string }>(`SELECT id FROM owners WHERE email = $1`, [
    email.toLowerCase(),
  ]);
  return r.rowCount ? Number(r.rows[0].id) : null;
}

async function main(): Promise<void> {
  const ctx = await freshProject("invite-accept");
  const ownerId = ctx.project.ownerId;
  const projectId = ctx.project.id;

  // 1. createOrgInvite + acceptInvite issues a working token for the right project + role.
  const inv = await createOrgInvite(ownerId, projectId, { kind: "human", isAdmin: false });
  check(inv !== null, "createOrgInvite returned null for an owned project");
  const accepted = await acceptInvite(inv!.token, "Bob@Example.com");
  check(accepted.ok === true, `acceptInvite failed: ${JSON.stringify(accepted)}`);
  if (accepted.ok) {
    check(accepted.created === true, "first accept should create the participant");
    const actx = await authenticate(`Bearer ${accepted.token}`);
    check(actx?.project.id === projectId, "accepted token did not resolve to the invite's project");
    check(actx?.participation.isAdmin === false, "non-admin invite resolved is_admin=true");
    check(accepted.participant === "human-bob", `derived name: ${accepted.participant}`);
  }

  // 2. Single-use: a second accept on the same token is already_accepted and mints no new token.
  const tokenCountBefore = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM tokens`);
  const again = await acceptInvite(inv!.token, "bob@example.com");
  check(again.ok === false && (again as { error: string }).error === "already_accepted", `second accept: ${JSON.stringify(again)}`);
  const tokenCountAfter = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM tokens`);
  check(tokenCountBefore.rows[0].n === tokenCountAfter.rows[0].n, "already-accepted invite minted a token");

  // 3. Owner isolation: Bob's own owner account does NOT gain the project; the project owner keeps it.
  const bobOwnerId = await ownerIdForEmail("bob@example.com");
  check(bobOwnerId !== null && bobOwnerId !== ownerId, "accepter should be a distinct owner");
  if (bobOwnerId) {
    const bobProjects = await listProjects(bobOwnerId);
    check(!bobProjects.some((p) => p.id === projectId), "accepter's dashboard leaked the project (isolation breach)");
  }
  const ownerProjects = await listProjects(ownerId);
  check(ownerProjects.some((p) => p.id === projectId), "project owner lost the project");

  // 4. Expired invite is rejected.
  const expiredTok = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO invites (token_hash, project_id, expires_at) VALUES ($1, $2, now() - interval '1 hour')`,
    [hashToken(expiredTok), projectId],
  );
  const expired = await acceptInvite(expiredTok, "carol@example.com");
  check(expired.ok === false && (expired as { error: string }).error === "expired", `expired: ${JSON.stringify(expired)}`);

  // 5. Revoked invite is rejected.
  const revokedTok = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO invites (token_hash, project_id, state, expires_at) VALUES ($1, $2, 'revoked', now() + interval '1 hour')`,
    [hashToken(revokedTok), projectId],
  );
  const revoked = await acceptInvite(revokedTok, "carol@example.com");
  check(revoked.ok === false && (revoked as { error: string }).error === "revoked", `revoked: ${JSON.stringify(revoked)}`);

  // 6. Targeted invite: a mismatched verified email is refused; the intended email is accepted as admin.
  const targeted = await createOrgInvite(ownerId, projectId, {
    intendedName: "dave",
    isAdmin: true,
    targetEmail: "dave@example.com",
  });
  const mismatch = await acceptInvite(targeted!.token, "evil@example.com");
  check(mismatch.ok === false && (mismatch as { error: string }).error === "email_mismatch", `mismatch: ${JSON.stringify(mismatch)}`);
  const dave = await acceptInvite(targeted!.token, "dave@example.com");
  check(dave.ok === true, `targeted accept failed: ${JSON.stringify(dave)}`);
  if (dave.ok) {
    check(dave.participant === "dave", `intended_name not honored: ${dave.participant}`);
    const dctx = await authenticate(`Bearer ${dave.token}`);
    check(dctx?.participation.isAdmin === true, "admin invite did not resolve is_admin=true");
  }

  // 7. createOrgInvite is owner-scoped: a foreign owner cannot mint against this project.
  const foreign = await freshProject("invite-accept-foreign");
  const refused = await createOrgInvite(foreign.project.ownerId, projectId, {});
  check(refused === null, "createOrgInvite allowed a non-owner to mint against the project");

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL invite.accept:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK invite.accept: createOrgInvite (owner-scoped) + acceptInvite mints a working token for the right " +
      "project/role; single-use -> already_accepted (no extra token); accepter is a distinct owner with no " +
      "project access (isolation); expired/revoked rejected; targeted invite refuses a mismatched email and " +
      "honors intended_name + admin.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("invite.accept test errored:", err);
  process.exit(1);
});
