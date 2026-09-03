import { randomBytes } from "node:crypto";
import { query, withTx } from "../db.js";
import { hashToken } from "../auth.js";
import { formatId } from "../domain/claim.js";
import { IS_BLOCKED_SQL, EFFECTIVE_STATUS_SQL } from "../domain/task.js";
import { reachClause, liveTokenClause, projectReadClause } from "../domain/projects.js";

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

/** A foreign project this human belongs to as an invited member (not the owner). Read-only display. */
export interface MemberProjectRow {
  id: number;
  name: string;
  slug: string;
  participantName: string;
  isAdmin: boolean;
}

export interface ParticipationRow {
  participationId: number;
  participantName: string;
  kind: "agent" | "human";
  /** The username of the HUMAN this agent belongs to (decision 052): the per-project bound human
   *  (`participations.human_owner_id`, canonical per decision 038), falling back to the provisioner
   *  (`participants.owner_id`) when unbound. Renders as `<ownerHandle>/<participantName>` so a project with
   *  agents from several humans shows who owns each. Null only if both are absent. */
  ownerHandle: string | null;
  lane: string | null;
  isAdmin: boolean;
  /** A live token on THIS participation. Since decision 070 that is no longer the same question as "can
   *  this agent work here" - see `reachable`. It still gates Revoke/Rotate, which act on this seat's token. */
  tokenActive: boolean;
  /** Whether any live token of this AGENT reaches this seat (decision 070's rule, via `reachClause`).
   *
   *  Before 075 the page rendered `tokenActive ? "active" : "revoked"`, which collapsed three states into
   *  two labels and got two of them wrong: a second-project seat with no token of its own is NORMAL under
   *  070 (it is reached by the agent's token elsewhere) and was shown as "revoked", and a genuinely
   *  unreachable seat was shown identically. So the surface an operator checks to answer "can this agent
   *  work here?" could not distinguish healthy from stranded, and used a word - revoked - describing an
   *  action nobody took. */
  reachable: boolean;
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

/**
 * What a GRANT produces. Distinct from GrantResult (which rotation still uses, and which always mints)
 * because a grant may legitimately produce NO token: decision 070 means one token reaches every project
 * its identity belongs to, so adding an already-connected agent to another project is a share, not a
 * re-issue. Minting anyway would hand the operator a secret to install that nothing needs.
 */
export interface GrantOutcome {
  participation: GrantResult["participation"];
  /** The token to hand over, or NULL when the agent was already connected. */
  plaintextToken: string | null;
  /** True when the grant reused the agent's existing connection instead of minting. */
  alreadyConnected: boolean;
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

/** Foreign projects this human belongs to (invited member), scoped to their own driven participations
 *  and explicitly excluding projects they own. Read-only: powers the account-home "Projects you belong to"
 *  section so a returning invited member is not misrouted to the owner first-run wizard. Isolation
 *  (invariant 3): only rows where this human is the participation's human_owner_id are returned. */
export async function listMemberProjects(ownerId: number): Promise<MemberProjectRow[]> {
  const res = await query<{
    id: string;
    name: string;
    slug: string;
    participant_name: string;
    is_admin: boolean;
  }>(
    `SELECT pr.id, pr.name, pr.slug, pt.name AS participant_name, pa.is_admin
       FROM participations pa
       JOIN projects pr ON pr.id = pa.project_id
       JOIN participants pt ON pt.id = pa.participant_id
      WHERE pa.human_owner_id = $1 AND pr.owner_id <> $1
      ORDER BY pr.name, pt.name`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    participantName: r.participant_name,
    isAdmin: r.is_admin,
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
    // request_mode is no longer selected: request-to-join was retired (decision 038); the column is
    // retained dormant but no surface reads it.
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

/**
 * The project row for a READ by someone who administers it without owning it: the owner, or a
 * `project_members` row with role 'admin' (decision 078, OI-37).
 *
 * A SEPARATE function from `loadOwnedProject`, never a widening of it, because that one gates this project's
 * MUTATIONS as well as its pages - granting an agent, revoking a participation, writing settings. Widening
 * it in place would hand a project admin the power to mint and revoke credentials as a side effect of a
 * visibility ruling, which is the coupling decision 077 was about. Every POST stays on `loadOwnedProject`;
 * only GETs may use this, and every loader behind those GETs carries the SAME `projectReadClause` - the
 * first attempt gated the route and left the loaders owner-only, which rendered the pages blank.
 */
export async function loadProjectForAdminRead(
  ownerId: number,
  projectId: number,
): Promise<{ id: number; slug: string; name: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const res = await query<{ id: string; slug: string; name: string }>(
    `SELECT pr.id, pr.slug, pr.name FROM projects pr
      WHERE pr.id = $1 AND ${projectReadClause("$2")}
      LIMIT 1`,
    [projectId, ownerId],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return { id: Number(r.id), slug: r.slug, name: r.name };
}


/**
 * Load a project the caller OWNS or is a MEMBER of (decision 039), for the task-authoring pages a plain
 * member must reach (loadOwnedProject is owner-only). Same membership predicate as the write layer; a
 * non-member yields null so the handler 404s (no 403 oracle, invariant 3).
 */
export async function loadProjectForMember(
  ownerId: number,
  projectId: number,
): Promise<{ id: number; slug: string; name: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const res = await query<{ id: string; slug: string; name: string }>(
    `SELECT pr.id, pr.slug, pr.name
       FROM projects pr
       LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $2
      WHERE pr.id = $1 AND (pr.owner_id = $2 OR pm.role IN ('admin', 'member'))
      LIMIT 1`,
    [projectId, ownerId],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return { id: Number(r.id), slug: r.slug, name: r.name };
}

/** Create a project for this owner. */
export async function createProject(
  ownerId: number,
  slug: string,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  // The creator is a member with role 'owner' (decision 037). Both inserts run in ONE statement via a
  // data-modifying CTE, so they are atomic without a transaction wrapper - a project is never left without
  // its owner membership row.
  const res = await query<{ id: string; slug: string; name: string }>(
    `WITH new_project AS (
       INSERT INTO projects (owner_id, slug, name) VALUES ($1, $2, $3)
       RETURNING id, slug, name, owner_id
     ), owner_member AS (
       INSERT INTO project_members (project_id, owner_id, role)
       SELECT id, owner_id, 'owner' FROM new_project
       ON CONFLICT (project_id, owner_id) DO NOTHING
     )
     SELECT id, slug, name FROM new_project`,
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
 * rows and the whole grant aborts.
 *
 * A token is minted ONLY for an agent that has none yet (decision 070). An agent that is already connected
 * reaches this new project on the token it already holds, so the result carries `alreadyConnected` and a
 * null token rather than a secret nobody has to install. A minted token is shown ONCE and never persisted
 * (only its sha-256 hash is stored).
 */
export async function grant(
  ownerId: number,
  projectId: number,
  participantId: number,
  lane: string | null,
  isAdmin: boolean,
): Promise<GrantOutcome | null> {
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
      // human_owner_id = the granting owner: for their own projects, the owner is the human driving
      // the participation, so an OAuth reconnect can enumerate it (decision 024). AS-only read (inv 3).
      `INSERT INTO participations (participant_id, project_id, lane, is_admin, human_owner_id)
       SELECT pt.id, pr.id, $4, $5, $1
         FROM participants pt, projects pr
        WHERE pt.id = $3 AND pt.owner_id = $1
          AND pr.id = $2 AND pr.owner_id = $1
       RETURNING id, participant_id, project_id, lane, is_admin`,
      [ownerId, projectId, participantId, lane, isAdmin],
    );
    if (partRes.rowCount === 0) return null;
    const p = partRes.rows[0];
    const participationId = Number(p.id);

    // Decision 070: a token reaches every project its identity is a member of, so an agent that is ALREADY
    // connected needs nothing installed to work here - the membership row above is the entire grant. Only
    // mint when the agent has no live token that can actually REACH this new seat.
    //
    // "Can reach" is the load-bearing part, and it is why this asks projects.ts rather than matching on
    // participant_id. Matching participant_id alone is what this used to do, under a comment claiming it was
    // the same scope as the reach rule; it silently dropped the driver guard. So granting a project to an
    // already-connected agent whose existing seat is UNBOUND created a new seat bound to the granting human,
    // skipped the token because "it already has one", and produced a membership its own token is refused
    // from - with the admin card telling the operator the opposite. Found when the operator added this rig
    // to a project and list_projects still showed one; four such seats existed on prod, three holding live
    // tokens that could not reach their own membership.
    //
    // Scoped to THIS participant on the token side deliberately: another agent's token being bound to the
    // same human does reach the new seat, but that says nothing about whether THIS agent can work here.
    const live = await client.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM tokens t
         JOIN participations tp ON tp.id = t.participation_id
         JOIN participations np ON np.id = $2
        WHERE tp.participant_id = $1
          AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > now())
          AND ${reachClause("tp.participant_id", "tp.human_owner_id", "np")}`,
      [Number(p.participant_id), participationId],
    );
    const alreadyConnected = Number(live.rows[0].n) > 0;

    let plaintextToken: string | null = null;
    if (!alreadyConnected) {
      plaintextToken = randomBytes(32).toString("base64url");
      await client.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, $3)`, [
        participationId,
        hashToken(plaintextToken),
        "web-admin grant",
      ]);
    }

    return {
      participation: {
        id: participationId,
        participantId: Number(p.participant_id),
        projectId: Number(p.project_id),
        lane: p.lane,
        isAdmin: p.is_admin,
      },
      plaintextToken,
      alreadyConnected,
    };
  });
}

/** The presence-derived connection status for the flips-green connect indicator (decision 028). */
export interface ConnectionStatus {
  seen: boolean;
  seen_at: string | null;
  actor: string;
}

/**
 * Owner-scoped connection status for a single participation (decision 028). Re-proves the participation
 * belongs to the session owner - either they drive it (human_owner_id) or they own its project - in the
 * SAME statement, so a non-owned or unknown id yields no row and the caller 404s identically to any
 * unmatched route (no 403 oracle, invariant 3). Reads only presence.last_seen; NEVER touches or returns a
 * token. `seen` is a positive edge: null last_seen means "not yet", never "offline" (invariant 5). The
 * actor prefers the BOUND human (participations.human_owner_id, canonical per 038/052) over the provisioner
 * (participants.owner_id), then the bare label - the same COALESCE the access page (listParticipations) and
 * domain presence (whoIsActive) use, so all "who belongs to whom" surfaces agree.
 */
export async function connectionStatus(
  ownerId: number,
  participationId: number,
): Promise<ConnectionStatus | null> {
  if (!Number.isFinite(participationId)) return null;
  const res = await query<{ actor: string; last_seen: Date | null }>(
    `SELECT COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor, pres.last_seen
       FROM participations pn
       JOIN projects prj ON prj.id = pn.project_id
       JOIN participants pt ON pt.id = pn.participant_id
       JOIN owners o ON o.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pn.human_owner_id
       LEFT JOIN presence pres ON pres.participation_id = pn.id
      WHERE pn.id = $1 AND (pn.human_owner_id = $2 OR prj.owner_id = $2)`,
    [participationId, ownerId],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  const seenAt = r.last_seen ? new Date(r.last_seen).toISOString() : null;
  return { seen: seenAt !== null, seen_at: seenAt, actor: r.actor };
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
    owner_handle: string | null;
    lane: string | null;
    is_admin: boolean;
    token_active: boolean;
    reachable: boolean;
    event_count: string;
  }>(
    // owner_handle = the human the agent belongs to (decision 052): prefer the per-project bound human
    // (participations.human_owner_id, canonical per 038), fall back to the provisioner (participants.owner_id).
    `SELECT pa.id AS participation_id, pt.name AS participant_name, pt.kind,
            COALESCE(ho.username, po.username) AS owner_handle,
            pa.lane, pa.is_admin,
            EXISTS (SELECT 1 FROM tokens tk
                     WHERE tk.participation_id = pa.id AND ${liveTokenClause("tk")}) AS token_active,
            EXISTS (SELECT 1 FROM tokens tk2
                      JOIN participations tp ON tp.id = tk2.participation_id
                     WHERE tp.participant_id = pa.participant_id
                       AND tk2.revoked_at IS NULL
                       AND (tk2.expires_at IS NULL OR tk2.expires_at > now())
                       AND ${reachClause("tp.participant_id", "tp.human_owner_id", "pa")}) AS reachable,
            (SELECT count(*) FROM events e WHERE e.participation_id = pa.id) AS event_count
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN projects pr ON pr.id = pa.project_id
       LEFT JOIN owners po ON po.id = pt.owner_id
       LEFT JOIN owners ho ON ho.id = pa.human_owner_id
      WHERE pa.project_id = $1 AND ${projectReadClause("$2")}
      ORDER BY pa.created_at ASC, pa.id ASC`,
    [projectId, ownerId],
  );
  return res.rows.map((r) => ({
    participationId: Number(r.participation_id),
    participantName: r.participant_name,
    kind: r.kind,
    ownerHandle: r.owner_handle ?? null,
    lane: r.lane,
    isAdmin: r.is_admin,
    tokenActive: r.token_active,
    reachable: r.reachable,
    eventCount: Number(r.event_count),
  }));
}

/**
 * Revoke every active token for a participation, but only if the participation's project
 * belongs to this owner (proven by the join to projects.owner_id inside the UPDATE). A
 * cross-owner participation id matches no rows and the statement is a no-op. Also revokes any
 * OAuth refresh tokens for the participation in the same transaction, so revoking a connection
 * actually kills it - otherwise a live 30-day refresh token could mint fresh access tokens after
 * revoke (decision 024). Returns the number of access tokens revoked (0 = nothing / not owned).
 */
export async function revokeParticipation(
  ownerId: number,
  participationId: number,
): Promise<number> {
  if (!Number.isFinite(participationId)) return 0;
  return withTx(async (client) => {
    const res = await client.query(
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
    // Kill OAuth refresh tokens too (owner-scoped), so the connection cannot be re-minted.
    await client.query(
      `UPDATE oauth_refresh_tokens rt
          SET revoked_at = now()
         FROM participations pa
         JOIN projects pr ON pr.id = pa.project_id
        WHERE rt.participation_id = pa.id
          AND pa.id = $1
          AND pr.owner_id = $2
          AND rt.revoked_at IS NULL`,
      [participationId, ownerId],
    );
    return res.rowCount ?? 0;
  });
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
    // Rotation invalidates the OAuth connection too: revoke its refresh tokens so it cannot re-mint
    // an access token behind the rotation (decision 024). Ownership already proven by the SELECT above.
    await client.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = now()
        WHERE participation_id = $1 AND revoked_at IS NULL`,
      [participationId],
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
  /** Reached by a live token this agent holds ELSEWHERE (decision 070/075) - the "connected" state. */
  reachable: boolean;
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

/**
 * Who this agent's open work could be handed to on deletion (decision 069): the owner's OTHER agents.
 * Owner-scoped, so the dropdown can never offer another tenant's agent; the write re-checks anyway.
 */
export async function listReassignCandidates(
  ownerId: number,
  excludeParticipantId: number,
): Promise<{ id: number; name: string }[]> {
  if (!Number.isFinite(excludeParticipantId)) return [];
  const res = await query<{ id: string; name: string }>(
    `SELECT id, name FROM participants
      WHERE owner_id = $1 AND id <> $2 AND kind = 'agent'
      ORDER BY name`,
    [ownerId, excludeParticipantId],
  );
  return res.rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/** How many unfinished tasks this agent is holding - shown so the hand-over choice is an informed one. */
export async function countOpenTasksForParticipant(ownerId: number, participantId: number): Promise<number> {
  if (!Number.isFinite(participantId)) return 0;
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM tasks t
       JOIN participations pa ON pa.id = t.owner_participation_id
       JOIN participants pt ON pt.id = pa.participant_id
      WHERE pt.id = $2 AND pt.owner_id = $1 AND t.status NOT IN ('done','cancelled')`,
    [ownerId, participantId],
  );
  return Number(res.rows[0].n);
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
    reachable: boolean;
  }>(
    `SELECT pr.id AS project_id, pr.name AS project_name, pa.lane,
            EXISTS (SELECT 1 FROM tokens tk WHERE tk.participation_id = pa.id AND ${liveTokenClause("tk")}) AS token_active,
            EXISTS (SELECT 1 FROM tokens tk2
                      JOIN participations tp ON tp.id = tk2.participation_id
                     WHERE tp.participant_id = pa.participant_id
                       AND ${liveTokenClause("tk2")}
                       AND ${reachClause("tp.participant_id", "tp.human_owner_id", "pa")}) AS reachable
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
    reachable: r.reachable,
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
    return await withTx(async (client) => {
      const res = await client.query(`UPDATE participants SET name = $3 WHERE id = $1 AND owner_id = $2`, [
        participantId,
        ownerId,
        name,
      ]);
      if ((res.rowCount ?? 0) === 0) return "notfound";
      // Refresh the DISPLAY SNAPSHOT on this agent's tasks. Assignment itself routes on
      // owner_participation_id (a real FK) and survives a rename untouched - but tasks.owner_name is a
      // stored string, and nothing used to update it. So a renamed agent kept working while every board,
      // list and digest showed its OLD name: the routing surface and the reading surface disagreeing,
      // which is the failure class 064/065 were both instances of. Same COALESCE as listRoster/whoIsActive
      // so the refreshed value matches what every other "who" surface renders.
      await client.query(
        `UPDATE tasks t
            SET owner_name = COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name)
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
           JOIN owners o ON o.id = pt.owner_id
           LEFT JOIN owners ho ON ho.id = pa.human_owner_id
          WHERE t.owner_participation_id = pa.id AND pt.id = $1`,
        [participantId],
      );
      return "ok";
    });
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
export async function deleteParticipant(
  ownerId: number,
  participantId: number,
  /** Hand this agent's open work to another participant of the SAME owner instead of dropping it back into
   *  the grabbable pool (decision 069). Ignored if it is not owned, is the agent being deleted, or has no
   *  participation in the project a given task belongs to - in each case that task falls back to unassigned,
   *  which is the safe direction: work returns to the pool rather than landing somewhere nobody polls. */
  reassignToParticipantId?: number | null,
): Promise<boolean> {
  if (!Number.isFinite(participantId)) return false;
  return withTx(async (client) => {
    // Owner-leave (decision 039): before the participant's participations are deleted (which SET NULL the
    // tasks.owner_participation_id FK and would otherwise orphan an in-flight task under a null owner), flip
    // this participant's non-terminal tasks back to `todo`, unassigned, so they re-enter the grabbable pool.
    // NEVER cancelled - the work still needs doing. Scoped via the participant's participations; the owner
    // check on the DELETE below is the isolation boundary (a non-owned participant deletes 0 rows).
    const owns = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM participants WHERE id = $1 AND owner_id = $2`,
      [participantId, ownerId],
    );
    if (Number(owns.rows[0].n) === 0) return false;

