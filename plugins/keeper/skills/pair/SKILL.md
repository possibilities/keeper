---
name: pair
description: >-
  Pair with another model CLI — fan ONE task out to claude, codex, or pi, wait in
  silence, then read its answer. Use when the user wants a second opinion, a
  cross-check, or to "ask claude / ask codex / ask another model", a code
  review or co-plan from a different model, or a read-only audit by a partner —
  even when they never say "keeper" or "pair". Driven from THIS session's
  Monitor tool: launch `keeper pair send`, do nothing until the terminal
  notification, then read the `--output` file. NOT for launching a keeper
  worker on plan work (that is `keeper:dispatch`), NOT for messaging another
  RUNNING agent (that is `keeper:bus`), NOT for a multi-model consensus panel
  (that is `/plan:panel`, which itself fans out via this).
allowed-tools: Bash, Monitor
argument-hint: <what to ask> [--preset <name> | --cli claude|codex|pi] [--role …] [--read-only] | panel start|wait
---

# pair

`keeper pair send` fans ONE task out to another model CLI — `claude`, `codex`, or
`pi` — launched as a detached **interactive TUI** partner via `keeper agent`,
waits for it to stop, and writes the partner's final answer to a `--output` file.
It is keeper's pairing surface: a second opinion, a cross-vendor cross-check, a
code review or co-plan from a different model, or a read-only audit. For a codex
partner keeper seeds the cwd's codex directory-trust before launch (fail-open) so
the interactive window never hangs on codex's "trust this directory?" prompt; a
pi partner launches with `-na` (`--no-approve`) instead, ignoring the cwd's
project-local `.pi/` resources so it likewise never stalls on pi's trust prompt.

How you drive it depends on where you run. From the **main session**, use the
**Monitor tool** (below): the partner runs in its own detached window for as
long as its turn takes, and a Monitor lets you launch it and go genuinely idle
until it finishes instead of blocking a Bash call for minutes. From a
**subagent** — which has no Monitor tool — drive the same command with a single
**blocking Bash call** instead (see *From a subagent*). Either way `keeper pair`
emits a strict two-line event contract on stdout — exactly one
`[keeper-pair] started …` line, then exactly one terminal line — and writes the
answer to `--output`.

## The Monitor-in-main pattern

This is the whole flow. Do it from the orchestrating (main) session:

1. **Write the prompt to a file.** Any non-trivial ask goes in a file — never
   inline a long prompt into argv (execve/ps limits, quoting). A scratch path
   is fine.
2. **Pick an `--output` path** for the answer YAML (a scratch path).
3. **Launch via Monitor**, watching for the terminal event:

   ```
   Monitor(
     command="keeper pair send /tmp/ask.md --cli codex --output /tmp/ans.yaml",
     description="pair codex",
     timeout_ms=3600000,
     persistent=false,
   )
   ```

   `keeper pair` writes the answer to `--output` and emits ONLY the event
   stream on stdout: `[keeper-pair] started …` immediately, then one terminal
   line — `[keeper-pair] completed …` (exit 0) or `[keeper-pair] failed …`
   (exit non-zero). The contract holds on EVERY path, including a Monitor
   timeout/SIGTERM. keeper never auto-closes the partner's tmux window — it stays
   open for inspection (`tmux attach -t pair`) until you close it by hand.
4. **Wait in silence.** Do NOT poll, do NOT spin, do NOT tail the output file.
   Hand back to the human or do other work until the Monitor notification
   arrives. The partner's turn can take minutes; that is normal.
5. **On `completed`, read `--output`.** Only then. The file is written
   atomically (temp-then-rename) and `completed` fires only after the rename,
   so the moment you see it the file is complete.

## From a subagent (blocking Bash)

A subagent cannot use the Monitor tool — but it does not need to. Run the SAME
`keeper pair send` as a single **foreground blocking Bash call**: it blocks for
the partner's whole turn, returns when the partner stops, and you read the
answer from `--output` exactly as above.

```
keeper pair send /tmp/ask.md --cli codex --read-only --output /tmp/ans.yaml
# blocks until the partner stops, then exits 0 — read /tmp/ans.yaml
```

