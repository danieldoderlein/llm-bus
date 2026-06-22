import type { Ctx } from "../context.js";
import { query } from "../db.js";

export interface LedgerEvent {
  id: number;
  ts: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface EventFilter {
  actor?: string;
  type?: string;
  sequence?: string;
  ref?: string;
  tag?: string;
  since?: string;
  until?: string;
  last_n?: number;
  limit?: number;
}

/**
 * Query the append-only ledger for one project with exact filters only (no semantic
 * search). All provided filters are AND-combined; results are newest-first (id DESC).
 * Every value is parameterized — no string interpolation of user input. The row cap is
 * `last_n ?? limit ?? 100`.
 */
export async function queryEvents(ctx: Ctx, filter: EventFilter = {}): Promise<LedgerEvent[]> {
  const params: unknown[] = [];
  const push = (val: unknown): string => {
    params.push(val);
    return `$${params.length}`;
  };

  const clauses: string[] = [`project_id = ${push(ctx.project.id)}`];
  if (filter.actor) clauses.push(`actor_name = ${push(filter.actor)}`);
  if (filter.type) clauses.push(`type = ${push(filter.type)}`);
  if (filter.sequence) clauses.push(`payload->>'sequence' = ${push(filter.sequence)}`);
  if (filter.ref) clauses.push(`payload->>'ref' = ${push(filter.ref)}`);
  if (filter.tag) clauses.push(`payload->>'tag' = ${push(filter.tag)}`);
  if (filter.since) clauses.push(`ts >= ${push(filter.since)}::timestamptz`);
  if (filter.until) clauses.push(`ts <= ${push(filter.until)}::timestamptz`);

  const limit = filter.last_n ?? filter.limit ?? 100;
  const limitPlaceholder = push(limit);

  const res = await query<{
    id: string;
    ts: string;
    actor: string;
    type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, ts, actor_name AS actor, type, payload
       FROM events
      WHERE ${clauses.join(" AND ")}
      ORDER BY id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );

  return res.rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
  }));
}