    // Reassign FIRST, per task, to the successor's participation in that task's OWN project - a
    // participation is project-scoped, so a successor who is not in that project cannot receive its work.
    // Owner-scoped and self-exclusive, so a crafted id cannot hand work to another tenant or to the agent
    // being removed. Anything not matched here falls through to the unassign below.
    const successor = Number.isFinite(reassignToParticipantId as number) ? Number(reassignToParticipantId) : null;
    if (successor !== null && successor !== participantId) {
      await client.query(
        `UPDATE tasks t
            SET owner_participation_id = succ.id,
                owner_name = COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name),
                updated_at = now()
           FROM participations succ
           JOIN participants pt ON pt.id = succ.participant_id AND pt.owner_id = $2
           JOIN owners o ON o.id = pt.owner_id
           LEFT JOIN owners ho ON ho.id = succ.human_owner_id
          WHERE succ.participant_id = $3
            AND succ.project_id = t.project_id
            AND t.owner_participation_id IN (SELECT id FROM participations WHERE participant_id = $1)
            AND t.status NOT IN ('done', 'cancelled')`,
        [participantId, ownerId, successor],
      );
    }

    await client.query(
      // Also clear owner_name so the now-unassigned task does not still display the departed agent as its
      // assignee on the board (the id columns drive nudges/mine/open_unassigned; owner_name is display-only).
      `UPDATE tasks SET status = 'todo', owner_participation_id = NULL, owner_name = NULL, updated_at = now()
        WHERE owner_participation_id IN (SELECT id FROM participations WHERE participant_id = $1)
          AND status NOT IN ('done', 'cancelled')`,
      [participantId],
    );
    const res = await client.query(`DELETE FROM participants WHERE id = $1 AND owner_id = $2`, [
      participantId,
      ownerId,
    ]);
    return (res.rowCount ?? 0) > 0;
  });
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