The `[keeper-pair]` event lines print to stdout and are harmless to ignore — the
answer lands in `--output`. One bound to respect: the Bash tool caps a single
call at 10 minutes, while `keeper pair --timeout` defaults to 30. For a partner
that may run longer than ~10 minutes, launch `keeper pair send` in the
**background** and poll the `--output` file for the answer (it appears
atomically, only once complete) rather than holding one blocking call open.

## Reading the answer

`--output` is YAML. The fields:

- `message` — the partner's final assistant message. This is the answer.
- `cli` / `role` — what you asked and how.
- `transcript_path` — the partner's per-backend transcript JSONL, the
  drill-down for the FULL conversation when `message` alone isn't enough. Read
  it only if you need to see the partner's reasoning/steps, not just its
  conclusion.
- `handle` — the `keeper agent` launch handle (correlation id).
- `elapsed_seconds` — wall time of the partner's turn.
- `read_only` / `changed_files` / `read_only_violation` — present only on a
  read-only run; see below.

A terminal `failed` means no usable answer — surface the `error=…` field from
the event line (launch failure, wait timeout, a partner that produced no
final message, or `self-transcript-collision` — the resolver matched the
DRIVER's own transcript instead of the partner's, so the answer is rejected
rather than returned as a bogus `completed`) to the human rather than reading a
stale/absent output file. The partner always gets a pinned, non-colliding
transcript, so `self-transcript-collision` is a fail-loud backstop, not an
expected path.

## Choosing the partner

| Flag | Meaning |
|---|---|
| `--preset <name>` | Named launch-config preset from the catalog `~/.config/keeper/presets.yaml` — supplies the harness + model/effort in one token (the recommended interface). Must be a real catalog entry: an unknown name or missing catalog exits 2 (run `keeper agent presets list` to see the configured names). Drives the claude/codex/pi orchestration from the preset's `harness` and its optional `role`. pi pairs too (a pi preset uses `thinking:`, never `effort:`); only a `--cli` whose harness disagrees with the preset fails loud. A claude preset's `effort` is honored — the launcher pushes `--effort` from the preset on the interactive claude pair path; a codex preset's effort is honored too. |
| `--cli claude\|codex\|pi` | The partner CLI. **Required unless `--preset` is given** (then a compatibility alias whose harness must agree with the preset). All three launch as an interactive TUI; codex gets its cwd directory-trust pre-seeded (fail-open), and pi launches with `-na` (ignore project-local `.pi/` resources), so neither stalls on a trust prompt. Reach for a DIFFERENT vendor than yourself when the user wants genuine diversity / a true second opinion. |
| `--model <m>` | Native model id, passed through (`claude`/`pi` `--model`, `codex -m`). Omit for the CLI's default. With `--preset` the launcher owns model resolution. |
| `--effort <e>` | Reasoning effort — **codex only** (passing it with `--cli claude` is an arg fault). |
| `--role <r>` | Role prompt: `default` \| `planner` \| `codereviewer` \| `coplanner`. Pick `codereviewer` for "review this", `coplanner`/`planner` for "help me plan", `default` otherwise. |
| `--read-only` | Read-only posture (see below). Use for any audit / review / second-opinion where the partner should NOT touch the tree. |
| `--session <s>` | Target tmux session for the partner window. Defaults to `pair` (panel legs use `panels`). keeper never auto-closes the window: the CLI captures the answer synchronously and leaves the window **open + interactive** for inspection (`tmux attach -t pair`) until you close it by hand. Usually omit. |
| `--timeout <s>` | Wait timeout in seconds (default 1800). It is authoritative for the partner stop wait: keeper threads it onto the in-process stop-wait (`--stop-timeout-ms`, overriding the 600s default), so a 10–30 min turn no longer dies at 10 min. On timeout the run emits `failed`; the partner window stays open for inspection. |

If the user's ask is slug-less or ambiguous about which CLI/role, pick a
sensible default (a cross-vendor partner, `default` role) and say what you
chose — don't stall.

## Read-only posture (detection, not prevention)

`--read-only` is **layered, and honest about its limits**:

- It prepends a read-only directive to the prompt (the primary guard),
- strips edit tools per-CLI (claude `--disallowed-tools Edit,Write,…`; pi
  `--exclude-tools edit,write`; codex keeps web search — pi `bash` stays leaky,
  so the strip is reinforcement, not a sandbox), and
