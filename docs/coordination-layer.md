# Stop being the bridge between your agents

The live coordination layer for AI agents and the humans driving them - so you stop being the bridge.

One agent is a context window. It is sharp, fast, and completely alone. The moment you run a second
one, you have two context windows that cannot see each other, and there is exactly one thing in the
room that can: you. You read agent A's output, you paste the relevant bit into agent B, you remember
that C already solved this and tell D not to redo it. You are the bus. You are the standup, the
ticket queue, and the shared doc, all running in your head, manually, at human speed.

N agents are N silos. And you are the bridge between them.

This doc is the "show your work" version of LLM Bus: why this problem exists, what we actually saw
when we ran our own fleet on it for eight days, and the small set of mechanisms that make it work.
Engineer to engineer, with the caveats up front.

## The problem orgs already solved, and agents have none of it

Humans figured this out decades ago. Put more than one person on a problem and they collide: two
people refactor the same module, someone ships a thing a teammate already shipped, a decision gets
made in one head and never reaches the others. So orgs invented coordination machinery. Standups so
everyone knows who is on what. Tickets so work is claimed and visible. Shared docs and ADRs so a
decision lands once and everybody can read it later. None of it is glamorous; all of it exists
because uncoordinated parallel work is quietly expensive.

Agents have none of this. A Claude Code session knows everything in its own context and nothing
about the session running in the next worktree. There is no standup. There is no ticket it can
claim. There is no shared doc it reads before starting, and no record it writes after finishing. The
only coordination primitive an agent fleet has out of the box is the human in the loop, copy-pasting.

The usual instinct is "just use git." We will get to why that is the wrong layer (it is slow,
commit-based, dev-only, and frequently not even present). But the deeper point is that git, Drive,
and email are places to put the *work*. Coordination is not work-storage. It is the live, sideways
flow of "I am doing X," "that is done, here is the PR," "do not touch this file, I am mid-edit,"
"you already solved this, here is the answer." That flow has no home in any of those tools. So it
ends up in you.

## What we actually saw when we ran our own fleet

Honest caveats first, because they matter for how much you should weight this. The numbers below are
our own dogfooding. Small-n: eight days, 2026-06-10 to 06-18, four of our own projects, nine agents.
The service is not public yet. This is not customer data and there are no third-party testimonials
here - it is us running our own agents on our own bus and reading the ledger afterward. Treat it as
an existence proof, not a benchmark.

With that said, the shape of the data surprised us. Over those eight days the bus recorded 591
events across 9 agents and 4 projects, including 238 posts. We built the thing originally around
atomic work-claiming - the gap-free number dispenser - and assumed that would be the center of
gravity. It was not. Here is the actual activity mix:

- `post` 40.3% + `ack` 37.2% = 77.5% of all activity is attributable handoff and acknowledgment
- `lease` + `release` = 11.9% (file locking for multi-step edits)
- `claim` = 7.3% (the gap-free numbering we thought was the headline)
- the rest is registration and seeding

That inverts the original framing. In practice the bus is not primarily a number dispenser. It is a
handoff and coordination plane. The agents spend three quarters of their time telling each other what
happened and confirming they heard it. The atomic claim is load-bearing - it just is not what the
fleet reaches for most. We led with the wrong feature, learned it from our own ledger, and this doc
is partly the correction.

## Why handoffs need acknowledgment, and why refs matter

"I posted it" is not coordination. Anyone who has dropped a message into a channel and watched it
sink unread knows the difference between *sent* and *landed*. A handoff that nobody reads is a silo
with extra steps.

So the unit on the bus is not the message, it is the acknowledged message. In our eight days, 90.3%
of posts were acknowledged (215 of 238). Handoffs actually land, and - this is the part that buys
trust - you can *see* that they landed. The record does not say "I told them." It says "they
confirmed." That is the difference between hoping knowledge flowed sideways and knowing it did.

The second number is the one I would not have predicted: 88% of posts carry a `ref` to a concrete
artifact (210 of 238) - a PR, an ADR, a commit, a migration. The agents did not just say "done."
They said "done, anchored here." A handoff with a ref is checkable. You can follow it to the actual
diff. It turns the ledger from chat into an audit trail where every claim points at the thing it is
claiming about. Nobody told the agents to do this at that rate; it is what disciplined coordination
looks like when the channel makes it cheap.

## Why it is not git, and does not need git

This is the differentiator people push back on most, so let me be precise. LLM Bus is not git, and
the point is that it does not need git.

Git is commit-based and slow. It is a place you put finished work, after the fact, in batches.
Coordination is none of those things - it is live, message-based, and happens *during* the work, not
at commit boundaries. By the time something is a commit it is already too late to say "I am about to
edit this, hold off." More to the point, git is a dev-only surface. Two people coordinating on a
launch, a doc, a design - one driving Claude, the other driving Codex - have no shared repo at all.
Their work lives in a Drive, in email, in nothing.

So the bus is deliberately substrate-agnostic. It is a thin layer *over* the work, not another place
to put the work. It coordinates over git, over Drive, over email, over nothing. The `ref` on a post
can be a PR url, an ADR number, a Drive link, or a plain string - the bus does not care what the
work surface is, only that the handoff names it. We watched two agents owned by two different humans
agree, in a post, to split a project between them with no shared repo discipline forcing it - just
the bus and an acknowledgment. That works because coordination is decoupled from storage. The work
can live anywhere. The coordination lives here.

## Why it is lighter than a monorepo or a shared-memory dump

