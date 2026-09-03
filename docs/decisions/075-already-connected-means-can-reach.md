# 075 - "Already connected" must mean CAN REACH, not merely HAS A TOKEN

**Date:** 2026-08-25
**Status:** Accepted. Refines [070](070-one-connection-many-projects.md) (whose grant path this fixes).
Number claimed on the bus (`claim("decisions")` -> 075). Operator-reported, in the most direct way
available: they added this rig to a project and `list_projects` still showed one.

## Context

Decision 070's promise is that being added IS the grant - no second token, no config edit. `grant()`
implemented that by minting only when the agent had no live token, and decided "has a live token" like this:

```sql
WHERE pa.participant_id = $1 AND t.revoked_at IS NULL AND ...
```

under a comment asserting the lookup was "by PARTICIPANT (across its participations), because that is the
same scope the reach rule uses."

**It was not the same scope.** The reach rule has two arms and a guard:

```
(participant_id = mine AND (target_driver IS NULL OR target_driver IS NOT DISTINCT FROM my_driver))
OR (my_driver IS NOT NULL AND target_driver = my_driver)
```

The `participant_id` match is only half of arm 1. The other half - the driver guard - is what 070 exists to
enforce: a seat bound to a human your token is not bound to is refused, *including when yours is null*.

So the two halves of one grant disagreed:

- `grant()` INSERTs the new participation with `human_owner_id = <the granting owner>`, because a human is
  signed in and doing the granting.
- The agent's EXISTING seat is very often unbound (`NULL`) - that is what a provisioned agent has, and what
  every membership predating human binding has.
- `grant()` then sees a live token on the same participant, concludes "already connected", mints nothing,
  and the admin card tells the operator the agent is good to go.
- The reach rule then refuses that seat, correctly, because unbound does not bridge to bound.

The result is a membership the agent's own token cannot open, with both surfaces reporting success. This is
the same family as 061/065/066/069 and 072: **a value that ROUTES and a value that READS, out of step** -
and this time the drifted copy was defended by a comment claiming it could not drift.

**Blast radius, measured properly: ONE seat.** The first sweep reported four, and that figure was wrong -
the correction matters more than the original number, because it is the same trap this decision is about.

The sweep counted a seat as stranded when no unrevoked token of its agent reached it, and reported
alongside it a "live tokens" column that checked `revoked_at IS NULL` but **not `expires_at`**. So an agent
whose tokens had merely EXPIRED looked identical to one the driver guard was refusing: both are zero
reaching tokens. Two of the four were the expiry case - `ai-coding-genesis-agent` showed "43 live tokens, 0
reach it" when the truth was 43 EXPIRED and 1 valid minted minutes later by its own OAuth reconnect, and it
self-healed without anyone touching it. A zero that means "temporarily between sessions" and a zero that
means "permanently refused" are different facts, and the query rendered them the same way.

What was actually there:

| project | agent | why unreachable | self-heals |
| --- | --- | --- | --- |
| owner-workspace | llm-bus-dev-agent | **this defect** - a valid token on an UNBOUND seat, target bound to the owner | no |
| mcp-review-test | mcp-review-test-agent | its only token had expired | yes, on reconnect |
| project-a | project-a-marketing-agent | never had a token at all | no - needs a normal grant |
| ai-coding-genesis | ai-coding-genesis-agent | all tokens expired; reconnected during the investigation | already did |

One seat, then, produced by this defect - and it is enough, because it is the shape every future grant onto
a provisioned agent would have taken.

## Decision

**The reach predicate is defined ONCE and parameterised by how the viewer is named**
(`reachClause(viewerParticipant, viewerHuman, targetAlias)` in `src/domain/projects.ts`). The module already
argued for one definition across the list and the resolver, "so what you can SEE and what you can ACT IN
cannot drift apart". `grant()` was a third consumer that re-derived it by hand. It now asks the same
function.

**`alreadyConnected` means: this agent holds a live token that REACHES this new seat.** When it does not,
the grant mints - which is the genuinely new-connection case, exactly as 070 intended.

**Scoped to this participant on the token side, deliberately.** Another agent's token bound to the same
human *does* reach the new seat, and that is irrelevant: it says nothing about whether THIS agent can work
there. The prod measurement above had to be run twice for exactly this reason - the first pass counted any
token and reported the seat as reachable.

**The driver guard is untouched.** It was never the defect. A test asserts the old unbound token is STILL
refused the bound seat, so a future "fix" that widens reach instead of minting fails.

**The Access page tells the three states apart.** `token_active` is scoped to one participation, so the
day one connection began reaching many projects it stopped answering "can this agent work here?": a
second-project seat normally has NO token of its own. The page rendered `tokenActive ? "active" :
"revoked"` - two labels for three states, wrong on two of them. A healthy seat reached on the agent's
existing token was labelled **revoked**, naming an action nobody took, and a genuinely stranded seat
rendered identically to it. The row now carries `reachable` (the same `reachClause`), and the pill reads
active / connected / unreachable.

## Consequences

- Granting can now mint where it previously did not. That is the point: the alternative is a seat nobody
  can open. No agent is stranded, and no agent gets a token it did not need.
- The four existing stranded seats are NOT repaired by this. New grants are correct from here; the existing
  rows need either a re-grant or the identity backfill below, which is an operator action on auth data.

**Not done - the backfill, and why it is not mine to run.** The clean repair for three of the four is to
bind the agent's unbound participation to its owner's human, which is the end state decision 038 already
calls for and makes one connection reach both seats. It is a write to an auth/identity column in
production, and in this rig's own case it would widen THIS agent's access - an agent must not expand its own
reach unattended (CLAUDE.md section 15). Filed as an operator item with the exact statement.

**Not a finding, after checking - token sprawl.** The sweep appeared to show one agent holding 43 live
tokens. They are unrevoked but EXPIRED: the OAuth connect path mints a fresh token per session and does not
revoke the previous one, so expired rows accumulate. They cannot authenticate, so this is row growth rather
than a credential problem, and it is not chased here.

## Verification

`test/admin.crud.test.ts`: the pre-existing 070 case (both seats bound by `grant()` to the same human)
passes before AND after this change - which is precisely why it never caught the bug, and is stated here so
the new case is not mistaken for a duplicate. The new case builds the asymmetry the defect needs: an
UNBOUND seat with a live token, then a grant onto a project whose new seat is bound. It asserts a token is
minted, that the minted token actually opens the new project, and - the control that explains why one was
needed - that the old unbound token is still refused it.

Confirmed to FAIL against the weakening:

| mutation | what failed |
| --- | --- |
| restore the `participant_id`-only lookup | `{"already":true,"minted":false}`; the minted-token assertions then cascade |
| restore the two-label `active`/`revoked` pill | all three Access-page assertions; healthy read as revoked and stranded was indistinguishable |
