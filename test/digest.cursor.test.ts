import { freshProject } from "./_setup.js";
import { withTx, query, closePool } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { queryEvents } from "../src/domain/query.js";
import { latestClaims, whatsNew } from "../src/domain/digest.js";

// UNIT E proof: the session digest reads everything since the actor's cursor, advances it,
// and the ledger query + latest-claim digest answer correctly — all project-scoped.

async function main(): Promise<void> {
  const ctx = await freshProject("digest");
  const errors: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) errors.push(msg);
  };

  // Seed three events: two claims on sequence "adr" (numbers 1 then 2) and one register.
  await withTx((c) => appendEvent(c, ctx, "claim", { sequence: "adr", number: 1, formatted: "1" }));
  await withTx((c) => appendEvent(c, ctx, "claim", { sequence: "adr", number: 2, formatted: "2" }));
  await withTx((c) => appendEvent(c, ctx, "register", { lane: "x" }));

  // First digest: sees all 3 from cursor 0 and advances the cursor.
  const first = await withTx((c) => whatsNew(c, ctx, {}));
  check(first.since_event_id === 0, `first.since_event_id expected 0, got ${first.since_event_id}`);
  check(first.events.length === 3, `first.events expected 3, got ${first.events.length}`);

  // Second digest: cursor advanced, nothing new.
  const second = await withTx((c) => whatsNew(c, ctx, {}));
  check(second.events.length === 0, `second.events expected 0, got ${second.events.length}`);
  check(
    second.since_event_id > 0,
    `second.since_event_id expected > 0 (advanced), got ${second.since_event_id}`,
  );

  // One more event -> next digest sees exactly it.
  await withTx((c) => appendEvent(c, ctx, "register", { lane: "y" }));
  const third = await withTx((c) => whatsNew(c, ctx, {}));
  check(third.events.length === 1, `third.events expected 1, got ${third.events.length}`);

  // Latest-claims map surfaces the newest claim per sequence.
  check(
    first.latest_claims.adr === "2",
    `first.latest_claims.adr expected "2", got ${JSON.stringify(first.latest_claims.adr)}`,
  );

  // Ledger query: exactly the two claim events for this workspace.
  const claims = await queryEvents(ctx, { type: "claim" });
  check(claims.length === 2, `queryEvents(type=claim) expected 2, got ${claims.length}`);

  // latestClaims digest: one row for "adr" with number 2, formatted "2".
  const { sequences } = await latestClaims(ctx);
  const adr = sequences.find((s) => s.sequence === "adr");
  check(!!adr, `latestClaims missing sequence "adr"`);
  check(adr?.number === 2, `latestClaims adr.number expected 2, got ${adr?.number}`);
  check(adr?.formatted === "2", `latestClaims adr.formatted expected "2", got ${adr?.formatted}`);
  check(adr?.by === ctx.participant.name, `latestClaims adr.by expected ${ctx.participant.name}, got ${adr?.by}`);

  // Project isolation sanity: the count of claim events in this project is 2.
  const rawCount = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events WHERE project_id = $1 AND type = 'claim'`,
    [ctx.project.id],
  );
  check(Number(rawCount.rows[0].count) === 2, `raw claim count expected 2, got ${rawCount.rows[0].count}`);

  await closePool();

  if (errors.length) {
    console.error(`FAIL digest.cursor:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK digest.cursor: cursor advances (3 -> 0 -> 1 new), queryEvents filters claims (2), latestClaims.adr = #2 \"2\".",
  );
}

main().catch((err) => {
  console.error("digest.cursor test errored:", err);
  process.exit(1);
});