// ── Project activity (read-only observability) ──────────────────────────────
// A window into the coordination the agents are actually doing, so the human can SEE the product work
// instead of trusting it. Every query is owner-scoped via a join to projects.owner_id (a non-owned
// project id yields empty lists - no cross-tenant leak). Read-only; never mutates.

export interface ActivityEvent {
  id: number;
  ts: string;
  actor: string;
  type: string;
  summary: string;
}
export interface ActiveLease {
  surface: string;
  actor: string;
  expiresAt: string;
}
export interface SequenceState {
  name: string;
  latest: string;
}
export interface ActiveAgent {
  actor: string;
  lane: string;
  status: string;
  lastSeen: string;
}
export interface ProjectActivity {
  events: ActivityEvent[];
  leases: ActiveLease[];
  sequences: SequenceState[];
  agents: ActiveAgent[];
}

/** Turn a raw event (type + payload) into one plain-language line: "claimed adr 12", "leased src/x.ts",
 *  "handoff to marketing". Defensive: unknown shapes fall back to the bare verb. Exported so the daily
 *  digest email (src/notify) renders events with the exact same wording the Board uses (decision 025). */
export function summarizeEvent(type: string, p: Record<string, unknown>): string {
  const s = (k: string): string => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : "");
  switch (type) {
    case "claim":
      return `claimed ${s("sequence")} ${s("formatted") || s("number")}`.trim();
    case "seed":
      return `set up the ${s("sequence")} sequence`.trim();
    case "register":
      return `checked in${s("lane") ? ` on ${s("lane")}` : ""}${s("status") ? ` - ${s("status")}` : ""}`;
    case "post":
      return `handoff${s("to_lane") ? ` to ${s("to_lane")}` : s("to_actor") ? ` to ${s("to_actor")}` : ""}${s("ref") ? ` (${s("ref")})` : ""}`;
    case "ack":
      return "acknowledged a handoff";
    case "lease":
      return `leased ${s("surface")}`.trim();
    case "release":
      return `released ${s("surface")}`.trim();
    case "task_create":
      return `created a task${s("title") ? `: ${s("title")}` : ""}`;
    case "task_assign":
      return `assigned a task${s("to_actor") ? ` to ${s("to_actor")}` : ""}`;
    case "task_start":
      return "started a task";
    case "task_stop":
      return "put a task back to todo";
    case "task_block":
      return "flagged a task blocked";
    case "task_resolve":
      return "resolved a task";
    case "task_ship":
      return "shipped a task";
    case "task_answer":
      return `answered a decision${s("option") ? `: ${s("option")}` : ""}`;
    case "task_cancel":
      return "cancelled a task";
    case "task_reopen":
      return "reopened a task";
    case "task_edit":
      return "edited a task";
    case "task_depend":
      return "added a task dependency";
    case "task_undepend":
      return "removed a task dependency";
    default:
      return type;
  }
}

