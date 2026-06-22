# 012 - Product name and rename mechanics

**Date:** 2026-06-16 (name selected 2026-06-17)
**Status:** Accepted

Resolves PLAN milestone 1 (naming + clearance).

## Selected name (2026-06-17): LLM Bus

The chosen name is **LLM Bus** (display), `llm-bus` / `llmbus` for handles, on the dedicated apex
**`llm-bus.com`** (a standalone product domain; `llmbus.io`/`.ai` are alternatives). It deliberately
adopts the established `llm-*` naming convention (Simon Willison's `llm` CLI + its `llm-*` plugins,
the "LLM OS" / "llm-wiki" lineage): nerdy, accurate, non-salesy, and a better fit than `agent-*` for
an open-source dev tool. It keeps the "bus" vocabulary the product lives by ("check the bus", "on the
bus", "bus-synced").

Clearance (2026-06-17, informational, not legal advice): **GO.** "LLM" is generic, so no defensible
trademark exists or blocks us (accepted trade-off for a convention name). `llmbus` and `llm-bus` are
free on npm, PyPI, and GitHub - grab them to secure the namespace. Two minor, non-blocking notes:
(1) `TRIZZGLOBAL/llmbus` is a low-footprint LLM red-team scanner sharing the bare name in an adjacent
category - differentiate via the "LLM Bus" styling and positioning; (2) on PyPI, `llm-bus` reads as an
`llm` plugin (it is not one) - use a distinct package name there or grab it defensively. `llm-bus.com`
is available; `llmbus.com` is parked/for-sale (not a live product).

**Rename timing:** do the rename cutover NOW, before the commercial launch - the name is locked and
there are far fewer deployed clients to migrate now than post-launch, and launching commercially under
the real brand (LLM Bus / `llm-bus.com`) beats launching as "LLM Bus/yolo" and renaming later. The
dual-accept window below covers the existing dogfood rigs.

**Cutover progress.** Phase 1 (brand/display + client-template strings: package name `@llm-bus/server`,
healthz/log/admin brand, the `.mcp.json` key `llm-bus`, env var `LLM_BUS_TOKEN`, MCP server name
`llm-bus`, kit contract `.llm-bus`/`llm-bus.config.json`, docs) executed 2026-06-17 with `npm run verify`
green (15 tests); lockstep tests updated (smoke `.mcp.json` key, hook.failopen contract, admin.crud
export line). Shipped with `PUBLIC_URL` still emitting `yolo.doderlein.com`, so no dead host. Deliberate
non-renames: the `yolo` prod DB and `llm_bus` test DB (internal infra), historical decision
filenames, the `yolo_admin` cookie. Phase 2 (host/endpoint `yolo.doderlein.com` -> `llm-bus.com`:
`PUBLIC_URL`/`ALLOWED_HOSTS` flip + a Caddy vhost serving both hosts with the header-strip intact +
kit/doc endpoint literals) is the coordinated deploy step on `odina-vm`, with the old host kept alive
until the dogfood rigs update their `.mcp.json` url.

## Decision (the bus-metaphor rationale that led here)

Adopt a coined name built on the **bus / shared-line metaphor** that agents already use ("check the
bus", "on the bus", "bus-synced"). The literal "Agent Bus" is NOT available as a product: it is
already a live, same-category product (agentbus.org "messaging platform for AI agents", a 2026 Show
HN "AgentBus", and GitHub repos), and `agentbus.com/.ai/.dev` are registered. The move is to coin
around the metaphor and own all three TLDs.

Domain availability checked via live RDAP lookups on 2026-06-16 (registered vs available snapshot;
RDAP confirms registration, not active use or for-sale status). Run a formal USPTO/EUIPO trademark
search on the finalist and register the domains the same day - availability is a snapshot.

**Ranked shortlist:**

| Rank | Name | .com | .io | .ai | Metaphor / verb fit | Collision risk |
|---|---|---|---|---|---|---|
| 1 | **Trunkbus** | free | free | free | "trunk" is a telecom/transit bus line; keeps "the bus" verb | Low (only electrical-busbar hardware) |
| 2 | **AgentTrunk** | free | free | free | shared trunk line for your agents; most self-explanatory | Low (no product found) |
| 3 | **Busbar** | reg. | free | free | a busbar is literally the shared conductor everything taps; best engineer metaphor | Med (data-center power hardware search noise) |
| 3 | **Onbus** | reg. | free | n/c | most verb-native: "is agent-3 onbus?", "onbus-synced" | Low-med |
| - | **Buswire** | reg. | free | free | "bus" + "on the wire" | Med (unrelated BUSlink/LINAK hardware) |

Explicitly drop (live same-category product or registered trademark): Agent Bus / AgentBus,
AgentRelay, AgentMux, AgentWire, Conductor (Orkes + Conductor.build), Mux (registered TM).

**Recommendation:** **Trunkbus** (clean sweep of all three preferred TLDs, keeps the owner's bus
verb, coined and trademark-defensible). Fallback **AgentTrunk** (also a clean sweep; clearest "what it
does" and keeps "agent" for SEO). Characterful third: **Busbar** (.io/.ai) or **Onbus** (.io).

**Clearance result on "Agent Bus" (2026-06-16, informational, not legal advice): CAUTION / AVOID.**
The owner asked to clear "Agent Bus" (agent-bus.io is available) before committing. Findings:
- No live US federal trademark registration surfaced for "Agent Bus"/"AgentBus" in software classes
  (only a dead 1997 mark, AGENT SERVICEBUS, abandoned) - but this is a preliminary knockout search,
  not a cleared opinion; confirm in TESS via counsel.
- Active same-category collisions: **agentbus.org** is a live "messaging platform for AI agents"
  (Show HN, March 2026); `Kanevry/agentbus` (open-source event bus for AI agents); npm `agentbus`
  (agent comms layer); PyPI `agentbus` (NATS task bus); the `agentbus` and `agent-bus` GitHub orgs are
  both taken. `agentbus.io` is registered; `agent-bus.io` is free.
- "Agent" + "bus" is descriptive, so even a won mark would be weak, and the namespace is crowded and
  confusing for SEO/recall. The hyphen does not create trademark distinctiveness.

Net: do not brand as "Agent Bus." Adopt a distinctive coined name (the shortlist above; Trunkbus
recommended) and use "a coordination bus for agents" descriptively. agent-bus.io remains a cheap
optional redirect/defensive grab but not the brand. Owner to make the final pick.

## Rename mechanics (when a name is chosen)

Two distinct classes of touch-point:
- **Display / docs (free to change at cutover):** README, USING, PLAN, CLAUDE.md headings,
  `package.json` description, the `/healthz` service string, server log prefixes, decision titles, the
  static landing copy.
- **Compatibility surface (breaking - needs a deprecation window):** the MCP server name `"llm-bus"`
  (`src/mcp.ts`), the token env var and the `"llm-bus"` `.mcp.json` server key (emitted
  in `src/invite.ts` templates and `kit/`), and the public host. These appear in every deployed
  client's `.mcp.json`; renaming them is a coordinated cutover, not a free edit.

Rule: never hard-swap the compatibility surface on a live service. Accept both the old and new MCP
server name and both env-var names for a deprecation window; emit only the new key in fresh templates.
The public host is already config-driven (`PUBLIC_URL`/`ALLOWED_HOSTS`, `mcpUrl` threaded into
`src/invite.ts`), so the new domain is a config/Cloud-Run/Caddy change at cutover, not a code edit.
Add the new domain alongside the old with a redirect; retire the old after clients migrate.

The rename cutover is the last mechanical step, sequenced after the OSS release and the hosted service
are live (it is blocked on the pick, not on the engineering).

## Context

PLAN milestone 1 always flagged that earlier real-word names were taken several times over and the
clean `.io` space was saturated, and that the "yolo" codename reads as "no guardrails". The owner's
instinct ("the bus") is the right metaphor; the research finding was that descriptive names in this
space are already taken, so coin around the metaphor instead.

## Alternatives considered

- **Keep an earlier working name.** Rejected: taken multiple times; no clean domain sweep.
- **Use "Agent Bus" / "AgentBus".** Rejected: a live competing product with the same name in the same
  category; only `agentbus.io` is free.
- **A non-bus name (Switchboard, Backplane, Roundtable, Conductor).** Rejected or down-ranked: either
  off the verb agents already use or contested by established infra/AI product names.

## Consequences

- Once picked: register `.com/.io/.ai`, run the trademark search, record the name here (Status ->
  Accepted), and schedule the rename cutover after OSS + hosted launch.
- All commercialization docs stay name-agnostic until the cutover; the landing copy uses a name slot.

## Follow-ups

- Owner picks from the shortlist; update this file and PLAN milestone 1.
- Formal trademark clearance on the finalist before branding spend.
