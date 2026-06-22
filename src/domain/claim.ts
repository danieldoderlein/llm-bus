import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";

export interface ClaimResult {
  sequence: string;
  number: number;
  formatted: string;
  note: string | null;
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
  const res = await client.query<{ current: string; prefix: string; pad: number }>(
    `INSERT INTO sequences (project_id, name, current)
     VALUES ($1, $2, 1)
     ON CONFLICT (project_id, name)
     DO UPDATE SET current = sequences.current + 1
     RETURNING current, prefix, pad`,
    [ctx.project.id, opts.sequence],
  );
  const row = res.rows[0];
  const number = Number(row.current);
  const formatted = formatId(row.prefix, row.pad, number);
  await appendEvent(client, ctx, "claim", {
    sequence: opts.sequence,
    number,
    formatted,
    note,
  });
  return { sequence: opts.sequence, number, formatted, note };
}

export interface SeedResult {
  sequence: string;
  current: number;
  prefix: string;
  pad: number;
}

/**
 * Set (or initialize) a sequence's counter and formatting, scoped to `ctx.project`.
 * A counter is never rewound: if the sequence already exists and `opts.current` is lower
 * than the stored value, this throws. Appends a `seed` event in the same transaction.
 */
export async function seedSequence(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { sequence: string; current: number; prefix?: string; pad?: number },
): Promise<SeedResult> {
  const prefix = opts.prefix ?? "";
  const pad = opts.pad ?? 0;

  // Guard against rewinding an existing counter (lock the row to avoid a TOCTOU race).
  const existing = await client.query<{ current: string }>(
    `SELECT current FROM sequences
      WHERE project_id = $1 AND name = $2
      FOR UPDATE`,
    [ctx.project.id, opts.sequence],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const stored = Number(existing.rows[0].current);
    if (opts.current < stored) {
      throw new Error(
        `cannot rewind sequence "${opts.sequence}": stored current ${stored} > requested ${opts.current}`,
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
  const result: SeedResult = {
    sequence: opts.sequence,
    current: Number(row.current),
    prefix: row.prefix,
    pad: row.pad,
  };
  await appendEvent(client, ctx, "seed", {
    sequence: result.sequence,
    current: result.current,
    prefix: result.prefix,
    pad: result.pad,
  });
  return result;
}
