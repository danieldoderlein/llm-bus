import os from "node:os";
import { randomUUID } from "node:crypto";

// Default DATABASE_URL to the local v2 test cluster if not provided. Must run before db.ts.
process.env.DATABASE_URL ??= `postgres://${os.userInfo().username}@127.0.0.1:5440/llm_bus`;

const { getPool } = await import("../src/db.js");
import type { Ctx } from "../src/context.js";

/**
 * A fresh, isolated owner + project + admin "tester" participant/participation, as a Ctx.
 * Every test gets its own owner+project (unique) so concurrent runs never collide.
 * Assumes the schema is already migrated (no DDL here).
 */
export async function freshProject(base: string): Promise<Ctx> {
  const pool = getPool();
  const tag = randomUUID().slice(0, 8);
  const owner = await pool.query<{ id: string; email: string }>(
    `INSERT INTO owners (email) VALUES ($1) RETURNING id, email`,
    [`${base}-${tag}@test.local`],
  );
  const ownerId = Number(owner.rows[0].id);
  const project = await pool.query<{ id: string; slug: string; name: string; liveness_window_sec: number }>(
    `INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $2)
     RETURNING id, slug, name, liveness_window_sec`,
    [ownerId, `${base}-${tag}`],
  );
  // A project always carries its owner membership (decision 037; production does this in createProject +
  // the backfill). Test fixtures must uphold the same invariant or membership-scoped queries see no owner row.
  await pool.query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (project_id, owner_id) DO NOTHING`,
    [Number(project.rows[0].id), ownerId],
  );
  const participant = await pool.query<{ id: string }>(
    `INSERT INTO participants (owner_id, name, kind) VALUES ($1, 'tester', 'agent') RETURNING id`,
    [ownerId],
  );
  const participantId = Number(participant.rows[0].id);
  const part = await pool.query<{ id: string; lane: string | null }>(
    `INSERT INTO participations (participant_id, project_id, is_admin) VALUES ($1, $2, true)
     RETURNING id, lane`,
    [participantId, Number(project.rows[0].id)],
  );
  return {
    project: {
      id: Number(project.rows[0].id),
      slug: project.rows[0].slug,
      name: project.rows[0].name,
      livenessWindowSec: Number(project.rows[0].liveness_window_sec),
      ownerId,
      ownerHandle: null, // freshProject owners have no handle by default; a test sets it to exercise 044's qualifier
    },
    participant: { id: participantId, name: "tester", kind: "agent", ownerId, handle: null },
    participation: { id: Number(part.rows[0].id), isAdmin: true, lane: part.rows[0].lane, humanOwnerId: null },
    owner: { id: ownerId, email: owner.rows[0].email },
    actor: "tester", // bare label: this helper builds an un-backfilled (no-handle) ctx by default
  };
}

/** Add another participant + participation in the same project, returned as a Ctx (e.g. "bob"). */
export async function createParticipation(
  ctx: Ctx,
  name: string,
  kind: "agent" | "human" = "agent",
): Promise<Ctx> {
  const pool = getPool();
  const p = await pool.query<{ id: string }>(
    `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, name) DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
    [ctx.project.ownerId, name, kind],
  );
  const participantId = Number(p.rows[0].id);
  const part = await pool.query<{ id: string; lane: string | null }>(
    `INSERT INTO participations (participant_id, project_id) VALUES ($1, $2)
     ON CONFLICT (participant_id, project_id) DO UPDATE SET project_id = EXCLUDED.project_id
     RETURNING id, lane`,
    [participantId, ctx.project.id],
  );
  return {
    project: ctx.project,
    participant: { id: participantId, name, kind, ownerId: ctx.project.ownerId, handle: null },
    participation: { id: Number(part.rows[0].id), isAdmin: false, lane: part.rows[0].lane, humanOwnerId: null },
    owner: ctx.owner,
    actor: name, // bare label (un-backfilled ctx); the qualified path is covered in identity.handle.test
  };
}

/**
 * A SECOND project the same identity belongs to (decision 070), returned as the Ctx for that membership.
 * By default it sits under the same owner and reuses `ctx`'s participant - the shape a real second
 * project takes for one owner. Pass `ownerId` to place it under a DIFFERENT owner (which forces a new
 * participant row, exactly as invite acceptance does), and `humanOwnerId` to set the driving human that
 * makes it reachable across that owner boundary.
 */
export async function siblingProject(
  ctx: Ctx,
  base: string,
  opts: { ownerId?: number; humanOwnerId?: number | null; isAdmin?: boolean } = {},
): Promise<Ctx> {
  const pool = getPool();
  const tag = randomUUID().slice(0, 8);
  const ownerId = opts.ownerId ?? ctx.project.ownerId;
  const project = await pool.query<{ id: string; slug: string; name: string; liveness_window_sec: number }>(
    `INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $2)
     RETURNING id, slug, name, liveness_window_sec`,
    [ownerId, `${base}-${tag}`],
  );
  const projectId = Number(project.rows[0].id);
  await pool.query(
    `INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (project_id, owner_id) DO NOTHING`,
    [projectId, ownerId],
  );
  // A participant is unique per (owner, name): same owner -> the SAME participant row is reused, which is
  // what makes participant-keyed reach work; a different owner -> a new row, reachable only via the human.
  const p = await pool.query<{ id: string }>(
    `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, name) DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
    [ownerId, ctx.participant.name, ctx.participant.kind],
  );
  const participantId = Number(p.rows[0].id);
  const part = await pool.query<{ id: string; lane: string | null }>(
    `INSERT INTO participations (participant_id, project_id, is_admin, human_owner_id) VALUES ($1, $2, $3, $4)
     RETURNING id, lane`,
    [participantId, projectId, opts.isAdmin ?? false, opts.humanOwnerId ?? null],
  );
  const ownerRow = await pool.query<{ email: string; username: string | null }>(
    `SELECT email, username FROM owners WHERE id = $1`,
    [ownerId],
  );
  return {
    project: {
      id: projectId,
      slug: project.rows[0].slug,
      name: project.rows[0].name,
      livenessWindowSec: Number(project.rows[0].liveness_window_sec),
      ownerId,
      ownerHandle: ownerRow.rows[0].username,
    },
    participant: {
      id: participantId,
      name: ctx.participant.name,
      kind: ctx.participant.kind,
      ownerId,
      handle: ownerRow.rows[0].username,
    },
    participation: {
      id: Number(part.rows[0].id),
      isAdmin: opts.isAdmin ?? false,
      lane: part.rows[0].lane,
      humanOwnerId: opts.humanOwnerId ?? null,
    },
    owner: { id: ownerId, email: ownerRow.rows[0].email },
    actor: ctx.participant.name,
  };
}

/** Set the driving human on a membership (participations.human_owner_id) and return the updated Ctx. */
export async function setDriver(ctx: Ctx, humanOwnerId: number | null): Promise<Ctx> {
  await getPool().query(`UPDATE participations SET human_owner_id = $2 WHERE id = $1`, [
    ctx.participation.id,
    humanOwnerId,
  ]);
  return { ...ctx, participation: { ...ctx.participation, humanOwnerId } };
}
