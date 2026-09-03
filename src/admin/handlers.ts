import type http from "node:http";
import { loadConfig, type Config } from "../config.js";
import { resolveOwner, linkProviderIdentity } from "./owner.js";
import type { Owner } from "./owner.js";
import {
  ensureSession,
  getSessionEmail,
  setSessionEmail,
  getAsAuthorize,
  setAsAuthorize,
  clearAsAuthorize,
  asLandingVariant,
  setLandingVariant,
  getLandingVariant,
  asChannel,
  setChannel,
  getChannel,
  setReturnTo,
  getReturnTo,
  clearReturnTo,
  asBoardAssignee,
  readBoardFilter,
  boardFilterCookie,
} from "./session.js";
import { oauthEnabled, beginLogin, handleCallback, asProvider } from "./oauth.js";
import {
  loadClient,
  listMemberships,
  listPendingInvitesForEmail,
  ownsParticipation,
  createOwnerParticipation,
  mintAuthCode,
} from "../oauth-as.js";
import { stripAdminPrefix, matchId, matchTwoIds, readForm } from "./router.js";
import { notifyInvite } from "../billing/notify.js";
import { acceptInvite, acceptInviteById, createOrgInvite } from "../invite-accept.js";
import {
  respondHtml,
  loginPage,
  acceptedPage,
  consentPage,
  layout,
  projectsPage,
  participantsPage,
  billingPage,
  settingsPage,
  setupPage,
  wizardConnectCard,
  newProjectPage,
  newParticipantPage,
  projectBoardPage,
  tasksPage,
  taskDetailPage,
  newTaskPage,
  messagesPage,
  projectAccessPage,
  grantPage,
  handoutCard,
  addedToProjectCard,
  projectSettingsPage,
  editParticipantPage,
  claudeConnectUrl,
  type Toast,
} from "./html.js";
import { listInvites, revokeInvite } from "../invite.js";
import { changeUsername } from "./username.js";
import { query } from "../db.js";
import { billingEnabled, createSetupSession, createPortalSession, chargeTopUp } from "../billing/index.js";
import { meterOwner } from "../billing/meter.js";
import { BONUS_LADDER } from "../billing/credits.js";
import type { LedgerRow } from "./html.js";
import {
  listProjects,
  listMemberProjects,
  listParticipants,
  loadOwnedProject,
  loadProjectForAdminRead,
  createProject,
  createParticipant,
  grant,
  listParticipations,
  listProjectHumanMembers,
  setProjectMemberRole,
  revokeParticipation,
  rotateParticipation,
  loadOwnedParticipant,
  listParticipantGrants,
  listReassignCandidates,
  countOpenTasksForParticipant,
  renameParticipant,
  deleteParticipant,
  renameProject,
  deleteProject,
  setParticipationAdmin,
  setParticipationLane,
  loadProjectActivity,
  loadProjectBoard,
  connectionStatus,
  listTasksForOwnerBoard,
  loadOwnerBoardTask,
  nextOwnerTaskInProject,
  listProjectMembersForAssign,
  loadProjectForMember,
} from "./queries.js";
import {
  taskCreateFromOwner,
  taskAssignFromOwner,
  taskStartFromOwner,
  taskStopFromOwner,
  taskShipFromOwner,
  taskAnswerFromOwner,
  taskHandoffFromOwner,
  taskCancelFromOwner,
  taskReopenFromOwner,
  sendMessageFromOwner,
  type OwnerActor,
} from "./task-writes.js";

/** Parse the New-task "Links" textarea (one `label | url` per line) into [{label,url}] for the v2 links
 *  field (decision 041). Blank lines and lines with no url are dropped; the domain normalizeLinks (via
 *  task-writes) bounds count/length, and the render layer (isHttpUrl) gates the href scheme. Returns null
 *  when empty (so the caller passes undefined, not an empty array). */
function parseLinksField(raw: string | undefined): { label: string; url: string }[] | null {
  if (!raw) return null;
  const out: { label: string; url: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split "label | url" on the FIRST '|'. But if the text before the '|' already looks like a URL, the '|'
    // is INSIDE a bare url (no label) - keep the whole line as the url. This keeps "label|url" and
    // "label | url" working while not mangling a bare url that contains a literal '|'.
    const bar = trimmed.indexOf("|");
    let label = "";
    let urlPart = trimmed;
    if (bar >= 0) {
      const left = trimmed.slice(0, bar).trim();
      const right = trimmed.slice(bar + 1).trim();
      if (right && !/^https?:\/\//i.test(left)) {
        label = left;
        urlPart = right;
      }
    }
    if (!urlPart) continue;
    out.push({ label, url: urlPart });
    if (out.length >= 10) break;
  }
  return out.length ? out : null;
}

/** Where to send the human after a task create/write (decision 041): the task's DETAIL page when they can
 *  still SEE it, else the board (which always resolves). A plain member who creates a task not assigned to
 *  themselves - or reassigns their own task away - can no longer load the detail page (loadOwnerBoardTask
 *  returns null -> 404), so this avoids a dead-end 404 after a successful action. Owners/admins always retain
 *  access (their predicate is assignee-independent), so they stay on the task. Uses the same tested
 *  membership-scoped read as the detail route. */
async function afterTaskWriteDest(owner: Owner, projectId: number, taskId: number): Promise<string> {
  const visible = await loadOwnerBoardTask(owner.id, projectId, taskId);
  return visible ? `/admin/projects/${projectId}/tasks/${taskId}` : `/admin/tasks?project=${projectId}`;
}

/** After a human ANSWERS a task (decision 048): auto-advance to the NEXT task in their queue for this project
 *  (the oldest open task assigned to them), or the board if the queue is empty - carrying a ?done=<id> so the
 *  destination shows a toast. The inbox-zero flow: answer one, land on the next. */
async function afterAnswerDest(owner: Owner, projectId: number, answeredTaskId: number): Promise<string> {
  const nextId = await nextOwnerTaskInProject(owner.id, projectId, answeredTaskId);
  return nextId != null
    ? `/admin/projects/${projectId}/tasks/${nextId}?done=${answeredTaskId}`
    : `/admin/tasks?project=${projectId}&done=${answeredTaskId}&caught=1`;
}

