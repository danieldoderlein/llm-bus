import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { freshProject } from "./_setup.js";
import { closePool, getPool } from "../src/db.js";
import { hashToken, authenticate, authenticateResult } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

// Suspension enforcement (decision 016): a suspended owner's token is rejected at auth with a stable
// "suspended due to non-payment" - the one deliberate block. Comped owners are carved out. The atomic
// claim path is unchanged (this is a pre-action read; concurrency.claim covers that separately).

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function mintToken(participationId: number): Promise<string> {
  const t = randomBytes(24).toString("base64url");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [
    participationId,
    hashToken(t),
  ]);
  return t;
}
async function setOwner(ownerId: number, setClause: string): Promise<void> {
  await getPool().query(`UPDATE owners SET ${setClause} WHERE id = $1`, [ownerId]);
}

async function main(): Promise<void> {
  const ctx = await freshProject("susp");
  const ownerId = ctx.project.ownerId;
  const token = await mintToken(ctx.participation.id);

  // 1. healthy owner authenticates
  check((await authenticateResult(`Bearer ${token}`)).ok === true, "healthy owner -> ok:true");

  // 2. missing token -> unauthorized
  const noTok = await authenticateResult(undefined);
  check(noTok.ok === false && noTok.reason === "unauthorized", "no token -> unauthorized");

  // 3. suspended -> reason 'suspended'; legacy authenticate() collapses to null
  await setOwner(ownerId, "suspended_at = now()");
  const susp = await authenticateResult(`Bearer ${token}`);
  check(susp.ok === false && susp.reason === "suspended", "suspended owner -> reason suspended");
  check((await authenticate(`Bearer ${token}`)) === null, "legacy authenticate() -> null when suspended");

  // 4. comped carve-out: a stray suspended flag is ignored for comped owners
  await setOwner(ownerId, "plan = 'comped'");
  check((await authenticateResult(`Bearer ${token}`)).ok === true, "comped owner authenticates despite suspended_at");
  await setOwner(ownerId, "plan = 'free'"); // back to suspended free for the HTTP check

  // 4b. BETA_FREE (decision 059) bypasses the suspension gate: a suspended FREE owner authenticates while the
  //     flag is on. Unset in finally so the HTTP check below still sees the (flag-off) 403 enforcement.
  process.env.BETA_FREE = "1";
  try {
    check(
      (await authenticateResult(`Bearer ${token}`)).ok === true,
      "BETA_FREE: suspended free owner authenticates (gate bypassed)",
    );
  } finally {
    delete process.env.BETA_FREE;
  }
  check(
    (await authenticateResult(`Bearer ${token}`)).ok === false,
    "flag off again: the suspended owner is blocked once more",
  );

  // 5. HTTP /mcp with a suspended token -> 403 + the stable message (not a 401 PRM challenge)
  const server = createHttpServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check(resp.status === 403, `suspended token over HTTP -> 403 (got ${resp.status})`);
  const body = (await resp.json()) as { error?: string };
  check(body.error === "suspended due to non-payment", `message: ${JSON.stringify(body)}`);
  check(resp.headers.get("www-authenticate") === null, "403 must NOT carry a PRM challenge");
  await new Promise<void>((res) => server.close(() => res()));

  finish();
}

function finish(): void {
  if (errors.length) {
    console.error(`FAIL auth.suspension:\n  - ${errors.join("\n  - ")}`);
    void closePool().then(() => process.exit(1));
    return;
  }
  console.log(
    "OK auth.suspension: healthy/unauthorized/suspended via authenticateResult + legacy null; comped carve-out; " +
      "HTTP /mcp -> 403 'suspended due to non-payment' with no PRM challenge.",
  );
  void closePool();
}

main().catch((err) => {
  console.error("auth.suspension test errored:", err);
  process.exit(1);
});
