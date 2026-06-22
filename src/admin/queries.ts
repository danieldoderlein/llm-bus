import { randomBytes } from "node:crypto";
import { query, withTx } from "../db.js";
import { hashToken } from "../auth.js";

// Every function here is OWNER-SCOPED: each query filters by owner_id (directly or via a
// join to projects.owner_id / participants.owner_id). A row that the owner does not own is
// invisible — loaders return null (the handler 404s) and mutators no-op. This is the only
// authorization boundary for the web admin, so it must never trust a caller-supplied id
// without re-proving ownership in the same SQL statement.

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  livenessWindowSec: number;
  participationCount: number;
  eventCount: number;
}

export interface ParticipantRow {
  id: number;
  name: string;
  kind: "agent" | "human";
  grantCount: number;
}

export interface ParticipationRow {
  participationId: number;
  participantName: string;
  kind: "agent" | "human";
  lane: string | null;
  isAdmin: boolean;
  tokenActive: boolean;
  eventCount: number;
}

export interface GrantResult {
  participation: {
    id: number;
    participantId: number;
    projectId: number;
    lane: string | null;
    isAdmin: boolean;
  };
  plaintextToken: string;
}

/** All projects this owner owns, with participation + event counts. */
export async function listProjects(ownerId: number): Promise<ProjectRow[]> {
  const res = await query<{
    id: string;
    slug: string;
    name: string;
    liveness_window_sec: number;
    participation_count: string;
    event_count: string;
  }>(
    `SELECT p.id, p.slug, p.name, p.liveness_window_sec,
            (SELECT count(*) FROM participations pa WHERE pa.project_id = p.id) AS participation_count,
            (SELECT count(*) FROM events e WHERE e.project_id = p.id) AS event_count
       FROM projects p
      WHERE p.owner_id = $1
      ORDER BY p.created_at DESC, p.id DESC`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    livenessWindowSec: Number(r.liveness_window_sec),
    participationCount: Number(r.participation_count),
    eventCount: Number(r.event_count),
  }));
}

/** All participants this owner owns, with a count of their grants (participations). */
export async function listParticipants(ownerId: number): Promise<ParticipantRow[]> {
  const res = await query<{
    id: string;
    name: string;
    kind: "agent" | "human";
    grant_count: string;
  }>(
    `SELECT pt.id, pt.name, pt.kind,
            (SELECT count(*) FROM participations pa WHERE pa.participant_id = pt.id) AS grant_count
       FROM participants pt
      WHERE pt.owner_id = $1
      ORDER BY pt.created_at DESC, pt.id DESC`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    grantCount: Number(r.grant_count),
  }));
}

/** A single project, but only if owned. Returns null otherwise (handler 404s — no 403 oracle). */
export async function loadOwnedProject(
  ownerId: number,
  projectId: number,
): Promise<{ id: number; slug: string; name: string; livenessWindowSec: number } | null> {
  if (!Number.isFinite(projectId)) return null;
  const res = await query<{
    id: string;
    slug: string;
    name: string;
    liveness_window_sec: number;
  }>(
    `SELECT id, slug, name, liveness_window_sec
       FROM projects
      WHERE id = $1 AND owner_id = $2
      LIMIT 1`,
    [projectId, ownerId],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    livenessWindowSec: Number(r.liveness_window_sec),
  };
}

/** Create a project for this owner. */
export async function createProject(
  ownerId: number,
  slug: string,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  const res = await query<{ id: string; slug: string; name: string }>(
    `INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $3)
     RETURNING id, slug, name`,
    [ownerId, slug, name],
  );
  const r = res.rows[0];
  return { id: Number(r.id), slug: r.slug, name: r.name };
}

/** Create a participant for this owner. */
export async function createParticipant(
  ownerId: number,
  name: string,
  kind: "agent" | "human",
): Promise<{ id: number; name: string; kind: "agent" | "human" }> {
  const res = await query<{ id: string; name: string; kind: "agent" | "human" }>(
    `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
     RETURNING id, name, kind`,
    [ownerId, name, kind],
  );
  const r = res.rows[0];
  return { id: Number(r.id), name: r.name, kind: r.kind };
}

/**
 * Grant a participant access to a project: create the participation and mint a token in one
 * transaction. Both the project and the participant must belong to `ownerId` — proven by the
 * `WHERE ... owner_id = $1` guards inside the INSERT's SELECT, so a cross-owner id yields zero
 * rows and the whole grant aborts. Returns the participation plus the plaintext token, which is
 * shown ONCE and never persisted (only its sha-256 hash is stored).
 */