/** The post-answer confirmation toast (decision 048), composed server-side from the numeric `?done=<id>` the
 *  answer redirect adds (never reflected free text). `caught` marks the queue-empty landing (the board). */
function answeredToast(url: URL): Toast | undefined {
  const raw = url.searchParams.get("done");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const caught = url.searchParams.get("caught") === "1";
  // "caught" = the human's answerable (todo) queue for this project is empty - NOT that every task is done
  // (they may still have in_progress/blocked ones), so the copy speaks to THEIR waiting queue (both reviewers).
  return {
    msg: caught ? `Answered #${raw} - nothing else waiting for you here.` : `Answered #${raw} - next up.`,
  };
}

/** The task-created confirmation toast (decision 049), composed server-side from the numeric `?created=<id>`
 *  (+ `?project=<id>`) the create redirect adds - never reflected free text. Carries a "View" link to the new
 *  task's detail page (an internal /admin path built from digit-only ids, esc()'d in renderToast) - but ONLY
 *  when the redirect proved the creator can actually see the task (`?view=1`). A plain member who assigns a
 *  task away cannot see it (the membership predicate, invariant 3), so we confirm creation WITHOUT a View link
 *  that would 404. Exported for a direct unit test of the branch logic. */
export function createdToast(url: URL): Toast | undefined {
  const raw = url.searchParams.get("created");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const proj = url.searchParams.get("project");
  const canView = url.searchParams.get("view") === "1";
  const link =
    canView && proj && /^\d+$/.test(proj) ? { label: "View", url: `/admin/projects/${proj}/tasks/${raw}` } : undefined;
  return { msg: `Created #${raw}`, link };
}

/** Resolve the board's effective filter from the request (decision 058, refines 050 / task #611). The
 *  board defaults to the operator's own plate across all projects (assignee "@me"); an explicit project
 *  and/or assignee in the URL wins and is persisted; otherwise the stored cookie preference applies.
 *  project and assignee fall back INDEPENDENTLY, keyed on the param's PRESENCE (not truthiness) - so the
 *  "in <project>" row link (which carries only ?project=) keeps the current assignee, and the empty-state
 *  "View all projects" link (explicit ?project=) clears the project while keeping the assignee lens.
 *  `write` is true when the URL expressed a selection, so the caller re-persists the cookie. The @me
 *  default applies ONLY when no cookie exists, so an operator's saved "Everyone" ("") still sticks.
 *  Exported for a direct unit test of the branch logic (like createdToast). */
export function resolveBoardFilter(input: {
  hasProject: boolean;
  projectRaw: string | null;
  hasAssignee: boolean;
  assigneeRaw: string | null;
  cookie: { project?: number; assignee?: string } | null;
}): { projectId?: number; assignee: string; write: boolean } {
  const { hasProject, projectRaw, hasAssignee, assigneeRaw, cookie } = input;
  // project: URL present -> URL value (finite id, else all-projects); else the cookie; else all-projects.
  const projectId = hasProject
    ? projectRaw && Number.isInteger(Number(projectRaw))
      ? Number(projectRaw)
      : undefined
    : cookie?.project;
  // assignee: URL present -> validated URL value; else the cookie; else the @me default (no cookie only).
  const assignee = hasAssignee
    ? (asBoardAssignee(assigneeRaw) ?? "")
    : cookie && cookie.assignee !== undefined
      ? cookie.assignee
      : "@me";
  return { projectId, assignee, write: hasProject || hasAssignee };
}

/** Dispatch the Status dropdown's target state to the right owner transition (decision 042): in_progress =
 *  start, done = ship, cancelled = cancel, todo = un-start (from in_progress) OR reopen (from terminal). Each
 *  mutator re-proves authority + legality and returns null on refusal (-> the handler 404s, no oracle). For
 *  'todo' we try un-start then fall back to reopen; both null (bad target/illegal/unauthorized) -> null. */
async function setTaskStatusFromOwner(
  owner: OwnerActor,
  projectId: number,
  taskId: number,
  target: string,
): Promise<{ taskId: number; status: string } | null> {
  switch (target) {
    case "in_progress":
      return taskStartFromOwner(owner, projectId, taskId);
    case "done":
      return taskShipFromOwner(owner, projectId, taskId);
    case "cancelled":
      return taskCancelFromOwner(owner, projectId, taskId);
    case "todo": {
      const stopped = await taskStopFromOwner(owner, projectId, taskId);
      return stopped ?? (await taskReopenFromOwner(owner, projectId, taskId));
    }
    default:
      return null;
  }
}

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

/** Slug from a free-text project name: lowercase, alphanumeric + hyphens, trimmed, capped. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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

/** OAuth-AS /authorize error page, shown only when the request is too broken to safely redirect back
 *  (unknown client or unregistered redirect_uri - the open-redirect guard). */
function asErrorPage(): string {
  return layout(
    "Connection error",
    `<section class="panel"><h1>Connection error</h1>
     <p class="muted">This connection request is invalid or has expired. Close this window and start
     the connection again from your app.</p></section>`,
  );
}

/** The host of a (validated) redirect_uri, shown on the consent screen so the user sees where the
 *  access token will be delivered - the honest signal against a spoofed client_name. */
function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/** Redirect an OAuth-AS error back to a VALIDATED (registered) redirect_uri, per OAuth 2.0 4.1.2.1. */
function redirectError(
  res: http.ServerResponse,
  redirectUri: string,
  error: string,
  clientState: string | null,
  setCookie: string | undefined,
): void {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (clientState) u.searchParams.set("state", clientState);
  redirect(res, u.toString(), setCookie);
}

/**
 * Open-redirect guard for the post-login return path. Returns `p` ONLY when it is a safe LOCAL admin
 * target - same-origin and under /admin - else null. Accept iff: it starts with "/admin"; does NOT start
 * with "//" (a protocol-relative URL to another host); the character right after "/admin" is "/", "?", or
 * end-of-string (so "/admin", "/admin/x", "/admin?y" pass but "/adminEVIL" fails); and it carries no
 * backslash and no ASCII control char (0x00-0x1F). Only same-origin /admin* targets are ever honored, so a
 * tampered ?next=//evil.com or an absolute URL can never bounce a freshly-authenticated operator off-site.
 */
