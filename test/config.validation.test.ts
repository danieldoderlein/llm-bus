import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";

// Item 4: config must fail LOUD at boot on broken email config - the class of bug that took prod email
// down silently for weeks (systemd split an unquoted `SMTP_FROM=LLM Bus <...>` on whitespace, so the
// app saw `SMTP_FROM=LLM`, sent `MAIL FROM:<LLM>`, and every send died 553 unnoticed). loadConfig runs
// at startup, so a rejected env means the process never boots half-broken. No DB connection here -
// loadConfig only validates process.env, which we mutate per case.

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

// Clean slate with a valid DB URL, so only the field under test can cause a failure.
function baseEnv(): void {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5440/llm_bus";
  delete process.env.CLOUD_SQL_INSTANCE;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  delete process.env.GA_MEASUREMENT_ID;
  delete process.env.BETA_FREE;
}

function betaFreeIs(label: string, expected: boolean): void {
  try {
    check(loadConfig().BETA_FREE === expected, `${label}: BETA_FREE expected ${expected}, got ${loadConfig().BETA_FREE}`);
  } catch (e) {
    check(false, `${label}: loadConfig threw on a billing flag it must tolerate: ${(e as Error).message}`);
  }
}

function throwsMatching(label: string, mustMatch: RegExp): void {
  try {
    loadConfig();
    check(false, `${label}: expected loadConfig to throw, but it succeeded`);
  } catch (e) {
    check(mustMatch.test((e as Error).message), `${label}: wrong error message: ${(e as Error).message}`);
  }
}
function succeeds(label: string): void {
  try {
    loadConfig();
  } catch (e) {
    check(false, `${label}: expected loadConfig to succeed, threw: ${(e as Error).message}`);
  }
}

function main(): void {
  // 0) minimal valid env, no email configured -> ok (self-host / dev default)
  baseEnv();
  succeeds("no email config");

  // 1) THE prod regression: a truncated SMTP_FROM with no @ must fail LOUD at boot
  baseEnv();
  process.env.SMTP_FROM = "LLM";
  throwsMatching("malformed SMTP_FROM=LLM", /SMTP_FROM/);

  // 2) a valid "Name <email>" display-name form is accepted
  baseEnv();
  process.env.SMTP_FROM = "LLM Bus <bus@example.com>";
  succeeds("display-name SMTP_FROM");

  // 3) a valid bare address is accepted
  baseEnv();
  process.env.SMTP_FROM = "bus@example.com";
  succeeds("bare-address SMTP_FROM");

  // 4) SMTP_HOST set but SMTP_FROM missing -> fail (would otherwise silently log instead of sending)
  baseEnv();
  process.env.SMTP_HOST = "smtp-relay.gmail.com";
  throwsMatching("SMTP_HOST without SMTP_FROM", /SMTP_FROM/);

  // 5) half-configured AUTH: user without password -> fail (would silently fall back to the relay)
  baseEnv();
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_FROM = "LLM Bus <bus@example.com>";
  process.env.SMTP_USER = "bus@example.com";
  throwsMatching("SMTP_USER without SMTP_PASSWORD", /SMTP_USER|SMTP_PASSWORD/);

  // 6) both AUTH credentials present -> ok (authenticated support@ send)
  baseEnv();
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_FROM = "bus@example.com";
  process.env.SMTP_USER = "bus@example.com";
  process.env.SMTP_PASSWORD = "app-pw-123";
  succeeds("both SMTP_USER + SMTP_PASSWORD");

  // 7) malformed GA id -> fail (pin the existing regex guard while we are here)
  baseEnv();
  process.env.GA_MEASUREMENT_ID = "not-a-ga-id";
  throwsMatching("bad GA_MEASUREMENT_ID", /GA_MEASUREMENT_ID/);

  // 8) BETA_FREE (decision 059) parses via an explicit "1"/"true" allowlist, NEVER z.coerce.boolean (which
  //    maps "0"/"false" -> true, a money footgun). Only "1"/"true" enable it; unset/"0"/"false"/garbage -> off,
  //    and it never throws (a billing master switch must tolerate any value, defaulting to safe = billing ON).
  for (const [val, expected] of [
    [undefined, false],
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
    ["yes", false],
  ] as const) {
    baseEnv();
    if (val !== undefined) process.env.BETA_FREE = val;
    betaFreeIs(`BETA_FREE=${val ?? "(unset)"}`, expected);
  }
  delete process.env.BETA_FREE;

  // /healthz is how a deploy is CONFIRMED, so its version must track package.json. These drifted once
  // (package.json 2.0.55 deployed while /healthz still answered 2.0.54) and the successful deploy read
  // as a failure. A version string that can lie about what is running is worse than no version string.
  {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const src = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");
    const m = /const VERSION = "([^"]+)"/.exec(src);
    if (!m) errors.push("src/http.ts no longer declares a VERSION constant - update this check");
    else if (m[1] !== pkg.version) {
      errors.push(`/healthz VERSION "${m[1]}" != package.json "${pkg.version}" - bump src/http.ts`);
    }
  }

  if (errors.length) {
    console.error(`FAIL config.validation:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK config.validation: malformed SMTP_FROM (no @) fails loud at boot; HOST=>FROM and USER<=>PASSWORD " +
      "pairing enforced; display-name/bare From accepted; GA id regex pinned; BETA_FREE parses via an " +
      "explicit 1/true allowlist (0/false/garbage/unset -> off), never throwing; and /healthz VERSION " +
      "matches package.json, which drifted once and made a successful deploy look like a failed one.",
  );
}

main();
