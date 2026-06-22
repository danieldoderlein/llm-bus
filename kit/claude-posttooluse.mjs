#!/usr/bin/env node
// LLM Bus — Claude Code PostToolUse hook adapter. FAIL OPEN.
//
// Claude invokes PostToolUse hooks with a JSON object on stdin. After a Write/Edit/
// MultiEdit tool runs, that JSON carries the path of the file just written. We extract
// that path and run the same reconcile logic as the git pre-commit hook, in --file mode.
//
// Wiring (settings.json): register this as a PostToolUse hook matching Write|Edit|MultiEdit.
// If the JSON has no usable file path, or anything goes wrong, we exit 0 (never block).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

function stdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Pull the written file path out of the PostToolUse payload, tolerant of shape drift. */
function extractPath(payload) {
  if (!payload || typeof payload !== "object") return null;
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.notebook_path,
    payload.tool_response?.filePath,
    payload.file_path,
  ];
  // MultiEdit may carry an edits[] array; the file_path is still at the top of tool_input.
  for (const c of candidates) {
    if (typeof c === "string" && c.length) return c;
  }
  return null;
}

function main() {
  const raw = stdin();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  const filePath = extractPath(payload);
  if (!filePath) {
    // Nothing to reconcile (non-file tool, or unexpected payload). Proceed.
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const hook = join(here, "reconcile-hook.mjs");

  const result = spawnSync(process.execPath, [hook, "--file", filePath], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // A non-zero exit (a confirmed collision) is surfaced to the caller; spawn failures
  // (null status) must not block — fail open.
  process.exit(typeof result.status === "number" ? result.status : 0);
}

main();
