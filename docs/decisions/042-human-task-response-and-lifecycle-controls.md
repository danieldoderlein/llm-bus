# 042 - Human task response + lifecycle controls: prose Answer/Hand-off on every task, Status dropdown, task numbers

**Date:** 2026-08-12
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (restores the "ask me" round
trip the v2 harmonization dropped, without re-introducing a separate review concept) and
[041](041-task-board-list-and-detail.md) (adds the controls to the task detail page 041 built). Refined by
[045](045-task-surface-ui-redesign.md) (the professional/design-system/mobile-first restyle). Number
claimed on the bus (`claim("decisions")` -> 042).

## Context

Operator field observation (2026-08-12), driving a task an agent created overnight: the v2 model harmonized
"a decision to make" and "work to do" into one task type, and the human web surface only rendered a response
field when a task carried `options`. So a **plain** task assigned to a human - the common shape of an agent's
"ask me" (a question, a steer, an approval that isn't a clean option pick) - showed **no way to respond**.
The operator could read it and Ship/Cancel/Assign, but could not answer in prose or route the outcome to an
agent, which the pre-v2 review flow allowed. As the operator put it: *most tasks a human gets from an agent
are decision/answer tasks, so option-only responses break the common case.*

Two facts made this a UI/wiring gap, not a model failure: (a) the domain `task_answer` **already** accepts a
prose-only note on a task with no options - only the web hid the field; and (b) the task already stores
`created_by_id` (the asking agent), so a response can route back to the asker - but `task_answer` delivered
only to *dependent* tasks, never to the asker. The round trip was half-wired.

Two adjacent UX problems surfaced in the same review: the detail page's **"Cancel"** button was ambiguous
(cancel the task, or cancel my work on it?) with no way to move an accidentally-started task back to Todo; and
tasks did not show their **`#id`**, so an operator could not find "task 344" when an agent cited it in chat.

## Decision

One cohesive change to the human task surface (the agent MCP surface is unchanged except a new queryable
`task_stop` event and answers now reaching the asker).

1. **Prose response on EVERY task (the "ask me" loop).** The detail page's controls always render a note
   field. A plain task gets **Answer & close** (records the note, completes the task); an option task keeps
   its option chips + Other. Either way the response is **delivered to the asking agent** (`created_by_id`)
   as an owner-authored post, not only to dependents - `task_answer` (domain + owner) now notifies the set
   `{dependent assignees} ∪ {asker}` minus the answerer. So an agent that asked a human learns the answer on
   its next check-in without polling.
2. **Hand to an agent.** A new **Hand to agent** action reassigns the task to a chosen agent (defaulting to
   the asker) **with the human's note** delivered to that agent; the task stays active, now agent-owned. This
   is "make the outcome into a task for an agent to handle" - it is already a task, handed back with the
   steer. (`taskHandoffFromOwner`: the tag must resolve to an in-project `agent:<pid>`; a human/out-of-project
   tag -> null, invariant 1.)
3. **Explicit Status control replaces the ambiguous Cancel.** A **Status dropdown** (Todo / In progress /
   Done / Cancelled) + Update offers only the valid targets for the current state and maps each to the right
   transition (start / **un-start** / ship / cancel / reopen). "Cancel task" is now an unambiguous choice, and
   moving an in-progress task back to Todo is a first-class transition (**`taskStop`**, in_progress -> todo,
   keeping the assignee - domain + owner twin; a new `task_stop` event, additive CHECK widen). An option task
   omits "Done" (it is answered, not shipped).
4. **Task numbers.** Every board row and the detail page show `#<id>` (globally unique `tasks.id`), so a human
   can find a task an agent references by number.

## Isolation + invariants (unchanged model)

Every new write goes through `lockTaskForWrite` (the decision-037 membership predicate, re-proven in the
locking statement): owner/admin -> any task, plain member -> only tasks assigned to them, else null -> the
handler 404s (no 403 oracle, invariant 3). The `/respond`, `/status`, and `/assign` POSTs are CSRF-guarded and
route through `layout()` + `esc()` (invariant 4). `taskHandoffFromOwner` re-proves the target agent is in the
project (invariant 1). No schema change beyond the additive `task_stop` event-type widen (created_by_id,
options, answer_note already exist since 039). After any membership-scoped write, the redirect target is
re-checked against the same visibility predicate (`afterTaskWriteDest`, 041) - a handoff can move a task out
of a plain member's view, and that must land on the board, not a 404.

## Consequences

- The human detail page's controls become three labelled sub-controls (Respond / Status / Assignee); the
  individual `/start //ship //cancel //reopen //answer` POST routes collapse into `/respond` + `/status`
  (+ the existing `/assign`).
- Agents gain no new tool; they gain answers pushed to the asker and a queryable `task_stop` event.
- **Override semantics (review F2):** "Answer & close" completes a task from `todo`/`in_progress` regardless of
  a derived block (an unmet dependency), so a human answering a blocked plain task is a deliberate SUPERVISOR
  override that then auto-unblocks dependents - consistent with `taskShip`, which also carries no blocked
  guard. The blocked note on the detail page warns before the human acts. A refused/empty answer re-renders
  the detail page with an inline error (never a bare 404) when the task is still visible to the owner; a
  foreign/missing task still 404s uniformly (no oracle).

## Reversibility

Presentation + additive: the `task_stop` event widen is reversible; the new owner mutators and routes are
removable. No data migration.

## Testing

`task.statemachine` (domain): `taskStop` (in_progress -> todo; illegal from todo/terminal); `task_answer`
notifies the asker (a second agent answers a task created by the first -> the creator receives a post).
`admin.taskwrites` (owner web, the isolation surface): answering an agent-asked task notifies that agent;
hand-off reassigns to an agent + delivers the note (a human/out-of-project tag and a non-member are refused);
`taskStop` un-starts, and is refused from todo / for a non-member. `analytics.allpages`: a PLAIN task's detail
page renders the note field + Answer & close + Hand to agent + the Status control + the `#id`. Full
`npm run verify` green.
