# 068 - An invite never re-binds an existing seat

**Date:** 2026-08-21
**Status:** Accepted. Refines [037](037-multi-human-project-membership.md) and
[057](057-retire-human-participant-fiction.md). Number claimed on the bus (`claim("decisions")` -> 068).
Reported by `owner/project-a-dev-agent`, who hit it on a live project.

## Context

`create_invite(participant_name:)` accepted a name already in use. On acceptance,
`grantParticipation` did:

    INSERT INTO participants (owner_id, name, kind) ... ON CONFLICT (owner_id, name) DO NOTHING

so a colliding name silently REUSED the existing participant, and the participation upsert then stamped
the accepter as `human_owner_id` on a row that already had a live token. Because the qualified actor
derives from the BOUND human (038/052/054/056), **an existing agent's unchanged bearer token began
authenticating as a different person's actor.**

Reported from project-a, verified in code here. The admin invited a teammate using a `participant_name` that
matched the CALLER'S OWN agent. After acceptance:

- `whoami` on an untouched, un-rotated token returned `alice/project-a-dev-agent` instead of
  `owner/project-a-dev-agent`.
- The original `owner/project-a-dev-agent` row vanished from `list_participants` - there was only ever one row.
- Two humans' tokens authenticated as one participation.
- `is_admin` came back TRUE although the invite never asked for it, inherited from the incumbent row via
  `is_admin = participations.is_admin OR $4`.
- The owner then demoted what he believed was the new agent from the web UI. One row, so it demoted the
  ORIGINAL LEAD, who lost admin on a project he runs through an action aimed at someone else.

Invariant 1 says identity comes from the token. Here the token never changed and its identity moved
anyway, because of an action taken by a third party. That is the invariant broken from an angle it was not
written to anticipate: it guards against a caller CLAIMING an identity, not against one being reassigned
underneath a caller who claims nothing.

The name is not an exotic collision. `project-a-dev-agent` is the obvious name for a second dev agent on the
project-a project, which is precisely how they walked into it.

## Decision

**Refuse, at the accept boundary, a seat name already held by a different human in that project.**

- The check runs before the `ON CONFLICT DO NOTHING` that caused the reuse, and looks for an existing
  participation in THIS project under that name. Re-acceptance by the SAME human stays idempotent, because
  reconnecting without a fresh invite is a documented path; only a different driver is refused.
- Surfaced as a typed `name_taken` result rather than a 500, and the throw rolls the transaction back so
  the invite is NOT consumed - the inviter can reissue with a different name. This mirrors the existing
  open-invite `name_taken` behaviour in `invite.ts`, which had the right shape all along; the emailed-org
  invite path simply never got it.
- The invitee is TOLD. They are signed in either way, so before this they landed on a dashboard with no
  explanation of why the invitation did nothing. `/admin` now renders the reason.

`is_admin` needs no separate fix: with the re-bind refused, an invite can no longer land on an incumbent
row, so there is nothing to inherit from. The `OR` remains correct for its actual purpose - a re-grant to
the same human must not silently demote them.

## Not done

**Retiring the `OR` in favour of an explicit flag**, and **blocking an invite at CREATION time when the
name is already taken.** The creation-time check is friendlier (fail when the admin types it, not when the
teammate clicks) but it is advisory only - the name can be taken between minting and acceptance - so the
accept-boundary refusal is the one that must exist and is what shipped. Worth adding later as UX, not as
the guarantee.

## Consequences

- An invite can no longer transfer an existing agent's identity, admin flag, or task ownership.
- Already-merged rows are not repaired by this change. project-a's owner is re-creating the identities under
  distinct names; there is no general repair, because once two humans have written through one row the
  ledger cannot be split by inference. Recorded so nobody looks for a migration that cannot be written.
- `test/invite.accept.test.ts` reproduces the incident and was confirmed to FAIL with the refusal disabled,
  reproducing all three symptoms: the accept succeeds, a human driver is stamped on the incumbent, and the
  seat ends up with two live tokens. One assertion in it is explicitly guarded against a vacuous pass - if
  `authenticate` returned null both times, comparing before to after would assert nothing.
