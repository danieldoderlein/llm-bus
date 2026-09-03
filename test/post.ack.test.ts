import { withTx, query, closePool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import { post, readPosts, unreadCount } from "../src/domain/post.js";
import { register } from "../src/domain/presence.js";
import { resolveOwner } from "../src/admin/owner.js";

// Post read-state (decision 039: reading IS the receipt; `ack` is retired). A post addressed to a lane+actor
// is readable by the recipient; reading it flips `read` true (the receipt) and drops the unread count; reading
// again is idempotent; `to_me` surfaces actor-addressed posts; a post carries optional artifact links.
async function main(): Promise<void> {
  const ctx = await freshProject("post");
  const bobCtx = await createParticipation(ctx, "bob");

  const errors: string[] = [];

  // bob is provisioned into "backend" the way admin_provision/create_invite do it. Decision 065 refuses a
  // post to a lane that exists in NEITHER column, so a lane has to exist before it can be posted to - and a
  // provisioned lane is enough, no register() needed.
  await query(`UPDATE participations SET lane = 'backend' WHERE id = $1`, [bobCtx.participation.id]);

  // tester posts to lane "backend", addressed to bob.
  const created = await withTx((c) =>
    post(c, ctx, { to_lane: "backend", to_actor: "bob", body: "wire attribution", ref: "R104" }),
  );
  if (!(created.post_id > 0)) errors.push(`expected post_id > 0, got ${created.post_id}`);
  if (!(created.event_id > 0)) errors.push(`expected event_id > 0, got ${created.event_id}`);

  // bob reads the backend lane: sees the post, unread (read=false reflects the pre-read state), and the act of
  // reading it (bob is addressed via to_actor) writes the receipt.
  let lane = await readPosts(bobCtx, { to_lane: "backend" });
  if (lane.length < 1) errors.push(`expected >= 1 backend post, got ${lane.length}`);
  if (lane[0]?.body !== "wire attribution") errors.push(`expected body 'wire attribution', got ${lane[0]?.body}`);
  if (lane[0]?.from !== "tester") errors.push(`expected from 'tester', got ${lane[0]?.from}`);
  if (lane[0]?.read !== false) errors.push(`expected read false on the first read, got ${lane[0]?.read}`);

  // re-read: now read=true (the receipt from the first read persists), and bob's unread count is 0.
  lane = await readPosts(bobCtx, { to_lane: "backend" });
  if (lane[0]?.read !== true) errors.push(`expected read true after the first read, got ${lane[0]?.read}`);
  const unread = await unreadCount(bobCtx);
  if (unread !== 0) errors.push(`expected bob's unread count 0 after reading, got ${unread}`);

  // Decision 062: a lane post fans out to everyone in the lane INCLUDING its author, so the author must not
  // become unread mail to themselves - otherwise "_unread_posts: N" rides every tool response nagging an
  // agent about its own handoff, and the count cannot be cleared by doing what it asks. Found by dogfooding:
  // ten "unread" posts, six of them mine.
  await withTx((c) => register(c, ctx, { lane: "backend", status: "authoring" }));
  await withTx((c) => post(c, ctx, { to_lane: "backend", body: "my own handoff", ref: "R106" }));
  const selfUnread = await unreadCount(ctx);
  if (selfUnread !== 0) errors.push(`an author's own lane post must not count as their unread mail, got ${selfUnread}`);
  const selfOnly = await readPosts(ctx, { to_me: true, unread_only: true });
  if (selfOnly.some((p) => p.from === "tester")) {
    errors.push(`unread_only must not return the caller's own posts, got [${selfOnly.map((p) => p.post_id).join(",")}]`);
  }

  // to_me surfaces the actor-addressed post for bob.
  const mine = await readPosts(bobCtx, { to_me: true });
  if (!mine.some((p) => p.post_id === created.post_id)) {
    errors.push(`expected to_me to include post ${created.post_id}, got [${mine.map((p) => p.post_id).join(",")}]`);
  }

  // decision 018: to_actor accepts the qualified handle/label form too, not just the bare label.
  const q = await withTx((c) =>
    post(c, ctx, { to_actor: "anyhandle/bob", body: "qualified addressing", ref: "R105" }),
  );
  if (!(q.post_id > 0)) errors.push(`qualified to_actor post failed: ${JSON.stringify(q)}`);
  const bobInbox = await readPosts(bobCtx, { to_me: true });
  if (!bobInbox.some((p) => p.post_id === q.post_id)) {
    errors.push(`qualified-addressed post ${q.post_id} should reach bob's inbox`);
  }

  // decision 039: a post carries optional artifact links ([{label,url}]) - "attach a link, not a blob".
  // They round-trip through readPosts as structured data; a link with no url is rejected; a post with no
  // links reads back links=null.
  const withLinks = await withTx((c) =>
    post(c, ctx, {
      to_actor: "bob",
      body: "see the spec + the PR",
      ref: "R106",
      links: [
        { label: "spec", url: "https://example.com/spec.md" },
        { url: "https://example.com/pr/1" },
      ],
    }),
  );
  const linkRow = (await readPosts(bobCtx, { ref: "R106" }))[0];
  if (!linkRow || linkRow.post_id !== withLinks.post_id) {
    errors.push(`expected to read back post ${withLinks.post_id} by ref R106`);
  } else {
    if (linkRow.links?.length !== 2) errors.push(`expected 2 links, got ${JSON.stringify(linkRow.links)}`);
    if (linkRow.links?.[0]?.label !== "spec" || linkRow.links?.[0]?.url !== "https://example.com/spec.md") {
      errors.push(`link[0] mismatch: ${JSON.stringify(linkRow.links?.[0])}`);
    }
    if (linkRow.links?.[1]?.url !== "https://example.com/pr/1") {
      errors.push(`link[1] url mismatch: ${JSON.stringify(linkRow.links?.[1])}`);
    }
  }
  // a post with no links reads back links=null (not an empty array).
  if (lane[0]?.links !== null) errors.push(`expected links=null on a link-less post, got ${JSON.stringify(lane[0]?.links)}`);
  // Decision 054: a targeted post's `to_actor` is the qualified name of the RECIPIENT, derived (like every
  // roster surface) from COALESCE(recipient participation's human_owner_id, provisioner owner_id). Rebind bob
  // to a SECOND human with a handle and confirm read_posts renders that bound human, not the project owner.
  const recipientMember = await resolveOwner(`post-recipient-member-${ctx.project.slug}@test.local`);
  await query(`UPDATE participations SET human_owner_id = $1 WHERE id = $2`, [recipientMember.id, bobCtx.participation.id]);
  await withTx((c) => post(c, ctx, { to_actor: "bob", body: "bound-human recipient", ref: "R107" }));
  const recRow = (await readPosts(bobCtx, { ref: "R107" }))[0];
  if (recRow?.to_actor !== `${recipientMember.username}/bob`)
    errors.push(`to_actor bound-human: expected ${recipientMember.username}/bob, got ${JSON.stringify(recRow?.to_actor)}`);

  // a link missing its url is rejected at normalize time.
  let rejected = false;
  try {
    await withTx((c) => post(c, ctx, { to_actor: "bob", body: "bad link", links: [{ label: "x" }] }));
  } catch {
    rejected = true;
  }
  if (!rejected) errors.push("a link with no url should be rejected");

  // Decision 061, silent-addressing sweep, as REFINED by 065. (a) A lane was free text and no registry, so a
  // typo'd lane was accepted and reached nobody, forever silently; 061 made it warn, 065 refuses it outright
  // because a lane in neither column is a typo every time. (b) `to_actor` resolves AGENTS only, so naming a
  // human member returned a bare "not found" about someone who demonstrably IS in the project.
  let laneRejected = "";
  try {
    await withTx((c) => post(c, ctx, { to_lane: "markting", body: "typo lane" }));
  } catch (e) {
    laneRejected = (e as Error).message;
  }
  if (!/does not exist in this project/.test(laneRejected))
    errors.push(`a post to a lane that exists in neither column must be REFUSED, got ${JSON.stringify(laneRejected)}`);
  if (!/lanes in use: backend/.test(laneRejected))
    errors.push(`the refusal must name the lanes that DO exist, got ${JSON.stringify(laneRejected)}`);
  if (!/register\(lane:/.test(laneRejected) || !/to_actor:/.test(laneRejected))
    errors.push(`the refusal must name the corrective call, got ${JSON.stringify(laneRejected)}`);

  // The read path refuses the same way: an empty [] for a lane that does not exist is indistinguishable from
  // "no lane mail", which is how a rig read its own actor name as a lane for nine days and saw nothing wrong.
  let readRejected = "";
  try {
    await readPosts(ctx, { to_lane: "markting" });
  } catch (e) {
    readRejected = (e as Error).message;
  }
  if (!/does not exist in this project/.test(readRejected))
    errors.push(`read_posts on an unknown lane must be REFUSED, not return [], got ${JSON.stringify(readRejected)}`);

  // A REGISTERED lane delivers and reports its reach.
  await withTx((c) => register(c, bobCtx, { lane: "backend" }));
  const laneOk = await withTx((c) => post(c, ctx, { to_lane: "backend", body: "real lane" }));
  if (laneOk.warning) errors.push(`a post to a REGISTERED lane must not warn, got ${laneOk.warning}`);
  if (laneOk.reaches !== 1) errors.push(`expected reaches 1 for the backend lane, got ${laneOk.reaches}`);
  // recipients carry the same qualified actor form as list_participants / who_is_active (decision 044).
  if (!laneOk.recipients.some((r) => r === "bob" || r.endsWith("/bob")))
    errors.push(`expected bob in recipients, got ${JSON.stringify(laneOk.recipients)}`);

  // 065 INVERTS 061's provisioning guard. It used to assert that a lane set only on the participation row
  // "still reaches nobody and must warn" - that was correct while presence.lane was the delivery surface.
  // 065 moved the delivery surface, so a provisioned-only lane now DELIVERS, and asserting otherwise would
  // pin the bug. carol is provisioned and never registers.
  const carolCtx = await createParticipation(ctx, "carol");
  await query(`UPDATE participations SET lane = 'provisioned-only' WHERE id = $1`, [carolCtx.participation.id]);
  const provisionedOnly = await withTx((c) =>
    post(c, ctx, { to_lane: "provisioned-only", body: "not registered" }),
  );
  if (provisionedOnly.warning)
    errors.push(`a provisioned-only lane now DELIVERS and must not warn, got ${provisionedOnly.warning}`);
  if (provisionedOnly.reaches !== 1)
    errors.push(`a provisioned-only lane must reach its member, got reaches ${provisionedOnly.reaches}`);
  if ((await unreadCount(carolCtx)) !== 1)
    errors.push(`the provisioned-only post must land in carol's unread mail`);

  // The surviving warning case, now that an unknown lane is refused: a lane that EXISTS but resolves to no
  // OTHER participation. The common shape is a solo occupant posting to their own lane - decision 062 says
  // you are never mail to yourself, so the reach is genuinely zero and saying so is the whole point.
  await withTx((c) => register(c, ctx, { lane: "solo" }));
  const soloLane = await withTx((c) => post(c, ctx, { to_lane: "solo", body: "nobody else here" }));
  if (soloLane.reaches !== 0) errors.push(`expected reaches 0 for a solo lane, got ${soloLane.reaches}`);
  if (!soloLane.warning || !/reaches nobody else/.test(soloLane.warning))
    errors.push(`a known lane reaching nobody else must warn, got ${JSON.stringify(soloLane.warning)}`);

  const postHuman = await resolveOwner(`post-human-${ctx.project.id}@test.local`);
  await query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
    [ctx.project.id, postHuman.id],
  );
  let humanPostErr = "";
  try { await withTx((c) => post(c, ctx, { to_actor: postHuman.username as string, body: "hi" })); }
  catch (e) { humanPostErr = (e as Error).message; }
  if (!/HUMAN MEMBER/.test(humanPostErr) || !/task_assign/.test(humanPostErr))
    errors.push(`posting to a human must say what they are and where their work lands, got "${humanPostErr}"`);

  await closePool();

  if (errors.length) {
    console.error(`FAIL post.ack:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `OK post.ack: post#${created.post_id} (event#${created.event_id}) read by recipient flips read-state (ack ` +
      `retired, decision 039), unread count clears, to_me resolves lane+actor, artifact links round-trip.`,
  );
}

main().catch((err) => {
  console.error("post.ack test errored:", err);
  process.exit(1);
});
