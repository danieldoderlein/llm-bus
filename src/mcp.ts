import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "./context.js";
import { query, withTx } from "./db.js";
import { touchPresence } from "./presence-mw.js";
import { hashToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createInvite, buildInvitePrompt } from "./invite.js";
import { claimSequence, seedSequence, formatId } from "./domain/claim.js";
import { register, whoIsActive } from "./domain/presence.js";
import { post, readPosts, ack, unackedCount } from "./domain/post.js";
import { acquireLease, release, whoHolds } from "./domain/lease.js";
import {
  taskCreate,
  taskAssign,
  taskStart,
  taskBlock,
  taskResolve,
  taskShip,
  listTasks,
} from "./domain/task.js";
import { queryEvents } from "./domain/query.js";
import { whatsNew, latestClaims } from "./domain/digest.js";

const SERVER_VERSION = "2.0.0-rc.0";

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
export function buildServer(ctx: Ctx): McpServer {
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
  const SELF_REPORTING = new Set(["read_posts", "ack", "whats_new"]);
  const reg = (
    name: string,
    config: ToolConfig,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    register2.call(server, name, config, async (args) => {
      await touchPresence(ctx);
      const data = await handler(args ?? {});
      // Push, don't ask for polling (Q&A finding: agents react to what rides a channel they
      // already read; they do not spontaneously poll). Surface the unread-post count on every
      // tool response, but only when non-zero and the tool does not already report it.
      if (!SELF_REPORTING.has(name) && data && typeof data === "object" && !Array.isArray(data)) {
        try {
          const unread = await unackedCount(ctx);
          if (unread > 0) {
            return ok({ ...(data as Record<string, unknown>), _unread_posts: unread });
          }
        } catch {
          // unread surfacing is best-effort; never fail the actual tool call over it
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
        "Atomically allocate the next number for a sequence (e.g. ADR/migration). Returns the FORMATTED id to write. Collision-free across all callers; the sole source of the number.",
      inputSchema: {
        sequence: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
        note: z.string().max(500).optional(),
      },
    },
    (a) => withTx((c) => claimSequence(c, ctx, { sequence: a.sequence as string, note: a.note as string | undefined })),
  );

  reg(
    "seed_sequence",
    {
      description:
        "Initialize/seed a sequence at an existing offset and set its format (prefix + zero-pad), e.g. seed 'adr' at 102 with prefix 'R'. Never rewinds a counter.",
      inputSchema: {
        sequence: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
        current: z.number().int().nonnegative(),
        prefix: z.string().max(16).optional(),
        pad: z.number().int().min(0).max(12).optional(),
      },
    },
    (a) =>
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
      description: "Announce your presence in a lane with an optional short status (who-owns-what + liveness).",
      inputSchema: { lane: z.string().min(1).max(64), status: z.string().max(140).optional() },
    },
    (a) => withTx((c) => register(c, ctx, { lane: a.lane as string, status: a.status as string | undefined })),
  );

  reg(
    "who_is_active",
    {
      description: "List actors seen within the liveness window (lane-scoped if `lane` is given). Check before touching a shared surface.",
      inputSchema: {
        lane: z.string().max(64).optional(),
        within_seconds: z.number().int().positive().max(86400).optional(),
      },
    },
    async (a) => ({
      active: await whoIsActive(ctx, {
        lane: a.lane as string | undefined,
        within_seconds: a.within_seconds as number | undefined,
      }),
    }),
  );

  // ── Prose handoffs ─────────────────────────────────────────────────
  reg(
    "post",
    {
      description: "Send an attributable prose note/handoff to a lane and/or actor, with optional subject/ref/tag.",
      inputSchema: {
        to_lane: z.string().max(64).optional(),
        to_actor: z.string().max(64).optional(),
        subject: z.string().max(200).optional(),
        body: z.string().min(1).max(8000),
        ref: z.string().max(120).optional(),
        tag: z.string().max(64).optional(),
      },
    },
    (a) =>
      withTx((c) =>
        post(c, ctx, {
          to_lane: a.to_lane as string | undefined,
          to_actor: a.to_actor as string | undefined,
          subject: a.subject as string | undefined,
          body: a.body as string,
          ref: a.ref as string | undefined,
          tag: a.tag as string | undefined,
        }),
      ),
  );

  reg(
    "read_posts",
    {
      description: "Read prose posts in this workspace. `to_me` = addressed to you or your lane; `unacked_only` for your inbox.",
      inputSchema: {
        to_lane: z.string().max(64).optional(),
        to_me: z.boolean().optional(),
        tag: z.string().max(64).optional(),
        ref: z.string().max(120).optional(),
        unacked_only: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (a) => ({
      posts: await readPosts(ctx, {
        to_lane: a.to_lane as string | undefined,
        to_me: a.to_me as boolean | undefined,
        tag: a.tag as string | undefined,
        ref: a.ref as string | undefined,
        unacked_only: a.unacked_only as boolean | undefined,
        limit: a.limit as number | undefined,
      }),
    }),
  );

  reg(
    "ack",
    {
      description: "Acknowledge a post (read receipt). Idempotent.",
      inputSchema: { post_id: z.number().int().positive() },
    },
    (a) => withTx((c) => ack(c, ctx, a.post_id as number)),
  );

  // ── Advisory leases ────────────────────────────────────────────────
  reg(
    "lease",
    {
      description: "Advisory lease on a surface (file/path) — visibility, not a hard lock. Returns current overlapping holders.",
      inputSchema: {
        surface: z.string().min(1).max(200),
        ttl_seconds: z.number().int().positive().max(86400).optional(),
        note: z.string().max(200).optional(),
      },
    },
    (a) =>
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
    (a) => withTx((c) => release(c, ctx, a.surface as string)),
  );

  reg(
    "who_holds",
    {
      description: "List active advisory leases in this workspace (optionally for one surface).",
      inputSchema: { surface: z.string().max(200).optional() },
    },
    async (a) => ({ leases: await whoHolds(ctx, a.surface as string | undefined) }),
  );

  // ── Task graph ─────────────────────────────────────────────────────
  reg(
    "task_create",
    {
      description: "Create a task (open, or assigned if an owner is given).",
      inputSchema: {
        title: z.string().min(1).max(200),
        detail: z.string().max(4000).optional(),
        lane: z.string().max(64).optional(),
        owner: z.string().max(64).optional(),
      },
    },
    (a) =>
      withTx((c) =>
        taskCreate(c, ctx, {
          title: a.title as string,
          detail: a.detail as string | undefined,
          lane: a.lane as string | undefined,
          owner: a.owner as string | undefined,
        }),
      ),
  );

  reg(
    "task_assign",
    {
      description: "Assign a task to an owner (open/assigned → assigned).",
      inputSchema: { task_id: z.number().int().positive(), owner: z.string().min(1).max(64) },
    },
    (a) => withTx((c) => taskAssign(c, ctx, { task_id: a.task_id as number, owner: a.owner as string })),
  );

  reg(
    "task_start",
    {
      description: "Start a task (assigned → in_progress).",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a) => withTx((c) => taskStart(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "task_block",
    {
      description: "Mark a task blocked, optionally on another task id, with a reason (in_progress → blocked).",
      inputSchema: {
        task_id: z.number().int().positive(),
        on: z.number().int().positive().optional(),
        reason: z.string().min(1).max(500),
      },
    },
    (a) =>
      withTx((c) =>
        taskBlock(c, ctx, {
          task_id: a.task_id as number,
          on: a.on as number | undefined,
          reason: a.reason as string,
        }),
      ),
  );

  reg(
    "task_resolve",
    {
      description: "Resolve a task's blocker(s); returns to in_progress when none remain.",
      inputSchema: { task_id: z.number().int().positive(), blocker: z.number().int().positive().optional() },
    },
    (a) =>
      withTx((c) =>
        taskResolve(c, ctx, { task_id: a.task_id as number, blocker: a.blocker as number | undefined }),
      ),
  );

  reg(
    "task_ship",
    {
      description: "Ship a task (in_progress → done).",
      inputSchema: { task_id: z.number().int().positive() },
    },
    (a) => withTx((c) => taskShip(c, ctx, { task_id: a.task_id as number })),
  );

  reg(
    "list_tasks",
    {
      description: "List tasks in this workspace (filter by status/owner/lane), each with its open-blocker count.",
      inputSchema: {
        status: z.enum(["open", "assigned", "in_progress", "blocked", "done"]).optional(),
        owner: z.string().max(64).optional(),
        lane: z.string().max(64).optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (a) => ({
      tasks: await listTasks(ctx, {
        status: a.status as string | undefined,
        owner: a.owner as string | undefined,
        lane: a.lane as string | undefined,
        limit: a.limit as number | undefined,
      }),
    }),
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
            "task_create", "task_assign", "task_start", "task_block", "task_resolve", "task_ship",
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
    async (a) => ({ events: await queryEvents(ctx, a as Record<string, never>) }),
  );

  reg(
    "whats_new",
    {
      description: "Session-start digest: everything since your cursor + unacked posts, active leases, and latest claim per sequence. Advances your cursor.",
      inputSchema: {
        advance_cursor: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    (a) =>
      withTx((c) =>
        whatsNew(c, ctx, {
          advance_cursor: a.advance_cursor as boolean | undefined,
          limit: a.limit as number | undefined,
        }),
      ),
  );

  reg(
    "latest_claims",
    { description: "Latest claimed number per sequence in this workspace (fast collision audit).", inputSchema: {} },
    () => latestClaims(ctx),
  );

  reg(
    "list_sequences",
    {
      description:
        "List this project's sequences with their shape: name, prefix, pad, last_used, next, and the " +
        "formatted id the NEXT claim will return. Read this instead of guessing sequence names or " +
        "prefix/pad conventions; if the sequence you need is missing, ask before seeding.",
      inputSchema: {},
    },
    async () => {
      const res = await query<{ name: string; prefix: string; pad: number; current: string }>(
        `SELECT name, prefix, pad, current FROM sequences WHERE project_id = $1 ORDER BY name`,
        [ctx.project.id],
      );
      return {
        sequences: res.rows.map((r) => {
          const lastUsed = Number(r.current);
          return {
            name: r.name,
            prefix: r.prefix,
            pad: Number(r.pad),
            last_used: lastUsed,
            next: lastUsed + 1,
            next_formatted: formatId(r.prefix, Number(r.pad), lastUsed + 1),
          };
        }),
      };
    },
  );

  reg(
    "whoami",
    { description: "Return your resolved identity: qualified actor (handle/label), project, and admin flag.", inputSchema: {} },
    () =>
      Promise.resolve({
        actor: ctx.actor,
        handle: ctx.participant.handle,
        label: ctx.participant.name,
        project: ctx.project.slug,
        is_admin: ctx.participation.isAdmin,
      }),
  );

  // ── Admin (project-scoped) ─────────────────────────────────────────
  // Read-only roster of THIS project — call before admin_provision to avoid duplicates.
  reg(
    "list_participants",
    {
      description:
        "List every participant granted into THIS project (the roster): name, kind, lane, admin flag, " +
        "and whether their token is active. Use before admin_provision to avoid creating a duplicate.",
      inputSchema: {},
    },
    async () => {
      const res = await query<{
        name: string;
        actor: string;
        kind: string;
        lane: string | null;
        is_admin: boolean;
        token_active: boolean;
      }>(
        // `name` is the bare label (for provisioning/dedup); `actor` is the qualified handle/label (the
        // bus identity). Both returned so the roster reads consistently with the rest of the bus.
        `SELECT pt.name, COALESCE(o.username || '/' || pt.name, pt.name) AS actor, pt.kind, pa.lane, pa.is_admin,
                EXISTS(SELECT 1 FROM tokens t WHERE t.participation_id = pa.id AND t.revoked_at IS NULL) AS token_active
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
           JOIN owners o ON o.id = pt.owner_id
          WHERE pa.project_id = $1
          ORDER BY pt.name`,
        [ctx.project.id],
      );
      return { participants: res.rows };
    },
  );

  reg(
    "admin_provision",
    {
      description:
        "Project-admin only: create (or re-token) a teammate participant in THIS project and mint its " +
        "bearer token + a ready connection config (shown ONCE). Hand the returned `setup` to the teammate. " +
        "Lane is an optional label (does not partition anything). Set is_admin only for another lead.",
      inputSchema: {
        participant_name: z.string().min(1).max(64),
        kind: z.enum(["agent", "human"]).optional(),
        lane: z.string().min(1).max(64).optional(),
        is_admin: z.boolean().optional(),
      },
    },
    async (a) => {
      if (!ctx.participation.isAdmin) throw new Error("admin_provision: requires a project-admin token");
      const name = a.participant_name as string;
      const kind = (a.kind as "agent" | "human" | undefined) ?? "agent";
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
          `INSERT INTO participations (participant_id, project_id, lane, is_admin) VALUES ($1, $2, $3, $4)
           ON CONFLICT (participant_id, project_id)
             DO UPDATE SET is_admin = participations.is_admin OR $4,
                           lane = COALESCE(EXCLUDED.lane, participations.lane)
           RETURNING id`,
          [participant.rows[0].id, ctx.project.id, lane, isAdmin],
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
        "Project-admin only: mint a project invite + a copy-paste onboarding prompt to send a teammate. " +
        "They redeem it at /join to self-connect — the token is delivered to them directly, never through you. " +
        "Omit participant_name to let them choose their own name.",
      inputSchema: {
        participant_name: z.string().min(1).max(64).optional(),
        kind: z.enum(["agent", "human"]).optional(),
        lane: z.string().min(1).max(64).optional(),
        is_admin: z.boolean().optional(),
        uses: z.number().int().min(1).max(50).optional(),
        ttl_hours: z.number().int().min(1).max(168).optional(),
      },
    },
    async (a) => {
      if (!ctx.participation.isAdmin) throw new Error("create_invite: requires a project-admin token");
      const name = (a.participant_name as string | undefined) ?? null;
      const ttlHours = (a.ttl_hours as number | undefined) ?? 24;
      const isAdmin = (a.is_admin as boolean | undefined) ?? false;
      const inv = await createInvite(ctx.project.ownerId, ctx.project.id, {
        name,
        kind: a.kind as "agent" | "human" | undefined,
        lane: a.lane as string | undefined,
        isAdmin,
        uses: a.uses as number | undefined,
        ttlHours,
      });
      if (!inv) throw new Error("create_invite: project not found");
      const publicUrl = loadConfig().PUBLIC_URL;
      return {
        code: inv.code,
        expires_at: inv.expiresAt,
        redeem_url: publicUrl.replace(/\/+$/, "") + "/join",
        invite_prompt: buildInvitePrompt(ctx.project.name, inv.code, name, publicUrl, ttlHours, isAdmin),
      };
    },
  );

  reg(
    "admin_revoke",
    {
      description:
        "Project-admin only: revoke a teammate's active token(s) in THIS project, by participant name. " +
        "Scoped to your project; their history is preserved; they are locked out until re-granted or rotated. " +
        "Returns the count revoked (0 = no such participant here / nothing active).",
      inputSchema: { participant_name: z.string().min(1).max(64) },
    },
    async (a) => {
      if (!ctx.participation.isAdmin) throw new Error("admin_revoke: requires a project-admin token");
      const name = a.participant_name as string;
      // Scope strictly to this project; resolve by name (never accept a participation id from input).
      const res = await query(
        `UPDATE tokens t SET revoked_at = now()
           FROM participations pa
           JOIN participants pt ON pt.id = pa.participant_id
          WHERE t.participation_id = pa.id
            AND pa.project_id = $1 AND pt.name = $2 AND t.revoked_at IS NULL`,
        [ctx.project.id, name],
      );
      return { project: ctx.project.slug, participant: name, revoked: res.rowCount ?? 0 };
    },
  );

  reg(
    "admin_rotate",
    {
      description:
        "Project-admin only: rotate a teammate's token in THIS project, by participant name - mint a fresh " +
        "token THEN revoke the old one(s) in one transaction (no lockout gap). Returns the new token + a ready " +
        "connection config (shown ONCE); hand the returned `setup` to the teammate.",
      inputSchema: { participant_name: z.string().min(1).max(64) },
    },
    async (a) => {
      if (!ctx.participation.isAdmin) throw new Error("admin_rotate: requires a project-admin token");
      const name = a.participant_name as string;
      const token = randomBytes(32).toString("base64url");
      const newHash = hashToken(token);
      return withTx(async (c) => {
        // Resolve + lock the target participation within THIS project only (identity from token).
        const sel = await c.query<{ id: string; is_admin: boolean }>(
          `SELECT pa.id, pa.is_admin
             FROM participations pa
             JOIN participants pt ON pt.id = pa.participant_id
            WHERE pa.project_id = $1 AND pt.name = $2
            FOR UPDATE OF pa`,
          [ctx.project.id, name],
        );
        if (sel.rowCount === 0) throw new Error("admin_rotate: no such participant in this project");
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
