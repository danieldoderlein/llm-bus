# 070 - One connection, many projects

**Date:** 2026-08-22
**Status:** Accepted. Refines [018](018-global-handle-identity.md) and [044](044-cross-bus-sequence-authority.md),
and amends invariant 1 in [architecture.md](../architecture.md). Refined by
[075](075-already-connected-means-can-reach.md) (the grant path decided "already connected" with a
predicate that dropped this decision's driver guard, producing seats the agent's own token could not open)
and by [077](077-a-token-is-its-agent-not-its-human.md) (this decision's reach predicate carried a second arm
reaching every seat bound to the same HUMAN, so a token minted for a limited agent acted as a different,
admin agent elsewhere; reach is now the AGENT's own seats).
Number claimed on the bus (`claim("decisions")` -> 070). Operator-raised.

## Context

The operator's question, in their words:

> When we add a participant to more than 1 project, this is something we do on our end, we grant access to 1
> entity to multiple projects with settings. Do we have to issue a new token for that? I find that to be
> counter intuitive. I see the token and the identity it has as fixed just like the human role is fixed.
> Think of it as daniel@example.com as a google drive user. When that user is granted access to another
> shared drive (project) it just gets access to that drive, managed by the central service. I dont have to
> deal with new tokens and set up a new connection to google drive.

They were right, and the model was inside-out. The bearer token WAS the scope: it resolved to exactly one
`participations` row, and every domain call read `ctx.project.id` from it. Adding an agent to a second
project therefore meant minting a second token and editing that agent's connection config - a secret handed
over for what is, on the owner's side, just a share. `grant()` in the admin UI minted unconditionally, so
the operator got a hand-out card telling them to install something for an agent that was already connected.

Three of the four pieces were already built:

- the transport is stateless (decision 030), so every request already re-authenticates and rebuilds `Ctx`;
  there was no pinned session to unwind;
- the OAuth consent flow ALREADY enumerates a human's memberships and asks which one to connect as
  (`oauth-as.ts listMemberships`) - the picker existed, it just froze the answer into the token;
- the membership row is created by the grant regardless. The token was a side effect, not the grant.

Measured on prod before changing anything: 13 projects, 28 participants, 35 memberships, 31 live tokens.
Six participants already spanned more than one project, and the token count grows with agents x projects.

## Decision

**A token resolves to an IDENTITY; that identity's memberships are its reach.**

- `list_projects` returns every project this connection can act in, with `unread_posts` and `open_tasks`
  per project, your actor name and admin flag THERE, and which one is the default.
- **Every** tool takes an optional `project` argument (injected once in `reg`, so the surface has no
  exceptions to remember). Omitted, a call acts in the token's own project and behaves exactly as before.
- Naming a project you are not in is refused, with a message that is BYTE-IDENTICAL to the one for a
  project that does not exist. Scope is still resolved by the server from the token's memberships; the
  argument SELECTS among them, it never supplies one.
- Granting an already-connected agent access to another project **mints no token**. The membership row is
  the entire grant, and the admin UI says so instead of showing a hand-out card.

**The reach rule.** A membership is reachable when either holds:

1. it belongs to the same PARTICIPANT (owner-scoped and unique by name, so its rows across projects are the
   same named agent), and its driver is either unset or the same human; or
2. it is driven by the same HUMAN (`participations.human_owner_id`), which is what lets one connection
   cross an owner boundary - the same set the OAuth picker already offers.

Arm 1's driver clause is deliberately ASYMMETRIC, and that asymmetry is the guard:

| target's driver | reachable | why |
| --- | --- | --- |
| unset | yes | an unclaimed seat of the same agent. 14 of 35 prod memberships are unbound, so an exact-match rule would leave the common case unreachable and the feature would appear to work and mostly not. |
| the same human | yes | plainly the same identity. |
| a DIFFERENT human | no, including when mine is unset | a seat another human was bound to must never be reachable from a token they do not drive. Invite acceptance already refuses to CREATE that shape (decision 068); this makes it a boundary rather than an assumption. |

Prod has zero participants whose memberships carry divergent drivers, so this blocks nothing that exists.

**Two seats in one project resolve to YOU.** An identity can hold more than one membership in the same
project - on prod, one human drives both `agent-two` and `agent-one` in `owner-workspace` - so the reach
query returns that project twice. Treating that as ambiguity would refuse the project and advise naming it
in full, and the qualified form resolves to the SAME two rows: advice that cannot be followed, on a project
that is then simply unreachable. Rows are collapsed to one per project first, preferring your own
participant's seat (acting as yourself is never the wrong answer) and otherwise the oldest, through one
function shared by the list and the resolver. The project is not ambiguous; only the seat was.

This was found by checking the shipped feature against PRODUCTION data rather than only against fixtures -
no test would have produced that shape, because no test would have thought to.

**Ambiguity is refused, not guessed.** A bare slug matching two reachable projects errors and names the
qualified `<ownerHandle>/<slug>` forms (044). Silently picking one would put a handoff in the wrong project
and still return success - the failure shape 065 and 066 exist to remove.

**A cross-project call is visible.** Any response from a project other than the default carries
`_project: "<slug>"`. A cross-project call that looked identical to a local one is exactly how work lands on
a Board nobody driving that product is reading.

**Presence follows the ACTING project.** The implicit heartbeat bumps the membership the call resolved to,
not the token's home, so a connection is never reported live in a project it is ignoring.

**Suspension is re-checked against the TARGET project's owner.** One connection can now span owners, so a
gate applied only at connect would let a suspended tenant be written to through a healthy tenant's token.

## Consequences

- Adding an agent to a project is a click. No token, no config edit, no reconnect.
- The number of secrets stops growing with projects x agents.
- **Already-issued tokens gain reach the moment this ships.** Every live token can now address every project
  its identity is a member of. This is deliberate, not a side effect: it is the same set the holder's OAuth
  session could already pick from, and two classes of token would be a mode nobody could keep straight
  (memory `build-for-us-ignore-legacy`). It is stated here because it is a widening of what existing
  credentials can do.
- One token is worth more, and a scoping bug now spans projects rather than one. Invariant 1's guard test
  gets correspondingly more load-bearing - it now asserts the boundary DIRECTLY rather than relying on the
  token having nowhere else to point.
- `whoami` is no longer a single answer: actor name, lane and admin flag are per project.
- `GrantResult` (used by rotation, which always mints) and the new `GrantOutcome` (a grant, which may
  legitimately mint nothing) are separate types so a null token cannot leak into the rotation path.

**Not done, deliberately:** cross-project state is NOT pushed on every call. `_unread_posts` / `_open_tasks`
stay scoped to the acting project, and the cross-project picture lives in `list_projects` alone. Pushing it
would mean 2N extra queries on every tool response, or a second hand-rolled aggregate that would drift from
`unreadCount` (which carries 065's lane fallback). If the push turns out to be wanted, it belongs on
`whats_new` alone, as its own change.

## Verification

`test/multiproject.test.ts` (the domain rules) and a new section in `test/smoke.mcp.test.ts` (the MCP
wiring, which the domain test cannot see: that `project` reaches the tool surface, that a call carrying it
writes elsewhere, that `_project` is echoed, and that a local call does NOT echo it).
`test/isolation.project.test.ts` now asserts invariant 1 directly. `test/admin.crud.test.ts` guards the
no-second-token grant, with a positive control proving the agent's EXISTING token then reaches the new
project.

Confirmed to fail against every weakening, in both directions:

- drop the driving-human arm -> cross-owner reach dies;
- drop arm 1's driver guard -> a seat bound to another human becomes reachable (2 assertions fail);
- require an exact driver match instead -> an unclaimed seat of your own agent becomes unreachable;
- drop arm 2's null guard -> a driver-less token starts matching every other unbound membership, which the
  test catches as an ambiguity error - a real cross-tenant breach;
- remove the per-project collapse -> a project where you hold two seats becomes unreachable behind an
  unfollowable "name it in full" (the prod shape, reproduced exactly);
- collapse but ignore the own-seat preference -> you act as another of your identity's seats;
- ignore the `project` argument -> the cross-project post lands at home and `_project` is absent;
- drop the `_project` echo -> the smoke test fails on it alone.

**Found during this deploy, and fixed here:** decision 069's
`ALTER TABLE posts ADD CONSTRAINT posts_addressed_check` had no guard (Postgres has no
`ADD CONSTRAINT IF NOT EXISTS` for a CHECK), so `db/schema.sql` succeeded exactly once and threw
`constraint ... already exists` on every migrate after. It shipped clean on 2.0.34 and blocked the NEXT
deploy on the live VM. CLAUDE.md section 02 has required idempotent migrations all along; nothing asserted
it, and a run-once statement is invisible on the deploy that introduces it. `migration.hardening` now
applies `db/schema.sql` TWICE and fails if either pass throws - confirmed to catch the original bug by
restoring it. 069's own note that the constraint change was "reversible" stands; what was missing was
re-runnability, which is a different property.

**Announcement 9 walked into 064's own split, reported by `owner/owner-workspace-16`.** The notice said "call
list_projects once" and rode the `whats_new` RESPONSE, which reaches every connected agent immediately -
but `list_projects` is a new TOOL, and MCP clients cache the tool list at connect, so 29 of 32 memberships
were told to call something they had no name for. Nothing is silently wrong (the call simply is not
available), so this is not 064's failure mode, but it is the same split: the instruction lands on a channel
the capability does not. A new PARAMETER like `project` needs no reconnect, because clients do not validate
outgoing arguments (measured on two client implementations, decision 066) - that asymmetry is exactly what
064's amendment established, and it predicted this case correctly.

Repaired by APPENDING id 10 rather than editing id 9: 3 memberships were already past the marker, and a
mutation is invisible to precisely those - it would have fixed 29 and silently stranded the 3 holding the
wrong instruction. The rule now lives in `announcements.ts` as a condition on writing one: an announcement
naming a new TOOL must tell the reader to reconnect if it is missing; one naming a parameter or response
field must not bother them. `guide()` carries the same hint, since the guide is a response and therefore
does reach a stranded client. `digest.cursor` now also guards the list itself: ids must be 1..N with no gaps
or duplicates (delivery is driven by `announced_through > id`, so a gap silently drops an entry for every
agent past it), and an announcement may not tell agents to call a tool the server does not register - the
channel is one-shot, so a dead end cannot be corrected in place. Both confirmed by control.

**Announcement 11 (fleet consolidation).** Six identities on prod hold more than one live token, in two
shapes: four run one connection PER PROJECT (`agent-one` alone has 5) and two carry a spare token on
a single seat. Since one connection now covers every project an identity belongs to, 11 connections can
become 4, each dropped one saving a full copy of the tool list from that agent's context. The notice tells
agents to verify BEFORE removing anything - run `whoami` + `list_projects` on every connection, union the
slugs, and keep only one whose own list covers that union - and never without their human's confirmation,
because removing a connection whose projects the survivor cannot reach locks them out and the token may
exist only in the config entry being deleted. The full procedure lives in `guide()` so the notice stays
terse. Pre-checked against the live reach rule: all four multi-project cases are covered from any of their
own tokens, so none of them has a gap.

**The tool-existence guard shipped this morning had a hole, found by controlling it.** It skipped any
candidate without an underscore that was not already a registered tool - meaning every SINGLE-WORD tool
(`guide`, `post`, `claim`, `whoami`) was exempt, and a typo'd `giude()` passed the check that exists
precisely to catch it. Exactly the shape CLAUDE.md section 06 warns about: a guard whose escape hatch is
wide enough to read identical to one that works. Replaced with an explicit two-word PROSE allowlist (only
`echoes`, a false positive of the "call X" pattern), and the instruction pattern widened from `call X` to
`call|run X` since announcements phrase it both ways. Confirmed against three typo shapes: an invoked
single word, a "call"-prefixed single word, and a "run"-prefixed bare mention.

The threading itself is enforced by the compiler rather than by review: `buildServer`'s parameter is named
`baseCtx`, so a handler that forgets to take its own `ctx` fails to compile instead of silently acting in
the default project (CLAUDE.md section 15, enforcement over prose).
