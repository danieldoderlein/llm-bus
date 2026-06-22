#!/usr/bin/env node
// LLM Bus reconcile hook — FAIL OPEN.
//
// Purpose: when an agent (or a human) is about to commit/write a governed file whose
// name carries a number (e.g. docs/decisions/045-foo.md, migrations/0038_init.sql),
// best-effort check the central LLM Bus ledger for a collision on that number. The
// service is a CONVENIENCE, never a gate: if it is slow, down, misconfigured, or returns
// anything unexpected, this hook prints a warning, records the skip, and EXITS 0. It must
// never block a commit because a network service is unreachable.
//
// Plain Node ESM. Node >= 22 built-ins only (global fetch, AbortController). No npm deps.
//
// Modes:
//   --staged            files come from `git diff --cached --name-only`
//   --file <path>       a single file path (e.g. from a Claude PostToolUse hook)
//
// Exit codes:
//   0  proceed (the ONLY code for any unreachable/override/unclaimed/no-match case)
//   1  a HARD collision was confirmed against a reachable service (different actor holds it)

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cwd } from "node:process";

const NET_TIMEOUT_MS = 1500; // hard ceiling on ALL network work
const STATE_DIR = ".llm-bus";

function warn(msg) {
  process.stderr.write(`[llm-bus] ${msg}\n`);
}

function notice(msg) {
  process.stderr.write(`[llm-bus] ${msg}\n`);
}

/** Append a line to a state file under .llm-bus/, creating the dir if needed. Best effort. */
function record(file, line) {
  try {
    const dir = join(cwd(), STATE_DIR);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Recording is a courtesy; never let a write failure block the commit.
  }
}

/**
 * Load config from $LLM_BUS_CONFIG (a path) or ./llm-bus.config.json.
 * Returns null if absent/unparseable — caller treats that as "fail open, do nothing".
 */
function loadConfig() {
  const path = process.env.LLM_BUS_CONFIG || join(cwd(), "llm-bus.config.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // file not present
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object") return null;
    if (!cfg.sequences || typeof cfg.sequences !== "object") return null;
    return cfg;
  } catch {
    return null; // malformed
  }
}

/**
 * Convert a glob to a RegExp anchored to the whole path. Supports:
 *   *   any run of non-slash characters
 *   **  any characters including slashes (and an optional trailing slash)
 * Everything else is matched literally.
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** -> match across path separators
        re += ".*";
        i++;
        // collapse a "**/" into ".*" (optional, so "**/migrations" also matches "migrations")
        if (glob[i + 1] === "/") {
          re += "(?:/)?";
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** First glob whose pattern matches `file` wins; returns its sequence name or null. */
function matchSequence(file, sequences) {
  const norm = file.replace(/^\.\//, "").replace(/\\/g, "/");
  for (const [glob, sequence] of Object.entries(sequences)) {
    if (globToRegExp(glob).test(norm)) return sequence;
  }
  return null;
}

/** First run of digits in the basename. "045-foo.md" -> 45, "0038_init.sql" -> 38, none -> null. */
function governedNumber(file) {
  const m = basename(file).match(/\d+/);
  if (!m) return null;
  return Number(m[0]);
}

/** The files to consider, per CLI mode. Any failure -> empty list (fail open). */
function candidateFiles(argv) {
  const fileFlag = argv.indexOf("--file");
  if (fileFlag !== -1 && argv[fileFlag + 1]) return [argv[fileFlag + 1]];
  if (argv.includes("--staged")) {
    try {
      const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
        encoding: "utf8",
      });
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return []; // not a git repo / git missing — nothing to check, proceed
    }
  }
  return [];
}

/**
 * One JSON-RPC call over MCP Streamable HTTP, sharing a single AbortController/deadline.
 * Returns the parsed `result` of the call, or throws on any transport/protocol error.
 * The signal is shared so the TOTAL of all calls stays under NET_TIMEOUT_MS.
 */
async function rpc(endpoint, token, sessionId, body, signal) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const newSession = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  const json = parseRpc(text);
  if (json.error) throw new Error(`rpc error: ${JSON.stringify(json.error)}`);
  return { result: json.result, sessionId: newSession };
}

/** Accept either a plain JSON body or an SSE-framed (`data:` lines) response. */
function parseRpc(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      if (payload && payload !== "[DONE]") return JSON.parse(payload);
    }
  }
  throw new Error("unparseable rpc response");
}

function unwrap(result) {
  // MCP tool results: { content: [{ type: "text", text: "<json>" }] }
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : result;
}

/**
 * Ask the service about `number` for `sequence`. Resolves to one of:
 *   { state: "claimed", by, next }  number already claimed (collision candidate)
 *   { state: "free", claimedId }    we claimed it just now (self-healing)
 * Throws on ANY error/timeout — caller maps that to UNREACHABLE (fail open).
 */
