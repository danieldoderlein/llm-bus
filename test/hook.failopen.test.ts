// FAIL-OPEN guardrail for the reconcile hook (UNIT G). NO database, NO _setup.
//
// This is the single most important behavioral guarantee in the kit: when the LLM Bus
// service is unreachable, the reconcile hook must WARN, record the skip, and EXIT 0 —
// never block. We prove it by pointing the hook at a dead port (127.0.0.1:1) so the
// network call fails fast, then asserting exit 0 + a warning + a pending.log entry.
//
// We run the real .mjs as a subprocess (the way git/Claude invoke it), in a throwaway
// temp cwd, so the test touches no network service and no database.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "kit", "reconcile-hook.mjs");

const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

function run(args: string[], cwd: string, configPath: string) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_BUS_CONFIG: configPath,
      // A token must be present so the hook attempts the network call (which then fails
      // against the dead port) rather than short-circuiting on "no token".
      LLM_BUS_TOKEN: "test-token-not-real",
      // Make sure no stray override leaks in from the runner's environment.
      LLM_BUS_OVERRIDE: "",
    },
  });
}

function main(): void {
  // A temp dir holding the config; a separate temp dir as the cwd (where .llm-bus/ lands).
  const cfgDir = mkdtempSync(join(tmpdir(), "llm-bus-cfg-"));
  const configPath = join(cfgDir, "llm-bus.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      // Dead port: connection refused / unreachable within the hook's 1500ms ceiling.
      endpoint: "http://127.0.0.1:1/mcp",
      tokenEnv: "LLM_BUS_TOKEN",
      sequences: { "docs/decisions/*.md": "adr" },
    }),
  );

  // CASE 1: a governed, numbered file with the service unreachable => FAIL OPEN.
  const cwd1 = mkdtempSync(join(tmpdir(), "llm-bus-run1-"));
  const r1 = run(["--file", "docs/decisions/045-example.md"], cwd1, configPath);

  check(r1.status === 0, `case1: expected exit 0 (FAIL OPEN), got ${r1.status}`);
  const warned = /unreachable/i.test(r1.stderr ?? "");
  check(warned, `case1: expected an "unreachable" warning on stderr, got: ${JSON.stringify(r1.stderr)}`);
  const pendingPath = join(cwd1, ".llm-bus", "pending.log");
  check(existsSync(pendingPath), `case1: expected ${pendingPath} to exist`);
  if (existsSync(pendingPath)) {
    const body = readFileSync(pendingPath, "utf8");
    check(/045-example\.md/.test(body), `case1: pending.log missing the file entry: ${JSON.stringify(body)}`);
  }

  // CASE 2: a file matching NO glob => exit 0, no reconcile attempted, no pending entry.
  const cwd2 = mkdtempSync(join(tmpdir(), "llm-bus-run2-"));
  const r2 = run(["--file", "README.md"], cwd2, configPath);

  check(r2.status === 0, `case2: expected exit 0, got ${r2.status}`);
  const noPending = !existsSync(join(cwd2, ".llm-bus", "pending.log"));
  check(noPending, `case2: README.md matches no glob; expected NO pending.log, but one was written`);

  if (failures.length) {
    console.error(`FAIL hook.failopen:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK hook.failopen: service unreachable -> exit 0 + warning + pending.log; non-matching file -> exit 0, no pending.",
  );
}

main();
