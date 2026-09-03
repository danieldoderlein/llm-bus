// The OAuth connector consent page (consentPage) preselect logic. The footgun we're guarding:
// auto-selecting the first existing membership (alphabetical) made a stale project the one-click
// default, so a fast "Allow & connect" could hand an agent a token to the WRONG project. Rule now:
// preselect a pending invite (high intent) or - for a brand-new account with no projects - "start
// fresh"; but when the account already drives projects, preselect NOTHING and force an explicit pick.
import { consentPage } from "../src/admin/html.js";

const errors: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) errors.push(msg);
}

// The radio for a given choice value is rendered checked as: value="<v>" checked
function isChecked(html: string, value: string): boolean {
  return html.includes(`value="${value}" checked`);
}

function main(): void {
  const csrf = "csrf-token";
  const host = "localhost:64452";
  const mA = { participationId: 11, projectName: "claude test", participantName: "claude-test-agent" };
  const mB = { participationId: 22, projectName: "zzz other", participantName: "zzz-agent" };
  const inv = { inviteId: 7, projectName: "invited proj", intendedName: "guest" };

  // (1) Account already drives projects, no invite: NO membership preselected, "new" not preselected,
  // and the "choose" prompt shows so the empty state does not read as a dead button.
  const withMembers = consentPage("Claude Code", host, csrf, [mA, mB], []);
  check(!isChecked(withMembers, "membership:11"), "membership:11 must NOT be preselected (the footgun)");
  check(!isChecked(withMembers, "membership:22"), "membership:22 must NOT be preselected");
  check(!isChecked(withMembers, "new"), '"new" must NOT be preselected when projects exist');
  check(withMembers.includes("Choose which project this agent connects to."), "empty-state prompt must render");

  // (2) A pending invite is high-intent: preselect it.
  const withInvite = consentPage("Claude Code", host, csrf, [mA], [inv]);
  check(isChecked(withInvite, "invite:7"), "a pending invite must be preselected");
  check(!isChecked(withInvite, "membership:11"), "membership must not steal the default from an invite");

  // (3) Brand-new account (no projects, no invites): preselect "start fresh" (nothing to get wrong).
  const fresh = consentPage("Claude Code", host, csrf, [], []);
  check(isChecked(fresh, "new"), '"new" must be preselected for a first-time account');

  // (4) A bad/empty re-submit passes an error, which renders as a notice (over the soft prompt).
  const withError = consentPage("Claude Code", host, csrf, [mA], [], "Choose where to connect before continuing.");
  check(withError.includes("Choose where to connect before continuing."), "error notice must render");
  check(!withError.includes("Choose which project this agent connects to."), "error wins over the soft prompt");

  // (5) esc() chokepoint: a hostile project/participant name is escaped, never raw in the markup.
  const xss = consentPage("Claude Code", host, csrf, [{ participationId: 99, projectName: `<script>a</script>`, participantName: "x" }], []);
  check(!xss.includes("<script>a</script>"), "project name must be HTML-escaped");
  check(xss.includes("&lt;script&gt;a&lt;/script&gt;"), "project name must appear escaped");

  if (errors.length) {
    console.error(`FAIL consent.preselect:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK consent.preselect: existing projects force an explicit pick (no stale default); invite preselected; first-run defaults to start-fresh; bad re-submit shows an error; names escaped.",
  );
}

main();
