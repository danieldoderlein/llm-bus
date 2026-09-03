// The flips-green connect indicator's backing endpoint (decision 028): GET /admin/connection-status is
// owner-scoped, positive-edge, and NEVER leaks the token. Driven over real HTTP via handleAdmin in header
// mode (the SSO email is the only identity input). Proves: the owner sees seen:false before any tool call
// and seen:true after a presence touch; a non-owner and a non-finite/absent id both 404 IDENTICALLY (no
// 403 oracle, invariant 3); the token never appears in any response body (invariant 7).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import "./_setup.js";
import { closePool, getPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { handleAdmin } from "../src/admin/handlers.js";
import { resolveOwner } from "../src/admin/owner.js";
import { createProject, createParticipant, grant, connectionStatus } from "../src/admin/queries.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

async function touch(participationId: number, projectId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO presence (participation_id, project_id, lane, last_seen) VALUES ($1, $2, '(unset)', now())
     ON CONFLICT (participation_id) DO UPDATE SET last_seen = now()`,
    [participationId, projectId],
  );
}

async function main(): Promise<void> {
  const header = loadConfig().ADMIN_EMAIL_HEADER; // default "x-auth-request-email"
  const tag = randomUUID().slice(0, 8);
  const emailA = `connstatus-a-${tag}@test.local`;
  const emailB = `connstatus-b-${tag}@test.local`;

  const server = http.createServer((req, res) => void handleAdmin(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const statusUrl = (pid: string): string => `${base}/admin/connection-status?participation=${pid}`;
  const getA = (url: string): Promise<Response> => fetch(url, { headers: { [header]: emailA } });

  // Owner A: a project + participant + grant (a real token we must never see echoed back).
  const a = await resolveOwner(emailA);
  const project = await createProject(a.id, `cs-${tag}`, `CS ${tag}`);
  const participant = await createParticipant(a.id, `cs-agent-${tag}`, "agent");
  const g = await grant(a.id, project.id, participant.id, null, false);
  check(g !== null, "grant failed");
  if (!g) return finish(server);
  const pid = g.participation.id;
  const token = g.plaintextToken ?? "";

  // (1) Before any tool call: owner A sees seen:false, seen_at:null, actor set - and JSON content-type.
  const r1 = await getA(statusUrl(String(pid)));
  check(r1.status === 200, `owner GET expected 200, got ${r1.status}`);
  check((r1.headers.get("content-type") ?? "").includes("application/json"), "status content-type not JSON");
  const body1 = await r1.text();
  check(!body1.includes(token), "response body leaked the token (pre-connect)");
  const j1 = JSON.parse(body1) as { seen: boolean; seen_at: string | null; actor: string };
  check(j1.seen === false && j1.seen_at === null, `expected seen:false pre-touch, got ${body1}`);
  check(typeof j1.actor === "string" && j1.actor.length > 0, "actor missing pre-connect");

  // (2) After a presence touch (the heartbeat any bus tool call writes): the positive edge fires.
  await touch(pid, project.id);
  const r2 = await getA(statusUrl(String(pid)));
  const body2 = await r2.text();
  check(!body2.includes(token), "response body leaked the token (post-connect)");
  const j2 = JSON.parse(body2) as { seen: boolean; seen_at: string | null };
  check(j2.seen === true && typeof j2.seen_at === "string", `expected seen:true after touch, got ${body2}`);

  // (3) A DIFFERENT owner asking for A's participation gets a 404 identical to any unmatched route (no
  // 403 oracle). B is a real, resolvable owner - the 404 is isolation, not "unauthenticated".
  await resolveOwner(emailB);
  const rB = await fetch(statusUrl(String(pid)), { headers: { [header]: emailB } });
  check(rB.status === 404, `non-owner expected 404, got ${rB.status}`);
  const bodyB = await rB.text();
  check(!bodyB.includes(token), "non-owner 404 body leaked the token");
  check(!bodyB.includes(String(pid)) || !/actor/.test(bodyB), "non-owner response looks like a status leak");

  // (4) A non-finite id and an absent id both 404 for the legitimate owner (parsed with Number()).
  const rNaN = await getA(statusUrl("not-a-number"));
  check(rNaN.status === 404, `non-finite id expected 404, got ${rNaN.status}`);
  const rAbsent = await getA(`${base}/admin/connection-status`);
  check(rAbsent.status === 404, `absent id expected 404, got ${rAbsent.status}`);

  // (5) Bound-human wins over the provisioner (decision 052 follow-up, bus task 508). An agent PROVISIONED
  // under owner A but BOUND to a different human M (human_owner_id != owner_id) must display as M/agent, not
  // A/agent. A still SEES the row via the project-owner branch of the reprove predicate, so this exercises
  // the divergence the OI-7 rebind masks in live data. Called directly (the actor string is the assertion).
  const m = await resolveOwner(`connstatus-m-${tag}@test.local`);
  await getPool().query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [m.id, pid]);
  const cs = await connectionStatus(a.id, pid);
  check(cs !== null, "owner A lost visibility of a member-bound agent (project-owner branch of the predicate)");
  check(
    cs?.actor === `${m.username}/cs-agent-${tag}`,
    `bound-human actor: expected ${m.username}/cs-agent-${tag}, got ${cs?.actor}`,
  );

  finish(server);
}

function finish(server: http.Server): void {
  server.close(() => {
    if (errors.length) {
      console.error(`FAIL connection.status:\n  - ${errors.join("\n  - ")}`);
      void closePool().then(() => process.exit(1));
      return;
    }
    console.log(
      "OK connection.status: owner sees seen:false pre-touch and seen:true after a presence heartbeat; a " +
        "non-owner and a non-finite/absent id both 404 (no 403 oracle); the token never appears in any body; " +
        "the actor renders the BOUND human (human_owner_id) not the provisioner (task 508).",
    );
    void closePool();
  });
}

main().catch((err) => {
  console.error("connection.status test errored:", err);
  process.exit(1);
});
