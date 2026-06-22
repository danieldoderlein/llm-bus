import type http from "node:http";
import { loadConfig, type Config } from "../config.js";
import { resolveOwner, linkProviderIdentity } from "./owner.js";
import type { Owner } from "./owner.js";
import { ensureSession, getSessionEmail, setSessionEmail } from "./session.js";
import { oauthEnabled, beginLogin, handleCallback, asProvider } from "./oauth.js";
import { stripAdminPrefix, matchId, readForm } from "./router.js";
import { acceptInvite } from "../invite-accept.js";
import {
  respondHtml,
  loginPage,
  acceptedPage,
  dashboardPage,
  newProjectPage,
  newParticipantPage,
  projectPage,
  grantPage,
  handoutCard,
  editProjectPage,
  editParticipantPage,
  inviteFormPage,
  invitePromptPage,
} from "./html.js";
import { createInvite, listInvites, revokeInvite, buildInvitePrompt } from "../invite.js";
import { query } from "../db.js";
import { billingEnabled, createSetupSession, createPortalSession, chargeTopUp } from "../billing/index.js";
import { meterOwner } from "../billing/meter.js";
import { BONUS_LADDER } from "../billing/credits.js";
import type { LedgerRow } from "./html.js";
import {
  listProjects,
  listParticipants,
  loadOwnedProject,
  createProject,
  createParticipant,
  grant,
  listParticipations,
  revokeParticipation,
  rotateParticipation,
  loadOwnedParticipant,
  listParticipantGrants,
  renameParticipant,
  deleteParticipant,
  renameProject,
  deleteProject,
  setParticipationAdmin,
} from "./queries.js";

// The web admin HTTP surface. Entry point: handleAdmin(req, res). Identity comes from a
// trusted header (set by Caddy after SSO; config.ADMIN_EMAIL_HEADER names it). Absence of that
// header means a misconfig or a direct hit that bypassed the proxy -> 401. Every :id route
// re-proves ownership through a loadOwned* / owner-scoped query and 404s on mismatch (never a
// 403 oracle that would leak existence). Every POST requires a matching session CSRF token.
// Success paths use post/redirect/get (302) so a refresh never re-submits a form.

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, location: string, setCookie?: string): void {
  const headers: Record<string, string | string[]> = { location };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

/** The owner's recent credit-ledger entries for the dashboard billing slot (owner-scoped). */
async function recentLedger(ownerId: number): Promise<LedgerRow[]> {
  const r = await query<{ type: string; amount: string; balance_after: string; created_at: Date }>(
    "SELECT type, amount, balance_after, created_at FROM credit_ledger WHERE owner_id = $1 ORDER BY id DESC LIMIT 8",
    [ownerId],
  );
  return r.rows.map((x) => ({
    type: x.type,
    amount: Number(x.amount),
    balance_after: Number(x.balance_after),
    created_at: new Date(x.created_at).toISOString().slice(0, 16).replace("T", " "),
  }));
}

function notFound(res: http.ServerResponse): void {
  respondHtml(res, 404, "<!doctype html><title>Not found</title><h1>404 Not found</h1>");
}

function forbidden(res: http.ServerResponse): void {
  sendJson(res, 403, { error: "forbidden" });
}

/**
 * Resolve the admin identity shared by both surfaces (owner dashboard and operator console). Header
 * mode reads the Caddy-stripped SSO email header (401 if absent); oauth mode reads the verified
 * session email (redirect to the login if absent). Returns the Owner, or null after having written
 * the 401/redirect response. Identity comes only from the header or the verified session, never from
 * request input (invariants 1, 4). The two modes never both apply.
 */
export async function resolveIdentity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  sid: string,
  setCookie: string | undefined,
): Promise<Owner | null> {
  if (oauthEnabled(config)) {
    const sessionEmail = getSessionEmail(sid);
    if (!sessionEmail) {
      redirect(res, "/admin/login", setCookie);
      return null;
    }
    return resolveOwner(sessionEmail);
  }
  const emailHeader = req.headers[config.ADMIN_EMAIL_HEADER.toLowerCase()];
  const headerEmail = Array.isArray(emailHeader) ? emailHeader[0] : emailHeader;
  if (!headerEmail || !headerEmail.trim()) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return resolveOwner(headerEmail.trim());
}

