// Decision 064: a task list is an INDEX, not a document.
//
// Every row used to carry its FULL body (up to 4000 chars). Measured on prod: a bare list_tasks() in a busy
// project returned ~93,000 characters, 93.5% of it `detail`, and it overflowed a consuming agent's context
// at 101,865 characters. Scope was NOT the lever - narrowing to one agent's own actionable tasks still
// returned ~36,000 characters, because the bodies came along. So the body is previewed by default and the
// paired precise read is `task_ids`, which returns named tasks in full.
//
// This test asserts the SHAPE and, at the end, the actual PAYLOAD SIZE - because the whole point of the
// change is a number, and a shape assertion alone would pass a change that saved nothing.
import { freshProject } from "./_setup.js";
import { getPool, closePool } from "../src/db.js";
import { listTasks, parseTaskIds, DETAIL_PREVIEW_CHARS, MAX_TASK_IDS } from "../src/domain/task.js";

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

const BODY = "x".repeat(3000); // a realistic task body; prod's average is ~1,740 chars

async function main(): Promise<void> {
  const ctx = await freshProject("listshape");
  const pool = getPool();
  const P = ctx.project.id;

  // 12 open tasks and 8 terminal ones, every one carrying a large body.
  const openIds: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, detail, status) VALUES ($1, $2, $3, 'todo') RETURNING id`,
      [P, `open ${i}`, BODY],
    );
    openIds.push(Number(r.rows[0].id));
  }
  await pool.query(
    `INSERT INTO tasks (project_id, title, detail, status)
     SELECT $1, 'archived ' || g, $2, 'done' FROM generate_series(1, 8) g`,
    [P, BODY],
  );
  // One task with a SHORT body: it must come back whole and must NOT be flagged as cut.
  const shortId = Number(
    (
      await pool.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, detail, status) VALUES ($1, 'tiny', 'brief', 'todo') RETURNING id`,
        [P],
      )
    ).rows[0].id,
  );

  // ── 1. The DEFAULT: open tasks only, bodies previewed ──
  const def = await listTasks(ctx, {});
  check(def.length === 13, `default returns the 13 open tasks, not the archive (got ${def.length})`);
  check(!def.some((t) => t.status === "done"), "the done/cancelled archive is not in the default list");
  const big = def.find((t) => t.task_id === openIds[0]);
  check(big?.detail?.length === DETAIL_PREVIEW_CHARS, `a large body is cut to ${DETAIL_PREVIEW_CHARS} chars (got ${big?.detail?.length})`);
  check(big?.detail_truncated === true, "a cut row is MARKED cut");
  check(big?.detail_chars === BODY.length, `a cut row reports its TRUE size (got ${big?.detail_chars})`);
  // The short one proves the marker is derived from what came back, not from the mode - otherwise every row
  // would nag a fetch that returns the identical text.
  const tiny = def.find((t) => t.task_id === shortId);
  check(tiny?.detail === "brief", "a short body comes back whole under preview");
  check(tiny?.detail_truncated === undefined, "a body that fit is NOT flagged as cut");
  check(tiny?.detail_chars === undefined, "and carries no size noise");

  // ── 2. task_ids: naming a task IS asking for its body ──
  const named = await listTasks(ctx, { task_ids: [openIds[0], openIds[1]] });
  check(named.length === 2, `task_ids returns exactly the named tasks (got ${named.length})`);
  check(named.every((t) => t.detail === BODY), "named tasks come back in FULL, whatever the detail mode");
  check(named.every((t) => t.detail_truncated === undefined), "and are not marked cut");
  // It also outranks the open-only default: you asked for THESE, so their state is irrelevant.
  const doneRow = await pool.query<{ id: string }>(
    `SELECT id FROM tasks WHERE project_id = $1 AND status = 'done' LIMIT 1`,
    [P],
  );
  const namedDone = await listTasks(ctx, { task_ids: [Number(doneRow.rows[0].id)] });
  check(namedDone.length === 1 && namedDone[0].detail === BODY, "naming a DONE task returns it in full (state default does not apply)");
  check((await listTasks(ctx, { task_ids: [] })).length === 13, "an empty task_ids is ignored, not treated as 'match nothing'");
  const capped = await listTasks(ctx, { task_ids: openIds.concat(openIds).slice(0, MAX_TASK_IDS + 5) });
  check(capped.length <= MAX_TASK_IDS, `task_ids is bounded at ${MAX_TASK_IDS} (got ${capped.length})`);

  // task_ids must accept what clients ACTUALLY send. Claude Code - the primary consumer - serialized
  // `task_ids:[536]` as the STRING "[536]" against the live tool, twice. Since this is the only path to a
  // task body, rejecting the string form would leave bodies unreachable: the exact failure 064 prevents.
  check(JSON.stringify(parseTaskIds([1, 2])) === "[1,2]", "an array of numbers parses");
  check(JSON.stringify(parseTaskIds("[536, 535]")) === "[536,535]", "the bracketed STRING form parses (what the client sends)");
  check(JSON.stringify(parseTaskIds("12,15")) === "[12,15]", "a bare comma-separated string parses");
  check(JSON.stringify(parseTaskIds("  7 ")) === "[7]", "whitespace is tolerated");
  check(JSON.stringify(parseTaskIds([3, 3, 3])) === "[3]", "duplicates collapse");
  check(JSON.stringify(parseTaskIds("0,-4,abc,9")) === "[9]", "non-positive and non-numeric entries are dropped");
  check(parseTaskIds(undefined).length === 0 && parseTaskIds("").length === 0, "absent/empty yields no ids");
  check(parseTaskIds(Array.from({ length: 50 }, (_, i) => i + 1)).length === MAX_TASK_IDS, "the batch is capped");
  const viaString = await listTasks(ctx, { task_ids: `[${openIds[0]}, ${openIds[1]}]` });
  check(viaString.length === 2 && viaString.every((t) => t.detail === BODY),
    "the STRING form reaches the same full-detail read as the array form");

  // ── 3. Every override still available - the point is cheap DEFAULTS, not a cheap ceiling ──
  const full = await listTasks(ctx, { detail: "full" });
  check(full.every((t) => t.detail !== null && t.detail.length > DETAIL_PREVIEW_CHARS || t.title === "tiny"),
    "detail:full restores whole bodies (the old default, deliberately available)");
  const none = await listTasks(ctx, { detail: "none" });
  check(none.every((t) => t.detail === null), "detail:none drops bodies entirely");
  check(none.find((t) => t.task_id === openIds[0])?.detail_chars === BODY.length,
    "detail:none still reports the size, so an agent knows a body exists");
  const all = await listTasks(ctx, { all_states: true });
  check(all.length === 21, `all_states brings the archive back (got ${all.length})`);
  check((await listTasks(ctx, { status: "done" })).length === 8, "status:done still selects the archive");

  // ── 4. THE NUMBER. The shape means nothing if it did not get cheaper. ──
  const before = JSON.stringify(await listTasks(ctx, { all_states: true, detail: "full" })).length;
  const after = JSON.stringify(await listTasks(ctx, {})).length;
  const saved = Math.round((1 - after / before) * 100);
  check(
    after * 5 < before,
    `the default must be dramatically cheaper than the old behaviour: ${before} -> ${after} chars (${saved}% saved)`,
  );
  console.log(`  [payload] old default ${before} chars -> new default ${after} chars (${saved}% saved)`);

  await closePool();
  if (errors.length) {
    console.error(`FAIL task.listshape:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    "OK task.listshape: decision 064 - the default list is OPEN tasks with previewed bodies (cut rows marked " +
      "with their true size, rows that fit left clean), task_ids returns named tasks in FULL whatever their " +
      "state, and detail:full / detail:none / all_states / status keep every verbose override available. " +
      "Payload asserted, not assumed.",
  );
}

main().catch((err) => {
  console.error("task.listshape test errored:", err);
  process.exit(1);
});
