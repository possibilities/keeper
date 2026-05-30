---
name: keeper-await
description: >-
  Block until a planctl board condition holds (epic/task complete, epic/task
  unblocked) and then run a follow-up action. Use when the user says "wait
  for", "wait until", "block until", "hold off until", "do X when Y is
  done", "do X after fn-N finishes", "review when fn-… is complete", "ping
  me when X completes", "once X is unblocked", "as soon as X is ready",
  "after the build/epic/task is done", or any pushy "do X when Y is in
  state Z" intent — even when they don't say "keeper", "epic", "task", or
  "await". The trigger is the wait-then-act shape against a planctl id
  (`fn-N-slug` for an epic, `fn-N-slug.M` for a task). Wires a
  `Monitor(keeper await …)` invocation, listens for the terminal
  `[keeper-await] met …` line, then runs the requested follow-up. Refuses
  upfront if the target is off-board (already completed / popped off) or
  nonexistent.
allowed-tools: Monitor Bash
---

# keeper-await

Turn a "wait until <thing> happens, then do <follow-up>" request into a
`Monitor(keeper await …)` invocation plus the follow-up action.

## When this fires

The user's ask has two shapes glued together:

1. **A wait condition** against a planctl id — words like *wait*, *block*,
   *hold off*, *when … is done*, *after … finishes*, *once … is ready*,
   *as soon as …*.
2. **A follow-up** to run when the condition holds — *then review it*,
   *then run the tests*, *and ping me*, *and start the next task*, etc.

The user does NOT need to say "keeper" / "epic" / "task" / "await". A
bare *"do a full review once fn-643-…-hook.4 is complete"* fires this
skill.

## Parse the request

Extract three things from the user's message:

| Field | How to derive | Example |
|---|---|---|
| `target` | The first planctl id in the message (`fn-N-slug` or `fn-N-slug.M`). | `fn-643-…-hook.4` |
| `kind` | `task` if `target` ends in `.<digits>`, else `epic`. | `task` |
| `condition` | `complete` by default. Use `unblocked` only when the user explicitly asks about readiness ("once it's unblocked", "as soon as it's ready to be worked on", "when the deps clear"). "done" / "finished" / "complete" all map to `complete`. | `complete` |
| `follow-up` | The clause after "then" / "and" / "and then" — what to run when the condition holds. | "do a full review" |

If the user gives multiple ids, ask which one to wait on — this skill
binds exactly one Monitor to one target.

## Step 1 — Pre-check the target is on-board

Before wiring Monitor, verify the id exists and is awaitable. `planctl
show` is read-only and fast.

```bash
planctl show <target> --format json
```

Refuse to wire Monitor in any of these cases — the event will never fire:

- **Nonexistent** — `planctl show` exits non-zero or returns `success:
  false`. Tell the user the id doesn't exist; ask them to double-check.
- **Already complete** (for `condition=complete`):
  - Task: `task.runtime_status == "done"` AND `task.approval ==
    "approved"`.
  - Epic: `epic.status == "closed"` AND `epic.approval == "approved"`.
  Tell the user the target has already popped off the board — there's
  nothing to await — and offer to just run the follow-up now.

If the target is on-board and the condition isn't already met, continue
to step 2. (For `condition=unblocked` you may skip the
already-unblocked check — `keeper await unblocked` with an already-
workable target fires `met` immediately, which is the correct behavior.)

## Step 2 — Wire the Monitor

```
Monitor({
  command: "keeper await <condition> <target>",
  description: "wait for <target> to be <condition>",
  persistent: true,
})
```

Defaults and overrides:

- **`persistent: true` is the default.** Epic / task completion can take
  hours; an open-ended "whenever it finishes" wait must outlive
  individual model turns. Only drop `persistent` when the user gave a
  hard wall-clock bound.
- **For a bounded wait** ("within the hour", "give it 30 minutes"), use
  `timeout_ms` on the Monitor invocation instead of `keeper await
  --timeout`. Let Monitor own the deadline. On timeout Monitor SIGTERMs
  the process and `keeper await` emits `[keeper-await] failed
  reason=timeout` exit 3 through the same flush path.
- **Do NOT pass `keeper await --timeout`** — Monitor's `timeout_ms` is
  the single source of truth for the deadline.
