import { withTx, query, closePool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import { post, readPosts, unreadCount, LANE_FALLBACK_FROM } from "../src/domain/post.js";
import { register, whoIsActive } from "../src/domain/presence.js";
import { whatsNew } from "../src/domain/digest.js";
import { listRoster } from "../src/domain/roster.js";
import { setParticipationLane } from "../src/admin/queries.js";

// Decision 065: lane delivery resolves a participation's lane as LIVE (presence.lane, written by register())
// falling back to PROVISIONED (participations.lane, set at provision/invite time and shown by
// list_participants). Before 065 only the live column routed, and across five bus projects NOBODY had ever
// called register() - so every lane-addressed post reached nobody while returning a success envelope. The
// provisioned arm is bounded by LANE_FALLBACK_FROM so the pre-065 archive is not retroactively PUSHED.

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

/** Insert a post row + its ledger event directly, at an arbitrary created_at (to straddle the cutoff). */
async function seedPostAt(projectId: number, lane: string, body: string, createdAt: string): Promise<number> {
  const ev = await query<{ id: string }>(
    `INSERT INTO events (project_id, actor_name, type, payload, ts)
     VALUES ($1, 'seeder', 'post', $2, $3::timestamptz) RETURNING id`,
    [projectId, JSON.stringify({ to_lane: lane }), createdAt],
  );
  const p = await query<{ id: string }>(
    `INSERT INTO posts (project_id, event_id, from_actor_name, to_lane, body, created_at)
     VALUES ($1, $2, 'seeder', $3, $4, $5::timestamptz) RETURNING id`,
    [projectId, Number(ev.rows[0].id), lane, body, createdAt],
  );
  return Number(p.rows[0].id);
}

const BEFORE_CUTOFF = "2026-08-01T00:00:00Z";

async function main(): Promise<void> {
  const ctx = await freshProject("lane");
  const bob = await createParticipation(ctx, "bob");
  const carol = await createParticipation(ctx, "carol");

  // ── 1. A PROVISIONED lane delivers, with no register() AND no presence row at all ─────────────────
  // This is the inversion of the pre-065 guarantee. bob is provisioned into "ops" the way admin_provision
  // and create_invite do it, and never calls register().
  //
  // NOTE THE STATE, it is load-bearing: bob has NO presence row here at all - touchPresence is MCP
  // middleware, so a participation that has never made a single bus call has no row, not a row reading
  // '(unset)'. The delivery predicate's scalar subquery then returns NULL, NULLIF passes the NULL through,
  // the IS NULL guard is TRUE, and the provisioned arm applies. That is a real case, not a hypothetical:
  // an agent can be invited and rostered into a lane weeks before it ever connects, and the handoffs sent
  // to that lane in the meantime must reach it when it does. Section 6 below covers the OTHER shape (a
  // presence row that exists but reads '(unset)'), which is what an agent that calls tools but never
  // registers looks like. Both must deliver, for different reasons.
  await query(`UPDATE participations SET lane = 'ops' WHERE id = $1`, [bob.participation.id]);
  const live = await withTx((c) => post(c, ctx, { to_lane: "ops", body: "provisioned delivery", ref: "L1" }));
  check((await unreadCount(bob)) === 1, `a provisioned lane must deliver: bob unread ${await unreadCount(bob)}`);
  const toMe = await readPosts(bob, { to_me: true });
  check(toMe.some((p) => p.post_id === live.post_id), "the provisioned-lane post reaches to_me");
  check((await unreadCount(bob)) === 0, "reading the provisioned-lane post stamps its receipt");

  // ── 2. The cutoff: the pre-065 archive is READABLE but never PUSHED ────────────────────────────────
  const oldId = await seedPostAt(ctx.project.id, "ops", "pre-065 handoff", BEFORE_CUTOFF);
  check((await unreadCount(bob)) === 0, `a pre-cutoff lane post must not become unread mail`);
  const wn = await withTx((c) => whatsNew(c, bob));
  check(wn.unread_posts === 0, `whats_new must agree with the cutoff, got ${wn.unread_posts}`);
  const archive = await readPosts(bob, { to_lane: "ops" });
  check(archive.some((p) => p.post_id === oldId), "the pre-cutoff post is still readable via read_posts(to_lane:)");

  // ── 3. The REGISTERED arm stays unbounded, exactly as before 065 ───────────────────────────────────
  // An explicit register() is a deliberate act of joining, so it carries no cutoff: carol gets the history.
  await withTx((c) => register(c, carol, { lane: "ops" }));
  const carolUnread = await unreadCount(carol);
  check(carolUnread >= 1, `a registered agent still receives pre-cutoff lane history, got ${carolUnread}`);

  // ── 4. register() dual-writes the roster, so the two columns cannot diverge ───────────────────────
  await withTx((c) => register(c, carol, { lane: "qa" }));
  const laneRow = await query<{ lane: string | null }>(`SELECT lane FROM participations WHERE id = $1`, [
    carol.participation.id,
  ]);
  check(laneRow.rows[0].lane === "qa", `register must dual-write participations.lane, got ${laneRow.rows[0].lane}`);

  // ── 5. Strict COALESCE: register() MOVES a lane, it does not add one ───────────────────────────────
  // ORDER MATTERS: the provisioned lane is set AFTER the register above, because register() dual-writes it -
  // setting it first would simply be overwritten, and then a post to "ops" would match no arm under ANY
  // variant of the predicate, so the assertion would pass with the IS NULL guard deleted and guard nothing.
  // Setting it after is also the reachable real-world state: an owner sets a lane on the Access tab for an
  // agent that has already registered elsewhere. Without the guard, that agent would receive BOTH lanes.
  await query(`UPDATE participations SET lane = 'ops' WHERE id = $1`, [carol.participation.id]);
  await readPosts(carol, { to_me: true }); // drain
  await withTx((c) => post(c, ctx, { to_lane: "ops", body: "to the old lane", ref: "L2" }));
  check((await unreadCount(carol)) === 0, "a registered agent no longer receives its PROVISIONED lane");
  await withTx((c) => post(c, ctx, { to_lane: "qa", body: "to the live lane", ref: "L3" }));
  check((await unreadCount(carol)) === 1, "a registered agent receives its LIVE lane");
  // Restore the converged state for the roster/who assertions below.
  await withTx((c) => register(c, carol, { lane: "qa" }));

  // ── 6. The who-surfaces report the lane that routes ────────────────────────────────────────────────
  const roster = await listRoster(ctx);
  check(roster.find((r) => r.name === "carol")?.lane === "qa", "list_participants reports the lane that routes");
  const active = await whoIsActive(ctx, { within_seconds: 3600 });
  check(active.find((a) => a.actor === "carol")?.lane === "qa", "who_is_active reports the resolved lane");
  // bob has never registered, but he HAS made bus calls, so touchPresence gave him a row carrying the
  // '(unset)' sentinel - the exact shape the project-a report found (roster says a lane, presence says nothing).
  // who_is_active must still show the lane a post would reach him on, or it contradicts delivery.
  await query(
    `INSERT INTO presence (participation_id, project_id, lane, last_seen) VALUES ($1, $2, '(unset)', now())
     ON CONFLICT (participation_id) DO UPDATE SET last_seen = now()`,
    [bob.participation.id, ctx.project.id],
  );
  const active2 = await whoIsActive(ctx, { within_seconds: 3600 });
  check(
    active2.find((a) => a.actor === "bob")?.lane === "ops",
    `who_is_active must resolve a provisioned-only lane, got ${JSON.stringify(active2.find((a) => a.actor === "bob")?.lane)}`,
  );
  // ...and the lane FILTER must agree with what it reports, or who_is_active(lane:) is the next dead surface.
  const opsOnly = await whoIsActive(ctx, { lane: "ops", within_seconds: 3600 });
  check(opsOnly.some((a) => a.actor === "bob"), "who_is_active(lane:) finds a provisioned-only member");

  // ── 7. Cross-project isolation (invariant 1/3) ─────────────────────────────────────────────────────
  const other = await freshProject("laneOther");
  const dave = await createParticipation(other, "dave");
  await query(`UPDATE participations SET lane = 'ops' WHERE id = $1`, [dave.participation.id]);
  await withTx((c) => post(c, ctx, { to_lane: "ops", body: "project one only", ref: "L4" }));
  check((await unreadCount(dave)) === 0, "a same-named lane in another project never receives the post");
  // Positive control: the isolation assertion above must not pass by the query simply returning nothing.
  await withTx((c) => post(c, other, { to_lane: "ops", body: "project two", ref: "L5" }));
  check((await unreadCount(dave)) === 1, "dave DOES receive his own project's lane post (positive control)");

  // ── 8. Reserved lane names ─────────────────────────────────────────────────────────────────────────
  // '(unset)' is the sentinel touchPresence writes and every resolution NULLIFs away, and '*' is reserved
  // for the server's own project-wide notices. Neither is a lane anyone may claim.
  let sentinelErr = "";
  try {
    await withTx((c) => register(c, bob, { lane: "(unset)" }));
  } catch (e) {
    sentinelErr = (e as Error).message;
  }
  check(/reserved/.test(sentinelErr), `register must refuse the '(unset)' sentinel, got ${JSON.stringify(sentinelErr)}`);
  check((await setParticipationLane(ctx.project.ownerId, bob.participation.id, "(unset)")) === false,
    "an owner must not be able to set the '(unset)' sentinel as a lane");
  check((await setParticipationLane(ctx.project.ownerId, bob.participation.id, "*")) === false,
    "an owner must not be able to set the reserved '*' broadcast lane");
  // Positive control: a normal value still goes through, so the refusals above are a real guard.
  check((await setParticipationLane(ctx.project.ownerId, bob.participation.id, "ops")) === true,
    "an ordinary lane must still be settable");

  // ── 9. recipients report the CANONICAL actor, never the caller's raw input ──────────────────────────
  const typed = await withTx((c) => post(c, ctx, { to_actor: "bob", body: "bare label", ref: "L6" }));
  check(typed.reaches === 1, `a to_actor post reaches its target, got ${typed.reaches}`);
  const canonical = (await listRoster(ctx)).find((r) => r.name === "bob")?.actor;
  check(typed.recipients[0] === canonical,
    `recipients must carry the canonical actor ${JSON.stringify(canonical)}, got ${JSON.stringify(typed.recipients[0])}`);

  check(typeof LANE_FALLBACK_FROM === "string" && !Number.isNaN(Date.parse(LANE_FALLBACK_FROM)),
    "LANE_FALLBACK_FROM parses as a timestamp");

  if (errors.length) {
    console.error("FAIL:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log(
    "OK lane.delivery: a provisioned lane delivers with no register(); the pre-cutoff archive is readable but never pushed; a registered agent keeps unbounded history; register MOVES the lane (strict COALESCE) and dual-writes the roster; who_is_active + list_participants report the lane that routes; '(unset)' and '*' are refused as lane names; recipients carry the canonical actor; cross-project isolation holds with a positive control.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(closePool);
