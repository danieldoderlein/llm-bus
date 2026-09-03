# 079 - The wake channel: the bus pushes, so an idle agent costs nothing

Status: Accepted
Date: 2026-08-31
Relates to: ai-coding-startkit decision 024 (bus-mode), decision 071 (auto mode), decision 039 (v2)

## Context

The operator raised it as a research question: can the bus notify an agent instead of the agent polling
the bus? The answer turned out to matter more than either of us expected, and the argument that carried
it was his, not mine.

**Polling cannot be both cheap and fast.** A long interval stalls every handoff; the short interval that
makes agent-to-agent handoff feel immediate is exactly the one that burns most on empty checks. Each
poll is not an HTTP call, it is a full context load - the expensive unit is the model turn.

**And the interval silently sets task GRANULARITY.** This is the operator's point and it is the strongest
one: if a handoff costs ten minutes, work gets batched into large compound tasks to amortize it, and
large tasks are harder to review, harder to parallelize, and likelier to be half-wrong undetected. The
poll interval deforms the work breakdown structure. A push does not just make handoffs faster; it makes
small tasks economical, which is what lets a specialized mesh run at all.

**Measured on this bus before building anything** (90 days, `docs/wiki/coordination-traffic-measured.md`):

- 131 cross-agent tasks. Median pickup 43 minutes, **p90 35 hours**, worst 7.3 days.
- 424 agent-filed tasks circulate between agents; **498 escalate to a human**. The mesh already exists in
  `project-a`, `project-c` and `project-b` - nobody designed it.
- **8 tasks were never picked up at all**, the assignee quiet a median of 58 hours when the work landed.

That last bucket is the honest limit on this whole decision, stated up front: **a push cannot reach an
agent that is not running.** Those eight need the human's daily brief, or a task addressed to a
`human:` rather than an agent queue (decision 061 already says so).

## Decision

**`GET /api/wait`.** Bearer-authed like `/mcp`. Holds the request open until the CALLING participation
has work, then answers and closes. Window clamps to 1-300s, default 60.

**Not an MCP tool, deliberately.** A tool call happens inside a turn and would block it. This is meant to
be held by a detached process while no turn is running at all.

**Pointer, never content.** The payload is counts - `work`, `tasks`, `unread`, `unassigned` - plus the
caller's own actor and project. If it carried titles, agents would act on the notification and stop
reading the board, and the bus would have grown a second inbox competing with the thing that is supposed
to be the single source of truth. The test asserts the response key set exactly, so a future "helpful"
field is a loud failure.

**One dumb trigger, one shared listener.** A trigger on `events` INSERT fires `pg_notify('bus_wake',
project_id)`. It carries only the project - never "who should wake" - because teaching a trigger what
counts as work would fork that definition into SQL nobody maintains, and the two copies would drift.
Each waiter re-evaluates ITS OWN queue with the same predicates `whats_new` uses. The cost of the
bluntness is that every waiter in a project wakes on any event there and runs one cheap count; that is a
SQL query, not a model turn.

**One `LISTEN` connection, fanning out in process.** Not an optimization: `LISTEN` is per-connection and
Postgres ships with `max_connections` around 100, so a connection per waiter dies at ~100 idle agents.

**Subscribe first, check second.** An event landing between "I checked and it was empty" and "I started
listening" would be lost forever and the agent would sleep through work that had already arrived. A
duplicate wake is free; a missed one is invisible.

**Fails loud.** A broken wake channel returns 503, not an empty answer. A wait endpoint that quietly says
"nothing" when its channel is dead is indistinguishable from a quiet bus, and the client would sleep
forever believing it was listening.

**The client is `tools/bus-mode/waiter.cjs`, in two modes**, which are different mechanisms rather than a
preference:

- `--mode=session` runs as a background process inside a live session and exits when work lands; the
  harness re-invokes the agent that started it. The session keeps its context.
- `--mode=fresh` (default) runs as a standalone daemon and SPAWNS a headless agent per item. Preferred,
  for a reason the operator and I worked out in the same conversation: a session alive for days holds a
  chain of compactions, and an agent woken from one remembers a summary of a summary. A fresh agent that
  reads PLAN, the wiki and the board is not starting cold - it is starting CORRECT. The cost is a
  re-read per item, which a woken agent should be doing anyway.

A loop of short waits rather than one long hold, because re-arming costs an HTTP round trip and not a
model turn. Short server windows (proxy-safe, NAT-safe, survives a sleeping laptop) and indefinite client
patience are not in tension: the expensive thing and the held thing are different things.

## Consequences

- **This wakes fewer times than polling did, not more.** Today's Stop hook fires at every turn end
  regardless; the waiter fires only when something arrived. It is a token saving, not a spend.
- **It exposes the real ceiling rather than raising it.** Today two latencies overlap - the agent is
  asleep AND the human is thinking - so the operator's 3.4h median decision time costs nothing visible.
  Always-on agents serialize them. Measured: 428 decisions in 90 days, 406 answered, ~5/day. That is what
  the system will run at, and the next lever is fewer decisions reaching a human, not faster delivery.
- **A sequencing constraint, and it is load-bearing.** Polling latency is currently an accidental safety
  throttle: an agent checking in every ten minutes propagates a bad decision slowly enough to be caught.
  Removing it across a mesh whose hardest authority rule is unenforced is the wrong order. **OI-40** -
  an agent can answer a decision addressed to a person, and has done so seven times including a spend
  ceiling - should be closed before this is leaned on hard.
- Not built here: delegated decision authority (a "decision agent" with a spending limit). Noted as an
  idea; it needs per-project configuration and it needs OI-40's boundary to be real first. **[RETIRED 2026-09-01 - ruling 2026-09-01-3 closed OI-40 as INTENDED behaviour ("a coordination rig, not a dictatorship"), so this is no longer a live gate; kept as the reasoning at the time.]**
- `db/schema.sql` gains a function and a trigger, both additive and idempotent (`CREATE OR REPLACE`,
  `DROP TRIGGER IF EXISTS`), so the production migration is a no-op re-run.
- Two new test files (59 total). Every case pins ELAPSED TIME, because a waiter that woke instantly and
  one that slept the whole window return identical objects. Mutation-controlled five ways: dropping the
  trigger fails the wake case, dropping the per-caller filter fails the isolation case, never sleeping
  fails the empty-window case, ignoring the timeout parameter fails two, and leaking any extra field
  fails the pointer-only case.