/** All four activity views for a project, owner-scoped. Returns empty lists if the project isn't owned. */
export async function loadProjectActivity(
  ownerId: number,
  projectId: number,
  limit = 20,
): Promise<ProjectActivity> {
  if (!Number.isFinite(projectId)) return { events: [], leases: [], sequences: [], agents: [] };
  const [ev, le, sq, ag] = await Promise.all([
    query<{ id: string; ts: string; actor_name: string; type: string; payload: Record<string, unknown> }>(
      `SELECT e.id, e.ts, e.actor_name, e.type, e.payload
         FROM events e JOIN projects pr ON pr.id = e.project_id
        WHERE e.project_id = $1 AND ${projectReadClause("$2")}
        ORDER BY e.id DESC LIMIT $3`,
      [projectId, ownerId, limit],
    ),
    query<{ surface: string; actor_name: string; expires_at: string }>(
      `SELECT l.surface, l.actor_name, l.expires_at
         FROM leases l JOIN projects pr ON pr.id = l.project_id
        WHERE l.project_id = $1 AND ${projectReadClause("$2")} AND l.released_at IS NULL AND l.expires_at > now()
        ORDER BY l.expires_at ASC`,
      [projectId, ownerId],
    ),
    query<{ name: string; prefix: string; pad: number; current: string }>(
      `SELECT s.name, s.prefix, s.pad, s.current
         FROM sequences s JOIN projects pr ON pr.id = s.project_id
        WHERE s.project_id = $1 AND pr.owner_id = $2 AND s.current > 0
        ORDER BY s.name`,
      [projectId, ownerId],
    ),
    query<{ actor: string; lane: string; status: string; last_seen: string }>(
      `SELECT pt.name AS actor,
              -- the RESOLVED lane (live, else provisioned - decision 065), so the operator's activity chip
              -- agrees with delivery and with list_participants instead of showing '(unset)'.
              COALESCE(NULLIF(p.lane, '(unset)'), pa.lane) AS lane, p.status, p.last_seen
         FROM presence p
         JOIN participations pa ON pa.id = p.participation_id
         JOIN participants pt ON pt.id = pa.participant_id
         JOIN projects pr ON pr.id = p.project_id
        WHERE p.project_id = $1 AND pr.owner_id = $2
          AND p.last_seen > now() - make_interval(secs => pr.liveness_window_sec)
        ORDER BY p.last_seen DESC`,
      [projectId, ownerId],
    ),
  ]);
  return {
    events: ev.rows.map((r) => ({
      id: Number(r.id),
      ts: new Date(r.ts).toISOString(),
      actor: r.actor_name,
      type: r.type,
      summary: summarizeEvent(r.type, r.payload || {}),
    })),
    leases: le.rows.map((r) => ({
      surface: r.surface,
      actor: r.actor_name,
      expiresAt: new Date(r.expires_at).toISOString(),
    })),
    sequences: sq.rows.map((r) => ({ name: r.name, latest: formatId(r.prefix, Number(r.pad), Number(r.current)) })),
    agents: ag.rows.map((r) => ({
      actor: r.actor,
      lane: r.lane,
      status: r.status,
      lastSeen: new Date(r.last_seen).toISOString(),
    })),
  };
}

export interface TaskCard {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  lane: string | null;
  blockers: number;
}

export interface DecisionClaim {
  sequence: string;
  formatted: string;
  number: number;
  actor: string;
  note: string | null;
  ts: string;
}

export interface ProjectBoard {
  tasks: TaskCard[];
  decisions: DecisionClaim[];
}

/**
 * The read-only project Board for someone who may READ this project - its owner, or an `admin` member
 * (decision 078): every task (for grouping by status, with its assignee) and the decision record (the
 * `claim` events). BOTH queries carry `projectReadClause`, and they must stay in step: widening one and not
 * the other renders half a page, which is how the first attempt at OI-37 shipped blank pages. A project the
 * caller may not read yields empty lists - never a cross-tenant leak (invariant 3). Assignee
 * reads `tasks.owner_name` (the preserved display string), so a task whose assignee was later deleted
 * still shows its historical owner (invariant 6). Pure read; no schema of its own - tasks/blockers/events
 * already exist.
 */
export async function loadProjectBoard(
  ownerId: number,
  projectId: number,
  taskLimit = 200,
  decisionLimit = 50,
): Promise<ProjectBoard> {
  if (!Number.isFinite(projectId)) return { tasks: [], decisions: [] };
  const [tk, dc] = await Promise.all([
    // The read-only Board (decision 039): tasks grouped by their EFFECTIVE status (blocked derived). The
    // human DRIVES tasks from /admin/tasks (the authoring surface); this per-project Board stays read-only.
    query<{
      id: string;
      title: string;
      status: string;
      assignee: string | null;
      lane: string | null;
      blockers: string;
    }>(
      `SELECT t.id, t.title, (${EFFECTIVE_STATUS_SQL}) AS status, t.owner_name AS assignee, t.lane,
              count(b.task_id)::text AS blockers
         FROM tasks t
         JOIN projects pr ON pr.id = t.project_id
         LEFT JOIN task_blockers b ON b.task_id = t.id AND b.resolved_at IS NULL
        WHERE t.project_id = $1 AND ${projectReadClause("$2")}
        GROUP BY t.id
        ORDER BY t.id DESC
        LIMIT $3`,
      [projectId, ownerId, taskLimit],
    ),
    query<{ sequence: string | null; formatted: string | null; number: string | null; note: string | null; actor_name: string; ts: string }>(
      `SELECT e.payload->>'sequence' AS sequence,
              e.payload->>'formatted' AS formatted,
              e.payload->>'number'    AS number,
              e.payload->>'note'      AS note,
              e.actor_name, e.ts
         FROM events e
         JOIN projects pr ON pr.id = e.project_id
        WHERE e.project_id = $1 AND ${projectReadClause("$2")} AND e.type = 'claim'
        ORDER BY e.id DESC
        LIMIT $3`,
      [projectId, ownerId, decisionLimit],
    ),
  ]);
  return {
    tasks: tk.rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      status: r.status,
      assignee: r.assignee,
      lane: r.lane,
      blockers: Number(r.blockers),
    })),
    decisions: dc.rows.map((r) => ({
      sequence: r.sequence ?? "",
      formatted: r.formatted || String(r.number ?? ""),
      number: Number(r.number ?? 0),
      actor: r.actor_name,
      note: r.note,
      ts: new Date(r.ts).toISOString(),
    })),
  };
}

export interface OwnerBoardTask {
  taskId: number;
  title: string;
  detail: string | null;
  lane: string | null;
  status: string; // effective status (blocked derived)
  assignee: string | null; // owner_name display snapshot (invariant 6: survives assignee deletion)
  mine: boolean; // assigned to THIS session owner as the human assignee
  /** An OPEN block on this task names THIS session owner as the human who has to lift it (decision 074,
   *  ruling 2026-08-30-1). Distinct from `mine`: the task is somebody else's work, and this person is the
   *  one thing standing in front of it - conflating the two would put another team's task in a
   *  filter that means "assigned to me". */
  waitingOnMe: boolean;
  blockers: number;
  // The OPEN blockers themselves, not just how many (decision 073). A count answers "is it blocked" and
  // leaves the human asking the only question they actually have - BY WHAT. `blockedOnTaskId` null means a
  // manual block: nothing will lift it automatically, which the page has to say out loud.
  // DETAIL LOADER ONLY (like createdByPid): the list board renders a count, not the reasons.
  blockerRows?: {
    reason: string | null;
    blockedOnTaskId: number | null;
    blockedOnTitle: string | null;
    blockedOnStatus: string | null;
    blockedOnProjectId: number | null;
    /** Decision 074, manual blocks only. Null on a dependency (it clears itself) and on any manual block
     *  recorded before 074 - the renderer distinguishes those two cases rather than showing one blank. */
    unblockCondition: string | null;
    unblockOwner: string | null;
    createdAt: string;
  }[];
  options: string[] | null;
  selectedOption: string | null;
  answerNote: string | null;
  links: { label: string; url: string }[] | null;
  projectId: number;
  projectName: string;
  projectSlug: string;
  // The agent that ASKED (created the task). createdByPid (detail loader only, null on the list board) defaults
  // the Reassign picker on the detail page (decision 047; was the hand-off picker, 042). createdByName is
  // populated on BOTH the list (the "from" in the glance line, decision 046) and the detail.
  createdByPid: number | null;
  createdByName: string | null;
  // True size of this row's effective-status group BEFORE the archive cap (decision 062), so a capped
  // Done/Cancelled column can report its real depth instead of the number of rows that happened to load.
  // Optional: only the board list computes it; a caller without it falls back to the rows it holds, which is
  // the honest count for a single-task load and for a hand-built fixture.
  groupTotal?: number;
}

