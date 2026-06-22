---
type: research
status: implemented
date: 2026-06-17
topic: bulletproof MCP enrollment ("copy-paste = it just works")
sources:
  - https://code.claude.com/docs/en/mcp
  - https://code.claude.com/docs/en/mcp-quickstart
related: [[index]]
---

# Onboarding: bulletproof MCP enrollment

Raw research output (subagent map + design) for redesigning how users connect to LLM Bus. The
adversarial validation of the Claude Code mechanics is captured in the "Validation" section at the end
(appended when that pass completes). Approved in direction by the operator 2026-06-17.

## Root cause: why people fail today

Every onboarding artifact the server emits today asks a human or an agent to **hand-author
`.mcp.json` + `.claude/settings.local.json` and restart** - the fragile path. Current code:
`buildJoinFiles()` (src/invite.ts) emits `.mcp.json` with `Bearer ${LLM_BUS_TOKEN}` + a separate
`settings.local.json` carrying the token; `buildInvitePrompt()`/`buildHandoutPrompt()` tell the agent
to write those files and restart; the admin hand-out card + `acceptedPage` render the same.

Failure modes (each confirmed against the official docs):
1. **Env var never resolved.** `.mcp.json` uses `${LLM_BUS_TOKEN}`. Claude Code expands `${VAR}` in
   `.mcp.json`, but "if a required environment variable is not set and has no default value, Claude
   Code will fail to parse the config" - the server is **silently absent**. Likely the #1 report.
2. **Project-scope approval prompt not surfaced.** A project `.mcp.json` shows as "pending approval"
   until the user answers "Use this project's MCP servers?". Prompts never mention it -> `/mcp` empty.
3. **Restart buried.** MCP loads only at session start; users read "doesn't show up" as failure.
4. **No deterministic alternative.** Nothing emits the one command that bypasses 1-3.

Fix: **invert the default** - lead with the single CLI command that writes a correct config
deterministically; make file-writing the documented fallback.

## Authoritative mechanics (cited)

The deterministic command (the whole game):
```
claude mcp add --transport http llm-bus https://mcp.llm-bus.com/mcp --header "Authorization: Bearer <TOKEN>"
```
- `--header` takes one quoted `"Key: Value"` string; repeatable. Matches the docs' own example.
- **Default scope is `local`** (stored in `~/.claude.json` under the project path). A local-scoped
  server needs **no approval prompt** (that dialog is only for project-scoped `.mcp.json`). Eliminates
  failure mode 2.
- Put the **literal token** in `--header` (CLI flags are not env-expanded). Eliminates failure mode 1.

`.mcp.json` schema (the fallback path):
```json
{ "mcpServers": { "llm-bus": { "type": "http", "url": "https://mcp.llm-bus.com/mcp",
  "headers": { "Authorization": "Bearer ${LLM_BUS_TOKEN}" } } } }
```
`type` is `"http"` (alias `"streamable-http"`). `${VAR}`/`${VAR:-default}` expand in url+headers; an
unset, default-less var is a hard parse failure.

`claude mcp add-json llm-bus '{"type":"http","url":"https://mcp.llm-bus.com/mcp","headers":{"Authorization":"Bearer <TOKEN>"}}'`
is a clean middle option.

Restart/status: MCP config is read once at session start; `claude mcp add` from a terminal is seen by
the NEXT session. Check with `/mcp` (in-session) or `claude mcp list` / `claude mcp get llm-bus`
(terminal). `claude mcp reset-project-choices` re-triggers project-scope approval.

## Design principle

Minimize what must be gotten right to **one paste**. Rank paths by reliability, lead with the most
reliable: (1) one shell command (`claude mcp add ... --header "...<literal token>..."`); (2) a
"paste-to-your-agent" super-prompt that runs that same command (never hand-writes files); (3) the
files fallback for non-Claude-Code clients / committed config. Token delivered directly to the joiner;
only the short invite code ever crosses the relay channel.

## Artifacts the server should emit

