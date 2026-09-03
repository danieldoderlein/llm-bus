// HTTP-level test for the wake channel (decision 079). The domain test covers the LISTEN/NOTIFY logic;
// this one drives the REAL server, because everything that can go wrong between a working function and a
// working endpoint lives here: the route never registered, auth wired wrong, the timeout parameter
// ignored, or the payload quietly carrying content.
//
// The endpoint's whole job is to be SLOW on purpose and fast when it matters, so these cases pin elapsed
// time. A route that returned instantly with `work:false` would satisfy every value assertion and be
// completely broken.

import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";

process.env.DATABASE_URL ??= `postgres://127.0.0.1:5440/llm_bus`;

const { createHttpServer } = await import("../src/http.js");
const { closePool, getPool, withTx } = await import("../src/db.js");
const { closeWaitChannel } = await import("../src/domain/wait.js");
const { freshProject, createParticipation } = await import("./_setup.js");
const { taskCreate } = await import("../src/domain/task.js");

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    }),
  );
}

/** Mint a real token row for a participation, the way admin_provision does. */
async function mintToken(participationId: number): Promise<string> {
  const raw = randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  await getPool().query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [
    participationId,
    hash,
  ]);
  return raw;
}

async function main(): Promise<void> {
  const server = createHttpServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const A = await freshProject("waithttp");
  const B = await createParticipation(A, "peer");
  const token = await mintToken(A.participation.id);

  // 1. No credentials is 401, and the refusal is not an existence oracle (invariant 1).
  {
    const r = await fetch(`${base}/api/wait?timeout=1`);
    check(r.status === 401, `1a anonymous is 401, got ${r.status}`);
    const body = (await r.json()) as Record<string, unknown>;
    check(
      JSON.stringify(body) === JSON.stringify({ error: "unauthorized" }),
      `1b refusal says nothing about what exists: ${JSON.stringify(body)}`,
    );
    const bad = await fetch(`${base}/api/wait?timeout=1`, {
      headers: { authorization: "Bearer " + randomBytes(24).toString("hex") },
    });
    check(bad.status === 401, `1c an unknown token is 401 too, got ${bad.status}`);
  }

  // 2. An empty queue holds the connection for the requested window, then answers honestly.
  {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/wait?timeout=2`, { headers: { authorization: `Bearer ${token}` } });
    const elapsed = Date.now() - t0;
    const j = (await r.json()) as Record<string, unknown>;
    check(r.status === 200, `2a status ${r.status}`);
    check(j.work === false, "2b empty queue reports no work");
    check(elapsed >= 1800, `2c the request was actually HELD for the window (${elapsed}ms)`);
    check(j.waited_seconds === 2, `2d the timeout parameter was honoured, got ${String(j.waited_seconds)}`);
  }

  // 3. THE FEATURE, over the wire: work landing mid-request returns early.
  {
    const t0 = Date.now();
    const pending = fetch(`${base}/api/wait?timeout=20`, { headers: { authorization: `Bearer ${token}` } });
    setTimeout(() => {
      void withTx((c) => taskCreate(c, B, { title: "over the wire", owner: A.participant.name }));
    }, 300);
    const r = await pending;
    const elapsed = Date.now() - t0;
    const j = (await r.json()) as Record<string, unknown>;
    check(j.work === true, "3a woke with work");
    check(Number(j.tasks) >= 1, `3b reported the task count, got ${String(j.tasks)}`);
    check(elapsed < 10000, `3c returned long before the 20s window (${elapsed}ms)`);
    check(elapsed >= 250, `3d did not return before the work existed (${elapsed}ms)`);
  }

  // 4. POINTER, NOT CONTENT. If a title ever appears here, agents will act on the notification and stop
  // reading the board, and the bus will have grown a second inbox competing with it.
  {
    const r = await fetch(`${base}/api/wait?timeout=1`, { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json()) as Record<string, unknown>;
    const keys = Object.keys(j).sort().join(",");
    check(
      keys === "actor,project,tasks,unassigned,unread,waited_seconds,work",
      `4a counts and identity only, no content (got: ${keys})`,
    );
    check(
      !JSON.stringify(j).includes("over the wire"),
      "4b no task title leaks into the wake payload",
    );
  }

  // 5. The window is clamped, so a client cannot pin a connection open indefinitely.
  {
    const r = await fetch(`${base}/api/wait?timeout=99999`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const j = (await r.json()) as Record<string, unknown>;
    check(Number(j.waited_seconds) === 300, `5 an absurd timeout clamps to the 300s ceiling, got ${String(j.waited_seconds)}`);
  }

  await closeWaitChannel();
  await new Promise<void>((r) => server.close(() => r()));
  await closePool();

  if (errors.length) {
    console.error("FAIL wait.http:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(
    "OK wait.http: /api/wait is bearer-gated and its refusal is not an existence oracle; an empty queue " +
      "HOLDS the connection for the requested window and honours the timeout parameter; work landing " +
      "mid-request returns early over the wire (the feature); the payload is counts plus identity and " +
      "never content, so it cannot become a second inbox; and an absurd timeout clamps to the ceiling. " +
      "Elapsed time is asserted throughout, because a route that answered instantly would pass every " +
      "value check while being entirely broken.",
  );
}

void main();
