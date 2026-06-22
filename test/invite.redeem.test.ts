// Invite (pairing) flow: create a code, redeem it for a working token, and prove the guards —
// one-use, name lock vs chosen name, expiry, revoke, and cross-owner refusal.
import { randomUUID } from "node:crypto";
import { freshProject } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
  buildInvitePrompt,
  buildJoinFiles,
} from "../src/invite.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function main(): Promise<void> {
  const ctx = await freshProject("invite");
  const ownerId = ctx.owner!.id;
  const projectId = ctx.project.id;
  const tag = randomUUID().slice(0, 6);

  // 1) Create + redeem with a chosen name -> token authenticates as that participant here.
  const inv = await createInvite(ownerId, projectId, { ttlHours: 24, uses: 1 });
  check(inv !== null && typeof inv.code === "string", "createInvite returned null/no code");
  const name = `ai-codex-${tag}`;
  const r = await redeemInvite(inv!.code, name);
  check(r.ok === true, `redeem failed: ${JSON.stringify(r)}`);
  if (r.ok) {
    check(r.created === true, `first open redeem should report created=true, got ${r.created}`);
    check(r.projectSlug === ctx.project.slug, `redeem wrong project: ${r.projectSlug}`);
    check(r.participant === name, `redeem wrong name: ${r.participant}`);
    const tctx = await authenticate(`Bearer ${r.token}`);
    check(
      !!tctx && tctx.project.id === projectId && tctx.participant.name === name && tctx.participation.id !== ctx.participation.id,
      `redeemed token resolves wrong: ${JSON.stringify(tctx && { p: tctx.project.id, n: tctx.participant.name })}`,
    );
    const files = buildJoinFiles(r.token, "https://x/mcp");
    check(
      files[".mcp.json"].includes("https://x/mcp") && files[".claude/settings.local.json"].includes(r.token),
      "buildJoinFiles malformed",
    );
  }

  // 2) One-use: a second redeem is exhausted.
  const again = await redeemInvite(inv!.code, `other-${tag}`);
  check(again.ok === false && (again as { error: string }).error === "exhausted", `expected exhausted, got ${JSON.stringify(again)}`);

  // 3) No intended_name and no provided name -> name_required.
  const inv2 = await createInvite(ownerId, projectId, {});
  const noName = await redeemInvite(inv2!.code, null);
  check(noName.ok === false && (noName as { error: string }).error === "name_required", `expected name_required, got ${JSON.stringify(noName)}`);

  // 4) intended_name locks the name (a provided name is ignored).
  const inv3 = await createInvite(ownerId, projectId, { name: `locked-${tag}` });
  const locked = await redeemInvite(inv3!.code, `ignored-${tag}`);
  check(locked.ok === true && (locked as { participant: string }).participant === `locked-${tag}`, `intended_name not enforced: ${JSON.stringify(locked)}`);

  // 5) Expired code -> expired.
  const inv4 = await createInvite(ownerId, projectId, {});
  await getPool().query(`UPDATE join_codes SET expires_at = now() - interval '1 hour' WHERE code = $1`, [inv4!.code]);
  const expired = await redeemInvite(inv4!.code, `late-${tag}`);
  check(expired.ok === false && (expired as { error: string }).error === "expired", `expected expired, got ${JSON.stringify(expired)}`);

  // 6) Revoked code -> invalid; listInvites excludes it.
  const inv5 = await createInvite(ownerId, projectId, {});
  check((await revokeInvite(ownerId, inv5!.id)) === true, "revokeInvite failed");
  const revoked = await redeemInvite(inv5!.code, `x-${tag}`);
  check(revoked.ok === false && (revoked as { error: string }).error === "invalid", `expected invalid after revoke, got ${JSON.stringify(revoked)}`);
  const open = await listInvites(ownerId, projectId);
  check(!open.some((i) => i.code === inv5!.code), "revoked invite still listed");

  // 7) The invite prompt is self-contained (code + redeem url + project name) and points at the OKF
  //    knowledge layer (division of labor: bus coordinates, wiki records) without hardcoding fields.
  const prompt = buildInvitePrompt(ctx.project.name, "ABC123", null, "https://yolo.example", 24, false);
  check(
    prompt.includes("ABC123") && prompt.includes("https://yolo.example/join") && prompt.includes(ctx.project.name),
    "invite prompt missing code/url/project",
  );
  check(
    prompt.includes("connect_command") &&
      prompt.includes("claude mcp add --transport http llm-bus https://yolo.example/mcp"),
    "invite prompt missing the `claude mcp add` connect-command flow",
  );
  check(
    prompt.includes("OKF") && prompt.includes("okf/SPEC.md") && prompt.toLowerCase().includes("wiki"),
    "invite prompt missing the OKF knowledge-layer pointer",
  );

  // 8) Cross-owner: another owner can neither create an invite for this project nor revoke its invite.
  const other = await freshProject("invite-other");
  check((await createInvite(other.owner!.id, projectId, {})) === null, "cross-owner createInvite was allowed");
  const invX = await createInvite(ownerId, projectId, {});
  check((await revokeInvite(other.owner!.id, invX!.id)) === false, "cross-owner revokeInvite was allowed");

  // 9) Open invite + an EXISTING name -> name_taken, and the code is NOT consumed; a fresh name then works.
  const inv6 = await createInvite(ownerId, projectId, {});
  const clash = await redeemInvite(inv6!.code, "tester"); // 'tester' already exists for this owner (freshProject)
  check(clash.ok === false && (clash as { error: string }).error === "name_taken", `expected name_taken, got ${JSON.stringify(clash)}`);
  const retry = await redeemInvite(inv6!.code, `fresh-${tag}`); // same code still valid -> succeeds as a new participant
  check(retry.ok === true && (retry as { created: boolean }).created === true, `retry after name_taken failed: ${JSON.stringify(retry)}`);

  // 10) An ADMIN invite -> the redeemed participation IS admin (result flag + the token resolves is_admin).
  const adminInv = await createInvite(ownerId, projectId, { isAdmin: true });
  const ar = await redeemInvite(adminInv!.code, `lead-${tag}`);
  check(ar.ok === true && (ar as { isAdmin: boolean }).isAdmin === true, `admin invite did not yield an admin redeem: ${JSON.stringify(ar)}`);
  if (ar.ok) {
    const actx = await authenticate(`Bearer ${ar.token}`);
    check(actx?.participation.isAdmin === true, "admin-invite token did not resolve is_admin=true");
  }

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL invite.redeem:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK invite.redeem: create+redeem mints a working token (created=true); one-use exhausts; name_required " +
      "without a name; open-name collision -> name_taken (code preserved, retry works); intended_name locks/attaches; " +
      "expiry + revoke rejected; cross-owner create/revoke refused; invite prompt carries the OKF pointer.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("invite.redeem test errored:", err);
  process.exit(1);
});
