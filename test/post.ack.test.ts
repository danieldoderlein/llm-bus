import { withTx, closePool } from "../src/db.js";
import { freshProject, createParticipation } from "./_setup.js";
import { post, readPosts, ack } from "../src/domain/post.js";

// Unit B proof: a post addressed to a lane+actor is readable by the recipient, ack flips
// `acked` true, ack is idempotent, and `to_me` surfaces actor-addressed posts.
async function main(): Promise<void> {
  const ctx = await freshProject("post");
  const bobCtx = await createParticipation(ctx, "bob");

  const errors: string[] = [];

  // tester posts to lane "backend", addressed to bob.
  const created = await withTx((c) =>
    post(c, ctx, { to_lane: "backend", to_actor: "bob", body: "wire attribution", ref: "R104" }),
  );
  if (!(created.post_id > 0)) errors.push(`expected post_id > 0, got ${created.post_id}`);
  if (!(created.event_id > 0)) errors.push(`expected event_id > 0, got ${created.event_id}`);

  // bob reads the backend lane: sees the post, unacked.
  let lane = await readPosts(bobCtx, { to_lane: "backend" });
  if (lane.length < 1) errors.push(`expected >= 1 backend post, got ${lane.length}`);
  if (lane[0]?.body !== "wire attribution") errors.push(`expected body 'wire attribution', got ${lane[0]?.body}`);
  if (lane[0]?.from !== "tester") errors.push(`expected from 'tester', got ${lane[0]?.from}`);
  if (lane[0]?.acked !== false) errors.push(`expected acked false before ack, got ${lane[0]?.acked}`);

  // bob acks, then re-reads: now acked.
  await withTx((c) => ack(c, bobCtx, created.post_id));
  lane = await readPosts(bobCtx, { to_lane: "backend" });
  if (lane[0]?.acked !== true) errors.push(`expected acked true after ack, got ${lane[0]?.acked}`);

  // ack again is idempotent — must not throw.
  await withTx((c) => ack(c, bobCtx, created.post_id));

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

  await closePool();

  if (errors.length) {
    console.error(`FAIL post.ack:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `OK post.ack: post#${created.post_id} (event#${created.event_id}) read by recipient, ack idempotent, to_me resolves lane+actor.`,
  );
}

main().catch((err) => {
  console.error("post.ack test errored:", err);
  process.exit(1);
});
