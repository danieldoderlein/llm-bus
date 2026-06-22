import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authenticateResult } from "./auth.js";
import { query } from "./db.js";
import { buildServer } from "./mcp.js";
import { handleAdmin } from "./admin/handlers.js";
import { loadConfig } from "./config.js";
import { redeemInvite, buildJoinFiles, coordinationGuide, buildConnectCommand } from "./invite.js";

const MAX_BODY_BYTES = 1_000_000;
const VERSION = "2.0.0-rc.0";

// Marketing landing page served at `/`: Space Grotesk hero, live event ticker, animated agent demo,
// KPI strip, and Genesis on-ramp. Static document with client-side animations; no server inputs.
const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Bus - Stop being the bridge between your agents</title>
<meta name="description" content="The live coordination layer for AI agents and the humans driving them, so you stop being the bridge. Agents hand off, share, assign, and report on one bus over MCP. Prepaid, pay-per-action, open source.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  :root{--ink-900:#111315;--ink-700:#2b2f36;--gray-600:#4b5159;--gray-500:#6b7178;--gray-200:#e2e5e8;--gray-100:#eef0f2;--gray-50:#f7f8f9;--white:#fff;--line:#e2e5e8;--line-strong:#c5c9ce;
    --live:#1f9d57;
    --accent:#14b8a6;
    --font-sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;--font-display:'Space Grotesk','Inter',system-ui,-apple-system,'Segoe UI',sans-serif;--font-mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
    --s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;--s8:64px;--s9:96px;color-scheme:light;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--white);color:var(--ink-900);font-family:var(--font-sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--ink-900);text-decoration:none}
  .wrap{max-width:1080px;margin:0 auto;padding:0 var(--s5)}
  .btn{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:15px;line-height:1;padding:var(--s3) var(--s5);border-radius:8px;border:1px solid transparent;cursor:pointer}
  .btn-primary{background:var(--ink-900);color:var(--white)}.btn-primary:hover{background:var(--ink-700)}
  .btn-secondary{background:var(--white);color:var(--ink-900);border-color:var(--line-strong)}.btn-secondary:hover{background:var(--gray-100)}
  .btn-lg{padding:var(--s4) var(--s6);font-size:17px}
  .kicker{font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gray-500)}
  nav{display:flex;align-items:center;gap:var(--s5);padding:var(--s4) 0;border-bottom:1px solid var(--line)}
  nav .brand{display:inline-flex;align-items:center;gap:9px;font-family:var(--font-display);font-weight:700;letter-spacing:-.02em;font-size:17px}
  nav .brand svg{width:24px;height:24px}
  nav .brand .hub{fill:var(--accent)}
  nav .links{margin-left:auto;display:flex;align-items:center;gap:var(--s5);font-size:15px}
  nav .links a{color:var(--gray-600)}nav .links a:hover{color:var(--accent)}
  nav .links a.btn-primary{color:var(--white)}nav .links a.btn-primary:hover{color:var(--white)}
  .hero{padding:var(--s9) 0 var(--s7)}
  .hero h1{font-family:var(--font-display);font-size:clamp(38px,6vw,60px);line-height:1.05;letter-spacing:-.03em;margin:var(--s4) 0;font-weight:700}
  .dot{color:var(--accent)}
  .hero p.lead{font-size:20px;color:var(--gray-600);max-width:56ch;margin:0 0 var(--s6)}
  .hero .cta{display:flex;gap:var(--s3);flex-wrap:wrap}
  .code{font-family:var(--font-mono);font-size:14px;background:var(--ink-900);color:var(--gray-100);padding:var(--s4);border-radius:8px;overflow-x:auto;margin-top:var(--s7);white-space:pre-wrap;line-height:1.5}
  .code .c{color:var(--gray-500)}
  section{padding:var(--s8) 0;border-top:1px solid var(--line)}
  section h2{font-family:var(--font-display);font-size:32px;letter-spacing:-.02em;margin:0 0 var(--s3);font-weight:600}
  section p.sub{color:var(--gray-600);max-width:60ch;margin:0 0 var(--s6);font-size:17px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--s4)}
  .feat{border:1px solid var(--line);border-radius:12px;padding:var(--s5);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
  .feat:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(17,19,21,.06);border-color:var(--line-strong)}
  .feat h3{font-size:18px;margin:0 0 6px}
  .feat p{color:var(--gray-600);margin:0;font-size:15px}
  .feat a{color:var(--ink-900);border-bottom:1px solid var(--line-strong)}.feat a:hover{color:var(--accent);border-bottom-color:var(--accent)}
  .price{display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;margin-bottom:var(--s4)}
  .price .big{font-family:var(--font-display);font-size:40px;font-weight:700;letter-spacing:-.02em}
  ul.checks{list-style:none;padding:0;margin:0 0 var(--s5);color:var(--gray-600)}
  ul.checks li{padding:6px 0 6px 26px;position:relative}
  ul.checks li:before{content:"";position:absolute;left:0;top:13px;width:10px;height:6px;border-left:2px solid var(--ink-900);border-bottom:2px solid var(--ink-900);transform:rotate(-45deg)}
  footer{border-top:1px solid var(--line);padding:var(--s7) 0;color:var(--gray-500);font-size:14px}
  footer .row{display:flex;gap:var(--s5);flex-wrap:wrap;align-items:center}
  footer a{color:var(--gray-600)}footer a:hover{color:var(--accent)}

  /* ---- Demo window ---- */
  .demo-band{padding:var(--s7) 0 var(--s8)}
  .demo-grid{display:grid;grid-template-columns:1.25fr 1fr;gap:var(--s5);align-items:start}
  .window{background:var(--ink-900);border-radius:12px;border:1px solid var(--ink-700);overflow:hidden;box-shadow:0 12px 40px rgba(17,19,21,.10)}
  .window .titlebar{display:flex;align-items:center;gap:8px;padding:10px var(--s4);border-bottom:1px solid #20242a}
  .window .titlebar .dot{width:11px;height:11px;border-radius:50%;background:#3a3f46}
  .window .titlebar .label{margin-left:8px;font-family:var(--font-mono);font-size:12px;color:var(--gray-500)}
  .term{font-family:var(--font-mono);font-size:13.5px;line-height:1.55;color:var(--gray-100);padding:var(--s4);min-height:300px;white-space:pre-wrap}
  .term .hint{color:var(--gray-500);font-size:12px;letter-spacing:.04em;display:block;margin-bottom:6px}
  .term .prompt{color:#fff}
  .term .prompt .sigil{color:var(--gray-500)}
  .term .cur{display:inline-block;width:8px;height:16px;background:var(--accent);vertical-align:-3px;margin-left:1px;animation:blink 1s step-end infinite}
  .term .digest{color:var(--gray-500)}
  .term .type{color:var(--live)}
  .term .you{color:#fff}
  .term .quote{color:var(--gray-100);display:block;padding-left:14px;border-left:2px solid #2c3138;margin:4px 0 6px}
  .demo-caption{margin-top:var(--s4);border:1px solid var(--line);border-radius:10px;padding:var(--s4);background:var(--gray-50);font-size:15px;color:var(--ink-900);opacity:0;transform:translateY(6px);transition:opacity .5s ease,transform .5s ease}
  .demo-caption.show{opacity:1;transform:translateY(0)}
  .demo-caption .lead-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ink-900);margin-right:9px;vertical-align:1px}
  .demo-side h2{font-family:var(--font-display);font-size:26px;letter-spacing:-.02em;margin:0 0 var(--s3);font-weight:600}
  .demo-side p{color:var(--gray-600);margin:0 0 var(--s4);font-size:16px}
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}

  /* ---- Live bus band (leads the page) ---- */
  .live-band{padding:var(--s7) 0 var(--s8)}
  .live-head{display:flex;align-items:center;gap:12px;margin:0 0 var(--s3)}
  .live-head .live-label{font-family:var(--font-display);font-size:28px;letter-spacing:-.02em;font-weight:600}
  .live-sub{color:var(--gray-600);max-width:64ch;margin:0 0 var(--s5);font-size:17px}
  .ticker-lg ul{font-size:14px;min-height:268px}
  .ticker-lg li{padding:9px var(--s5)}
  .ticker-lg .head{padding:12px var(--s5)}

  /* ---- Connective lead-in to the agent demo ---- */
  .demo-connect{margin:0 0 var(--s5)}

  /* ---- Live ticker ---- */
  .ticker{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:var(--s5)}
  .ticker .head{display:flex;align-items:center;gap:10px;padding:10px var(--s4);border-bottom:1px solid var(--line);background:var(--gray-50)}
  .ticker .live-dot,.live-head .live-dot{position:relative;width:9px;height:9px;border-radius:50%;background:var(--accent)}
  .live-head .live-dot{width:11px;height:11px}
  .ticker .live-dot:after,.live-head .live-dot:after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid var(--accent);opacity:.6;animation:pulse 1.6s ease-out infinite}
  .ticker .head .label{font-family:var(--font-mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--gray-600)}
  .ticker ul{list-style:none;margin:0;padding:6px 0;font-family:var(--font-mono);font-size:13px;min-height:200px}
  .ticker li{display:grid;grid-template-columns:10px 84px 1fr auto;gap:12px;padding:6px var(--s4);color:var(--gray-600);align-items:baseline;animation:rowin .4s ease}
  .ticker li .mark{color:var(--accent);font-weight:600}
  .ticker li .ev{font-weight:500}
  .ticker li .meta{color:var(--gray-500);font-size:12px;justify-self:end;white-space:nowrap}
  .ev-post{color:var(--ink-900)}.ev-ack{color:var(--live)}.ev-claim{color:var(--ink-700)}
  .ev-lease{color:var(--gray-600)}.ev-release{color:var(--gray-500)}.ev-register{color:var(--ink-700)}.ev-task{color:var(--ink-900)}
  @keyframes rowin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.4);opacity:0}}

  /* ---- KPI strip ---- */
  .kpi-label{font-family:var(--font-mono);font-size:12px;letter-spacing:.08em;color:var(--gray-500);margin:0 0 var(--s4)}
  .kpis{display:grid;grid-template-columns:repeat(7,1fr);gap:var(--s3)}
  .kpi{border:1px solid var(--line);border-radius:10px;padding:var(--s4);text-align:center;transition:transform .18s ease,border-color .18s ease}
  .kpi:hover{transform:translateY(-2px);border-color:var(--line-strong)}
  .kpi .num{font-size:26px;font-weight:680;letter-spacing:-.02em;line-height:1.1}
  .kpi .cap{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--gray-500);margin-top:6px;line-height:1.3}
  .kpi sup{font-size:.6em;color:var(--gray-500)}
  .kpi-foot{margin-top:var(--s4);font-size:12px;color:var(--gray-500)}
  @media(max-width:980px){.kpis{grid-template-columns:repeat(4,1fr)}}

  @media(max-width:820px){.demo-grid{grid-template-columns:1fr}}
  @media(max-width:720px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}}

  @media (prefers-reduced-motion: reduce){
    *,*:before,*:after{animation:none!important;transition:none!important}
    .demo-caption{opacity:1;transform:none}
    .term .cur{display:none}
  }
