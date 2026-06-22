import type http from "node:http";
import type { Owner } from "./owner.js";
import type {
  ProjectRow,
  ParticipantRow,
  ParticipationRow,
  ParticipantGrantRow,
} from "./queries.js";
import {
  buildHandoutPrompt,
  buildJoinFiles,
  buildConnectCommand,
  coordinationGuide,
  type InviteRow,
} from "../invite.js";
import { BONUS_LADDER } from "../billing/credits.js";

/** A recent credit-ledger entry for the dashboard billing slot. */
export interface LedgerRow {
  type: string;
  amount: number;
  balance_after: number;
  created_at: string;
}

// This module is the single rendering layer for the web admin. There is exactly ONE way to
// emit a dynamic value into HTML — esc() — and every page builder routes every interpolated
// string through it. No template ever concatenates an un-esc()'d value. That is the whole XSS
// story: every dynamic value is esc()'d. The ONLY client JS is one STATIC copy-to-clipboard
// handler (no interpolation — it reads a block's text from the DOM and copies it, injecting
// nothing); the only external asset is the Google Fonts stylesheet (DM Sans + JetBrains Mono,
// degrades to system fonts if blocked).

/** HTML-escape: the single XSS chokepoint. EVERY interpolated value must pass through this. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Dark palette + type scale (DM Sans + JetBrains Mono).
// The LLM Bus design system (brand/system.css), inlined for the server-rendered admin. Black & white,
// Scandinavian; one 4px spacing scale; the existing class vocabulary is mapped onto the system so all
// pages restyle from here. Keep page code composing these classes - do not invent ad-hoc px/colours.
const STYLE = `
  :root {
    --ink-900:#111315; --ink-800:#1b1e22; --ink-700:#2b2f36;
    --gray-600:#4b5159; --gray-500:#6b7178; --gray-400:#969ba2; --gray-300:#c5c9ce;
    --gray-200:#e2e5e8; --gray-100:#eef0f2; --gray-50:#f7f8f9; --white:#ffffff;
    --line:#e2e5e8; --line-strong:#c5c9ce;
    --ok:#137a52; --ok-wash:#e7f4ee; --bad:#b42318; --bad-wash:#fdeceb;
    --font-sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    --font-mono:'JetBrains Mono','IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font-sans); font-size: 15px; line-height: 1.6; margin: 0;
         background: var(--gray-50); color: var(--ink-900); -webkit-font-smoothing: antialiased; }
  a { color: var(--ink-900); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
  a:hover { color: var(--gray-600); }
  header.site { padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--white);
                display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 5; }
  header.site .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; font-size: 16px;
                       color: var(--ink-900); letter-spacing: -0.01em; text-decoration: none; }
  header.site .brand svg { width: 22px; height: 22px; }
  header.site .nav { color: var(--ink-900); font-size: 13px; }
  header.site .who { color: var(--gray-500); font-size: 13px; margin-left: auto; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 96px; }
  h1 { font-size: 30px; font-weight: 650; margin: 4px 0 8px; letter-spacing: -0.02em; line-height: 1.15; }
  h2 { font-size: 20px; font-weight: 650; margin: 40px 0 14px; letter-spacing: -0.01em; }
  .lead { color: var(--gray-600); font-size: 17px; margin: 0 0 20px; max-width: 64ch; }
  .muted { color: var(--gray-500); }
  /* The plain-English "what does this do" explainer box. */
  .help { background: var(--white); border: 1px solid var(--line); border-left: 3px solid var(--ink-900);
          border-radius: 12px; padding: 16px 18px; margin: 16px 0 24px; color: var(--gray-600); font-size: 14px; }
  .help b { color: var(--ink-900); }
  .help ul { margin: 8px 0 0; padding-left: 18px; }
  .help li { margin: 4px 0; }
  .help code, .hint code { font-family: var(--font-mono); background: var(--gray-100); padding: 1px 5px;
          border-radius: 3px; color: var(--ink-800); }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 15px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  th { font-family: var(--font-mono); color: var(--gray-500); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.08em; }
  tbody tr:last-child td { border-bottom: 0; }
  .sectionhead { display: flex; align-items: center; justify-content: space-between; }
  .sectionhead h2 { margin-bottom: 0; }
  .pill { display: inline-flex; align-items: center; font-family: var(--font-mono); padding: 2px 8px;
          border-radius: 999px; font-size: 12px; background: var(--gray-100); color: var(--ink-800); border: 1px solid var(--line); }
  .pill.ok { background: var(--ok-wash); color: var(--ok); border-color: transparent; }
  .pill.off { background: var(--bad-wash); color: var(--bad); border-color: transparent; }
  .pill.admin { background: var(--ink-900); color: var(--white); border-color: var(--ink-900); }
  form.stack { display: flex; flex-direction: column; gap: 16px; max-width: 480px; margin: 18px 0; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink-800); }
  label.inline { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; color: var(--gray-600); }
  .hint { font-size: 12px; font-weight: 400; color: var(--gray-500); margin: 0; }
  input, select { padding: 11px 13px; border-radius: 8px; border: 1px solid var(--line-strong);
                  background: var(--white); color: var(--ink-900); font-size: 15px; font-family: var(--font-sans); }
  input:focus, select:focus { outline: none; border-color: var(--ink-900); box-shadow: 0 0 0 3px var(--gray-200); }
  button, .btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px; border-radius: 8px;
           border: 1px solid transparent; background: var(--ink-900); color: var(--white); font-size: 15px;
           font-weight: 600; cursor: pointer; font-family: var(--font-sans); line-height: 1; text-decoration: none;
           transition: background .12s; }
  button:hover, .btn:hover { background: var(--ink-700); color: var(--white); text-decoration: none; }
  .btn.sm, button.sm { padding: 8px 13px; font-size: 13px; background: var(--white); color: var(--ink-900);
           border: 1px solid var(--line-strong); }
  .btn.sm:hover, button.sm:hover { background: var(--gray-100); color: var(--ink-900); }
  button.danger { background: var(--white); color: var(--bad); border: 1px solid var(--line-strong); padding: 7px 13px; font-size: 13px; }
  button.danger:hover { background: var(--bad-wash); color: var(--bad); }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px; margin: 16px 0; background: var(--white); }
  .card.warn { border-color: transparent; background: var(--bad-wash); }
  .card h2 { margin-top: 0; }
  pre { background: var(--ink-900); border: 0; border-radius: 8px; padding: 16px; overflow-x: auto;
        font-size: 13px; margin: 6px 0 14px; color: var(--gray-100); }
  code { font-family: var(--font-mono); font-size: 13px; }
  .codeblock { position: relative; }
  .codeblock > pre { margin: 0; padding-top: 36px; }
  .codeblock button.copy { position: absolute; top: 8px; right: 8px; padding: 4px 10px; font-size: 12px;
        font-weight: 600; background: var(--ink-700); color: var(--gray-100); border: 1px solid var(--ink-700); border-radius: 6px; }
  .codeblock button.copy:hover { background: var(--gray-600); color: var(--white); }
  .back { display: inline-block; margin-top: 24px; color: var(--gray-500); font-size: 14px; }
  .row-actions form { display: inline; }
  .error { color: var(--bad); }
  .panel { background: var(--white); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  .metrics { list-style: none; display: flex; flex-wrap: wrap; gap: 24px; padding: 18px 20px; margin: 12px 0 4px;
             border: 1px solid var(--line); border-radius: 12px; background: var(--white); }
  .metrics li { font-size: 13px; color: var(--gray-500); }
  .metrics b { display: block; font-family: var(--font-mono); font-size: 22px; color: var(--ink-900); font-weight: 600; }
`;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  "family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap\">";

/** Page shell. `bodyHtml` is trusted (assembled by builders that esc() their inputs). */
export function layout(title: string, bodyHtml: string, owner?: Owner): string {
  const who = owner
    ? `<span class="who">${esc(owner.email)}</span>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · LLM Bus</title>
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<header class="site"><a class="brand" href="/admin"><svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M154.34,60.53 L177.58,20.29"/><path d="M115.34,83.05 L68.87,83.05"/><path d="M154.34,105.57 L177.58,145.81"/><circle cx="141.34" cy="83.05" r="20"/><circle cx="177.58" cy="20.29" r="16" fill="currentColor" stroke="none"/><circle cx="68.87" cy="83.05" r="16" fill="currentColor" stroke="none"/><circle cx="177.58" cy="145.81" r="16" fill="currentColor" stroke="none"/></svg>LLM&nbsp;Bus</a>${who}</header>
<main>${bodyHtml}</main>
<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('button.copy');
  if (!b) return;
  var el = document.getElementById(b.getAttribute('data-copy'));
  if (!el || !navigator.clipboard) return;
  navigator.clipboard.writeText(el.innerText).then(function () {
    var prev = b.textContent; b.textContent = 'Copied!';
    setTimeout(function () { b.textContent = prev; }, 1200);
  }).catch(function () {});
});
</script>
</body>
</html>`;
}

/** Write an HTML response with the correct content type. */
export function respondHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
}

/** A copyable code block: a "Copy" button (wired by the static script in layout) + esc()'d content. */
function codeblock(id: string, content: string): string {
  return `<div class="codeblock"><button type="button" class="copy" data-copy="${esc(id)}">Copy</button><pre id="${esc(id)}"><code>${esc(content)}</code></pre></div>`;
}

// ── Page builders ──────────────────────────────────────────────────────────

/** The OAuth sign-in page (ADMIN_AUTH_SOURCE=oauth). Static links; the provider `state` carries CSRF.
 *  When `inviteToken` is set the start links carry it so the sign-in accepts the invite on callback. */
export function loginPage(error?: string, inviteToken?: string): string {
  const err = error ? `<p class="error">${esc(error)}</p>` : "";
  const q = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  const lead = inviteToken
    ? `<p class="muted">You've been invited to a project. Sign in to accept and connect.</p>`
    : `<p class="muted">Sign in to manage your projects, participants, and invites.</p>`;
  const body = `
    <section class="panel">
      <h1>Sign in</h1>
      ${lead}
      ${err}
      <p><a class="btn" href="/admin/auth/google/start${q}">Continue with Google</a></p>
      <p><a class="btn" href="/admin/auth/github/start${q}">Continue with GitHub</a></p>
    </section>`;
  return layout("Sign in", body);
}

