# 064 - A task list is an index, not a document

**Date:** 2026-08-20
**Status:** Accepted. Amended 2026-08-20 (see "Amendment: a parameter does NOT work immediately" below). Refines [062](062-plate-never-truncated.md) (which fixed WHICH rows a list returns;
this fixes HOW MUCH each row costs) and [039](039-llm-bus-v2-task-and-message-model.md) (the task surface).
Number claimed on the bus (`claim("decisions")` -> 064). Operator-reported from a consuming rig.

## Context

An agent on the `project-c` project hit a hard failure calling `list_tasks`:

    Error: result (101,865 characters across 1 line) exceeds maximum allowed tokens.

The operator's first reading was that the tool returns every task ever, which would make it useless for
token cost. It does not - the page has been capped at 50 rows all along, and decision 062 had already made
those 50 actionable-first. Measured on prod, the real distribution of a bare `list_tasks()` in project-c:

    detail bodies                86,973 chars   93.5%
    titles                        4,247 chars    4.6%
    owner + options + answers     1,770 chars    1.9%

**The row count was never the problem. Every row was carrying a full document.** `detail` is capped at 4000
characters and averages ~1,740 across the fleet, so 50 rows is ~87,000 characters of body before any JSON
escaping - which is how a 50-row list became 101,865 characters.

The tempting fix was to narrow the default scope to the caller's own open tasks. That was measured before
being adopted, and rejected:

    today (bare call)          50 rows    ~93,000 chars
    actionable-only            44 rows    ~70,000 chars
    mine + actionable          14 rows    ~36,000 chars

Cutting 50 rows to 14 still leaves 36,000 characters, because the bodies come along. **Scope is not the
lever; body size is.** Any fix built on filtering alone fails.

One constraint shaped the design: there is no single-task read tool. `list_tasks` is the ONLY way to read a
task body, so trimming bodies without adding a precise read would have made task detail unreachable.

## Decision

**The list previews; naming a task fetches it.**

**1. Bodies are previewed, not omitted.** `detail` keeps its name and type and is cut to
`DETAIL_PREVIEW_CHARS` (140), with `detail_truncated: true` + `detail_chars: N` present ONLY on rows that
were actually cut. Keeping the field means no consumer breaks - code reading `.detail` still gets a string -
while the markers say "there is more, and this much of it". A row whose body already fit stays clean, because
the marker is derived from what came back rather than from the requested mode; deriving it from the mode
would nag a fetch that returns the identical text.

**2. The trim happens in SQL** (`left(t.detail, 140)`), so the full body never crosses the wire. Trimming in
JS would have fixed the agent's context and left the database and network cost exactly where it was.

**3. `task_ids: [12,15]` is the paired precise read** - the named tasks come back in FULL, whatever the
detail mode and whatever their state, bounded at `MAX_TASK_IDS` (20). Naming a task IS asking for its body.
This is deliberately a FILTER on the existing tool rather than a new `task_get` tool: adding a tool forces
every agent to reconnect before it can see it (MCP clients cache the tool list, which `guide()` already warns
about), whereas a new parameter works immediately for every already-connected agent.

**4. The default drops the terminal archive.** An agent asking "what is on the board" means open work;
`all_states: true` or an explicit `status` brings it back. The predicate uses raw `t.status` rather than the
effective one - it is indexable, and every legacy or derived state resolves to non-terminal, which is the
safe direction.

**5. Every verbose override is offered**, per the operator's requirement that an agent be able to be
deliberately verbose: `detail: "full"` (the old behaviour, exactly), `detail: "none"` (titles only, with
sizes still reported so an agent knows a body exists), `all_states`, plus the existing
`status`/`owner`/`lane`/`mine`/`limit`.

Measured in test: **63,356 -> 4,268 characters, 93% saved**, with nothing made unreachable.

## What was rejected, and why

**Defaulting to `mine: true`.** It was the operator's initial instinct and it is the wrong knob. It breaks a
core bus function - seeing grabbable work and what teammates are doing - and the cheap "my plate" channel
already exists and already carries no bodies: `whats_new.my_open_tasks`. The clean split is **whats_new for
your plate, list_tasks for the board, task_ids for bodies.**

**A new `task_get` tool.** Correct-looking, but it would strand every connected agent behind a reconnect for
a capability a parameter delivers immediately.

## Caught by dogfooding: a parameter the client cannot express does not exist

Calling the freshly deployed tool to verify the paired read, `task_ids:[536]` was REJECTED - Claude Code,
the primary consumer, had serialized the array as the STRING `"[536]"`. Twice, so not a typo.

That is not a cosmetic interop wrinkle. `task_ids` is the ONLY path to a task body once bodies are
previewed, so a client that cannot express it would have left task detail unreachable - the exact failure
this decision set out to prevent, reintroduced through the fix for it. The tool now accepts an array OR a
comma-separated string (`parseTaskIds`: tolerant on the way in - bracket and space noise stripped,
duplicates collapsed, non-positive and non-numeric entries dropped - strict in what it yields, still capped
at 20).

