// One connection, many projects (decision 070).
//
// Before this, the bearer token WAS the scope: it resolved to exactly one membership and an agent could
// not name, see, or reach any other project. Being added to a second project therefore meant minting a
// second token and editing the agent's connection config - a secret handed over for what is, on the
// owner's side, just a share.
//
// Now the token resolves to an IDENTITY, and that identity's memberships are its reach. The two keys:
//
//   - the same PARTICIPANT (an agent identity is owner-scoped and unique by name, so its rows across
//     projects are the same actor), guarded so a seat whose driver differs never bridges two humans; and
//   - the same DRIVING HUMAN (participations.human_owner_id, the verified SSO identity), which is what
//     lets one connection cross an owner boundary - exactly the set the OAuth consent picker already
//     offers at sign-in (oauth-as.ts listMemberships).
//
// What did NOT change: scope is still resolved by the SERVER from the token, never trusted from input.
// A call may NAME a project, but only one already in this set; anything else is refused with an error
// that lists what you DO hold and never confirms whether the named project exists (invariant 1).

import type { Ctx } from "../context.js";
import { query } from "../db.js";
import { CTX_COLUMNS, composeCtx, suspensionBlocked, type CtxRow } from "../auth.js";
import { unreadCount } from "./post.js";
import { ownedActionableTaskCount } from "./task.js";

/**
 * The reach predicate. ONE definition, used by both the list and the resolver, so what you can SEE and
 * what you can ACT IN cannot drift apart - a list that showed more than it could open, or a resolver that
 * opened more than it listed, are the same bug in opposite directions.
 *
 * $1 = the token's participant id, $2 = the token's driving human (nullable).
 *
 * Arm 1's driver clause is deliberately ASYMMETRIC, and the asymmetry is the whole guard:
 *   - target driver NULL          -> reachable. An unclaimed seat of the SAME agent (participant rows are
 *                                   unique per owner+name, so this is the same named agent under the same
 *                                   owner). Most provisioned memberships are unbound, so requiring a match
 *                                   here would leave the common case unreachable.
 *   - target driver = mine        -> reachable.
 *   - target driver = SOMEONE ELSE-> refused, INCLUDING when mine is null. A seat another human was bound
 *                                   to must never be reachable from a token that human does not drive;
 *                                   invite acceptance already refuses to create that shape (decision 068)
 *                                   and this makes it a boundary rather than an assumption.
 * Arm 2 is null-guarded: a driver-less token (a provisioned agent nobody has bound) must reach only its
 * own participant's rows, never every other unbound membership on the platform.
 */
/**
 * The predicate itself, parameterised by how the VIEWER is named in SQL, so a third consumer cannot
 * re-derive it slightly differently. That is not hypothetical: `grant()` decided whether to mint a token by
 * matching `participant_id` ALONE, under a comment asserting it was "the same scope the reach rule uses".
 * It was not - it dropped the driver guard - so granting an already-connected agent a project whose seat is
 * bound to a human its token is NOT bound to produced a membership row, skipped the token, and told the
 * operator the agent was good to go. Measured on prod the day it was found: FOUR such seats, three of them
 * holding live tokens that could not reach their own new membership (one agent had 43).
 *
 * @param viewerParticipant SQL for the viewer's participant id
 * @param viewerHuman       SQL for the viewer's driving human (nullable)
 * @param target            table alias of the participation being tested
 */
/**
 * These two builders assemble the AUTHORIZATION predicate by string concatenation, which is the one place
 * in the codebase that does (invariant 7: all SQL parameterized). Every current call site passes a compile
 * -time literal - a bound placeholder like `$1` or a fixed table alias - and none is derived from input.
 * Independent review flagged that nothing ENFORCED that: a future consumer passing a value derived from a
 * request would silently rewrite the reach rule with no type error and no failing test. So it is enforced
 * here, loudly, rather than left to a comment nobody reads at the call site.
 */