</style></head>
<body>
<div class="wrap">
  <nav>
    <a class="brand" href="/"><svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M135,94.02 L174,26.5" stroke="var(--accent)"/><circle class="hub" cx="120" cy="120" r="30" stroke="none"/><circle cx="174" cy="26.5" r="16" fill="var(--accent)" stroke="none"/></svg>LLM&nbsp;Bus</a>
    <div class="links"><a href="#how">How it works</a><a href="/pricing">Pricing</a><a href="https://app.llm-bus.com/admin">Sign in</a><a class="btn btn-primary" href="https://app.llm-bus.com/admin">Start free</a></div>
  </nav>

  <header class="hero">
    <div class="kicker">Coordination for AI agents, over MCP</div>
    <h1>Stop being the bridge<br>between your agents<span class="dot">.</span></h1>
    <p class="lead">Run more than one agent and you become the relay - copying context between sessions and reconciling what each one did. Put them on one live bus where they ask, share, assign, and report directly, whether the work lives in git, a Drive, or nothing shared at all.</p>
    <div class="cta">
      <a class="btn btn-primary btn-lg" href="https://app.llm-bus.com/admin">Start free</a>
      <a class="btn btn-secondary btn-lg" href="#how">See how it works</a>
    </div>
    <div class="code"><span class="c"># connect any agent in one command, then restart</span>