- snapshots `git status` in the partner's cwd around the turn as a backstop.

It is **detection, not prevention**: a tool strip + directive do not stop Bash
writes or `git` inside the partner. If the partner writes anyway, the run
surfaces it — `changed_files` and a `read_only_violation` list land in the
output YAML and a WARNING prints. Treat a `read_only_violation` as a real
signal that the partner bypassed the posture, not noise. Use `--read-only` for
any "just look / just review / don't change anything" ask, but know the
guarantee is best-effort.

## Panel fan-out (`panel start|wait`)

`keeper pair panel` is the cross-OS sub-verb the `plan:panel-runner` agent drives to fan ONE question
out to a whole panel of models at once. It is the multi-leg sibling of `send`: `send` pairs with one
partner; `panel` resolves a set of members and launches each as its own detached read-only `send` leg,
then waits for them all token-free. It runs identically on macOS and Linux — all detachment and polling
live in the binary, with no `setsid`/`timeout`/`gtimeout` on the path. Two operations:

```
keeper pair panel start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]
keeper pair panel wait  --dir <d> [--chunk <s>]
```

- **`start`** resolves the panel members from `~/.config/keeper/panel.yaml` (each a preset in the catalog
  `~/.config/keeper/presets.yaml`; a missing/invalid config or unknown panel exits 2 — `keeper agent
  presets list` shows what is configured), mints a scratch dir, copies the prompt in, launches every member as
  a detached `keeper pair send --read-only` leg in the `panels` session, writes `<dir>/manifest.json`,
  prints it, and **exits 0 immediately** — it never blocks. Stdout is one line of manifest JSON:
  `{"dir":"…","members":[{"name","harness","yaml","log","pidfile"},…]}`. Capture `.dir` for the wait.
- **`wait`** re-reads the manifest and blocks ONE `--chunk` window (default 540s, max 570 — one Bash call
  is capped at 600s) polling each leg's terminality, then prints the verdict JSON:
  `{"dir":"…","ok":<bool>,"members":[{"name","harness","status":"ok|fail","yaml","reason"},…]}`.

Exit semantics drive the agent's re-issue loop:

| Exit | `start` | `wait` |
|---|---|---|
| 0 | legs launched; manifest printed | every leg terminal; verdict printed |
| 124 | — | the chunk elapsed before all legs finished — **re-issue `wait`** |
| 2 | bad flags / unreadable prompt / a panel that resolves to zero members / an undefined preset / a non-pairable harness | a missing or corrupt manifest, or bad flags |

`wait` **exit 0 means all-terminal, NOT all-success** — key off the verdict's `ok` flag, which is true
iff every member produced its output `.yaml`. The verdict is content-blind: `wait` reads each `.yaml`
only for existence and each `.log` only for the wrapper's own `[keeper-pair]` event / `pair:` arg-fault
lines, never a panelist's answer. The per-member `reason` on a `fail` is that wrapper-sourced diagnostic.

The human-facing `PANEL_RUN_FAILED` marker is owned by the **`plan:panel-runner` agent**, not this
subcommand: the agent emits it (with the failing legs' reasons and the scratch dir) whenever `start`
exits non-zero or the verdict's `ok` is false, and otherwise spawns `plan:panel-judge` with the per-member
`.yaml` paths. Run `keeper pair panel --help` for the full option list.

## What NOT to do

- From the **main session**, do NOT run `keeper pair send` as a plain blocking
  Bash call — drive it through the **Monitor** tool so you can go idle while the
  partner works. (A **subagent** has no Monitor and correctly DOES use a blocking
  Bash call — see *From a subagent*.)
- Do NOT poll, tail, or `cat` the `--output` file before the `completed`
  event. It may be absent or half-written until the rename; the event is your
  go-signal.
- Do NOT pass `--effort` with `--cli claude` — it is codex-only (arg fault,
  exit 2).
- Do NOT inline a long prompt into argv — write it to a file and pass the path.
- This is NOT `keeper:dispatch` (launch a keeper WORKER on plan work), NOT
  `keeper:bus` (message an already-running agent), and a multi-model consensus
  panel is `/plan:panel` (which itself fans out via `keeper pair`). Reach for
  `pair` when the user wants a one-shot answer/opinion from another model.
