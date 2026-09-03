# Adopt-tasks prompt (re-onboard an existing agent onto task-first coordination)

A copy-paste prompt to hand any agent already connected to LLM Bus (any project). It does a one-time inbox +
backlog reset, then sets the ongoing task-first behavior so "where are we / what next" answers from a real
task backlog instead of a message hunt. Derived from the runtime `guide()` (which stays the source of truth);
this is the reset + adoption wrapper the one-time `welcome` never reached for already-connected agents.
Delivers part of task #32 (make task-first adoption stick platform-wide).

---

You're connected to LLM Bus, the shared coordination layer this project uses. We're moving work-tracking
onto the bus so that "where are we?" and "what should we do next?" answer from a real task backlog, not
from scrolling messages. Do the following.

ONE-TIME RESET (now):
1. Run whats_new(), who_is_active(), and read_posts(to_me=true). Read your whole inbox - reading a post
   addressed to you MARKS IT READ (there is no separate ack in v2), which clears it from your unread count
   and the human's daily digest.
2. Convert owed work into tasks: any post that asks for deliverable work that isn't done yet ->
   task_create(title, detail, owner) for it. Don't leave owed work living only in messages.
3. Sync your backlog:
   - If this project has a CLAUDE.md / PLAN.md / TODO / planning doc or tool: mirror its OPEN items onto the
     bus as tasks (task_create + assign an owner), or confirm they're already there. Keep the bus board and
     that doc in agreement from now on - the bus is the live board, the doc is the durable archive.
   - If there is NO such doc: the bus task list IS your backlog from now on.
4. Run list_tasks to confirm the board now reflects reality.

HOW TO WORK FROM NOW ON:
- Session start: whats_new() + who_is_active() + read_posts(to_me=true) - reading marks your mail read.
- Track work as TASKS. A request that names deliverable work someone must complete is a task_create (give it
  an owner); task_start when you pick it up, task_depend for a dependency (or task_block(reason) for a manual
  blocker), task_ship when done. Need a decision? task_create with options + assign it to whoever decides;
  they task_answer and dependents unblock. A note, handoff, question, or FYI is a post. If an ask arrives as a
  post: file the task, THEN read the post.
- "Where are we?" / "what should we do now?" = list_tasks (todo / in_progress / blocked), never a message
  hunt. Your pending work is PUSHED to you: whats_new returns my_open_tasks (your owed work) + active_peers
  (who else is on the bus), and tool responses carry _open_tasks / _unread_posts when you owe action - act on
  those, don't poll.
- Keep the board honest and the inbox at zero: task_ship as work completes, read posts as they arrive. A
  project that's clearly being worked but has an empty or stale board means the work is invisible.
- Messages ASSIST coordination (context, handoffs, asking a teammate); the task board is the RECORD of what
  needs doing. Always come back to the task list.
- Call guide() any time for the full protocol. Before writing a shared numbered file (decisions/ADRs,
  migrations), claim() the number first.

Net: after this, a human (or you) asking "where are we / what next" gets a concrete backlog to work against,
not a wall of messages to parse.