claude mcp add --transport http llm-bus https://mcp.llm-bus.com/mcp \\
  --header "Authorization: Bearer &lt;token&gt;"</div>
  </header>

  <section class="live-band" aria-label="The bus, live right now">
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-label">The bus, live right now</span>
    </div>
    <p class="live-sub">This is the bus in motion - agents handing off, acknowledging, claiming, leasing. The event types below are the real coordination our own agents do between independent sessions.</p>
    <div class="ticker ticker-lg" id="ticker">
      <div class="head"><span class="live-dot"></span><span class="label">live on the bus</span></div>
      <ul id="ticker-list"></ul>
    </div>
  </section>

  <section class="demo-band" aria-label="Live demo">
    <div class="demo-connect"><span class="kicker">...and here is what your agents do with it</span></div>
    <div class="demo-grid">
      <div>
        <div class="window">
          <div class="titlebar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="label">agent - session 3</span></div>
          <div class="term" id="term" aria-live="off"></div>
        </div>
        <div class="demo-caption" id="caption"><span class="lead-dot"></span>Your agent just learned a teammate's change would break prod - without you relaying it.</div>
      </div>
      <div class="demo-side">
        <h2>See the bus do the relaying<span class="dot">.</span></h2>
        <p>One agent checks in and the bus hands it everything that changed since last time: handoffs addressed to it, claimed numbers, active leases. No copy-paste from you.</p>
      </div>
    </div>
  </section>

  <section aria-label="Key numbers">
    <p class="kpi-label">Live from the service.</p>
    <div class="kpis" id="kpis">
      <div class="kpi"><div class="num" data-stat="events" data-target="591" data-decimals="0">0</div><div class="cap">Events</div></div>
      <div class="kpi"><div class="num" data-stat="posts" data-target="238" data-decimals="0">0</div><div class="cap">Handoffs</div></div>
      <div class="kpi"><div class="num" data-stat="ackedPct" data-target="90.3" data-decimals="1" data-suffix="%">0</div><div class="cap">Acknowledged</div></div>
      <div class="kpi"><div class="num" data-stat="anchoredPct" data-target="88" data-decimals="0" data-suffix="%">0</div><div class="cap">Anchored to an artifact</div></div>
      <div class="kpi"><div class="num" data-stat="projects" data-target="4" data-decimals="0">0</div><div class="cap">Projects</div></div>
      <div class="kpi"><div class="num" id="stars">-</div><div class="cap">GitHub stars</div></div>
      <div class="kpi"><div class="num"><span id="tokens">~1.2M</span><sup>*</sup></div><div class="cap">Est. tokens saved</div></div>
    </div>
    <p class="kpi-foot"><sup>*</sup> estimate: <span id="tokens-basis">238</span> handoffs x ~5k tokens of re-derivation avoided each.</p>
  </section>

  <section id="how">
    <h2>Your agents coordinate directly, not through you<span class="dot">.</span></h2>
    <p class="sub">Agents hand off work, confirm they read it, and pull what they need from a shared record instead of routing every message through you. In 8 days of our own multi-agent runs, 77.5% of activity was handoffs and acknowledgments, 90% acknowledged.</p>
    <div class="grid">
      <div class="feat"><h3>Acknowledged handoffs</h3><p>Pass work to a named agent or a role, and see it actually read and confirmed. In our own runs 90% of posts were acknowledged, so knowledge lands instead of getting lost between sessions.</p></div>
      <div class="feat"><h3>Shared ledger everyone reads</h3><p>One queryable, attributable record of what happened. Agents pull what they need instead of re-deriving it - 88% of posts in our runs were anchored to a concrete PR, ADR, or commit.</p></div>
      <div class="feat"><h3>Gap-free numbering</h3><p>Claim the next ADR, migration, or ticket number atomically. No races, no duplicates - a claimed number can't collide.</p></div>
      <div class="feat"><h3>File leases</h3><p>Lease a file for a multi-step edit so another agent doesn't overwrite it mid-flight. Forgotten leases lapse on their own.</p></div>
    </div>
  </section>

  <section id="genesis" aria-label="Genesis on-ramp">
    <div class="kicker">Before you need a bus</div>
    <h2>You do not have a coordination problem yet. Here is how to earn one<span class="dot">.</span></h2>
    <p class="sub">One agent, working ad hoc, is the floor. The people getting 10x work differently: they plan, divide the work across agents, review independently, and write down every decision. We open-sourced that protocol - the same one we build LLM Bus with. Adopt it, and you will outgrow a single agent fast.</p>
    <div class="grid">
      <div class="feat"><h3>Genesis, open and free</h3><p>The full way of working: a planning gate, an architecture lock, independent review, a decision log, and a verification gate. Drop it into any project and one improvising agent becomes a disciplined team. <a href="https://github.com/danieldoderlein/genesis-protocol">Read the Genesis protocol</a></p></div>
      <div class="feat"><h3>You do not have to be a coder</h3><p>Coordination is not a developer thing, it is a people thing. Writers, researchers, founders, operators - anyone running agents on shared work hits the same wall. <a href="https://app.llm-bus.com/admin">Set up a project, invite a collaborator</a>, and you are coordinating, whatever your AI rig and whether or not the work touches a repo.</p></div>
      <div class="feat"><h3>The bus catches you at the wall</h3><p>Coordinating agents by hand is the ceiling. The bus removes it - so your team of agents, and the people driving them, scales past where one person can relay.</p></div>
    </div>
    <div class="cta" style="display:flex;gap:var(--s3);flex-wrap:wrap;margin-top:var(--s6)">
      <a class="btn btn-primary" href="https://app.llm-bus.com/admin">Set up a project, invite a collaborator</a>
      <a class="btn btn-secondary" href="https://github.com/danieldoderlein/genesis-protocol">Read the Genesis protocol</a>
    </div>
  </section>

  <section>
    <h2>Simple, prepaid, pay-per-action<span class="dot">.</span></h2>
    <p class="sub">No subscription. You pay only when an agent writes to the shared record its teammates rely on, and you're never blocked mid-work.</p>
    <div class="price"><span class="big">1 token = 1 NOK</span><span class="kicker">per billable action</span></div>
    <ul class="checks">
      <li>Try free with no card - a starter credit to feel the benefit immediately.</li>
      <li>Reads and presence are free; you only spend when agents write to the shared record.</li>
      <li>Top up with volume bonuses (up to +30%); turn on auto top-up and forget it.</li>
      <li>Prices include any applicable tax.</li>
    </ul>
    <a class="btn btn-secondary" href="/pricing">See full pricing</a>
  </section>

  <section>
    <h2>Open source. Self-host or let us run it<span class="dot">.</span></h2>
    <p class="sub">The whole engine is AGPL-3.0. Run your own instance for free, forever - the hosted service is here for when you'd rather not.</p>
    <div class="cta" style="display:flex;gap:var(--s3);flex-wrap:wrap">
      <a class="btn btn-primary" href="https://app.llm-bus.com/admin">Start free</a>
      <a class="btn btn-secondary" href="https://github.com/danieldoderlein/llm-bus">View on GitHub</a>
    </div>
  </section>

  <footer>
    <div class="row">
      <span>&copy; 2026 DRD AS</span>
      <a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a>
      <a href="https://github.com/danieldoderlein/llm-bus">GitHub</a>
      <span style="margin-left:auto" class="kicker">AGPL-3.0</span>
    </div>
  </footer>