function sqlFragment(v: string, what: string): string {
  if (!/^[A-Za-z0-9_.$:]+$/.test(v)) {
    throw new Error(`${what} must be a SQL identifier or placeholder, never user input - got: ${v}`);
  }
  return v;
}

/**
 * A token row is LIVE only if it is neither revoked nor expired. Both halves, always - checking
 * `revoked_at` alone was shipped in three separate places and made an EXPIRED token read as an
 * active one, because nothing ever stamps `revoked_at` when a token simply lapses (the OAuth AS
 * mints a fresh 1h row per exchange AND per refresh, and never revokes the old one). The Access
 * page then rendered "active" for a seat that could not authenticate - on the one page decision
 * 075 built to answer "can this agent work here?".
 *
 * Defined once so the display predicates cannot drift from `auth.ts`, which is the authority and
 * has always checked both. `alias` is a SQL table alias, never user input.
 */
export function liveTokenClause(alias: string): string {
  const a = sqlFragment(alias, "liveTokenClause(alias)");
  return `${a}.revoked_at IS NULL AND (${a}.expires_at IS NULL OR ${a}.expires_at > now())`;
}

/**
 * A token reaches exactly the seats of the AGENT it was issued for (decision 077, narrowing 070).
 *
 * It used to carry a second arm - `viewerHuman IS NOT NULL AND target.human_owner_id = viewerHuman` - so a
 * token reached every seat bound to the same HUMAN, whichever agent held it. Because `composeCtx` builds the
 * context from the row that is reached, landing on another agent's seat handed the caller that agent's NAME
 * and its `is_admin` flag: a token minted for a deliberately non-admin `show-and-tell` in one project acted
 * as `Project-B-hq` WITH ADMIN in another. Measured on prod before the change: 10 live tokens, every one an
 * admin key to four projects. 070 meant "one connection, all your projects" as a convenience for a person's
 * own agents; what it could not express is that a token issued for a NAMED actor reads as a narrower grant,
 * and was not one.
 *
 * The remaining arm is deliberately still human-GUARDED rather than bare `participant_id =`: a seat of the
 * same participant that a DIFFERENT human drives is still refused, so a re-homed membership cannot bridge
 * two people. `human_owner_id IS NULL` stays reachable because most provisioned seats were minted, never
 * invited, and have no driver at all - an unbound seat of your own agent is still yours.
 *
 * Privilege is unchanged and still comes from the seat you land on ("your role is per project"). That rule
 * was always right; what was wrong was which seats you could land on.
 */
/**
 * Who may READ a project's own surfaces: its owner, or a `project_members` row with role 'admin'
 * (decision 078, ruling 2026-08-30-3 - "they see tasks only, if admin, everything").
 *
 * Defined ONCE and used by every loader behind those pages, because the first attempt at this shipped the
 * route gate alone and left four loaders on `pr.owner_id = $2` - so a project admin reached the overview,
 * Access and settings pages and would have seen BLANK ones. Four copies of an access rule is four chances
 * for the page and its data to disagree about who is allowed to see it.
 *
 * READ ONLY. Every mutation stays on `loadOwnedProject` (`owner_id` alone): widening the write path would
 * hand a project admin the power to mint and revoke credentials as a side effect of a visibility ruling,
 * which is the coupling decision 077 was written about.
 */
export function projectReadClause(viewerOwner: string, alias = "pr"): string {
  sqlFragment(viewerOwner, "projectReadClause(viewerOwner)");
  sqlFragment(alias, "projectReadClause(alias)");
  return `(${alias}.owner_id = ${viewerOwner} OR EXISTS (
        SELECT 1 FROM project_members pmr
         WHERE pmr.project_id = ${alias}.id AND pmr.owner_id = ${viewerOwner} AND pmr.role = 'admin'
      ))`;
}

export function reachClause(viewerParticipant: string, viewerHuman: string, target = "pa"): string {
  sqlFragment(viewerParticipant, "reachClause(viewerParticipant)");
  sqlFragment(viewerHuman, "reachClause(viewerHuman)");
  sqlFragment(target, "reachClause(target)");
  return `(
        ${target}.participant_id = ${viewerParticipant}
        AND (${target}.human_owner_id IS NULL OR ${target}.human_owner_id IS NOT DISTINCT FROM ${viewerHuman})
      )`;
}