export async function grant(
  ownerId: number,
  projectId: number,
  participantId: number,
  lane: string | null,
  isAdmin: boolean,
): Promise<GrantResult | null> {
  if (!Number.isFinite(projectId) || !Number.isFinite(participantId)) return null;
  return withTx(async (client) => {
    // Verify both sides are owned, then create the participation — all in one statement so an
    // unowned project or participant simply produces no row (no separate ownership oracle).
    const partRes = await client.query<{
      id: string;
      participant_id: string;
      project_id: string;
      lane: string | null;
      is_admin: boolean;
    }>(
      `INSERT INTO participations (participant_id, project_id, lane, is_admin)
       SELECT pt.id, pr.id, $4, $5
         FROM participants pt, projects pr
        WHERE pt.id = $3 AND pt.owner_id = $1
          AND pr.id = $2 AND pr.owner_id = $1
       RETURNING id, participant_id, project_id, lane, is_admin`,
      [ownerId, projectId, participantId, lane, isAdmin],
    );
    if (partRes.rowCount === 0) return null;
    const p = partRes.rows[0];
    const participationId = Number(p.id);

    const plaintextToken = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, $3)`,
      [participationId, hashToken(plaintextToken), "web-admin grant"],
    );

    return {
      participation: {
        id: participationId,
        participantId: Number(p.participant_id),
        projectId: Number(p.project_id),
        lane: p.lane,
        isAdmin: p.is_admin,
      },
      plaintextToken,
    };
  });
}

/** Participations within a project (owner-scoped via join), with token-active + event counts. */
export async function listParticipations(
  ownerId: number,
  projectId: number,
): Promise<ParticipationRow[]> {
  if (!Number.isFinite(projectId)) return [];
  const res = await query<{
    participation_id: string;
    participant_name: string;
    kind: "agent" | "human";
    lane: string | null;
    is_admin: boolean;
    token_active: boolean;
    event_count: string;
  }>(
    `SELECT pa.id AS participation_id, pt.name AS participant_name, pt.kind,
            pa.lane, pa.is_admin,
            EXISTS (SELECT 1 FROM tokens tk
                     WHERE tk.participation_id = pa.id AND tk.revoked_at IS NULL) AS token_active,
            (SELECT count(*) FROM events e WHERE e.participation_id = pa.id) AS event_count
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN projects pr ON pr.id = pa.project_id
      WHERE pa.project_id = $1 AND pr.owner_id = $2
      ORDER BY pa.created_at ASC, pa.id ASC`,
    [projectId, ownerId],
  );
  return res.rows.map((r) => ({
    participationId: Number(r.participation_id),
    participantName: r.participant_name,
    kind: r.kind,
    lane: r.lane,
    isAdmin: r.is_admin,
    tokenActive: r.token_active,
    eventCount: Number(r.event_count),
  }));
}

/**
 * Revoke every active token for a participation, but only if the participation's project
 * belongs to this owner (proven by the join to projects.owner_id inside the UPDATE). A
 * cross-owner participation id matches no rows and the statement is a no-op. Returns the
 * number of tokens revoked (0 = nothing happened / not owned).
 */
export async function revokeParticipation(
  ownerId: number,
  participationId: number,
): Promise<number> {
  if (!Number.isFinite(participationId)) return 0;
  const res = await query(
    `UPDATE tokens t
        SET revoked_at = now()
       FROM participations pa
       JOIN projects pr ON pr.id = pa.project_id
      WHERE t.participation_id = pa.id
        AND pa.id = $1
        AND pr.owner_id = $2
        AND t.revoked_at IS NULL`,
    [participationId, ownerId],
  );
  return res.rowCount ?? 0;
}

/**
 * Rotate a participation's token: mint a fresh token, THEN revoke the old one(s), in ONE
 * transaction with mint-before-revoke ordering so a valid token exists at every instant (no
 * lockout gap for a live actor). Owner-scoped: a cross-owner / unknown id matches no row and
 * returns null (the handler 404s, no 403 oracle). The new plaintext is shown ONCE; only its hash
 * is stored. Ledger preserved (revoke only sets revoked_at; nothing is deleted).
 */
export async function rotateParticipation(
  ownerId: number,
  participationId: number,
): Promise<GrantResult | null> {
  if (!Number.isFinite(participationId)) return null;
  return withTx(async (client) => {
    // Re-prove ownership and lock the participation row so concurrent rotate/revoke serialize and
    // never leave zero active tokens. A non-owned id yields no row -> abort.
    const sel = await client.query<{
      id: string;
      participant_id: string;
      project_id: string;
      lane: string | null;
      is_admin: boolean;
    }>(
      `SELECT pa.id, pa.participant_id, pa.project_id, pa.lane, pa.is_admin
         FROM participations pa
         JOIN projects pr ON pr.id = pa.project_id
        WHERE pa.id = $1 AND pr.owner_id = $2
        FOR UPDATE OF pa`,
      [participationId, ownerId],
    );
    if (sel.rowCount === 0) return null;
    const p = sel.rows[0];

    // MINT first: a valid token now exists alongside the old one(s).
    const plaintextToken = randomBytes(32).toString("base64url");
    const newHash = hashToken(plaintextToken);
    await client.query(
      `INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, $3)`,
      [participationId, newHash, "web-admin rotate"],
    );
    // THEN revoke every OTHER active token (the token_hash guard never revokes what we just minted).
    await client.query(
      `UPDATE tokens SET revoked_at = now()
        WHERE participation_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
      [participationId, newHash],
    );

    return {
      participation: {
        id: participationId,
        participantId: Number(p.participant_id),
        projectId: Number(p.project_id),
        lane: p.lane,
        isAdmin: p.is_admin,
      },
      plaintextToken,
    };
  });
}