async function checkAndClaim(cfg, token, sequence, number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  const signal = controller.signal;
  const ep = cfg.endpoint;
  let sid;
  try {
    // 1. initialize a stateless session
    const init = await rpc(
      ep,
      token,
      sid,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "llm-bus-reconcile-hook", version: "1" },
        },
      },
      signal,
    );
    sid = init.sessionId;

    // 2. who am I? (to tell my own prior claim apart from a real collision)
    const me = await rpc(
      ep,
      token,
      sid,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
      signal,
    );
    const myActor = unwrap(me.result)?.actor ?? null;

    // 3. has this number already been claimed for this sequence?
    const q = await rpc(
      ep,
      token,
      sid,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "query_events", arguments: { type: "claim", sequence, limit: 1000 } },
      },
      signal,
    );
    const events = unwrap(q.result)?.events ?? [];
    const hit = events.find((e) => Number(e?.payload?.number) === number);
    if (hit) {
      // If I am the claimer, this is the normal claim->write flow, not a collision.
      if (hit.actor && hit.actor === myActor) return { state: "mine" };
      // Someone else holds this number. Suggest the next free one.
      const maxNum = events.reduce((m, e) => Math.max(m, Number(e?.payload?.number) || 0), 0);
      return { state: "claimed", by: hit.actor ?? "another agent", next: maxNum + 1 };
    }

    // 4. unclaimed: best-effort claim so the ledger self-heals. The server allocates the
    //    next number monotonically (which may differ from the filename's number).
    const c = await rpc(
      ep,
      token,
      sid,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "claim", arguments: { sequence } },
      },
      signal,
    );
    const claimed = unwrap(c.result);
    return { state: "free", claimedFormatted: claimed?.formatted ?? String(claimed?.number ?? "?") };
  } finally {
    clearTimeout(timer);
  }
}

async function handleFile(file, cfg, token) {
  const sequence = matchSequence(file, cfg.sequences);
  if (!sequence) return 0; // not governed — nothing to do

  const number = governedNumber(file);
  if (number === null) return 0; // no number in name — nothing to reconcile

  // Global override escape hatch: proceed unconditionally, but leave a trail.
  if (process.env.LLM_BUS_OVERRIDE === "1") {
    notice(`override-used: LLM_BUS_OVERRIDE=1 — skipping reconcile for ${file}`);
    record("overrides.log", `override ${sequence} ${number} ${file}`);
    return 0;
  }

  if (!token) {
    // No token configured: we cannot reach the service meaningfully. Fail open.
    warn(
      `service unreachable (no token in $${cfg.tokenEnv || "LLM_BUS_TOKEN"}); ` +
        `proceeding without a collision check for ${file}`,
    );
    record("pending.log", `unreachable(no-token) ${sequence} ${number} ${file}`);
    return 0;
  }

  let outcome;
  try {
    outcome = await checkAndClaim(cfg, token, sequence, number);
  } catch (err) {
    // ANY network error, timeout, or non-2xx => UNREACHABLE. THE critical path.
    warn(
      `service unreachable (${err?.message || err}); ` +
        `proceeding without a collision check for ${file}`,
    );
    record("pending.log", `unreachable ${sequence} ${number} ${file}`);
    return 0;
  }

  if (outcome.state === "mine") {
    return 0; // already claimed by you — the normal claim-then-write flow
  }

  if (outcome.state === "claimed") {
    const suggested = String(outcome.next).padStart(basename(file).match(/^\d+/)?.[0].length || 0, "0");
    const renamed = file.replace(/(^|\/)(\d+)/, `$1${suggested}`);
    warn(
      `COLLISION: ${sequence} #${number} is already claimed by "${outcome.by}". ` +
        `Use #${outcome.next} instead:`,
    );
    warn(`  git mv ${file} ${renamed}`);
    return 1;
  }

  notice(
    `reconciled ${sequence}: ${file} — you had not claimed #${number}; allocated ${outcome.claimedFormatted} on the ledger (rename if needed).`,
  );
  return 0;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) {
    warn("no config found (LLM_BUS_CONFIG / ./llm-bus.config.json); fail open, proceeding.");
    return 0;
  }
  const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : process.env.LLM_BUS_TOKEN;

  const files = candidateFiles(process.argv.slice(2));
  let exit = 0;
  for (const file of files) {
    // A confirmed collision on any one file fails the whole commit.
    const code = await handleFile(file, cfg, token);
    if (code !== 0) exit = code;
  }
  return exit;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // The hook itself must never crash a commit. Any unexpected error => fail open.
    warn(`internal error (${err?.message || err}); fail open, proceeding.`);
    process.exit(0);
  });
