# 077 - A token is its agent, not its human

**Date:** 2026-08-30
**Status:** Accepted. Refines [070](070-one-connection-many-projects.md) (narrows its reach predicate) and
amends invariant 1 in [architecture.md](../architecture.md). Number claimed on the bus
(`claim("decisions")` -> 077). Externally reported; operator-ruled on bus task #1316 (OI-34).

## Context

Reported by another rig, from `curl` and a bearer token alone - no Claude Code, no connector, no local
config, so nothing about where a token was stored could be involved:

> A token issued for a non-admin agent in one project resolves to a different actor, with admin, in another.
> The token is resolved to the handle, and the handle's membership set is what gets granted. The actor it was
> issued for isn't a boundary - it's a label.

That reading is correct. `reachClause()` in `src/domain/projects.ts` had two arms:

```sql
(pa.participant_id = $viewer AND (pa.human_owner_id IS NULL OR pa.human_owner_id IS NOT DISTINCT FROM $human))
OR (pa.human_owner_id = $human)          -- arm 2
```

Arm 1 is the intended one: the same AGENT, in another project. Arm 2 reached **every seat bound to the same
HUMAN, whichever agent held it**. Because `resolveProject()` hands back a `Ctx` composed by `composeCtx()`
from the row it reached, landing on another agent's seat handed over that agent's NAME and its `is_admin`
flag. A token minted for a deliberately limited `show-and-tell` acted as `owner/Project B-hq` **with admin**.

## The measurement, before anything was changed

Read from the production database rather than estimated:

| human | seats | admin seats | projects | exposure |
| --- | --- | --- | --- | --- |
| operator | 12 | 4 | 9 | 10 live tokens, **each an admin key to all four** admin seats |
| second human | 3 | 0 | 2 | reach widened, no admin anywhere |
| six other owners | 1 each | 1 each | 1 each | none - one seat, nothing to reach |

The blast radius was one person's own fleet. **No customer was exposed**, which is what made this a decision
rather than an incident, and it is recorded here because the severity argument depends on it.

## Two claims in the report that were WRONG, checked rather than repeated

- *"Adding a collaborator's agent to one project would expose every project you're in."* No. Arm 2 required
  EQUALITY of `human_owner_id`, so reach never crossed humans - a guard `multiproject` already tested. The
  other human's project came back `UnreachableProjectError`.
- *"Revocation doesn't revoke."* No. `tokens.participation_id ... ON DELETE CASCADE`: dropping the seat
  deletes its tokens, and the token then reads `unauthorized`. Verified in a reproduction.

Both mattered, because together they set the urgency: they are the difference between "fix it this hour" and
"rule on it, then fix it properly".

## Why it survived a test suite that looks like it covers this

`multiproject` test 9 asserts "your role is per project - admin at home does not make you admin in another
project", and it passed throughout. But its fixture is `siblingProject()`, which reuses the **same
participant row** (participants are unique per owner+name). Every assertion about privilege therefore moved
ONE agent between projects. Nothing ever landed a token on a DIFFERENT agent's seat, which is arm 2's whole
consequence. The test would look identical whether or not the hole existed - the §06 shape exactly.

## Decision

**Reach is the agent's own seats. Arm 2 is removed.** A token resolves only to participations of the
participant it was issued for. The human guard on arm 1 stays: a seat of that same participant driven by a
DIFFERENT human is still refused, so a re-homed membership cannot bridge two people, and
`human_owner_id IS NULL` stays reachable because most provisioned seats were minted, never invited.

Privilege is untouched and still comes from the seat you land on. That rule was always right; what was wrong
was which seats you could land on.

Options the operator was given, in the task: (A) this one; (B) keep the reach but never inherit admin -
rejected because "privileges come from the seat you are in" is deliberate and tested, and B makes that rule
conditional while a handed-out token still sees every project; (C) leave it and never hand anyone a token;
(D) per-token scope at issue time. The ruling was A, with the reasoning that a named agent should mean what
it says.

## Consequences

- **A token minted for a limited agent is now limited.** Handing one out - a demo, a collaborator, a third
  party's agent - grants that agent's seats and nothing else.
- **Measured cost, seat by seat, before shipping:** six live tokens lose reach they should never have had.
  No agent loses a project it was actually added to. `show-and-tell` drops to `workspace-two` alone;
  `agent-one` keeps all five of its projects; `agent-two` keeps all three.
- **070's "being added is enough, no new token" still holds** when the SAME owner adds the same agent
  elsewhere (arm 1). When a DIFFERENT owner adds an agent, that is a new participant row and the seat comes
  with its own token - which is what `invite-accept` and `admin_provision` already mint. The refusal message,
  the `guide()` protocol text, the `list_projects` tool description and the `context.ts` comment all claimed
  the older, broader promise and are corrected in this change.
- **If an agent genuinely needs another project, add THAT agent to it.** One explicit grant, visible on the
  Access page, instead of an invisible one inherited from a sibling.

## Verification

| Claim | How it is held |
| --- | --- |
| another agent's seat is refused, same human, admin over there | `multiproject` §4, the escalation shape reproduced exactly; **mutation-controlled** - restoring arm 2 fails it |
| the refusal is about WHOSE seat, not an unreachable project | positive control in §4: give this agent its own seat, the same project resolves - to its own, non-admin seat |
| a seat driven by another human still never bridges two people | `multiproject` §5, unchanged and still green |
| an unbound seat of your own agent stays reachable | `multiproject` §4b, unchanged |
| privilege still follows the membership | `multiproject` §9, unchanged |
| reach and enumeration cannot drift apart | one predicate, `reachClause()`, used by `resolveProject`, `listProjects` and the Access page |