export type MutateResult = "ok" | "conflict" | "notfound";

export interface ParticipantGrantRow {
  projectId: number;
  projectName: string;
  lane: string | null;
  tokenActive: boolean;
}

/** A single participant, but only if owned. Null otherwise (handler 404s — no 403 oracle). */
export async function loadOwnedParticipant(
  ownerId: number,
  participantId: number,
): Promise<{ id: number; name: string; kind: "agent" | "human" } | null> {
  if (!Number.isFinite(participantId)) return null;
  const res = await query<{ id: string; name: string; kind: "agent" | "human" }>(
    `SELECT id, name, kind FROM participants WHERE id = $1 AND owner_id = $2 LIMIT 1`,
    [participantId, ownerId],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return { id: Number(r.id), name: r.name, kind: r.kind };
}

/** The projects a participant is granted into (owner-scoped), with token status — for impact display. */
export async function listParticipantGrants(
  ownerId: number,
  participantId: number,
): Promise<ParticipantGrantRow[]> {
  if (!Number.isFinite(participantId)) return [];
  const res = await query<{
    project_id: string;
    project_name: string;
    lane: string | null;
    token_active: boolean;
  }>(
    `SELECT pr.id AS project_id, pr.name AS project_name, pa.lane,
            EXISTS (SELECT 1 FROM tokens tk WHERE tk.participation_id = pa.id AND tk.revoked_at IS NULL) AS token_active
       FROM participations pa
       JOIN projects pr ON pr.id = pa.project_id
      WHERE pa.participant_id = $1 AND pr.owner_id = $2
      ORDER BY pr.name`,
    [participantId, ownerId],
  );
  return res.rows.map((r) => ({
    projectId: Number(r.project_id),
    projectName: r.project_name,
    lane: r.lane,
    tokenActive: r.token_active,
  }));
}

/** Rename a participant (owner-scoped). "conflict" if the owner already has that name. */
export async function renameParticipant(
  ownerId: number,
  participantId: number,
  name: string,
): Promise<MutateResult> {
  if (!Number.isFinite(participantId)) return "notfound";
  try {
    const res = await query(`UPDATE participants SET name = $3 WHERE id = $1 AND owner_id = $2`, [
      participantId,
      ownerId,
      name,
    ]);
    return (res.rowCount ?? 0) > 0 ? "ok" : "notfound";
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return "conflict"; // UNIQUE(owner_id, name)
    throw e;
  }
}

/**
 * Delete a participant (owner-scoped). Cascades their participations/tokens/presence/cursors;
 * the event/post/task FKs are ON DELETE SET NULL, so ledger rows survive with their recorded
 * actor_name intact (history is never orphaned). Returns true if a row was deleted.
 */
export async function deleteParticipant(ownerId: number, participantId: number): Promise<boolean> {
  if (!Number.isFinite(participantId)) return false;
  const res = await query(`DELETE FROM participants WHERE id = $1 AND owner_id = $2`, [
    participantId,
    ownerId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** Rename a project (name + slug, owner-scoped). "conflict" on a duplicate slug for this owner. */
export async function renameProject(
  ownerId: number,
  projectId: number,
  name: string,
  slug: string,
): Promise<MutateResult> {
  if (!Number.isFinite(projectId)) return "notfound";
  try {
    const res = await query(`UPDATE projects SET name = $3, slug = $4 WHERE id = $1 AND owner_id = $2`, [
      projectId,
      ownerId,
      name,
      slug,
    ]);
    return (res.rowCount ?? 0) > 0 ? "ok" : "notfound";
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return "conflict"; // UNIQUE(owner_id, slug)
    throw e;
  }
}

/** Delete a project and ALL its coordination data (project_id cascades everywhere). Returns true if deleted. */
export async function deleteProject(ownerId: number, projectId: number): Promise<boolean> {
  if (!Number.isFinite(projectId)) return false;
  const res = await query(`DELETE FROM projects WHERE id = $1 AND owner_id = $2`, [projectId, ownerId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Promote/demote a participation's project-admin (lead) flag, owner-scoped (join to projects.owner_id).
 * Takes effect on the participation's NEXT token resolution — the agent reconnects to pick it up.
 * Returns true if a row changed.
 */
export async function setParticipationAdmin(
  ownerId: number,
  participationId: number,
  makeAdmin: boolean,
): Promise<boolean> {
  if (!Number.isFinite(participationId)) return false;
  const res = await query(
    `UPDATE participations pa
        SET is_admin = $3
       FROM projects pr
      WHERE pa.id = $1 AND pa.project_id = pr.id AND pr.owner_id = $2`,
    [participationId, ownerId, makeAdmin],
  );
  return (res.rowCount ?? 0) > 0;
}