export async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const config = loadConfig();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = stripAdminPrefix(url.pathname);
    const method = req.method ?? "GET";

    // ── Session + CSRF (both auth modes) ──
    const session = ensureSession(req);
    const setCookie = session.setCookie;

    // Helper: send an HTML page, attaching a freshly-issued cookie if there is one.
    const page = (status: number, html: string): void => {
      if (setCookie) res.setHeader("set-cookie", setCookie);
      respondHtml(res, status, html);
    };

    // For POSTs, read the form first, then enforce CSRF before any mutation.
    const requireCsrf = (form: Record<string, string>): boolean =>
      typeof form._csrf === "string" && form._csrf === session.csrf;

    // ── OAuth public entry points (oauth mode only; reachable without a prior session email) ──
    if (oauthEnabled(config)) {
      if (method === "GET" && path === "/login") {
        return page(200, loginPage());
      }
      // Invite acceptance entry: sign in (carrying the invite token), then accept on callback.
      if (method === "GET" && path === "/accept") {
        const token = url.searchParams.get("token");
        if (!token) return notFound(res);
        return page(200, loginPage(undefined, token));
      }
      const startMatch = path.match(/^\/auth\/(google|github)\/start$/);
      if (startMatch && method === "GET") {
        const provider = asProvider(startMatch[1]);
        const authUrl =
          provider &&
          beginLogin(provider, session.sid, config, {
            inviteToken: url.searchParams.get("invite") ?? undefined,
          });
        if (!authUrl) return notFound(res);
        return redirect(res, authUrl, setCookie);
      }
      const cbMatch = path.match(/^\/auth\/(google|github)\/callback$/);
      if (cbMatch && method === "GET") {
        const provider = asProvider(cbMatch[1]);
        if (!provider) return notFound(res);
        const result = await handleCallback(provider, session.sid, url.searchParams, config);
        if (!result) return page(401, loginPage("Sign-in failed. Please try again."));
        const o = await resolveOwner(result.email);
        await linkProviderIdentity(o.id, result.provider, result.subject, result.email);
        setSessionEmail(session.sid, result.email);
        if (result.inviteToken) {
          const accepted = await acceptInvite(result.inviteToken, result.email);
          if (accepted.ok) {
            const mcpUrl = `${config.PUBLIC_URL}/mcp`;
            return page(
              200,
              acceptedPage(accepted.projectName, accepted.participant, accepted.token, mcpUrl, accepted.isAdmin),
            );
          }
          console.warn(`[llm-bus admin] invite accept failed: ${accepted.error}`);
          // The user is signed in regardless; land them on the dashboard.
        }
        return redirect(res, "/admin", setCookie);
      }
    }

    // ── Identity (shared header/oauth resolution; same helper backs the operator console) ──
    const owner = await resolveIdentity(req, res, config, session.sid, setCookie);
    if (!owner) return;

    // ── Routes ──

    // GET / -> dashboard
    if (method === "GET" && path === "/") {
      // Opportunistic meter tick so the displayed balance is fresh (fire-and-forget, never awaited
      // into a mutating path, never in /mcp - decision 015 keeps metering off the hot path).
      if (billingEnabled(config)) void meterOwner(owner.id).catch(() => {});
      const [projects, participants, ledger] = await Promise.all([
        listProjects(owner.id),
        listParticipants(owner.id),
        billingEnabled(config) ? recentLedger(owner.id) : Promise.resolve([] as LedgerRow[]),
      ]);
      const notice = url.searchParams.get("billing");
      return page(
        200,
        dashboardPage(owner, projects, participants, session.csrf, ledger, notice, config.RECHARGE_THRESHOLD),
      );
    }

    // GET /projects/new
    if (method === "GET" && path === "/projects/new") {
      return page(200, newProjectPage(owner, session.csrf));
    }

    // POST /projects
    if (method === "POST" && path === "/projects") {
      const form = await readForm(req);
      if (!requireCsrf(form)) return forbidden(res);
      const slug = (form.slug ?? "").trim();
      const name = (form.name ?? "").trim();
      if (!slug || !name) {
        return page(400, newProjectPage(owner, session.csrf));
      }
      const created = await createProject(owner.id, slug, name);
      return redirect(res, `/admin/projects/${created.id}`, setCookie);
    }

    // GET /participants/new
    if (method === "GET" && path === "/participants/new") {
      return page(200, newParticipantPage(owner, session.csrf));
    }

    // POST /participants
    if (method === "POST" && path === "/participants") {
      const form = await readForm(req);
      if (!requireCsrf(form)) return forbidden(res);
      const name = (form.name ?? "").trim();
      const kind = form.kind === "human" ? "human" : "agent";
      if (!name) {
        return page(400, newParticipantPage(owner, session.csrf));
      }
      await createParticipant(owner.id, name, kind);
      return redirect(res, `/admin`, setCookie);
    }

    // GET /projects/:id/grant
    {
      const id = matchId("/projects/:id/grant", path);
      if (id !== null && method === "GET") {
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const participants = await listParticipants(owner.id);
        return page(200, grantPage(owner, project, participants, session.csrf));
      }
    }

    // POST /projects/:id/grant -> hand-out card
    {
      const id = matchId("/projects/:id/grant", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const participantId = Number(form.participant_id);
        const lane = form.lane && form.lane.trim() ? form.lane.trim() : null;
        const isAdmin = form.is_admin === "1" || form.is_admin === "on";
        const result = await grant(owner.id, project.id, participantId, lane, isAdmin);
        if (!result) return notFound(res); // participant not owned / bad id
        const participants = await listParticipants(owner.id);
        const participantName =
          participants.find((p) => p.id === result.participation.participantId)?.name ?? "agent";
        const mcpUrl = `${config.PUBLIC_URL}/mcp`;
        return page(
          200,
          handoutCard(owner, project, participantName, result.plaintextToken, mcpUrl, result.participation.isAdmin),
        );
      }
    }

    // GET /projects/:id -> project view
    {
      const id = matchId("/projects/:id", path);
      if (id !== null && method === "GET") {
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const [participations, invites] = await Promise.all([
          listParticipations(owner.id, project.id),
          listInvites(owner.id, project.id),
        ]);
        return page(200, projectPage(owner, project, participations, invites, session.csrf));
      }
    }

    // POST /participations/:id/revoke
    {
      const id = matchId("/participations/:id/revoke", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        // revokeParticipation is itself owner-scoped: a non-owned id is a silent no-op. We
        // can't cheaply learn the project id to redirect to, so redirect to the dashboard.
        await revokeParticipation(owner.id, id);
        return redirect(res, `/admin`, setCookie);
      }
    }

    // POST /participations/:id/rotate -> mint a new token + revoke the old one, show the fresh card
    {
      const id = matchId("/participations/:id/rotate", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const result = await rotateParticipation(owner.id, id);
        if (!result) return notFound(res); // not owned / bad id (no 403 oracle)
        const project = await loadOwnedProject(owner.id, result.participation.projectId);
        if (!project) return notFound(res);
        const participants = await listParticipants(owner.id);
        const participantName =
          participants.find((p) => p.id === result.participation.participantId)?.name ?? "agent";
        const mcpUrl = `${config.PUBLIC_URL}/mcp`;
        return page(
          200,
          handoutCard(owner, project, participantName, result.plaintextToken, mcpUrl, result.participation.isAdmin),
        );
      }
    }

    // POST /participations/:id/set-admin -> promote/demote the lead flag (form: admin=1|0)
    {
      const id = matchId("/participations/:id/set-admin", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        await setParticipationAdmin(owner.id, id, form.admin === "1"); // owner-scoped no-op if not owned
        const pid = Number(form.project_id);
        return redirect(res, Number.isFinite(pid) && pid > 0 ? `/admin/projects/${pid}` : "/admin", setCookie);
      }
    }

    // GET /projects/:id/edit
    {
      const id = matchId("/projects/:id/edit", path);
      if (id !== null && method === "GET") {
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        return page(200, editProjectPage(owner, project, session.csrf));
      }
    }

    // POST /projects/:id/rename
    {
      const id = matchId("/projects/:id/rename", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const name = (form.name ?? "").trim();
        const slug = (form.slug ?? "").trim();
        if (!name || !slug) {
          return page(400, editProjectPage(owner, project, session.csrf, "Name and slug are required."));
        }
        const r = await renameProject(owner.id, project.id, name, slug);
        if (r === "conflict") {
          return page(409, editProjectPage(owner, { ...project, name, slug }, session.csrf, "You already have a project with that slug."));
        }
        if (r === "notfound") return notFound(res);
        return redirect(res, `/admin/projects/${project.id}`, setCookie);
      }
    }

    // POST /projects/:id/delete
    {
      const id = matchId("/projects/:id/delete", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        await deleteProject(owner.id, id); // owner-scoped: a non-owned id is a silent no-op
        return redirect(res, `/admin`, setCookie);
      }
    }

    // GET /participants/:id/edit
    {
      const id = matchId("/participants/:id/edit", path);
      if (id !== null && method === "GET") {
        const participant = await loadOwnedParticipant(owner.id, id);
        if (!participant) return notFound(res);
        const grants = await listParticipantGrants(owner.id, participant.id);
        return page(200, editParticipantPage(owner, participant, grants, session.csrf));
      }
    }

    // POST /participants/:id/rename
    {
      const id = matchId("/participants/:id/rename", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const participant = await loadOwnedParticipant(owner.id, id);
        if (!participant) return notFound(res);
        const name = (form.name ?? "").trim();
        const grants = await listParticipantGrants(owner.id, participant.id);
        if (!name) {
          return page(400, editParticipantPage(owner, participant, grants, session.csrf, "Name is required."));
        }
        const r = await renameParticipant(owner.id, participant.id, name);
        if (r === "conflict") {
          return page(409, editParticipantPage(owner, participant, grants, session.csrf, "You already have a participant with that name."));
        }
        if (r === "notfound") return notFound(res);
        return redirect(res, `/admin/participants/${participant.id}/edit`, setCookie);
      }
    }

    // POST /participants/:id/delete
    {
      const id = matchId("/participants/:id/delete", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        await deleteParticipant(owner.id, id); // owner-scoped: a non-owned id is a silent no-op
        return redirect(res, `/admin`, setCookie);
      }
    }

    // GET /projects/:id/invite -> invite form
    {
      const id = matchId("/projects/:id/invite", path);
      if (id !== null && method === "GET") {
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        return page(200, inviteFormPage(owner, project, session.csrf));
      }
    }

    // POST /projects/:id/invite -> create the invite + show the copy-paste prompt
    {
      const id = matchId("/projects/:id/invite", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const name = form.name && form.name.trim() ? form.name.trim() : null;
        const kind = form.kind === "human" ? "human" : "agent";
        const lane = form.lane && form.lane.trim() ? form.lane.trim() : null;
        const isAdmin = form.is_admin === "1" || form.is_admin === "on";
        const ttlHours = Number(form.ttl_hours) || 24;
        const uses = Number(form.uses) || 1;
        const inv = await createInvite(owner.id, project.id, { name, kind, lane, isAdmin, uses, ttlHours });
        if (!inv) return notFound(res);
        const prompt = buildInvitePrompt(project.name, inv.code, name, config.PUBLIC_URL, ttlHours, isAdmin);
        return page(200, invitePromptPage(owner, project, prompt, inv.expiresAt));
      }
    }

    // POST /invites/:id/revoke
    {
      const id = matchId("/invites/:id/revoke", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        await revokeInvite(owner.id, id); // owner-scoped: a non-owned id is a silent no-op
        return redirect(res, `/admin`, setCookie);
      }
    }

    // ── Billing (decision 015): owner-self routes; CSRF on every POST; inert when unconfigured.
    // Amounts validated against the fixed ladder server-side; redirect targets are Stripe-issued. ──
    if (billingEnabled(config)) {
      if (method === "POST" && path === "/billing/setup") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const url = await createSetupSession(owner);
        return redirect(res, url ?? "/admin", setCookie);
      }
      if (method === "POST" && path === "/billing/portal") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const url = await createPortalSession(owner);
        return redirect(res, url ?? "/admin", setCookie);
      }
      if (method === "POST" && path === "/billing/auto-recharge") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const raw = form.amount ?? "";
        const amt = Number(raw);
        const value = raw === "" ? null : BONUS_LADDER.some(([n]) => n === amt) ? amt : undefined;
        if (value !== undefined) {
          await query("UPDATE owners SET auto_recharge_amount = $2 WHERE id = $1", [owner.id, value]);
        }
        return redirect(res, "/admin", setCookie);
      }
      if (method === "POST" && path === "/billing/topup") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const amt = Number(form.amount);
        let notice = "badamount";
        if (BONUS_LADDER.some(([n]) => n === amt)) {
          const r = await chargeTopUp(owner, amt);
          notice =
            r === "credited" ? "added" : r === "pending" ? "charging" : r === "declined" ? "declined" : "nocard";
        }
        return redirect(res, `/admin?billing=${notice}`, setCookie);
      }
    }

    return notFound(res);
  } catch (err) {
    console.error("[llm-bus admin] request error:", err);
    if (!res.headersSent) sendJson(res, 400, { error: "bad request" });
    else res.end();
  }
}

export type { Owner };