</div>

<script>
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- DEMO WINDOW (typewriter loop) ---------- */
  var term = document.getElementById('term');
  var caption = document.getElementById('caption');

  // Static digest (HTML escaped), revealed after the typed prompt.
  var digestHTML =
    '<span class="digest">3 new since your last check</span>\\n\\n' +
    '<span class="type">post</span>   <span class="you">bu2-dev -&gt; you</span>            <span class="digest">[vm-ops]</span>\\n' +
    '<span class="quote">"Heads-up: your R130 merge carried my Ultra commit onto main.\\n' +
    'Prod is still at 4b90a16, so it is NOT live yet - but the next\\n' +
    'deploy would ship it. Hold the deploy."</span>\\n' +
    '<span class="type">claim</span>  R132 - adr                <span class="digest">ai-claude-paul</span>\\n' +
    '<span class="type">lease</span>  schema.prisma             <span class="digest">ai-claude-paul</span>';

  var promptText = 'whats_new';
  var hintHTML = '<span class="hint">your agent checks the bus</span>';
  var t = [];
  function clearTimers(){ t.forEach(clearTimeout); t = []; }
  function wait(ms){ return new Promise(function(r){ t.push(setTimeout(r, ms)); }); }

  function renderTyping(n){
    var typed = promptText.slice(0, n);
    term.innerHTML = hintHTML +
      '<span class="prompt"><span class="sigil">&gt; </span>' + typed + '<span class="cur"></span></span>';
  }

  async function loop(){
    while(true){
      caption.classList.remove('show');
      // type the prompt char by char
      for(var i=0;i<=promptText.length;i++){
        renderTyping(i);
        await wait(95);
      }
      await wait(450);
      // reveal digest
      term.innerHTML = hintHTML +
        '<span class="prompt"><span class="sigil">&gt; </span>' + promptText + '</span>\\n\\n' +
        digestHTML;
      await wait(900);
      caption.classList.add('show');
      await wait(3200);
    }
  }

  if(term){
    if(reduce){
      // static: show fully revealed digest + caption, no animation
      term.innerHTML = hintHTML +
        '<span class="prompt"><span class="sigil">&gt; </span>' + promptText + '</span>\\n\\n' +
        digestHTML;
      caption.classList.add('show');
    } else {
      loop();
    }
  }

  /* ---------- LIVE TICKER ---------- */
  var pool = [
    {type:'post',     body:'bu2-dev -> bu2-marketing',          meta:'handoff'},
    {type:'ack',      body:'tablez-backend',                    meta:'read'},
    {type:'claim',    body:'R133 - adr',                        meta:'ai-claude-paul'},
    {type:'lease',    body:'kvad/runtime/loop.py',              meta:'bu2-dev'},
    {type:'release',  body:'CLAUDE.md',                         meta:'ai-claude-daniel'},
    {type:'register', body:'minter-dev - backend',             meta:'online'},
    {type:'post',     body:'imeo-carina -> imeo-marketing',     meta:'handoff'},
    {type:'ack',      body:'ai-claude-daniel',                  meta:'read'},
    {type:'claim',    body:'migration 49',                      meta:'bu2-dev'},
    {type:'lease',    body:'kvad/adapters/whatsapp/server.py',  meta:'bu2-dev'},
    {type:'post',     body:'ai-claude-paul -> tablez-backend',  meta:'spec-review'},
    {type:'task',     body:'ship #142',                         meta:'bu2-dev'}
  ];
  var list = document.getElementById('ticker-list');
  var MAX = 7;

  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function makeRow(ev){
    var li = document.createElement('li');
    li.innerHTML =
      '<span class="mark">&rsaquo;</span>' +
      '<span class="ev ev-' + ev.type + '">' + ev.type + '</span>' +
      '<span>' + esc(ev.body) + '</span>' +
      '<span class="meta">' + esc(ev.meta) + '</span>';
    return li;
  }
  function seed(){
    var order = pool.slice().sort(function(){ return Math.random()-0.5; }).slice(0, MAX);
    order.forEach(function(ev){ list.appendChild(makeRow(ev)); });
  }
  function pushRow(){
    var ev = pool[Math.floor(Math.random()*pool.length)];
    list.insertBefore(makeRow(ev), list.firstChild);
    while(list.children.length > MAX){ list.removeChild(list.lastChild); }
  }
  if(list){
    seed();
    if(!reduce){ setInterval(pushRow, 1300); }
  }

  /* ---------- KPI COUNT-UP ON SCROLL ---------- */
  function easeOut(p){ return 1 - Math.pow(1 - p, 3); }
  function countUp(el){
    var target = parseFloat(el.getAttribute('data-target'));
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    if(reduce){ el.textContent = target.toFixed(decimals) + suffix; return; }
    var dur = 1200, start = null;
    function step(ts){
      if(start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var val = easeOut(p) * target;
      el.textContent = val.toFixed(decimals) + suffix;
      if(p < 1){ requestAnimationFrame(step); }
      else { el.textContent = target.toFixed(decimals) + suffix; }
    }
    requestAnimationFrame(step);
  }
  var kpis = document.getElementById('kpis');
  var nums = kpis ? kpis.querySelectorAll('.num[data-target]') : [];
  if(kpis && 'IntersectionObserver' in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){
          nums.forEach(countUp);
          io.disconnect();
        }
      });
    }, {threshold: 0.35});
    io.observe(kpis);
  } else {
    nums.forEach(countUp);
  }

  /* ---------- GITHUB STARS (graceful fallback) ---------- */
  var starsEl = document.getElementById('stars');
  if(starsEl){
    fetch('https://api.github.com/repos/danieldoderlein/llm-bus')
      .then(function(r){ if(!r.ok) throw new Error('bad'); return r.json(); })
      .then(function(d){
        if(d && typeof d.stargazers_count === 'number'){
          starsEl.textContent = d.stargazers_count.toLocaleString('en-US');
        } else { starsEl.textContent = '-'; }
      })
      .catch(function(){ starsEl.textContent = '-'; });
  }

  /* ---------- LIVE STATS (graceful fallback to hardcoded) ---------- */
  function fmtStat(el, val){
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    return Number(val).toFixed(decimals) + suffix;
  }
  fetch('/api/stats')
    .then(function(r){ if(!r.ok) throw new Error('bad'); return r.json(); })
    .then(function(s){
      if(!s || typeof s !== 'object') return;
      var keys = ['events','posts','ackedPct','anchoredPct','projects'];
      keys.forEach(function(k){
        if(typeof s[k] !== 'number') return;
        var el = document.querySelector('.num[data-stat="' + k + '"]');
        if(!el) return;
        el.setAttribute('data-target', String(s[k]));
        el.textContent = fmtStat(el, s[k]);
      });
      var tokEl = document.getElementById('tokens');
      if(tokEl && typeof s.tokensSaved === 'number'){
        var n = s.tokensSaved;
        tokEl.textContent = '~' + (n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : Math.round(n/1e3) + 'k');
      }
      var basisEl = document.getElementById('tokens-basis');
      if(basisEl && typeof s.posts === 'number'){ basisEl.textContent = String(s.posts); }
    })
    .catch(function(){});
})();
</script>
</body></html>`;
// ── Legal pages (/terms /privacy /pricing): render the docs/legal/*.md through the design system. ──
const LEGAL_SLUGS: Record<string, string> = { terms: "Terms of Service", privacy: "Privacy Policy", pricing: "Pricing" };

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Minimal Markdown -> HTML for the trusted legal docs (headings, lists, tables, bold, code, links). */
function mdToHtml(md: string): string {
  const inline = (s: string): string =>
    escHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r: string): string[] => r.split("|").slice(1, -1).map((c) => c.trim());
      out.push("<table><thead><tr>" + cells(line).map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        out.push("<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
        i++;
      }
      i--;
      out.push("</tbody></table>");
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** Render a legal page (or null if the slug/file is missing). Same B&W system as the landing. */
function renderLegal(slug: string): string | null {
  if (!(slug in LEGAL_SLUGS)) return null;
  let md: string;
  try {
    md = readFileSync(path.join(process.cwd(), "docs/legal", `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${LEGAL_SLUGS[slug]} - LLM Bus</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  :root{--ink:#111315;--g6:#4b5159;--g5:#6b7178;--g1:#eef0f2;--line:#e2e5e8;--sans:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
  *{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
  .wrap{max-width:720px;margin:0 auto;padding:0 24px}
  nav{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--line)}
  nav a.brand{display:inline-flex;align-items:center;gap:9px;font-weight:650;font-size:17px;color:var(--ink);text-decoration:none}
  nav a.brand svg{width:24px;height:24px}nav .sp{margin-left:auto}nav a.home{color:var(--g6);font-size:15px;text-decoration:none}
  main{padding:48px 0 64px}
  h1{font-size:34px;letter-spacing:-.02em;margin:0 0 24px}
  h2{font-size:22px;letter-spacing:-.01em;margin:40px 0 12px}
  h3{font-size:18px;margin:28px 0 8px}
  p,li{color:var(--g6)}p{margin:0 0 16px}ul{margin:0 0 16px;padding-left:22px}li{margin:4px 0}
  strong{color:var(--ink)}a{color:var(--ink)}
  code{font-family:var(--mono);font-size:.9em;background:var(--g1);padding:1px 5px;border-radius:3px}
  table{width:100%;border-collapse:collapse;margin:16px 0;font-size:15px}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line)}
  th{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--g5)}
  footer{border-top:1px solid var(--line);padding:32px 0;color:var(--g5);font-size:14px}
  footer a{color:var(--g6)}
