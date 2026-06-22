<!-- BEGIN llm-bus block - paste into your repo's CLAUDE.md (the §13 Multi-Agent
     Coordination section of the Claude Code Genesis Protocol v1.3). A project-admin (lead)
     agent gets CLAUDE.md.admin-block.md instead. -->

## LLM Bus - Multi-Agent Coordination

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
collapse to a single participant. Never mint per-sub-agent tokens. Lane naming is
`<product>-<role>` (e.g. `bu2-dev`, `minter-marketing`); lanes are addressing labels, not walls.

### Allocation (claim before you name)

Numbered artifacts on **shared** sequences (cross-rig decision/ADR numbers, migration prefixes)
are obtained via `claim("<sequence>")` - never by reading a ledger file; a number read from a
file can race, a claimed number cannot. Name the file from the returned formatted id.

- Call `list_sequences` first: it returns each sequence's name, prefix, pad, last_used, and the
  exact id the next claim will produce. Never guess conventions; never seed without asking.
- **When NOT to claim:** this repo's purely local numbering (sequences no other rig shares) is
  local - do not claim it against the shared project. If unsure, check `list_sequences`, then
  ask the operator.

### Rituals (scoped to triggers, not blanket ceremony)

1. **Session start:** `whats_new` + `who_is_active` + read your inbox (`read_posts` with
   `to_me=true`; `ack` what you have read).
2. **Unread mail is pushed to you:** tool responses carry `_unread_posts: N` whenever you have
   unacked posts. When you see it, read and ack before continuing.
3. **Before AND after touching a declared shared surface:** check the bus; post the handoff
   with a `ref` to the commit/file.
4. **Leases:** lease a shared file for multi-step edits; release at the natural end of the
   work. `who_holds` shows expiry; a forgotten lease lapses on its own.

### Fail-open

The bus is advisory infrastructure. If it is unreachable: keep working, single-write the git
coordination file (append-only), and reconcile with the bus when it returns. A git pre-commit
hook (`kit/reconcile-hook.mjs`) double-checks numbered files against the ledger and is itself
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

<!-- END llm-bus block -->
