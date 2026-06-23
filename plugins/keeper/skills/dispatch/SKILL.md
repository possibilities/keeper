---
name: dispatch
description: >-
  Fire ONE claude worker into a managed window by hand — the manual surface
  parallel to the server-side autopilot reconciler. Two forms: plan form
  ("fire a worker on fn-N.M", "spawn a closer for fn-N") → `keeper dispatch
  work::fn-N.M` / `close::fn-N`; free form ("run this one-off prompt in a
  worker") → `--prompt` / `--prompt-file`. Use when the user asks to launch a
  single worker by hand / spawn a closer — even when they never say "keeper"
  or "dispatch". NOT for routine plan execution (that is `/plan:work`, which
  runs in THIS session), NOT for resuming a stuck autopilot retry or
  "approve fn-X" (that is `keeper:autopilot`), and NOT for planning work
  (`/plan:plan`).
allowed-tools: Bash
argument-hint: <verb>::<id> | --prompt "<text>"
---

# dispatch

Turn a "launch ONE worker by hand" request into a single `keeper dispatch`
Bash call. `keeper dispatch` fires one `claude` worker into a managed window
(via agentwrap), parallel to — and independent of — the server-side autopilot
reconciler. This
is a precisely-triggered operator surface, conservative by default: it fires a
worker only on a clear request to launch one by hand. The autopilot dispatching
ready plan work on its own, or `/plan:work` running a task in THIS session,
remain the everyday paths.

`keeper dispatch` is a ONE-SHOT Bash call (optionally `--dry-run` first). It
is NOT a Monitor — dispatch has no snapshot / keeper-meta streaming mode. Run
it once and read the exit code.

## When this fires

The user asks to launch a single worker by hand. Two shapes:

1. **Plan form** — fire a worker against an on-board plan id:
   - *"fire a worker on fn-871-…-skills.2"*, *"manually dispatch the next
     task"*, *"launch a worker for fn-871-…-skills.2"* → `work::<task-id>`.
   - *"spawn a closer for fn-871-…-skills"*, *"close out fn-871-… by hand"*
     → `close::<epic-id>`.
2. **Free form** — launch an arbitrary one-off prompt in a worker:
   - *"run this one-off prompt in a worker"*, *"kick off a background worker
     that does X"* → `--prompt "<text>"` (or `--prompt-file <path>`).

The two forms are **mutually exclusive** — exactly one of (a `<verb>::<id>`
positional) or (`--prompt`/`--prompt-file`), never both.

**Near-miss exclusions — these are NOT this skill:**

- *"work on fn-N.M"* / *"do the next task"* with no "launch a worker out of
  band" framing → that is `/plan:work`, which runs the task in THIS session.
  Dispatch is for spawning a SEPARATE worker by hand.
- *"approve fn-X"*, *"retry the dispatch"*, *"pause / unpause the autopilot"*
  → that is `keeper:autopilot` (`keeper autopilot retry approve::…`), NOT a
  dispatch.
- *"plan a feature"* / *"make a plan"* → `/plan:plan`.

## Parse the request

Extract the form and its argument. Plan form takes a `<verb>::<id>`
positional; free form takes a prompt source. Map intent to the exact
invocation — never "pass any valid flags":

| Intent | How to derive | `keeper dispatch` form |
|---|---|---|
| Fire a worker on a task | A keeper plan **task** id `fn-N-slug.M`. Verb is `work`. | `keeper dispatch work::fn-N-slug.M` |
| Spawn a closer for an epic | A keeper plan **epic** id `fn-N-slug`. Verb is `close`. | `keeper dispatch close::fn-N-slug` |
| Run a one-off prompt | Inline prompt text. Mutually exclusive with the positional. | `keeper dispatch --prompt "<text>"` |
| Run a one-off prompt from a file | The prompt lives in a file (or is large — see the 96 KB cap below). | `keeper dispatch --prompt-file <path>` |

Optional flags (both forms unless noted):

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the resolved launch plan (`session` / `cwd` / `key` / `prompt-from` / `argv`) and launch NOTHING. Run this first to preview. |
| `--session <s>` | Target tmux session (overrides every fallback). Default precedence: `--session` > `$KEEPER_TMUX_SESSION` > `$TMUX` current > `work`. |
| `--cwd <dir>` | Free form only: working dir (defaults to `process.cwd()`). Plan form resolves cwd from the board. |
| `--model <m>` | Pass `--model` through to claude. |
| `--effort <e>` | Pass `--effort` through to claude. |
| `--name <n>` | Free form only: a PURE claude pass-through, NOT a keeper label (see Guardrails). Plan form bakes `--name <verb>::<id>` automatically — never set it there. |
| `--no-prefix` | Free form only: bypass the configured `dispatch_prompt_prefix`. |
| `--force` | Plan form only: skip the race guard. **Human-gated** — never a default. |

If the user gives a slug-less reference ("dispatch the OAuth task") and you
can't resolve it to an exact id, ask. Do not invent ids.

## Step 1 — Pre-check the plan target (plan form only)

For a plan-form launch, verify the id is on-board and workable BEFORE
dispatching — a doomed dispatch wastes a worker window. Free form has no
board target, so skip straight to Step 2.

```bash
keeper plan show <id> --format json
```

Refuse to dispatch (and tell the user) when:

- **Nonexistent** — `keeper plan show` exits non-zero / `success: false`. The
  id doesn't exist; ask the user to double-check.
- **Already done** — the task `runtime_status == "done"` or the epic
  `status == "done"`. There's nothing to dispatch.

`resolvePlanCwd` reads the same `epics` projection, so an id the board
doesn't carry yet (daemon hasn't folded it) will fail the launch with a
`no epic '<id>' in the board` message — the pre-check catches it early.

