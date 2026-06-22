import { randomBytes } from "node:crypto";
import { query, withTx } from "./db.js";
import { hashToken } from "./auth.js";

// Project invite codes (a pairing / "join link" flow). An owner/lead mints a short-lived,
// project-scoped code; the invitee redeems it at the PUBLIC, rate-limited POST /join endpoint,
// which mints their participation token and returns it + ready config. The token is delivered
// server -> invitee directly; only the short code ever crosses the relay channel. createInvite/
// listInvites/revokeInvite are owner-scoped (admin). redeemInvite is public, scoped only by the
// code itself (validity + uses + expiry).

const MAX_NAME = 64;

export interface InviteRow {
  id: number;
  code: string;
  intendedName: string | null;
  kind: "agent" | "human";
  lane: string | null;
  isAdmin: boolean;
  maxUses: number;
  uses: number;
  expiresAt: string;
}

function genCode(): string {
  return randomBytes(12).toString("base64url"); // ~16 chars, unguessable; one-use + 24h-TTL + rate-limited
}

function validName(n: string | null | undefined): string | null {
  if (!n) return null;
  const t = n.trim();
  if (!t || t.length > MAX_NAME) return null;
  return t;
}

/** Mint an invite for a project (owner-scoped: the project must belong to ownerId). */
export async function createInvite(
  ownerId: number,
  projectId: number,
  opts: {
    name?: string | null;
    kind?: "agent" | "human";
    lane?: string | null;
    isAdmin?: boolean;
    uses?: number;
    ttlHours?: number;
  },
): Promise<{ id: number; code: string; expiresAt: string } | null> {
  if (!Number.isFinite(projectId)) return null;
  const code = genCode();
  const name = validName(opts.name);
  const kind = opts.kind === "human" ? "human" : "agent";
  const lane = opts.lane && opts.lane.trim() ? opts.lane.trim() : null;
  const isAdmin = opts.isAdmin === true;
  const uses = Math.min(Math.max(Math.trunc(opts.uses ?? 1), 1), 50);
  const ttl = Math.min(Math.max(Math.trunc(opts.ttlHours ?? 24), 1), 168);
  const res = await query<{ id: string; code: string; expires_at: string }>(
    `INSERT INTO join_codes (code, project_id, intended_name, kind, lane, is_admin, max_uses, expires_at)
     SELECT $1, pr.id, $3, $4, $5, $6, $7, now() + make_interval(hours => $8)
       FROM projects pr
      WHERE pr.id = $2 AND pr.owner_id = $9
     RETURNING id, code, expires_at`,
    [code, projectId, name, kind, lane, isAdmin, uses, ttl, ownerId],
  );
  if (res.rowCount === 0) return null; // project not owned
  const r = res.rows[0];
  // pg returns TIMESTAMPTZ as a Date object — normalize to an ISO string for the UI/JSON.
  return { id: Number(r.id), code: r.code, expiresAt: new Date(r.expires_at).toISOString() };
}

/** Active (un-revoked, un-expired) invites for a project (owner-scoped). */
export async function listInvites(ownerId: number, projectId: number): Promise<InviteRow[]> {
  if (!Number.isFinite(projectId)) return [];
  const res = await query<{
    id: string;
    code: string;
    intended_name: string | null;
    kind: "agent" | "human";
    lane: string | null;
    is_admin: boolean;
    max_uses: number;
    uses: number;
    expires_at: string;
  }>(
    `SELECT jc.id, jc.code, jc.intended_name, jc.kind, jc.lane, jc.is_admin, jc.max_uses, jc.uses, jc.expires_at
       FROM join_codes jc
       JOIN projects pr ON pr.id = jc.project_id
      WHERE jc.project_id = $1 AND pr.owner_id = $2 AND jc.revoked_at IS NULL AND jc.expires_at > now()
      ORDER BY jc.created_at DESC`,
    [projectId, ownerId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    intendedName: r.intended_name,
    kind: r.kind,
    lane: r.lane,
    isAdmin: r.is_admin,
    maxUses: Number(r.max_uses),
    uses: Number(r.uses),
    expiresAt: new Date(r.expires_at).toISOString(), // pg returns a Date; normalize for the UI
  }));
}