/** Archive depth fetched per terminal column (decision 062). The board renders 8 by default and lifts the
 *  cap on ?alldone=1, so the default fetch only has to out-run that; the lifted one is a safety bound, not a
 *  display budget. ACTIONABLE rows are NEVER bounded - that is the whole point of the two budgets. */
const BOARD_ARCHIVE_CAP = 60;
const BOARD_ARCHIVE_CAP_ALLDONE = 1000;

/**
 * The cross-project, MEMBERSHIP-scoped task board (decision 039) - the /admin/tasks read. It carries the
 * decision-037 predicate onto the v2 task surface (the same one the retired review board used): a project
 * OWNER or an ADMIN member sees EVERY task in the project (supervisor); a plain MEMBER
 * sees ONLY tasks assigned to THEM (`assignee_owner_id = owner`); a non-member sees nothing (invariant 3).
 * Optional projectId narrows to one project. `blocked` is derived via EFFECTIVE_STATUS_SQL; `mine` flags a
 * task assigned to the caller so the UI can gate which controls it renders (the WRITE re-proves regardless).
 * Pure read; every value is escaped on render (invariant 4).
 *
 * TWO BUDGETS, NOT ONE (decision 062). This read used to be a single `ORDER BY pr.id, t.id DESC LIMIT 300`
 * over EVERY status. Terminal rows are the fast-growing majority, so the archive ate the budget and the
 * project-id ordering starved the newest projects FIRST: measured on prod 2026-08-19, 194 of 494 rows never
 * reached the renderer and SIX entire projects were invisible, including 47 open tasks and a decision task
 * the operator had been asked to answer. tasksPage re-sorts every group itself, so that ORDER BY was never a
 * display order - it was only ever deciding what to throw away, by a rule unrelated to importance.
 * So: ACTIONABLE rows (todo/in_progress/blocked, and any dormant legacy status) are returned in FULL, with no
 * cap of any kind - the plate cannot be truncated by construction, not merely by a limit chosen to be big
 * enough. Only the terminal archive is bounded, newest-first within its own column, and `groupTotal` carries
 * the true pre-cap depth so the UI never reports a number it silently trimmed.
 */
export async function listTasksForOwnerBoard(
  ownerId: number,
  filter: { projectId?: number; allDone?: boolean } = {},
): Promise<OwnerBoardTask[]> {
  const projectId = filter.projectId != null && Number.isFinite(filter.projectId) ? filter.projectId : null;
  const archiveCap = filter.allDone ? BOARD_ARCHIVE_CAP_ALLDONE : BOARD_ARCHIVE_CAP;
  const res = await query<{
    id: string;
    title: string;
    detail: string | null;
    lane: string | null;
    status: string;
    assignee: string | null;
    mine: boolean;
    blockers: string;
    options: string[] | null;
    selected_option: string | null;
    answer_note: string | null;
    links: { label: string; url: string }[] | null;
    project_id: string;
    project_name: string;
    slug: string;
    created_by_name: string | null;
    waiting_on_me: boolean;
    group_total: string;
  }>(
    // Two phases on purpose. `scoped` carries the membership predicate and NOTHING else - id + effective
    // status - so deciding what to keep is cheap even when the archive is enormous (EFFECTIVE_STATUS_SQL's
    // EXISTS probes are already gated on an actionable base status, so terminal rows short-circuit). The
    // per-row projections that actually cost something (the blocker count, the created_by COALESCE over
    // participations/owners) run ONLY over rows that survived the cap, joined back by primary key. Removing
    // the old flat LIMIT would otherwise have paid those subqueries across the whole archive to throw most of
    // the results away. The predicate itself is unchanged, and the final join reaches only ids it already
    // approved, so invariant 3 is where it always was.
    `WITH scoped AS (
       SELECT t.id, (${EFFECTIVE_STATUS_SQL}) AS status
         FROM tasks t
         JOIN projects pr ON pr.id = t.project_id
         LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $1
        WHERE (
                pr.owner_id = $1
                -- Decision 078 (ruling 2026-08-30-3): membership means SEEING the project. A member could
                -- already open the project, read its roster and CREATE tasks in it while this predicate hid
                -- every task but their own, so they could add a task to a board they could not read. The
                -- WRITE path is deliberately not widened with it (task-writes.ts): read the project, act on
                -- your own.
                OR pm.role IN ('admin', 'member')
              )
          AND ($2::bigint IS NULL OR t.project_id = $2)
     ),
     kept AS (
       -- Rank ONLY within a terminal column; every actionable row gets 0, which is <= any cap, so the plate
       -- passes through whole no matter how deep the archive is. count(*) OVER the same partition is the true
       -- column depth (windows are evaluated before the cap is applied), carried on the row so the header
       -- never has to infer a total from the rows that happened to survive.
       SELECT id, status, group_total FROM (
         SELECT s.id, s.status,
                CASE WHEN s.status IN ('done','cancelled')
                     THEN row_number() OVER (PARTITION BY s.status ORDER BY s.id DESC)
                     ELSE 0 END AS trank,
                count(*) OVER (PARTITION BY s.status)::text AS group_total
           FROM scoped s
       ) r
        WHERE r.trank <= $3::bigint
     )
     SELECT t.id, t.title, t.detail, t.lane, k.status,
            t.owner_name AS assignee, (t.assignee_owner_id = $1) AS mine,
            (SELECT count(*) FROM task_blockers b WHERE b.task_id = t.id AND b.resolved_at IS NULL)::text AS blockers,
            -- Rides the partial index 074 already created for exactly this question
            -- (idx_blockers_waiting_human), and is gated on the same resolved_at IS NULL the count above uses.
            EXISTS (SELECT 1 FROM task_blockers wb
                     WHERE wb.task_id = t.id AND wb.resolved_at IS NULL AND wb.unblock_owner_id = $1) AS waiting_on_me,
            t.options, t.selected_option, t.answer_note, t.links,
            pr.id AS project_id, pr.name AS project_name, pr.slug,
            COALESCE(
              (SELECT COALESCE(COALESCE(ho2.username, o2.username) || '/' || pt2.name, pt2.name)
                 FROM participations pa2 JOIN participants pt2 ON pt2.id = pa2.participant_id
                 LEFT JOIN owners o2 ON o2.id = pt2.owner_id
                 LEFT JOIN owners ho2 ON ho2.id = pa2.human_owner_id
                WHERE pa2.id = t.created_by_id),
              (SELECT username FROM owners WHERE id = t.created_by_owner_id)
            ) AS created_by_name,
            k.group_total
       FROM kept k
       JOIN tasks t ON t.id = k.id
       JOIN projects pr ON pr.id = t.project_id
      ORDER BY pr.id, t.id DESC`,
    [ownerId, projectId, archiveCap],
  );
  return res.rows.map((r) => ({
    taskId: Number(r.id),
    title: r.title,
    detail: r.detail,
    lane: r.lane,
    status: r.status,
    assignee: r.assignee,
    mine: r.mine === true,
    waitingOnMe: r.waiting_on_me === true,
    blockers: Number(r.blockers),
    options: r.options,
    selectedOption: r.selected_option,
    answerNote: r.answer_note,
    links: r.links,
    projectId: Number(r.project_id),
    projectName: r.project_name,
    projectSlug: r.slug,
    createdByPid: null, // the hand-off default picker is detail-only; the list needs only the display name
    createdByName: r.created_by_name, // the "from" (requester) shown in the row glance line (decision 046)
    groupTotal: Number(r.group_total), // pre-cap depth of this row's status column (decision 062)
  }));
}

/**
 * ONE task on the membership-scoped board (decision 041, the task detail page). Same decision-037 predicate
 * as listTasksForOwnerBoard - an owner/admin sees any task in the project, a plain member only a task assigned
 * to them, a non-member nothing - so a refused/foreign/non-existent id all return null and the handler 404s
 * with no 403 oracle (invariant 3). The WRITE layer re-proves regardless. Non-finite ids return null.
 */