- **A - one-line connect command** (`buildConnectCommand(token, mcpUrl, serverName)`), literal token,
  serverName defaults to `llm-bus-<projectSlug>` (see scenario 4).
- **B - connect block** (`buildConnectBlock`): the command + a `claude mcp list` verify line + an
  "other tools" portable `{url, headers}` JSON with the literal token + the "keep out of git" warning.
- **C - agent super-prompt** (`buildAgentConnectPrompt`): instructs a coding agent to run `claude mcp
  add` (forbids hand-authoring), verify with `claude mcp list`, state the restart as expected, then
  call whoami; appends `coordinationGuide(isAdmin)`.
- **D - invite "send to your friend"** (rewritten `buildInvitePrompt`): redeem via `curl POST /join`
  -> run the response's `connect_command` -> restart -> whoami. Only the short code is in it.
- **E - `/join` JSON response** gains `connect_command` + `connect_command_json` (token inlined), and
  demotes `files` to a fallback with a `next` that warns about the unset-var parse failure.

## Scenarios (restart point + failure modes eliminated)

1. First-timer owner connects their own agent: sign in -> create project + participant -> Grant ->
   hand-out card leads with the one command -> restart -> whoami. Eliminates env-var, approval,
   wrong-file, "did I restart".
2. Owner invites a collaborator: mint invite -> send Artifact D (code only, no token).
3. Collaborator connects: redeem -> run returned `connect_command` -> restart -> whoami.
4. Existing participant joins another project: name each registration `llm-bus-<slug>` so N projects
   give N non-colliding local servers (Claude Code keys local servers by name). **Recommendation:
   always use `llm-bus-<slug>`, even for single-project users, for consistency.**

## Failure-mode table

| # | Failure (today) | Root cause | Prevented by |
|---|---|---|---|
| 1 | "Doesn't show up in /mcp" | `${LLM_BUS_TOKEN}` unset -> hard parse failure, server silently dropped | Primary path inlines the literal token in `--header`; no env var in config. |
| 2 | Present but "pending"/inactive | Project `.mcp.json` needs approval; never surfaced | Local scope (`claude mcp add`) needs no approval; copy names the prompt + reset-project-choices where project scope is used. |
| 3 | "tools aren't there" | MCP loads only at session start; no restart | Every artifact states restart as a numbered, expected step with `/mcp`/`claude mcp list` check. |
| 4 | Agent writes broken `.mcp.json` | Prompts told it to author files | Super-prompt mandates `claude mcp add`; command can't get schema wrong. |
| 5 | Token leaks into git | Token in a committed file | Primary path stores token in `~/.claude.json` (outside repo); fallback says keep out of git. |
| 6 | Second project overwrites first | Local servers keyed by name; reusing `llm-bus` collides | Registration named `llm-bus-<slug>`; distinct entries. |
| 7 | "POST blocked by sandbox" dead-end | Agent sandbox blocks outbound curl | Artifact D: hand the exact curl to the operator, continue from its JSON. |
| 8 | Non-Claude-Code user stuck | Artifacts assumed Claude Code | Every block has an "other tools" portable JSON branch. |
| 9 | "failed/401" no next step | No diagnostic | `claude mcp list` check + "failed = token wrong/revoked, re-run fresh"; /admin Rotate mints a new one. |

## Code changes needed

- `src/invite.ts`: add `buildConnectCommand`, `buildConnectBlock`, `buildAgentConnectPrompt`; rewrite
  `buildHandoutPrompt` + `buildInvitePrompt` to lead with `claude mcp add`; keep `buildJoinFiles`
  demoted to fallback.
- `src/http.ts` (`POST /join`): compute `serverName = "llm-bus-" + projectSlug`; add `connect_command`
  + `connect_command_json` to the response; update `next`.
- `src/admin/html.ts`: `handoutCard` + `acceptedPage` lead with the command (Copy button), demote the
  two files; `invitePromptPage` help text.
- `kit/`: `CLAUDE.md.block.md` endpoint -> `mcp.llm-bus.com/mcp` + a one-line connect note;
  `llm-bus.config.json.example` + `reconcile-hook.mjs` endpoint -> `mcp.llm-bus.com/mcp`.