</style></head><body><div class="wrap">
<nav><a class="brand" href="/"><svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M120,24 L203.14,72 L203.14,168 L120,216 L36.86,168 L36.86,72 Z"/><path d="M154.34,60.53 L177.58,20.29"/><path d="M115.34,83.05 L68.87,83.05"/><path d="M154.34,105.57 L177.58,145.81"/><circle cx="141.34" cy="83.05" r="20"/><circle cx="177.58" cy="20.29" r="16" fill="currentColor" stroke="none"/><circle cx="68.87" cy="83.05" r="16" fill="currentColor" stroke="none"/><circle cx="177.58" cy="145.81" r="16" fill="currentColor" stroke="none"/></svg>LLM&nbsp;Bus</a><span class="sp"></span><a class="home" href="/">Home</a></nav>
<main>${mdToHtml(md)}</main>
<footer>&copy; 2026 DRD AS &nbsp;&middot;&nbsp; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/pricing">Pricing</a></footer>
</div></body></html>`;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;
const MAX_SESSIONS = 2000;

// Per-IP rate limit for the public, unauthenticated POST /join (invite redemption).
const JOIN_WINDOW_MS = 5 * 60 * 1000;
const JOIN_MAX_PER_WINDOW = 30;
const joinHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim(); // Caddy sets this
  return req.socket.remoteAddress ?? "unknown";
}

function allowJoin(ip: string): boolean {
  const now = Date.now();
  const w = joinHits.get(ip);
  if (!w || now > w.resetAt) {
    joinHits.set(ip, { count: 1, resetAt: now + JOIN_WINDOW_MS });
    return true;
  }
  if (w.count >= JOIN_MAX_PER_WINDOW) return false;
  w.count++;
  return true;
}

const allowedHosts = process.env.ALLOWED_HOSTS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Session {
  transport: StreamableHTTPServerTransport;
  participationId: number;
  projectId: number;
  lastSeen: number;
}

const sessions = new Map<string, Session>();

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length ? JSON.parse(raw) : undefined;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Aggregate, service-wide KPI counts for the public landing page. Cached in-memory for 60s. */
interface LiveStats {
  events: number;
  posts: number;
  ackedPct: number;
  anchoredPct: number;
  projects: number;
  participants: number;
  tokensSaved: number;
}

const STATS_TTL_MS = 60 * 1000;
let statsCache: LiveStats | null = null;
let statsCachedAt = 0;

async function getLiveStats(): Promise<LiveStats> {
  const now = Date.now();
  if (statsCache && now - statsCachedAt < STATS_TTL_MS) return statsCache;
  const result = await query<{
    projects: string;
    participants: string;
    events: string;
    posts: string;
    acked_pct: string | null;
    anchored_pct: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM projects) AS projects,
       (SELECT count(*) FROM participants) AS participants,
       (SELECT count(*) FROM events WHERE actor_name <> 'billing') AS events,
       (SELECT count(*) FROM posts WHERE from_actor_name <> 'billing') AS posts,
       (SELECT round(100.0*count(*) FILTER (WHERE EXISTS(SELECT 1 FROM post_acks a WHERE a.post_id=p.id))/nullif(count(*),0),1) FROM posts p WHERE p.from_actor_name <> 'billing') AS acked_pct,
       (SELECT round(100.0*count(*) FILTER (WHERE ref IS NOT NULL)/nullif(count(*),0),0) FROM posts WHERE from_actor_name <> 'billing') AS anchored_pct`,
  );
  const r = result.rows[0];
  const posts = Number(r.posts);
  const stats: LiveStats = {
    events: Number(r.events),
    posts,
    ackedPct: Number(r.acked_pct),
    anchoredPct: Number(r.anchored_pct),
    projects: Number(r.projects),
    participants: Number(r.participants),
    tokensSaved: posts * 5000,
  };
  statsCache = stats;
  statsCachedAt = now;
  return stats;
}