## Step 2 — Dry-run to preview (recommended)

Run with `--dry-run` first to see exactly what will launch. It prints the
resolved plan and exits 0 without spawning anything:

```bash
keeper dispatch --dry-run work::fn-N-slug.M
```

```
session:     autopilot
cwd:         /abs/path/to/repo
key:         work::fn-N-slug.M
prompt-from: plan
argv:        ["/bin/zsh","-l","-i","-c", … ,"/plan:work fn-N-slug.M"]
```

(Free form omits the `key:` line and shows `prompt-from: --prompt` or
`prompt-from: file <path>`.) Confirm the `session` / `cwd` / prompt are what
the user wants before the real launch.

## Step 3 — Dispatch

Drop `--dry-run` to actually launch:

```bash
keeper dispatch work::fn-N-slug.M
```

On success it prints `dispatched <label> → session <session>` and exits 0
(plus a `tmux attach -t <session>` hint when launched outside tmux into the
`work` session). Surface that line to the user.

### The race-guard refusal (plan form)

Plan form runs a best-effort race guard before launching. It refuses with
exit 1 and a `refusing to dispatch <verb>::<id>: <reason> (pass --force to
override)` line when any of:

- **a pending dispatch** for the key is already in flight, or
- **autopilot is unpaused** — `autopilot is unpaused — it may dispatch this
  key itself; pause it or pass --force`, or
- **a live job** for the key already occupies a slot.

The unpaused-autopilot refusal is the most likely one. **Surface the refusal
to the user and ASK how to proceed — never auto-pause and never pass `--force`
on your own.** Offer the two options:

1. Pause the autopilot first (via **`keeper:autopilot`**), then re-run the
   dispatch — the clean path when you want the autopilot out of the way.
2. Pass `--force` to skip the guard for this one launch — only when the user
   explicitly confirms it. `--force` is human-gated; it is never a skill
   default.

## Exit taxonomy

