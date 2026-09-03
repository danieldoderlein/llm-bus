import { query } from "../db.js";
import type { Ctx } from "../context.js";
import { liveTokenClause } from "./projects.js";

// The project ROSTER (decision 061): who can be assigned work here, agents and human members alike.
//
// Lives in domain/ like every other coordination concern. It was inline SQL inside the `list_participants`
// tool registration - the only tool in mcp.ts that did not delegate - and that is exactly why it had no
// isolation test: there was no function to call. The untested surface was the one that broke the pattern.

export interface RosterRow {
  name: string;
  actor: string;
  kind: string;
  assign_with: string;
  lane: string | null;
  is_admin: boolean;
  role: string | null;
  token_active: boolean;
}

/**
 * Two sources, one roster (decision 061). Agents come from `participations`; HUMAN members come from
 * `project_members` (decision 037) - they were invisible here, so the only assignable-to-a-person string was
 * undiscoverable while the one that mis-routes was a first-class `name` (the imeo report).
 *
 * For an agent: `name` is the bare label (for provisioning/dedup) and `actor` the qualified handle/label, the
 * handle preferring the BOUND human (participations.human_owner_id, canonical per 038/052) then the
 * provisioner then the bare label - the same COALESCE the access page, who_is_active, and the task write path
 * use. For a human both are the bare handle: a person has no handle/label structure, and the bare handle is
 * exactly what `human:` accepts.
 *
 * `assign_with` derives from the ROW SOURCE, not from `kind`, so it cannot lie even for a legacy kind='human'
 * participation. The explicit `src` rank keeps agents first for the same reason.
 *
 * ISOLATION (invariant 1/3): BOTH branches are pinned to $1 = ctx.project.id, which is token-derived and
 * never caller input, so an agent's roster can only ever be its own project's. Guarded by
 * `isolation.project` - which asserts BOTH that a foreign project's agents and human members are absent AND
 * that the caller's own are present, because an isolation test that only checks absence passes just as
 * happily when the query is broken and returns nothing.
 */
export async function listRoster(ctx: Ctx): Promise<RosterRow[]> {
  const res = await query<RosterRow>(
    `SELECT name, actor, kind, assign_with, lane, is_admin, role, token_active
       FROM (
         SELECT 0 AS src, pt.name AS name,
                COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
                pt.kind AS kind, 'owner'::text AS assign_with,
                -- The RESOLVED lane (live, else provisioned - decision 065), i.e. the lane a post_to_lane
                -- would actually reach. This column advertising a lane that routed NOTHING is the defect
                -- 065 fixes; register() now dual-writes pa.lane, so the two agree going forward and this
                -- COALESCE only matters for a participation that registered before 065 shipped.
                COALESCE(NULLIF(pres.lane, '(unset)'), pa.lane) AS lane, pa.is_admin AS is_admin,
                NULL::text AS role,
                EXISTS(SELECT 1 FROM tokens t WHERE t.participation_id = pa.id AND ${liveTokenClause("t")}) AS token_active
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
           JOIN owners o ON o.id = pt.owner_id
           LEFT JOIN owners ho ON ho.id = pa.human_owner_id
           LEFT JOIN presence pres ON pres.participation_id = pa.id
          WHERE pa.project_id = $1
         UNION ALL
         SELECT 1 AS src, COALESCE(mo.username, mo.email) AS name,
                COALESCE(mo.username, mo.email) AS actor,
                'human'::text AS kind, 'human'::text AS assign_with, NULL::text AS lane,
                (pm.role IN ('owner','admin')) AS is_admin, pm.role AS role,
                false AS token_active
           FROM project_members pm
           JOIN owners mo ON mo.id = pm.owner_id
          WHERE pm.project_id = $1
       ) r
      ORDER BY r.src, r.name, r.actor`,
    [ctx.project.id],
  );
  return res.rows;
}
