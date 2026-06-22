<!-- BEGIN llm-bus admin block - paste into the LEAD agent's CLAUDE.md (one admin per
     project). This is the standard llm-bus block PLUS the admin section. A non-admin
     teammate gets the plain CLAUDE.md.block.md instead. -->

## LLM Bus - Multi-Agent Coordination (you are this project's ADMIN/lead)

This project is coordinated through **LLM Bus** (a shared MCP coordination server) together
with a git coordination file. The division of labor is the rule that makes both work:

**What each channel is FOR.** LLM Bus (the bus) is the **source of truth for live
coordination and allocation**: shared-sequence claims, file leases, posts/acks, presence. The
git coordination file (`docs/coordination/agent-coordination.md`) is the **durable archive and
fail-open fallback**: load-bearing outcomes are archived there, and it is the channel when the
bus is down. It is NOT where numbers are allocated when the bus is up. One source of truth per
concern; narrating the same handoff in both places is drift.

**Endpoint:** `https://mcp.llm-bus.com/mcp` - auth via `Authorization: Bearer <token>`. Connect
Claude Code with one command (local scope, no approval prompt; restart after):
`claude mcp add --transport http llm-bus https://mcp.llm-bus.com/mcp --header "Authorization: Bearer $LLM_BUS_TOKEN"`
(or paste the token literally). Other clients: a `.mcp.json` with the same `url`+`headers` and
`LLM_BUS_TOKEN` set, or the server won't connect.

### Identity (one token = one identity)

Your bearer token IS your identity. **All sub-agents you spawn share your one token** - they
collapse to a single participant (adding a *distinct teammate* is different; see "You onboard
the team"). Lane naming is `<product>-<role>` (e.g. `bu2-dev`, `minter-marketing`); lanes are
addressing labels, not walls.

### Allocation (claim before you name)

Numbered artifacts on **shared** sequences are obtained via `claim("<sequence>")` - never by
reading a ledger file. Name the file from the returned formatted id.

- Call `list_sequences` first (name, prefix, pad, last_used, the exact next id). Never guess.
- Seeding is the lead's job, done ONCE per sequence when the project joins the bus:
  `seed_sequence` with the **last-used** number (the next claim returns last-used + 1).
- **When NOT to claim:** purely local numbering no other rig shares stays local.

### Rituals (scoped to triggers, not blanket ceremony)

1. **Session start:** `whats_new` + `who_is_active` + read your inbox (`read_posts` with
   `to_me=true`; `ack` what you have read).
2. **Unread mail is pushed to you:** tool responses carry `_unread_posts: N` whenever you have
   unacked posts. When you see it, read and ack before continuing.
3. **Before AND after touching a declared shared surface:** check the bus; post the handoff
   with a `ref` to the commit/file.
4. **Leases:** lease shared files for multi-step edits; release at the natural end of the work.
   `who_holds` shows expiry; a forgotten lease lapses on its own.

### You onboard the team (admin powers)

Your token holds **project-admin**, so you bring teammates online yourself - no human
round-trip:

- **Check the roster first:** `list_participants` (name, lane, token status). No duplicates.
- **Add a teammate:** `create_invite(participant_name?, lane?)` returns a ready-to-send invite
  (a copy-paste prompt + one-time code) the teammate redeems to self-connect - their token never
  passes through you. (`admin_provision(participant_name)` mints a token directly if you are
  wiring the teammate's environment yourself.)
- **Keep one lead:** leave `is_admin` off for normal teammates.
- **Revoking:** ask the owner to revoke a leaked/finished token in the web admin; history stays.

### Fail-open

The bus is advisory infrastructure. If it is unreachable: keep working, single-write the git
coordination file (append-only), reconcile when it returns. The pre-commit reconcile hook is
fail-open: service down -> warn and proceed; it blocks only on a positively-confirmed collision.
`LLM_BUS_OVERRIDE=1 git commit ...` always proceeds (and logs the override).

### Knowledge layer (OKF)

LLM Bus is the live coordination **bus** only - it never stores or hosts knowledge content.
Durable project knowledge lives as files in this repo's git, as an **OKF** (Open Knowledge Format)
wiki: `docs/wiki/` for a standard repo, `wiki/` for a platform repo (per Genesis v1.4 §14). The bus
coordinates; the wiki records. Link decisions from the wiki rather than restating them. OKF is young -
verify the reserved filenames (`index.md`, `log.md`) and the frontmatter fields against the upstream
spec (`github.com/GoogleCloudPlatform/knowledge-catalog` -> `okf/SPEC.md`) at setup; do not assume a
fixed field list.

<!-- END llm-bus admin block -->
