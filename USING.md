# Using LLM Bus for your projects - operator manual

Live endpoint: **`https://mcp.example.com/mcp`** · health: `https://mcp.example.com/healthz` · admin: `https://mcp.example.com/admin`

> **v2 - owner model + web admin (decision [004](docs/decisions/004-owner-participant-model-and-web-admin.md)).**
> Structure is **Owner -> Projects + Participants -> Participation**. You (the owner) do everything in
> the **web admin**: create projects and participants, grant participants into projects (each grant
> mints a token + a copy-paste hand-out card), and rotate/revoke. The admin is **live** behind Google
> SSO (sign in with an owner email). A VM CLI path exists as a fallback for scripted/headless setup.

## Model in one paragraph
One service, many **projects**. A **participant** is one identity (agent or person); granting it into
a project mints a **participation token** - what agents connect with. A token =
one participation; share it across that participant's sub-agents (they collapse to one identity).
Everything is project-scoped and isolated per owner.

---

## A. Onboard a new project (the web admin - primary path)

1. Go to **`https://mcp.example.com/admin`** and sign in with your owner email (Google SSO). Only a
   registered owner is admitted; the operator seeds owners (see ops/README.md Step B2).
2. **+ New project** - give it a slug and a name.
3. **+ New participant** - a name and kind (agent or person). Participants are owner-level identities;
   you reuse one across projects.
4. Open the project, **+ Grant access** - pick a participant, an optional lane label, and tick
   "lead" for a project-admin. The grant mints the token and shows a **hand-out card once**: the
   plaintext token, a ready `.mcp.json`, and a self-contained onboarding prompt. Store or hand it off
   now - the token is never shown again (rotate or grant again if lost).

Then **seed your real counters** so `claim` starts at the right number (do this with a connected admin
agent - see §B - by asking it to call the tool):
```
seed_sequence(sequence="adr", current=102, prefix="R")        # next claim -> R103
seed_sequence(sequence="migration", current=37, pad=4)        # next claim -> 0038
```
`seed_sequence` never rewinds a counter, so it is safe to run once at onboarding.

**VM CLI fallback** (scripted / no browser). Mints owner + project + participant + token in one
idempotent upsert; the wrapper keeps the DB secret in tmpfs, never your shell:
```bash
```
It prints the token once. `--admin` makes the participation a project-admin (can mint more online, §D).

---

## B. Connect an agent (Claude Code)

Commit a **project-scoped `.mcp.json`** at the repo root (token comes from an env var, never
hardcoded - the hand-out card gives you this verbatim):
```json
{
  "mcpServers": {
    "llm-bus": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LLM_BUS_TOKEN}" }
    }
  }
}
```
Then, per developer/agent (do **not** commit the token):
```bash
export LLM_BUS_TOKEN="<that agent's token>"
claude                       # first run: approve the server when prompted
claude mcp list              # expect: Connected  llm-bus
```
CLI alternative (local scope, no file): `claude mcp add --transport http llm-bus https://mcp.example.com/mcp --header "Authorization: Bearer $LLM_BUS_TOKEN"`.
Cursor / Codex / Windsurf use the same remote-HTTP MCP shape (url + Authorization header).

---

## C. Install the adherence kit (makes `claim` un-skippable, fail-open)

Into each consuming project's repo, from this repo's [`kit/`](kit/):
```bash
cp -r <path-to-llm-bus>/kit  ./.llm-bus-kit
bash ./.llm-bus-kit/install.sh            # installs the fail-open git pre-commit hook
# edit ./llm-bus.config.json: set endpoint, tokenEnv=LLM_BUS_TOKEN, and the
# sequence -> file-glob map, e.g. "docs/decisions/*.md": "adr"
```
Paste [`kit/CLAUDE.md.block.md`](kit/CLAUDE.md.block.md) into the project's `CLAUDE.md` (Planning-Gate
rules: claim before writing a governed file; whats_new at session start; post/ack for handoffs; one
token per agent). The lead variant is [`kit/CLAUDE.md.admin-block.md`](kit/CLAUDE.md.admin-block.md).
The hook **never blocks on the service being down** - it warns and proceeds.

---

## D. Add and manage participants (the common operations)

Mint **one token per identity** (shared across its sub-agents). Three ways:

- **Web admin** - the project's **+ Grant access** (see §A.4); the hand-out card is the whole
  onboarding.
- **Self-assemble invite** - mint a one-use, expiring invite (web admin, or `create_invite` from a
  connected admin agent). Send the short code; the invitee redeems it at the public **`/join`**
  endpoint and the server returns their token + config directly. Only the code crosses the relay.
- **Online MCP tool** - with a project-admin agent connected:
  ```
  admin_provision(participant_name="project-c-dev")              # -> { token, setup } for this project
  admin_provision(participant_name="alice", kind="human")
  ```
- **VM CLI fallback:**
  ```bash
  ```

Give the new agent: the endpoint, its token, the `.mcp.json` (§B), and the CLAUDE.md block. That is the
whole onboarding - "one MCP endpoint + a token."

**Revoke / rotate** - both ship in the web admin and as MCP tools (no VM SQL needed):

- **Web admin** (per participation row): **Revoke** kills the token immediately; **Rotate** mints a
  fresh token and revokes the old one in a single step (no lockout gap) and shows the new hand-out
  card once. Use Rotate when a token may have leaked.
- **MCP tools** for a connected project-admin agent (mirror `admin_provision`):
  ```
  admin_revoke(participant_name="project-c-dev")    # kill that teammate's active token(s)
  admin_rotate(participant_name="project-c-dev")    # mint new + revoke old; returns the new token + setup
  ```

Revoked agents are locked out until re-granted or rotated; their ledger history is always preserved.

---

## E. What agents actually do (day-to-day)

- **Session start:** `whats_new()` (digest since last time), `who_is_active(lane)`, `who_holds(surface)`.
- **Before allocating a number:** `claim(sequence)` -> use the returned `formatted` id to name the file.
- **Handoffs:** `post(to_lane/to_actor, body, ref)` -> others `read_posts(to_me=true)` + `ack`.
- **Before touching a shared file:** `lease(surface)`; `release` when done.
- **Work tracking:** `task_create/assign/start/block/resolve/ship`, `list_tasks`.
- **Audit:** `query_events(...)`, `latest_claims()`, `list_sequences()`.

## F. Operate and monitor

How you run the process is yours - `SELFHOSTING.md` and `deploy/` carry Docker, Compose and systemd
examples. Whatever the host, the two checks that matter are the same:

```bash
curl -sS https://<your-host>/healthz     # {"ok":true,"service":"llm-bus","version":"..."}
curl -sS https://<your-host>/api/stats   # coordination counters
```

The service is advisory and FAIL-OPEN by design: if it is unreachable, agents keep working against
their git archive and reconcile when it returns. An outage degrades coordination rather than stopping
work - which is also why a SILENT failure matters more here than a loud one. Watch `/healthz` and the
process log; a bus that answers "nothing new" while its database is unreachable is the failure mode to
design against.

## G. Troubleshooting

| Symptom | Check |
|---|---|
| Agent shows `Failed to connect` | `echo $LLM_BUS_TOKEN` set? `curl -I https://mcp.example.com/mcp` (405/401 = up). |
| `401` on `/mcp` | token missing/invalid/revoked - re-mint (§D), or rotate (then load the new token). |
| `.mcp.json` parse error | required env var unset; `cat .mcp.json \| python3 -m json.tool`. |
| `/admin` will not load | sign in with a **registered owner** email; a non-owner is rejected. Operator seeds owners (ops/README.md Step B2). |
