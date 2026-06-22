import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { getPool, initPool } from "./db.js";
import { billingEnabled } from "./billing/stripe.js";
import { meterAll } from "./billing/meter.js";

// How often the billing reconciler tallies new ledger events and debits balances (off the hot path).
const METER_INTERVAL_MS = 30_000;

// A long-running server must not be killed by a stray background promise rejection (e.g. an MCP
// transport close race). Log it and keep serving; genuine startup failures still exit via the
// main().catch below, and systemd restarts on a hard crash.
process.on("unhandledRejection", (reason) => {
  console.error("[llm-bus] unhandledRejection (continuing):", reason);
});

async function main(): Promise<void> {
  const config = loadConfig();
  // Build the Cloud SQL connector pool when configured (no-op on the direct-pool path).
  await initPool();
  // Probe the database, but do NOT die if it is not reachable yet: the server must still boot so it
  // can answer MCP introspection (the tool list needs no DB); tool calls that touch the DB error at
  // call time. This keeps the container startable without a live DB (directory build-tests, a DB that
  // comes up just after the app) instead of crash-looping on a transient connection failure.
  try {
    await getPool().query("SELECT 1");
  } catch (e) {
    console.warn("[llm-bus] database not reachable at startup (continuing):", (e as Error).message);
  }
  const server = createHttpServer();

  // Billing meter tick (decision 015): off the hot path, gated by config, never started in dev/test
  // or self-host without Stripe. unref() so it never holds the process open.
  if (billingEnabled(config)) {
    const tick = setInterval(() => {
      void meterAll().catch((e) => console.error("[llm-bus] meter:", e));
    }, METER_INTERVAL_MS);
    tick.unref();
    server.on("close", () => clearInterval(tick));
  }

  server.listen(config.PORT, config.BIND_ADDRESS, () => {
    console.log(
      `[llm-bus] listening on ${config.BIND_ADDRESS}:${config.PORT} ` +
        `(platform=${config.RUN_PLATFORM}, public=${config.PUBLIC_URL}, env=${config.NODE_ENV})`,
    );
  });
}

main().catch((err) => {
  console.error("[llm-bus] failed to start:", err);
  process.exit(1);
});