- `USING.md` §B: invert to lead with `claude mcp add`; **fix all `yolo.doderlein.com` -> `mcp.llm-bus.com`
  (live doc-drift)**.
- Needs an Implementation Plan + a test (assert `/join` returns `connect_command` containing
  `claude mcp add --transport http` and the literal token).

## Open risks (for the adversarial validation pass)

1. Exact `claude mcp add` re-add/collision message+exit code; settle `llm-bus` vs `llm-bus-<slug>`.
2. Does `claude mcp add` validate at add time, or only next session start? Does `claude mcp list`
   live-probe or just list config? (Determines the "verify before restart" wording.)
3. `--header` quoting across zsh/bash/PowerShell (Windows variant).
4. Token in shell history (acceptable; note it).
5. Relay joiner with no shell stalls at "run connect_command" - operator handoff must cover it.
6. Version floor for `add-json`/`--transport http`.
7. Confirm `PUBLIC_URL=https://mcp.llm-bus.com` on the VM so emitted commands match the live vhost.

## Validation (2026-06-17, claude-code-guide vs official docs + local CLI)

The design holds. Verdicts:

1. `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <TOKEN>"` -
   **CONFIRMED**. `--transport http` is right (spec name is "streamable-http"; `--transport http` in
   CLI, `"type":"http"` or `"streamable-http"` in config). `--header "Key: Value"` is correct + repeatable.
2. Default scope `local` (in `~/.claude.json`), no approval prompt - **CONFIRMED**. The approval dialog
   is project-scope-only; local avoids it.
3. Literal token in `--header` (no env var needed) - **CONFIRMED**. Nuance on the fallback: an unset
   `${VAR}` in `.mcp.json` does NOT "fail to parse" (docs wording) - it leaves the literal `${VAR}` in
   the URL/header and **fails to connect**. Same outcome (server silently absent); copy should say
   "the var must be set or the server won't connect."
4. MCP loads at session start; `claude mcp add` seen next session - **CONFIRMED**. `claude mcp list`
   performs a **live connection probe** (shows `✓ Connected` / `! Needs authentication` /
   `✗ Failed` / `⏸ Pending approval`), so "verify with `claude mcp list` before restarting" is VALID.
5. `claude mcp add-json llm-bus '{"type":"http","url":"...","headers":{"Authorization":"Bearer <TOKEN>"}}'`
   - **CONFIRMED** (help text says stdio/SSE but http works).
6. Re-add of an existing name -> `MCP server <name> already exists in <scope> config`, non-zero exit,
   no overwrite. Rotate via `claude mcp remove <name> --scope local` then add.
   **REFINEMENT (simplifies the design): local scope is ALREADY per-project** (keyed by project path in
   `~/.claude.json`), so a bare `llm-bus` does NOT collide across projects. **Drop the `llm-bus-<slug>`
   naming - use `llm-bus` everywhere.** (Scenario 4 / failure-mode #6 above are over-engineered; the
   per-slug convention is unnecessary.)
7. `.mcp.json` uses `"type"` (not `"transport"`); `claude mcp reset-project-choices` re-triggers
   project-scope approval - **CONFIRMED**.
8. bash/zsh: `--header "Authorization: Bearer <token>"` works as written - **CONFIRMED**. PowerShell:
   same double-quoted header; use backtick (not backslash) for line continuation.
9. Version floor: remote HTTP MCP needs a recent Claude Code (changelog cites ~v2.1.147; the primary
   path is well-supported). Onboarding copy should say "recent Claude Code; check `claude --version`."

### Net changes to the design from validation
- Use the bare server name `llm-bus` (drop per-slug); local scope handles multi-project.
- Reword the unset-var warning to "won't connect" rather than "won't parse."
- Keep "verify with `claude mcp list` (live probe) before restarting" - it is accurate.
- Add a one-line "needs a recent Claude Code (`claude --version`)" note.
