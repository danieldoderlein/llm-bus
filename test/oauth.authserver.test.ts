import { freshProject } from "./_setup.js";
import { createHash, randomBytes } from "node:crypto";
import { closePool, getPool, query } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { createOrgInvite, acceptInviteById } from "../src/invite-accept.js";
import { revokeParticipation } from "../src/admin/queries.js";
import type { Config } from "../src/config.js";
import {
  asIssuer,
  authServerMetadata,
  isAllowedRedirectUri,
  verifyPkceS256,
  registerClient,
  loadClient,
  mintAuthCode,
  redeemAuthCode,
  redeemRefreshToken,
  listMemberships,
  listPendingInvitesForEmail,
  ownsParticipation,
  createOwnerParticipation,
} from "../src/oauth-as.js";

// The MCP OAuth 2.1 authorization server (decision 024). Covers: RFC 8414 metadata shape; redirect_uri
// allowlist (open-redirect guard); PKCE S256; DCR persist + reject; the full authorization_code ->
// access-token flow (the token is a normal `tokens` row authenticate() resolves - invariant 1);
// single-use codes + TTL + redirect/PKCE mismatch; access-token expiry; refresh rotation; and the
// consent picker enumeration filtered by human_owner_id / target_email (no cross-tenant listing - inv 3).

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

/** A minimal Config for the pure metadata/issuer functions (they read only these two fields). */
function cfg(publicUrl: string, redirectBase?: string): Config {
  return { PUBLIC_URL: publicUrl, OAUTH_REDIRECT_BASE: redirectBase } as unknown as Config;
}