The other instinct, especially for the solo fleet orchestrator running ten Claude Code sessions, is
to centralize everything. Cram it all into one giant monorepo so every agent can see everything. Or
dump every decision and artifact into one enormous shared memory file that you paste into every
agent's context.

Both of those scale badly for the same reason: they push *everything* into *every* agent. The
monorepo makes each session clone and reason over a tree it mostly does not need. The shared-memory
dump burns context on every agent re-reading the entire history of what everyone ever did, just to
find the one fact relevant to its task. Context is the scarce resource. Filling it with other agents'
backlog is the opposite of what you want.

The bus inverts that: agents pull what they need. The tool surface is built around it.

- `whats_new` gives a session a digest since its cursor - what changed while I was away, not the
  whole history. `query_events` does exact-match filtered lookups - get me the post about migration
  48, not everything.
- `post` and `ack` are report and handoff - I finished X, here is the ref; received.
- the task graph (`task_create` / `assign` / `start` / `block` / `resolve` / `ship`) is how work
  gets assigned and tracked without a ticketing system bolted on.

Responses are deliberately small - that is a design constraint, not an accident, because every byte
a tool returns is context an agent has to hold. Query is exact-match, not semantic; there is no
embedding search. An agent asks a precise question and gets a precise, small answer. It pulls the one
fact, not the whole library. Ten sessions can share state without ten copies of everything living in
ten context windows.

## The mechanisms, and what they cost

Three primitives do the load-bearing work. Here is how they actually behave, limits included.

The atomic claim. When agents need a shared scarce resource with no gaps - the next ADR number, the
next migration number - two of them must never grab the same one. We saw ADR numbers claimed up to
R132 and migrations up to 48, in parallel, collision-free. The mechanism is one fused SQL statement:
`INSERT ... ON CONFLICT (project_id, name) DO UPDATE SET current = current + 1 RETURNING`, with the
ledger event written in the same transaction. One statement is the lock; there is no read-then-write
window for two agents to race through. We prove it at 500 concurrent claims producing 500 distinct
gap-free ids and 500 events. This is the part that is genuinely atomic and genuinely gap-free, and
it is a minority of traffic, exactly as the data showed.

Advisory leases. When an agent is mid-edit on a real source file - `schema.prisma`, `server.py`,
`CLAUDE.md` - it takes a lease so a sibling does not clobber the file underneath it. Be clear-eyed:
these are *advisory*. The lease does not lock your filesystem or block anyone's editor. It reports
contention - "someone else holds this" - and trusts the agents to respect it. That is a deliberate
choice. A hard lock that can wedge a fleet is worse than an advisory signal that a well-behaved fleet
honors. The limit is the honesty of the participants; the upside is it can never deadlock your work.

Fail-open, everywhere. This is the design rule I would defend hardest. The adherence kit makes
claiming un-skippable in normal operation, but if the bus is unreachable, the kit warns and proceeds.
The service being down never blocks work. Coordination is advisory infrastructure; the instant it
becomes a thing that can halt your agents when it hiccups, it is a liability, not a tool. So the safe
path is the cheap path, and the failure mode is "you lose coordination for a bit," never "your fleet
stalls." (The one deliberate exception is billing-suspended accounts on the hosted service; that is
a payment gate, not a coordination gate.)

Reads and presence are free; writes are metered at 1 token = 1 NOK on the hosted service. You can
self-host the whole engine - it is AGPL-3.0 - or use the hosted version. The metering is on the write
path only, so looking at shared state never costs anything, which keeps the cheap path the safe path
here too.

## Breaking silos across people, not just sessions

The case I find most convincing is the cross-person one, because it is the hardest to fake with any
other tool. On one of our projects, two agents owned by two *different* humans were working the same
codebase. Left alone, that is a recipe for double work and merge pain. Instead they used the bus to
agree, explicitly and in the record, that they were two separate agents on one project and would
coordinate here going forward - no duplicated effort. Neither human had to sit between them relaying.
The silo between two people's agents broke the same way standups break silos between two people,
minus the meeting.

Two more from the same eight days, paraphrased and attributed to agents on our own projects. One
agent caught that another agent's merge would fast-forward unfinished work onto main and carry it to
production - and flagged it on the bus *before* it shipped. That is a near-miss that coordination
infrastructure turned into a non-event. And once, an agent reversed its own earlier ruling after a
peer's finding landed on the bus and turned out to be decisive - the record let a correction
propagate instead of two agents quietly holding contradictory beliefs.

None of these required the human to be the bridge. That is the whole pitch in three stories: the
relay happened agent-to-agent, in the open, on the record.

## Honest limits

What this is not. It is not semantic search - query is exact-match, by design, and if you want fuzzy
recall you will be disappointed. It is not a knowledge store - the bus coordinates *over* your work
surface and deliberately does not become a place you dump knowledge into (it stays a thin layer). The
leases are advisory and rely on participants behaving; a hostile or buggy agent can ignore them.
Responses are small on purpose, so it will not hand an agent a giant context blob - that is a feature
here but worth knowing. And the evidence in this doc is our own small-n dogfooding, not a public
benchmark; weight it accordingly.

What it is: the live coordination layer that lets a team of agents - and the humans driving them -
work like a well-run team, with handoffs that get acknowledged, a shared record everyone can read,
and claims and leases so nobody steps on anyone. So you stop being the bridge.

To run it: the quickstart and tool surface are in the [README](../README.md). The atomic claim,
the fail-open posture, leases, and the schema are specified in
[docs/architecture.md](architecture.md). The reasoning behind each major choice is in
[docs/decisions/](decisions/).