/** Shown after a successful invite acceptance: the bearer token + ready config + the protocol. */
export function acceptedPage(
  projectName: string,
  participant: string,
  token: string,
  mcpUrl: string,
  isAdmin: boolean,
): string {
  const files = buildJoinFiles(token, mcpUrl);
  const body = `
    <section class="panel">
      <h1>You're in: ${esc(projectName)}</h1>
      <p class="muted">Connected as <b>${esc(participant)}</b>. Run the one command below in your project
      directory, verify, restart, and call <code>whoami</code>.</p>
      <h2>Connect (one command, Claude Code)</h2>
      ${codeblock("accepted-connect", buildConnectCommand(token, mcpUrl))}
      <p class="muted">Then <code>claude mcp list</code> should show <code>llm-bus ... Connected</code>.
      Restart your session (MCP loads only at startup - expected), then call <code>whoami</code>. Needs a
      recent Claude Code (<code>claude --version</code>).</p>
      <h2>Not Claude Code? (Cursor / Codex / Windsurf / VS Code)</h2>
      ${codeblock("accepted-mcp", files[".mcp.json"])}
      <p class="muted">Write that as <code>.mcp.json</code> and set <code>LLM_BUS_TOKEN</code> in a
      gitignored <code>.claude/settings.local.json</code>
      (<code>{"env":{"LLM_BUS_TOKEN":"..."}}</code>) - it must be set or the server won't connect.</p>
      <h2>Coordination protocol (append to CLAUDE.md)</h2>
      ${codeblock("accepted-guide", coordinationGuide(isAdmin))}
    </section>`;
  return layout("Joined", body);
}

