import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "./context.js";
import { query, withTx } from "./db.js";
import { touchPresence } from "./presence-mw.js";
import { hashToken, liveIsAdmin } from "./auth.js";
import { loadConfig } from "./config.js";
import { coordinationGuide } from "./invite.js";
import { createOrgInvite } from "./invite-accept.js";
import { notifyInvite } from "./billing/notify.js";
import { claimSequence, seedSequence, formatId, qualifyId } from "./domain/claim.js";
import { register, whoIsActive } from "./domain/presence.js";
import { post, readPosts, unreadCount } from "./domain/post.js";
import { acquireLease, release, whoHolds } from "./domain/lease.js";
import {
  taskCreate,
  taskAssign,
  taskStart,
  taskBlock,
  taskResolve,
  taskShip,
  taskAnswer,
  taskEdit,
  taskDepend,
  taskUndepend,
  taskCancel,
  taskReopen,
  listTasks,
  LIST_TASKS_DEFAULT_LIMIT,
  MAX_TASK_IDS,
  type DetailMode,
  ownedActionableTaskCount,
} from "./domain/task.js";
import { queryEvents } from "./domain/query.js";
import { listProjects, resolveProject } from "./domain/projects.js";
import { listRoster } from "./domain/roster.js";
import { whatsNew, latestClaims } from "./domain/digest.js";

const SERVER_VERSION = "2.0.13";

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO-8601 datetime" });

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Build an MCP server bound to one authenticated context (actor + workspace). One server
 * per session; identity/workspace come from the token, never tool input. Every tool call
 * first refreshes the actor's liveness (implicit heartbeat), so presence is never a manual
 * chore an LLM forgets.
 */
/** The tool call as it arrived on the wire, BEFORE zod stripped it (see `reg`). */
export interface RawCall {
  toolName: string;
  argKeys: string[];
  /** The Host this request arrived on. Client-controlled, so it is used ONLY to compare against the
   *  canonical name and to echo back sanitized - never for an auth or routing decision. */
  host?: string;
}

/** Which endpoint a caller reached us on, when that is NOT the canonical one.
 *
 *  A hostname cannot be retired while agents still point at it, and the server had no way to tell WHO was
 *  still using an old one: measured on the legacy vhost's access log, one real claude-code client had
 *  connected in 47 hours, and the ledger could not say which agent it was (its call was a notification
 *  frame, which writes no event and stamps no presence). Waiting for the log to go quiet cannot distinguish
 *  "moved" from "idle this week", so the endpoint tells the only party who can actually act: the agent
 *  itself, on every call it makes, with the canonical URL to move to.
 *
 *  Generalised on PUBLIC_URL rather than hardcoding a legacy name, so this covers any future rename too.
 *  The host is sanitized before echoing - it is attacker-controlled input being reflected into a response. */
export function legacyEndpointNotice(host: string | undefined, canonicalUrl: string): string | null {
  if (!host) return null;
  // Parsed as a URL rather than split on ":" - a naive split mangles IPv6 ("[::1]:8787" -> "["), which
  // would report a dev loopback as a deprecated endpoint on every call.
  let seen: string;
  let canonical: string;
  try {
    seen = new URL(`http://${host}`).hostname.toLowerCase();
    canonical = new URL(canonicalUrl).hostname.toLowerCase();
  } catch {
    return null; // a malformed Host or PUBLIC_URL must never break a tool call
  }
  if (!seen || seen === canonical) return null;
  // Loopback/dev hosts are not a deprecation, they are how the suite and a self-host run.
  if (seen === "localhost" || seen === "127.0.0.1" || seen === "[::1]") return null;
  const safe = seen.replace(/[^a-z0-9.-]/g, "").slice(0, 80);
  return (
    `You are connected to LLM Bus via "${safe}", which is not the canonical endpoint and may be retired. ` +
    `Point this MCP server at ${canonicalUrl} instead - same token, same identity, nothing else changes. ` +
    `Tell your human so the config is actually updated.`
  );
}

