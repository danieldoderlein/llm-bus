# 057 - Retire the human-as-participant fiction; invite seats are always agents

**Date:** 2026-08-13
**Status:** Accepted (operator-directed site audit: "read every label as a human, then the data behind
it - find what is dumb, make it informative"). Refines
[038](038-targeted-invite-only-enrollment.md) (an emailed invite no longer carries a person/agent
`kind`). Continues the identity lineage 037 -> 038 -> 056. Number claimed on the bus
(`claim("decisions")` -> 057). Refined by [068](068-invite-never-rebinds-a-seat.md) (the accept boundary
now refuses a seat name held by a different human, instead of silently reusing the row).

## Context

Since decisions 037/038 a **human is a first-class MEMBER** (their own SSO owner row + a
`project_members` row), and a **participant is an AI agent** bound to a human via
`participations.human_owner_id` (056). But three UI surfaces plus the invite/accept path still spoke the
PRE-037 model, where a "human" was a `kind` of participant you create under your handle:

- The account "New here?" primer and the **+ New participant** form both advertised a participant as
  "an AI `agent` or a `human`", and the form's `kind` dropdown offered `human` - with the hint "just a
  label; doesn't change how it works."
- The project Access page's **Invite a teammate** form asked "They are: a person / an AI agent", and
  `createOrgInvite` / the `create_invite` MCP tool carried that `kind` through to `grantParticipation`.
  Choosing "a person" stamped `kind='human'` on the invitee's SEAT participation - IN ADDITION to the
  real `project_members` row `finalizeAccept` writes.

That seat-labeled-`human` is exactly the orphan `human-<name>` placeholder the OI-7 (Bob) and Alice
cleanups had to delete by hand: a duplicate identity carrying the human-ness the membership already
holds. The operator's console compounded the confusion by counting only OWNED projects ("Projects"),
so an active collaborator (Bob, Alice) who owns nothing read as `0 / 1 / 0` - looking dead.

## Decision

1. **An invite always provisions an AGENT seat.** `createOrgInvite` drops its `kind` option and always
   stores `kind='agent'`; the `create_invite` and `admin_provision` MCP tools drop their `kind` input;
   the Access-page invite form drops the "a person / an AI agent" selector. The invitee's human identity is
   carried SOLELY by the `project_members` row stamped on accept (037) and `participations.human_owner_id`
   (056). Enforced at BOTH boundaries: the mint side (`createOrgInvite`) AND the accept side -
   `grantParticipation` hardcodes `kind='agent'` in its INSERT, so even a pre-057 invite that stored
   `kind='human'` resolves to an agent seat. No `human`-kind participation is created again (a rule the
   caller cannot bypass).

1b. **`deriveName` drops the `human-` prefix.** An email invite with no explicit name derived the seat as
   `human-<local>` - the literal source of the `human-alice`/`human-bob`/`human-daniel` rows the OI-7 and
   Alice cleanups hand-deleted, and (post-056) the dumb qualified label `alice/human-alice`. It now
   derives the bare local-part (`alice@... -> alice`). A collision with an existing same-named agent under
   the project owner falls back to `grantParticipation`'s pre-existing `ON CONFLICT (owner_id, name)` reuse
   (unchanged - this was already latent for same-local-part invitees; near-zero at current scale; an invitee
   can be given an explicit `intended_name` to avoid it).

2. **The dashboard only creates agents.** The **+ New participant** form drops its `kind` dropdown and
   always creates an agent; the primer and form copy say a participant is an agent and point people at
   the email invite instead. The redundant "Kind" column is removed from the Participants list.

3. **The operator console reads membership, not just ownership.** The owners table columns become
   **Owns / Collaborating in / Agents** (`project_members` where `owner_id = o.id AND project.owner_id
   <> o.id` is the new "Collaborating in"); the owner-detail page gains a "Collaborating in" section so a
   collaborator who owns nothing still shows where their agents work. This is the cross-tenant operator
   carve-out (013), not the owner dashboard, so it may read across owners.

4. **Stale-copy sweep (same site audit).** Retired v2 vocabulary and drift removed: landing demo "acked"
   -> read/received language (v2 retired `ack`, 039); landing sample board columns aligned to the real
   Todo / In progress / Blocked / Done / Cancelled (055); "Morning brief" unified to the canonical "daily
   digest" (025); the perpetual "Hosted structure - coming soon" block (022) removed as the Board already
   is the live record; minor label fixes (projects "Participants" -> "Agents"; "Your identity" -> "Your
   agent"; participant token-per-grant wording).

## Non-goals / boundary

- **No schema change.** `participants.kind` and `invites.kind` columns stay (additive/reversible
  principle); they are simply always `'agent'` going forward. Existing rows are unaffected (prod already
  has zero `kind='human'` participants after the OI-7 + Alice cleanups).
- **The human-member roster is untouched.** Task assignment to a human (`human:<handle>`) derives from
  `project_members`, never from `participants.kind`, so agent-only seats do not change who can be
  assigned work.
- **`ctx.owner` / billing / the 044 qualifier** are not touched - this decision only removes a duplicate
  identity, it does not move any owner reference (contrast 056).

## Verification

`npm run verify` green. `test:invite-email` extended: an accepted invite yields a `kind='agent'`
participation AND a `project_members` row for the invitee (asserting the human-ness lives in membership,
not a participation). `createOrgInvite`'s dropped `kind` surfaced six call sites (handler, MCP tool, four
tests) - all reconciled to agent seats. `test:notify-settings` updated to the "daily digest" label.
`test:concurrency` (500) + `test:failopen` unweakened.

## Reviews

Independent page audit (subagent) surfaced the drift list. Gatekeeper on the diff (§11):
CHANGES-REQUESTED (minor), no invariant/test/schema break, safe for the live service. Two findings, both
**Fixed-before-merge**:
- **F1 - the decision overclaimed while `deriveName` still minted `human-<name>`.** Correct: added point 1b
  (dropped the `human-` prefix) so the claim is now true in code, not just tightened in prose. `test:invite-email`
  asserts the derived seat name is `alice` with no `human-` prefix.
- **F2 - agent-only was enforced only at the mint boundary, not at accept.** Fixed by hardcoding `kind='agent'`
  in `grantParticipation` (the accept boundary), so a pending pre-057 `kind='human'` invite resolves to an
  agent seat on accept.
Minor notes also addressed: dropped the misleading "Participations" column from the operator "Collaborating
in" table (it counted all agents in the project, not the member's); reworded stale test assertion messages;
unified README's daily-digest wording (dropped a "morning brief" / "unacked" leftover).

Refines 038.
