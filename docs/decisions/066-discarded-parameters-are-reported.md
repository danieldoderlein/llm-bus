# 066 - A discarded parameter is reported back, not silently dropped

**Date:** 2026-08-21
**Status:** Accepted. Continues the silent-mis-addressing lineage
[061](061-assignee-routing-humans-visible.md) -> [065](065-lane-delivery-reads-both-columns.md). Number
claimed on the bus (`claim("decisions")` -> 066). Found by `owner/owner-workspace-16` while re-running 064's
client-behaviour experiment on a second MCP client.

## Context

The MCP SDK builds a zod object from each tool's `inputSchema`, and zod STRIPS keys the schema does not
declare. So an argument a tool does not have is removed and the call succeeds normally: no error, no
warning, no echo. Measured on two independent client implementations - the SDK client and Claude Code's -
both transmit an argument absent from their cached schema, and the server discards it in silence.

The consequence is a wrong answer that looks like a right one:

    list_tasks(task_id: [606])     -> task_id is not a parameter; discarded
                                   -> returns the DEFAULT unfiltered index
                                   -> the caller reads row one as the answer to a question it never asked

Same for `owner` vs `actor`, `lane` vs `to_lane`, and every other near-miss. The caller has no way to
detect it: a filtered result and an unfiltered one are both plausible lists of tasks.

This is the shape 065 removed for lanes, one layer over. There, a post to a lane nobody held was accepted
and reached nobody; the fix was to refuse the unknown lane and to report `reaches` on every send. Here an
argument nobody declared is accepted and filters nothing. The argument transfers unchanged: **a caller
cannot miss a number, but cannot see a discarded field at all.**

It is also the mirror of 064's amendment, which established that a stale schema HIDES a parameter rather
than disabling it. Both halves are now known: a caller may not know a real parameter exists, and may not
learn that one it sent does not.

## Decision

Report, do not reject. Any tool response whose call carried arguments the tool does not declare gains
`_ignored_params`, naming each discarded key, suggesting the nearest real parameter within two edits
(`task_id (did you mean task_ids?)`), and listing what the tool does accept.

- **Reported rather than refused**, because refusing unknown arguments breaks every existing caller the
  moment a server ships a stricter build, and that cost is not needed to make the mistake visible. Strict
  rejection is what makes a probe measurable (the reporter notes Vertex `:predict` returning 400 on an
  unknown field, which is how a colleague proved a `labels` field was genuinely honoured rather than
  ignored) - and that is a real argument FOR rejection, worth revisiting if the nag proves insufficient.
  It is a reversal we can make later; the reverse is not.

  The reporter subsequently argued against their own counter-case, and the argument is the one that
  actually settles it: strict rejection made the Vertex probe measurable, but that probe was a deliberate
  experiment by someone who controlled BOTH ENDS. This surface serves long-lived agents that upgrade
  underneath themselves. Those are different populations, and optimising a production surface for the
  convenience of the experimenter is the wrong trade. Recorded rather than omitted so the reasoning is
  reusable when someone revisits this - the same instinct as amending 064 in place rather than quietly
  patching it.
- **Captured before zod runs**, in `http.ts`, because by the time a handler sees its arguments the evidence
  is gone. The argument keys as sent are passed into `buildServer` and compared against the tool's declared
  keys in the same wrapper that already adds `_unread_posts` and `_open_tasks`.
- **Silent on a correct call.** A nag that fires on good calls is noise and gets tuned out, which is how
  the informational-tag allowlist in 063 decayed.
- **Fail-open** (invariant 5): the whole check is wrapped, and an unintrospectable body simply yields no
  nag. It must never fail a real call.

## Consequences

- Every tool gains a possible response field. Additive; no caller breaks.
- A misspelled parameter is now one round trip from being understood, rather than an answer to a different
  question. This closes the last silent-accept surface on the bus that anyone has identified.
- `smoke.mcp` guards three cases at the wire: an unknown argument is reported, a near-miss names the
  intended parameter, and a correct call stays clean.

## The review lesson, recorded because it produced a wrong rule this week

064's amendment was written by two agents who each reached for explanation before measurement, and each
treated the other's account as the check. The result was a rule in `docs/architecture.md` that a one-line
experiment disproved. Stated by the reporter, and worth keeping: **independent review is only independent
if the second party runs the experiment rather than reading the argument.** The second client
implementation in this decision exists for that reason - a rule generalised from one SDK was re-run on
another before being trusted.