| Exit | Meaning | Your action |
|---|---|---|
| 0 | Dispatched (or `--dry-run` previewed). | Surface the `dispatched …` line. |
| 1 | Resolution / launch failure (`die`). | Read the `dispatch: …` message. **Distinguish:** an unknown-id / not-on-board failure (`no epic '…' in the board`, `no task '…' under epic '…'`, empty-cwd) means the target is wrong — re-check the id. A `cwd-missing: <path>` failure means the resolved repo dir no longer exists on disk (typically a renamed-away repo) — fix with `keeper plan mv-repo <old> <new>` (rewrites the board's `primary_repo` / `target_repo` / `touched_repos`), then re-dispatch. A daemon-unreachable failure (`cannot reach daemon to resolve cwd (…)`) means keeperd is down — surface that. The race-guard refusal is also exit 1 — handle it via Step 3's surface-and-ask. |
| 2 | Arg fault. | Mode misuse (both forms, or neither), a malformed `<verb>::<id>` key, or the prompt cap (NUL byte / over 96 KB) — for a large prompt, route it to `--prompt-file`. |

## Examples

### Fire a worker on a task (plan form)

> User: "Manually fire a worker on fn-871-…-skills.2."

1. `keeper plan show fn-871-…-skills.2 --format json` → task exists,
   `runtime_status != "done"`. Proceed.
2. `keeper dispatch --dry-run work::fn-871-…-skills.2` → confirm session / cwd.
3. `keeper dispatch work::fn-871-…-skills.2`.
   - If it refuses with `autopilot is unpaused …` → surface it and ask: pause
     via `keeper:autopilot` then retry, or `--force` (user confirms). Do NOT
     auto-pause.
   - On success → report the `dispatched …` line.

### Spawn a closer for an epic (plan form)

> User: "Spawn a closer for fn-871-…-skills."

1. `keeper plan show fn-871-…-skills --format json` → epic exists,
   `status != "done"`. Proceed.
2. `keeper dispatch close::fn-871-…-skills` (race-guard handling as above).

### Run a one-off prompt (free form)

> User: "Kick off a background worker that audits the README links."

1. No board pre-check — free form has no plan target.
2. `keeper dispatch --prompt "Audit every link in README.md and report
   broken ones."`.
3. On exit 0 → report the dispatched line. If exit 2 reports the 96 KB cap,
   write the prompt to a file and re-run with `--prompt-file <path>`.

## What NOT to do

- Do not use this for routine plan execution — *"work on fn-N.M"* with no
  "launch a worker out of band" framing is `/plan:work` in THIS session, not a
  dispatch.
- Do not auto-pause the autopilot to clear the race guard, and do not pass
  `--force` on your own. Surface the refusal and ask (pause via
  `keeper:autopilot` then retry, or `--force` on explicit confirmation).
- Do not pass BOTH a `<verb>::<id>` positional AND `--prompt`/`--prompt-file`
  — the forms are mutually exclusive (exit 2).
- Do not set `--name` in plan form — it bakes `--name <verb>::<id>`
  automatically so the SessionStart hook binds a board-visible jobs row.
- Do not treat free-form `--name` as a keeper label — it is a PURE claude
  pass-through, forwarded verbatim and nothing else. In particular do NOT pass
  a `verb::id`-shaped `--name` in free form: keeper's SessionStart hook
  scrapes any `claude --name` keeper-wide, so it would still bind to that plan
  row and corrupt the board.
- Do not wrap `keeper dispatch` in a Monitor — it is a one-shot Bash call with
  no streaming mode.
- Do not skip the `keeper plan show` pre-check for a plan-form launch — a
  doomed dispatch against an unknown / done id wastes a window.
- Do not pass a prompt over 96 KB (or containing a NUL byte) via `--prompt` —
  it exits 2. Route large prompts to `--prompt-file`.
- Do not invent ids. If the user's reference is slug-less and ambiguous, ask.

## Guardrails

- **Precisely-triggered, conservative by default.** This is a manual operator
  surface — the everyday paths are the autopilot or `/plan:work`. Reach for it
  on a clear request to launch a worker by hand, not for routine execution.
- **Surface-and-ask on the race guard.** The skill never auto-pauses and
  never self-arms `--force`. It surfaces the refusal verbatim and asks.
- **One worker per call.** `keeper dispatch` fires exactly one window. To
  launch several, the user repeats the call (or lets the autopilot do its
  job).