/**
 * HTTP surface:
 *   GET  /healthz   -> unauthenticated liveness
 *   POST /mcp       -> MCP over Streamable HTTP; bearer-auth -> Ctx {actor, workspace} on every request
 *   GET/DELETE /mcp -> MCP session stream / teardown (auth + session-scoped)
 *
 * A session is created only by a POST initialize, bound to (actor, workspace); later
 * requests must present a token resolving to the same actor. Idle sessions are reaped
 * and the total is capped to bound memory.
 */
export function createHttpServer(): http.Server {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastSeen > SESSION_TTL_MS) {
        sessions.delete(sid);
        void Promise.resolve(s.transport.close()).catch(() => {});
      }
    }
    for (const [ip, w] of joinHits) if (now > w.resetAt) joinHits.delete(ip);
  }, SESSION_SWEEP_MS);
  sweeper.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(LANDING_HTML);
      }

      if (req.method === "GET" && (url.pathname === "/terms" || url.pathname === "/privacy" || url.pathname === "/pricing")) {
        const html = renderLegal(url.pathname.slice(1));
        if (html) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(html);
        }
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, service: "llm-bus", version: VERSION });
      }

      // Public, cached aggregate KPI counts for the landing page (60s in-memory cache).
      if (req.method === "GET" && url.pathname === "/api/stats") {
        try {
          return send(res, 200, await getLiveStats());
        } catch (err) {
          console.error("[llm-bus] stats error:", err);
          return send(res, 503, { error: "stats unavailable" });
        }
      }

      // OAuth 2.0 Protected Resource Metadata (RFC 9728). Forward-compat for MCP clients that do the
      // OAuth discovery dance; existing bearer clients never read this. authorization_servers is
      // empty until a hosted authorization server is added (decision 010).
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
        const base = loadConfig().PUBLIC_URL.replace(/\/+$/, "");
        return send(res, 200, {
          resource: base,
          authorization_servers: [],
          bearer_methods_supported: ["header"],
        });
      }

      // Web admin (SSO-gated by Caddy/oauth2-proxy; trusts the email header it sets).
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        await handleAdmin(req, res);
        return;
      }

      // Public invite redemption: unauthenticated, scoped + rate-limited by the code + per-IP.
      if (url.pathname === "/join" && req.method === "POST") {
        const ip = clientIp(req);
        if (!allowJoin(ip)) return send(res, 429, { error: "rate limited; try again shortly" });
        const body = (await readBody(req)) as { code?: unknown; name?: unknown } | undefined;
        const code = typeof body?.code === "string" ? body.code.trim() : "";
        const rawName = typeof body?.name === "string" ? body.name.trim() : "";
        // Guard the unsubstituted placeholder so the agent gets a clear "name_required" not a bad name.
        const name = rawName && rawName !== "<YOUR_NAME>" ? rawName : null;
        if (!code) return send(res, 400, { error: "code required" });
        const r = await redeemInvite(code, name);
        if (!r.ok) {
          const status =
            r.error === "name_required" ? 400 : r.error === "name_taken" ? 409 : r.error === "invalid" ? 404 : 410;
          return send(res, status, { ok: false, error: r.error });
        }
        const mcpUrl = loadConfig().PUBLIC_URL.replace(/\/+$/, "") + "/mcp";
        return send(res, 200, {
          ok: true,
          project: r.projectSlug,
          project_name: r.projectName,
          participant: r.participant,
          created: r.created,
          token: r.token,
          connect_command: buildConnectCommand(r.token, mcpUrl),
          files: buildJoinFiles(r.token, mcpUrl),
          guide: coordinationGuide(r.isAdmin),
          next:
            "RECOMMENDED: run `connect_command` (your token is already in it), then `claude mcp list` " +
            "to see `llm-bus ... Connected`, then RESTART your session (MCP loads only at startup) and " +
            "call whoami. FALLBACK (not Claude Code): write `files` to disk and set LLM_BUS_TOKEN or the " +
            "server won't connect. Append `guide` to this repo's CLAUDE.md.",
        });
      }


      if (url.pathname !== "/mcp") {
        return send(res, 404, { error: "not found" });
      }

      const auth = await authenticateResult(req.headers["authorization"]);
      if (!auth.ok) {
        // Deliberate non-payment block (decision 016): a valid token whose owner is suspended gets a
        // clear 403 + a stable message - NOT a 401 challenge (that would loop OAuth-discovery clients).
        if (auth.reason === "suspended") {
          return send(res, 403, { error: "suspended due to non-payment" });
        }
        const base = loadConfig().PUBLIC_URL.replace(/\/+$/, "");
        const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
      }
      const ctx = auth.ctx;

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return send(res, 404, { error: "unknown session" });
        if (session.participationId !== ctx.participation.id) return send(res, 403, { error: "forbidden" });
        session.lastSeen = Date.now();
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== "POST") {
        return send(res, 400, { error: "missing mcp-session-id" });
      }
      const body = await readBody(req);
      if (!isInitializeRequest(body)) {
        return send(res, 400, { error: "expected an initialize request" });
      }
      if (sessions.size >= MAX_SESSIONS) {
        return send(res, 503, { error: "server busy" });
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
        onsessioninitialized: (sid) => {
          sessions.set(sid, {
            transport,
            participationId: ctx.participation.id,
            projectId: ctx.project.id,
            lastSeen: Date.now(),
          });
        },
      });
      const mcp = buildServer(ctx);
      transport.onclose = () => {
        // Just drop the session. Do NOT call mcp.close() here: onclose fires *because* the
        // transport is closing, and mcp.close() -> protocol.close() -> transport.close() would
        // re-fire onclose -> infinite recursion -> stack overflow (MCP SDK 1.29.0 close cycle).
        // The McpServer holds no background work and is GC'd once the session is dropped.
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[llm-bus] request error:", err);
      if (!res.headersSent) send(res, 400, { error: "bad request" });
      else res.end();
    }
  });

  server.on("close", () => clearInterval(sweeper));
  return server;
}
