---
name: pair
description: >-
  Pair with another model CLI — fan ONE task out to claude or codex, wait in
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
argument-hint: <what to ask> [--cli claude|codex] [--role …] [--read-only]
---

# pair

`keeper pair send` fans ONE task out to another model CLI — `claude` or
`codex` — launched as a detached partner via agentwrap, waits for it to stop,
and writes the partner's final answer to a `--output` file. It is keeper's
pairing surface: a second opinion, a cross-vendor cross-check, a code review or
co-plan from a different model, or a read-only audit.

You drive it from **this session's Monitor tool**, not a plain Bash call. The
partner runs in its own detached window for as long as its turn takes; a
Monitor lets you launch it and then go genuinely idle until it finishes,
instead of blocking a Bash call for minutes. `keeper pair` emits a strict
two-line event contract on stdout — exactly one `[keeper-pair] started …` line,
then exactly one terminal line — which is precisely what a Monitor consumes.

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
     until="[keeper-pair] (completed|failed)",
   )
   ```

   `keeper pair` writes the answer to `--output` and emits ONLY the event
   stream on stdout: `[keeper-pair] started …` immediately, then one terminal
   line — `[keeper-pair] completed …` (exit 0) or `[keeper-pair] failed …`
   (exit non-zero). The contract holds on EVERY path, including a Monitor
   timeout/SIGTERM (it still emits `failed` and reaps the partner's tmux
   window).
4. **Wait in silence.** Do NOT poll, do NOT spin, do NOT tail the output file.
   Hand back to the human or do other work until the Monitor notification
   arrives. The partner's turn can take minutes; that is normal.
5. **On `completed`, read `--output`.** Only then. The file is written
   atomically (temp-then-rename) and `completed` fires only after the rename,
   so the moment you see it the file is complete.

## Reading the answer

`--output` is YAML. The fields:

- `message` — the partner's final assistant message. This is the answer.
- `cli` / `role` — what you asked and how.
- `transcript_path` — the partner's per-backend transcript JSONL, the
  drill-down for the FULL conversation when `message` alone isn't enough. Read
  it only if you need to see the partner's reasoning/steps, not just its
  conclusion.
- `handle` — the agentwrap launch handle (correlation id).
- `elapsed_seconds` — wall time of the partner's turn.
- `read_only` / `changed_files` / `read_only_violation` — present only on a
  read-only run; see below.

A terminal `failed` means no usable answer — surface the `error=…` field from
the event line (launch failure, wait timeout, or a partner that produced no
final message) to the human rather than reading a stale/absent output file.

## Choosing the partner

| Flag | Meaning |
|---|---|
| `--cli claude\|codex` | The partner CLI. **Required.** Reach for a DIFFERENT vendor than yourself when the user wants genuine diversity / a true second opinion. |
| `--model <m>` | Native model id, passed through (`claude --model` / `codex -m`). Omit for the CLI's default. |
| `--effort <e>` | Reasoning effort — **codex only** (passing it with `--cli claude` is an arg fault). |
| `--role <r>` | Role prompt: `default` \| `planner` \| `codereviewer` \| `coplanner`. Pick `codereviewer` for "review this", `coplanner`/`planner` for "help me plan", `default` otherwise. |
| `--read-only` | Read-only posture (see below). Use for any audit / review / second-opinion where the partner should NOT touch the tree. |
| `--session <s>` | Target tmux session for the partner window. Usually omit — it inherits a sane default. |
| `--timeout <s>` | Wait timeout in seconds (default 1800). On timeout the run emits `failed` and reaps the window. |

If the user's ask is slug-less or ambiguous about which CLI/role, pick a
sensible default (a cross-vendor partner, `default` role) and say what you
chose — don't stall.

## Read-only posture (detection, not prevention)

`--read-only` is **layered, and honest about its limits**:

- It prepends a read-only directive to the prompt (the primary guard),
- strips edit tools per-CLI (claude `--disallowed-tools Edit,Write,…`; codex
  keeps web search), and
- snapshots `git status` in the partner's cwd around the turn as a backstop.

It is **detection, not prevention**: a tool strip + directive do not stop Bash
writes or `git` inside the partner. If the partner writes anyway, the run
surfaces it — `changed_files` and a `read_only_violation` list land in the
output YAML and a WARNING prints. Treat a `read_only_violation` as a real
signal that the partner bypassed the posture, not noise. Use `--read-only` for
any "just look / just review / don't change anything" ask, but know the
guarantee is best-effort.

## What NOT to do

- Do NOT run `keeper pair send` as a plain blocking Bash call — drive it
  through the **Monitor** tool so you can go idle while the partner works.
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
