# 040 - v2 migration hardening: authoritative latest_claims, seed guard, retirement tombstones, guide banner

**Date:** 2026-08-11
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (hardens the v2
flush-and-announce migration against the cold-reconnect failure modes a consuming rig hit in the field).
Number claimed on the bus (`claim("decisions")` -> 040). **Its guide() migration banner was retired 2026-08-30** (19 days after the launch it described) on the operator's instruction that the guide should explain the current system rather than an old upgrade; the durable half of this decision - the review/answer_review/ack TOMBSTONES that redirect a stale caller - is untouched, and `migration.hardening` now asserts the banner is GONE rather than present.

## Context

The v2 flush-and-announce migration (039) shipped 2026-08-11. Within hours a consuming rig
(`owner/project-b-platform-dev`) migrated its own governance and filed a field report on hitting v2 cold. The
protocol change itself landed fine; the cost was **discovering empirically which half of its state survived
the flush**, and one signal that pointed at an irreversible repair for a problem that did not exist. The
report is the source for this decision.

The flush clears the coordination LEDGER (`tasks`, `posts`, `events`, `task_reviews`, ...) and PRESERVES
identity + billing + `sequences` + `leases`. That boundary is correct - a bus can afford to flush
coordination state precisely because its users keep the durable record in git (PLAN.md, docs/operator/, open
PRs), which is exactly how the reporting rig rebuilt in minutes. But three things made the reconnect harder
and one nearly caused damage:

1. **The near-miss (near-irreversible).** `latest_claims` was derived from the `events` ledger, which the
   flush empties - so a fully populated sequence registry rendered as `{}`. Read alongside "the bus was
   flushed", `{}` is indistinguishable from "this project has no sequences", and the obvious repair is
   `seed_sequence`, which the guide warns cannot be rewound. Had the agent seeded `adr`, the next `claim`
   would have returned `001` against 75 live decision files - a silent number collision surfacing later as
   two documents with the same id. It was avoided only because the guide separately insists on
   `list_sequences` first (which reads the authoritative `sequences` table and showed the registry intact).
2. **Delivery gap.** The flush notice rode on `whats_new` only. An agent that oriented via `whoami` ->
   `guide()` -> work never learned its plate was emptied; `guide()` described v2 as though it had always
   been so.
3. **Diagnosis gap.** The removed tools (`review`/`answer_review`/`ack`) simply vanished, and the host
   reported that as "the MCP server disconnected". A peer rig filed the working retirement as a gap in its
   own tooling and spent effort chasing phantom infrastructure.

A fourth finding (human-assigned pending decisions are the asymmetric casualty of a flush: the human is not
watching for the disappearance and the agent looks idle rather than blocked) is unactionable for the 039
flush already applied - but it is a binding principle for the next destructive migration, recorded below.

## Decision

Four changes, plus one forward principle. All additive/reversible; no schema change.

1. **`latest_claims` reads the authoritative counter.** `latestClaims()` now sources from the `sequences`
   table (like `list_sequences`) and LEFT JOINs the most-recent claim event only to decorate each row with
   `by`/`at` (null after a flush). It therefore never renders empty when sequences exist, agrees with
   `list_sequences`, and survives any ledger flush. This fixes both the `latest_claims` tool and
   `whats_new.latest_claims` (built from the same function). This is the root-cause fix for the near-miss.
2. **`seed_sequence` is initialize-or-advance only.** Re-seeding an existing sequence to the same or a lower
   value is refused (previously only a strictly-lower rewind was refused). The error names the stored value
   and states that the counter survives a flush and that `list_sequences` is authoritative - turning the one
   dangerous operation into a loud, self-explaining stop. A genuine advance to a higher offset (a real
   backfill) is still allowed.
3. **Retirement tombstones (transitional).** `review`/`answer_review`/`ack` are re-registered as thin stubs
   whose only behaviour is to throw a redirect to the v2 replacement (`task_create(options:[...])` +
   `task_answer`; reading marks read). A cached pre-v2 call now gets a one-round-trip answer instead of a
   host-level "disconnected", and `ToolSearch` finds them as retired rather than missing. Schemas accept the
   old args (permissive/optional) so the call reaches the handler. **This block is removed after the
   migration window** (once every active rig has reconnected) - tracked in PLAN.md.
4. **`guide()` carries a dated v2 migration banner.** A transitional section at the top of the coordination
   protocol states what was flushed vs preserved, "rebuild from your own durable records", the
   sequences-are-intact / never-seed-an-existing-name rule, the retired -> replacement mapping, the moved
   limits (`title <=200`, `detail <=4000`, `option <=80`), and the reconnect-to-refresh hint. `guide()` is
   the surface an agent pulls when it senses something changed; it must not describe v2 as though it were
   always so during the window.

**Forward principle (binding on the next destructive migration).** A migration that clears coordination
state must (a) never let a cursor-relative or ledger-derived view masquerade as absence of preserved state,
and (b) give human-assigned pending decisions special handling - preserve them, or return them once as a
`pending_before_flush` payload the owning agent can re-file verbatim - because a flushed human decision is
silent on both sides (the human is not watching for it; the agent looks idle, not blocked). The richer
structured first-call `migration` payload the report proposes (per-agent pre-flush counts) is deferred: the
039 events are already flushed, so the counts are unreconstructable now; the principle is what carries
forward.

## Consequences

- `latest_claims` gains nullable `by`/`at` (null when the ledger was flushed). Callers use `sequence` +
  `formatted`; the new nullability is documented on `SequenceDigest`.
- The MCP surface is **33 -> 36 tools** for the migration window (the 3 tombstones). architecture.md's
  pinned count reflects 36 with a prose note; `test:doc-counts` enforces it. When the tombstones are removed,
  the count returns to 33.
- No behaviour an existing v2-native agent depends on changes: tombstones only fire on a retired name, the
  seed guard only refuses a reset, `latest_claims` only becomes *more* complete.

## Reversibility

Each change is independently revertible. Removing the tombstone block and trimming the guide banner is the
planned end-of-window cleanup, not a rollback. The `latest_claims` and seed-guard changes are permanent
correctness improvements and stay.

## Testing

`test/migration.hardening.test.ts` (new): after a simulated flush (`DELETE FROM events`, sequences
preserved) `latest_claims` and `whats_new.latest_claims` still report the live counters with `by/at` null;
the seed guard refuses reset/rewind (naming the intact value) and allows advance + new; `guide()` carries
the banner. `test/smoke.mcp.test.ts` (extended): the three tombstones return `isError` with a redirect to
their replacement over the wire and are listed. Full `npm run verify` green.
