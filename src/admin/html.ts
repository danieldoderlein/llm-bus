import type http from "node:http";
import type { Owner } from "./owner.js";
import type {
  ProjectRow,
  MemberProjectRow,
  ParticipantRow,
  ParticipationRow,
  ProjectMemberRow,
  ParticipantGrantRow,
  ProjectActivity,
  ProjectBoard,
  DecisionClaim,
  TaskCard,
  OwnerBoardTask,
  AssignTarget,
} from "./queries.js";
import {
  buildHandoutPrompt,
  buildConnectCommand,
  buildClientJson,
  coordinationGuide,
  type InviteRow,
} from "../invite.js";
import { BONUS_LADDER } from "../billing/credits.js";
import { gaHead, cookieBanner } from "../analytics.js";
import { TOKENS } from "../brand.js";

/** A recent credit-ledger entry for the dashboard billing slot. */
export interface LedgerRow {
  type: string;
  amount: number;
  balance_after: number;
  created_at: string;
}

// This module is the single rendering layer for the web admin. There is exactly ONE way to
// emit a dynamic value into HTML - esc() - and every page builder routes every interpolated
// string through it. No template ever concatenates an un-esc()'d value. That is the whole XSS
// story: every dynamic value is esc()'d. Client JS is a handful of STATIC inline handlers, none
// of which interpolate a dynamic value into script: the copy-to-clipboard button (reads a block's
// text from the DOM), the task-board filter select (this.form.submit()), and the new-task select
// navigator (fills ONLY a numeric project id from its own <option value> into a fixed
// /admin/projects/<id>/tasks/new URL template). The only external asset is the Google Fonts
// stylesheet (Sora + Inter + JetBrains Mono, degrades to system fonts if blocked).

/** HTML-escape: the single XSS chokepoint. EVERY interpolated value must pass through this. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True only for an http/https absolute URL. The scheme guard before an attacker-influenceable value
 *  (a review's artifact_url, written via the MCP `review` tool) becomes an href - a `javascript:`/`data:`/
 *  `mailto:` value never passes, so it renders as escaped plain text instead of an active link (invariant 4,
 *  decision 033). esc() alone does not stop a `javascript:` href; this does. */