The general rule: when a new parameter is the only route to something, exercise it through a REAL client
before believing it works. The schema was valid, the tests passed, and it was still unusable.

## Consequences

- The default response SHAPE changes for five live rigs. Nothing is removed, no tool is added, so no
  reconnect is required, and `detail: "full"` restores the previous behaviour byte for byte. Announced once
  per agent (announcement id 7) and carried in `guide()`.
- `board.truncation` was re-pointed rather than weakened: decision 062's "actionable rows sort before
  terminal ones, so a limit can only eat archive" still has to hold wherever terminal rows are in scope, so
  that assertion now runs under `all_states: true` - which is exactly where a page limit can still bite.
- `test/task.listshape.test.ts` asserts the SHAPE and then the actual PAYLOAD SIZE. A shape-only test would
  pass a change that saved nothing, and the entire point of this decision is a number.

## Amendment: a stale tool schema hides a parameter, it does not disable it (2026-08-20, corrected 2026-08-21)

**Read the correction before the story.** This amendment was first written on a report that a connected
agent could not use `task_ids` after 064 went live, and concluded that 064's reasoning - "a parameter works
immediately where a new tool strands connected agents" - was false. The reporter has since retracted: the
schema they read DID list `task_ids` on every fetch including the first, they misread it, and they never
made the call that would have settled it. The window closed on a reconnect, so whether the call would have
worked beforehand is now permanently unknowable from their side.

So it was measured here instead, which should have happened first. **A cached tool schema does not gate
what a client can SEND**: the SDK client transmits an argument absent from its cached `inputSchema` and the
server receives it. That is now a guard in `smoke.mcp`, so the fact cannot drift into folklore again.

WHAT IS ACTUALLY TRUE. An MCP client fetches `tools/list`, including every `inputSchema`, once at connect
time, and the stateless transport (decision 030) has no session on which to send `tools/list_changed`. So
an agent connected before a parameter ships is never TOLD it exists - it is not prevented from using it. A
stale schema is an INFORMATIONAL gap, not a mechanical one. 064's original reasoning stands: a parameter
does work immediately for anyone who knows to send it, while a new TOOL genuinely strands connected agents,
because there is no response to hang a notice on until the tool is called. That asymmetry - not "send
versus receive" - is the reason to prefer a parameter.

WHAT WAS SHIPPED ANYWAY, AND WHY IT IS STILL RIGHT. `list_tasks` returns `reading_a_full_body` on any
response that cut a body, naming `task_ids` and telling the caller to send it even if they cannot see it
listed. Under the corrected model this is not a workaround for a broken channel - it is a complete fix for
the only thing the caller was missing, which is knowing. It rides the response, and no cache can stale a
response. The general rule worth keeping: **a change that alters what a caller RECEIVES lands instantly; a
change that gives them something new to SEND lands only when they learn of it, so ship the telling with
it.**

WHAT THIS EPISODE COST AND TAUGHT. Two people spent an afternoon on a regression that may never have
existed, and a wrong rule reached `docs/architecture.md` and this file before anyone ran the one-line
experiment that disproved it. Both of us had the applicable discipline already written down - the reporter
had told me twice that absence of output is not evidence - and both of us skipped it on a report that felt
conclusive. The twin of the rule we did have: **before believing a FAILING check, ask what it would look
like if the thing were fine.** Reading "no `task_ids` in the schema" and calling `list_tasks(task_ids:)`
look identical right up until you make the call.

Left standing, because it was directly observed rather than inferred: `reading_a_full_body` does arrive in
the response and reaches a caller whatever its schema state. Not standing: any claim that the caller could
not otherwise have expanded the body.

A TRAP FOUND WHILE VERIFYING, worth more than the verification. Asked whether announcements reach an
already-connected client, a fresh `whats_new()` returned no announcements array at all. Reported as-is that
would have read as "the remediation reaches nobody" and prompted a fix for a working system. The truth is
the opposite: announcements 7 and 8 HAD both been delivered in full to that same connection earlier in the
session, and are absent now because they are one-time and were consumed. A one-shot delivery and a broken
delivery are indistinguishable on the second look. Verifying announcement reach on an agent that has
already consumed one requires a fresh identity or a server-side delivery record; the agent's own second
call cannot tell you. This is tagged on CLAUDE.md section 06.

Noted for future decisions: this is the same failure class as 065 (an advertisement that could disagree
with the routing surface), one layer up - there the roster advertised a lane that did not deliver, here an
announcement advertised a parameter the schema did not carry. 065 fixed its case by making the two
surfaces impossible to disagree; the schema/response split cannot be collapsed that way, so it needs the
recovery path instead.
