// Naming the actor in a decision task (operator report, 2026-09-01).
//
// He read his own board and could not answer his own task. The options were "I will commit it myself",
// "You commit just that line, leave my other files", "Leave it - I am mid-change and know about it".
// The agent wrote them; he read them. Neither pronoun has a resolvable referent at that point, and the
// two readings are OPPOSITE instructions - the agent offering to act, versus the agent repeating what
// the human said.
//
// The guard WARNS and never refuses: a refusal would reject a live decision handoff over prose style,
// and the entire purpose of the call is that the decision reaches its decider. So every case below
// asserts BOTH that the warning fired AND that the task exists anyway.
import { freshProject, createParticipation } from "./_setup.js";
import { ambiguousActorWarning, taskCreate, taskEdit } from "../src/domain/task.js";
import { coordinationGuide } from "../src/invite.js";
import { withTx, getPool, closePool } from "../src/db.js";

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  const A = await freshProject("actornaming");
  const pool = getPool();

  // 1. HIS ACTUAL OPTIONS, verbatim. If this ever stops firing, the report that caused this file is back.
  {
    const w = ambiguousActorWarning([
      "I will commit it myself",
      "You commit just that line, leave my other files",
      "Leave it - I am mid-change and know about it",
    ]);
    check(w !== undefined, "1a the operator's real option set must warn");
    check(/3 of 3/.test(w ?? ""), `1b all three are ambiguous, got: ${w}`);
    check(/AGENT/.test(w ?? "") && /HUMAN/.test(w ?? ""), "1c the warning must SHOW the fix, not just name the fault");
    check(/task_edit/.test(w ?? ""), "1d and must name the tool that repairs it");
  }

  // 2. THE REWRITTEN FORM IS CLEAN. Without this the guard could be a function that always warns, which
  //    would be indistinguishable from a working one on case 1 alone.
  {
    const w = ambiguousActorWarning([
      "AGENT commits the line, leaves the other files",
      "HUMAN commits it themselves",
      "NOBODY acts - human is mid-change and knows",
    ]);
    check(w === undefined, `2a the named-actor rewrite must NOT warn, got: ${w}`);
    check(ambiguousActorWarning(["Ship now", "Wait for review"]) === undefined, "2b ordinary options stay quiet");
    check(ambiguousActorWarning(["Deploy 2.0.55", "Hold"]) === undefined, "2c a version string is not a pronoun");
    check(ambiguousActorWarning(undefined) === undefined, "2d a task with no options is not a decision task");
    check(ambiguousActorWarning([]) === undefined, "2e an empty option list warns about nothing");
  }

  // 3. THE /i FLAG TRAP. "I" needs a case-SENSITIVE match; folding case would make it fire on any stray
  //    lowercase "i". A guard that cries on innocent text gets ignored, which is the same as absent.
  {
    check(ambiguousActorWarning(["Pick option i", "Pick option ii"]) === undefined, "3a lowercase 'i' is not the pronoun");
    check(ambiguousActorWarning(["Migrate to iOS", "Stay on Android"]) === undefined, "3b 'iOS' must not trip it");
    check(ambiguousActorWarning(["I ship it", "Hold"]) !== undefined, "3c but the real pronoun I still fires");
    check(ambiguousActorWarning(["Your call", "Defer"]) !== undefined, "3d and 'Your' fires case-insensitively");
  }

  // 4. THE WARNING RIDES A REAL task_create AND THE TASK IS STILL THERE. Warn-not-refuse is the contract.
  {
    const r = await withTx((c) =>
      taskCreate(c, A, {
        title: "Commit the stray line?",
        options: ["I will commit it myself", "You commit just that line"],
      }),
    );
    check(typeof r.task_id === "number", "4a the task is created despite the ambiguity");
    check(/ambiguous actor/.test(r.warning ?? ""), `4b and task_create returns the warning, got: ${r.warning}`);
    const row = await pool.query(`SELECT id FROM tasks WHERE id = $1 AND project_id = $2`, [r.task_id, A.project.id]);
    check(row.rowCount === 1, "4c the row really exists - a warning is not a silent refusal");

    // task_edit is the documented repair, so it must both accept the fix and go quiet on it.
    const fixed = await withTx((c) =>
      taskEdit(c, A, {
        task_id: r.task_id,
        options: ["AGENT commits the line", "HUMAN commits it themselves"],
      }),
    );
    check(fixed.warning === undefined, `4d the repaired task_edit is quiet, got: ${fixed.warning}`);
  }

  // 5. AN ASSIGNEE WARNING AND AN ACTOR WARNING MUST NOT EAT EACH OTHER - they share one `warning` field.
  {
    // A real agent that has never polled: that is what raises the dormant-queue warning.
    await createParticipation(A, "never-polled-bot");
    const r = await withTx((c) =>
      taskCreate(c, A, {
        title: "Two problems at once",
        owner: "never-polled-bot",
        options: ["I do it", "You do it"],
      }),
    );
    check(/ambiguous actor/.test(r.warning ?? ""), `5a the actor warning survives, got: ${r.warning}`);
    check(/never-polled-bot/.test(r.warning ?? ""), `5c the dormant-queue warning survives too, got: ${r.warning}`);
    check((r.warning ?? "").includes("|"), `5b and is joined with the assignee warning, not replacing it: ${r.warning}`);
  }

  // 6. THE REMOTE SURFACES CARRY IT. The guide and the announcement are the only levers that reach an
  //    agent this rig does not own, which is the whole reason the rule is written down at all.
  {
    const guide = coordinationGuide(false);
    check(/NAME THE ACTOR/.test(guide), "6a the coordination guide must carry the rule");
    check(guide.includes("AGENT") && guide.includes("HUMAN"), "6b and must show the named-actor form");
    // The hosted build announces this rule once per agent; a self-hosted bus ships no announcements
    // (see src/announcements.ts), so only the guide half is asserted here.
  }

  await closePool();
  if (errors.length) {
    console.error("FAIL task.actornaming:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(
    "OK task.actornaming: the operator's real option set ('I will commit it myself' / 'You commit just that " +
      "line') warns and names the fix, while its named-actor rewrite is silent - so the guard is not one " +
      "that always fires; the /i-flag trap is pinned both ways (lowercase 'i' and 'iOS' stay quiet, the " +
      "pronoun I and 'Your' still fire); the warning rides a real task_create and THE TASK STILL EXISTS, " +
      "because warn-not-refuse is the contract - a refusal would drop a live decision over prose style; " +
      "task_edit repairs it and goes quiet; an actor warning and an assignee warning share one field " +
      "without eating each other; and the guide plus announcement 16 carry the rule to agents this rig " +
      "does not own.",
  );
}

void main();
