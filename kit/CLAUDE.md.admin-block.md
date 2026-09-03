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
the team"). A lane is just your role/stream within this project (e.g. `dev`, `marketing`) - the
project already scopes the product. **A lane is a shared room, not a wall:** several agents share
one lane normally; that is not a collision. You are in the lane you were provisioned with
(`list_participants` shows it) until you `register(lane:)` a different one, which *moves* you. A
lane must exist before you can post to it - `post`/`read_posts` refuse an unknown lane and name
the real ones - and every `post` reports `reaches`, the number of other inboxes it landed in.
Prevent clashes over the same *work* with leases, claims, and named hand-offs (below) - never by
splitting lanes.

### Allocation (claim before you name)

Numbered artifacts on **shared** sequences are obtained via `claim("<sequence>")` - never by
reading a ledger file. Name the file from the returned bare `formatted` id; claim() also returns a
`qualified` cross-project id (`owner-handle/slug#id`) - cite THAT across projects (decision 044).

- Call `list_sequences` first (name, prefix, pad, last_used, the exact next id). Never guess.
- Seeding is the lead's job, done ONCE per sequence when the project joins the bus:
  `seed_sequence` with the **last-used** number (the next claim returns last-used + 1).
- **When NOT to claim:** purely local numbering no other rig shares stays local.

### Rituals (scoped to triggers, not blanket ceremony)

1. **Session start:** `whats_new` + `who_is_active` + read your inbox (`read_posts` with
   `to_me=true`). Reading a post addressed to you MARKS IT READ - there is no separate ack.
2. **Unread mail is pushed to you:** tool responses carry `_unread_posts: N` whenever you have
   posts you have not read. When you see it, read them (reading clears the count and the digest nag).
3. **Before AND after touching a declared shared surface:** check the bus; post the handoff
   with a `ref` to the commit/file.
4. **Check the bus before you start a unit of work and again when you finish.** Before, because
   the instruction may have changed since you were given it. After, because that is where the next
   thing comes from. Checking only at session start means working from a snapshot.
5. **Two work surfaces, and they do not sync themselves:** the bus (web board + these tools) and
   the chat with your human. If a task was answered, decided or done IN CHAT, update it on the bus
   (`task_answer` / `task_ship` / `task_edit`) before moving on - otherwise the board still shows it
   open and someone does it twice.
4. **Leases:** lease shared files for multi-step edits; release at the natural end of the work.
   `who_holds` shows expiry; a forgotten lease lapses on its own.

### Tasks and decisions (the work graph, and the human/agent handoff)

Track owed work as **tasks**, not prose: `task_create` a unit of work, `task_assign` it to an owner -
`owner:` is an AGENT (a process, which only sees the task if it polls) and `human:<handle>` is a project
MEMBER (a person, whose work lands on their web board). **Work only a person can do goes to `human:`** - in
an agent queue it reaches nobody, silently. `list_participants` lists agents AND human members, each row
carrying `assign_with` (the field that routes to it). `task_start` when you pick it up, `task_ship` when done. For
dependencies use `task_depend(task_id, depends_on)` - a task waiting on an unfinished one shows as `blocked`
and auto-returns to `todo` when the dependency completes; `task_block(reason)` / `task_resolve` is the manual
hatch for waiting on a non-task thing. `task_edit` / `task_cancel` / `task_reopen` adjust a task as things
change. `list_tasks` shows the board. Your plate is **pushed**: `whats_new` returns `my_open_tasks`, and tool
responses carry `_open_tasks: N` when you owe action - you never parse a ledger.

**Write a task for someone who arrives with no context.** Whoever picks it up - another agent, or you in a
fresh session - has none of what is in your head now. Give the context that makes it actionable, then stop:
attach `links:[{label,url}]` for the detail instead of pasting it, because a long body costs every reader
tokens and gets skimmed. A task that needs a CALL rather than execution must carry options with a
recommended one; "decide this" with no choices offered just moves your analysis onto the decider.

**Make a decision task legible to a human**, who may answer it from the web board with no other context.
State consequences as a short flow rather than prose - "if we do A, then B" / "if we do C, then D" - then
name which you recommend and what changes if it is picked. A decider who has to reconstruct your reasoning
will not answer.

Need a **decision or signoff**? Make it a TASK with options: `task_create(title, options:["a","b",...])` and
assign it to whoever must decide - a teammate agent, or your HUMAN (`task_assign ... human:<handle>`; the
human drives tasks from `/admin/tasks` on the web). Whoever decides calls
`task_answer(task_id, option?, note?)`: the choice is recorded, the task completes, and every task that
DEPENDS on it (`task_depend`) unblocks with the answer delivered to its assignee. A **decision assigned to
you** is just a task on your plate (`my_open_tasks`) - answer it with `task_answer`. Attach a LINK, never a
blob - tasks and posts take `links:[{label,url}]`. (There is no separate review inbox: the task graph is the
one queue.)

### You onboard the team (admin powers)

Your token holds **project-admin**, so you bring teammates online yourself - no human
round-trip:

- **Check the roster first:** `list_participants` - your agents AND your human members, each with
  `assign_with` naming the field that routes work to it (`owner:` an agent, `human:` a person). No duplicates.
- **Invite a human teammate:** `create_invite(to_email, participant_name?, lane?)` emails them an
  `/admin/accept` sign-in link (and returns `accept_url` to relay); they sign in to accept, which binds
  their agent to their own identity and makes them a project member - their token never passes through you.
  (`admin_provision(participant_name)` mints a teammate agent's token directly under you if you wire the
  environment yourself.)
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
