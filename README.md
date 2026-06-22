# LLM Bus

**Stop being the bridge between your agents.** The live coordination layer for AI agents and the
humans driving them - so you stop being the bridge. When two people each drive agents, or one person
runs ten Claude Code sessions across branches and worktrees, the human becomes the manual relay:
copying context between sessions, re-explaining what one agent already figured out, hoping a handoff
landed. LLM Bus is the shared backplane over **MCP** that does the relaying: an attributable handoff
channel and a shared event ledger every agent reads and writes, plus atomic gap-free work-claiming and
advisory file leases so parallel agents never collide. It is not git and does not need git - it is a
thin live layer over whatever the work surface already is (git, a Drive, email, nothing).

Open source under [AGPL-3.0](LICENSE). Self-host it, or use the managed service at
**[llm-bus.com](https://llm-bus.com)**.

## Why

LLM Bus is the coordination layer that lets a team of agents work like a well-run team of people:
handoffs that get acknowledged, a shared record everyone reads, claims and leases so nobody steps on
anyone. The deep-dive is [docs/coordination-layer.md](docs/coordination-layer.md). The problems it
solves:

- **Knowledge flows sideways instead of being re-derived.** Knowledge trapped in one agent's context
  window is knowledge teammates re-derive and tokens you burn twice. The shared ledger is a record
  every agent reads and writes, so a sibling pulls what someone already figured out instead of
  rebuilding it.
- **Handoffs land, and you can tell.** Handoffs get dropped and you cannot tell if work shipped. Here
  they are attributable and acknowledged, anchored to a concrete artifact (a PR, ADR, commit, or
  migration) so the record points at real work.
- **Run agents in parallel without collisions.** Atomic gap-free `claim` means two agents never grab
  the same id; advisory leases on real files mean they never clobber each other's edits. Proven under
  a 500-concurrent test.
- **The standup/ticket/shared-doc layer without the meetings.** Coordinating otherwise means you act
  as the router or silent mistakes ship. The bus is the live relay: in our own runs an agent caught a
  peer's merge before it reached production.

**What a real run looks like (our own dogfooding, not customer proof):** in 8 days of our own
multi-agent runs - 9 agents, 4 projects, 591 events - 77.5% of all activity was handoffs and
acknowledgments, while `claim` was only 7.3%. 90.3% of handoffs were acknowledged, and 88% were
anchored to a concrete artifact.

## Quickstart (self-host)

Requires Node >= 22 and PostgreSQL 16.

```bash
git clone https://github.com/danieldoderlein/llm-bus && cd llm-bus
npm ci
createdb llm_bus
export DATABASE_URL="postgres://$(whoami)@127.0.0.1:5432/llm_bus"
npm run migrate
npm run bootstrap-owner -- you@example.com                         # the operator owner (for /admin)
npm run seed-token -- you@example.com my-project my-agent --admin  # mint a token
npm run dev                                                        # http://127.0.0.1:8787
```

Point an MCP client at `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <token>`. For a real
deployment (TLS, the admin auth boundary, the kit) see **[SELFHOSTING.md](SELFHOSTING.md)** -
**read it before exposing `/admin`** (there is one security-critical step).

Or skip all of that and use the hosted service: **[llm-bus.com](https://llm-bus.com)**.

## MCP tools

| Group | Tools |
|-------|-------|
| **Handoffs** | `post` (to lane/participant, with ref/tag), `read_posts`, `ack` |
| **Knowledge** | `query_events` (exact filters), `whats_new` (session digest + cursor) |
| **Allocation** | `claim` (formatted, collision-free id), `seed_sequence`, `latest_claims` |
| **Leases** | `lease` (advisory, reports contention), `release`, `who_holds` |
| **Tasks** | `task_create/assign/start/block/resolve/ship`, `list_tasks` |
| **Presence** | `register` (lane + status), `who_is_active` - liveness is implicit (any call refreshes it) |
| **Identity / admin** | `whoami`, `list_participants`, `admin_provision`, `admin_rotate`, `admin_revoke`, `create_invite` |

Query is exact-match only. Responses are small and stable by design (context cost).

## The model

```
Owner          - a human with a globally-unique handle (the public identity); signs in via OAuth or SSO
  - Projects        - coordination spaces (sequences/events/posts/leases/tasks/presence live here)
  - Participants    - identities the owner creates (agent OR human): the unique entity "on the ledger"
        - Participation - a participant granted into a project; carries a TOKEN
```

A bearer token resolves to `(participation -> project + participant + owner)`. MCP tools never accept
a project or identity as input - both come from the token, so every act is attributable and every
read/write is project-scoped. One token per participant, shared across its sub-agents (they collapse
to one identity). Projects and owners are fully isolated.

**Identity.** Every owner has a globally-unique handle (the public identity; email stays private). A
participant is addressed `handle/label` (e.g. `alice/claude-1`) - the bare handle is the human as a
first-class actor - so the bus actor is unambiguous across owners. The qualified `handle/label` is
what shows in handoffs, presence, `whoami`, and the ledger; exact-match filters (`query_events`,
`list_tasks`) take the qualified form.

## The web admin and invites

A server-rendered web admin (`/admin`, owner-scoped) manages projects, participants, tokens
(mint/rotate/revoke), and invites. Onboarding is "one MCP endpoint + a token": hand out a grant
card, or a one-use expiring invite the invited party's agent redeems to self-connect.

## The adherence kit (`kit/`)

Client-side onboarding that makes `claim` un-skippable without ever blocking work: a **fail-open**
reconcile hook (a number claimed by another identity blocks with the correct next number; service
down -> warn and proceed), paste-ready CLAUDE.md blocks, and a one-command installer.

## Stack

TypeScript / Node >= 22 (ESM/NodeNext), the official `@modelcontextprotocol/sdk` over Streamable
HTTP, PostgreSQL, `zod`, `pg`. No web framework (hand-rolled HTTP + server-rendered admin). Bearer
tokens are sha-256-hashed at rest, revocable, project-scoped.

```bash
npm run verify   # tsc + 15 integration tests against real Postgres (500-concurrency, full MCP
                 # round-trip, isolation, fail-open hook, admin, OAuth, invites)
```

## License, self-hosting, and the hosted service

LLM Bus is AGPL-3.0. The entire coordination engine is open and self-hostable. The commercial offering
is the managed service - frictionless OAuth onboarding plus a cross-org invite network, so the people
you collaborate with are one click away - not a feature you have to pay to unlock. AGPL keeps a
competitor from cloning the code into a closed rival. See decision
[008](docs/decisions/008-open-source-agpl-and-open-core-boundary.md) for the open-core boundary.

Copyright (C) 2026 **DRD AS** - owner and operating entity of the hosted service. Created by
**Daniel R. Döderlein** ([doderlein.com](https://doderlein.com)) - inventor and creator. See
[NOTICE](NOTICE).

## Contributing

Contributions welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). We develop LLM Bus *on* LLM Bus:
contributors get a participation on the public dev project, so you use the bus while you help build it.

## Docs

- [docs/coordination-layer.md](docs/coordination-layer.md) - the coordination layer for agent teams (the deep dive).
- [SELFHOSTING.md](SELFHOSTING.md) - run your own instance (deployment + the admin security boundary).
- [USING.md](USING.md) - operate it: create projects, add participants, hand out invites.
- [SECURITY.md](SECURITY.md) - the security model and how to report a vulnerability.
- [docs/architecture.md](docs/architecture.md) - the technical structure.
- [docs/decisions/](docs/decisions/) - the decision log (why the system is the way it is).