- **Stuck verdicts** (job-rejected, dep-on-epic-dangling) keep waiting
  by default. Add `--fail-on-stuck` only if the user explicitly wants
  the wait to surrender on those.

## Step 3 — Listen for the terminal line

Monitor streams `keeper await`'s stdout to you, line by line. The shape:

```
[keeper-await] armed target=<id> kind=<epic|task> condition=<…> state=<…>
[keeper-await] met target=<id> condition=<…> state=met
```

…or a terminal `failed` instead of `met`:

```
[keeper-await] failed target=<id> reason=<reason> …
```

Reasons + exit codes:

| Line | Exit | Meaning | Your action |
|---|---|---|---|
| `met …` | 0 | Condition holds. | Run the follow-up. |
| `failed reason=not-found …` | 1 | Id absent at startup (pre-check missed it). | Tell the user, do NOT run the follow-up. |
| `failed reason=deleted …` | 4 | Was on board, vanished, re-query miss. | Tell the user the target was deleted; do NOT run the follow-up. |
| `failed reason=timeout …` | 3 | Monitor wall-clock deadline hit. | Tell the user it timed out; ask whether to extend or move on. |
| `failed reason=stuck …` | 5 | Under `--fail-on-stuck` only. | Tell the user the target is stuck; surface the verdict. |

The `armed` line is information only — proceed past it. The first
`met` / `failed` line is terminal; act on it.

**Already-complete-while-on-board fires immediately.** If the target is
on-board but the condition already holds at arm time, `keeper await`
emits `armed` and then `met` in quick succession. That's correct
behavior — run the follow-up.

## Step 4 — Run the follow-up

On `met`, run the follow-up clause the user gave. If the follow-up is
itself a Claude Code task ("do a full review", "implement the next
task"), invoke whatever tools are appropriate for it. If it's a shell
command, run it via Bash.

On any `failed`, surface the terminal line to the user verbatim and ask
how they want to proceed — do NOT silently run the follow-up.

## Examples

### Wait then review

> User: "Do a full review when fn-643-keeper-hook-dead-letters.4 is
> complete."

1. `planctl show fn-643-keeper-hook-dead-letters.4 --format json` →
   task exists, `runtime_status != "done"`. Proceed.
2. `Monitor({ command: "keeper await complete
   fn-643-keeper-hook-dead-letters.4", description: "wait for fn-643.4
   complete then review", persistent: true })`.
3. On `[keeper-await] met …` → start the review.

### Wait until unblocked

> User: "As soon as fn-650 is ready to work, start it."

1. `planctl show fn-650-some-epic --format json` → epic exists, open.
2. `Monitor({ command: "keeper await unblocked fn-650-some-epic",
   description: "wait for fn-650 unblocked then start", persistent:
   true })`.
3. On `met` → run `/plan:work fn-650-some-epic` (or whatever start
   verb the user implied).

### Off-board refusal

> User: "Ping me when fn-647-…-promotion.2 finishes."

1. `planctl show fn-647-…-promotion.2 --format json` → `runtime_status:
   "done"` AND `approval: "approved"`.
2. Tell the user: this task has already popped off the board — it's
   done and approved. Nothing to await. Offer the follow-up now
   (a ping is just a message; deliver it).

### Bounded wait

> User: "Wait up to 30 minutes for fn-X.1 then run tests."

1. Pre-check passes.
2. `Monitor({ command: "keeper await complete fn-X.1", description:
   "30-min bounded wait then test", timeout_ms: 1800000 })` — drop
   `persistent` since the user gave a hard bound; Monitor owns the
   deadline.
3. On `met` → run tests. On `failed reason=timeout` → tell the user
   the wait expired without completion.

## What NOT to do

- Do not pass `keeper await --timeout`. Monitor's `timeout_ms` owns the
  deadline.
- Do not wire Monitor without the `planctl show` pre-check — a doomed
  Monitor that immediately exits `failed reason=not-found` is bad UX.
- Do not run the follow-up on `failed`. Surface the terminal line and
  ask.
- Do not invent ids. If the user gives a slug-less reference ("the
  promotion epic") and you can't disambiguate, ask.