export function dashboardPage(
  owner: Owner,
  projects: ProjectRow[],
  participants: ParticipantRow[],
  csrf: string,
  ledger: LedgerRow[],
  billingNotice: string | null,
  rechargeThreshold: number,
): string {
  const projectRows = projects.length
    ? projects
        .map(
          (p) => `<tr>
        <td><a href="/admin/projects/${esc(p.id)}">${esc(p.name)}</a></td>
        <td><code>${esc(p.slug)}</code></td>
        <td>${esc(p.participationCount)}</td>
        <td>${esc(p.eventCount)}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">No projects yet — start with <b>+ New project</b>.</td></tr>`;

  const participantRows = participants.length
    ? participants
        .map(
          (p) => `<tr>
        <td>${esc(p.name)}</td>
        <td><span class="pill">${esc(p.kind)}</span></td>
        <td>${esc(p.grantCount)}</td>
        <td class="row-actions"><a class="btn sm" href="/admin/participants/${esc(p.id)}/edit">Edit</a></td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">No participants yet — add one with <b>+ New participant</b>.</td></tr>`;

  const body = `
    <h1>Dashboard</h1>
    <p class="lead">Your coordination control plane.</p>

    <div class="help">
      <b>What is this?</b> LLM Bus gives your AI agents a shared, live source of truth so they don't
      step on each other — gap-free ID numbers (ADRs, migrations), who's working on what right now,
      hand-off messages, file locks, and a shared task list.
      <ul>
        <li><b>Project</b> = one coordination space (usually one codebase or team). Agents in it share its
            numbering and history. Projects are fully isolated from each other.</li>
        <li><b>Participant</b> = one identity you create — an AI <code>agent</code> or a <code>human</code>.
            One participant = one access token (reused across all of that agent's sub-agents).</li>
        <li><b>To put an agent to work:</b> make a Project + a Participant, then open the project and
            <b>Grant</b> the participant in — that mints the token you paste into the agent.</li>
      </ul>
    </div>

    <div class="sectionhead"><h2>Projects</h2><a class="btn sm" href="/admin/projects/new">+ New project</a></div>
    <table>
      <thead><tr><th>Name</th><th>Slug</th><th>Participants</th><th>Events</th></tr></thead>
      <tbody>${projectRows}</tbody>
    </table>

    <div class="sectionhead"><h2>Participants</h2><a class="btn sm" href="/admin/participants/new">+ New participant</a></div>
    <table>
      <thead><tr><th>Name</th><th>Kind</th><th>In&nbsp;projects</th><th></th></tr></thead>
      <tbody>${participantRows}</tbody>
    </table>

    <div class="sectionhead"><h2>Billing</h2></div>
    ${billingSlot(owner, csrf, ledger, billingNotice, rechargeThreshold)}`;
  return layout("Dashboard", body, owner);
}

/** A one-shot billing banner from the ?billing= redirect param. For states that settle via webhook
 *  (card-saved / charging) it auto-reloads to a clean /admin once so the new balance shows. */
function billingBanner(notice: string | null): string {
  if (!notice) return "";
  const refresh = `<meta http-equiv="refresh" content="4;url=/admin">`;
  switch (notice) {
    case "added":
      return `<div class="card"><b>Credits added.</b> Your new balance is below.</div>`;
    case "charging":
      return `${refresh}<div class="card">Payment processing &mdash; your balance updates in a moment.</div>`;
    case "card-saved":
      return `${refresh}<div class="card"><b>Card saved.</b> Applying your welcome credit&hellip;</div>`;
    case "declined":
      return `<div class="card warn"><b>Card was declined.</b> Try a different amount or update your card.</div>`;
    case "nocard":
      return `<div class="card warn">Add a card before topping up.</div>`;
    default:
      return "";
  }
}

/** The dashboard billing slot: balance, card/top-up/auto-recharge controls, recent ledger. */
function billingSlot(
  owner: Owner,
  csrf: string,
  ledger: LedgerRow[],
  notice: string | null,
  rechargeThreshold: number,
): string {
  if (owner.plan === "comped") {
    return `<div class="help">Billing: <span class="pill">Sponsored</span> &mdash; this account is comped; usage is not metered.</div>`;
  }
  const ladderOpts = (selected: number | null): string =>
    BONUS_LADDER.map(([nok, bonus]) => {
      const label =
        bonus > 0 ? `${nok} NOK (+${Math.round(bonus * 100)}% = ${Math.round(nok * (1 + bonus))} tokens)` : `${nok} NOK`;
      return `<option value="${nok}"${selected === nok ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
  const ledgerRows = ledger.length
    ? ledger
        .map(
          (e) =>
            `<tr><td><span class="pill">${esc(e.type)}</span></td><td>${esc(e.amount)}</td><td>${esc(
              e.balance_after,
            )}</td><td class="muted">${esc(e.created_at)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">No credit activity yet.</td></tr>`;

  const controls = owner.hasCard
    ? `<p>
         <form method="POST" action="/admin/billing/topup" style="display:inline-block;margin-right:.6rem">${csrfField(
           csrf,
         )}<select name="amount">${ladderOpts(null)}</select> <button type="submit">Add credits now</button></form>
         <form method="POST" action="/admin/billing/portal" style="display:inline-block">${csrfField(
           csrf,
         )}<button type="submit">Manage card</button></form>
       </p>
       <form method="POST" action="/admin/billing/auto-recharge" style="margin-top:.4rem">${csrfField(csrf)}
         <p class="muted" style="margin:.2rem 0">Auto top-up: when your balance drops below
         <b>${esc(rechargeThreshold)}</b> tokens, your card is automatically charged the amount you pick to
         top it back up. "Off" = no automatic charges.</p>
         <select name="amount"><option value="">Off</option>${ladderOpts(owner.autoRechargeAmount)}</select>
         <button type="submit">Save auto top-up</button></form>`
    : `<form method="POST" action="/admin/billing/setup" style="display:inline-block">${csrfField(
        csrf,
      )}<button type="submit">Add a card</button></form>
       <span class="muted">No card needed to try. Add one to get welcome credits and auto top-ups.</span>`;

  return `<div class="help">
      ${billingBanner(notice)}
      ${owner.tokenBalance < rechargeThreshold ? `<p><b>Low balance.</b> Top up to keep coordinating; agents are never blocked mid-work.</p>` : ""}
      <p>Token balance: <b>${esc(owner.tokenBalance)}</b> <span class="muted">(1 token = 1 NOK; every bus event costs 1 token)</span></p>
      ${controls}
      <table style="margin-top:.7rem">
        <thead><tr><th>Type</th><th>Tokens</th><th>Balance</th><th>When</th></tr></thead>
        <tbody>${ledgerRows}</tbody>
      </table>
    </div>`;
}

export function newProjectPage(owner: Owner, csrf: string): string {
  const body = `
    <h1>New project</h1>
    <div class="help">
      A <b>project</b> is one coordination space — usually a single codebase or team. Agents you grant into
      it share its ID counters (ADRs, migrations), presence, hand-offs, and tasks. Nothing leaks between
      projects. Create one project per thing your agents collaborate on.
    </div>
    <form class="stack" method="POST" action="/admin/projects">
      ${csrfField(csrf)}
      <label>Slug
        <input name="slug" required pattern="[a-z0-9\\-]+" placeholder="bu2">
        <span class="hint">Short internal id: lowercase letters, numbers, dashes (e.g. <code>bu2</code>).</span>
      </label>
      <label>Name
        <input name="name" required placeholder="BU2 platform">
        <span class="hint">A human-friendly label shown in this dashboard.</span>
      </label>
      <button type="submit">Create project</button>
    </form>
    <a class="back" href="/admin">← Cancel</a>`;
  return layout("New project", body, owner);
}

export function newParticipantPage(owner: Owner, csrf: string): string {
  const body = `
    <h1>New participant</h1>
    <div class="help">
      A <b>participant</b> is one identity that will coordinate in your projects — an AI <code>agent</code>
      or a <code>human</code> who drives agents. It's the unique entity "on the ledger" (and the unit you're
      billed per, per project). One participant = one token, shared across all of that agent's sub-agents
      (they count as one identity). Creating a participant does nothing on its own until you <b>grant</b> it
      into a project.
    </div>
    <form class="stack" method="POST" action="/admin/participants">
      ${csrfField(csrf)}
      <label>Name
        <input name="name" required placeholder="backend-agent">
        <span class="hint">How this identity shows up to others (e.g. <code>backend-agent</code>, <code>paul</code>).</span>
      </label>
      <label>Kind
        <select name="kind">
          <option value="agent">agent — an AI</option>
          <option value="human">human — a person driving agents</option>
        </select>
        <span class="hint">Just a label; doesn't change how it works.</span>
      </label>
      <button type="submit">Create participant</button>
    </form>
    <a class="back" href="/admin">← Cancel</a>`;
  return layout("New participant", body, owner);
}

export function projectPage(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  participations: ParticipationRow[],
  invites: InviteRow[],
  csrf: string,
): string {
  const rows = participations.length
    ? participations
        .map((p) => {
          const tokenPill = p.tokenActive
            ? `<span class="pill ok">active</span>`
            : `<span class="pill off">revoked</span>`;
          const revoke = p.tokenActive
            ? `<form method="POST" action="/admin/participations/${esc(p.participationId)}/revoke">
                 ${csrfField(csrf)}
                 <button type="submit" class="danger">Revoke</button>
               </form>`
            : "";
          const rotate = p.tokenActive
            ? `<form method="POST" action="/admin/participations/${esc(p.participationId)}/rotate">
                 ${csrfField(csrf)}
                 <button type="submit" class="btn sm">Rotate</button>
               </form>`
            : "";
          const toggle = `<form method="POST" action="/admin/participations/${esc(p.participationId)}/set-admin">
                 ${csrfField(csrf)}
                 <input type="hidden" name="project_id" value="${esc(project.id)}">
                 <input type="hidden" name="admin" value="${p.isAdmin ? "0" : "1"}">
                 <button type="submit" class="btn sm">${p.isAdmin ? "Remove lead" : "Make lead"}</button>
               </form>`;
          return `<tr>
            <td>${esc(p.participantName)}</td>
            <td><span class="pill">${esc(p.kind)}</span></td>
            <td>${p.lane === null ? '<span class="muted">—</span>' : esc(p.lane)}</td>
            <td>${p.isAdmin ? '<span class="pill admin">admin (lead)</span>' : ""}</td>
            <td>${tokenPill}</td>
            <td>${esc(p.eventCount)}</td>
            <td class="row-actions">${toggle}${rotate}${revoke}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No one granted yet — use <b>+ Grant access</b>.</td></tr>`;

  const inviteRows = invites.length
    ? invites
        .map(
          (i) => `<tr>
            <td><code>${esc(i.code)}</code></td>
            <td>${i.intendedName ? esc(i.intendedName) : '<span class="muted">any name</span>'}${i.isAdmin ? ' <span class="pill admin">admin</span>' : ""}</td>
            <td>${i.lane === null ? '<span class="muted">—</span>' : esc(i.lane)}</td>
            <td>${esc(i.uses)}/${esc(i.maxUses)}</td>
            <td class="muted">${esc(i.expiresAt.slice(0, 16).replace("T", " "))}</td>
            <td class="row-actions"><form method="POST" action="/admin/invites/${esc(i.id)}/revoke">${csrfField(csrf)}<button type="submit" class="danger">Revoke</button></form></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">No open invites.</td></tr>`;

  const body = `
    <h1>${esc(project.name)}</h1>
    <p class="lead">Slug <code>${esc(project.slug)}</code> · <a href="/admin/projects/${esc(project.id)}/edit">edit / delete</a></p>

    <div class="help">
      Everyone you've let into this project. Each row is a <b>participation</b> — one participant's access,
      with its token status and how many events it has logged here.
      <ul>
        <li><b>+ Grant access</b> — let a participant in and mint their token.</li>
        <li><b>Rotate</b> — mint a fresh token and revoke the old one in a single step (no lockout
            gap); the new hand-out card is shown once. Use it when a token may have leaked.</li>
        <li><b>Revoke</b> — instantly kill that token (the agent is locked out until you grant again).
            Their past history stays.</li>
      </ul>
    </div>

    <div class="sectionhead"><h2>Participants in this project</h2>
      <a class="btn sm" href="/admin/projects/${esc(project.id)}/grant">+ Grant access</a></div>
    <table>
      <thead><tr><th>Participant</th><th>Kind</th><th>Lane</th><th>Role</th>
        <th>Token</th><th>Events</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="sectionhead"><h2>Open invites</h2>
      <a class="btn sm" href="/admin/projects/${esc(project.id)}/invite">+ Create invite</a></div>
    <table>
      <thead><tr><th>Code</th><th>For</th><th>Lane</th><th>Uses</th><th>Expires</th><th></th></tr></thead>
      <tbody>${inviteRows}</tbody>
    </table>

    <a class="back" href="/admin">← Back to dashboard</a>`;
  return layout(project.name, body, owner);
}

export function inviteFormPage(
  owner: Owner,
  project: { id: number; name: string },
  csrf: string,
): string {
  const body = `
    <h1>Create invite</h1>
    <p class="lead">Project <strong>${esc(project.name)}</strong></p>
    <div class="help">
      An invite is a copy-paste prompt you send to the invited party. Their AI redeems it, collects its
      token, saves its config, connects, and confirms — <b>zero setup on their end</b>. The token is
      delivered to them directly and never passes through you. Codes are one-use and expire (default 24h).
    </div>
    <form class="stack" method="POST" action="/admin/projects/${esc(project.id)}/invite">
      ${csrfField(csrf)}
      <label>Name <span class="muted">(optional)</span>
        <input name="name" placeholder="ai-codex-frontend">
        <span class="hint">Leave blank to let them choose their own identity name when they redeem.</span>
      </label>
      <label>Kind
        <select name="kind"><option value="agent">agent — an AI</option><option value="human">human</option></select>
      </label>
      <label>Lane <span class="muted">(optional)</span>
        <input name="lane" placeholder="frontend">
        <span class="hint">Optional role label; never partitions coordination.</span>
      </label>
      <label class="inline"><input type="checkbox" name="is_admin" value="1"> Invite as project admin (lead)</label>
      <label>Valid for (hours)
        <input name="ttl_hours" type="number" min="1" max="168" value="24">
      </label>
      <label>Uses
        <input name="uses" type="number" min="1" max="50" value="1">
        <span class="hint">How many teammates can redeem this one code (1 = single use).</span>
      </label>
      <button type="submit">Create invite</button>
    </form>
    <a class="back" href="/admin/projects/${esc(project.id)}">← Cancel</a>`;
  return layout("Create invite", body, owner);
}

export function invitePromptPage(
  owner: Owner,
  project: { id: number; name: string },
  prompt: string,
  expiresAt: string,
): string {
  const body = `
    <h1>Invite created</h1>
    <p class="lead">Project <strong>${esc(project.name)}</strong> · valid until <span class="muted">${esc(expiresAt.slice(0, 16).replace("T", " "))} UTC</span></p>
    <div class="help"><b>Copy the block below and send it to the invited party</b> (paste it to their AI, drop it in their repo, or email it). They redeem it and self-connect — you do nothing else.</div>
    <div class="card">
      <h2>Invite prompt</h2>
      ${codeblock("copytext", prompt)}
    </div>
    <a class="back" href="/admin/projects/${esc(project.id)}">← Back to project</a>`;
  return layout("Invite created", body, owner);
}

export function grantPage(
  owner: Owner,
  project: { id: number; name: string },
  participants: ParticipantRow[],
  csrf: string,
): string {
  const options = participants.length
    ? participants
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.kind)})</option>`)
        .join("")
    : "";
  const formOrEmpty = participants.length
    ? `<form class="stack" method="POST" action="/admin/projects/${esc(project.id)}/grant">
         ${csrfField(csrf)}
         <label>Participant
           <select name="participant_id" required>${options}</select>
           <span class="hint">Who to let in. Don't see them? <a href="/admin/participants/new">Create a participant</a> first.</span>
         </label>
         <label>Lane <span class="muted">(optional)</span>
           <input name="lane" placeholder="backend">
           <span class="hint">A label for what they do (e.g. <code>backend</code>, <code>marketing</code>). Powers "who's active" and targeted hand-offs.</span>
         </label>
         <label class="inline"><input type="checkbox" name="is_admin" value="1"> Project admin (lead)</label>
         <span class="hint">Leave off for normal agents. <b>On</b> = a lead agent: it can onboard teammates itself from inside the project (gets <code>list_participants</code> + <code>admin_provision</code>). Use one lead per project.</span>
         <button type="submit">Grant + mint token</button>
       </form>`
    : `<p class="muted">No participants yet. <a href="/admin/participants/new">Create one first.</a></p>`;

  const body = `
    <h1>Grant access</h1>
    <p class="lead">Project <strong>${esc(project.name)}</strong></p>
    <div class="help">
      Granting lets a participant into this project and <b>mints their access token</b> — the secret the
      agent uses to connect. You'll see the token <b>once</b> on the next screen, so have somewhere to paste it.
    </div>
    ${formOrEmpty}
    <a class="back" href="/admin/projects/${esc(project.id)}">← Cancel</a>`;
  return layout("Grant access", body, owner);
}

/**
 * The hand-out card shown ONCE after a successful grant. It contains the plaintext token, a
 * copy-paste `.mcp.json`, an export line, and a store-now warning. The token is never
 * retrievable again. `mcpUrl` is loadConfig().PUBLIC_URL + "/mcp".
 */
export function handoutCard(
  owner: Owner,
  project: { id: number; name: string },
  participantName: string,
  plaintextToken: string,
  mcpUrl: string,
  isAdmin: boolean,
): string {
  // The whole onboarding, self-contained: token + .mcp.json + connect steps + the coordination
  // protocol (and, for a lead, the admin powers). Nothing for the operator to look up elsewhere.
  const prompt = buildHandoutPrompt(project.name, participantName, plaintextToken, mcpUrl, isAdmin);

  const body = `
    <h1>Access granted${isAdmin ? " — admin (lead)" : ""}</h1>
    <p class="lead"><strong>${esc(participantName)}</strong> &rarr; <strong>${esc(project.name)}</strong></p>

    <div class="card warn">
      <strong>⚠ The token below is shown once and can't be recovered.</strong>
      It's embedded in the block — store that somewhere safe. Lost it? Revoke and grant again for a new one.
    </div>

    <div class="help">
      <b>Copy everything below and give it to ${esc(participantName)}'s agent</b> — paste it into a session,
      drop it in their repo, or send it over. It leads with the one <code>claude mcp add</code> command (token
      included), then verify/restart/whoami${isAdmin ? ", the admin (lead) powers (how to invite/provision teammates)," : ""} and the coordination
      protocol. No setup on your end, nothing to look up.
    </div>

    <div class="card">
      <h2>📋 Onboarding — copy &amp; send</h2>
      ${codeblock("copytext", prompt)}
    </div>

    <a class="back" href="/admin/projects/${esc(project.id)}">← Back to project</a>`;
  return layout("Access granted", body, owner);
}

export function editProjectPage(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  csrf: string,
  error?: string,
): string {
  const err = error ? `<div class="card warn">${esc(error)}</div>` : "";
  const body = `
    <h1>Edit project</h1>
    <p class="lead">${esc(project.name)} · <code>${esc(project.slug)}</code></p>
    ${err}
    <div class="help">Rename is cosmetic + safe — agents connect with their token, not the slug, so changing the slug won't break anyone.</div>
    <form class="stack" method="POST" action="/admin/projects/${esc(project.id)}/rename">
      ${csrfField(csrf)}
      <label>Name<input name="name" required value="${esc(project.name)}"></label>
      <label>Slug
        <input name="slug" required pattern="[a-z0-9\\-]+" value="${esc(project.slug)}">
        <span class="hint">Lowercase letters, numbers, dashes.</span>
      </label>
      <button type="submit">Save changes</button>
    </form>

    <h2>Danger zone</h2>
    <div class="card warn">
      <strong>⚠ Delete this project.</strong> Permanently removes the project and <b>all</b> of its
      coordination data — ID counters, presence, messages, leases, tasks and the full event history —
      plus every participant's access to it. This cannot be undone.
    </div>
    <form method="POST" action="/admin/projects/${esc(project.id)}/delete">
      ${csrfField(csrf)}
      <button type="submit" class="danger">Delete project permanently</button>
    </form>
    <a class="back" href="/admin/projects/${esc(project.id)}">← Cancel</a>`;
  return layout("Edit project", body, owner);
}

export function editParticipantPage(
  owner: Owner,
  participant: { id: number; name: string; kind: "agent" | "human" },
  grants: ParticipantGrantRow[],
  csrf: string,
  error?: string,
): string {
  const err = error ? `<div class="card warn">${esc(error)}</div>` : "";
  const grantList = grants.length
    ? `<ul>${grants
        .map(
          (g) =>
            `<li><a href="/admin/projects/${esc(g.projectId)}">${esc(g.projectName)}</a>` +
            `${g.lane ? ` · <span class="muted">${esc(g.lane)}</span>` : ""} · ` +
            `${g.tokenActive ? '<span class="pill ok">token active</span>' : '<span class="pill off">revoked</span>'}</li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">Not in any project yet.</p>`;
  const scope = grants.length === 1 ? "1 project" : `${esc(grants.length)} projects`;
  const body = `
    <h1>Edit participant</h1>
    <p class="lead">${esc(participant.name)} · <span class="pill">${esc(participant.kind)}</span></p>
    ${err}
    <form class="stack" method="POST" action="/admin/participants/${esc(participant.id)}/rename">
      ${csrfField(csrf)}
      <label>Name
        <input name="name" required value="${esc(participant.name)}">
        <span class="hint">Applies going forward; past ledger entries keep the name they were logged under.</span>
      </label>
      <button type="submit">Save name</button>
    </form>

    <h2>In projects</h2>
    ${grantList}

    <h2>Danger zone</h2>
    <div class="card warn">
      <strong>⚠ Delete this participant.</strong> Removes them from ${scope} and invalidates their
      token(s) immediately. Their past entries in the ledger are kept (under the name they used).
      This cannot be undone.
    </div>
    <form method="POST" action="/admin/participants/${esc(participant.id)}/delete">
      ${csrfField(csrf)}
      <button type="submit" class="danger">Delete participant permanently</button>
    </form>
    <a class="back" href="/admin">← Cancel</a>`;
  return layout("Edit participant", body, owner);
}