/** Nearest known parameter within one or two edits - enough to catch task_id/task_ids, lane/to_lane. */
function nearestKnown(typo: string, known: string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const k of known) {
    if (Math.abs(k.length - typo.length) >= bestD) continue;
    const d: number[][] = Array.from({ length: typo.length + 1 }, (_, i) =>
      Array.from({ length: k.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= typo.length; i++)
      for (let j = 1; j <= k.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (typo[i - 1] === k[j - 1] ? 0 : 1));
    if (d[typo.length][k.length] < bestD) { bestD = d[typo.length][k.length]; best = k; }
  }
  return best;
}

/**
 * Resolve a participant NAME to exactly one participation in this project.
 *
 * Returns NULL when there is no such participant here, because the two callers have DIFFERENT and
 * long-standing contracts for that case - `admin_revoke` answers `revoked: 0` and `admin_rotate` throws -
 * and the smoke test pins the first as part of cross-project isolation. Ambiguity is the only new refusal.
 *
 * WHY THIS EXISTS. `admin_revoke` and `admin_rotate` address a teammate by NAME, and a name is not an
 * identity: `participants` is unique on (owner_id, name), so two DIFFERENT humans can each own a
 * participant called the same thing, and both can hold a seat in one project. The old code handled that
 * badly in two different ways - revoke updated EVERY match (so revoking your own retired agent could
 * silently lock out a collaborator's live rig), and rotate took `rows[0]` and re-tokened an arbitrary one
 * of them. Both are credential operations on somebody else's access, which is the worst place for a
 * silent wrong guess.
 *
 * Reported by the project-b rig, which refused to run a revoke it could not prove was safe and asked instead.
 * That was the right call: measured afterwards, `agent-bob` resolves to BOB's live rig and nothing
 * of the operator's, so the call would have taken a collaborator offline outright.
 *
 * No collision exists on this bus today (checked: zero names are used by more than one human). This turns
 * a hazard that is currently dormant into one that cannot fire silently - an ambiguous name is REFUSED and
 * the refusal names the qualified actors, so the caller can see exactly whose access they were about to
 * touch. Same shape as decision 077: a name-keyed operation must not cross an identity boundary.
 */
export async function resolveOneParticipant(
  projectId: number,
  name: string,
  tool: string,
): Promise<{ participationId: number; actor: string; isAdmin: boolean } | null> {
  const res = await query<{ id: string; actor: string; is_admin: boolean }>(
    `SELECT pa.id,
            COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name, pt.name) AS actor,
            pa.is_admin
       FROM participations pa
       JOIN participants pt ON pt.id = pa.participant_id
       JOIN owners o        ON o.id  = pt.owner_id
       LEFT JOIN owners ho  ON ho.id = pa.human_owner_id
      WHERE pa.project_id = $1 AND pt.name = $2
      ORDER BY pa.id`,
    [projectId, name],
  );
  if (res.rows.length === 0) return null;
  if (res.rows.length > 1) {
    const actors = res.rows.map((r) => r.actor).join(", ");
    throw new Error(
      `${tool}: "${name}" is ambiguous in this project - it belongs to more than one person (${actors}). ` +
        `Refusing rather than guessing, because this changes someone's access. Ask the person whose seat ` +
        `you did NOT mean to touch to rename their agent, then retry.`,
    );
  }
  return {
    participationId: Number(res.rows[0].id),
    actor: res.rows[0].actor,
    isAdmin: res.rows[0].is_admin,
  };
}

/**
 * The `project` argument every tool accepts (decision 070). Omitted, a call acts in the connection's
 * DEFAULT project - the one its token was issued against - so every existing caller is unchanged.
 */
const PROJECT_ARG = z.string().max(128).optional();

/**
 * NB the parameter is `baseCtx`, not `ctx`. Every handler receives its own `ctx` (the project the CALL
 * resolved to, which may not be the default), and naming the outer one differently means a handler that
 * forgets to take the parameter fails to COMPILE instead of silently acting in the default project.
 * That is the whole safety story for decision 070's threading: a boundary tsc enforces, not a rule to
 * remember (CLAUDE.md section 15, enforcement over prose).
 */
export function buildServer(baseCtx: Ctx, rawCall?: RawCall): McpServer {
  const server = new McpServer({ name: "llm-bus", version: SERVER_VERSION });
  const MCP_URL = loadConfig().PUBLIC_URL.replace(/\/+$/, "") + "/mcp";

  // Register a tool whose handler runs an implicit heartbeat, then returns ok(<data>).
  // The SDK's registerTool is heavily overloaded; bypass overload inference at this boundary.
  type ToolConfig = { description?: string; title?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  const register2 = server.registerTool as unknown as (
    name: string,
    config: ToolConfig,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) => void;
  // Tools that already self-report inbox state; piggybacking the unread count on them is noise.
  const SELF_REPORTING = new Set(["read_posts", "whats_new"]);
  // Tools that already carry your task state (whats_new lists it, list_tasks IS it); no _open_tasks nudge.
  const TASK_SELF_REPORTING = new Set(["whats_new", "list_tasks"]);
  const reg = (
    name: string,
    config: ToolConfig,
    handler: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>,
  ): void => {
    // Every tool takes `project` (decision 070) - injected here rather than repeated 36 times, so the
    // surface has no exceptions to remember and `_ignored_params` below sees it as a known key.
    const merged: ToolConfig = { ...config, inputSchema: { ...(config.inputSchema ?? {}), project: PROJECT_ARG } };
    register2.call(server, name, merged, async (args) => {
      const a = args ?? {};
      // Scope is still resolved BY THE SERVER, from the token's memberships - the argument selects among
      // them, it never supplies one (invariant 1). An unreachable name throws before the handler runs.
      const asked = typeof a.project === "string" ? a.project : "";
      const ctx = asked.trim() ? await resolveProject(baseCtx, asked) : baseCtx;
      const elsewhere = ctx.project.id !== baseCtx.project.id;
      // Heartbeat where you ACT, not where your token lives: presence is per membership, so bumping the
      // default project while working in another would report you live in a project you are ignoring.
      await touchPresence(ctx);
      const data = await handler(a, ctx);
      // Push, don't ask for polling (Q&A finding: agents react to what rides a channel they
      // already read; they do not spontaneously poll). Surface the unread-post count and owed-task count on
      // every tool response, but only when non-zero and the tool does not already report it.
      if (data && typeof data === "object" && !Array.isArray(data)) {
        // Best-effort: a nudge count that throws is swallowed to 0 - it must never fail the real tool call.
        const [unread, owed] = await Promise.all([
          SELF_REPORTING.has(name) ? Promise.resolve(0) : unreadCount(ctx).catch(() => 0),
          TASK_SELF_REPORTING.has(name) ? Promise.resolve(0) : ownedActionableTaskCount(ctx).catch(() => 0),
        ]);
        const extra: Record<string, number | string> = {};
        if (unread > 0) extra._unread_posts = unread;
        if (owed > 0) extra._open_tasks = owed;
        // Acting in a project OTHER than this connection's default is stated back on every response. A
        // cross-project call that looked identical to a local one is exactly how a handoff lands in the
        // wrong project and still returns success - the failure shape 065/066 were written to remove.
        if (elsewhere) extra._project = ctx.project.slug;
        const endpointNotice = legacyEndpointNotice(rawCall?.host, MCP_URL);
        if (endpointNotice) extra._endpoint = endpointNotice;
        // A parameter this tool does not have is STRIPPED by zod and the call succeeds anyway, so a
        // misspelling is indistinguishable from a correct call at the call site: `task_id:[606]` instead of
        // `task_ids:[606]` returns a full unfiltered index and the caller reads the first row as an answer.
        // That is the same silent-accept shape 065 removed for lanes - and the same argument applies, that
        // a caller cannot miss a number but cannot see a discarded field at all. Reported, not rejected:
        // refusing unknown arguments would break every caller on a server upgrade, which is a cost this
        // does not need to impose to make the mistake visible.
        try {
          if (rawCall?.toolName === name && rawCall.argKeys.length) {
            const known = Object.keys(merged.inputSchema ?? {});
            const unknown = rawCall.argKeys.filter((k) => !known.includes(k));
            if (unknown.length) {
              extra._ignored_params = unknown
                .map((u) => {
                  const near = nearestKnown(u, known);
                  return near ? `${u} (did you mean ${near}?)` : u;
                })
                .join(", ")
                .concat(
                  ` - NOT a parameter of ${name}, so it was discarded and this result ignored it. Known: ${known.join(", ") || "(none)"}.`,
                );
            }
          }
        } catch {
          /* never let the nag break the real call (invariant 5) */
        }
        if (Object.keys(extra).length > 0) {
          return ok({ ...(data as Record<string, unknown>), ...extra });
        }
      }
      return ok(data);
    });
  };

  // ── Scarce resources ───────────────────────────────────────────────
  reg(
    "claim",
    {
      description:
        "Atomically allocate the next number for a sequence (e.g. ADR/migration). Returns `formatted` (the bare local id to write, e.g. R181) AND `qualified` (the cross-project id <ownerHandle>/<slug>#R181 - cite THIS when referencing the number from another project, so it never clashes with the same bare id elsewhere). Collision-free across all callers; the sole source of the number. Also returns `created`: TRUE means you just made a BRAND-NEW sequence and this is its first id - if you expected an existing series, you probably typo'd the name (a `warning` then names the sequences this project actually has). Call list_sequences if unsure.",
      inputSchema: {
        sequence: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
        note: z.string().max(500).optional(),
      },
    },
    (a, ctx) => withTx((c) => claimSequence(c, ctx, { sequence: a.sequence as string, note: a.note as string | undefined })),
  );

  reg(
    "seed_sequence",
    {
      description:
        "Initialize a NEW sequence (or advance an existing one to a HIGHER offset) and set its format (prefix + zero-pad), e.g. seed 'adr' at 102 with prefix 'R'. Refuses re-seeding an existing sequence at the same or a lower value - it never rewinds or resets a live counter (which survives a ledger flush); call claim() for the next id.",
      inputSchema: {
        sequence: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
        current: z.number().int().nonnegative(),
        prefix: z.string().max(16).optional(),
        pad: z.number().int().min(0).max(12).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        seedSequence(c, ctx, {
          sequence: a.sequence as string,
          current: a.current as number,
          prefix: a.prefix as string | undefined,
          pad: a.pad as number | undefined,
        }),
      ),
  );

  // ── Presence ───────────────────────────────────────────────────────
  reg(
    "register",
    {
      description: "JOIN a lane (and announce liveness + an optional short status). The lane you register with is where your lane mail lands, and it REPLACES the one you were provisioned with - one lane per agent, changeable any time.",
      inputSchema: { lane: z.string().min(1).max(64), status: z.string().max(140).optional() },
    },
    (a, ctx) => withTx((c) => register(c, ctx, { lane: a.lane as string, status: a.status as string | undefined })),
  );

  reg(
    "who_is_active",
    {
      description:
        "List actors seen on the bus within the liveness window (lane-scoped if `lane` is given), each with `seen_ago_seconds`. Check before touching a shared surface. IMPORTANT: `last_seen` only bumps on a bus tool call, so absence here - or a large `seen_ago_seconds` - means 'quiet on the bus', NOT 'offline'. Never conclude a teammate is gone or free-to-override from this; widen `within_seconds` or post an ask if unsure.",
      inputSchema: {
        lane: z.string().max(64).optional(),
        within_seconds: z.number().int().positive().max(86400).optional(),
      },
    },
    async (a, ctx) => ({
      active: await whoIsActive(ctx, {
        lane: a.lane as string | undefined,
        within_seconds: a.within_seconds as number | undefined,
      }),
      note: "seen_ago_seconds is bus recency, not presence: last_seen only bumps on a bus call, so a quiet agent may be working. Absence is not proof of offline - post an ask before overriding a shared surface.",
    }),
  );

  // ── Prose handoffs ─────────────────────────────────────────────────
  reg(
    "post",
    {
      description: "Send an attributable prose note/handoff to a lane and/or actor, with optional subject/ref/tag and artifact links. Returns `reaches` (how many other inboxes it lands in) and `recipients`; a lane that does not exist in this project is REFUSED, never silently accepted. Attach a LINK, never a blob - the bus stores the url + label, never the artifact.",
      inputSchema: {
        to_lane: z.string().max(64).optional(),
        to_actor: z.string().max(64).optional(),
        subject: z.string().max(200).optional(),
        body: z.string().min(1).max(8000),
        ref: z.string().max(120).optional(),
        tag: z.string().max(64).optional(),
        links: z
          .array(z.object({ label: z.string().max(120).optional(), url: z.string().max(2000) }))
          .max(10)
          .optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        post(c, ctx, {
          to_lane: a.to_lane as string | undefined,
          to_actor: a.to_actor as string | undefined,
          subject: a.subject as string | undefined,
          body: a.body as string,
          ref: a.ref as string | undefined,
          tag: a.tag as string | undefined,
          links: a.links as unknown,
        }),
      ),
  );

  reg(
    "read_posts",
    {
      description: "Read prose posts in this workspace. `to_me` = addressed to you or your lane (the lane you registered with, else the one you were provisioned with); `unread_only` for just your unread mail. `to_lane` reads a lane's archive and REFUSES a lane that does not exist here, so an empty result always means an empty lane. Reading a post addressed to you MARKS IT READ (there is no separate ack in v2) - which clears it from your unread count and the owner's daily digest.",
      inputSchema: {
        to_lane: z.string().max(64).optional(),
        to_me: z.boolean().optional(),
        tag: z.string().max(64).optional(),
        ref: z.string().max(120).optional(),
        unread_only: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (a, ctx) => ({
      posts: await readPosts(ctx, {
        to_lane: a.to_lane as string | undefined,
        to_me: a.to_me as boolean | undefined,
        tag: a.tag as string | undefined,
        ref: a.ref as string | undefined,
        unread_only: a.unread_only as boolean | undefined,
        limit: a.limit as number | undefined,
      }),
    }),
  );

  // ── Advisory leases ────────────────────────────────────────────────
  reg(
    "lease",
    {
      description: "Advisory lease on a surface (file/path) - visibility, not a hard lock. Returns current overlapping holders.",
      inputSchema: {
        surface: z.string().min(1).max(200),
        ttl_seconds: z.number().int().positive().max(86400).optional(),
        note: z.string().max(200).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        acquireLease(c, ctx, {
          surface: a.surface as string,
          ttl_seconds: a.ttl_seconds as number | undefined,
          note: a.note as string | undefined,
        }),
      ),
  );

  reg(
    "release",
    {
      description: "Release your active lease(s) on a surface.",
      inputSchema: { surface: z.string().min(1).max(200) },
    },
    (a, ctx) => withTx((c) => release(c, ctx, a.surface as string)),
  );

  reg(
    "who_holds",
    {
      description: "List active advisory leases in this workspace (optionally for one surface).",
      inputSchema: { surface: z.string().max(200).optional() },
    },
    async (a, ctx) => ({ leases: await whoHolds(ctx, a.surface as string | undefined) }),
  );

  // ── Task graph (decision 039: five-state model, assignee-as-field, dependency edges, options) ──
  reg(
    "task_create",
    {
      description:
        "Create a task (starts in `todo`). Assign now with `owner` (an AGENT process that polls the bus) or " +
        "`human` (a PERSON who works the web board), or leave it unassigned for the grabbable backlog. If a " +
        "person must do it, it goes to `human:` - an agent queue reaches nobody. Call list_participants to " +
        "see both and which field each takes. `options` makes it a decide-this task; `links` attaches " +
        "labeled reference links. NAME THE ACTOR IN AN OPTION, never \"I\"/\"you\": whoever answers reads " +
        "it on the board with no speaker attached, so write \"AGENT commits the line\" / \"HUMAN commits it " +
        "themselves\", not \"I will commit it myself\".",
      inputSchema: {
        title: z.string().min(1).max(200),
        detail: z.string().max(4000).optional(),
        lane: z.string().max(64).optional(),
        owner: z.string().max(64).optional(),
        human: z.string().max(200).optional(),
        options: z.array(z.string().min(1).max(80)).min(2).max(6).optional(),
        links: z.array(z.object({ label: z.string().max(120), url: z.string().max(2000) })).max(10).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        taskCreate(c, ctx, {
          title: a.title as string,
          detail: a.detail as string | undefined,
          lane: a.lane as string | undefined,
          owner: a.owner as string | undefined,
          human: a.human as string | undefined,
          options: a.options as string[] | undefined,
          links: a.links,
        }),
      ),
  );

  reg(
    "task_assign",
    {
      description:
        "Assign, reassign, or unassign a task - legal any time before it is done/cancelled. `owner` names an " +
        "AGENT (a process; it only sees the task if it polls list_tasks(mine=true)), `human` a project MEMBER " +
        "(a person; it lands on their web board). Work only a person can do goes to `human:`. `unassign:true` " +
        "clears it (backlog). Reassigning an in-progress task hands it off (back to todo for the new owner).",
      inputSchema: {
        task_id: z.number().int().positive(),
        owner: z.string().max(64).optional(),
        human: z.string().max(200).optional(),
        unassign: z.boolean().optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        taskAssign(c, ctx, {
          task_id: a.task_id as number,
          owner: a.owner as string | undefined,
          human: a.human as string | undefined,
          unassign: a.unassign as boolean | undefined,
        }),
      ),
  );

  reg(
    "task_start",
    {
      description:
        "Start (or grab) a task: todo → in_progress, taking the soft-lock. An unassigned task is grabbed to you. " +
        "A blocked task (unmet dependency or open manual block) cannot be started.",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskStart(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "task_ship",
    {
      description: "Ship a task (in_progress → done). For a decide-this task (options set) use task_answer instead.",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskShip(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "task_answer",
    {
      description:
        "Complete a decide-this task: pick an `option` (or 'other' + note), or leave free-form `note`. Records " +
        "the choice, marks it done, and posts the result to the assignee of every task that depended on it " +
        "(which unblocks them).",
      inputSchema: {
        task_id: z.number().int().positive(),
        option: z.string().max(80).optional(),
        note: z.string().max(2000).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        taskAnswer(c, ctx, {
          task_id: a.task_id as number,
          option: a.option as string | undefined,
          note: a.note as string | undefined,
        }),
      ),
  );

  reg(
    "task_edit",
    {
      description:
        "Edit a task's fields (any of title/detail/lane/links/options), at any state. Use it to rewrite " +
        "options that named no actor - say \"AGENT ...\" / \"HUMAN ...\" rather than \"I\"/\"you\".",
      inputSchema: {
        task_id: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        detail: z.string().max(4000).optional(),
        lane: z.string().max(64).optional(),
        links: z.array(z.object({ label: z.string().max(120), url: z.string().max(2000) })).max(10).optional(),
        options: z.array(z.string().min(1).max(80)).min(2).max(6).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        taskEdit(c, ctx, {
          task_id: a.task_id as number,
          title: a.title as string | undefined,
          detail: a.detail as string | undefined,
          lane: a.lane as string | undefined,
          links: a.links,
          options: a.options as string[] | undefined,
        }),
      ),
  );

  reg(
    "task_depend",
    {
      description:
        "Add a dependency: `task_id` depends on `depends_on` (both in this project). task_id stays blocked until " +
        "depends_on is done. Cycles are rejected.",
      inputSchema: { task_id: z.number().int().positive(), depends_on: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskDepend(c, ctx, { task_id: a.task_id as number, depends_on: a.depends_on as number })),
  );

  reg(
    "task_undepend",
    {
      description: "Remove a dependency edge (task_id no longer depends on depends_on).",
      inputSchema: { task_id: z.number().int().positive(), depends_on: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskUndepend(c, ctx, { task_id: a.task_id as number, depends_on: a.depends_on as number })),
  );

  reg(
    "task_block",
    {
      description:
        "Record a manual wait on a NON-task thing. The task shows blocked until you task_resolve it. For a " +
        "dependency on another task use task_depend instead - that one clears itself when the target ships. " +
        "This one does NOT: nothing lifts a manual block automatically, so it also requires what would lift " +
        "it (unblock_condition) and who owns lifting it (unblock_owner for an agent, or unblock_human for a " +
        "person). The owner need not be the final assignee - it is whoever has to process it next.",
      inputSchema: {
        task_id: z.number().int().positive(),
        reason: z.string().min(1).max(500),
        unblock_condition: z.string().min(1).max(500).optional(),
        unblock_owner: z.string().max(64).optional(),
        unblock_human: z.string().max(64).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        taskBlock(c, ctx, {
          task_id: a.task_id as number,
          reason: a.reason as string,
          unblock_condition: a.unblock_condition as string | undefined,
          unblock_owner: a.unblock_owner as string | undefined,
          unblock_human: a.unblock_human as string | undefined,
        }),
      ),
  );

  reg(
    "task_resolve",
    {
      description:
        "Clear a task's manual blocker(s). It returns to its base status automatically once no manual block and " +
        "no unmet dependency remain.",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskResolve(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "task_cancel",
    {
      description: "Cancel a task (soft, keeps history): any non-terminal → cancelled. Use for redundant / won't-do work.",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskCancel(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "task_reopen",
    {
      description: "Reopen a done/cancelled task back to todo (clears any recorded decision answer).",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a, ctx) => withTx((c) => taskReopen(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "list_tasks",
    {
      description:
        "The task INDEX for this project. Defaults are cheap on purpose: OPEN tasks only, with each body cut " +
        "to a ~140-char preview (`detail_truncated` + `detail_chars` mark a cut one). To READ a body, name it: " +
        "`task_ids:[12,15]` returns those tasks in FULL, whatever their state - that is the intended way to go " +
        "from index to document, and it is cheaper than widening the list. Filter with status/owner/lane, or " +
        "`mine:true` for tasks assigned to you. Be deliberately verbose when you want it: `detail:\"full\"` " +
        "(every body in full - this was the old default and can be very large), `detail:\"none\"` (titles only), " +
        "`all_states:true` (include done/cancelled). `blocked` is derived (an unmet dependency or an open manual " +
        "block). A decision task carries `options`; once answered it also carries `selected_option` + " +
        "`answer_note`, so read the answer here. Rows are ACTIONABLE-FIRST then newest, so a limit can only cut " +
        "the archive, never open work; if it cuts, `truncated` says so. For just YOUR plate, whats_new already " +
        "pushes my_open_tasks - no call needed.",
      inputSchema: {
        status: z.enum(["todo", "in_progress", "blocked", "done", "cancelled"]).optional(),
        owner: z.string().max(64).optional(),
        lane: z.string().max(64).optional(),
        mine: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
        detail: z.enum(["preview", "full", "none"]).optional(),
        all_states: z.boolean().optional(),
        // Accepts an array OR a comma-separated string: the primary client sends "[536]" as a string, and a
        // parameter the main client cannot express is a parameter that does not exist (decision 064).
        task_ids: z
          .union([z.array(z.number().int().positive()).max(MAX_TASK_IDS), z.string().max(400)])
          .optional(),
      },
    },
    // Decision 062: fetch ONE past the limit to learn, exactly rather than by inference, whether the page cut
    // anything - a caller cannot tell a full page from a truncated one, and a silently short list is how work
    // goes missing. Paired with the actionable-first ordering, a cut is provably archive-only, so the note can
    // promise that instead of vaguely warning.
    async (a, ctx) => {
      const limit = (a.limit as number | undefined) ?? LIST_TASKS_DEFAULT_LIMIT;
      const rows = await listTasks(ctx, {
        status: a.status as string | undefined,
        owner: a.owner as string | undefined,
        lane: a.lane as string | undefined,
        mine: a.mine as boolean | undefined,
        detail: a.detail as DetailMode | undefined,
        all_states: a.all_states as boolean | undefined,
        task_ids: a.task_ids,
        limit: limit + 1,
      });
      // A body was cut, so the response must say how to get the whole one. An MCP client caches the tool
      // list - including inputSchema - at CONNECT time, and the stateless transport (decision 030) has no
      // session on which to send tools/list_changed. So an agent connected before a parameter shipped is
      // never TOLD the parameter exists. It can still send it - measured: the SDK client transmits an
      // argument absent from its cached schema and the server receives it (guarded in smoke.mcp) - it just
      // has no reason to try. That makes the gap informational, not mechanical, which is why naming the
      // parameter on the response is a complete fix and not a workaround: the note travels on a channel
      // no cache can stale, and knowing is the only thing the caller was missing.
      const anyCut = rows.some((r) => (r as { detail_truncated?: true }).detail_truncated);
      const readBody = anyCut
        ? {
            reading_a_full_body: `Bodies here are previews. Ask for one with task_ids:[<id>] - send it even if you do not see \`task_ids\` listed on this tool, because a tool schema is cached from when you connected and may predate the parameter. If your client refuses to send it, reconnect the MCP server once and it will appear.`,
          }
        : {};
      if (rows.length <= limit) return { tasks: rows, ...readBody };
      return {
        tasks: rows.slice(0, limit),
        ...readBody,
        truncated: `More than ${limit} tasks match; older ones were cut (open work is never cut - it sorts first). Raise \`limit\`, or filter by \`status\`/\`owner\`/\`lane\`.`,
      };
    },
  );

  // ── Query + digest ─────────────────────────────────────────────────
  reg(
    "query_events",
    {
      description: "Query the append-only ledger with exact filters (no semantic search). AND-combined; newest first.",
      inputSchema: {
        actor: z.string().max(64).optional(),
        type: z
          .enum([
            "claim", "seed", "register", "post", "ack", "lease", "release",
            "task_create", "task_assign", "task_start", "task_stop", "task_block", "task_resolve", "task_ship",
            "task_review_request", "task_review_answer",
            "task_cancel", "task_reopen", "task_edit", "task_depend", "task_undepend", "task_answer",
          ])
          .optional(),
        sequence: z.string().max(64).optional(),
        ref: z.string().max(120).optional(),
        tag: z.string().max(64).optional(),
        since: isoDateTime.optional(),
        until: isoDateTime.optional(),
        last_n: z.number().int().positive().max(1000).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (a, ctx) => ({ events: await queryEvents(ctx, a as Record<string, never>) }),
  );

  reg(
    "whats_new",
    {
      description: "Session-start digest: new events since your cursor + unread posts, active leases, your open tasks (my_open_tasks) and grabbable work (open_unassigned), other agents active right now (active_participants + active_peers), and latest claim per sequence. Advances your cursor, so `events` is empty on a repeat call - that is NOT 'the bus is empty': active_participants/unread_posts/my_open_tasks are current-state and re-surface every call (use who_is_active / read_posts for the live picture). On your first check-in it also returns a one-time `welcome` orientation, and it may carry a one-time `announcements` array - server notices about a newly launched capability, delivered once per agent (read each and act on it if it applies).",
      inputSchema: {
        advance_cursor: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    (a, ctx) =>
      withTx((c) =>
        whatsNew(c, ctx, {
          advance_cursor: a.advance_cursor as boolean | undefined,
          limit: a.limit as number | undefined,
        }),
      ),
  );

  reg(
    "latest_claims",
    {
      description:
        "Latest number per sequence in this workspace, read from the AUTHORITATIVE counter (agrees with " +
        "list_sequences; survives a ledger flush). Each carries `formatted` (bare local id) + `qualified` (the " +
        "cross-project id <ownerHandle>/<slug>#<id>). `by`/`at` show who/when from the most recent claim event, " +
        "or null if the ledger was flushed. A fast collision audit; never empty when sequences exist.",
      inputSchema: {},
    },
    (_a, ctx) => latestClaims(ctx),
  );

  reg(
    "list_sequences",
    {
      description:
        "List this project's sequences with their shape: name, prefix, pad, last_used, next, the formatted id " +
        "the NEXT claim will return, and next_qualified (the cross-project id <ownerHandle>/<slug>#<id>). Read " +
        "this instead of guessing sequence names or prefix/pad conventions; if the sequence you need is " +
        "missing, ask before seeding.",
      inputSchema: {},
    },
    async (_a, ctx) => {
      const res = await query<{ name: string; prefix: string; pad: number; current: string }>(
        `SELECT name, prefix, pad, current FROM sequences WHERE project_id = $1 ORDER BY name`,
        [ctx.project.id],
      );
      return {
        sequences: res.rows.map((r) => {
          const lastUsed = Number(r.current);
          const nextFormatted = formatId(r.prefix, Number(r.pad), lastUsed + 1);
          return {
            name: r.name,
            prefix: r.prefix,
            pad: Number(r.pad),
            last_used: lastUsed,
            next: lastUsed + 1,
            next_formatted: nextFormatted,
            next_qualified: qualifyId(ctx.project.ownerHandle, ctx.project.slug, nextFormatted),
          };
        }),
      };
    },
  );

  reg(
    "whoami",
    {
      description:
        "Return your resolved identity: qualified actor (handle/label), the project you are acting in, the admin flag THERE, and `other_projects` - the other projects this one connection can act in by passing `project:` (decision 070). Your actor name and admin flag are per project, so they can differ between them.",
      inputSchema: {},
    },
    // is_admin is read LIVE (not the connect-time snapshot) so it matches list_participants immediately
    // after an owner grants/revokes admin - no session reconnect needed.
    async (_a, ctx) => {
      const reach = await listProjects(ctx);
      return {
        actor: ctx.actor,
        handle: ctx.participant.handle,
        label: ctx.participant.name,
        project: ctx.project.slug,
        is_admin: await liveIsAdmin(ctx.participation.id),
        default_project: baseCtx.project.slug,
        other_projects: reach.filter((p) => p.project !== ctx.project.slug).map((p) => p.project),
      };
    },
  );

  reg(
    "list_projects",
    {
      description:
        "Every project THIS ONE CONNECTION can work in, and what is waiting in each (unread_posts, open_tasks). One token spans every project THIS AGENT has been added to (decision 070, narrowed by 077 - a token never borrows another of your agents' seats, so what it reaches is exactly where IT was added). Pass `project:\"<slug>\"` on ANY tool to act in one of these instead of your default; omit it and you act in your default as before. `you` is your actor name in that project and `is_admin` is your role THERE, both of which can differ per project. Use `qualified` if two of your projects share a slug. This lists ONLY your own memberships and can never reveal a project you are not in.",
      inputSchema: {},
    },
    async (_a, ctx) => ({
      projects: await listProjects(ctx),
      note: "Put project-oriented work in its own project. To act elsewhere add project:\"<slug>\" to the call - the response then echoes _project so a cross-project call never looks local.",
    }),
  );

  reg(
    "guide",
    {
      description:
        "Return the current LLM Bus coordination protocol - how to use tasks, decisions, claims, leases, handoffs, presence, and the human Board that a project's operator watches. Pull this any time your CLAUDE.md may be out of date; append it and follow it.",
      inputSchema: {},
    },
    async (_a, ctx) => ({ protocol: coordinationGuide(await liveIsAdmin(ctx.participation.id)) }),
  );

  // ── Retirement tombstones (decision 040, TRANSITIONAL) ─────────────
  // review/answer_review/ack were removed in v2 (decision 039). An MCP client that cached the pre-v2 tool
  // list still calls them; with the tools simply absent, the host surfaces that as "the MCP server
  // disconnected" - and a reconnecting agent (and a peer on its project) burned real time chasing a phantom
  // infra gap (project-b field report). These stubs answer that cached call ONCE with a redirect to the
  // replacement, turning a mis-diagnosis into a single round trip. Schemas accept the OLD args (optional,
  // permissive) so a cached call reaches the handler instead of failing validation first. Remove this whole
  // block after the migration window (every active agent has reconnected) - tracked in PLAN.md.
  // Each tombstone is registered explicitly (not via a shared helper) so the static tool-count check
  // in scripts/check-doc-counts.mjs, which counts registration literals, stays accurate at 36 this window.
  const retired = (message: string) => async (): Promise<never> => {
    throw new Error(message);
  };
  const REVIEW_MSG =
    "review is retired. A decision/signoff is now a TASK with options: task_create(title, detail?, " +
    'options:["a","b",...], links?:[{label,url}]), then task_assign it to whoever decides (an agent, or ' +
    "human:<handle>); they call task_answer. Reconnect the llm-bus MCP server (in Claude Code: /mcp, toggle " +
    "llm-bus off then on) to refresh your tool list, and pull guide() for the current protocol.";
  const ANSWER_REVIEW_MSG =
    "answer_review is retired. Answer a decide-this task with task_answer(task_id, option?, note?) - it " +
    "records the choice, completes the task, and unblocks every task that task_depend-s on it. Reconnect the " +
    "llm-bus MCP server to refresh your tools; see guide().";
  const ACK_MSG =
    "ack is retired. Reading a post addressed to you (read_posts to_me=true) now MARKS IT READ - there is no " +
    "separate ack, and unread_posts / _unread_posts reflect what you have not read. Reconnect the llm-bus MCP " +
    "server to refresh your tools; see guide().";
  reg(
    "review",
    {
      description: `RETIRED in v2 (decision 039). ${REVIEW_MSG}`,
      inputSchema: { task_id: z.any().optional(), kind: z.any().optional(), question: z.any().optional(), options: z.any().optional(), artifact_url: z.any().optional() },
    },
    retired(REVIEW_MSG),
  );
  reg(
    "answer_review",
    {
      description: `RETIRED in v2 (decision 039). ${ANSWER_REVIEW_MSG}`,
      inputSchema: { task_id: z.any().optional(), decision: z.any().optional(), option: z.any().optional(), note: z.any().optional() },
    },
    retired(ANSWER_REVIEW_MSG),
  );
  reg(
    "ack",
    {
      description: `RETIRED in v2 (decision 039). ${ACK_MSG}`,
      inputSchema: { post_id: z.any().optional() },
    },
    retired(ACK_MSG),
  );

  // ── Admin (project-scoped) ─────────────────────────────────────────
  // Read-only roster of THIS project - call before admin_provision to avoid duplicates.
  reg(
    "list_participants",
    {
      description:
        "The roster of THIS project: its AGENTS (assign with `owner:`) AND its HUMAN members (assign with " +
        "`human:`). Each row carries `assign_with` naming the field that actually routes to it - a person's " +
        "work goes to `human:` (they act on the web board); only an agent process polls `owner:`. Humans " +
        "hold no token. Use before admin_provision to avoid creating a duplicate.",
      inputSchema: {},
    },
    // Isolation lives in the query (both branches pinned to the token-derived project) and is guarded by
    // isolation.project; see domain/roster.ts.
    async (_a, ctx) => ({ participants: await listRoster(ctx) }),
  );

  reg(
    "admin_provision",
    {
      description:
        "Project-admin only: create (or re-token) one of YOUR OWN agents in THIS project - bound to you as " +
        "its human (decision 038) - and mint its bearer token + a ready connection config (shown ONCE). For a " +
        "HUMAN teammate who signs in as themselves, use create_invite instead (they become a project member, " +
        "so tasks can be assigned to them). Hand the returned `setup` to the agent. Lane is optional and " +
        "ROUTES: lane mail reaches them on it immediately, until they register with a different one. " +
        "Set is_admin only for another lead.",
      inputSchema: {
        participant_name: z.string().min(1).max(64),
        lane: z.string().min(1).max(64).optional(),
        is_admin: z.boolean().optional(),
      },
    },
    async (a, ctx) => {
      if (!(await liveIsAdmin(ctx.participation.id)))
        throw new Error("admin_provision: requires a project-admin token");
      const name = a.participant_name as string;
      // Decision 057: provisioning creates an AGENT (a human teammate joins via create_invite as a member).
      const kind = "agent";
      const lane = (a.lane as string | undefined) ?? null;
      const isAdmin = (a.is_admin as boolean | undefined) ?? false;
      const token = randomBytes(32).toString("base64url");
      return withTx(async (c) => {
        const participant = await c.query<{ id: string }>(
          `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
           ON CONFLICT (owner_id, name) DO UPDATE SET kind = EXCLUDED.kind
           RETURNING id`,
          [ctx.project.ownerId, name, kind],
        );
        const participation = await c.query<{ id: string }>(
          // human_owner_id = the provisioning owner (decision 038): a provisioned agent belongs to the human
          // who runs the project, so it is never a human-less agent and can be surfaced on their own board.
          // COALESCE on conflict never un-binds an agent already bound to a specific human (e.g. via /accept).
          `INSERT INTO participations (participant_id, project_id, lane, is_admin, human_owner_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (participant_id, project_id)
             DO UPDATE SET is_admin = participations.is_admin OR $4,
                           lane = COALESCE(EXCLUDED.lane, participations.lane),
                           human_owner_id = COALESCE(participations.human_owner_id, EXCLUDED.human_owner_id)
           RETURNING id`,
          [participant.rows[0].id, ctx.project.id, lane, isAdmin, ctx.project.ownerId],
        );
        await c.query(`INSERT INTO tokens (participation_id, token_hash) VALUES ($1, $2)`, [
          participation.rows[0].id,
          hashToken(token),
        ]);
        return {
          project: ctx.project.slug,
          participant: name,
          kind,
          lane,
          is_admin: isAdmin,
          token,
          setup: {
            note: "Give this to the teammate (token shown once): set the env var where they run, add mcp_json to their repo root.",
            mcp_url: MCP_URL,
            env: `export LLM_BUS_TOKEN=${token}`,
            mcp_json: {
              mcpServers: {
                "llm-bus": {
                  type: "http",
                  url: MCP_URL,
                  headers: { Authorization: "Bearer ${LLM_BUS_TOKEN}" },
                },
              },
            },
          },
        };
      });
    },
  );

  reg(
    "create_invite",
    {
      description:
        "Project-admin only: invite a HUMAN teammate by email (decision 037). Creates a TARGETED invite and " +
        "returns an /accept link; they sign in (SSO) to accept, which binds their agent to THEIR identity and " +
        "makes them a project member - so a task can be assigned to them (and they drive tasks from /admin/tasks). The token reaches them via the " +
        "link, never through you. Emailed automatically if SMTP is configured; otherwise relay accept_url.",
      inputSchema: {
        to_email: z.string().email().max(200),
        participant_name: z.string().min(1).max(64).optional(),
        lane: z.string().min(1).max(64).optional(),
        is_admin: z.boolean().optional(),
        ttl_hours: z.number().int().min(1).max(720).optional(),
      },
    },
    async (a, ctx) => {
      if (!(await liveIsAdmin(ctx.participation.id)))
        throw new Error("create_invite: requires a project-admin token");
      const toEmail = (a.to_email as string).trim().toLowerCase();
      const name = (a.participant_name as string | undefined) ?? null;
      const ttlHours = (a.ttl_hours as number | undefined) ?? 168;
      const isAdmin = (a.is_admin as boolean | undefined) ?? false;
      const inv = await createOrgInvite(ctx.project.ownerId, ctx.project.id, {
        targetEmail: toEmail,
        intendedName: name,
        lane: a.lane as string | undefined,
        isAdmin,
        ttlHours,
      });
      if (!inv) throw new Error("create_invite: project not found");
      const cfg = loadConfig();
      // The accept flow lives on the ADMIN host (OAUTH_REDIRECT_BASE, e.g. admin.example.com) at /admin/accept,
      // NOT the MCP host (PUBLIC_URL). This is the SAME URL notifyInvite emails, so the relay link matches.
      const acceptUrl = `${(cfg.OAUTH_REDIRECT_BASE ?? cfg.PUBLIC_URL).replace(/\/+$/, "")}/admin/accept?token=${encodeURIComponent(inv.token)}`;
      // Best-effort email (fail-open, invariant 5); the accept link is returned regardless so you can relay it.
      void notifyInvite(toEmail, ctx.participant.handle ?? "a teammate", ctx.project.name, inv.token);
      return {
        accept_url: acceptUrl,
        to_email: toEmail,
        expires_at: inv.expiresAt,
        note: `Send ${toEmail} the accept_url. They sign in to accept, which binds their agent to their own identity and adds them as a project member. Emailed automatically if SMTP is up.`,
      };
    },
  );

  reg(
    "admin_revoke",
    {
      description:
        "Project-admin only: revoke a teammate's active token(s) in THIS project, by participant name. " +
        "Scoped to your project; their history is preserved; they are locked out until re-granted or rotated. " +
        "A name is not an identity - if it belongs to more than one person here the call is REFUSED and names " +
        "them, rather than revoking both. The reply carries `actor`, the QUALIFIED identity you just locked " +
        "out, so check it: a bare name can be someone else's live rig. Returns the count revoked " +
        "(0 = no such participant here / nothing active).",
      inputSchema: { participant_name: z.string().min(1).max(64) },
    },
    async (a, ctx) => {
      if (!(await liveIsAdmin(ctx.participation.id)))
        throw new Error("admin_revoke: requires a project-admin token");
      const name = a.participant_name as string;
      // Scope strictly to this project, and to exactly ONE participation (never accept a participation id
      // from input). The old version updated EVERY row matching the name, which on a shared name meant
      // revoking a different person's live rig as a side effect of revoking your own retired one.
      const target = await resolveOneParticipant(ctx.project.id, name, "admin_revoke");
      // No such participant HERE stays `revoked: 0` rather than an error - the long-standing contract, and
      // what cross-project isolation is asserted through (a name that exists only in another project must
      // read exactly like one that exists nowhere).
      if (!target) return { project: ctx.project.slug, participant: name, actor: null, revoked: 0 };
      const res = await query(
        `UPDATE tokens SET revoked_at = now() WHERE participation_id = $1 AND revoked_at IS NULL`,
        [target.participationId],
      );
      // `actor` is the qualified identity, so the caller can see WHOSE access they just changed rather
      // than only the name they typed.
      return { project: ctx.project.slug, participant: name, actor: target.actor, revoked: res.rowCount ?? 0 };
    },
  );

  reg(
    "admin_rotate",
    {
      description:
        "Project-admin only: rotate a teammate's token in THIS project, by participant name - mint a fresh " +
        "token THEN revoke the old one(s) in one transaction (no lockout gap). An ambiguous name is REFUSED " +
        "rather than resolved arbitrarily. The reply carries `actor`, the qualified identity affected. " +
        "Returns the new token + a ready connection config (shown ONCE); hand the returned `setup` to them.",
      inputSchema: { participant_name: z.string().min(1).max(64) },
    },
    async (a, ctx) => {
      if (!(await liveIsAdmin(ctx.participation.id)))
        throw new Error("admin_rotate: requires a project-admin token");
      const name = a.participant_name as string;
      const token = randomBytes(32).toString("base64url");
      const newHash = hashToken(token);
      return withTx(async (c) => {
        // Resolve within THIS project only (identity from token), and REFUSE an ambiguous name rather
        // than taking rows[0] - the old code silently re-tokened an arbitrary one of two people sharing
        // a name, which is a lockout for whichever of them lost the coin toss.
        const target = await resolveOneParticipant(ctx.project.id, name, "admin_rotate");
        if (!target) throw new Error("admin_rotate: no such participant in this project");
        const sel = await c.query<{ id: string; is_admin: boolean }>(
          `SELECT pa.id, pa.is_admin FROM participations pa WHERE pa.id = $1 FOR UPDATE OF pa`,
          [target.participationId],
        );
        if (sel.rows.length === 0) throw new Error("admin_rotate: no such participant in this project");
        const participationId = sel.rows[0].id;
        // MINT first, THEN revoke the old set (never the freshly minted row).
        await c.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, 'mcp rotate')`, [
          participationId,
          newHash,
        ]);
        await c.query(
          `UPDATE tokens SET revoked_at = now()
            WHERE participation_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
          [participationId, newHash],
        );
        return {
          project: ctx.project.slug,
          participant: name,
          actor: target.actor,
          is_admin: sel.rows[0].is_admin,
          token,
          setup: {
            note: "Give this to the teammate (token shown once): set the env var where they run, add mcp_json to their repo root.",
            mcp_url: MCP_URL,
            env: `export LLM_BUS_TOKEN=${token}`,
            mcp_json: {
              mcpServers: {
                "llm-bus": {
                  type: "http",
                  url: MCP_URL,
                  headers: { Authorization: "Bearer ${LLM_BUS_TOKEN}" },
                },
              },
            },
          },
        };
      });
    },
  );

  return server;
}
