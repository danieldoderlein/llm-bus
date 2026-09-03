// Decision 058 / task #611: the sticky task-board filter. Pure-unit coverage of the cookie helpers and
// the URL-vs-cookie resolution - no DB, no HTTP. The board default is "@me across all projects"; an
// explicit URL selection wins and is persisted; the stored cookie sticks otherwise; project and assignee
// fall back INDEPENDENTLY; and untrusted cookie values are validated on read (invariant 4 - a bad value
// is dropped, never reflected). Env is set before the dynamic imports (mirrors analytics.allpages).
import type http from "node:http";

process.env.DATABASE_URL ??= "postgres://board-filter@127.0.0.1:5440/llm_bus";

const { asBoardAssignee, readBoardFilter, boardFilterCookie, boardFilterCookieName } = await import(
  "../src/admin/session.js"
);
const { resolveBoardFilter } = await import("../src/admin/handlers.js");

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

// A minimal request stand-in: readBoardFilter only reads req.headers.cookie.
const req = (cookie?: string): http.IncomingMessage =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as http.IncomingMessage;
// The name=value pair (first segment) of a Set-Cookie string, as a browser would echo it back.
const pairOf = (setCookie: string): string => setCookie.split(";")[0];

async function main(): Promise<void> {
  // --- asBoardAssignee: "" and "@me" pass; a handle passes; HTML metachars / over-length / null -> null ---
  check(asBoardAssignee("") === "", "asBoardAssignee keeps Everyone ('')");
  check(asBoardAssignee("@me") === "@me", "asBoardAssignee keeps @me");
  check(asBoardAssignee("daniel/agent-x") === "daniel/agent-x", "asBoardAssignee keeps a handle");
  check(asBoardAssignee("<script>") === null, "asBoardAssignee drops HTML metacharacters");
  check(asBoardAssignee("a".repeat(65)) === null, "asBoardAssignee drops an over-length value");
  check(asBoardAssignee(null) === null, "asBoardAssignee drops null");

  // --- readBoardFilter: absent cookie -> null; round-trips project+assignee; drops forged values ---
  check(readBoardFilter(req()) === null, "readBoardFilter returns null when no cookie is present");
  const name = boardFilterCookieName();
  const parsed = readBoardFilter(req(pairOf(boardFilterCookie(5, "@me"))));
  check(
    parsed?.project === 5 && parsed?.assignee === "@me",
    `readBoardFilter round-trips project+assignee, got ${JSON.stringify(parsed)}`,
  );
  // A handle containing a slash survives the percent-encode/decode round-trip through the cookie.
  const parsedH = readBoardFilter(req(pairOf(boardFilterCookie(undefined, "daniel/agent-x"))));
  check(
    parsedH?.assignee === "daniel/agent-x" && parsedH?.project === undefined,
    `readBoardFilter round-trips a slash handle with no project, got ${JSON.stringify(parsedH)}`,
  );
  // Everyone ("") is a legitimate stored preference and round-trips.
  const parsedE = readBoardFilter(req(pairOf(boardFilterCookie(7, ""))));
  check(
    parsedE?.assignee === "" && parsedE?.project === 7,
    `readBoardFilter round-trips a saved Everyone (''), got ${JSON.stringify(parsedE)}`,
  );
  // A forged non-finite project id and an HTML-metachar assignee are DROPPED on read (invariant 4).
  const forged = `${name}=${encodeURIComponent("project=abc&assignee=<script>")}`;
  const parsedF = readBoardFilter(req(forged));
  check(
    parsedF !== null && parsedF.project === undefined && parsedF.assignee === undefined,
    `readBoardFilter drops a non-finite project and a bad assignee, got ${JSON.stringify(parsedF)}`,
  );
  // A non-INTEGER project id (a DB row id is always an integer) is dropped too, so a fractional value
  // never gets persisted stickily (gatekeeper observation, decision 058).
  const frac = `${name}=${encodeURIComponent("project=5.7&assignee=@me")}`;
  const parsedFrac = readBoardFilter(req(frac));
  check(
    parsedFrac?.project === undefined && parsedFrac?.assignee === "@me",
    `readBoardFilter drops a non-integer project id, got ${JSON.stringify(parsedFrac)}`,
  );

  // --- boardFilterCookie attributes: HttpOnly, SameSite=Lax, Path=/, Max-Age; Secure + __Host- only in prod ---
  const wasProd = process.env.NODE_ENV;
  process.env.NODE_ENV = "";
  const dev = boardFilterCookie(1, "@me");
  check(
    dev.startsWith("yolo_board=") &&
      dev.includes("HttpOnly") &&
      dev.includes("SameSite=Lax") &&
      dev.includes("Path=/") &&
      dev.includes("Max-Age=31536000"),
    `dev board cookie carries the nav-pref attributes, got ${dev}`,
  );
  check(!dev.includes("Secure"), "dev board cookie is not Secure (works over plain http on 127.0.0.1)");
  process.env.NODE_ENV = "production";
  const prod = boardFilterCookie(1, "@me");
  check(
    prod.startsWith("__Host-yolo_board=") && prod.includes("Secure"),
    `prod board cookie uses the __Host- prefix and is Secure, got ${prod}`,
  );
  if (wasProd === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = wasProd;

  // --- resolveBoardFilter: the URL-vs-cookie blend ---
  // No URL params, no cookie -> the default (@me, all projects), no write.
  const d = resolveBoardFilter({ hasProject: false, projectRaw: null, hasAssignee: false, assigneeRaw: null, cookie: null });
  check(
    d.projectId === undefined && d.assignee === "@me" && d.write === false,
    `default is @me + all projects, no write, got ${JSON.stringify(d)}`,
  );
  // A saved Everyone+project sticks when the URL is bare, and does NOT rewrite the cookie.
  const s = resolveBoardFilter({ hasProject: false, projectRaw: null, hasAssignee: false, assigneeRaw: null, cookie: { project: 3, assignee: "" } });
  check(
    s.projectId === 3 && s.assignee === "" && s.write === false,
    `a saved Everyone+project sticks with no write, got ${JSON.stringify(s)}`,
  );
  // An explicit URL selection wins over the cookie and writes.
  const u = resolveBoardFilter({ hasProject: true, projectRaw: "9", hasAssignee: true, assigneeRaw: "@me", cookie: { project: 3, assignee: "" } });
  check(
    u.projectId === 9 && u.assignee === "@me" && u.write === true,
    `an explicit URL selection wins and writes, got ${JSON.stringify(u)}`,
  );
  // A project-only URL (the "in <project>" row link) keeps the cookie's assignee lens.
  const po = resolveBoardFilter({ hasProject: true, projectRaw: "9", hasAssignee: false, assigneeRaw: null, cookie: { project: 3, assignee: "@me" } });
  check(
    po.projectId === 9 && po.assignee === "@me" && po.write === true,
    `a project-only URL keeps the cookie assignee, got ${JSON.stringify(po)}`,
  );
  // An explicit empty project= (the empty-state escape link) clears the project while keeping the assignee.
  const clr = resolveBoardFilter({ hasProject: true, projectRaw: "", hasAssignee: true, assigneeRaw: "@me", cookie: { project: 3, assignee: "@me" } });
  check(
    clr.projectId === undefined && clr.assignee === "@me" && clr.write === true,
    `an explicit empty project= clears the project, got ${JSON.stringify(clr)}`,
  );
  // A garbage URL assignee resolves to Everyone (validated), still a write.
  const bad = resolveBoardFilter({ hasProject: false, projectRaw: null, hasAssignee: true, assigneeRaw: "<x>", cookie: null });
  check(bad.assignee === "" && bad.write === true, `a garbage URL assignee resolves to Everyone, got ${JSON.stringify(bad)}`);
  // A non-integer URL project id resolves to all-projects (undefined), not a fractional id.
  const fracU = resolveBoardFilter({ hasProject: true, projectRaw: "5.7", hasAssignee: false, assigneeRaw: null, cookie: null });
  check(fracU.projectId === undefined && fracU.write === true, `a non-integer URL project id resolves to all-projects, got ${JSON.stringify(fracU)}`);

  if (errors.length) {
    console.error(`FAIL board.filter:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK board.filter: the sticky board filter (decision 058) validates untrusted cookie values, round-trips " +
      "project+assignee (Everyone included), and blends URL params over the cookie with an @me default - " +
      "project and assignee falling back independently.",
  );
}

main().catch((e) => {
  console.error("board.filter test errored:", e);
  process.exit(1);
});