export function isHttpUrl(s: unknown): boolean {
  if (typeof s !== "string") return false;
  try {
    const proto = new URL(s).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/** True for an http(s) URL whose PATH ends in a known raster image extension (decision 051). Used to render a
 *  pasted image link as an inline thumbnail ("attach a link, not a blob" - we preview, never host). The scheme
 *  is still gated by isHttpUrl (no javascript:/data:), and the extension is read from the URL path only (query
 *  string ignored). SVG is deliberately excluded (an <img>-embedded SVG can still reference external content);
 *  screenshots are raster anyway. */
export function isImageUrl(s: unknown): boolean {
  if (!isHttpUrl(s)) return false;
  try {
    const path = new URL(s as string).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|avif)$/.test(path);
  } catch {
    return false;
  }
}

// Light palette + type scale (Sora display + Inter body/UI + JetBrains Mono).
// The LLM Bus design system (brand/system.css), inlined for the server-rendered admin. Black & white,
// Scandinavian; one 4px spacing scale; the existing class vocabulary is mapped onto the system so all
// pages restyle from here. Keep page code composing these classes - do not invent ad-hoc px/colours.
const STYLE = `
  * { box-sizing: border-box; }
  /* NO -webkit-font-smoothing here. It was set to 'antialiased', which on macOS turns OFF subpixel
     rendering and makes every glyph render THINNER - the usual reason a near-black body reads as washed
     out. Reported as "the text colour is hard to read", but the colour was #1b1e22 at 16.5:1 on white and
     was never the problem; the smoothing was. Removing it restores the default (subpixel) weight on the
     surface people read longest. Do not re-add it to make text look "cleaner" - it costs stroke weight. */
  body { font-family: var(--font-sans); font-size: 15px; line-height: 1.6; margin: 0;
         background: var(--gray-50); color: var(--ink-900); }
  a { color: var(--ink-900); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
  a:hover { color: var(--gray-600); }
  header.site { padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--white);
                display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 5; }
  header.site .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; font-size: 16px;
                       color: var(--ink-900); letter-spacing: -0.01em; text-decoration: none; }
  header.site .brand svg { width: 22px; height: 22px; }
  header.site .nav { color: var(--ink-900); font-size: 13px; }
  header.site .acct { display: flex; gap: 2px; flex-wrap: wrap; }
  header.site .acct a { color: var(--gray-600); font-size: 13.5px; text-decoration: none; padding: 5px 10px;
                        border-radius: 7px; }
  header.site .acct a:hover { background: var(--gray-100); color: var(--ink-900); }
  header.site .acct a[aria-current="page"] { color: var(--ink-900); background: var(--gray-100); font-weight: 600; }
  header.site .who { color: var(--gray-500); font-size: 13px; margin-left: auto; }
  nav.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 14px 0 10px; border-bottom: 1px solid var(--line); }
  nav.tabs a { padding: 9px 13px 11px; font-size: 14px; color: var(--gray-600); text-decoration: none;
               border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav.tabs a:hover { color: var(--ink-900); }
  nav.tabs a[aria-current="page"] { color: var(--ink-900); border-bottom-color: var(--teal); font-weight: 600; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 96px; }
  h1, h2, h3, h4 { font-family: var(--font-display); }
  h1 { font-size: 30px; font-weight: 650; margin: 4px 0 8px; letter-spacing: -0.02em; line-height: 1.15; }
  h2 { font-size: 20px; font-weight: 650; margin: 40px 0 14px; letter-spacing: -0.01em; }
  .lead { color: var(--gray-600); font-size: 17px; margin: 0 0 20px; max-width: 64ch; }
  .muted { color: var(--gray-500); }
  /* The owning-human prefix on a qualified agent name (decision 052): "human/agent" with the human muted. */
  .owner-prefix { color: var(--gray-500); font-weight: 400; }
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
  input, select, textarea { padding: 11px 13px; border-radius: 8px; border: 1px solid var(--line-strong);
                  background: var(--white); color: var(--ink-900); font-size: 15px; font-family: var(--font-sans); }
  textarea { resize: vertical; min-height: 76px; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--teal-600); box-shadow: 0 0 0 3px rgba(12,125,114,.25); }
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
  .card { border: 1px solid var(--line); border-radius: 14px; padding: 20px 24px; margin: 16px 0; background: var(--white); box-shadow: var(--card-lift); }
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
  .lane-edit { display: flex; gap: 4px; align-items: center; }
  .lane-edit input { width: 92px; padding: 2px 6px; font-size: 12px; }
  .error { color: var(--bad); }
  .panel { background: var(--white); border: 1px solid var(--line); border-radius: 16px; padding: 24px; box-shadow: var(--card-lift); }
  /* OAuth consent screen (decision 024): the "unverified" tag + the token-destination notice are the
     honest signal that lets a user catch a spoofed client. */
  .tag { display: inline-flex; align-items: center; font-family: var(--font-mono); font-size: 11px;
         text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 7px; border-radius: 999px;
         background: var(--amber-wash); color: var(--amber); vertical-align: middle; }
  .notice { border: 1px solid var(--line); border-left: 3px solid var(--amber); background: var(--amber-wash);
            border-radius: 10px; padding: 12px 16px; margin: 8px 0 18px; font-size: 14px; color: var(--ink-800); }
  .notice b { color: var(--ink-900); }
  /* Connect card (decision 028): per-client tabs (CSS-only radio switch, no JS) + the flips-green live
     indicator. Colours are TOKENS only (decision 026) - no literal hex; the pulse fades the --live ring
     to transparent so no rgba() is hand-authored. */
  .connect-tabs .tab-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .connect-tabs .tabs { display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--line);
          padding-bottom: 12px; margin: 4px 0 2px; }
  .connect-tabs .tab { font-size: 13px; font-weight: 600; padding: 7px 12px; border-radius: 8px;
         background: var(--gray-100); color: var(--body); cursor: pointer; user-select: none; }
  .connect-tabs .tab:hover { color: var(--ink-900); }
  .connect-tabs .pane { display: none; padding: 16px 2px 2px; }
  #ct-claude:checked ~ .pane[data-tab="claude"],
  #ct-code:checked ~ .pane[data-tab="code"],
  #ct-cursor:checked ~ .pane[data-tab="cursor"],
  #ct-codex:checked ~ .pane[data-tab="codex"],
  #ct-other:checked ~ .pane[data-tab="other"] { display: block; }
  #ct-claude:checked ~ .tabs label[for="ct-claude"],
  #ct-code:checked ~ .tabs label[for="ct-code"],
  #ct-cursor:checked ~ .tabs label[for="ct-cursor"],
  #ct-codex:checked ~ .tabs label[for="ct-codex"],
  #ct-other:checked ~ .tabs label[for="ct-other"] {
    background: var(--paper); color: var(--ink-900); box-shadow: var(--card-lift); border: 1px solid var(--line); }
  .conn { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; font-size: 13px;
          padding: 10px 12px; border-radius: 9px; }
  .conn.wait { background: var(--gray-50); border: 1px solid var(--line); color: var(--muted); }
  .conn.live { background: var(--ok-wash); border: 1px solid var(--live); border-left: 3px solid var(--live); color: var(--ok); }
  .conn.wait .conn-live-text { display: none; }
  .conn.live .conn-wait-text { display: none; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 9px; }
  .dot.wait { background: var(--muted); }
  .dot.live { background: var(--live); box-shadow: 0 0 0 0 var(--live); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--live); } 70% { box-shadow: 0 0 0 7px transparent; }
                     100% { box-shadow: 0 0 0 0 transparent; } }
  .actor { font-family: var(--font-mono); white-space: nowrap; overflow-wrap: anywhere; }
  fieldset.choices { border: 0; margin: 18px 0; padding: 0; display: flex; flex-direction: column; gap: 18px; }
  .choices .grp { display: flex; flex-direction: column; gap: 8px; }
  .choices .grp-h { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase;
                    letter-spacing: 0.08em; color: var(--gray-500); }
  label.opt { flex-direction: row; align-items: baseline; gap: 10px; font-weight: 400; color: var(--ink-800);
              padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  label.opt:hover { border-color: var(--line-strong); background: var(--gray-100); }
  label.opt b { font-weight: 600; }
  .choices .txt { margin-top: 6px; max-width: 320px; }
  .metrics { list-style: none; display: flex; flex-wrap: wrap; gap: 24px; padding: 18px 20px; margin: 12px 0 4px;
             border: 1px solid var(--line); border-radius: 12px; background: var(--white); }
  .metrics li { font-size: 13px; color: var(--gray-500); }
  .metrics b { display: block; font-family: var(--font-mono); font-size: 22px; color: var(--ink-900); font-weight: 600; }
  /* Activity panel: three compact at-a-glance cards + a recent-events table. */
  .actrow { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0 4px; }
  .actcard { flex: 1; min-width: 190px; background: var(--white); border: 1px solid var(--line);
             border-radius: 12px; padding: 12px 16px; }
  .actcard h3 { margin: 0 0 8px; font-size: 12px; font-family: var(--font-mono); text-transform: uppercase;
                letter-spacing: 0.08em; color: var(--gray-500); font-weight: 600; }
  .actcard p { margin: 0; font-size: 14px; display: flex; flex-wrap: wrap; gap: 5px; }
  .actlist { margin: 0; padding-left: 16px; font-size: 14px; }
  .actlist li { margin: 3px 0; }
  /* Task board (decision 041, restyled 045): a scannable, status-grouped LIST - not five crammed columns.
     Each task is ONE line (title + at-a-glance meta + a badge or two) that opens a detail page where it is
     worked. The WHOLE row is the tap target (stretched link over the title) so a thumb never has to land on
     one ellipsized line; on a phone the row STACKS (see the media block) so the title is never crushed by
     the side badges. Values snap to the 4px token scale. */
  .taskbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin: 0 0 var(--s4); }
  .taskbar .filterwrap { margin-right: auto; }
  .taskbar .newpick { font-weight: 400; color: var(--gray-600); }
  .taskbar label.inline select { min-width: 170px; }
  .tasksec { margin: var(--s6) 0 0; }
  .tasksec > h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font-size: 12px;
                  font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.07em;
                  color: var(--gray-500); font-weight: 600; }
  .tasksec > h3 .n { color: var(--ink-900); }
  .tasklist { border: 1px solid var(--line); border-radius: 12px; background: var(--white); overflow: hidden; }
  /* The load-more / show-fewer control under a capped terminal group (decision 050 / task 447). */
  .loadmore { padding: 10px 4px 0; }
  .loadmore a { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.03em; color: var(--gray-600);
                text-decoration: none; }
  .loadmore a:hover { color: var(--ink-900); text-decoration: underline; }
  .taskrow { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 14px 16px;
             border-top: 1px solid var(--line); }
  .taskrow:first-child { border-top: 0; }
  .taskrow:hover { background: var(--gray-50); }
  /* Per-state row shading (decision 055 / task 540): a faint wash + a left-edge accent (inset box-shadow, so the
     edge survives hover) so a task's state reads at a glance and the eye keeps its place when a group empties and
     the next list slides up. These follow the hover rule in source order, so the wash intentionally persists on
     hover; the title-underline below stays the interaction cue. Mirrors the .statuspill.s-* families. */
  .taskrow.s-todo { background: var(--state-todo-wash); box-shadow: inset 3px 0 0 var(--state-todo-edge); }
  .taskrow.s-in_progress { background: var(--state-progress-wash); box-shadow: inset 3px 0 0 var(--state-progress-edge); }
  .taskrow.s-blocked { background: var(--state-blocked-wash); box-shadow: inset 3px 0 0 var(--state-blocked-edge); }
  .taskrow.s-done { background: var(--state-done-wash); box-shadow: inset 3px 0 0 var(--state-done-edge); }
  .taskrow.s-cancelled { background: var(--state-cancelled-wash); box-shadow: inset 3px 0 0 var(--state-cancelled-edge); }
  /* An empty status column stays VISIBLE as one placeholder row (task 541) - the board is a fixed structure, not
     a list that vanishes on filter/empty. No state wash, no stretched link. */
  .taskrow.empty { color: var(--muted); font-style: italic; cursor: default; }
  .taskrow.empty .emptymsg { font-size: 13px; }
  .taskrow .t-title { font-weight: 600; color: var(--ink-900); text-decoration: none; white-space: nowrap;
                      overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  /* Stretched link: the title's ::after overlay makes the whole row navigate, matching the hover cue. A
     link inside the glance line sits above the overlay (z-index) so it stays independently clickable. */
  .taskrow .t-title::after { content: ""; position: absolute; inset: 0; }
  .taskrow:hover .t-title { text-decoration: underline; }
  /* Harmonized glance line (decision 046): ONE aligned, same-font strip of at-a-glance facts under the
     title - task id, who asked (from), type, lane - used IDENTICALLY in the list row and the detail page,
     so a person learns one shape and everything is in one place (no split below-title-and-on-the-right).
     All one font + size, baseline-aligned; a middot separates items. */
  .glance { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; font-size: 13px;
            color: var(--gray-500); }
  .glance .g { display: inline-flex; align-items: baseline; gap: 4px; }
  .glance .g + .g::before { content: "\\00B7"; color: var(--line-strong); }
  .glance .k { color: var(--gray-500); }
  /* Colon-label the glance keys (decision 050 / task 448): "from: X - lane: Y - for: Z" reads like a mail
     header. One scoped rule covers every .k label in BOTH the list row and the detail glance ("everywhere"). */
  .glance .k::after { content: ":"; }
  .glance .v { color: var(--gray-600); font-weight: 500; }
  .glance a.v { position: relative; z-index: 1; text-decoration: none; }
  .glance a.v:hover { color: var(--ink-900); text-decoration: underline; }
  .badge { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px;
           padding: 1px 8px; border-radius: 999px; background: var(--gray-100); color: var(--gray-600);
           border: 1px solid var(--line); white-space: nowrap; }
  .badge.decide { background: var(--amber-wash); color: var(--amber); border-color: transparent; }
  .badge.block { background: var(--bad-wash); color: var(--bad); border-color: transparent; }
  /* Task detail (decision 047): a WHITE card so the task reads OFF the grey page like the list rows, with
     internal dividers separating the header (title + the SAME glance line as the list) from the body from
     "work this task". The status pill sits on the TITLE line (a single task is not status-grouped), so the
     glance line starts at #id and lines up with the list row (list/detail parity). */
  .taskcard { background: var(--white); border: 1px solid var(--line); border-radius: 16px;
              box-shadow: var(--card-lift); padding: 24px 28px; margin: 6px 0 0; }
  .taskhead { display: flex; flex-direction: column; gap: 8px; padding-bottom: var(--s4); margin: 0 0 var(--s4);
              border-bottom: 1px solid var(--line); }
  .th-top { display: flex; align-items: flex-start; gap: 12px; }
  .th-top h1 { margin: 0; flex: 1 1 auto; }
  .th-top .statuspill { flex: 0 0 auto; margin-top: 5px; }
  .statuspill { font-family: var(--font-mono); font-size: 12px; padding: 2px 10px; border-radius: 999px;
                background: var(--gray-100); color: var(--ink-800); border: 1px solid var(--line); white-space: nowrap; }
  .statuspill.s-in_progress { background: var(--ok-wash); color: var(--ok); border-color: transparent; }
  .statuspill.s-blocked { background: var(--bad-wash); color: var(--bad); border-color: transparent; }
  .blockedbox { border: 1px solid var(--state-blocked-edge); background: var(--state-blocked-wash); border-radius: 10px; padding: .7rem .85rem; margin: .6rem 0; }
  .blockedbox .bb-h { font-weight: 650; margin-bottom: .35rem; }
  .blockedbox .bb-item + .bb-item { margin-top: .6rem; border-top: 1px solid var(--state-blocked-edge); padding-top: .6rem; }
  .blockedbox .bb-on { font-size: .93rem; }
  .blockedbox .bb-manual { font-weight: 600; }
  /* No opacity here either - it was .92, which fades prose the reader has to act on (same complaint as
     .detailbody). If this ever needs to recede, use a lighter TOKEN, never a veil over the text. */
  .blockedbox .bb-why { white-space: pre-wrap; margin-top: .3rem; font-size: .93rem; }
  /* Decision 074: the exit condition and the owner of the unblock. bb-gap is the ABSENCE of either on a
     pre-074 row - italic and muted so it reads as a hole in the record, never as content. */
  .blockedbox .bb-lift, .blockedbox .bb-who { margin-top: .3rem; font-size: .93rem; white-space: pre-wrap; }
  .blockedbox .bb-gap { font-style: italic; color: var(--gray-600); }
  /* Done recedes (muted), not shouts: reserve high-contrast fills for states that want attention. */
  .statuspill.s-done { background: var(--gray-100); color: var(--gray-600); border-color: var(--line); }
  .statuspill.s-cancelled { background: var(--gray-100); color: var(--gray-500); }
  /* The detail card carries the same state edge for list/detail parity (decision 055 / task 540): keep the
     card lift and add the status edge as a second inset shadow. */
  .taskcard.s-todo { box-shadow: var(--card-lift), inset 4px 0 0 var(--state-todo-edge); }
  .taskcard.s-in_progress { box-shadow: var(--card-lift), inset 4px 0 0 var(--state-progress-edge); }
  .taskcard.s-blocked { box-shadow: var(--card-lift), inset 4px 0 0 var(--state-blocked-edge); }
  .taskcard.s-done { box-shadow: var(--card-lift), inset 4px 0 0 var(--state-done-edge); }
  .taskcard.s-cancelled { box-shadow: var(--card-lift), inset 4px 0 0 var(--state-cancelled-edge); }
  .metaline { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 8px 0 0; font-size: 13px; color: var(--gray-600); }
  .metaline b { color: var(--ink-900); font-weight: 600; }
  /* The task body is the longest-read prose in the product, so it takes the DARKEST canonical ink rather
     than the --ink-800 legacy alias it used to carry (operator request, task #1002). */
  .detailbody { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); margin: 0; font-size: 15px; }
  .detail-empty { margin: 0; }
  .linklist { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .linklist li { display: flex; align-items: baseline; gap: 8px; overflow-wrap: anywhere; }
  .linklist li::before { content: "\\2197"; color: var(--gray-500); font-size: 12px; flex: 0 0 auto; }
  /* An image link renders as an inline thumbnail (decision 051): drop the arrow, stack image + caption. The
     caption stays a working link if the <img> removes itself (onerror). */
  .linklist li.linkimg { display: block; }
  .linklist li.linkimg::before { content: none; }
  .linkimg a { display: inline-block; text-decoration: none; max-width: 100%; }
  .linkimg img { display: block; max-width: min(100%, 360px); max-height: 200px; width: auto; height: auto;
                 border: 1px solid var(--line); border-radius: 8px; background: var(--gray-50); }
  .linkimg .cap { display: inline-block; margin-top: 4px; font-size: 13px; color: var(--gray-600); }
  .linkimg a:hover .cap { color: var(--ink-900); text-decoration: underline; }
  /* Work this task (decisions 046/047): ~95% of these are DECISIONS an agent asked, so the HAPPY PATH - make
     the decision - is dominant (big option chips + a written-reply escape). Everything else ("other ways to
     handle it") is quiet, clearly separated, each alternative stating what it does with its control DIRECTLY
     under the text. Every path moves the task to someone: answering SENDS the reply back to the asker and
     closes it (not a silent dismiss). */
  .worksec { margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line); }
  .worksec h3 { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
                color: var(--gray-500); font-weight: 600; margin: 0 0 var(--s4); }
  .answer-block { max-width: 620px; }
  .ab-h { font-size: 15px; font-weight: 600; color: var(--ink-900); margin: 0 0 4px; }
  .ab-sub { font-size: 13px; color: var(--gray-600); margin: 0 0 12px; }
  .ab-sub b { color: var(--ink-900); font-weight: 600; }
  .answer-block .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 8px; }
  .answer-block .chips .btn { font-size: 15px; padding: 12px 20px; }
  .escape-top { margin: 0 0 10px; }
  .escape-top .btn { text-align: left; }
  .answer-note textarea { width: 100%; }
  .answer-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 0; }
  button:disabled, .btn:disabled { opacity: .5; cursor: not-allowed; }
  /* Other ways to handle it: quiet, clearly separated; each alternative is a labelled action with a one-line
     "what this does", and its control sits DIRECTLY under that text (not drifting to the right). */
  .otherways { margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line); }
  .ow-h { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
          color: var(--gray-500); font-weight: 600; margin: 0 0 var(--s3); }
  .ow-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin: 0 0 18px; }
  .ow-row:last-child { margin-bottom: 0; }
  .ow-desc { font-size: 13px; color: var(--gray-600); }
  .ow-desc b { display: block; color: var(--ink-900); font-weight: 600; }
  .ow-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .ow-ctl select { min-width: 180px; }
  .answered { margin: 0 0 var(--s3); font-size: 14px; }
  /* Breadcrumb trail (top-of-page "up one level"); complements the bottom .back link. */
  nav.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px;
               margin: 0 0 6px; color: var(--gray-500); }
  nav.crumbs a { color: var(--gray-500); text-decoration: none; }
  nav.crumbs a:hover { color: var(--ink-900); text-decoration: underline; }
  nav.crumbs .sep { color: var(--gray-300); }
  nav.crumbs .here { color: var(--ink-800); font-weight: 600; }
  /* Toast (decision 048): a uniform status notice centered at the TOP (mobile-first), slid in from the top.
     Info/success AUTO-DISMISSES via a CSS animation (no JS); an error is STICKY with an X (inline onclick). */
  .toast-wrap { position: fixed; top: 0; left: 0; right: 0; z-index: 60; display: flex; justify-content: center;
                padding: 12px; pointer-events: none; }
  .toast { pointer-events: auto; max-width: min(92vw, 480px); background: var(--ink-900); color: var(--white);
           padding: 12px 16px; border-radius: 10px; box-shadow: var(--card-lift); font-size: 14px; font-weight: 500;
           display: flex; align-items: center; gap: 12px; animation: toastinout 3.4s ease forwards; }
  .toast.error { background: var(--bad); animation: toastin .26s ease forwards; }
  .toast-x { background: transparent; border: 0; color: var(--white); font-size: 20px; line-height: 1;
             cursor: pointer; padding: 0 2px; opacity: .85; }
  .toast-x:hover { opacity: 1; }
  .toast-link { color: var(--white); font-weight: 600; text-decoration: underline; text-underline-offset: 2px;
                white-space: nowrap; }
  /* Hovering OR focusing a link inside pauses the auto-dismiss (decision 049) so a toast link stays
     reachable for both pointer and keyboard users. */
  .toast:hover, .toast:focus-within { animation-play-state: paused; }
  @keyframes toastin { from { transform: translateY(-16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes toastinout {
    0% { transform: translateY(-16px); opacity: 0; }
    9% { transform: translateY(0); opacity: 1; }
    82% { transform: translateY(0); opacity: 1; }
    100% { transform: translateY(-16px); opacity: 0; visibility: hidden; }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes toastin { from { opacity: 0; } to { opacity: 1; } }
    @keyframes toastinout { 0% { opacity: 0; } 9% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
  }
  /* Small screens: let wide tables scroll inside themselves instead of forcing the page sideways. */
  @media (max-width: 720px) {
    main { padding: 24px 14px 72px; }
    h1 { font-size: 25px; }
    h2 { margin-top: 28px; }
    table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; max-width: 100%; }
    form.stack { max-width: 100%; }
    /* Header on mobile: row 1 = brand (left) + email (right); the operator link and the account nav each
       get their own full-width row (the nav scrolls horizontally), so nothing clips or crams. Not sticky
       on mobile (a wrapped header would eat the screen). */
    header.site { flex-wrap: wrap; gap: 6px 10px; padding: 10px 14px; position: static; }
    header.site .brand { margin-right: auto; }
    header.site .who { order: 1; margin-left: auto; font-size: 12px; max-width: 62%; overflow-wrap: anywhere; }
    header.site .nav { order: 2; font-size: 12.5px; }
    header.site .acct { order: 3; width: 100%; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
    header.site .acct a { flex: 0 0 auto; }
    nav.tabs { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; }
    nav.tabs a { flex: 0 0 auto; }
    .panel { padding: 18px 16px; }
    .card { padding: 16px 18px; }
    .taskcard { padding: 18px 16px; }
    /* Task board on a phone (most bus-task driving happens here): the row is already a stacked column
       (title, then the glance line) and stays a 44px+ tap target via the stretched link; the title wraps
       in full instead of ellipsizing. */
    .taskrow .t-title { white-space: normal; }
    .taskintro { display: none; }
    .taskbar { flex-direction: column; align-items: stretch; }
    .taskbar .newpick, .taskbar form { width: 100%; }
    .taskbar label.inline { flex-direction: column; align-items: stretch; }
    .taskbar label.inline select { width: 100%; }
    /* Work this task on a phone: 44px targets, 16px inputs (stops iOS zoom), one action per row full-width;
       each "other ways" control sits full-width directly under its text. */
    .worksec .btn, .worksec button, .worksec select, .worksec input, .worksec textarea { min-height: 44px; }
    .worksec .btn, .worksec button { padding: 11px 16px; font-size: 14px; }
    .worksec select, .worksec input, .worksec textarea { font-size: 16px; }
    .answer-block .chips, .answer-actions, .ow-ctl { flex-direction: column; align-items: stretch; }
    .answer-block .chips .btn, .answer-actions .btn, .answer-actions button, .escape-top .btn,
    .ow-ctl select, .ow-ctl .btn, .ow-ctl button { width: 100%; justify-content: center; }
    .escape-top .btn { text-align: center; }
    .ow-row, .ow-ctl { align-self: stretch; align-items: stretch; }
  }
`;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  "family=Inter:wght@400;500;600;700&amp;family=Sora:wght@500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap\">";

/** Page shell. `bodyHtml` is trusted (assembled by builders that esc() their inputs). */
export interface Crumb {
  label: string;
  href?: string;
}

/** Social/discovery meta for shareable public pages (e.g. /p request links). Absent = the default
 *  noindex, no-unfurl admin page. */
export interface SocialMeta {
  description: string;
  image?: string;
  index?: boolean;
}

// The account-level nav (decision 023): shown in the header for any signed-in owner, never on public
// pages. `activeNav` highlights the current section. [key, href, label].
const ACCT_NAV: Array<[string, string, string]> = [
  ["projects", "/admin", "Projects"],
  ["tasks", "/admin/tasks", "Tasks"],
  ["participants", "/admin/participants", "Participants"],
  ["billing", "/admin/billing", "Billing"],
  ["settings", "/admin/settings", "Settings"],
];

/** A uniform top-center status notice (decision 048). Info/success auto-dismisses (CSS); an error is sticky
 *  with an X. `msg` is composed server-side (a fixed template, never reflected free text) and esc()'d. */
export interface Toast {
  msg: string;
  level?: "info" | "error";
  /** An optional in-app link rendered inside the toast (decision 049), e.g. "View" the thing just created.
   *  The url is composed server-side (an internal /admin path from digit-only ids), never reflected free
   *  text; esc()'d here regardless. Hovering the toast pauses the auto-dismiss so the link stays reachable. */
  link?: { label: string; url: string };
}
function renderToast(toast?: Toast): string {
  if (!toast || !toast.msg) return "";
  const err = toast.level === "error";
  const x = err
    ? `<button type="button" class="toast-x" aria-label="Dismiss" onclick="this.closest('.toast').remove()">&times;</button>`
    : "";
  // Defense-in-depth (decision 049): a toast link is only ever an internal same-origin path (composed
  // server-side from validated numeric ids). Render it ONLY when the url is such a path ("/..." but not
  // "//..." or a scheme), so a stray future caller can never inject a javascript:/absolute href; esc()'d too.
  const lu = toast.link?.url ?? "";
  const link =
    toast.link && toast.link.label && lu.startsWith("/") && !lu.startsWith("//")
      ? `<a class="toast-link" href="${esc(lu)}">${esc(toast.link.label)}</a>`
      : "";
  return `<div class="toast-wrap"><div class="toast${err ? " error" : ""}" role="status" aria-live="${err ? "assertive" : "polite"}"><span>${esc(toast.msg)}</span>${link}${x}</div></div>`;
}

export function layout(
  title: string,
  bodyHtml: string,
  owner?: Owner,
  crumbs?: Crumb[],
  social?: SocialMeta,
  activeNav?: string,
  toast?: Toast,
): string {
  const acctNav = owner
    ? `<nav class="acct" aria-label="Account">${ACCT_NAV.map(
        ([key, href, label]) =>
          `<a href="${href}"${activeNav === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`,
      ).join("")}</nav>`
    : "";
  const who = owner
    ? `<span class="who">${esc(owner.email)}${owner.isOperator ? " · operator" : ""}</span>`
    : "";
  // Top-of-page "up one level" trail (the header brand link overshoots to the dashboard). The last
  // crumb is the current page (no link). Omitted on entry/public pages that pass no crumbs.
  const crumbHtml =
    crumbs && crumbs.length
      ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs
          .map((c, i) => {
            const sep = i > 0 ? `<span class="sep">/</span>` : "";
            return sep + (c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<span class="here">${esc(c.label)}</span>`);
          })
          .join("")}</nav>`
      : "";
  // Operators get a link into the cross-tenant console; non-operators never see it (no oracle).
  const opLink = owner?.isOperator ? `<a class="nav" href="/operator">Operator console</a>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${social?.index ? "index" : "noindex"}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${esc(title)} · LLM Bus</title>
${
  social
    ? `<meta property="og:type" content="website">
<meta property="og:site_name" content="LLM Bus">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(social.description)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(social.description)}">${
        social.image
          ? `\n<meta property="og:image" content="${esc(social.image)}">\n<meta name="twitter:image" content="${esc(social.image)}">`
          : ""
      }`
    : ""
}
${FONTS}
${gaHead()}
<style>${TOKENS}${STYLE}</style>
</head>
<body>
${renderToast(toast)}<header class="site"><a class="brand" href="/admin"><svg viewBox="0 0 240 240" fill="none" stroke="#14b8a6" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5" stroke="#14b8a6"/><circle cx="120" cy="120" r="30" fill="#14b8a6" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="#14b8a6" stroke="none"/></svg>LLM&nbsp;Bus</a>${acctNav}${opLink}${who}</header>
<main>${crumbHtml}${bodyHtml}</main>
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
<script>
// Connect-card live indicator (decision 028): if a "waiting" banner is present, poll the owner-scoped
// status endpoint and flip it green on the FIRST check-in. Fully static (no interpolated values); a
// no-op on every other page. Positive edge only - never asserts "disconnected". The actor is already
// esc()'d in the DOM; only the seen time is set (via textContent, XSS-safe) from the JSON.
(function () {
  var el = document.querySelector('.conn[data-participation]');
  if (!el || !window.fetch || el.classList.contains('live')) return;
  var pid = el.getAttribute('data-participation');
  var base = el.getAttribute('data-status-url');
  if (!pid || !base) return;
  var timer = setInterval(function () {
    fetch(base + '?participation=' + encodeURIComponent(pid), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.seen) return;
        clearInterval(timer);
        el.classList.remove('wait'); el.classList.add('live');
        var dot = el.querySelector('.dot');
        if (dot) { dot.classList.remove('wait'); dot.classList.add('live'); }
        var s = el.querySelector('.conn-seen');
        if (s && typeof j.seen_at === 'string') { s.textContent = 'seen ' + j.seen_at.slice(11, 16) + ' UTC'; }
      })
      .catch(function () {});
  }, 2500);
})();
</script>
${cookieBanner()}
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

// ── Connect card (decision 028) ─────────────────────────────────────────────
// ONE shared, tabbed connect surface backs acceptedPage, wizardConnectCard, and requestClaimedPage.
// Per-client tabs switch with a CSS-only hidden-radio pattern (input:checked ~ .pane) - zero JS, so the
// full surface works with scripting disabled. The token appears ONLY inside codeblock()s (invariant 7);
// the one-click deep link and the status banner never carry it. Every dynamic value passes esc().

/** The presence-driven live signal for the connect banner. `seenAt` is null until the just-provisioned
 *  participation first checks in; the poll in layout() flips it green (positive edge only - never asserts
 *  "disconnected" from staleness, invariant 5). `actor` is the qualified bus identity, shown once seen. */
export interface ConnectLive {
  participationId: number;
  seenAt: string | null;
  actor: string;
}

export interface ConnectCardOpts {
  token: string;
  mcpUrl: string;
  /** The static "Add to Claude" deep link (built by claudeConnectUrl from PUBLIC_URL). */
  oneClickUrl: string;
  live: ConnectLive;
}

/** The one-click "Add to Claude" deep link (decision 024/028). Static external anchor; PUBLIC_URL + /mcp
 *  is the connector URL. Built here so call sites (and tests) share one shape. */
export function claudeConnectUrl(publicUrl: string): string {
  const mcp = `${publicUrl.replace(/\/+$/, "")}/mcp`;
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=LLM+Bus&connectorUrl=${encodeURIComponent(mcp)}`;
}

// The per-client tab set, in order. Claude (one-click) is first-class default; the token/CLI paths for
// Claude Code / Cursor / Codex / Other MCP are equally reachable (not hidden behind Claude - Daniel #7).
const CONNECT_TABS: Array<[string, string]> = [
  ["claude", "Claude"],
  ["code", "Claude Code"],
  ["cursor", "Cursor"],
  ["codex", "Codex"],
  ["other", "Other MCP"],
];

/** The five per-client panes + the tab row, switched purely by CSS (`input:checked ~ .pane`). */
function connectTabs(token: string, mcpUrl: string, oneClickUrl: string): string {
  const cli = buildConnectCommand(token, mcpUrl);
  const json = buildClientJson(token, mcpUrl);
  const radios = CONNECT_TABS.map(
    ([k], i) => `<input type="radio" name="connect-tab" id="ct-${k}" class="tab-radio"${i === 0 ? " checked" : ""}>`,
  ).join("");
  const tabRow = `<div class="tabs" role="tablist">${CONNECT_TABS.map(
    ([k, label]) => `<label class="tab" for="ct-${k}">${esc(label)}</label>`,
  ).join("")}</div>`;
  // Cursor / Codex / Other MCP all take the same .mcp.json; distinct panes + copyblock ids keep each tab
  // first-class and independently copyable.
  const mcpPane = (k: string): string =>
    `<div class="pane" data-tab="${k}">
       <p class="hint">Add LLM Bus to your MCP config:</p>
       ${codeblock(`connect-${k}`, json)}
       <p class="hint">The token is inside the config - keep the file out of git.</p>
     </div>`;
  const panes = [
    `<div class="pane" data-tab="claude">
       <a class="btn" href="${esc(oneClickUrl)}">Add LLM Bus to Claude</a>
       <p class="hint" style="margin-top:.6rem">One click, approve once. No token to copy.</p>
     </div>`,
    `<div class="pane" data-tab="code">
       <p class="hint">Run this in your terminal:</p>
       ${codeblock("connect-code", cli)}
       <p class="hint">Then restart the session and ask Claude to <b>run whoami on LLM Bus</b>.</p>
     </div>`,
    mcpPane("cursor"),
    mcpPane("codex"),
    mcpPane("other"),
  ].join("");
  return `<div class="connect-tabs">${radios}${tabRow}${panes}</div>`;
}

/** A short local time (HH:MM) from an ISO timestamp, for the "seen ..." live label. */
function seenLabel(iso: string): string {
  return `seen ${esc(iso.slice(11, 16))} UTC`;
}

/** The flips-green connection banner. Renders grey/"waiting" when `live.seenAt` is null, green/"connected"
 *  once set. Both variants are always in the DOM (toggled by the `.conn.wait`/`.conn.live` class) so the
 *  poll in layout() only swaps classes + sets the seen time via textContent - the actor is server-esc()'d
 *  in the DOM and never re-injected from the JSON response. */
function connStatusBanner(live: ConnectLive): string {
  const seen = live.seenAt != null;
  const seenTxt = seen ? seenLabel(live.seenAt as string) : "seen just now";
  return `<div class="conn ${seen ? "live" : "wait"}" data-participation="${esc(String(live.participationId))}" data-status-url="/admin/connection-status">
      <span class="dot ${seen ? "live" : "wait"}"></span>
      <span class="conn-wait-text">Waiting for your AI to say hello. This flips green the moment it connects.</span>
      <span class="conn-live-text"><strong>Connected</strong> as <span class="actor">${esc(live.actor)}</span> - <span class="conn-seen">${seenTxt}</span>.</span>
    </div>`;
}

/** ONE shared tabbed connect card: per-client tabs (CSS-only) + the live "flips green" banner. Backs all
 *  three connect surfaces; each page supplies its own title/lead + "token shown once" warning around it. */
export function connectCard(opts: ConnectCardOpts): string {
  return `<div class="card">
      ${connectTabs(opts.token, opts.mcpUrl, opts.oneClickUrl)}
      ${connStatusBanner(opts.live)}
    </div>`;
}

// ── Page builders ──────────────────────────────────────────────────────────

/** The OAuth sign-in page (ADMIN_AUTH_SOURCE=oauth). Static links; the provider `state` carries CSRF.
 *  When `inviteToken` is set the start links carry it so the sign-in accepts the invite on callback. */
export function loginPage(error?: string, inviteToken?: string): string {
  const err = error ? `<p class="error">${esc(error)}</p>` : "";
  const q = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  // F2 (marketing #845): the no-card reassurance must not disappear at the auth card - it rides both paths.
  const noCard = `<p class="muted">Free to start, no card. Your identity comes from your sign-in, not something you type.</p>`;
  const buttons = `
      <p><a class="btn btn-p" href="/admin/auth/google/start${q}">Continue with Google</a></p>
      <p><a class="btn" href="/admin/auth/github/start${q}">Continue with GitHub</a></p>`;

  // Invited users are accepting a specific project - keep that focused (not the "Start free" pitch).
  if (inviteToken) {
    const body = `
    <section class="panel">
      <h1>Sign in</h1>
      <p class="muted">You've been invited to a project. Sign in to accept and connect.</p>
      ${err}${buttons}
      ${noCard}
    </section>`;
    return layout("Sign in", body);
  }

  // First-timer greeting (F1) + path-to-value preview (F3). One page still serves returning users - the
  // sign-in buttons are the same; a returning owner just clicks through to their dashboard.
  const body = `
    <section class="panel">
      <h1>Start free</h1>
      <p class="lead">Connect your agents and watch them coordinate. No card, free to start.</p>
      ${err}${buttons}
      ${noCard}
      <div class="card">
        <strong>What happens next</strong>
        <ol>
          <li>Create a project</li>
          <li>Connect your agent - one click for Claude</li>
          <li>Add a second agent, or invite a teammate, and watch them hand off</li>
        </ol>
      </div>
    </section>`;
  return layout("Start free", body);
}

/** Shown after a successful invite acceptance: the shared tabbed connect card + the flips-green live
 *  indicator. The token is shown ONCE (inside the copy blocks). Lands here, never the first-run wizard. */
export function acceptedPage(
  projectName: string,
  participant: string,
  token: string,
  mcpUrl: string,
  isAdmin: boolean,
  participationId: number,
  oneClickUrl: string,
): string {
  const body = `
    <section class="panel">
      <h1>You're in: ${esc(projectName)}</h1>
      <p class="lead">Connect your AI as <span class="actor">${esc(participant)}</span> to start coordinating.
      Pick your client below; it flips green the moment your agent says hello.</p>

      <div class="card warn">
        <strong>Your token is shown once</strong> - it's inside the config/command below, so copy it
        somewhere safe now. Lost it? Ask the project owner to rotate your token for a fresh one.
      </div>

      ${connectCard({ token, mcpUrl, oneClickUrl, live: { participationId, seenAt: null, actor: participant } })}

      <details class="help"><summary style="cursor:pointer;font-weight:600">Coordination protocol (append to CLAUDE.md)</summary>
        ${codeblock("accepted-guide", coordinationGuide(isAdmin))}</details>
    </section>`;
  return layout("Joined", body);
}

/**
 * The OAuth-AS consent screen (decision 024): after SSO, the verified human picks which participation
 * this connector connects as. The generic connector URL cannot carry a project, so we pick it here.
 * Options: accept a pending invite targeted at their email (the main win - no pasted token), reconnect
 * as an existing membership, or create a personal project. Posts back to /admin/authorize/consent
 * (same origin as the session cookie); the client's authorize params are read from the trusted session,
 * never from this form. Plain + correct now; look/copy aligns with the enrollment redesign later.
 */
export function consentPage(
  clientName: string | null,
  redirectHost: string,
  csrf: string,
  memberships: Array<{ participationId: number; projectName: string; participantName: string }>,
  invites: Array<{ inviteId: number; projectName: string; intendedName: string | null }>,
  error?: string | null,
): string {
  const client = clientName && clientName.trim() ? clientName.trim() : "An application";
  // Preselect only when the intent is unambiguous: a pending invite (the reason they're usually here),
  // or - for a first-time user with no projects yet - the "start fresh" path. When the account ALREADY
  // drives projects, deliberately preselect NOTHING: auto-selecting the first membership (alphabetical)
  // made a stale project the one-click default, so a fast click connected an agent to the wrong place.
  // Reconnecting is a real choice; force an explicit pick.
  const firstChoice = invites.length
    ? `invite:${invites[0].inviteId}`
    : memberships.length
      ? null
      : "new";
  const radio = (value: string, checked: boolean, label: string): string =>
    `<label class="opt"><input type="radio" name="choice" value="${esc(value)}"${checked ? " checked" : ""}> ${label}</label>`;

  const inviteOpts = invites
    .map((i) =>
      radio(
        `invite:${i.inviteId}`,
        firstChoice === `invite:${i.inviteId}`,
        `Accept invite to <b>${esc(i.projectName)}</b>${i.intendedName ? ` as <b>${esc(i.intendedName)}</b>` : ""}`,
      ),
    )
    .join("");
  const membershipOpts = memberships
    .map((m) =>
      radio(
        `membership:${m.participationId}`,
        firstChoice === `membership:${m.participationId}`,
        `Connect to <b>${esc(m.projectName)}</b> as <b>${esc(m.participantName)}</b>`,
      ),
    )
    .join("");
  const newOpt = radio("new", firstChoice === "new", `Create a new personal project`);

  // Disclose WHERE the access token will be delivered (the client's registered redirect host) and that
  // the app is unverified. Clients self-register (open DCR) and set their own name, so the name alone is
  // spoofable - the destination host is the honest signal that lets a user catch a phishing client
  // (decision 024 security review). esc() throughout (the XSS chokepoint).
  const host = redirectHost && redirectHost.trim() ? redirectHost.trim() : "an external app";
  // When nothing is preselected (the account already drives projects), tell the user to choose so an
  // empty submit does not look like a dead button. An explicit error (bad/empty re-submit) wins.
  const prompt = error
    ? `<p class="notice">${esc(error)}</p>`
    : firstChoice === null
      ? `<p class="muted">Choose which project this agent connects to.</p>`
      : "";
  const body = `
    <section class="panel">
      <h1>Connect to LLM Bus</h1>
      <p class="muted"><b>${esc(client)}</b> <span class="tag">unverified</span> wants to connect to LLM
      Bus as you and will receive an access token to the project you pick below.</p>
      <p class="notice">The token will be sent to <b>${esc(host)}</b>. Only continue if you started this
      from an app you trust - if this host looks wrong, close this page.</p>
      ${prompt}
      <form method="post" action="/admin/authorize/consent">
        ${csrfField(csrf)}
        <fieldset class="choices">
          ${inviteOpts ? `<div class="grp"><span class="grp-h">Pending invites</span>${inviteOpts}</div>` : ""}
          ${membershipOpts ? `<div class="grp"><span class="grp-h">Your projects</span>${membershipOpts}</div>` : ""}
          <div class="grp"><span class="grp-h">Start fresh</span>
            ${newOpt}
            <input type="text" name="project_name" placeholder="Project name" maxlength="64" class="txt">
          </div>
        </fieldset>
        <p><button class="btn" type="submit">Allow &amp; connect</button></p>
      </form>
      <p class="muted">Signing in confirms your identity. Your agents coordinate under the participation you
      pick; the connection can be revoked anytime from your dashboard.</p>
    </section>`;
  return layout("Connect to LLM Bus", body);
}

/**
 * Public notification-settings page (decision 025), reached from an emailed magic link - NOT SSO-gated.
 * Identity is the owner bound to the SESSION by the magic-link exchange (routes.ts verifies the HMAC sig
 * on the sig-bearing GET, then 302s here sig-free), so the secret never lands in a GA page_location. This
 * page only toggles the daily-digest preference. Rendered through layout() so the analytics chokepoint +
 * HEAD-as-GET hold. Every value esc()'d; the POST is CSRF-guarded.
 */
/** Render an ISO instant in a given IANA zone for the settings page. Same Intl path (and same fallback) as
 *  the email formatter, so the "next brief" the page promises reads like the stamps the brief carries. */
function fmtLocalIso(iso: string, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz ?? "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

// The concept primer, shown as an always-collapsed disclosure (decision 023 progressive disclosure): the
// first run teaches via the wizard, so returning owners get it available without a scroll tax.
function conceptExplainer(owner: Owner): string {
  return `<details class="help"><summary style="cursor:pointer;font-weight:600">New here? What LLM Bus does</summary>
      <b>What is this?</b> LLM Bus gives your AI agents a shared, live source of truth so they don't
      step on each other - gap-free ID numbers (ADRs, migrations), who's working on what right now,
      handoff messages, file leases, and a shared task list.
      <ul>
        <li><b>Project</b> = one coordination space (usually one codebase or team). Agents in it share its
            numbering and history. Projects are fully isolated from each other.</li>
        <li><b>Participant</b> = one AI <code>agent</code> you create under your handle, addressed <code>${esc(owner.username)}/&lt;label&gt;</code>.
            One participant = one access token (reused across all of that agent's sub-agents).</li>
        <li><b>To put an agent to work:</b> make a Project + a Participant, then open the project and
            <b>Grant</b> the participant in - that mints the token you paste into the agent.</li>
        <li><b>Working with people?</b> A teammate isn't a participant. Invite them by email into a project;
            they sign in with their own account and their agents connect under their identity.</li>
      </ul></details>`;
}

/** Account home (decision 023): the projects list + first-run nudge + "projects you belong to". */
export function projectsPage(
  owner: Owner,
  projects: ProjectRow[],
  memberProjects: MemberProjectRow[] = [],
  /** Why an invite acceptance did not complete (decision 068). Signing in still succeeded, so the person
   *  lands here either way - without this they land on an empty dashboard with no idea what went wrong. */
  inviteError?: string,
): string {
  const notice = inviteError ? `<div class="card warn">${esc(inviteError)}</div>` : "";
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
    : `<tr><td colspan="4" class="muted">No projects yet - start with <b>+ New project</b>.</td></tr>`;

  // First-run nudge (wizard screen 3): once the starter project exists, point the owner at inviting a
  // teammate/second agent - the one growth action that isn't obvious. Fades out past the first project.
  const firstProjectNudge =
    projects.length === 1
      ? `<div class="card"><strong>Working with a teammate or another agent?</strong> Invite them by email into
         <strong>${esc(projects[0].name)}</strong> - they sign in to accept, and their agent connects under
         their own identity. <a class="btn sm" href="/admin/projects/${esc(projects[0].id)}/access" style="margin-left:.4rem">Invite a teammate &rarr;</a></div>`
      : "";

  // "Projects you belong to": foreign projects this human was invited into (task #7). Read-only - the rows
  // do NOT link into /admin/projects/:id (those are owner-only and 404 for a member; a link would be a soft
  // oracle). The member coordinates in these through their connected agent, not this dashboard.
  const memberRows = memberProjects
    .map(
      (m) => `<tr>
        <td>${esc(m.name)}</td>
        <td><code>${esc(m.participantName)}</code></td>
        <td>${m.isAdmin ? `<span class="pill">admin</span>` : `<span class="pill">member</span>`}</td>
      </tr>`,
    )
    .join("");
  const memberSection = memberProjects.length
    ? `<div class="sectionhead"><h2>Projects you belong to</h2></div>
       <div class="help">Projects you were invited into. You coordinate in these through your connected
         agent, not from here.</div>
       <table>
         <thead><tr><th>Project</th><th>Your agent</th><th>Role</th></tr></thead>
         <tbody>${memberRows}</tbody>
       </table>`
    : "";

  const body = `
    <div class="sectionhead"><h1 style="margin-bottom:0">Projects</h1><a class="btn sm" href="/admin/projects/new">+ New project</a></div>
    <p class="lead">Your coordination spaces.</p>
    ${notice}
    ${firstProjectNudge}
    ${conceptExplainer(owner)}
    <table>
      <thead><tr><th>Name</th><th>Slug</th><th>Agents</th><th>Events</th></tr></thead>
      <tbody>${projectRows}</tbody>
    </table>
    ${memberSection}`;
  return layout("Projects", body, owner, undefined, undefined, "projects");
}

/** The identities this owner owns (decision 023). */
export function participantsPage(owner: Owner, participants: ParticipantRow[]): string {
  const participantRows = participants.length
    ? participants
        .map(
          (p) => `<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.grantCount)}</td>
        <td class="row-actions"><a class="btn sm" href="/admin/participants/${esc(p.id)}/edit">Edit</a></td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No participants yet - add one with <b>+ New participant</b>.</td></tr>`;
  const body = `
    <div class="sectionhead"><h1 style="margin-bottom:0">Participants</h1><a class="btn sm" href="/admin/participants/new">+ New participant</a></div>
    <p class="lead">The AI agents you own, each addressed <code>${esc(owner.username)}/&lt;label&gt;</code>. Granting one into a project mints its access token there.</p>
    <table>
      <thead><tr><th>Name</th><th>In&nbsp;projects</th><th></th></tr></thead>
      <tbody>${participantRows}</tbody>
    </table>`;
  return layout("Participants", body, owner, undefined, undefined, "participants");
}

/** Billing: balance, card/top-up/auto-recharge controls, recent ledger (decision 023). */
export function billingPage(
  owner: Owner,
  csrf: string,
  ledger: LedgerRow[],
  billingNotice: string | null,
  rechargeThreshold: number,
  betaFree = false,
): string {
  const lead = betaFree
    ? "Free during the beta - no charges. Your balance is preserved."
    : "Reads are free; you pay when an agent writes to the shared record.";
  const body = `
    <h1>Billing</h1>
    <p class="lead">${lead}</p>
    ${billingSlot(owner, csrf, ledger, billingNotice, rechargeThreshold, betaFree)}`;
  return layout("Billing", body, owner, undefined, undefined, "billing");
}

/** Account settings (decision 023): the bus handle, account email, and the "runs on" badge. */
export function settingsPage(
  owner: Owner,
  csrf: string,
  handleError?: string,
  handleOk?: boolean,
): string {
  const body = `
    <h1>Settings</h1>
    <p class="lead">Your account and bus identity.</p>

    <div class="sectionhead"><h2>Bus handle</h2></div>
    <div class="help">Your global identity on LLM Bus. Your agents appear as
      <code>${esc(owner.username)}/&lt;label&gt;</code> on every project they join - pick something recognizable.</div>
    ${handleOk ? `<div class="card">Handle saved.</div>` : ""}
    ${handleError ? `<div class="card warn">${esc(handleError)}</div>` : ""}
    <form class="stack" method="POST" action="/admin/handle">
      ${csrfField(csrf)}
      <label>Handle
        <input name="username" required value="${esc(owner.username)}" pattern="[a-z0-9][a-z0-9-]{0,30}[a-z0-9]">
        <span class="hint">2-32 chars: lowercase letters, numbers, dashes. Globally unique.</span>
      </label>
      <button type="submit">Save handle</button>
    </form>

    <div class="sectionhead"><h2>Account</h2></div>
    <div class="help">Signed in as <b>${esc(owner.email)}</b>${owner.isOperator ? " (operator)" : ""}.</div>

`;
  return layout("Settings", body, owner, undefined, undefined, "settings");
}

/** A one-shot billing banner from the ?billing= redirect param. For states that settle via webhook
 *  (card-saved / charging) it auto-reloads to a clean /admin once so the new balance shows. */
function billingBanner(notice: string | null): string {
  if (!notice) return "";
  const refresh = `<meta http-equiv="refresh" content="4;url=/admin/billing">`;
  switch (notice) {
    case "added":
      return `<div class="card"><b>Credits added.</b> Your new balance is below.</div>`;
    case "charging":
      return `${refresh}<div class="card">Payment processing. Your balance updates in a moment.</div>`;
    case "card-saved":
      return `${refresh}<div class="card"><b>Card saved.</b> Applying your welcome credit&hellip;</div>`;
    case "declined":
      return `<div class="card warn"><b>Card was declined.</b> Try a different amount or update your card.</div>`;
    case "nocard":
      return `<div class="card warn">Add a card before topping up.</div>`;
    case "freebeta":
      return `<div class="card"><b>LLM Bus is free during the beta.</b> No charge needed - your balance is preserved.</div>`;
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
  betaFree = false,
): string {
  if (owner.plan === "comped") {
    return `<div class="help">Billing: <span class="pill">Sponsored</span>. This account is comped; usage is not metered.</div>`;
  }
  // Free beta (decision 059): NO charge controls are rendered - the UI must never invite a charge while
  // billing is off. Show the free-beta state + the preserved balance + the ledger so the owner sees their
  // credit is intact. The server also refuses /billing/topup under BETA_FREE (defense in depth).
  if (betaFree) {
    const rows = ledger.length
      ? ledger
          .map(
            (e) =>
              `<tr><td><span class="pill">${esc(e.type)}</span></td><td>${esc(e.amount)}</td><td>${esc(
                e.balance_after,
              )}</td><td class="muted">${esc(e.created_at)}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="4" class="muted">No credit activity yet.</td></tr>`;
    return `<div class="help">
        ${billingBanner(notice)}
        <p>Billing: <span class="pill">Free during beta</span>. Usage is not metered and no card is charged;
          your prepaid balance is preserved and carries forward.</p>
        <p>Token balance: <b>${esc(owner.tokenBalance)}</b> <span class="muted">preserved - not spent during beta.</span></p>
        <table style="margin-top:.7rem">
          <thead><tr><th>Type</th><th>Tokens</th><th>Balance</th><th>When</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
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
      <p>Token balance: <b>${esc(owner.tokenBalance)}</b> <span class="muted">1 token = 1 NOK.</span></p>
      <details class="help"><summary style="cursor:pointer">What am I paying for?</summary>Reads and presence are free - you only spend when an agent writes to the shared record: a handoff, claim, lease, or task.</details>
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
      A <b>project</b> is one coordination space - usually a single codebase or team. Agents you grant into
      it share its ID counters (ADRs, migrations), presence, handoffs, and tasks. Nothing leaks between
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

/** The guided first-run wizard for a brand-new owner (zero projects). One field; POST /admin/setup
 *  creates a project + a lead agent + grant + token in one step and renders the connect card. */
export function setupPage(owner: Owner, csrf: string, error?: string): string {
  const body = `
    <div style="max-width:560px">
      <h1>Welcome. Let's connect your first agent.</h1>
      <p class="lead">About 60 seconds. Name a project - a space your agents share - and we'll set it up
      and give you one line to paste into your AI agent.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <form class="stack" method="POST" action="/admin/setup">
        ${csrfField(csrf)}
        <label>Choose a project name
          <input name="name" required autofocus placeholder="e.g. acme-web">
          <span class="hint">The shared space your agents coordinate in - you can add more later.</span>
        </label>
        <button type="submit">Create &amp; connect</button>
        <p class="hint" style="margin-top:2px">No card needed; free starter credit to try it.</p>
      </form>
    </div>`;
  return layout("Get started", body, owner);
}

/** The lean first-run connect card (wizard screen 2): the ONE connect command + restart + a clear next
 *  step. Deliberately lighter than handoutCard - the owner is connecting their own starter agent, so the
 *  full protocol dump would bury the single action. The complete onboarding kit (for inviting others)
 *  lives on the project page. */
export function wizardConnectCard(
  owner: Owner,
  project: { id: number; name: string },
  participantName: string,
  plaintextToken: string,
  mcpUrl: string,
  participationId: number,
  oneClickUrl: string,
): string {
  const actor = `${owner.username}/${participantName}`; // the qualified bus identity (decision 018)
  const body = `
    <div style="max-width:640px">
      <h1>Done. Connect your agent.</h1>
      <p class="lead">Project <strong>${esc(project.name)}</strong> is ready with a lead agent
      (<span class="actor">${esc(actor)}</span>). Pick your client below - it flips green the moment your
      agent connects.</p>

      <div class="card warn">
        <strong>Your token is shown once</strong> - it's inside the config/command below, so copy it
        somewhere safe now. Lost it? Rotate the token from the project page for a fresh one.
      </div>

      ${connectCard({ token: plaintextToken, mcpUrl, oneClickUrl, live: { participationId, seenAt: null, actor } })}

      <p class="hint" style="margin-top:1rem">After connecting, ask your agent to <b>run whoami on LLM Bus</b>
      to confirm it is <span class="actor">${esc(actor)}</span> (a bare <code>whoami</code> runs your shell,
      not the connector).</p>
      <p style="margin-top:1.2rem"><a class="btn" href="/admin">Go to your projects &rarr;</a>
      <a class="back" href="/admin/projects/${esc(project.id)}" style="margin-left:.9rem">Open the project &amp; full onboarding kit</a></p>
      <p class="hint" style="margin-top:1rem">Coordinating on the bus? <a href="/brand">Add a "Runs on LLM Bus" badge</a> to your README.</p>
    </div>`;
  return layout("Connect your agent", body, owner);
}

/** View / confirm / change the global bus handle (decision 018). */
export function newParticipantPage(owner: Owner, csrf: string): string {
  const body = `
    <h1>New participant</h1>
    <div class="help">
      A <b>participant</b> is one AI <code>agent</code> that will coordinate in your projects - the unique
      entity "on the ledger". One participant = one token, shared across all of that agent's sub-agents
      (they count as one identity). Creating a participant does nothing on its own until you <b>grant</b> it
      into a project. Bringing in a person instead? Don't create them here -
      <b>invite them by email</b> from a project's Access page; they get their own account.
    </div>
    <form class="stack" method="POST" action="/admin/participants">
      ${csrfField(csrf)}
      <label>Name
        <input name="name" required placeholder="claude-backend">
        <span class="hint">Name it for <b>what it does and which tool it is</b> - <code>claude-backend</code>,
          <code>grok-coder</code>, <code>marketing-agent</code>. Your handle is added automatically, so this
          becomes <code>${esc(owner.username ?? "you")}/claude-backend</code>: that is what you and your
          teammates type to assign it work, and what you will see on the board months from now. Do NOT put
          your own handle in the name - you would get it twice. Pick something you can still tell apart when
          you are running four agents.</span>
      </label>
      <button type="submit">Create participant</button>
    </form>
    <a class="back" href="/admin/participants">← Cancel</a>`;
  return layout("New participant", body, owner);
}

// The Board's task columns, in state-machine order and 1:1 with the tasks.status CHECK set in
// db/schema.sql ('open','assigned','in_progress','blocked','review_requested','review_answered','done').
// The v2 five-column read-only board (decision 039): Todo / In progress / Blocked / Done / Cancelled, where
// Blocked is DERIVED (EFFECTIVE_STATUS_SQL). The human DRIVES tasks from /admin/tasks; this per-project Board
// is a read-only situational-awareness surface. Exhaustive on purpose: no status is silently dropped.
const BOARD_COLUMNS: Array<[string, string]> = [
  ["todo", "Todo"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

// The project-level tab strip (decision 023): Board (default) / Access / Settings.
function projectTabs(projectId: number, active: string): string {
  const tabs: Array<[string, string, string]> = [
    ["board", `/admin/projects/${projectId}`, "Board"],
    ["access", `/admin/projects/${projectId}/access`, "Access"],
    ["settings", `/admin/projects/${projectId}/settings`, "Settings"],
  ];
  return `<nav class="tabs" aria-label="Project sections">${tabs
    .map(
      ([key, href, label]) =>
        `<a href="${esc(href)}"${active === key ? ' aria-current="page"' : ""}>${esc(label)}</a>`,
    )
    .join("")}</nav>`;
}

/** Crumbs for a project sub-page: Projects / <name> [ / <tail> ]. */
function projectCrumbs(project: { id: number; name: string }, tail?: string): Crumb[] {
  const base: Crumb[] = [{ label: "Projects", href: "/admin" }];
  return tail
    ? [...base, { label: project.name, href: `/admin/projects/${project.id}` }, { label: tail }]
    : [...base, { label: project.name }];
}

/** First-run safety-net (task #125, enrollment-spread concept): a brand-new project's Board is otherwise a
 *  wall of "-" and "no coordination yet", which reads as a dead end - the empty-bus first impression that
 *  loses a solo tester (and would waste hard-won channel traffic). This shows ONE clearly-labelled example
 *  handoff so the owner sees the SHAPE of coordination. It is DISPLAY-ONLY static markup: it writes no
 *  rows and emits no events, so it never pollutes the ledger, the decision-031 acquisition funnel, or
 *  /api/stats, and it vanishes the instant any real coordination lands (the caller gates on `isFirstRun`).
 *  Static, self-authored strings (no user input), but esc()-free is fine as they are constant literals. */
function firstRunExample(): string {
  return `
    <div class="card" style="border-style:dashed">
      <div class="sectionhead"><h2>Example <span class="pill">preview</span></h2></div>
      <div class="help">This is what your Board shows once two agents coordinate - a live example, not real
        data. It disappears the moment your agents post their first handoff, claim, or task. Connect a
        second participant (another agent, or invite a teammate) to replace it with the real thing.</div>
      <p class="hint" style="margin-bottom:4px">Tasks</p>
      <div class="actrow">
        <div class="actcard"><h3>In progress <span class="muted">1</span></h3><ul class="actlist"><li>Draft the launch post <span class="pill">writer-agent</span></li></ul></div>
        <div class="actcard"><h3>Done <span class="muted">1</span></h3><ul class="actlist"><li>Research the market <span class="pill">research-agent</span></li></ul></div>
      </div>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
        <tbody><tr><td class="muted">just now</td><td>research-agent</td><td>handed off to writer-agent - findings ready, draft the post</td></tr></tbody>
      </table>
    </div>`;
}

/** The project front page (decision 023): the read-only Board - Tasks-by-status + Decisions (decision 022)
 *  + the Activity mirror. The situational-awareness surface. */
export function projectBoardPage(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  notice?: string,
  activity?: ProjectActivity,
  board?: ProjectBoard,
): string {
  // ── Board: tasks grouped by effective status (+ assignee) and the decision record. Read-only; the human
  // creates/assigns/answers tasks on /admin/tasks (decision 039). ──
  const bd = board ?? { tasks: [], decisions: [] };
  const renderTaskItem = (tk: TaskCard): string => {
    const who = tk.assignee
      ? `<span class="pill">${esc(tk.assignee)}</span>`
      : `<span class="muted">unassigned</span>`;
    return `<li>${esc(tk.title)} ${who}</li>`;
  };
  const taskCols = BOARD_COLUMNS.map(([status, label]) => {
    const items = bd.tasks.filter((tk) => tk.status === status);
    const list = items.length ? items.map(renderTaskItem).join("") : `<li class="muted">-</li>`;
    return `<div class="actcard"><h3>${esc(label)} <span class="muted">${items.length}</span></h3><ul class="actlist">${list}</ul></div>`;
  }).join("");

  const decisionsBySeq = new Map<string, DecisionClaim[]>();
  for (const d of bd.decisions) {
    const arr = decisionsBySeq.get(d.sequence) ?? [];
    arr.push(d);
    decisionsBySeq.set(d.sequence, arr);
  }
  const decisionsHtml = decisionsBySeq.size
    ? [...decisionsBySeq.entries()]
        .map(
          ([seq, ds]) =>
            `<div class="actcard"><h3>${esc(seq || "sequence")} <span class="muted">${ds.length}</span></h3><ul class="actlist">${ds
              .map(
                (d) =>
                  `<li><code>${esc(d.formatted)}</code>${d.note ? ` ${esc(d.note)}` : ""} <span class="muted">${esc(d.actor)}</span></li>`,
              )
              .join("")}</ul></div>`,
        )
        .join("")
    : `<div class="actcard"><h3>Decisions</h3><ul class="actlist"><li class="muted">no numbers claimed yet - decisions and migrations your agents claim on the bus show here.</li></ul></div>`;

  const boardSection = `
    <div class="help">What your agents picked up and decided here - tasks by status, and the numbered
      decision record. To create, assign, or answer tasks, use
      <a href="/admin/tasks?project=${esc(project.id)}">Tasks</a>.</div>
    <p class="hint" style="margin-bottom:4px">Tasks &middot; <a href="/admin/tasks?project=${esc(project.id)}">Manage on the Tasks board</a></p>
    <div class="actrow">${taskCols}</div>
    <p class="hint" style="margin:12px 0 4px">Decisions</p>
    <div class="actrow">${decisionsHtml}</div>`;

  // ── Activity: a read-only window so the human can SEE the coordination, not just trust it. ──
  const act = activity ?? { events: [], leases: [], sequences: [], agents: [] };
  const t = (iso: string): string => esc(iso.slice(0, 16).replace("T", " "));
  const agentChips = act.agents.length
    ? act.agents
        .map(
          (a) =>
            // Presence only: a short identity chip (actor + lane). The agent's freeform check-in
            // status is deliberately NOT rendered here - a paragraph in a pill-radius chip wraps into
            // an irregular blob. Presence is the signal this card carries; status is ephemeral.
            `<span class="pill ok">${esc(a.actor)}${a.lane ? ` &middot; ${esc(a.lane)}` : ""}</span>`,
        )
        .join(" ")
    : `<span class="muted">nobody checked in right now</span>`;
  const leaseList = act.leases.length
    ? act.leases
        .map((l) => `<li><code>${esc(l.surface)}</code> - ${esc(l.actor)} <span class="muted">until ${t(l.expiresAt)}</span></li>`)
        .join("")
    : `<li class="muted">no files leased</li>`;
  const seqList = act.sequences.length
    ? act.sequences.map((s) => `<li><b>${esc(s.name)}</b> at <code>${esc(s.latest)}</code></li>`).join("")
    : `<li class="muted">no numbers claimed yet</li>`;
  const evRows = act.events.length
    ? act.events.map((e) => `<tr><td class="muted">${t(e.ts)}</td><td>${esc(e.actor)}</td><td>${esc(e.summary)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">No coordination yet - once your agents claim numbers, lease files, or hand off work, it shows here.</td></tr>`;
  const activitySection = `
    <div class="sectionhead"><h2>Activity</h2></div>
    <div class="help">The shared record your agents write to. Reads and check-ins are free and don't appear.</div>
    <div class="actrow">
      <div class="actcard"><h3>Active now</h3><p>${agentChips}</p></div>
      <div class="actcard"><h3>Files leased</h3><ul class="actlist">${leaseList}</ul></div>
      <div class="actcard"><h3>Latest numbers</h3><ul class="actlist">${seqList}</ul></div>
    </div>
    <table>
      <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
      <tbody>${evRows}</tbody>
    </table>`;

  const noticeHtml = notice ? `<div class="card">${esc(notice)}</div>` : "";
  // First-run safety-net (#125): show the example ONLY when nothing real has happened yet - no tasks, no
  // decisions, and an empty activity mirror (events/leases/agents/sequences). Any real coordination flips
  // this off, so the preview self-retires. Guarded so it can never sit alongside real data.
  const isFirstRun =
    bd.tasks.length === 0 &&
    bd.decisions.length === 0 &&
    act.events.length === 0 &&
    act.leases.length === 0 &&
    act.agents.length === 0 &&
    act.sequences.length === 0;
  const body = `
    <h1>${esc(project.name)}</h1>
    ${projectTabs(project.id, "board")}
    ${noticeHtml}
    ${isFirstRun ? firstRunExample() : ""}
    <div class="sectionhead"><h2>Board</h2></div>
    ${boardSection}
    ${activitySection}`;
  return layout(project.name, body, owner, projectCrumbs(project), undefined, "projects");
}

// ── The human task control surface (decision 039, v2) ───────────────────────────────────────────────
// The /admin/tasks board + authoring pages let a human DRIVE tasks across their projects from the web, so a
// human can run a headless agent through the bus alone. Every write goes through admin/task-writes.ts, which
// re-proves the membership predicate (invariant 3); these renderers are display-only. Every dynamic value is
// esc()'d; artifact links pass isHttpUrl (invariant 4); every form carries CSRF.

// The five effective columns (decision 039). `blocked` is derived (EFFECTIVE_STATUS_SQL); there is no
// persisted 'blocked' base status.
const TASK_COLUMNS: Array<[string, string]> = [
  ["todo", "Todo"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

/** Render a task's artifact links as a DISCRETE listed set (decision 041) - each link is its own item, not
 *  buried in body text ("attach a link, not a blob"). Each becomes an anchor ONLY when isHttpUrl passes,
 *  otherwise escaped text (invariant 4 - a javascript:/data: url never becomes an href). */
function renderTaskLinks(links: { label: string; url: string }[] | null): string {
  if (!links || !links.length) return "";
  const items = links
    .map((l) => {
      const label = l.label && l.label.trim() ? l.label : l.url;
      // An image link renders as an inline thumbnail (decision 051) - you SEE the screenshot instead of a bare
      // link. The <img src> is esc()'d and scheme-gated by isImageUrl (no javascript:/data:); if the image
      // fails to load (not really an image, 404, blocked) it removes itself, leaving the caption link - so the
      // link always works. The caption link is the same target, so nothing is lost when the preview can't show.
      if (isImageUrl(l.url)) {
        return `<li class="linkimg"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow"><img src="${esc(l.url)}" alt="${esc(label)}" loading="lazy" onerror="this.remove()"><span class="cap">${esc(label)}</span></a></li>`;
      }
      const body = isHttpUrl(l.url)
        ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(label)}</a>`
        : esc(label);
      return `<li>${body}</li>`;
    })
    .join("");
  return `<ul class="linklist">${items}</ul>`;
}

/** The harmonized glance line (decision 046): a single, same-font, baseline-aligned strip of at-a-glance
 *  facts (id, from, type, lane, ...) shown IDENTICALLY under the title on the list row and the detail page,
 *  so a person learns one shape. Each item is pre-escaped html; the middots between items are drawn by CSS.
 *  Falsy items are dropped. */
function glanceLine(items: Array<string | false | null | undefined>): string {
  const cells = items.filter(Boolean).map((h) => `<span class="g">${h}</span>`).join("");
  return `<div class="glance">${cells}</div>`;
}

/** The action controls for ONE task on the detail page (decisions 039/042/046). ~95% of human-facing tasks
 *  are DECISIONS an agent asked, so the HAPPY PATH is dominant: answer the decision (option chips, or a
 *  written reply on a plain task) - which SENDS your answer back to the asking agent and closes the task
 *  (never a silent dismiss). Everything else ("other ways to handle it" - reassign, change status) is quiet,
 *  clearly separated, and each says what it does, so a person who cannot answer as intended glances
 *  down and finds the way out. Every path moves the task to someone. The write layer re-proves authority +
 *  the transition regardless (a control a plain member cannot use just 404s). */
function taskCardControls(task: OwnerBoardTask, csrf: string, roster: AssignTarget[]): string {
  const base = `/admin/projects/${task.projectId}/tasks/${task.taskId}`;
  const terminal = task.status === "done" || task.status === "cancelled";
  const hasOptions = Array.isArray(task.options) && task.options.length > 0;
  const label = (s: string): string => (TASK_COLUMNS.find(([v]) => v === s) ?? [s, s])[1];

  const answered =
    task.selectedOption || task.answerNote
      ? `<div class="hint answered">Answer sent: ${esc(task.selectedOption ?? "(note)")}${task.answerNote ? ` - ${esc(task.answerNote)}` : ""}</div>`
      : "";

  // The Status dropdown of VALID target states + Update (decision 042). The handler re-validates the
  // transition (todo->in_progress start; in_progress->todo un-start; ->done ship; ->cancelled cancel;
  // terminal->todo reopen). An option task is answered, not shipped, so it omits 'done'.
  const targets: string[] =
    task.status === "todo"
      ? ["in_progress", "cancelled"]
      : task.status === "in_progress"
        ? hasOptions
          ? ["todo", "cancelled"]
          : ["todo", "done", "cancelled"]
        : task.status === "blocked"
          ? ["cancelled"]
          : ["todo"]; // done/cancelled -> reopen
  const statusCtl = `<form method="POST" action="${esc(`${base}/status`)}" class="ow-ctl">
      ${csrfField(csrf)}
      <select name="status" aria-label="Change status">${targets
        .map((t) => `<option value="${esc(t)}">${esc(label(t))}${t === "cancelled" ? " (cancel task)" : ""}</option>`)
        .join("")}</select>
      <button type="submit" class="btn sm">Update</button>
    </form>`;

  if (terminal) {
    // A finished task: the recorded answer + a single manage row (reopen / change status).
    return `${answered}<div class="otherways"><div class="ow-h">Manage</div>
        <div class="ow-row"><div class="ow-desc"><b>Reopen or change status</b>Bring this task back to Todo, or leave it closed.</div>${statusCtl}</div>
      </div>`;
  }

  const askerTag = task.createdByPid != null ? `agent:${task.createdByPid}` : null;
  const backTo = task.createdByName ? `<b>${esc(task.createdByName)}</b>` : "the agent that asked";

  // HAPPY PATH (decision 047): make the decision (chips) or, on a plain task, send a written reply. Both post
  // to /respond; the reply routes back to the asker (created_by_id) and closes the task. On a decision task
  // the chips ARE the answer. "None of the above" (option=other) submits a WRITTEN reply from the box below
  // it, and is disabled until that box has text (a small inline handler toggles it; the server also validates).
  const answerInner = hasOptions
    ? `<div class="ab-h">Your decision</div>
       <div class="ab-sub">Pick an option, your reply goes back to ${backTo}, and closes this task.</div>
       <div class="chips">${(task.options ?? [])
         .map((o) => `<button type="submit" name="option" value="${esc(o)}" class="btn">${esc(o)}</button>`)
         .join("")}</div>
       <div class="escape-top"><button type="submit" name="option" value="other" id="needs-note" class="btn sm" disabled>None of the above. Follow the instructions provided below</button></div>
       <div class="answer-note"><textarea name="note" rows="3" aria-label="Your written reply" placeholder="Type your reply here..." oninput="var b=document.getElementById('needs-note');if(b)b.disabled=!this.value.trim()"></textarea></div>`
    : `<div class="ab-h">Your reply</div>
       <div class="ab-sub">Your reply goes back to ${backTo}, and closes this task.</div>
       <div class="answer-note"><textarea name="note" rows="3" aria-label="Your reply" placeholder="Type your reply here..."></textarea></div>
       <div class="answer-actions"><button type="submit" name="action" value="answer" class="btn">Send reply</button></div>`;
  const answerBlock = `<form method="POST" action="${esc(`${base}/respond`)}" class="answer-block">
      ${csrfField(csrf)}
      ${answerInner}
    </form>`;

  // OTHER WAYS to handle it (decision 047): "hand to an agent" and "reassign" were indistinguishable, so they
  // are now ONE "Reassign" - give the task to any agent or teammate (defaulting to the agent that asked); they
  // pick it up on their next check. Plus Change status. Each control sits DIRECTLY under its explanation.
  const reassignRow = roster.length
    ? `<div class="ow-row">
         <div class="ow-desc"><b>Reassign</b>Give this task to someone else - an agent or a teammate. They pick it up on their next check.</div>
         <form method="POST" action="${esc(`${base}/assign`)}" class="ow-ctl">
           ${csrfField(csrf)}
           <select name="assignee" aria-label="Reassign to">
             <option value="">Unassigned</option>
             ${roster.map((r) => `<option value="${esc(r.tag)}"${r.tag === askerTag ? " selected" : ""}>${esc(r.label)}</option>`).join("")}
           </select>
           <button type="submit" class="btn sm">Reassign</button>
         </form>
       </div>`
    : "";
  const statusRow = `<div class="ow-row">
       <div class="ow-desc"><b>Change status</b>Pause, cancel, or reopen this task.</div>
       ${statusCtl}
     </div>`;

  // Decision 073: say WHAT is blocking it, not how many things are. A count answers a question nobody has;
  // the reason text was always stored and never shown, and a dependency's target was never linked - so the
  // page said "blocked" and left the reader with the only question they actually came with.
  const rows = task.blockerRows ?? [];
  const blockedNote =
    task.status === "blocked"
      ? `<div class="blockedbox">
           <div class="bb-h">Blocked${rows.length ? "" : " on a dependency"}</div>
           ${
             rows.length
               ? rows
                   .map((b) => {
                     const target =
                       b.blockedOnTaskId != null
                         ? `<div class="bb-on">Waiting on <a href="/admin/projects/${esc(
                             b.blockedOnProjectId ?? task.projectId,
                           )}/tasks/${esc(b.blockedOnTaskId)}">#${esc(b.blockedOnTaskId)} ${esc(
                             b.blockedOnTitle ?? "(task)",
                           )}</a>${
                             b.blockedOnStatus ? ` <span class="muted">- ${esc(b.blockedOnStatus)}</span>` : ""
                           }. It clears on its own when that finishes.</div>`
                         : `<div class="bb-on bb-manual">Blocked BY HAND, not by another task. Nothing will lift this
                              automatically - someone has to decide it is over and unblock it.</div>`;
                     const why = b.reason ? `<div class="bb-why">${esc(b.reason)}</div>` : "";
                     // Decision 074. A manual block now carries its exit condition and an owner. Rows
                     // written before 074 have neither, and that is shown AS missing - the alternative is a
                     // silent blank that reads exactly like a block nobody has to act on, which is the
                     // state 074 exists to end.
                     const lift =
                       b.blockedOnTaskId != null
                         ? ""
                         : b.unblockCondition
                           ? `<div class="bb-lift"><b>Lifts when:</b> ${esc(b.unblockCondition)}</div>`
                           : `<div class="bb-lift bb-gap">No exit condition was recorded - this block ` +
                             `predates the rule that one is required.</div>`;
                     const who =
                       b.blockedOnTaskId != null
                         ? ""
                         : b.unblockOwner
                           ? `<div class="bb-who"><b>Owned by:</b> ${esc(b.unblockOwner)}</div>`
                           : `<div class="bb-who bb-gap">Nobody owns lifting this. Reassign it to someone ` +
                             `who can process it, or resolve it.</div>`;
                     return `<div class="bb-item">${target}${why}${lift}${who}</div>`;
                   })
                   .join("")
               : `<div class="bb-on">A dependency is unfinished. It clears on its own when that task completes.</div>`
           }
         </div>`
      : "";
  const other = `<div class="otherways"><div class="ow-h">Other ways to handle it</div>${reassignRow}${statusRow}</div>`;
  return `${answered}${blockedNote}${answerBlock}${other}`;
}

/** The cross-project task board (decision 041): a scannable, status-GROUPED LIST (not five crammed columns).
 *  Each task is ONE line - title link + at-a-glance meta + a couple of badges - that opens a detail page where
 *  it is actually worked. Membership-scoped by listTasksForOwnerBoard; ?project=<id> narrows. Read-only here
 *  (no inline forms), so no roster/CSRF needed on this page. Routed through layout() (analytics + esc()). */
export function tasksPage(
  owner: Owner,
  tasks: OwnerBoardTask[],
  projectsForNew: Array<{ id: number; name: string }>,
  filter: { projectId?: number; assignee?: string; allDone?: boolean } = {},
  toast?: Toast,
): string {
  const row = (t: OwnerBoardTask): string => {
    const href = `/admin/projects/${esc(t.projectId)}/tasks/${esc(t.taskId)}`;
    // The harmonized glance line (decision 046): id | from (who asked) | type | lane, ALL in one place under
    // the title (nothing split off to the right). Project is added only on the "all projects" view (it is
    // redundant when the board is already filtered); a link count comes last. Same shape as the detail page.
    const items: Array<string | false> = [`<span class="v">#${esc(t.taskId)}</span>`];
    if (t.createdByName) items.push(`<span class="k">from</span> <span class="v">${esc(t.createdByName)}</span>`);
    if (Array.isArray(t.options) && t.options.length) items.push(`<span class="badge decide">decision</span>`);
    // Decision 074 named a person as the owner of an unblock and then told only agents. On the board that
    // row was indistinguishable from any other blocked task, so the one person who could clear it had no way
    // to spot it (ruling 2026-08-30-1). It is deliberately its own badge rather than folded into "for <you>":
    // the task is someone else's work and the assignee line must keep saying so.
    if (t.waitingOnMe) items.push(`<span class="badge decide">waiting on you</span>`);
    if (t.lane) items.push(`<span class="k">lane</span> <span class="v">${esc(t.lane)}</span>`);
    if (!filter.projectId)
      items.push(`<span class="k">in</span> <a class="v" href="/admin/tasks?project=${esc(t.projectId)}">${esc(t.projectName)}</a>`);
    // "for <assignee>" appears in BOTH views at the same spot (decision 047), so the list and detail lines match.
    items.push(`<span class="k">for</span> <span class="v">${t.assignee ? esc(t.assignee) : "unassigned"}</span>`);
    if (t.links && t.links.length)
      items.push(`<span class="v">${esc(t.links.length)} link${t.links.length > 1 ? "s" : ""}</span>`);
    return `<div class="taskrow s-${esc(t.status)}">
        <a class="t-title" href="${href}">${esc(t.title)}</a>
        ${glanceLine(items)}
      </div>`;
  };

  // Build a board URL preserving the current filters, with overrides (decision 050). Values are our own (a
  // project id, an assignee handle, the alldone flag); URLSearchParams encodes them, esc() guards the HTML
  // attribute at the call site. Never renders the raw assignee string as markup.
  const boardUrl = (over: { assignee?: string; allDone?: boolean; projectId?: number | null }): string => {
    const p = new URLSearchParams();
    // projectId override (decision 058): undefined = keep the current project; a number = that project;
    // null = an EXPLICIT empty `project=` (present-but-empty) so the empty-state escape link clears the
    // project and overrides the sticky cookie (the handler keys on param presence, not truthiness).
    const pid = over.projectId !== undefined ? over.projectId : filter.projectId;
    if (typeof pid === "number") p.set("project", String(pid));
    else if (over.projectId === null) p.set("project", "");
    const a = over.assignee !== undefined ? over.assignee : filter.assignee ?? "";
    if (a) p.set("assignee", a);
    const ad = over.allDone !== undefined ? over.allDone : filter.allDone;
    if (ad) p.set("alldone", "1");
    const q = p.toString();
    return q ? `/admin/tasks?${q}` : "/admin/tasks";
  };

  // Assignee filter (decision 050 / task 449): a render-level NARROWING of the already membership-scoped board
  // (invariant 3 untouched - this only HIDES rows already visible, never widens). "" = everyone, "@me" = tasks
  // assigned to me the human (OwnerBoardTask.mine), else an exact assignee handle. My own handle is folded into
  // "Me", so the picker's other entries are the OTHER participants.
  const asg = filter.assignee ?? "";
  const matchesAssignee = (t: OwnerBoardTask): boolean =>
    !asg ? true : asg === "@me" ? !!t.mine : t.assignee === asg;

  // Sort within each group (decision 048): actionable groups OLDEST-first (FIFO - longest-waiting on top, so
  // nothing rots); terminal groups newest-first (a recent-completions archive). taskId is monotonic with
  // creation. `.filter` returns a fresh array, so sorting never mutates the caller's `tasks`. Terminal groups
  // are CAPPED (decision 050 / task 447): Done/Cancelled grow fast now agents log completed work, so show the
  // most recent TERMINAL_CAP with a "Load more" that lifts the cap (?alldone=1). Actionable groups are never
  // capped - they are the plate.
  const ACTIONABLE = new Set(["todo", "in_progress", "blocked"]);
  const TERMINAL_CAP = 8;
  // An empty status column renders ONE placeholder row (task 541) so the five columns are a fixed structure the
  // eye can rely on, not a list that vanishes on filter/empty. An empty Todo is inbox-zero - the operator asked
  // for a celebration there; every other empty column is a quiet "Nothing here".
  const emptyRow = (status: string): string => {
    if (status === "todo") {
      // The empty-Todo chain (task #611): a project filter that comes up empty offers a one-click escape
      // back to all projects (keeping the current assignee lens via an explicit `project=`); the
      // all-projects @me inbox-zero is the celebratory end of the line. The link text carries no user
      // data; the href is esc()'d. Other actionable/terminal empties stay a quiet "Nothing here".
      let inner: string;
      if (filter.projectId) {
        inner = `All clear in this project. <a href="${esc(boardUrl({ projectId: null, assignee: asg }))}">View all projects</a>`;
      } else if (asg === "@me") {
        inner = "\u{1F389} Inbox zero across every project - nothing waiting for you anywhere. Go grab a drink ;)";
      } else {
        inner = "\u{1F389} Nothing to do";
      }
      return `<div class="taskrow empty"><span class="emptymsg">${inner}</span></div>`;
    }
    return `<div class="taskrow empty"><span class="emptymsg">Nothing here</span></div>`;
  };
  const sections = TASK_COLUMNS.map(([status, label]) => {
    const all = tasks
      .filter((t) => t.status === status && matchesAssignee(t))
      .sort((a, b) => (ACTIONABLE.has(status) ? a.taskId - b.taskId : b.taskId - a.taskId));
    // Decision 062: an ACTIONABLE column is now complete by construction, so its count is exact. A terminal
    // column is fetched newest-first under an archive cap, and groupTotal carries the true pre-cap depth - so
    // the header states the real number instead of however many rows happened to load. Under an assignee lens
    // the rows were narrowed by a predicate the QUERY never applied, so the pre-cap total does not describe
    // this set and the loaded count is the only honest one available. Residual, bounded and accepted: a
    // LENSED terminal column can still under-count if the cap cut rows the lens would have kept - reachable
    // only past ~1000 archived tasks in one column, and it costs an archive number, never a row of the plate.
    const lensed = asg !== "";
    const notLoaded =
      !ACTIONABLE.has(status) && !lensed && all.length
        ? Math.max(0, (all[0].groupTotal ?? all.length) - all.length)
        : 0;
    const overCap = !ACTIONABLE.has(status) && all.length > TERMINAL_CAP;
    const shown = overCap && !filter.allDone ? all.slice(0, TERMINAL_CAP) : all;
    const expand = !overCap
      ? ""
      : filter.allDone
        ? `<div class="loadmore"><a href="${esc(boardUrl({ allDone: false }))}">Show fewer</a></div>`
        : `<div class="loadmore"><a href="${esc(boardUrl({ allDone: true }))}">Load more (${all.length - TERMINAL_CAP} more)</a></div>`;
    // Only worth saying once the expand control is already spent: before that, "Load more" reaches them.
    const deep =
      notLoaded && filter.allDone
        ? `<div class="loadmore"><span class="muted">${notLoaded} older not loaded</span></div>`
        : "";
    const rows = all.length ? shown.map(row).join("") : emptyRow(status);
    return `<section class="tasksec"><h3>${esc(label)} <span class="n">${all.length + notLoaded}</span></h3>
        <div class="tasklist">${rows}</div>${expand}${deep}</section>`;
  }).join("");

  // Create control (RIGHT of the bar, decision 046): a primary button for a single project; a select-navigate
  // ("Create a task in [project]") when there are several - one control that scales, not a wall of
  // one-button-per-project. The select navigates via the same inline pattern as the filter (option values are
  // our own project ids, not user input); a <noscript> fallback lists direct links.
  const newSelect = `<label class="inline">Create a task in
      <select aria-label="Create a task in project"
        onchange="if(this.value){window.location.href='/admin/projects/'+this.value+'/tasks/new'}">
        <option value="">choose project...</option>
        ${projectsForNew.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
      </select>
    </label>
    <noscript>${projectsForNew
      .map((p) => `<a class="btn sm" href="/admin/projects/${esc(p.id)}/tasks/new">${esc(p.name)}</a>`)
      .join(" ")}</noscript>`;
  const newPick =
    projectsForNew.length === 1
      ? `<a class="btn" href="/admin/projects/${esc(projectsForNew[0].id)}/tasks/new">Create a task</a>`
      : projectsForNew.length
        ? newSelect
        : `<span class="muted">Create a project first to author tasks.</span>`;

  // Filter bar (LEFT of the bar, decisions 046/050): scope by project AND by assignee, both in ONE GET form so
  // changing either preserves the other. Project select shows with >1 project; the assignee select (task 449)
  // shows only when there are >=2 assignee buckets to choose among (self counts as one) - a single-assignee
  // board has nothing to narrow. `alldone` rides as a hidden field so re-filtering keeps an expanded terminal
  // list expanded. The owner's own handle is folded into "Me"; the rest are the other participants.
  // Fold the owner's own assignee handle(s) into "Me" so it is not a duplicate entry in the picker. This dedup
  // relies on a handle never being BOTH mine and someone else's: a human assignee's owner_name is their unique
  // username/email; an agent's is `handle/label` (always contains "/", set with assignee_owner_id NULL so it is
  // never "mine"). If that ever changes (e.g. agent owner_name loses the prefix), revisit this fold.
  const mineAssignees = new Set(tasks.filter((t) => t.mine && t.assignee).map((t) => t.assignee as string));
  const others = Array.from(
    new Set(tasks.map((t) => t.assignee).filter((a): a is string => !!a && !mineAssignees.has(a))),
  ).sort((a, b) => a.localeCompare(b));
  const anyMine = tasks.some((t) => t.mine);
  // Decision 058 / task #611: switching project PRESERVES the assignee lens (the operator picks a project
  // then works through THEIR list), so the onchange no longer resets assignee - it submits both together.
  const projectSelect =
    projectsForNew.length > 1
      ? `<label class="inline">Filter list:
           <select name="project" onchange="this.form.submit()">
             <option value="">All projects</option>
             ${projectsForNew
               .map((p) => `<option value="${esc(p.id)}"${filter.projectId === p.id ? " selected" : ""}>${esc(p.name)}</option>`)
               .join("")}
           </select>
         </label>`
      : "";
  // Decision 058 / task #611: with @me the default, the assignee select is the escape hatch back to
  // "Everyone" - so it must render whenever a narrowing filter is active (asg !== ""), not only with >=2
  // buckets. "Everyone" (value="") is always present. A concrete-handle filter with no rows on the current
  // board is still injected as a selected option so the current selection stays representable (else the
  // browser would show Everyone selected while @me/handle is actually applied). "Me" shows when the owner
  // has a mine-task OR @me is the active lens (so an empty @me board still offers Me).
  const concreteAsg = asg !== "" && asg !== "@me" ? asg : null;
  const otherAssignees =
    concreteAsg && !others.includes(concreteAsg)
      ? [concreteAsg, ...others].sort((a, b) => a.localeCompare(b))
      : others;
  const showMe = anyMine || asg === "@me";
  const assigneeSelect =
    (showMe ? 1 : 0) + otherAssignees.length >= 2 || asg !== ""
      ? `<label class="inline">Assignee:
           <select name="assignee" onchange="this.form.submit()">
             <option value=""${!asg ? " selected" : ""}>Everyone</option>
             ${showMe ? `<option value="@me"${asg === "@me" ? " selected" : ""}>Me</option>` : ""}
             ${otherAssignees
               .map((a) => `<option value="${esc(a)}"${asg === a ? " selected" : ""}>${esc(a)}</option>`)
               .join("")}
           </select>
         </label>`
      : "";
  const filterForm =
    projectSelect || assigneeSelect
      ? `<div class="filterwrap"><form method="GET" action="/admin/tasks">
           ${projectSelect}${assigneeSelect}
           ${filter.allDone ? `<input type="hidden" name="alldone" value="1">` : ""}
           <noscript><button type="submit" class="btn sm">Filter</button></noscript>
         </form></div>`
      : "";

  // The five columns are ALWAYS rendered (task 541) - each empty group carries a placeholder row - so `sections`
  // is never empty and the board is a fixed, scannable structure. The intro help below orients a first-run user.
  const board = sections;

  const body = `
    <h1>Tasks</h1>
    <div class="help taskintro">Every task across your projects - answer the decisions your agents ask you,
      assign work, attach links, and drive each to done. The same task graph your agents see on the bus.
      Actionable lists show oldest first, so the longest-waiting task sits on top.</div>
    <div class="taskbar">${filterForm}<div class="newpick">${newPick}</div></div>
    ${board}`;
  return layout("Tasks", body, owner, undefined, undefined, "tasks", toast);
}

/** The task DETAIL / working surface (decision 041): full title + status + meta, the complete detail body,
 *  artifact links as a DISCRETE listed set, the decision options + answer, and every control (start/ship/
 *  answer/assign/cancel/reopen) - moved off the cramped board onto a page with room. Membership-gated upstream
 *  (the handler 404s a non-member/foreign/missing task before rendering, no 403 oracle). CSRF on every control
 *  POST; every value esc()'d; artifact links behind isHttpUrl (invariant 4). */
export function taskDetailPage(
  owner: Owner,
  task: OwnerBoardTask,
  project: { id: number; name: string },
  roster: AssignTarget[],
  csrf: string,
  error?: string,
  toast?: Toast,
): string {
  const statusLabel = (TASK_COLUMNS.find(([s]) => s === task.status) ?? [task.status, task.status])[1];
  const terminal = task.status === "done" || task.status === "cancelled";
  const hasOptions = Array.isArray(task.options) && task.options.length > 0;
  // The harmonized glance line (decision 046): the SAME shape as the list row (status, #id, from, type, lane)
  // plus the detail-only project + assignee - so the two views read identically. Title + this ONE line, never
  // a three-line stack.
  // The glance line starts at #id (NO leading status pill - that sits on the title line, decision 047) so it
  // lines up with the list row. Same shape as the list: id | from | type | lane | in project | for assignee.
  const glanceItems: Array<string | false | null> = [
    `<span class="v">#${esc(task.taskId)}</span>`,
    task.createdByName && `<span class="k">from</span> <span class="v">${esc(task.createdByName)}</span>`,
    hasOptions && `<span class="badge decide">decision</span>`,
    task.lane && `<span class="k">lane</span> <span class="v">${esc(task.lane)}</span>`,
    `<span class="k">in</span> <span class="v">${esc(task.projectName)}</span>`,
    `<span class="k">for</span> <span class="v">${task.assignee ? esc(task.assignee) : "unassigned"}</span>`,
  ];
  const errorBox = error ? `<div class="card warn" style="margin:14px 0 0">${esc(error)}</div>` : "";
  // Options are actionable chips while the task is live; show them read-only ONLY once terminal (the chips are
  // gone then) so what was on offer stays visible - never both at once.
  const decision =
    terminal && hasOptions
      ? `<div class="metaline"><span>Decision options <b>${(task.options ?? []).map((o) => esc(o)).join(", ")}</b></span></div>`
      : "";
  const detail = task.detail
    ? `<div class="detailbody">${esc(task.detail)}</div>`
    : `<p class="muted detail-empty">No detail.</p>`;
  const links =
    task.links && task.links.length ? `<div class="worksec"><h3>Links</h3>${renderTaskLinks(task.links)}</div>` : "";
  const controls = `<div class="worksec"><h3>Work this task</h3>${taskCardControls(task, csrf, roster)}</div>`;

  const body = `
    <div class="taskcard taskdetail s-${esc(task.status)}">
      <div class="taskhead">
        <div class="th-top">
          <h1>${esc(task.title)}</h1>
          <span class="statuspill s-${esc(task.status)}">${esc(statusLabel)}</span>
        </div>
        ${glanceLine(glanceItems)}
      </div>
      ${errorBox}
      ${decision}
      ${detail}
      ${links}
      ${controls}
    </div>
    <a class="back" href="/admin/tasks?project=${esc(task.projectId)}">&larr; All tasks</a>`;
  const crumbs: Crumb[] = [
    { label: "Tasks", href: "/admin/tasks" },
    { label: project.name, href: `/admin/tasks?project=${project.id}` },
    // The last crumb is the task ID, not the title - the title is the h1 right below it (decision 047).
    { label: `#${task.taskId}` },
  ];
  return layout(task.title, body, owner, crumbs, undefined, "tasks", toast);
}

/** The create-a-task form for one project (decision 039): title/detail/lane, an optional assignee (agents +
 *  human members via the dropdown roster), and optional decision options (comma-separated). Membership-gated
 *  upstream (the handler 404s a non-member before rendering). CSRF on the POST; every value esc()'d. */
export function newTaskPage(
  owner: Owner,
  project: { id: number; name: string },
  roster: AssignTarget[],
  csrf: string,
  error?: string,
): string {
  const body = `
    <h1>New task</h1>
    <div class="help">Create a task in <b>${esc(project.name)}</b>. Assign it to an agent or a teammate, or leave
      it unassigned for anyone to grab. Add decision options to make it a "decide this" task - whoever answers
      picks an option and every task depending on it unblocks.</div>
    ${error ? `<div class="card">${esc(error)}</div>` : ""}
    <form method="POST" action="/admin/projects/${esc(project.id)}/tasks/new" class="stack" style="max-width:560px">
      ${csrfField(csrf)}
      <label>Title <input type="text" name="title" required maxlength="200" placeholder="What needs doing"></label>
      <label>Detail <span class="hint">(optional)</span>
        <textarea name="detail" rows="3" placeholder="Definition of done, context, links"></textarea>
      </label>
      <label>Lane <span class="hint">(optional, e.g. dev / marketing)</span>
        <input type="text" name="lane" maxlength="64" placeholder="lane">
      </label>
      <label>Assignee
        <select name="assignee">
          <option value="">Unassigned</option>
          ${roster.map((r) => `<option value="${esc(r.tag)}">${esc(r.label)}</option>`).join("")}
        </select>
      </label>
      <label>Decision options <span class="hint">(optional, comma-separated - makes this a decide-this task)</span>
        <input type="text" name="options" maxlength="400" placeholder="option a, option b">
      </label>
      <label>Links <span class="hint">(optional - one per line as  label | url ; listed as discrete items on the task)</span>
        <textarea name="links" rows="3" placeholder="Spec on main | https://github.com/org/repo/blob/main/spec.md&#10;Figma | https://figma.com/file/..."></textarea>
      </label>
      <div class="row-actions">
        <button type="submit" class="btn">Create task</button>
        <a class="btn sm" href="/admin/tasks">Cancel</a>
      </div>
    </form>`;
  return layout("New task", body, owner, projectCrumbs(project, "New task"), undefined, "tasks");
}

/** The send-a-message page for one project (decision 039): a human posts a prose note to a lane and/or a
 *  specific agent, owner-authored. Membership-gated upstream. CSRF on the POST; every value esc()'d. */
export function messagesPage(
  owner: Owner,
  project: { id: number; name: string },
  roster: AssignTarget[],
  csrf: string,
  sent?: boolean,
  /** Reach count on a successful send, so the confirmation states a number instead of a promise. */
  reached?: number,
  /** Why the send was refused (decision 065): an unknown lane, or a lane nobody resolves to. */
  error?: string,
  /** What the operator typed, echoed back on a refusal so a rejected lane does not cost them the message. */
  draft?: { toLane: string; toActor: string; subject: string; body: string },
): string {
  // Only AGENT targets are addressable directly (a message to a human is a task assigned to them). The roster
  // filters to agents; the label carries the bare bus label the handler resolves.
  const agentOptions = roster
    .filter((r) => r.kind === "agent")
    .map((r) => {
      const label = r.label.includes("/") ? r.label.slice(r.label.lastIndexOf("/") + 1) : r.label;
      return `<option value="${esc(label)}"${draft?.toActor === label ? " selected" : ""}>${esc(r.label)}</option>`;
    })
    .join("");
  const body = `
    <h1>Message</h1>
    <div class="help">Send a prose note into <b>${esc(project.name)}</b> - to a lane (every agent in it) or one
      agent. Your agent reads it on its next check-in. A lane has to exist before you can post to it: an agent
      joins one with <code>register</code>, or you set one on the Access page. To ask for a deliverable,
      create a task instead so it is tracked to done.</div>
    ${error ? `<div class="card warn">${esc(error)}</div>` : ""}
    ${
      sent
        ? `<div class="card">Sent${
            reached != null ? ` - reaches ${esc(reached)} agent${reached === 1 ? "" : "s"}` : ""
          }. They pick it up on the next check-in.</div>`
        : ""
    }
    <form method="POST" action="/admin/projects/${esc(project.id)}/messages" class="stack" style="max-width:560px">
      ${csrfField(csrf)}
      <label>To lane <span class="hint">(optional, e.g. dev)</span>
        <input type="text" name="to_lane" maxlength="64" placeholder="lane" value="${esc(draft?.toLane ?? "")}">
      </label>
      <label>To agent <span class="hint">(optional)</span>
        <select name="to_actor">
          <option value="">-</option>
          ${agentOptions}
        </select>
      </label>
      <label>Subject <span class="hint">(optional)</span>
        <input type="text" name="subject" maxlength="200" placeholder="subject" value="${esc(draft?.subject ?? "")}">
      </label>
      <label>Message <textarea name="body" rows="4" required placeholder="Your note">${esc(draft?.body ?? "")}</textarea></label>
      <div class="row-actions">
        <button type="submit" class="btn">Send</button>
        <a class="btn sm" href="/admin/projects/${esc(project.id)}">Back to board</a>
      </div>
    </form>`;
  return layout("Message", body, owner, projectCrumbs(project, "Message"), undefined, "tasks");
}

/** The project Access tab (decision 023): members (grant/rotate/revoke/lead) + targeted email invites.
 *  Request-to-join was retired by decision 038 - enrollment is create_invite -> /admin/accept only. */
export function projectAccessPage(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  participations: ParticipationRow[],
  invites: InviteRow[],
  members: ProjectMemberRow[],
  csrf: string,
  notice?: string,
): string {
  const rows = participations.length
    ? participations
        .map((p) => {
          // THREE states, not two (decision 075). "No token on this seat" stopped meaning "revoked" the day
          // one connection began reaching many projects: a second-project seat normally has no token of its
          // own and is reached by the agent's token elsewhere. Rendering that as "revoked" named an action
          // nobody took, and rendered identically to a seat nothing can reach - so the page an operator
          // checks to answer "can this agent work here?" could not tell healthy from stranded.
          const tokenPill = p.tokenActive
            ? `<span class="pill ok">active</span>`
            : p.reachable
              ? `<span class="pill ok" title="No token on this seat, and none is needed - this agent reaches it on the token it already has (decision 070).">connected</span>`
              : `<span class="pill off" title="No token on this seat and none this agent holds can reach it, so it cannot work here. Grant it again to mint one, or bind its other seat to the same human.">unreachable</span>`;
          const revoke = p.tokenActive
            ? `<form method="POST" action="/admin/participations/${esc(p.participationId)}/revoke">
                 ${csrfField(csrf)}
                 <input type="hidden" name="project_id" value="${esc(project.id)}">
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
          // Show the OWNING HUMAN as a prefix (decision 052): `human/agent`, matching the board's from/for
          // convention, so a project with agents from several humans shows who owns each. The human part is
          // muted so the agent name still reads first. Humans (rare here) render bare.
          // The lane ROUTES now (decision 065), so it needs an edit/clear path: every provisioning write uses
          // COALESCE(EXCLUDED.lane, participations.lane), which means a NULL can never clear one, and a lane
          // typo'd at provision time would otherwise be a subscription the agent cannot leave. Submitting an
          // empty value clears it. Humans hold no participation lane, so they keep the plain dash.
          const laneForm = (row: typeof p): string =>
            row.kind !== "agent"
              ? '<span class="muted">-</span>'
              : `<form method="POST" action="/admin/participations/${esc(row.participationId)}/lane" class="lane-edit">
                   ${csrfField(csrf)}
                   <input type="hidden" name="project_id" value="${esc(project.id)}">
                   <input name="lane" value="${row.lane === null ? "" : esc(row.lane)}" maxlength="64"
                          placeholder="-" aria-label="Lane for ${esc(row.participantName)}">
                   <button class="btn sm" type="submit">Set</button>
                 </form>`;
          const qualified =
            p.kind === "agent" && p.ownerHandle
              ? `<span class="owner-prefix">${esc(p.ownerHandle)}/</span>${esc(p.participantName)}`
              : esc(p.participantName);
          return `<tr>
            <td>${qualified}</td>
            <td><span class="pill">${esc(p.kind)}</span></td>
            <td>${laneForm(p)}</td>
            <td>${p.isAdmin ? '<span class="pill admin">admin (lead)</span>' : ""}</td>
            <td>${tokenPill}</td>
            <td>${esc(p.eventCount)}</td>
            <td class="row-actions">${toggle}${rotate}${revoke}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No one granted yet - use <b>+ Grant access</b>.</td></tr>`;

  const inviteRows = invites.length
    ? invites
        .map(
          (i) => `<tr>
            <td><code>${esc(i.code)}</code></td>
            <td>${i.intendedName ? esc(i.intendedName) : '<span class="muted">any name</span>'}${i.isAdmin ? ' <span class="pill admin">admin</span>' : ""}</td>
            <td>${i.lane === null ? '<span class="muted">-</span>' : esc(i.lane)}</td>
            <td>${esc(i.uses)}/${esc(i.maxUses)}</td>
            <td class="muted">${esc(i.expiresAt.slice(0, 16).replace("T", " "))}</td>
            <td class="row-actions"><form method="POST" action="/admin/invites/${esc(i.id)}/revoke">${csrfField(csrf)}<input type="hidden" name="project_id" value="${esc(project.id)}"><button type="submit" class="danger">Revoke</button></form></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">No open invites.</td></tr>`;

  const accessPrimer = `<details class="help"><summary style="cursor:pointer;font-weight:600">What do Grant, Rotate, and Revoke do?</summary>
      <ul>
        <li><b>+ Grant access</b> - let a participant in and mint their token.</li>
        <li><b>Rotate</b> - mint a fresh token and revoke the old one in a single step (no lockout gap);
            the new hand-out card is shown once. Use it when a token may have leaked.</li>
        <li><b>Revoke</b> - instantly kill that token (the agent is locked out until you grant again).
            Their past history stays.</li>
      </ul></details>`;
  const noticeHtml = notice ? `<div class="card">${esc(notice)}</div>` : "";
  const body = `
    <h1>${esc(project.name)}</h1>
    ${projectTabs(project.id, "access")}
    ${noticeHtml}

    <div class="sectionhead"><h2>People</h2></div>
    <div class="help">Everyone here reads the whole task board. An <b>admin</b> also sees the project's own
      pages - this Access tab, settings and activity. Only you, as the owner, can change these, and only you
      can grant or revoke agent tokens.</div>
    <table class="grid">
      <thead><tr><th>Person</th><th>Role</th><th class="row-actions"></th></tr></thead>
      <tbody>${
        members.length
          ? members
              .map((m) => {
                const you = m.isYou ? ' <span class="hint">(you)</span>' : "";
                // The owner row carries no control at all. Demoting it would leave a project whose owner
                // cannot administer it and no way back - refused in SQL too, not just hidden here.
                const action =
                  m.role === "owner"
                    ? '<span class="hint">Owner cannot be changed</span>'
                    : `<form method="POST" action="/admin/projects/${esc(project.id)}/member-role">${csrfField(csrf)}` +
                      `<input type="hidden" name="member_owner_id" value="${esc(m.ownerId)}">` +
                      `<input type="hidden" name="admin" value="${m.role === "admin" ? "0" : "1"}">` +
                      `<button type="submit"${m.role === "admin" ? ' class="danger"' : ""}>` +
                      `${m.role === "admin" ? "Demote to member" : "Make admin"}</button></form>`;
                return `<tr><td>${esc(m.handle)}${you}<div class="hint">${esc(m.email)}</div></td>` +
                  `<td><span class="pill${m.role === "owner" || m.role === "admin" ? " ok" : ""}">${esc(m.role)}</span></td>` +
                  `<td class="row-actions">${action}</td></tr>`;
              })
              .join("")
          : '<tr><td colspan="3" class="muted">No people yet - invite someone below.</td></tr>'
      }</tbody>
    </table>

    <div class="sectionhead"><h2>Invite a teammate</h2></div>
    <div class="help">Enter a person's email and we send the invitation - they sign in with their own
      account, join as a member, and their agent connects under their identity. No token to hand over.</div>
    <form class="stack" method="POST" action="/admin/projects/${esc(project.id)}/invite-email">
      ${csrfField(csrf)}
      <label>Email
        <input type="email" name="email" required placeholder="teammate@company.com">
      </label>
      <label>Lane <span class="hint">optional; lane mail reaches them on it until their agent registers a different one</span>
        <input name="lane" placeholder="dev">
      </label>
      <label class="inline"><input type="checkbox" name="is_admin" value="1"> Make them a project lead (admin)</label>
      <button type="submit">Send invitation</button>
    </form>

    <div class="sectionhead"><h2>Participants in this project</h2>
      <a class="btn sm" href="/admin/projects/${esc(project.id)}/grant">+ Grant access</a></div>
    ${accessPrimer}
    <table>
      <thead><tr><th>Participant</th><th>Kind</th><th>Lane</th><th>Role</th>
        <th>Token</th><th>Events</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="sectionhead"><h2>Legacy invite codes</h2></div>
    <div class="help">Open paste-a-code invites are retired (decision 038). Any codes here are legacy and
      revoke-only - new teammates join via <b>Invite a teammate</b> above.</div>
    <table>
      <thead><tr><th>Code</th><th>For</th><th>Lane</th><th>Uses</th><th>Expires</th><th></th></tr></thead>
      <tbody>${inviteRows}</tbody>
    </table>`;
  return layout(project.name, body, owner, projectCrumbs(project, "Access"), undefined, "projects");
}

// Public request-to-join pages (requestPublicPage / requestSentPage / requestClaimedPage) were removed
// by decision 038: enrollment is targeted-invite-only, so /p/:handle/:slug now 410s (see http.ts).

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
           <span class="hint">The lane they work in (e.g. <code>backend</code>, <code>marketing</code>). It ROUTES: lane
             handoffs reach them on it straight away. If the agent later registers a different lane, that one replaces this.</span>
         </label>
         <label class="inline"><input type="checkbox" name="is_admin" value="1"> Project admin (lead)</label>
         <span class="hint">Leave off for normal agents. <b>On</b> = a lead agent: it can onboard teammates itself from inside
           the project (gets <code>admin_provision</code> + <code>create_invite</code>). Every agent in a project can already
           read the roster (<code>list_participants</code>), which lists its agents and human members. Use one lead per project.</span>
         <button type="submit">Grant + mint token</button>
       </form>`
    : `<p class="muted">No participants yet. <a href="/admin/participants/new">Create one first.</a></p>`;

  const body = `
    <h1>Grant access</h1>
    <p class="lead">Project <strong>${esc(project.name)}</strong></p>
    <div class="help">
      Granting lets a participant into this project and <b>mints their access token</b> - the secret the
      agent uses to connect. You'll see the token <b>once</b> on the next screen, so have somewhere to paste it.
    </div>
    ${formOrEmpty}
    <a class="back" href="/admin/projects/${esc(project.id)}">← Cancel</a>`;
  return layout("Grant access", body, owner, [
    { label: "Projects", href: "/admin" },
    { label: project.name, href: `/admin/projects/${project.id}` },
    { label: "Grant access" },
  ]);
}

/**
 * Shown after granting an ALREADY-CONNECTED agent access to another project (decision 070). There is no
 * token here on purpose: one token reaches every project its identity belongs to, so this grant is a
 * share, not a re-issue, and there is nothing for the operator to install or hand over.
 */
export function addedToProjectCard(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  participantName: string,
  isAdmin: boolean,
  lane: string | null,
): string {
  const actor = `${owner.username}/${participantName}`;
  const body = `
    <h1>Added to ${esc(project.name)}${isAdmin ? " - admin (lead)" : ""}</h1>
    <p class="lead"><strong>${esc(actor)}</strong> &rarr; <strong>${esc(project.name)}</strong></p>

    <div class="card">
      <p><strong>Nothing to install.</strong> ${esc(participantName)} is already connected to the bus, and one
      connection reaches every project it belongs to. It can work here on the token it already has - no new
      token, no config change, no reconnect.</p>
      <p class="muted">Next time it checks in, ${esc(project.name)} appears in its <code>list_projects</code>,
      and it works here by passing <code>project:"${esc(project.slug)}"</code> on any call.
      ${lane ? `Its lane here is <code>${esc(lane)}</code>.` : "It has no lane here yet."}</p>
    </div>

    <p><a class="btn" href="/admin/projects/${esc(project.id)}/access">Back to access</a>
       <a class="btn ghost" href="/admin/projects/${esc(project.id)}">Open the board</a></p>
  `;
  return layout("Added to project", body, owner, projectCrumbs(project, "Access"), undefined, "projects");
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
  const actor = `${owner.username}/${participantName}`; // the qualified bus identity (decision 018)
  const prompt = buildHandoutPrompt(project.name, actor, plaintextToken, mcpUrl, isAdmin);

  const body = `
    <h1>Access granted${isAdmin ? " - admin (lead)" : ""}</h1>
    <p class="lead"><strong>${esc(actor)}</strong> &rarr; <strong>${esc(project.name)}</strong></p>

    <div class="card warn">
      <strong>The token below is shown once and can't be recovered.</strong>
      It's embedded in the block - store that somewhere safe. Lost it? Revoke and grant again for a new one.
    </div>

    <div class="help">
      <b>Copy everything below and give it to ${esc(participantName)}'s agent</b> - paste it into a session,
      drop it in their repo, or send it over. It offers two ways to connect - a no-command-line
      <code>.mcp.json</code> (works in the Claude desktop app, VS Code, and the CLI) and a one-command
      <code>claude mcp add</code> for CLI users - then verify/restart/whoami${isAdmin ? ", the admin (lead) powers (how to invite/provision teammates)," : ""} and the coordination
      protocol. No setup on your end, nothing to look up.
    </div>

    <div class="card">
      <h2>Onboarding - copy &amp; send</h2>
      ${codeblock("copytext", prompt)}
    </div>

    <a class="back" href="/admin/projects/${esc(project.id)}">← Back to project</a>`;
  return layout("Access granted", body, owner, [
    { label: "Projects", href: "/admin" },
    { label: project.name, href: `/admin/projects/${project.id}` },
    { label: "Access granted" },
  ]);
}

export function projectSettingsPage(
  owner: Owner,
  project: { id: number; slug: string; name: string },
  csrf: string,
  error?: string,
): string {
  const err = error ? `<div class="card warn">${esc(error)}</div>` : "";
  const body = `
    <h1>${esc(project.name)}</h1>
    ${projectTabs(project.id, "settings")}
    ${err}
    <div class="sectionhead"><h2>Rename</h2></div>
    <div class="help">Rename is cosmetic + safe - agents connect with their token, not the slug, so changing the slug won't break anyone.</div>
    <form class="stack" method="POST" action="/admin/projects/${esc(project.id)}/rename">
      ${csrfField(csrf)}
      <label>Name<input name="name" required value="${esc(project.name)}"></label>
      <label>Slug
        <input name="slug" required pattern="[a-z0-9\\-]+" value="${esc(project.slug)}">
        <span class="hint">Lowercase letters, numbers, dashes.</span>
      </label>
      <button type="submit">Save changes</button>
    </form>

    <div class="sectionhead"><h2>Danger zone</h2></div>
    <div class="card warn">
      <strong>Delete this project.</strong> Permanently removes the project and <b>all</b> of its
      coordination data - ID counters, presence, messages, leases, tasks and the full event history -
      plus every participant's access to it. This cannot be undone.
    </div>
    <form method="POST" action="/admin/projects/${esc(project.id)}/delete">
      ${csrfField(csrf)}
      <button type="submit" class="danger">Delete project permanently</button>
    </form>`;
  return layout("Project settings", body, owner, projectCrumbs(project, "Settings"), undefined, "projects");
}

export function editParticipantPage(
  owner: Owner,
  participant: { id: number; name: string; kind: "agent" | "human" },
  grants: ParticipantGrantRow[],
  csrf: string,
  error?: string,
  /** Other participants of this owner, offered as somewhere to hand the open work (decision 069). */
  successors: { id: number; name: string }[] = [],
  /** How many non-terminal tasks this agent is currently holding, so the choice is informed. */
  openTaskCount = 0,
): string {
  const err = error ? `<div class="card warn">${esc(error)}</div>` : "";
  const grantList = grants.length
    ? `<ul>${grants
        .map(
          (g) =>
            `<li><a href="/admin/projects/${esc(g.projectId)}">${esc(g.projectName)}</a>` +
            `${g.lane ? ` · <span class="muted">${esc(g.lane)}</span>` : ""} · ` +
            // Three states, not two - the same rule as the Access page (decision 075). A second-project seat
            // normally has NO token of its own and is reached on the agent's token elsewhere; labelling that
            // "revoked" named an action nobody took. Left standing here when 075 fixed the sibling page.
            `${
              g.tokenActive
                ? '<span class="pill ok">token active</span>'
                : g.reachable
                  ? '<span class="pill ok" title="No token on this seat, and none is needed - this agent reaches it on the token it already has (decision 070).">connected</span>'
                  : '<span class="pill off" title="No token on this seat and none this agent holds can reach it, so it cannot work here.">unreachable</span>'
            }</li>`,
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
      <strong>Delete this participant.</strong> Removes them from ${scope} and invalidates their
      token(s) immediately. Their past entries in the ledger are kept (under the name they used).
      This cannot be undone.
    </div>
    <form class="stack" method="POST" action="/admin/participants/${esc(participant.id)}/delete">
      ${csrfField(csrf)}
      ${
        openTaskCount > 0
          ? `<label>Hand over their open work
               <span class="hint">${esc(openTaskCount)} unfinished task${openTaskCount === 1 ? "" : "s"}.
                 Deleting never cancels work - it either moves to whoever you pick, or goes back on the
                 board as unassigned for anyone to grab.</span>
               <select name="reassign_to">
                 <option value="">Put it back on the board (unassigned)</option>
                 ${successors
                   .map((sx) => `<option value="${esc(sx.id)}">Give it to ${esc(sx.name)}</option>`)
                   .join("")}
               </select>
               ${
                 successors.length === 0
                   ? `<span class="hint">No one else to hand it to yet - it will go back on the board.</span>`
                   : `<span class="hint">Only work in projects the new owner is also in can move to them;
                        anything else goes back on the board.</span>`
               }
             </label>`
          : `<p class="muted">No unfinished tasks to hand over.</p>`
      }
      <button type="submit" class="danger">Delete participant permanently</button>
    </form>
    <a class="back" href="/admin/participants">← Cancel</a>`;
  return layout("Edit participant", body, owner, [
    { label: "Projects", href: "/admin" },
    { label: participant.name },
  ]);
}
