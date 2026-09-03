import { freshProject } from "./_setup.js";
import { withTx, closePool } from "../src/db.js";
import { claimSequence } from "../src/domain/claim.js";
import { acquireLease } from "../src/domain/lease.js";
import { register } from "../src/domain/presence.js";
import { post } from "../src/domain/post.js";
import { loadProjectActivity } from "../src/admin/queries.js";

// Tier D: the read-only Activity panel makes coordination visible to the human. loadProjectActivity is
// owner-scoped (a non-owned project id must return empty lists - no cross-tenant leak) and turns raw
// events into plain-language summaries, plus active leases, sequence state, and live agents.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  const ctx = await freshProject("act");
  const ownerId = ctx.owner!.id;

  // Seed real coordination: a check-in, a claimed number, a file lease, a handoff.
  await withTx((c) => register(c, ctx, { lane: "dev", status: "reviewing" }));
  await withTx((c) => claimSequence(c, ctx, { sequence: "adr" }));
  await withTx((c) => acquireLease(c, ctx, { surface: "src/server.ts" }));
  await withTx((c) => post(c, ctx, { to_lane: "dev", body: "took the API work", ref: "PR#7" }));

  const a = await loadProjectActivity(ownerId, ctx.project.id);

  check(a.events.length >= 4, `expected >=4 events, got ${a.events.length}`);
  check(a.events.some((e) => e.type === "claim" && /claimed adr/i.test(e.summary)), "claim summary should read 'claimed adr ...'");
  check(a.events.some((e) => e.type === "post" && /handoff/i.test(e.summary)), "post summary should read 'handoff ...'");
  check(a.events.some((e) => e.type === "lease" && /leased src\/server\.ts/.test(e.summary)), "lease summary should name the file");
  check(a.events.every((e) => typeof e.summary === "string" && e.summary.length > 0), "every event has a non-empty summary");

  check(a.leases.length === 1 && a.leases[0]!.surface === "src/server.ts", `active lease should be src/server.ts, got ${JSON.stringify(a.leases)}`);
  check(a.sequences.some((s) => s.name === "adr" && s.latest === "1"), `sequence state should show adr at 1, got ${JSON.stringify(a.sequences)}`);
  check(a.agents.some((g) => g.actor === ctx.participant.name && g.lane === "dev"), `active agent should be ${ctx.participant.name} on dev, got ${JSON.stringify(a.agents)}`);

  // Owner isolation: a different owner sees NONE of this project's activity (no cross-tenant leak).
  const other = await freshProject("act-other");
  const empty = await loadProjectActivity(other.owner!.id, ctx.project.id);
  check(
    empty.events.length === 0 && empty.leases.length === 0 && empty.sequences.length === 0 && empty.agents.length === 0,
    `a non-owner must see empty activity for someone else's project, got ${JSON.stringify(empty)}`,
  );

  await closePool();
  if (errors.length) {
    console.error(`FAIL activity.panel:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK activity.panel: events -> plain-language summaries (claim/lease/handoff), active leases, sequence " +
      "state, live agents; owner-scoped (a non-owner sees empty).",
  );
}

main().catch((e) => {
  console.error("activity.panel test errored:", e);
  process.exit(1);
});