export async function loadOwnerBoardTask(
  ownerId: number,
  projectId: number,
  taskId: number,
): Promise<OwnerBoardTask | null> {
  if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) return null;
  const res = await query<{
    id: string;
    title: string;
    detail: string | null;
    lane: string | null;
    status: string;
    assignee: string | null;
    mine: boolean;
    blockers: string;
    options: string[] | null;
    selected_option: string | null;
    answer_note: string | null;
    links: { label: string; url: string }[] | null;
    project_id: string;
    project_name: string;
    slug: string;
    created_by_pid: string | null;
    created_by_name: string | null;
    waiting_on_me: boolean;
    blocker_rows: {
      reason: string | null;
      blockedOnTaskId: number | null;
      blockedOnTitle: string | null;
      blockedOnStatus: string | null;
      blockedOnProjectId: number | null;
      unblockCondition: string | null;
      unblockOwner: string | null;
      createdAt: string;
    }[];
  }>(
    `SELECT t.id, t.title, t.detail, t.lane, (${EFFECTIVE_STATUS_SQL}) AS status,
            t.owner_name AS assignee, (t.assignee_owner_id = $1) AS mine,
            EXISTS (SELECT 1 FROM task_blockers wb
                     WHERE wb.task_id = t.id AND wb.resolved_at IS NULL AND wb.unblock_owner_id = $1) AS waiting_on_me,
            (SELECT count(*) FROM task_blockers b WHERE b.task_id = t.id AND b.resolved_at IS NULL)::text AS blockers,
            -- BOTH sources of "blocked", because there are two and they are different tables: task_block
            -- writes task_blockers (a reason, no target) and task_depend writes task_deps (a target, no
            -- reason). Reading only the first is why a dependency-blocked task rendered "blocked on a
            -- dependency" and never said WHICH - 15 live tasks were in that state.
            (SELECT COALESCE(json_agg(x ORDER BY x->>'createdAt'), '[]'::json)
               FROM (
                 SELECT json_build_object(
                          'reason', b2.reason,
                          'blockedOnTaskId', NULL::bigint,
                          'blockedOnTitle', NULL::text,
                          'blockedOnStatus', NULL::text,
                          'blockedOnProjectId', NULL::bigint,
                          -- Decision 074: what would lift it, and who owns lifting it. Both are NULL on
                          -- rows written before 074; the renderer says so rather than pretending.
                          'unblockCondition', b2.unblock_condition,
                          'unblockOwner', b2.unblock_name,
                          'createdAt', b2.created_at) AS x
                   FROM task_blockers b2
                  WHERE b2.task_id = t.id AND b2.resolved_at IS NULL
                 UNION ALL
                 SELECT json_build_object(
                          'reason', NULL::text,
                          'blockedOnTaskId', d2.depends_on_task_id,
                          'blockedOnTitle', u2.title,
                          'blockedOnStatus', u2.status,
                          'blockedOnProjectId', u2.project_id,
                          'unblockCondition', NULL::text,
                          'unblockOwner', NULL::text,
                          'createdAt', d2.created_at)
                   FROM task_deps d2 JOIN tasks u2 ON u2.id = d2.depends_on_task_id
                  WHERE d2.task_id = t.id AND u2.status NOT IN ('done','cancelled')
               ) s) AS blocker_rows,
            t.options, t.selected_option, t.answer_note, t.links,
            pr.id AS project_id, pr.name AS project_name, pr.slug,
            t.created_by_id AS created_by_pid,
            COALESCE(
              (SELECT COALESCE(COALESCE(ho2.username, o2.username) || '/' || pt2.name, pt2.name)
                 FROM participations pa2 JOIN participants pt2 ON pt2.id = pa2.participant_id
                 LEFT JOIN owners o2 ON o2.id = pt2.owner_id
                 LEFT JOIN owners ho2 ON ho2.id = pa2.human_owner_id
                WHERE pa2.id = t.created_by_id),
              (SELECT username FROM owners WHERE id = t.created_by_owner_id)
            ) AS created_by_name
       FROM tasks t
       JOIN projects pr ON pr.id = t.project_id
       LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $1
      WHERE t.id = $2 AND t.project_id = $3
        AND (
              pr.owner_id = $1
              -- Decision 078 (ruling 2026-08-30-3): membership means SEEING the project. A member could
              -- already open the project, read its roster and CREATE tasks in it while this predicate hid
              -- every task but their own, so they could add a task to a board they could not read. The
              -- WRITE path is deliberately not widened with it (task-writes.ts): read the project, act on
              -- your own.
              OR pm.role IN ('admin', 'member')
            )`,
    [ownerId, taskId, projectId],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const r = res.rows[0];
  return {
    taskId: Number(r.id),
    title: r.title,
    detail: r.detail,
    lane: r.lane,
    status: r.status,
    assignee: r.assignee,
    mine: r.mine === true,
    waitingOnMe: r.waiting_on_me === true,
    blockers: Number(r.blockers),
    blockerRows: r.blocker_rows ?? [],
    options: r.options,
    selectedOption: r.selected_option,
    answerNote: r.answer_note,
    links: r.links,
    projectId: Number(r.project_id),
    projectName: r.project_name,
    projectSlug: r.slug,
    createdByPid: r.created_by_pid != null ? Number(r.created_by_pid) : null,
    createdByName: r.created_by_name,
  };
}

/** The NEXT task in the human's queue for a project (decision 048): the OLDEST open (effective `todo`) task
 *  assigned to THIS owner, excluding a just-handled one - so answering a task can auto-advance to the next in
 *  line (FIFO). Assigned-to-them means they can already see it (the membership predicate lets a plain member
 *  see tasks assigned to them; an owner/admin sees all), so this needs no extra scope check, and the detail
 *  loader re-proves membership on render regardless. Ordered by id ASC (id is monotonic with creation, so
 *  oldest-first). Returns null when the queue is empty. Read-only; parameterized. */
export async function nextOwnerTaskInProject(
  ownerId: number,
  projectId: number,
  excludeTaskId: number,
): Promise<number | null> {
  if (!Number.isFinite(projectId) || !Number.isFinite(excludeTaskId)) return null;
  const res = await query<{ id: string }>(
    `SELECT t.id
       FROM tasks t
      WHERE t.project_id = $1 AND t.assignee_owner_id = $2 AND t.id <> $3
        AND (${EFFECTIVE_STATUS_SQL}) = 'todo'
      ORDER BY t.id ASC
      LIMIT 1`,
    [projectId, ownerId, excludeTaskId],
  );
  return (res.rowCount ?? 0) > 0 ? Number(res.rows[0].id) : null;
}

export interface AssignTarget {
  tag: string; // the dropdown value tag re-proven server-side: agent:<pid> | human:<ownerId>
  label: string; // display label (qualified handle/label for an agent; handle/email for a human)
  kind: "agent" | "human";
}

/** A human member of a project, for the Access page's People section (decision 080). */
export interface ProjectMemberRow {
  ownerId: number;
  handle: string;
  email: string;
  role: string;
  isYou: boolean;
}

/**
 * The HUMAN members of a project - owner-scoped, for the Access page.
 *
 * The Access page listed agents and pending invites and never showed people at all, which is why
 * "make Bob an admin" had nowhere to happen: you cannot promote someone who is not on the screen.
 */
export async function listProjectHumanMembers(
  ownerId: number,
  projectId: number,
): Promise<ProjectMemberRow[]> {
  if (!Number.isFinite(projectId)) return [];
  const res = await query<{ owner_id: string; handle: string; email: string; role: string }>(
    `SELECT m.owner_id, COALESCE(o.username, o.email) AS handle, o.email, m.role
       FROM project_members m
       JOIN owners o ON o.id = m.owner_id
       JOIN projects pr ON pr.id = m.project_id
      WHERE m.project_id = $1 AND ${projectReadClause("$2", "pr")}
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, handle`,
    [projectId, ownerId],
  );
  return res.rows.map((r) => ({
    ownerId: Number(r.owner_id),
    handle: r.handle,
    email: r.email,
    role: r.role,
    isYou: Number(r.owner_id) === ownerId,
  }));
}

