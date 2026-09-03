import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";

export interface ClaimResult {
  sequence: string;
  number: number;
  formatted: string;
  /** The auto-qualified cross-project id `<ownerHandle>/<slug>#<formatted>` (decision 044). The bare
   *  `formatted` stays the local filename; `qualified` is how a multi-project agent cites this number without
   *  clashing with the same bare id in another project. */
  qualified: string;
  note: string | null;
  /** True when this call CREATED the sequence rather than advancing an existing one, i.e. this id is the
   *  FIRST of a brand-new counter. `claim` is an upsert, so a typo'd name silently forks a new namespace and
   *  hands back a confident-looking "1" - and CLAUDE.md §02 requires decision numbers to come from
   *  claim("decisions"), so one typo can fork the numbering a whole fleet shares (decision 061). */
  created: boolean;
  /** Present only on a `created` claim in a project that ALREADY has other sequences - the typo signal.
   *  Names the existing sequences so the mistake is visible at the call site instead of weeks later. */
  warning?: string;
}

/**
 * Render a claimed number as a stable display id: `prefix` followed by the number
 * left-zero-padded to width `pad`. `pad === 0` means no padding (bare digits).
 */
export function formatId(prefix: string, pad: number, n: number): string {
  const digits = String(n);
  const padded = pad > 0 ? digits.padStart(pad, "0") : digits;
  return prefix + padded;
}

/**
 * The auto-qualified cross-project id (decision 044): the project's canonical bus address
 * `<ownerHandle>/<slug>` + `#` + the bare local id. Built from the caller's OWN project (owner handle + slug,
 * resolved server-side from the token - isolation-preserving, never a cross-project read), so nothing is
 * claimed and the same bare id in two projects is disambiguated. Degrades to `<slug>#<formatted>` when the
 * owner has no handle yet (pre-backfill). This is a REFERENCE form; the bare `formatted` remains the filename.
 */
export function qualifyId(ownerHandle: string | null, slug: string, formatted: string): string {
  const project = ownerHandle ? `${ownerHandle}/${slug}` : slug;
  return `${project}#${formatted}`;
}

/**
 * Atomically allocate the next number for `sequence` and append the matching event,
 * both inside the caller's transaction and scoped to `ctx.project`.
 *
 * The fused `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` takes a row lock on the
 * (project_id, name) row, serializing concurrent claimers so two callers can never
 * receive the same number. The increment and its ledger event commit together, so no
 * number is ever handed out without a recorded event.
 */
export async function claimSequence(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { sequence: string; note?: string },
): Promise<ClaimResult> {
  const note = opts.note ?? null;
  // `(xmax = 0)` distinguishes the INSERT branch from the DO UPDATE branch of the upsert - a pure extra
  // projection, so the row lock and the gap-free serialization of concurrent claimers are untouched
  // (invariant 2). It is what lets a brand-new namespace announce itself instead of passing for a real id.
  const res = await client.query<{ current: string; prefix: string; pad: number; created: boolean }>(
    `INSERT INTO sequences (project_id, name, current)
     VALUES ($1, $2, 1)
     ON CONFLICT (project_id, name)
     DO UPDATE SET current = sequences.current + 1
     RETURNING current, prefix, pad, (xmax = 0) AS created`,
    [ctx.project.id, opts.sequence],
  );
  const row = res.rows[0];
  const number = Number(row.current);
  const created = row.created === true;
  // Typo signal (decision 061): creating the FIRST sequence in a project is ordinary; creating a NEW one
  // beside existing sequences is how `claim("decisons")` silently forks a namespace. Runs only on the
  // create path, inside the same transaction, so the hot path is unchanged.
  let warning: string | undefined;
  if (created) {
    const others = await client.query<{ name: string }>(
      `SELECT name FROM sequences WHERE project_id = $1 AND name <> $2 ORDER BY name`,
      [ctx.project.id, opts.sequence],
    );
    if (others.rows.length > 0) {
      warning =
        `created a NEW sequence "${opts.sequence}" (this id is its first). This project already has: ` +
        `${others.rows.map((r) => r.name).join(", ")}. If you meant one of those, STOP - this number is from ` +
        `a brand-new counter, not that series. Call list_sequences to see the real names.`;
    }
  }
  const formatted = formatId(row.prefix, row.pad, number);
  const qualified = qualifyId(ctx.project.ownerHandle, ctx.project.slug, formatted);
  // The bare `formatted` is what the ledger records; `qualified` is NOT persisted (it is recomputed live from
  // the project's current handle wherever it is shown, so a later handle backfill can't leave a stale copy).
  await appendEvent(client, ctx, "claim", {
    sequence: opts.sequence,
    number,
    formatted,
    note,
  });
  return { sequence: opts.sequence, number, formatted, qualified, note, created, ...(warning ? { warning } : {}) };
}