export function safeAdminReturn(p: string | undefined | null): string | null {
  if (typeof p !== "string") return null;
  if (!p.startsWith("/admin")) return null;
  if (p.startsWith("//")) return null; // protocol-relative -> another host
  const after = p.charAt("/admin".length); // "" when p is exactly "/admin"
  if (after !== "" && after !== "/" && after !== "?") return null;
  if (p.includes("\\")) return null;
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) <= 0x1f) return null; // ASCII control chars (incl. NUL, \t, \n, \r)
  }
  return p;
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
      // Preserve where the user was headed so the callback can return them there (not always /admin).
      // req.url is the full /admin* path Caddy preserves; sanitize it (open-redirect guard) before stashing.
      const wanted = new URL(req.url ?? "/", "http://localhost");
      const safe = safeAdminReturn(wanted.pathname + wanted.search);
      if (safe) setReturnTo(sid, safe);
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

    // Landing A/B variant capture (decision 027, gap-B). The landing CTAs point at /admin?...&
    // llmbus_variant=<everyone|dev>; the redirect to /admin/login and the SSO round-trip drop the query
    // string, so we stash the ENUM-VALIDATED value on the session at the earliest admin hit. UNTRUSTED
    // input: it is only ever written as owner conversion metadata on first creation - never read into
    // identity/authz/scoping (invariant 1). Only stash a valid value, so a garbage param leaves the
    // session (and thus the owner) with no variant (NULL).
    const variant = asLandingVariant(url.searchParams.get("llmbus_variant"));
    if (variant) setLandingVariant(session.sid, variant);

    // Acquisition channel capture (decision 031, task #114). Marketing points each channel's links at
    // /admin?via=<slug> (r-mcp, showhn, x, creator-*); same stash-through-SSO mechanism as the variant
    // above. UNTRUSTED input, sanitized to [a-z0-9._-]{1,64}: written only as owner conversion metadata
    // on first creation, never into identity/authz/scoping (invariant 1). A garbage/absent param leaves
    // the owner unattributed (NULL) - capture is fail-open and never blocks signup.
    const channel = asChannel(url.searchParams.get("via"));
    if (channel) setChannel(session.sid, channel);

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
        // gap-B: pass the session-stashed landing variant so it stamps a NEWLY-created owner only.
        // Identity still derives solely from result.email (the SSO-verified address); the variant is
        // write-only metadata and cannot change which owner resolves.
        const o = await resolveOwner(result.email, {
          landingVariant: getLandingVariant(session.sid),
          channel: getChannel(session.sid),
        });
        await linkProviderIdentity(o.id, result.provider, result.subject, result.email);
        setSessionEmail(session.sid, result.email);
        // Return-path: read the sanitized target the login guard stashed, then clear it once so a stale
        // target can never leak into a later unrelated sign-in on this session. It is honored only by the
        // final fallback redirect below; the AS-authorize and invite paths keep their own destinations.
        const back = safeAdminReturn(getReturnTo(session.sid));
        clearReturnTo(session.sid);
        // Resume a pending connector consent (decision 024): the AS /authorize request was stashed on
        // the session before we sent the user to SSO. Back to /authorize now that they are verified.
        if (getAsAuthorize(session.sid)) return redirect(res, "/admin/authorize", setCookie);
        if (result.inviteToken) {
          const accepted = await acceptInvite(result.inviteToken, result.email);
          if (accepted.ok) {
            const mcpUrl = `${config.PUBLIC_URL}/mcp`;
            return page(
              200,
              acceptedPage(
                accepted.projectName,
                accepted.participant,
                accepted.token,
                mcpUrl,
                accepted.isAdmin,
                accepted.participationId,
                claudeConnectUrl(config.PUBLIC_URL),
              ),
            );
          }
          console.warn(`[llm-bus admin] invite accept failed: ${accepted.error}`);
          // The user is signed in regardless; land them on the dashboard - but TELL them why the invite did
          // not complete (decision 068). A silent redirect to an empty dashboard is how an invitee concludes
          // the product is broken, and name_taken is now a reachable outcome rather than a theoretical one.
          if (accepted.error === "name_taken") {
            const seat = accepted.seatName ? ` ("${accepted.seatName}")` : "";
            return redirect(
              res,
              `/admin?invite_error=${encodeURIComponent(
                `You are signed in, but the invitation could not be completed: the agent name${seat} it asked for is already used by someone else in that project. Ask whoever invited you to send a new invitation with a different agent name.`,
              )}`,
              setCookie,
            );
          }
        }
        return redirect(res, back ?? "/admin", setCookie);
      }

      // ── OAuth 2.1 authorization server: the connector consent dance (decision 024) ──
      // The metadata advertises authorization_endpoint = <issuer>/admin/authorize; /register, /token,
      // and the well-known metadata are stateless and live in http.ts. These two need the session +
      // SSO + consent rendering, so they sit here, reachable before the identity gate.
      if (method === "GET" && path === "/authorize") {
        const p = url.searchParams;
        const fromUrl = p.get("client_id");
        let payload = getAsAuthorize(session.sid);
        if (fromUrl) {
          // Fresh request: validate the client, then EXACT-match the redirect_uri to a registered
          // value. If either is bad we must NOT redirect (open-redirect guard) - show an error page.
          const client = await loadClient(fromUrl);
          const redirectUri = p.get("redirect_uri") ?? "";
          if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
            return page(400, asErrorPage());
          }
          // From here the redirect_uri is trusted, so protocol errors go back to the client per OAuth.
          const clientState = p.get("state");
          if (p.get("response_type") !== "code") {
            return redirectError(res, redirectUri, "unsupported_response_type", clientState, setCookie);
          }
          const codeChallenge = p.get("code_challenge") ?? "";
          if (!codeChallenge || p.get("code_challenge_method") !== "S256") {
            return redirectError(res, redirectUri, "invalid_request", clientState, setCookie);
          }
          payload = { clientId: fromUrl, redirectUri, codeChallenge, state: clientState, scope: "mcp" };
          setAsAuthorize(session.sid, payload);
        } else if (!payload) {
          return page(400, asErrorPage());
        }
        // Not signed in: the payload is stashed; go through SSO and the callback resumes here.
        const email = getSessionEmail(session.sid);
        if (!email) return redirect(res, "/admin/login", setCookie);
        const o = await resolveOwner(email);
        const client = await loadClient(payload.clientId);
        const memberships = await listMemberships(o.id);
        const invites = await listPendingInvitesForEmail(o.email);
        return page(200, consentPage(client?.client_name ?? null, hostOf(payload.redirectUri), session.csrf, memberships, invites));
      }

      if (method === "POST" && path === "/authorize/consent") {
        const email = getSessionEmail(session.sid);
        const payload = getAsAuthorize(session.sid);
        if (!email || !payload) return redirect(res, "/admin/login", setCookie);
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const o = await resolveOwner(email);
        const choice = (form.choice ?? "").trim();
        let participationId: number | null = null;
        if (choice.startsWith("membership:")) {
          const pid = Number(choice.slice("membership:".length));
          if (await ownsParticipation(o.id, pid)) participationId = pid;
        } else if (choice.startsWith("invite:")) {
          const inviteId = Number(choice.slice("invite:".length));
          const accepted = await acceptInviteById(inviteId, o.email);
          if (accepted.ok) participationId = accepted.participationId;
        } else if (choice === "new") {
          const name = (form.project_name ?? "").trim();
          const slug = slugify(name);
          if (name && slug) {
            try {
              const project = await createProject(o.id, slug, name);
              const participant = await createParticipant(o.id, `${slug}-agent`, "agent");
              participationId = await createOwnerParticipation(o.id, project.id, participant.id);
            } catch {
              participationId = null; // slug/name collision -> re-render below
            }
          }
        }
        if (participationId == null) {
          const memberships = await listMemberships(o.id);
          const invites = await listPendingInvitesForEmail(o.email);
          const client = await loadClient(payload.clientId);
          return page(400, consentPage(client?.client_name ?? null, hostOf(payload.redirectUri), session.csrf, memberships, invites, "Choose where to connect before continuing."));
        }
        // Mint a single-use code bound to (client, participation, redirect_uri, challenge), clear the
        // pending payload, and hand the browser back to the client with code + the client's state.
        const code = await mintAuthCode({
          clientId: payload.clientId,
          participationId,
          redirectUri: payload.redirectUri,
          codeChallenge: payload.codeChallenge,
          scope: payload.scope,
        });
        clearAsAuthorize(session.sid);
        const back = new URL(payload.redirectUri);
        back.searchParams.set("code", code);
        if (payload.state) back.searchParams.set("state", payload.state);
        return redirect(res, back.toString(), setCookie);
      }
    }

    // ── Identity (shared header/oauth resolution; same helper backs the operator console) ──
    const owner = await resolveIdentity(req, res, config, session.sid, setCookie);
    if (!owner) return;

    // ── Routes ──

    // GET / -> Projects (account home; decision 023). First run -> the guided wizard, but ONLY for a truly
    // new owner: an invited member who owns no projects yet belongs to someone else's must NOT be dumped in
    // the owner setup wizard (task #7). The wizard shows only when they own nothing AND belong to nothing.
    if (method === "GET" && path === "/") {
      const projects = await listProjects(owner.id);
      const memberProjects = await listMemberProjects(owner.id);
      if (projects.length === 0 && memberProjects.length === 0) {
        return page(200, setupPage(owner, session.csrf));
      }
      // The invite_error carries the reason a just-attempted acceptance did not complete (decision 068).
      // Escaped by projectsPage through esc(), and capped so a crafted link cannot inject a wall of text.
      const inviteErr = (url.searchParams.get("invite_error") ?? "").slice(0, 300) || undefined;
      return page(200, projectsPage(owner, projects, memberProjects, inviteErr));
    }

    // GET /participants -> the identities this owner owns (decision 023)
    if (method === "GET" && path === "/participants") {
      const participants = await listParticipants(owner.id);
      return page(200, participantsPage(owner, participants));
    }

    // GET /review -> retired by decision 039 (the review board folded into the task board). Permanent
    // repoint so old links/bookmarks/agent messages still land somewhere useful.
    if (method === "GET" && path === "/review") {
      return redirect(res, "/admin/tasks", setCookie);
    }

    // GET /tasks -> the cross-project task control board (decision 039). listTasksForOwnerBoard is
    // MEMBERSHIP-scoped (owner/admin see every task in a project; a plain member sees only tasks assigned to
    // them; invariant 3). ?project=<id> narrows. Rosters (assignable targets) are loaded per project present.
    if (method === "GET" && path === "/tasks") {
      // Decision 050: ?assignee narrows the (already membership-scoped) board to one assignee ("@me" = mine);
      // ?alldone lifts the terminal-group cap. Both are render-level filters applied in tasksPage - they only
      // HIDE rows already visible under the membership predicate, never widen (invariant 3 untouched).
      // Decision 058 / task #611: the board default is "@me across all projects" and the project+assignee
      // selection is STICKY - resolveBoardFilter blends the URL params (authoritative when present) with the
      // persisted preference cookie, defaulting to @me. `alldone` stays URL-only transient (never persisted).
      const filter = resolveBoardFilter({
        hasProject: url.searchParams.has("project"),
        projectRaw: url.searchParams.get("project"),
        hasAssignee: url.searchParams.has("assignee"),
        assigneeRaw: url.searchParams.get("assignee"),
        cookie: readBoardFilter(req),
      });
      const projectId = filter.projectId;
      const allDone = url.searchParams.get("alldone") === "1";
      const [tasks, owned, memberOf] = await Promise.all([
        // allDone rides into the QUERY too (decision 062): "Load more" lifts the render cap, so the fetch has
        // to hold more archive as well or the control would expand into rows that were never loaded.
        listTasksForOwnerBoard(owner.id, { projectId, allDone }),
        listProjects(owner.id),
        listMemberProjects(owner.id),
      ]);
      const projMap = new Map<number, { id: number; name: string }>();
      for (const p of [...owned, ...memberOf]) projMap.set(p.id, { id: p.id, name: p.name });
      const html = tasksPage(
        owner,
        tasks,
        [...projMap.values()],
        { projectId, assignee: filter.assignee, allDone },
        answeredToast(url) ?? createdToast(url),
      );
      // Persist the selection when the URL expressed one (decision 058). The board cookie rides ALONGSIDE the
      // session cookie - res.setHeader accepts an array of Set-Cookie values; the single-string `page` helper
      // would clobber one, so this branch attaches both directly. No redirect: the URL stays shareable (the
      // `aud` model). A read-only nav pref needs no CSRF (that guards POSTs; GET reads are unchanged).
      if (filter.write) {
        const cookies = [setCookie, boardFilterCookie(projectId, filter.assignee)].filter(Boolean) as string[];
        res.setHeader("set-cookie", cookies);
        return respondHtml(res, 200, html);
      }
      return page(200, html);
    }

    // GET /projects/:id/tasks/new -> the create-a-task form. Membership-gated (loadProjectForMember 404s a
    // non-member before rendering). POST creates via taskCreateFromOwner (which re-proves membership).
    {
      const pid = matchId("/projects/:id/tasks/new", path);
      if (pid !== null && method === "GET") {
        const project = await loadProjectForMember(owner.id, pid);
        if (!project) return notFound(res);
        const roster = await listProjectMembersForAssign(owner.id, pid);
        return page(200, newTaskPage(owner, project, roster, session.csrf));
      }
      if (pid !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const options = (form.options ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6);
        const result = await taskCreateFromOwner(owner, pid, {
          title: form.title ?? "",
          detail: form.detail,
          lane: form.lane,
          assignee: form.assignee,
          options: options.length ? options : undefined,
          links: parseLinksField(form.links) ?? undefined,
        });
        if (!result) {
          const project = await loadProjectForMember(owner.id, pid);
          if (!project) return notFound(res); // non-member -> the same 404 as a bad id (no oracle)
          const roster = await listProjectMembersForAssign(owner.id, pid);
          return page(400, newTaskPage(owner, project, roster, session.csrf, "Could not create the task - check the title and assignee."));
        }
        // Land back on the board with a toast confirming creation (decision 049). The human just authored this
        // task and handed it to an agent/teammate; there is nothing for THEM to do on its detail page, so
        // return them to their plate. ?project keeps the filter; ?created drives the toast. The "View" link is
        // gated on whether the creator can actually SEE the task (a plain member who assigned it away cannot -
        // the membership predicate, invariant 3): &view=1 only then, so the toast never offers a link that
        // 404s (the detail route re-proves regardless). (Was: land on the task's own detail page, decision 041.)
        const canView = (await loadOwnerBoardTask(owner.id, pid, result.taskId)) !== null;
        return redirect(res, `/admin/tasks?project=${pid}&created=${result.taskId}${canView ? "&view=1" : ""}`, setCookie);
      }
    }

    // GET /projects/:id/tasks/:rid -> the task DETAIL / working surface (decision 041). Membership-scoped:
    // loadOwnerBoardTask re-proves the 037 predicate, so a foreign/missing/refused task 404s exactly like a
    // bad id (no 403 oracle). Checked AFTER /tasks/new so "new" is handled above (matchTwoIds would read
    // rid=NaN for it, and loadOwnerBoardTask returns null on a non-finite id anyway).
    {
      const mm = matchTwoIds("/projects/:id/tasks/:rid", path);
      if (mm && method === "GET") {
        const [project, task] = await Promise.all([
          loadProjectForMember(owner.id, mm.id),
          loadOwnerBoardTask(owner.id, mm.id, mm.rid),
        ]);
        if (!project || !task) return notFound(res);
        const roster = await listProjectMembersForAssign(owner.id, mm.id);
        return page(200, taskDetailPage(owner, task, project, roster, session.csrf, undefined, answeredToast(url)));
      }
    }

    // POST /projects/:id/tasks/:rid/<verb> -> drive one task (decisions 039/041/042/047). Three verbs:
    //   respond - answer the task: an option chip, or a written reply ("Send reply" / the "None of the above"
    //             button) carrying a note; the reply routes back to the asking agent. (action=handoff is
    //             retained here but no longer surfaced in the UI - decision 047 merged hand-off into Reassign.)
    //   status  - set the lifecycle state (the Status dropdown -> the right transition);
    //   assign  - set the assignee (the "Reassign" control).
    // Each write re-proves the membership predicate AND the transition; a refused/foreign/illegal move -> null
    // -> the SAME 404 as a bad id (no 403 oracle). Redirect via afterTaskWriteDest.
    {
      const taskVerbs = ["respond", "status", "assign"] as const;
      let matched: { verb: (typeof taskVerbs)[number]; id: number; rid: number } | null = null;
      for (const v of taskVerbs) {
        const mm = matchTwoIds(`/projects/:id/tasks/:rid/${v}`, path);
        if (mm) {
          matched = { verb: v, id: mm.id, rid: mm.rid };
          break;
        }
      }
      if (matched && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const { verb, id, rid } = matched;
        let result: unknown = null;
        if (verb === "assign") {
          result = await taskAssignFromOwner(owner, id, rid, (form.assignee ?? "").trim());
        } else if (verb === "status") {
          result = await setTaskStatusFromOwner(owner, id, rid, (form.status ?? "").trim());
        } else if (verb === "respond") {
          const note = form.note && form.note.trim() ? form.note.trim() : null;
          if (form.action === "handoff") {
            result = await taskHandoffFromOwner(owner, id, rid, (form.handoff_to ?? "").trim() || undefined, note);
          } else {
            // an option chip (form.option set) OR "Answer & close" (form.action=answer, note only)
            const option = form.option && form.option.trim() ? form.option.trim() : undefined;
            result = await taskAnswerFromOwner(owner, id, rid, { option, note });
          }
        }
        if (!result) {
          // A refused RESPOND on a task the owner can still SEE (e.g. "Answer & close"/"Other" with an empty
          // note) re-renders the detail page with an inline error instead of a bare 404 - which would read as
          // "the task vanished" (042 code-review F1). A foreign/missing/out-of-scope task still 404s uniformly
          // (no oracle); status/assign inputs come from server dropdowns, so a null there is crafted -> 404.
          if (verb === "respond") {
            const [project, task] = await Promise.all([
              loadProjectForMember(owner.id, id),
              loadOwnerBoardTask(owner.id, id, rid),
            ]);
            if (project && task) {
              const roster = await listProjectMembersForAssign(owner.id, id);
              return page(400, taskDetailPage(owner, task, project, roster, session.csrf, "Type a response before answering, or pick an option."));
            }
          }
          return notFound(res);
        }
        // After a successful ANSWER (respond, not the dormant hand-off), auto-advance to the NEXT task in the
        // human's queue for this project - or the board if the queue is empty - carrying ?done for the toast
        // (decision 048). Every OTHER write lands back on the task's detail page (decision 041), which reflects
        // the new state - falling back to the board if the actor can no longer SEE it (a plain member who
        // reassigned their own task away).
        const answered = verb === "respond" && form.action !== "handoff";
        const dest = answered
          ? await afterAnswerDest(owner, id, rid)
          : await afterTaskWriteDest(owner, id, rid);
        return redirect(res, dest, setCookie);
      }
    }

    // GET/POST /projects/:id/messages -> send a prose note into a project (decision 039). Membership-gated.
    {
      const pid = matchId("/projects/:id/messages", path);
      if (pid !== null && method === "GET") {
        const project = await loadProjectForMember(owner.id, pid);
        if (!project) return notFound(res);
        const roster = await listProjectMembersForAssign(owner.id, pid);
        const reachedRaw = url.searchParams.get("reaches");
        const reachedParam = reachedRaw === null ? Number.NaN : Number(reachedRaw);
        return page(
          200,
          messagesPage(
            owner,
            project,
            roster,
            session.csrf,
            url.searchParams.get("sent") === "1",
            Number.isFinite(reachedParam) && reachedParam >= 0 ? reachedParam : undefined,
          ),
        );
      }
      if (pid !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const result = await sendMessageFromOwner(owner, pid, {
          toLane: form.to_lane,
          toActor: form.to_actor,
          subject: form.subject,
          body: form.body ?? "",
        });
        // Decision 065: a refusal now says WHY. This form used to render a bare 400 for every failure and,
        // on success, promised delivery it had not checked - the web twin of the silent mis-addressing the
        // decision fixes.
        if (!result || "error" in result) {
          const project = await loadProjectForMember(owner.id, pid);
          if (!project) return notFound(res);
          const roster = await listProjectMembersForAssign(owner.id, pid);
          const why = result && "error" in result ? result.error : undefined;
          // Give the operator their message back. A 400 here used to be near-impossible; decision 065 makes
          // an unknown or empty lane a COMMON refusal, and losing a long message to a typo'd lane would be a
          // new papercut introduced by a fix for silent loss.
          return page(
            400,
            messagesPage(owner, project, roster, session.csrf, false, undefined, why, {
              toLane: form.to_lane ?? "",
              toActor: form.to_actor ?? "",
              subject: form.subject ?? "",
              body: form.body ?? "",
            }),
          );
        }
        return redirect(res, `/admin/projects/${pid}/messages?sent=1&reaches=${result.reaches}`, setCookie);
      }
    }

    // GET /billing -> balance, card/top-up controls, ledger (decision 023). Opportunistic meter tick so
    // the balance is fresh (fire-and-forget, never awaited into a mutating path - decision 015 keeps
    // metering off the hot path).
    if (method === "GET" && path === "/billing") {
      if (billingEnabled(config)) void meterOwner(owner.id).catch(() => {});
      const ledger = billingEnabled(config) ? await recentLedger(owner.id) : [];
      const notice = url.searchParams.get("billing");
      return page(200, billingPage(owner, session.csrf, ledger, notice, config.RECHARGE_THRESHOLD, config.BETA_FREE));
    }

    // GET /settings -> bus handle + account + "runs on" badge (decision 023)
    if (method === "GET" && path === "/settings") {
      return page(200, settingsPage(owner, session.csrf));
    }

    // GET /connection-status?participation=<id> -> JSON presence edge for the flips-green connect
    // indicator (decision 028). Owner-scoped in-statement: a non-owned / unknown / non-finite id returns
    // the SAME 404 as any unmatched route (no 403 oracle, invariant 3). Reads presence only; never a
    // token. Positive edge only (seen:false = "not yet", never "offline"). HEAD arrives here as GET.
    if (method === "GET" && path === "/connection-status") {
      const pid = Number(url.searchParams.get("participation"));
      if (!Number.isFinite(pid)) return notFound(res);
      const status = await connectionStatus(owner.id, pid);
      if (!status) return notFound(res);
      if (setCookie) res.setHeader("set-cookie", setCookie);
      return sendJson(res, 200, status);
    }

    // POST /setup -> first-run, one step: create a project + a lead agent + grant + token, then show
    // the connect card. Collapses new-project -> new-participant -> grant into a single action.
    if (method === "POST" && path === "/setup") {
      const form = await readForm(req);
      if (!requireCsrf(form)) return forbidden(res);
      const name = (form.name ?? "").trim();
      const slug = slugify(name);
      if (!name || !slug) {
        return page(400, setupPage(owner, session.csrf, "Please enter a project name (letters and numbers)."));
      }
      // One transaction-ish sequence; any collision (slug taken, or a participant name surviving a
      // previously deleted project) re-renders the wizard with a friendly error rather than a bare 400.
      let card: string;
      try {
        const project = await createProject(owner.id, slug, name);
        const participant = await createParticipant(owner.id, `${slug}-agent`, "agent");
        const result = await grant(owner.id, project.id, participant.id, null, true);
        // A token is always minted here: createParticipant above made a BRAND-NEW agent, so it cannot
        // already be connected. Treat a null as the failure it would be rather than rendering an empty card.
        if (!result || result.plaintextToken === null) return notFound(res);
        const mcpUrl = `${config.PUBLIC_URL}/mcp`;
        // The lean first-run view (wizard screen 2): the shared tabbed connect card + live indicator.
        card = wizardConnectCard(
          owner,
          project,
          participant.name,
          result.plaintextToken,
          mcpUrl,
          result.participation.id,
          claudeConnectUrl(config.PUBLIC_URL),
        );
      } catch {
        return page(400, setupPage(owner, session.csrf, "That name is taken or invalid - try another."));
      }
      return page(200, card);
    }

    // GET /handle -> folded into Settings (decision 023); redirect old links/bookmarks.
    if (method === "GET" && path === "/handle") {
      return redirect(res, "/admin/settings", setCookie);
    }

    // POST /handle -> change the handle, re-render Settings (decision 018 action, decision 023 surface)
    if (method === "POST" && path === "/handle") {
      const form = await readForm(req);
      if (!requireCsrf(form)) return forbidden(res);
      const result = await changeUsername(owner.id, form.username ?? "");
      if (!result.ok) return page(400, settingsPage(owner, session.csrf, result.error));
      const updated = { ...owner, username: result.username, usernameConfirmed: true };
      return page(200, settingsPage(updated, session.csrf, undefined, true));
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
      if (!name) {
        return page(400, newParticipantPage(owner, session.csrf));
      }
      // Humans are not participants (decisions 037/038) - they join via SSO invite. The dashboard only
      // ever creates AI agents; the participants.kind column stays for the API surface but the UI is agent-only.
      await createParticipant(owner.id, name, "agent");
      return redirect(res, `/admin/participants`, setCookie);
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
        // Decision 070: an already-connected agent gets no token to install, so it gets no hand-out card
        // either - showing one would imply setup work that does not exist.
        if (result.plaintextToken === null) {
          return page(
            200,
            addedToProjectCard(owner, project, participantName, result.participation.isAdmin, result.participation.lane),
          );
        }
        return page(
          200,
          handoutCard(owner, project, participantName, result.plaintextToken, mcpUrl, result.participation.isAdmin),
        );
      }
    }

    // GET /projects/:id -> the read-only Board (project front page; decision 023). The human drives tasks
    // from /admin/tasks (decision 039); this Board is situational-awareness only.
    {
      const id = matchId("/projects/:id", path);
      if (id !== null && method === "GET") {
        // 078/OI-37: a project admin READS this page; every mutation stays on loadOwnedProject.
        const project = await loadProjectForAdminRead(owner.id, id);
        if (!project) return notFound(res);
        const [activity, board] = await Promise.all([
          loadProjectActivity(owner.id, project.id),
          loadProjectBoard(owner.id, project.id),
        ]);
        return page(200, projectBoardPage(owner, project, undefined, activity, board));
      }
    }

    // GET /projects/:id/access -> members + targeted invites (decision 023; request-to-join retired by 038)
    {
      const id = matchId("/projects/:id/access", path);
      if (id !== null && method === "GET") {
        // 078/OI-37: a project admin READS this page; every mutation stays on loadOwnedProject.
        const project = await loadProjectForAdminRead(owner.id, id);
        if (!project) return notFound(res);
        const [participations, invites, members] = await Promise.all([
          listParticipations(owner.id, project.id),
          listInvites(owner.id, project.id),
          listProjectHumanMembers(owner.id, project.id),
        ]);
        // Flashes: invite-by-email sent, or a bad email address.
        const invited = url.searchParams.get("invited");
        const notice = invited
          ? `Invitation emailed to ${invited}. They click the link, sign in, and connect - no setup on your end.`
          : url.searchParams.get("invite_err")
            ? "That doesn't look like a valid email address - try again."
            : undefined;
        return page(200, projectAccessPage(owner, project, participations, invites, members, session.csrf, notice));
      }
    }

    // GET /projects/:id/settings -> rename, hosted-structure placeholder, delete (decision 023)
    {
      const id = matchId("/projects/:id/settings", path);
      if (id !== null && method === "GET") {
        // 078/OI-37: a project admin READS this page; every mutation stays on loadOwnedProject.
        const project = await loadProjectForAdminRead(owner.id, id);
        if (!project) return notFound(res);
        return page(200, projectSettingsPage(owner, project, session.csrf));
      }
    }

    // Request-to-join routes (approve / deny / request-mode / my-requests claim) were RETIRED by decision 038
    // (targeted-invite-only). Enrollment is now create_invite -> /admin/accept exclusively.

    // POST /participations/:id/revoke
    {
      const id = matchId("/participations/:id/revoke", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        // revokeParticipation is itself owner-scoped: a non-owned id is a silent no-op. Return to the
        // project the row lives on (the form posts its project_id) so managing access isn't interrupted;
        // fall back to the dashboard if it's absent.
        await revokeParticipation(owner.id, id);
        const pid = Number(form.project_id);
        return redirect(res, Number.isFinite(pid) && pid > 0 ? `/admin/projects/${pid}/access` : `/admin`, setCookie);
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

    // POST /projects/:id/member-role -> promote a HUMAN member to admin, or demote (decision 080).
    // form: member_owner_id, admin=1|0. Owner-only ON PURPOSE and narrower than the read it unlocks: this
    // decides who else can see a whole project, so a project ADMIN cannot mint more admins.
    {
      const id = matchId("/projects/:id/member-role", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const project = await loadOwnedProject(owner.id, id); // mutation gate, not the 078 read clause
        if (!project) return notFound(res);
        const memberOwnerId = Number(form.member_owner_id);
        await setProjectMemberRole(owner.id, project.id, memberOwnerId, form.admin === "1");
        return redirect(res, `/admin/projects/${project.id}/access`, setCookie);
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
        return redirect(res, Number.isFinite(pid) && pid > 0 ? `/admin/projects/${pid}/access` : "/admin", setCookie);
      }
    }

    // POST /participations/:id/lane -> set or CLEAR the routing lane (decision 065; empty value = clear)
    {
      const id = matchId("/participations/:id/lane", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const lane = (form.lane ?? "").trim().slice(0, 64);
        await setParticipationLane(owner.id, id, lane === "" ? null : lane); // owner-scoped no-op if not owned
        const pid = Number(form.project_id);
        return redirect(res, Number.isFinite(pid) && pid > 0 ? `/admin/projects/${pid}/access` : "/admin", setCookie);
      }
    }

    // GET /projects/:id/edit -> folded into the project Settings tab (decision 023); redirect old links.
    // Still owner-checked first so a non-owner gets the same 404 (no redirect to a would-be-404 URL).
    {
      const id = matchId("/projects/:id/edit", path);
      if (id !== null && method === "GET") {
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        return redirect(res, `/admin/projects/${project.id}/settings`, setCookie);
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
          return page(400, projectSettingsPage(owner, project, session.csrf, "Name and slug are required."));
        }
        const r = await renameProject(owner.id, project.id, name, slug);
        if (r === "conflict") {
          return page(409, projectSettingsPage(owner, { ...project, name, slug }, session.csrf, "You already have a project with that slug."));
        }
        if (r === "notfound") return notFound(res);
        return redirect(res, `/admin/projects/${project.id}/settings`, setCookie);
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
        const [successors, openTasks] = await Promise.all([
          listReassignCandidates(owner.id, participant.id),
          countOpenTasksForParticipant(owner.id, participant.id),
        ]);
        return page(
          200,
          editParticipantPage(owner, participant, grants, session.csrf, undefined, successors, openTasks),
        );
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
        // reassign_to hands their open work to another of this owner's agents (decision 069); empty means
        // put it back on the board. The value is re-validated owner-scoped in the query, so a crafted id
        // cannot move work to another tenant.
        const reassignRaw = Number((form.reassign_to ?? "").trim());
        const reassignTo = Number.isFinite(reassignRaw) && reassignRaw > 0 ? reassignRaw : null;
        await deleteParticipant(owner.id, id, reassignTo); // owner-scoped: a non-owned id is a silent no-op
        return redirect(res, `/admin/participants`, setCookie);
      }
    }

    // The open-code invite routes (GET/POST /projects/:id/invite) are RETIRED (decision 037): a collaborator
    // joins by accepting an EMAILED targeted invite and signing in (SSO), so their agent binds to their OWN
    // identity and they become a project member. The remaining path is POST /projects/:id/invite-email below.

    // POST /projects/:id/invite-email -> mint a targeted invite + EMAIL the join link (the "add by email"
    // path). Reuses createOrgInvite (mints under the PROJECT owner - invariant 3; only the token hash is
    // stored - invariant 7) + the /accept flow; the email is best-effort (invariant 5). Lands on the Access
    // tab with a flash.
    {
      const id = matchId("/projects/:id/invite-email", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const project = await loadOwnedProject(owner.id, id);
        if (!project) return notFound(res);
        const email = (form.email ?? "").trim().toLowerCase();
        // Minimal shape check; the real gate is that acceptInvite verifies this address against the
        // invitee's OAuth-verified identity, so a wrong address simply never accepts.
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return redirect(res, `/admin/projects/${project.id}/access?invite_err=1`, setCookie);
        }
        const lane = form.lane && form.lane.trim() ? form.lane.trim() : null;
        const isAdmin = form.is_admin === "1" || form.is_admin === "on";
        // Decision 057: an emailed invite always provisions an AGENT seat. The invitee's human identity is
        // carried by their project_members row (stamped on accept), never a "human"-kind participation - that
        // duplicate placeholder was the source of the orphan human-<name> rows (the 037/038/056 lineage).
        const inv = await createOrgInvite(owner.id, project.id, { targetEmail: email, lane, isAdmin });
        if (!inv) return notFound(res);
        void notifyInvite(email, owner.username, project.name, inv.token);
        return redirect(res, `/admin/projects/${project.id}/access?invited=${encodeURIComponent(email)}`, setCookie);
      }
    }

    // POST /invites/:id/revoke
    {
      const id = matchId("/invites/:id/revoke", path);
      if (id !== null && method === "POST") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        await revokeInvite(owner.id, id); // owner-scoped: a non-owned id is a silent no-op
        const pid = Number(form.project_id);
        return redirect(res, Number.isFinite(pid) && pid > 0 ? `/admin/projects/${pid}/access` : `/admin`, setCookie);
      }
    }

    // ── Billing (decision 015): owner-self routes; CSRF on every POST; inert when unconfigured.
    // Amounts validated against the fixed ladder server-side; redirect targets are Stripe-issued. ──
    if (billingEnabled(config)) {
      if (method === "POST" && path === "/billing/setup") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const url = await createSetupSession(owner);
        return redirect(res, url ?? "/admin/billing", setCookie);
      }
      if (method === "POST" && path === "/billing/portal") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        const url = await createPortalSession(owner);
        return redirect(res, url ?? "/admin/billing", setCookie);
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
        return redirect(res, "/admin/billing", setCookie);
      }
      if (method === "POST" && path === "/billing/topup") {
        const form = await readForm(req);
        if (!requireCsrf(form)) return forbidden(res);
        // Money guard (decision 059): during the free beta NEVER charge a card, even on a direct POST that
        // bypasses the hidden UI. This is the only manual charge path; the auto-recharge path is already
        // inert (the meter's BETA_FREE branch never reaches handleLowBalance/chargeTopUp).
        if (config.BETA_FREE) return redirect(res, "/admin/billing?billing=freebeta", setCookie);
        const amt = Number(form.amount);
        let notice = "badamount";
        if (BONUS_LADDER.some(([n]) => n === amt)) {
          const r = await chargeTopUp(owner, amt);
          notice =
            r === "credited" ? "added" : r === "pending" ? "charging" : r === "declined" ? "declined" : "nocard";
        }
        return redirect(res, `/admin/billing?billing=${notice}`, setCookie);
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