const REACH_WHERE = reachClause("$1", "$2::bigint");

const REACH_FROM = `FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN projects     pr ON pr.id = pa.project_id
       JOIN owners       o  ON o.id  = pr.owner_id
       LEFT JOIN owners  ho ON ho.id = pa.human_owner_id`;

function reachArgs(ctx: Ctx): [number, number | null] {
  return [ctx.participant.id, ctx.participation.humanOwnerId];
}

/**
 * One row per PROJECT. An identity can hold more than one seat in the same project - on prod, one human
 * drives both `agent-two` and `agent-one` in the project `owner-workspace` - and both are reachable, so the
 * raw reach query returns that project twice.
 *
 * Left unhandled this is not a cosmetic duplicate: the ambiguity check below would refuse the project and
 * tell the caller to name it in full, and the qualified form resolves to the SAME two rows, so the advice
 * cannot be followed and the project is simply unreachable. The ambiguity that IS real is two DIFFERENT
 * projects sharing a slug, which is what qualifying actually fixes.
 *
 * The pick is deterministic and prefers YOU: your own participant's seat if you hold one there (acting as
 * yourself is never the wrong answer), else the oldest seat. It is applied to the list and the resolver
 * through this one function, so what you see and what you get stay the same row.
 */
function onePerProject(rows: CtxRow[], ownParticipantId: number): CtxRow[] {
  const best = new Map<string, CtxRow>();
  for (const r of rows) {
    const cur = best.get(r.project_id);
    if (cur === undefined) {
      best.set(r.project_id, r);
      continue;
    }
    const curIsOwn = Number(cur.participant_id) === ownParticipantId;
    const rIsOwn = Number(r.participant_id) === ownParticipantId;
    if (rIsOwn && !curIsOwn) best.set(r.project_id, r);
    else if (rIsOwn === curIsOwn && Number(r.participation_id) < Number(cur.participation_id))
      best.set(r.project_id, r);
  }
  return [...best.values()];
}

/** The canonical cross-project address `<ownerHandle>/<slug>` (044), or the bare slug until backfilled. */
export function qualifyProject(ownerHandle: string | null, slug: string): string {
  return ownerHandle ? `${ownerHandle}/${slug}` : slug;
}

export interface ReachableProject {
  project: string; // the slug: what you pass as `project` on any tool
  qualified: string; // <ownerHandle>/<slug> - pass THIS when two of your projects share a slug
  name: string;
  you: string; // your qualified actor name IN that project (it can differ per project)
  lane: string | null;
  is_admin: boolean;
  is_default: boolean; // the project this connection's token was issued against
  unread_posts: number;
  open_tasks: number;
  suspended: boolean; // that project's owner is blocked for non-payment; calls naming it will refuse
}

/** Every membership this connection can act in, with what is waiting in each. */
export async function listProjects(ctx: Ctx): Promise<ReachableProject[]> {
  const res = await query<CtxRow>(
    `SELECT ${CTX_COLUMNS}
       ${REACH_FROM}
      WHERE ${REACH_WHERE}
      ORDER BY pr.name`,
    reachArgs(ctx),
  );
  const rows = onePerProject(res.rows, ctx.participant.id);
  // The counts come from the SAME functions that produce the per-call `_unread_posts` / `_open_tasks`
  // nudges rather than a hand-rolled aggregate. Two ways to count the same thing is how the number in the
  // list and the number on the nudge start disagreeing - and unreadCount carries 065's lane fallback,
  // which a re-implementation would silently drop. N is a handful of projects on one non-hot tool.
  return Promise.all(
    rows.map(async (r) => {
      const there = composeCtx(r);
      const blocked = suspensionBlocked(r);
      const [unread, owed] = blocked
        ? [0, 0]
        : await Promise.all([unreadCount(there).catch(() => 0), ownedActionableTaskCount(there).catch(() => 0)]);
      return {
        project: there.project.slug,
        qualified: qualifyProject(there.project.ownerHandle, there.project.slug),
        name: there.project.name,
        you: there.actor,
        lane: there.participation.lane,
        is_admin: there.participation.isAdmin,
        is_default: there.project.id === ctx.project.id,
        unread_posts: unread,
        open_tasks: owed,
        suspended: blocked,
      };
    }),
  );
}