export interface SeedResult {
  sequence: string;
  current: number;
  prefix: string;
  pad: number;
  /** The qualified id of the current (last-used) value after the PUT (decision 044), e.g. `daniel/bu2#R180`. */
  qualified: string;
}

/**
 * Set (or initialize) a sequence's counter and formatting, scoped to `ctx.project`.
 *
 * seed_sequence is INITIALIZE-OR-ADVANCE only: it creates a brand-new sequence, or advances an existing
 * one to a strictly HIGHER offset. Re-seeding an existing sequence to the same or a lower value is refused
 * (decision 040) - that is the operation that quietly resets a live registry. The refusal names the stored
 * value and states that the counter survives a ledger flush, because the flush-driven near-miss (an agent
 * misreading a stale `latest_claims: {}` as "the sequences are gone" and reaching for seed) is exactly the
 * case this guard exists to stop. A `seed` event is appended in the same transaction.
 */
export async function seedSequence(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { sequence: string; current: number; prefix?: string; pad?: number },
): Promise<SeedResult> {
  const prefix = opts.prefix ?? "";
  const pad = opts.pad ?? 0;

  // Guard against resetting an existing counter (lock the row to avoid a TOCTOU race).
  const existing = await client.query<{ current: string }>(
    `SELECT current FROM sequences
      WHERE project_id = $1 AND name = $2
      FOR UPDATE`,
    [ctx.project.id, opts.sequence],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const stored = Number(existing.rows[0].current);
    if (opts.current <= stored) {
      throw new Error(
        `sequence "${opts.sequence}" already exists at ${stored} and is intact - a sequence counter ` +
          `SURVIVES a ledger flush (if latest_claims looked empty, that was a stale ledger view; ` +
          `list_sequences is authoritative). Do NOT re-seed it: call claim("${opts.sequence}") for the ` +
          `next id. seed_sequence only initializes a NEW sequence or advances one to a HIGHER offset ` +
          `(requested ${opts.current} <= stored ${stored}).`,
      );
    }
  }

  const res = await client.query<{ current: string; prefix: string; pad: number }>(
    `INSERT INTO sequences (project_id, name, current, prefix, pad)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, name)
     DO UPDATE SET current = EXCLUDED.current, prefix = EXCLUDED.prefix, pad = EXCLUDED.pad
     RETURNING current, prefix, pad`,
    [ctx.project.id, opts.sequence, opts.current, prefix, pad],
  );
  const row = res.rows[0];
  const seededCurrent = Number(row.current);
  const result: SeedResult = {
    sequence: opts.sequence,
    current: seededCurrent,
    prefix: row.prefix,
    pad: row.pad,
    qualified: qualifyId(ctx.project.ownerHandle, ctx.project.slug, formatId(row.prefix, row.pad, seededCurrent)),
  };
  await appendEvent(client, ctx, "seed", {
    sequence: result.sequence,
    current: result.current,
    prefix: result.prefix,
    pad: result.pad,
  });
  return result;
}