/**
 * Promote a member to `admin`, or demote an admin back to `member` (decision 080).
 *
 * WHAT THIS CLOSES: decision 078 gave a project admin read of the project's own pages, and nothing in the
 * product could create such a row - two writes to project_members existed, 'owner' at project creation and
 * 'member' at invite acceptance. A capability gated on a state the system could not produce.
 *
 * OWNER-ONLY, deliberately narrower than the read it unlocks. This is the act that decides who else can
 * see a whole project, so it runs through loadOwnedProject like every other mutation rather than through
 * 078's wider read clause - a project ADMIN cannot mint more admins. Returns false on any refusal, with
 * the row untouched and no oracle: a project you do not own is indistinguishable from one that is not there.
 *
 * THE OWNER ROW IS UNTOUCHABLE. Demoting it would leave a project whose owner cannot administer it, and
 * there is no path back - so 'owner' is excluded in SQL, not just in the UI.
 */
export async function setProjectMemberRole(
  ownerId: number,
  projectId: number,
  memberOwnerId: number,
  admin: boolean,
): Promise<boolean> {
  if (!Number.isFinite(projectId) || !Number.isFinite(memberOwnerId)) return false;
  const res = await query(
    `UPDATE project_members m
        SET role = $4
       FROM projects pr
      WHERE pr.id = m.project_id
        AND m.project_id = $1
        AND pr.owner_id = $2
        AND m.owner_id = $3
        AND m.role <> 'owner'`,
    [projectId, ownerId, memberOwnerId, admin ? "admin" : "member"],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The assignable targets for a project's task authoring dropdown (decision 039): its agents (participations)
 * + its human members (project_members join owners). Membership-gated: the CALLER must own/admin/be a member
 * of the project, else it returns [] (a non-member gets no roster - invariant 3). Each option is value-tagged
 * `agent:<pid>` / `human:<ownerId>` and re-proven in-project by the write layer before any assignment
 * (invariant 1 - the tag names no identity on its own).
 */
export async function listProjectMembersForAssign(ownerId: number, projectId: number): Promise<AssignTarget[]> {
  if (!Number.isFinite(projectId)) return [];
  const gate = await query(
    `SELECT 1 FROM projects pr
       LEFT JOIN project_members pm ON pm.project_id = pr.id AND pm.owner_id = $2
      WHERE pr.id = $1 AND (pr.owner_id = $2 OR pm.role IN ('admin', 'member'))`,
    [projectId, ownerId],
  );
  if ((gate.rowCount ?? 0) === 0) return [];
  const [agents, humans] = await Promise.all([
    query<{ pid: string; label: string; handle: string | null }>(
      `SELECT pa.id AS pid, pt.name AS label, o.username AS handle
         FROM participations pa
         JOIN participants pt ON pt.id = pa.participant_id
         LEFT JOIN owners o ON o.id = pt.owner_id
        WHERE pa.project_id = $1
        ORDER BY pt.name`,
      [projectId],
    ),
    query<{ oid: string; handle: string }>(
      `SELECT o.id AS oid, COALESCE(o.username, o.email) AS handle
         FROM project_members m JOIN owners o ON o.id = m.owner_id
        WHERE m.project_id = $1
        ORDER BY handle`,
      [projectId],
    ),
  ]);
  return [
    ...agents.rows.map((a) => ({
      tag: `agent:${a.pid}`,
      label: a.handle ? `${a.handle}/${a.label}` : a.label,
      kind: "agent" as const,
    })),
    ...humans.rows.map((h) => ({ tag: `human:${h.oid}`, label: h.handle, kind: "human" as const })),
  ];
}

/**
 * Promote/demote a participation's project-admin (lead) flag, owner-scoped (join to projects.owner_id).
 * Takes effect on the agent's NEXT tool call - the admin gates and whoami re-read is_admin live from
 * the DB (auth.ts liveIsAdmin), so no session reconnect is needed. Returns true if a row changed.
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

/**
 * Set (or CLEAR, with an empty value) a participation's lane - the owner-side half of decision 065.
 *
 * Before 065 the provisioned lane was a cosmetic label nothing read, so nothing needed to edit it. Now it
 * ROUTES, and every write path uses `lane = COALESCE(EXCLUDED.lane, participations.lane)`, so a NULL never
 * clears one: a lane typo'd at provision time would be a permanent subscription with no way out short of
 * re-minting the agent's token. This is the way out. An agent can also move itself with register(lane:).
 *
 * Owner-scoped, and a miss is indistinguishable from a bad id (invariant 3: no existence oracle).
 */
export async function setParticipationLane(
  ownerId: number,
  participationId: number,
  lane: string | null,
): Promise<boolean> {
  if (!Number.isFinite(participationId)) return false;
  // '(unset)' is the delivery sentinel, not a lane name (see register()); and '*' is reserved for the
  // server's own project-wide notices, so an owner must not be able to subscribe an agent to it by typing it.
  if (lane === "(unset)" || lane === "*") return false;
  const res = await query(
    `UPDATE participations pa
        SET lane = $3
       FROM projects pr
      WHERE pa.id = $1 AND pa.project_id = pr.id AND pr.owner_id = $2`,
    [participationId, ownerId, lane],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── The "needs you" plate, shared by the daily digest ────────────────────────────────────────────────────
// ONE owner-scoped builder for the two genuinely-shared NEEDS YOU buckets, each scoped by pr.owner_id = $1
// (invariant 3): blocked tasks + unread reply-needing posts. The daily digest (src/notify/digest) composes
// from it. Read-only; a project the caller does not own yields no row. (The review buckets that lived here
// were retired with the /admin/review board by decision 039.)
const NEEDS_UNACKED_AGE = "3 hours"; // give agents time to READ a post before it counts as "needs you"
// Rows shown per "needs you" bucket. A GLANCE size, deliberately small - which is exactly why each bucket
// also reports its true pre-cap total (decision 063); the cap is a display choice, never a claim.
const NEEDS_CAP = 20;
const NEEDS_INFORMATIONAL_TAGS = ["handoff", "share", "fyi", "announce", "announcement"]; // never nag as needs-you

export interface OwnerBlockedNeed {
  taskId: number;
  title: string;
  assignee: string | null;
  projectId: number;
  projectName: string;
  updatedAt: string;
}
export interface OwnerUnackedNeed {
  postId: number;
  subject: string | null;
  ref: string | null;
  fromActorName: string;
  toLane: string | null;
  projectId: number;
  projectName: string;
  createdAt: string;
}
/** A task assigned to THE HUMAN (assignee_owner_id) awaiting their action - the "ask me" plate (decision 043):
 *  a decision an agent routed to them (options set), or any task on their personal plate. */
export interface OwnerAwaitingNeed {
  taskId: number;
  title: string;
  isDecision: boolean;
  projectId: number;
  projectName: string;
  updatedAt: string;
}
/** Decision 074 named a HUMAN as the owner of a block's unblock and then delivered that only to AGENTS
 *  (whats_new.waiting_on_you). A block naming a person reached no human surface at all, so it sat until
 *  someone happened to open that task's detail page - the exact dead end 074 was written to close, surviving
 *  in its own fix. Operator ruling 2026-08-30-1: it goes in NEEDS YOU in the brief, and on the board. */
export interface OwnerWaitingNeed {
  taskId: number;
  title: string;
  /** What would LIFT it (074's unblock_condition). Null on a manual block recorded before 074 - rendered as
   *  a stated gap, never as a blank, because a blank reads identically to "there is nothing to do". */
  liftsWhen: string | null;
  projectId: number;
  projectName: string;
  createdAt: string;
}

export interface OwnerNeeds {
  awaiting: OwnerAwaitingNeed[];
  blocked: OwnerBlockedNeed[];
  unacked: OwnerUnackedNeed[];
  waiting: OwnerWaitingNeed[];
  // TRUE bucket sizes before NEEDS_CAP (decision 063, same rule as 062: a capped list states its real
  // depth). The digest email is the main returning surface, so a bucket that quietly stops at the cap is
  // the operator being told a smaller number than is true, on the one channel that pulls them back.
  awaitingTotal: number;
  blockedTotal: number;
  unackedTotal: number;
  waitingTotal: number;
}

/** The genuinely-shared "needs you" buckets for one owner: blocked tasks + unread reply-needing posts, each
 *  owner-scoped by pr.owner_id = $1. Optional `projectId` narrows both buckets to one project, WITHIN the
 *  owner's projects (the pr.owner_id = $1 isolation is kept), never past them (invariant 3). The daily digest
 *  passes no projectId, so its buckets stay owner-wide. (The review buckets were retired by decision 039.) */
export async function ownerNeedsYou(ownerId: number, opts: { projectId?: number } = {}): Promise<OwnerNeeds> {
  const projectId = opts.projectId != null && Number.isFinite(opts.projectId) ? opts.projectId : null;
  const [awaiting, blocked, unacked, waiting] = await Promise.all([
    // AWAITING YOU (decision 043): open tasks assigned to THIS HUMAN (assignee_owner_id = $1) - the decisions
    // and tasks an agent routed to them via the ask-me loop. Scoped by the ASSIGNEE (the human's own plate),
    // so it spans owned + member projects (invariant 3: only their own assignments). Excludes derived-blocked
    // (those show in the blocked bucket), decisions (options set) sort first. This is the push half of the
    // ask-me loop the daily digest was missing (the review-nag it replaces was retired by 039).
    query<{ id: string; title: string; project_id: string; project_name: string; updated_at: string; is_decision: boolean; total: string }>(
      `SELECT t.id, t.title, t.project_id, pr.name AS project_name, t.updated_at,
              count(*) OVER ()::text AS total,
              (t.options IS NOT NULL AND jsonb_array_length(t.options) > 0) AS is_decision
         FROM tasks t JOIN projects pr ON pr.id = t.project_id
        WHERE t.assignee_owner_id = $1
          AND t.status IN ('todo', 'in_progress')
          AND NOT (${IS_BLOCKED_SQL})
          AND ($2::bigint IS NULL OR pr.id = $2)
        ORDER BY is_decision DESC, t.updated_at DESC
        LIMIT ${NEEDS_CAP}`,
      [ownerId, projectId],
    ),
    query<{ id: string; title: string; project_id: string; project_name: string; updated_at: string; assignee: string | null; total: string }>(
      `SELECT t.id, t.title, t.project_id, pr.name AS project_name, t.updated_at, t.owner_name AS assignee,
              count(*) OVER ()::text AS total
         FROM tasks t JOIN projects pr ON pr.id = t.project_id
        WHERE pr.owner_id = $1 AND ${IS_BLOCKED_SQL}
          AND ($2::bigint IS NULL OR pr.id = $2)
        ORDER BY t.updated_at DESC LIMIT ${NEEDS_CAP}`,
      [ownerId, projectId],
    ),
    query<{ id: string; subject: string | null; ref: string | null; from_actor_name: string; to_lane: string | null; created_at: string; project_id: string; project_name: string; total: string }>(
      `SELECT p.id, p.subject, p.ref, p.from_actor_name, p.to_lane, p.created_at, p.project_id, pr.name AS project_name,
              count(*) OVER ()::text AS total
         FROM posts p JOIN projects pr ON pr.id = p.project_id
        WHERE pr.owner_id = $1
          AND p.created_at < now() - interval '${NEEDS_UNACKED_AGE}'
          -- DIRECTED posts only (decision 063, operator-ruled 2026-08-20). A post to a LANE is an
          -- agent-to-agent broadcast in a shared room, not a request for the project owner's reply, and the
          -- product already has a proper channel for "a person must act on this": a task assigned to
          -- human:, which is the awaiting-you bucket above. Measured on prod before the rule changed: of
          -- 101 posts this bucket was nagging the operator about, 87 were lane broadcasts written by his own
          -- agents (tagged progress/platform/brand/deploy/acquisition/...) and only 14 were addressed to
          -- anyone. Filtering by ADDRESSING rather than by tag is what makes this hold: the informational
          -- tag list below is a hand-kept allowlist and agents invent tags freely, so it drifts out of date
          -- and the bucket silently re-inflates - which is exactly how it reached 101.
          AND p.to_participation_id IS NOT NULL
          AND (p.tag IS NULL OR lower(p.tag) <> ALL($2::text[]))
          -- decision 039: "still needs a reply" now means NOBODY has READ it (post_reads), not un-acked -
          -- reading is the receipt in v2. Scoped to the ADDRESSEE (decision 065): the receipt that clears
          -- this line must be the addressed participation's own. A directed post normally also carries a
          -- to_lane (address an actor, cc the room), and readPosts stamps a receipt for anyone the lane
          -- reaches - so an unscoped check let a BYSTANDER's read silently clear the operator's "unread
          -- from X" line while the addressee never saw it. 065 widens lane delivery, which multiplies the
          -- bystanders; post_reads rows cannot be un-written, so this scoping lands BEFORE that widening.
          AND NOT EXISTS (
            SELECT 1 FROM post_reads pr2
             WHERE pr2.post_id = p.id AND pr2.participation_id = p.to_participation_id
          )
          AND ($3::bigint IS NULL OR pr.id = $3)
        ORDER BY p.created_at DESC LIMIT ${NEEDS_CAP}`,
      [ownerId, NEEDS_INFORMATIONAL_TAGS, projectId],
    ),
    // WAITING ON YOU (decision 074's human arm, operator ruling 2026-08-30-1): open blocks that named THIS
    // HUMAN as the owner of the unblock. Scoped by the NAMED human, like `awaiting` above and unlike the
    // owner-scoped buckets, because the point of the bucket is "someone's work is stopped until YOU act" -
    // which is true in a project you are merely a member of. That is safe rather than a widening: task_block
    // resolves unblock_human through the SAME resolveAssignee as assignment (decision 061), which refuses a
    // name from outside the project, so a block can only ever name an existing member.
    query<{ id: string; title: string; unblock_condition: string | null; project_id: string; project_name: string; created_at: string; total: string }>(
      // TERMINAL TASKS ARE EXCLUDED, and the exclusion is load-bearing - the same one the agent-side query
      // carries. A blocker row is NOT resolved when its task ships or is cancelled (prod holds exactly that
      // shape), so without this a block on a task that later went terminal would sit in someone's brief
      // forever with no action able to clear it. A queue you cannot empty is the failure 074 exists to
      // prevent, not one to reproduce on a second surface.
      `SELECT b.task_id AS id, t.title, b.unblock_condition, t.project_id, pr.name AS project_name,
              b.created_at, count(*) OVER ()::text AS total
         FROM task_blockers b
         JOIN tasks t ON t.id = b.task_id
         JOIN projects pr ON pr.id = t.project_id
        WHERE b.unblock_owner_id = $1
          AND b.resolved_at IS NULL
          AND t.status NOT IN ('done','cancelled')
          AND ($2::bigint IS NULL OR pr.id = $2)
        ORDER BY b.created_at
        LIMIT ${NEEDS_CAP}`,
      [ownerId, projectId],
    ),
  ]);
  return {
    awaiting: awaiting.rows.map((r) => ({
      taskId: Number(r.id),
      title: r.title,
      isDecision: r.is_decision === true,
      projectId: Number(r.project_id),
      projectName: r.project_name,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    blocked: blocked.rows.map((r) => ({
      taskId: Number(r.id),
      title: r.title,
      assignee: r.assignee,
      projectId: Number(r.project_id),
      projectName: r.project_name,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    unacked: unacked.rows.map((r) => ({
      postId: Number(r.id),
      subject: r.subject,
      ref: r.ref,
      fromActorName: r.from_actor_name,
      toLane: r.to_lane,
      projectId: Number(r.project_id),
      projectName: r.project_name,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    waiting: waiting.rows.map((r) => ({
      taskId: Number(r.id),
      title: r.title,
      liftsWhen: r.unblock_condition,
      projectId: Number(r.project_id),
      projectName: r.project_name,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    awaitingTotal: bucketTotal(awaiting.rows),
    blockedTotal: bucketTotal(blocked.rows),
    unackedTotal: bucketTotal(unacked.rows),
    waitingTotal: bucketTotal(waiting.rows),
  };
}

/** True pre-cap size of a bucket. count(*) OVER () is evaluated before LIMIT, so it rides on any returned
 *  row; an empty bucket is genuinely 0. */
function bucketTotal(rows: Array<{ total: string }>): number {
  return rows.length ? Number(rows[0].total) : 0;
}