/** Refusal to act in a named project. Never says whether the name exists - it lists only what YOU hold. */
export class UnreachableProjectError extends Error {
  constructor(asked: string, reachable: string[]) {
    super(
      `"${asked}" is not a project this connection can act in. It can act in: ${
        reachable.join(", ") || "(none)"
      }. Call list_projects for the current list. If you should have access to "${asked}", ask its owner ` +
        `to add THIS agent - a token reaches the projects its own agent was added to (decision 077). ` +
        `Adding it hands back a token for that seat; another agent of yours holding a seat there does ` +
        `not carry this one in.`,
    );
    this.name = "UnreachableProjectError";
  }
}

/** Two of your projects share this slug. Refuse rather than guess which one the caller meant. */
export class AmbiguousProjectError extends Error {
  constructor(asked: string, options: string[]) {
    super(
      `"${asked}" matches more than one project you can act in (${options.join(
        ", ",
      )}). Name it in full, e.g. project:"${options[0]}".`,
    );
    this.name = "AmbiguousProjectError";
  }
}

/** The named project's owner is blocked for non-payment. Distinct from "you cannot reach it". */
export class SuspendedProjectError extends Error {
  constructor(slug: string) {
    super(`"${slug}" is suspended for non-payment and cannot be written to. Its owner must settle billing.`);
    this.name = "SuspendedProjectError";
  }
}

/**
 * Resolve a `project` argument to the Ctx for that membership.
 *
 * Accepts the bare slug or the qualified `<ownerHandle>/<slug>`. Matching is case-insensitive; a bare slug
 * that matches two reachable projects is REFUSED rather than guessed, because silently picking one would
 * put a handoff in the wrong project and still return success (the failure shape 065/066 exist to remove).
 *
 * The suspension gate is re-applied against the TARGET project's owner: one connection can now span
 * projects owned by different people, so a gate applied only at connect would let a suspended tenant be
 * written to through a healthy tenant's token.
 */
export async function resolveProject(base: Ctx, asked: string): Promise<Ctx> {
  const want = asked.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!want) return base;

  const res = await query<CtxRow>(
    `SELECT ${CTX_COLUMNS}
       ${REACH_FROM}
      WHERE ${REACH_WHERE}
      ORDER BY pr.name`,
    reachArgs(base),
  );

  const rows = onePerProject(res.rows, base.participant.id).map((r) => ({
    row: r,
    slug: r.slug.toLowerCase(),
    qualified: qualifyProject(r.username, r.slug).toLowerCase(),
  }));

  // A qualified ask matches only the qualified form; a bare ask matches the slug. Never mix the two, or
  // "acme/ops" could resolve through a project merely CALLED "acme/ops" under a different owner.
  const hits = want.includes("/") ? rows.filter((x) => x.qualified === want) : rows.filter((x) => x.slug === want);

  if (hits.length === 0) {
    throw new UnreachableProjectError(
      asked.trim(),
      rows.map((x) => qualifyProject(x.row.username, x.row.slug)),
    );
  }
  if (hits.length > 1) {
    throw new AmbiguousProjectError(
      asked.trim(),
      hits.map((x) => qualifyProject(x.row.username, x.row.slug)),
    );
  }
  const hit = hits[0].row;
  if (suspensionBlocked(hit)) throw new SuspendedProjectError(hit.slug);
  // Same project as the token's own: return the ctx we already have rather than a freshly built twin.
  if (Number(hit.project_id) === base.project.id) return base;
  return composeCtx(hit);
}
