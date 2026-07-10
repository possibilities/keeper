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
(via the in-binary `keeper agent` launcher), parallel to — and independent of — the server-side autopilot
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
| `--preset <triple>` | A launch triple `<harness>::<model>::<effort>` (claude-only — a codex/pi triple is an arg fault). Must be well-formed (exit 2 otherwise; run `keeper agent presets list` to see the enumerable cube). Supplies `--model`/`--effort`. Plan form defaults to the SAME `worker` triple the autopilot resolves, so a hand-fired plan worker is byte-identical to an automated one; `--model`/`--effort` override per field. |
| `--model <m>` | Pass `--model` through to claude (overrides the triple). |
| `--effort <e>` | Pass `--effort` through to claude (overrides the triple). |
| `--name <n>` | Free form only: a PURE claude pass-through, NOT a keeper label (see *What NOT to do*). Plan form bakes `--name <verb>::<id>` automatically — never set it there. |
| `--no-prefix` | Free form only: bypass the configured `dispatch_prompt_prefix`. |
| `--force` | Plan form only: skip the race guard. **Human-gated** — never a default. |

If the user gives a slug-less reference ("dispatch the OAuth task") and you
can't resolve it to an exact id, ask. Do not invent ids.

## Orient first

<!-- POINTER: keeper prompt render engineering/orient -->

Before firing a worker, read the board in one call: `keeper status --json`
prints autopilot config (`{paused, mode, …}`), per-row readiness verdicts,
counts, `drained`/`jammed`, in-flight launches, and needs-human in a single
envelope (exit 0 on any board state). The `data.autopilot.paused` flag tells
you up front whether the race-guard refusal in Step 3 is coming (an unpaused
autopilot may dispatch the key itself), and the readiness verdict confirms the
target is workable. For the full orient step run `keeper prompt render
engineering/orient`. Then verify the specific id in Step 1.

## Step 1 — Pre-check the plan target (plan form only)

For a plan-form launch, verify the id is on-board and workable BEFORE
dispatching — a doomed dispatch wastes a worker window. Free form has no
board target, so skip straight to Step 2.

Read the LIVE board, never a `keeper plan show` file read: a `work::<task>` id
resolves in `keeper query tasks --json` (its row carries `runtime_status` + the
readiness verdict), a `close::<epic>` id in `keeper status --json` under
`data.board.epics[]` (carrying the epic `status`) — the same board the orient
step already fetched.

Refuse to dispatch (and tell the user) when:

- **Off-board** — the id is in neither read (nonexistent, or already completed
  and closed off). Ask the user to double-check.
- **Already done** — the task row's `runtime_status == "done"` or the epic's
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
  key itself; pause it first`, or
- **a running worker** occupies the slot — `a live worker for <key> is running
  (job state=working); let it finish`, or
- **a stopped worker** still holds the slot — `a stopped worker for <key> still
  holds the slot (job state=stopped); warm-resume its session over the bus, or
  reclaim the dead pane`.

Every refusal names the right-path recovery BEFORE `--force`. **Surface the
refusal to the user and ASK how to proceed — never auto-pause, never
warm-resume, and never pass `--force` on your own.** Match the recovery to the
reason:

1. **Unpaused autopilot** (the most likely one) → pause it first (via
   **`keeper:autopilot`**), then re-run — the clean path when you want the
   autopilot out of the way.
2. **A stopped worker** → warm-resume its session over the bus (**`keeper:bus`**)
   if it is still live, or reclaim the dead pane; only then consider `--force`.
3. **`--force`** → skip the guard for this one launch — only when the user
   explicitly confirms it. It is human-gated; never a skill default.

**Boot-window duplicate (accepted).** A manual `close::` spawned while a
reconciler closer is still booting can both start — the CLI has no sanctioned
pre-announce write path, so this narrow race costs one wasted boot. It is
harmless: the close-preflight claim step fails the second closer loud with a
typed `CLOSE_ALREADY_CLAIMED`, and `close-finalize` is idempotent.

## Exit taxonomy

| Exit | Meaning | Your action |
|---|---|---|
| 0 | Dispatched (or `--dry-run` previewed). | Surface the `dispatched …` line. |
| 1 | Resolution / launch failure (`die`). | Read the `dispatch: …` message. **Distinguish:** an unknown-id / not-on-board failure (`no epic '…' in the board`, `no task '…' under epic '…'`, empty-cwd) means the target is wrong — re-check the id. A `cwd-missing: <path>` failure means the resolved repo dir no longer exists on disk (typically a renamed-away repo) — fix with `keeper plan mv-repo <old> <new>` (rewrites the board's `primary_repo` / `target_repo` / `touched_repos`), then re-dispatch. A daemon-unreachable failure (`cannot reach daemon to resolve cwd (…)`) means keeperd is down — surface that. The race-guard refusal is also exit 1 (including a `stopped worker … warm-resume … or reclaim` occupancy refusal) — handle it via Step 3's surface-and-ask. |
| 2 | Arg fault. | Mode misuse (both forms, or neither), a malformed `<verb>::<id>` key, or the prompt cap (NUL byte / over 96 KB) — for a large prompt, route it to `--prompt-file`. |

## Examples

### Fire a worker on a task (plan form)

> User: "Manually fire a worker on fn-871-…-skills.2."

1. `keeper query tasks --json` → the `fn-871-…-skills.2` row exists,
   `runtime_status != "done"`. Proceed.
2. `keeper dispatch --dry-run work::fn-871-…-skills.2` → confirm session / cwd.
3. `keeper dispatch work::fn-871-…-skills.2`.
   - If it refuses with `autopilot is unpaused …` → surface it and ask: pause
     via `keeper:autopilot` then retry, or `--force` (user confirms). Do NOT
     auto-pause.
   - On success → report the `dispatched …` line.

### Spawn a closer for an epic (plan form)

> User: "Spawn a closer for fn-871-…-skills."

1. `keeper status --json` → the `fn-871-…-skills` epic is on
   `data.board.epics[]`, `status != "done"`. Proceed.
2. `keeper dispatch close::fn-871-…-skills` (race-guard handling as above). For a
   worktree epic this runs the closer IN the epic lane (`keeper/epic/<id>`); when
   no lane worktree is registered it prints `dispatch: no epic lane worktree for
   '<epic>'; launching close in <dir>` and runs in the main checkout.

### Run a one-off prompt (free form)

> User: "Kick off a background worker that audits the README links."

1. No board pre-check — free form has no plan target.
2. `keeper dispatch --prompt "Audit every link in README.md and report
   broken ones."`.
3. On exit 0 → report the dispatched line. If exit 2 reports the 96 KB cap,
   write the prompt to a file and re-run with `--prompt-file <path>`.

## What NOT to do

- Do not treat free-form `--name` as a keeper label — it is a PURE claude
  pass-through. In particular do NOT pass a `verb::id`-shaped `--name` in free
  form: keeper's SessionStart hook scrapes any `claude --name` keeper-wide, so
  it would still bind to that plan row and corrupt the board.

## Guardrails

- **Surface-and-ask on the race guard.** The skill never auto-pauses,
  auto-resumes, or self-arms `--force` — it surfaces the refusal verbatim and
  asks, matching the recovery to the reason (pause via `keeper:autopilot`,
  warm-resume a stopped worker via `keeper:bus`, or `--force` on explicit
  confirmation).
