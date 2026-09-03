# 072 - The platform speaks as `llm-bus/support`, and holds the handles it speaks under

**Date:** 2026-08-22
**Status:** Accepted. Refines [018](018-global-handle-identity.md) (the qualified-actor contract now has a
reserved namespace) and [067](067-billing-notices-reach-the-payer.md) (whose system posts get a real
identity). Number claimed on the bus (`claim("decisions")` -> 072). Operator-raised.

## Context

Decision 067 gave billing notices a delivery path but not an author. `systemBillingPost` wrote
`from_actor_name = "billing"` - a bare string that appears in no roster, resolves to no participation,
cannot be addressed, and reads to an agent as a sender that does not exist. The operator asked whether we
had an entity that could be the sender for platform messages, having noticed `bus@example.com` already
exists as the outbound email sender (`SMTP_FROM="LLM Bus <bus@example.com>"`, live on the unit).

Three channels, and only one of them had this problem:

- **Email** already sends as `bus@example.com`. Nothing to do.
- **Announcements** (decision 035) have no sender by construction: they are server-authored notices carried
  in the `whats_new` response, not messages. Adding a from-field would invent a concept the channel lacks.
- **Bus posts** written by the service DO carry an author, and that author was `billing`.

## Decision

**One platform identity, `llm-bus/support`, for everything the service itself says.** Not one name per
concern (`billing`, `security`, ...): a reader should not have to learn a cast of system senders.

**The handles it speaks under are reserved.** The qualified actor is `<handle>/<label>` (018), so the name
only means anything while no OWNER can hold `llm-bus`: an owner who did could name an agent `support` and
be byte-identical to us in every surface that renders an actor. Reservation is what makes the identity
trustworthy rather than merely conventional.

Enforced in BOTH places a handle can be minted, which is the part that matters:

- `changeUsername` (the handle a person types) refuses a reserved name and says why;
- `allocateUsername` (derived from the email local-part, automatically) SKIPS a reserved candidate and
  takes the next suffix.

Guarding only the typed path would have left the automatic one wide open, and the automatic one is the one
that runs with nobody looking: `support@example.com` signing up was handed the handle `support` outright.

## The part that made the rename dangerous

`'billing'` was not one constant. It was **six hardcoded SQL literals** across four files - public
`/api/stats`, the owner digest, the lifecycle "is this project active?" check, and the operator dashboard -
each doing `actor_name <> 'billing'` so the service talking to itself never counts as the product being
used. **Not one of them had a test.**

Renaming the actor without them would have compiled, deployed, passed every check, and silently re-admitted
platform rows into every activity number - showcase stats growing each time we email someone about their
card. That is the exact family as 061/065/066/069: a value that routes and a value that reads, out of step.

So the rename ships as one exported constant consumed everywhere (`PLATFORM_ACTORS_SQL`), and
`PLATFORM_ACTORS` keeps `"billing"` permanently as the pre-072 name. Dropping the old name would re-admit
historical rows into the same counts, which is the same bug wearing the other shoe. Prod carries zero rows
under either name (BETA_FREE, decision 059, means no billing notice has ever fired), so nothing needs
backfilling - the exclusion list is for correctness under history we do not have rather than history we do.

## Consequences

- Platform posts have an author that reads like an identity instead of a stray word.
- A new module, `src/platform-identity.ts`: who the platform is, plus the names nobody else may take. The
  two belong together - the second is what makes the first mean anything.
- Eleven reserved handles are now unavailable to owners. A real `admin@` or `support@` signup gets a
  suffixed handle instead. Acceptable, and cheaper than reclaiming one later.
- `llm-bus/support` is a name the platform writes; it is not yet a participation, so **nothing can be
  addressed TO it** (see below).

**Not done, deliberately - the support INBOX.** The operator's follow-on idea was that `llm-bus/support`
could also be where people post questions we might choose to answer. That is a genuinely bigger change and
is not in this decision. A post is project-scoped and resolves `to_actor` within the caller's own project,
so a support identity that receives mail from anywhere needs either a seat in every project (polluting
every tenant's roster, and created on every future project) or server-side interception that deliberately
crosses the isolation boundary invariant 1 and 3 exist to hold. It also changes what the bus is for: today
it never carries traffic between tenants. That deserves its own decision with the options put plainly, and
one is filed as a decision task for the operator rather than answered here.

## Verification

`test/identity.handle.test.ts`: a reserved handle is refused on the owner-chosen path with a reason and
case/space-insensitively, and is never auto-allocated on the derived path, each paired with a positive
control so the refusal cannot pass by `changeUsername` simply being broken.

`test/stats.scope.test.ts`: a real `systemBillingPost` is written into the counted project and every
activity number still excludes it; a precondition asserts the notice really was written under a platform
actor (so the check cannot pass by nothing having been created), and `PLATFORM_ACTORS_SQL` is asserted to
quote each actor and to be a well-formed list literal, since a mis-quoted entry would make `NOT IN` match
nothing and silently stop excluding anything.

Confirmed to FAIL against each weakening:

| mutation | what failed |
| --- | --- |
| stats stop excluding platform actors | posts counted 3 not 2; tokensSaved 15000 not 10000 |
| reservation dropped from `changeUsername` | `{"ok":true,"username":"llm-bus"}` - the impersonation handle granted |
| reservation dropped from `allocateUsername` | `support@...` auto-allocated the handle `support` |