/** RFC 7636 PKCE pair: a random verifier and its S256 challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, within 43-128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function main(): Promise<void> {
  // ── 1. RFC 8414 metadata + issuer resolution ──
  const md = authServerMetadata(cfg("https://mcp.example.com", "https://app.example.com"));
  check(md.issuer === "https://app.example.com", `issuer = ${md.issuer}`);
  check(md.authorization_endpoint === "https://app.example.com/admin/authorize", "authorization_endpoint");
  check(md.token_endpoint === "https://app.example.com/token", "token_endpoint");
  check(md.registration_endpoint === "https://app.example.com/register", "registration_endpoint");
  check(JSON.stringify(md.code_challenge_methods_supported) === JSON.stringify(["S256"]), "S256 only");
  check(
    md.grant_types_supported.includes("authorization_code") && md.grant_types_supported.includes("refresh_token"),
    "grant_types",
  );
  check(JSON.stringify(md.token_endpoint_auth_methods_supported) === JSON.stringify(["none"]), "public client");
  // Issuer falls back to PUBLIC_URL when OAUTH_REDIRECT_BASE is unset (self-host single host).
  check(asIssuer(cfg("https://solo.example.com")) === "https://solo.example.com", "issuer fallback");
  check(asIssuer(cfg("https://solo.example.com/")) === "https://solo.example.com", "issuer strips slash");

  // ── 2. redirect_uri allowlist (open-redirect guard) ──
  check(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), "https allowed");
  check(isAllowedRedirectUri("http://127.0.0.1:8976/callback"), "loopback allowed");
  check(isAllowedRedirectUri("http://localhost:1234/cb"), "localhost allowed");
  check(!isAllowedRedirectUri("http://evil.com/cb"), "http non-loopback rejected");
  check(!isAllowedRedirectUri("javascript:alert(1)"), "javascript: rejected");
  check(!isAllowedRedirectUri("com.evil.app://cb"), "custom scheme rejected");
  check(!isAllowedRedirectUri("https://claude.ai/cb#frag"), "fragment rejected");
  check(!isAllowedRedirectUri("/relative/cb"), "relative rejected");
  check(!isAllowedRedirectUri("https://user:pw@claude.ai/cb"), "embedded creds rejected");

  // ── 3. PKCE S256 verify ──
  const { verifier, challenge } = pkcePair();
  check(verifyPkceS256(verifier, challenge), "correct verifier accepted");
  check(!verifyPkceS256("wrong-verifier-wrong-verifier-wrong-verifier-xx", challenge), "wrong verifier rejected");
  check(!verifyPkceS256(verifier, verifier), "plain (unhashed) challenge rejected");
  check(!verifyPkceS256("tooshort", challenge), "short verifier rejected");

  // ── 4. DCR persist + reject ──
  const reg = await registerClient({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    client_name: "Claude",
  });
  check(reg.ok === true, `register ok: ${JSON.stringify(reg)}`);
  if (!reg.ok) {
    await closePool();
    process.exit(1);
  }
  const clientId = reg.client.client_id;
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const loaded = await loadClient(clientId);
  check(loaded !== null && loaded.redirect_uris.includes(redirectUri), "client loads with its redirect_uri");
  check(loaded?.client_name === "Claude", "client_name persisted");
  const rogue = await registerClient({ redirect_uris: ["http://evil.com/cb"] });
  check(rogue.ok === false, "rogue redirect_uri registration rejected");
  const empty = await registerClient({ redirect_uris: [] });
  check(empty.ok === false, "empty redirect_uris rejected");

  // ── 5. Full authorization_code flow: code -> access token that authenticate() resolves ──
  const ctx = await freshProject("oauthas");
  // Attach a human_owner_id so this participation is enumerable + reprovable (mirror a real grant).
  await query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [
    ctx.owner!.id,
    ctx.participation.id,
  ]);
  const participationId = ctx.participation.id;

  const code = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: challenge, scope: "mcp" });
  const ex = await redeemAuthCode(code, clientId, redirectUri, verifier);
  check(ex.ok === true, `code exchange ok: ${JSON.stringify(ex)}`);
  if (!ex.ok) {
    await closePool();
    process.exit(1);
  }
  check(ex.grant.token_type === "Bearer" && ex.grant.expires_in > 0, "grant shape");
  const resolved = await authenticate(`Bearer ${ex.grant.access_token}`);
  check(resolved !== null, "access token resolves via authenticate()");
  check(resolved?.project.id === ctx.project.id, "resolves to the right project (inv 1)");
  check(resolved?.participation.id === participationId, "resolves to the chosen participation");

  // ── 6. Single-use code: a second redemption fails ──
  const replay = await redeemAuthCode(code, clientId, redirectUri, verifier);
  check(replay.ok === false, "code is single-use (replay rejected)");

  // ── 7. Code TTL expiry (insert an already-expired code directly) ──
  const expiredRaw = randomBytes(16).toString("base64url");
  const expiredHash = createHash("sha256").update(expiredRaw).digest("hex");
  await query(
    `INSERT INTO oauth_codes (code_hash, client_id, participation_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,'S256','mcp', now() - interval '1 minute')`,
    [expiredHash, clientId, participationId, redirectUri, challenge],
  );
  const expiredEx = await redeemAuthCode(expiredRaw, clientId, redirectUri, verifier);
  check(expiredEx.ok === false, "expired code rejected");

  // ── 8. redirect_uri mismatch + wrong PKCE verifier at redeem ──
  const p2 = pkcePair();
  const code2 = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: p2.challenge });
  const mismatch = await redeemAuthCode(code2, clientId, "https://claude.ai/OTHER", p2.verifier);
  check(mismatch.ok === false, "redirect_uri mismatch rejected");
  const code3 = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: p2.challenge });
  const badVerifier = await redeemAuthCode(code3, clientId, redirectUri, pkcePair().verifier);
  check(badVerifier.ok === false, "wrong PKCE verifier rejected");

  // ── 9. Access-token expiry: an expired oauth access token no longer resolves ──
  await query(`UPDATE tokens SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`, [
    createHash("sha256").update(ex.grant.access_token).digest("hex"),
  ]);
  check((await authenticate(`Bearer ${ex.grant.access_token}`)) === null, "expired access token rejected");

  // ── 10. Refresh rotation: new tokens, old refresh revoked ──
  const p3 = pkcePair();
  const code4 = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: p3.challenge });
  const first = await redeemAuthCode(code4, clientId, redirectUri, p3.verifier);
  check(first.ok === true, "second grant for refresh test");
  if (!first.ok) {
    await closePool();
    process.exit(1);
  }
  const rot = await redeemRefreshToken(first.grant.refresh_token, clientId);
  check(rot.ok === true, "refresh rotates to a new grant");
  if (rot.ok) {
    check((await authenticate(`Bearer ${rot.grant.access_token}`)) !== null, "rotated access token resolves");
  }
  const reuseOld = await redeemRefreshToken(first.grant.refresh_token, clientId);
  check(reuseOld.ok === false, "old refresh token is revoked after rotation");

  // ── 11. Consent enumeration filtered by human_owner_id / ownership (inv 3) ──
  const memA = await listMemberships(ctx.owner!.id);
  check(memA.some((m) => m.participationId === participationId), "owner sees their own membership");
  const ctxB = await freshProject("oauthas-b");
  const memBseenByA = await listMemberships(ctx.owner!.id);
  check(
    !memBseenByA.some((m) => m.projectId === ctxB.project.id),
    "owner A never sees owner B's project (inv 3)",
  );
  check(!(await ownsParticipation(ctx.owner!.id, ctxB.participation.id)), "ownsParticipation is owner-scoped");

  // ── 12. Pending invite enumeration + acceptInviteById (targeted, email-checked) ──
  const inviteeEmail = `oauthinvitee-${randomBytes(4).toString("hex")}@test.local`;
  const inv = await createOrgInvite(ctxB.owner!.id, ctxB.project.id, { targetEmail: inviteeEmail });
  check(inv !== null, "targeted invite minted");
  const pending = await listPendingInvitesForEmail(inviteeEmail);
  check(pending.length === 1 && pending[0].projectName === ctxB.project.name, "invitee sees exactly their invite");
  const seenByWrong = await listPendingInvitesForEmail(`someone-else-${randomBytes(3).toString("hex")}@test.local`);
  check(seenByWrong.length === 0, "a different email sees no invites (inv 3)");

  const wrongAccept = await acceptInviteById(pending[0].inviteId, "attacker@test.local");
  check(wrongAccept.ok === false, "acceptInviteById rejects a mismatched email");
  const accept = await acceptInviteById(pending[0].inviteId, inviteeEmail);
  check(accept.ok === true, `acceptInviteById ok: ${JSON.stringify(accept)}`);
  if (accept.ok) {
    // The accepter's owner drives the new participation (human_owner_id threaded), so it enumerates.
    const accepterOwner = await getPool().query<{ id: string }>(`SELECT id FROM owners WHERE email = $1`, [
      inviteeEmail,
    ]);
    const accepterOwnerId = Number(accepterOwner.rows[0].id);
    const accMems = await listMemberships(accepterOwnerId);
    check(
      accMems.some((m) => m.participationId === accept.participationId),
      "accepted participation is enumerable by human_owner_id",
    );
  }
  const secondAccept = await acceptInviteById(pending[0].inviteId, inviteeEmail);
  check(secondAccept.ok === false, "an already-accepted invite cannot be re-accepted");

  // ── 13. createOwnerParticipation cross-owner guard ──
  const cross = await createOwnerParticipation(ctx.owner!.id, ctxB.project.id, ctxB.participant.id);
  check(cross === null, "createOwnerParticipation refuses a project not owned by the caller (inv 3)");

  // ── 14. Revoking a connection kills its OAuth refresh token (no re-mint after revoke) ──
  const p4 = pkcePair();
  const code5 = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: p4.challenge });
  const grantForRevoke = await redeemAuthCode(code5, clientId, redirectUri, p4.verifier);
  check(grantForRevoke.ok === true, "grant issued for revoke test");
  if (grantForRevoke.ok) {
    // Sanity: the refresh token works before revoke.
    const pre = await redeemRefreshToken(grantForRevoke.grant.refresh_token, clientId);
    check(pre.ok === true, "refresh works before revoke");
    // Mint a fresh grant to revoke (the one above was rotated away by `pre`).
    const p5 = pkcePair();
    const code6 = await mintAuthCode({ clientId, participationId, redirectUri, codeChallenge: p5.challenge });
    const live = await redeemAuthCode(code6, clientId, redirectUri, p5.verifier);
    if (live.ok) {
      const n = await revokeParticipation(ctx.owner!.id, participationId);
      check(n >= 1, `revokeParticipation revoked >=1 access token (got ${n})`);
      const afterAccess = await authenticate(`Bearer ${live.grant.access_token}`);
      check(afterAccess === null, "access token dead after revoke");
      const afterRefresh = await redeemRefreshToken(live.grant.refresh_token, clientId);
      check(afterRefresh.ok === false, "refresh token cannot re-mint after connection revoke (MEDIUM-1 fix)");
    }
  }

  await closePool();
  if (errors.length) {
    console.error("FAIL:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log("oauth.authserver: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