/** Revoke an invite (owner-scoped). Returns true if a row was revoked. */
export async function revokeInvite(ownerId: number, inviteId: number): Promise<boolean> {
  if (!Number.isFinite(inviteId)) return false;
  const res = await query(
    `UPDATE join_codes jc
        SET revoked_at = now()
       FROM projects pr
      WHERE jc.id = $1 AND jc.project_id = pr.id AND pr.owner_id = $2 AND jc.revoked_at IS NULL`,
    [inviteId, ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}

export type RedeemResult =
  | {
      ok: true;
      token: string;
      projectSlug: string;
      projectName: string;
      participant: string;
      created: boolean; // true = a new participant was created; false = attached to an existing one (locked name only)
      isAdmin: boolean; // the invite granted project-admin (lead) -> the guide includes admin powers
    }
  | { ok: false; error: "invalid" | "expired" | "exhausted" | "name_required" | "name_taken" };

/**
 * PUBLIC: redeem an invite code. Validates (exists, not revoked, not expired, uses remaining)
 * under a row lock, resolves the name (the code's locked name, else the redeemer's chosen one),
 * upserts the participant + participation under the project's owner, mints a token, and bumps
 * uses — all atomically. Returns the token + project info, or a typed error.
 */
export async function redeemInvite(code: string, providedName: string | null): Promise<RedeemResult> {
  if (!code || code.length > 256) return { ok: false, error: "invalid" };
  return withTx(async (c) => {
    const codeRes = await c.query<{
      id: string;
      project_id: string;
      owner_id: string;
      project_slug: string;
      project_name: string;
      intended_name: string | null;
      kind: "agent" | "human";
      lane: string | null;
      is_admin: boolean;
      max_uses: number;
      uses: number;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT jc.id, jc.project_id, pr.owner_id, pr.slug AS project_slug, pr.name AS project_name,
              jc.intended_name, jc.kind, jc.lane, jc.is_admin, jc.max_uses, jc.uses, jc.expires_at, jc.revoked_at
         FROM join_codes jc
         JOIN projects pr ON pr.id = jc.project_id
        WHERE jc.code = $1
        FOR UPDATE OF jc`,
      [code],
    );
    if (codeRes.rowCount === 0) return { ok: false, error: "invalid" };
    const jc = codeRes.rows[0];
    if (jc.revoked_at) return { ok: false, error: "invalid" };
    if (new Date(jc.expires_at).getTime() <= Date.now()) return { ok: false, error: "expired" };
    if (Number(jc.uses) >= Number(jc.max_uses)) return { ok: false, error: "exhausted" };

    const locked = validName(jc.intended_name);
    const name = locked ?? validName(providedName);
    if (!name) return { ok: false, error: "name_required" };

    // Resolve the participant. Try to create it; if the name already exists for this owner:
    //  - a LOCKED invite (the admin chose the name) attaches to that existing identity (intended);
    //  - an OPEN invite (the redeemer chose) reports name_taken WITHOUT consuming the code, so they
    //    retry with a different name. This stops a brand-new joiner silently merging into someone else.
    const ins = await c.query<{ id: string }>(
      `INSERT INTO participants (owner_id, name, kind) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO NOTHING
       RETURNING id`,
      [Number(jc.owner_id), name, jc.kind],
    );
    let participantId: number;
    let created: boolean;
    if (ins.rowCount && ins.rows[0]) {
      participantId = Number(ins.rows[0].id);
      created = true;
    } else if (locked) {
      const sel = await c.query<{ id: string }>(
        `SELECT id FROM participants WHERE owner_id = $1 AND name = $2`,
        [Number(jc.owner_id), name],
      );
      participantId = Number(sel.rows[0].id);
      created = false;
    } else {
      return { ok: false, error: "name_taken" }; // open invite + taken: retry; the code is preserved
    }

    const participation = await c.query<{ id: string }>(
      `INSERT INTO participations (participant_id, project_id, lane, is_admin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (participant_id, project_id)
         DO UPDATE SET is_admin = participations.is_admin OR $4,
                       lane = COALESCE(EXCLUDED.lane, participations.lane)
       RETURNING id`,
      [participantId, Number(jc.project_id), jc.lane, jc.is_admin],
    );
    const token = randomBytes(32).toString("base64url");
    await c.query(`INSERT INTO tokens (participation_id, token_hash, label) VALUES ($1, $2, 'invite')`, [
      participation.rows[0].id,
      hashToken(token),
    ]);
    await c.query(`UPDATE join_codes SET uses = uses + 1 WHERE id = $1`, [jc.id]);

    return {
      ok: true,
      token,
      projectSlug: jc.project_slug,
      projectName: jc.project_name,
      participant: name,
      created,
      isAdmin: jc.is_admin,
    };
  });
}

/** The coordination protocol the participant should follow (returned by /join + embedded in hand-out
 *  cards, appended to CLAUDE.md). Admin-aware: a lead also gets the "you onboard the team" section. */
export function coordinationGuide(isAdmin: boolean): string {
  const base = `## LLM Bus - coordination protocol

WHAT THIS IS FOR (the division of labor - read this first):
LLM Bus (the bus) is the source of truth for LIVE coordination and allocation: shared-sequence
claims, file leases, handoffs/asks/acks, and presence. Your git coordination file (e.g.
docs/coordination/agent-coordination.md) is the durable ARCHIVE and fail-open FALLBACK: archive
load-bearing outcomes there, and use it as the channel only when the bus is down. Allocate numbers
on the bus, never by reading a file - a number read from a file can race; a claimed number cannot.
Do not narrate the same handoff twice: post on the bus with a ref to the committed file; record the
outcome in the archive when it lands.

Rules (scoped to triggers, not blanket ceremony):
- Session start: whats_new(), who_is_active(), and read your inbox (read_posts to_me=true; ack what you read).
- Unread mail is PUSHED to you: tool responses carry "_unread_posts": N whenever you have unacked posts - when you see it, read and ack before continuing.
- Before writing a numbered file on a SHARED sequence (decisions/ADRs, migrations): claim("<sequence>") and name the file from the returned formatted id. Call list_sequences first to see the real names, prefixes, and the next id - never guess, never seed without asking. Purely local numbering that no other rig shares is NOT claimed.
- Before AND after touching a declared shared surface: check the bus; post the handoff with a ref.
- Lease a shared file for multi-step edits; release at the natural end of the work (who_holds shows expiry; a forgotten lease lapses on its own).
- Lane naming is <product>-<role> (e.g. bu2-dev, minter-marketing); lanes are addressing labels, not walls.
- One token = one identity; all your sub-agents share it (they count as one).
- The service is advisory and fail-open: if it's ever unreachable, keep working, append to the git archive, reconcile when it returns.

Knowledge layer (OKF): the bus is for LIVE coordination only - it never stores or hosts knowledge.
Durable project knowledge lives as files in this repo's git, as an OKF (Open Knowledge Format) wiki:
docs/wiki/ for a standard repo, wiki/ for a platform repo (per your repo's Genesis v1.4 §14). The bus
coordinates; the wiki records. Link decisions from the wiki, do not restate them. OKF is young - verify
the reserved filenames (index.md, log.md) and the frontmatter fields against the upstream spec
(github.com/GoogleCloudPlatform/knowledge-catalog, okf/SPEC.md) at setup; do not assume a fixed field list.`;
  if (!isAdmin) return base;
  return (
    base +
    `

### You are this project's admin (lead) - you onboard teammates
- See who's in the project: call list_participants.
- Add a teammate yourself: call create_invite(participant_name?, lane?) - it returns a ready-to-send invite (a copy-paste prompt + code) the teammate redeems to self-connect; their token never passes through you. (Or admin_provision(participant_name) to mint a teammate's token directly.)
- Leave is_admin off for normal teammates - keep one lead per project.`
  );
}

/** Build the two config files the redeemed agent writes (token via env, never committed raw). */
export function buildJoinFiles(token: string, mcpUrl: string): Record<string, string> {
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        "llm-bus": { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${LLM_BUS_TOKEN}" } },
      },
    },
    null,
    2,
  );
  const settings = JSON.stringify({ env: { LLM_BUS_TOKEN: token } }, null, 2);
  return { ".mcp.json": mcpJson, ".claude/settings.local.json": settings };
}

/** The ONE deterministic command that connects Claude Code to LLM Bus: `claude mcp add` writes a
 *  correct local-scope registration (no approval prompt, token stored outside the repo), so the user
 *  never hand-authors .mcp.json (the path that silently fails). Server name is the bare `llm-bus` -
 *  local scope is per-project, so it never collides across a user's projects (validated). */
export function buildConnectCommand(token: string, mcpUrl: string): string {
  return `claude mcp add --transport http llm-bus ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

/** The portable MCP config for non-Claude-Code clients (Cursor/Codex/Windsurf/VS Code). Token inline -
 *  keep this out of git. */
export function buildClientJson(token: string, mcpUrl: string): string {
  return JSON.stringify(
    { mcpServers: { "llm-bus": { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/** The complete, copy-paste onboarding to hand a directly-granted participant. Leads with the one
 *  deterministic command (token inline), with a non-Claude-Code fallback, then the protocol. */
export function buildHandoutPrompt(
  projectName: string,
  participantName: string,
  token: string,
  mcpUrl: string,
  isAdmin: boolean,
): string {
  return [
    `You've been added to the project "${projectName}" on LLM Bus (a shared MCP coordination server) as`,
    `"${participantName}"${isAdmin ? ", as this project's admin (lead)" : ""}. Connect in one command.`,
    ``,
    `1. Run this from your project directory. It registers LLM Bus in Claude Code with your token already`,
    `   in it - it is idempotent and stores the token outside your repo. Do NOT hand-write .mcp.json instead:`,
    ``,
    `   ${buildConnectCommand(token, mcpUrl)}`,
    ``,
    `   Not Claude Code (Cursor / Codex / Windsurf / VS Code)? Add this to your client's MCP config and`,
    `   keep it out of git:`,
    ...buildClientJson(token, mcpUrl)
      .split("\n")
      .map((l) => `       ${l}`),
    `2. Verify (no restart needed): run  claude mcp list  - expect a line  llm-bus ... Connected.`,
    `   If it says failed, your token is wrong or revoked - get a fresh one.`,
    `3. RESTART your session so the tools load (MCP loads only at startup - this is expected, not an error),`,
    `   then call the whoami tool and confirm to me:`,
    `   "Connected to LLM Bus as ${participantName} on ${projectName}."`,
    `   (In harnesses with deferred/prefixed tools whoami may appear as mcp__llm-bus__whoami - search your`,
    `   tools before assuming it is missing.)`,
    `4. Append the protocol below to this repo's CLAUDE.md and follow it every session.`,
    `   (Needs a recent Claude Code; check with  claude --version  if  claude mcp add  is unknown.)`,
    ``,
    coordinationGuide(isAdmin),
  ].join("\n");
}

/** The self-contained, copy-paste invite prompt the orchestrator sends to the invited party's AI. */
export function buildInvitePrompt(
  projectName: string,
  code: string,
  intendedName: string | null,
  publicUrl: string,
  ttlHours: number,
  isAdmin: boolean,
): string {
  const base = publicUrl.replace(/\/+$/, "");
  const redeemUrl = base + "/join";
  const mcpUrl = base + "/mcp";
  const nameLine = intendedName
    ? `Your assigned name on LLM Bus is "${intendedName}".`
    : `Pick a short identity name for yourself if you don't already have one on LLM Bus (e.g. ai-claude-developer, ai-codex-frontend, human-yourname).`;
  const nameField = intendedName ? `"${intendedName}"` : `"<YOUR_NAME>"`;
  return [
    `You're invited to coordinate on the project "${projectName}" via LLM Bus.`,
    ``,
    `WHAT IT IS FOR (before the how): LLM Bus is the live coordination bus for this project - it is`,
    `the source of truth for shared-number claims, file leases, handoffs/asks/acks, and who-is-active.`,
    `Your git coordination files remain the durable archive and the fallback when the bus is down; the`,
    `bus is where live coordination and allocation happen. It is advisory and fail-open: if it is ever`,
    `unreachable, you keep working.`,
    ``,
    `Knowledge layer: the bus never stores knowledge - durable project knowledge lives as OKF (Open`,
    `Knowledge Format) wiki files in this repo's git (docs/wiki/ standard repo, wiki/ platform); verify`,
    `the format against github.com/GoogleCloudPlatform/knowledge-catalog (okf/SPEC.md). The coordination`,
    `guide you append in step 3 restates this.`,
    ``,
    `One token = one identity: all sub-agents you spawn share your one token (they count as one`,
    `participant). Never mint or request per-sub-agent tokens.`,
    ``,
    nameLine,
    ``,
    `Connect yourself now:`,
    `1. From your project root, redeem this invite (this returns YOUR token + a ready-to-run command):`,
    `   curl -fsS ${redeemUrl} -X POST -H 'content-type: application/json' -d '{"code":"${code}","name":${nameField}}'`,
    `   The response JSON has a "connect_command" field - one line with your token already in it.`,
    `   If your sandbox blocks outbound POSTs, do not work around it - hand this exact curl to your`,
    `   operator to run, and continue from its JSON output.`,
    ...(intendedName
      ? []
      : [
          `   If the response is {"error":"name_taken"}, that name is already in use on LLM Bus - pick a`,
          `   different one and run it again. Your invite stays valid until a redemption succeeds.`,
        ]),
    `2. Run the response's "connect_command" verbatim. It registers LLM Bus in Claude Code (local scope,`,
    `   no approval prompt) and looks like:`,
    `   claude mcp add --transport http llm-bus ${mcpUrl} --header "Authorization: Bearer <your-token>"`,
    `   Not Claude Code? The response also has "files" - write .mcp.json from it and set LLM_BUS_TOKEN`,
    `   (it must be set or the server won't connect); keep settings.local.json gitignored.`,
    `3. Verify (no restart needed): run  claude mcp list  - expect  llm-bus ... Connected. Then append the`,
    `   response's "guide" to this repo's CLAUDE.md so you follow the coordination protocol every session.`,
    `4. RESTART REQUIRED: MCP tools load only at session boot. Tell your operator "registered, please`,
    `   restart", then restart. This is expected, not an error.`,
    `5. After restarting, call the whoami tool and confirm: "Connected to LLM Bus as <name> on ${projectName}."`,
    `   (In harnesses with deferred tools the names carry an MCP prefix like mcp__llm-bus__whoami -`,
    `   search your tools before assuming they are missing.)`,
    ...(isAdmin
      ? [``, `This invite grants project-admin (lead): once connected you can onboard teammates yourself - the guide explains how (create_invite / admin_provision / list_participants).`]
      : []),
    ``,
    `Invite code: ${code} - valid ${ttlHours}h, one redemption${intendedName ? "" : " (you choose your name)"}.`,
    `(Needs a recent Claude Code; check  claude --version  if  claude mcp add  is unknown.)`,
  ].join("\n");
}
