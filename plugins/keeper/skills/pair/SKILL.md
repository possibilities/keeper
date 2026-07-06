---
name: pair
description: >-
  Pair with another model CLI — fan ONE task out to claude, codex, pi, or
  hermes, wait, then read its answer. Use when the user wants a second opinion, a cross-check,
  or to "ask claude / ask codex / ask another model", a code review or co-plan
  from a different model, or a read-only audit by a partner — even when they
  never say "keeper" or "pair". Drives `keeper agent` from THIS session: a
  blocking `agent run` for a quick single-shot, or a detached `agent panel
  start` + chunked blocking `agent panel wait` loop for a longer or multi-model
  ask, then reads the partner's JSON answer envelope. NOT for launching a keeper
  worker on plan work (that is `keeper:dispatch`), NOT for messaging another
  RUNNING agent (that is `keeper:bus`), NOT for a multi-model consensus panel
  (that is `/plan:panel`, which itself fans out via this).
allowed-tools: Bash
argument-hint: <what to ask> [--preset <name> | --cli claude|codex|pi|hermes] [--role …] [--read-only]
---

# pair

Pairing fans ONE task out to another model CLI — `claude`, `codex`, `pi`, or
`hermes` — launched as a detached **interactive TUI** partner via `keeper agent`,
and reads the partner's final answer back as a uniform JSON envelope. It is
keeper's pairing surface: a second opinion, a cross-vendor cross-check, a code
review or co-plan from a different model, or a read-only audit. Each harness that
needs a first-use consent step is pre-seeded so the window never stalls, all
fail-open: for a codex partner keeper seeds the cwd's codex directory-trust
before launch so it never hangs on codex's "trust this directory?" prompt; a pi
partner launches with `-na` (`--no-approve`), ignoring the cwd's project-local
`.pi/` resources so it likewise never stalls on pi's trust prompt; a hermes
partner has its shell-hook allowlist + keeper events-shim pre-seeded so it
reports live state with no interactive hook-approval prompt (degrading to
presence-only tracking if the seed can't be written).

You wait with **blocking Bash calls**, never a Monitor — a blocking call bills
zero tokens while it blocks (the model is suspended between emitting the tool_use
and receiving the tool_result). There are two shapes:

- **Quick single-shot** (`agent run`) — one blocking call that returns the answer
  when the partner stops. Use it for a partner expected to finish within ~10
  minutes.
- **Detached + chunked wait** (`agent panel start` + `agent panel wait`) — launch
  the partner detached, then re-issue a bounded blocking `wait` loop. Use it for
  a longer partner (past Bash's 10-minute single-call cap) or to fan the same ask
  out to several models at once.

## Quick single-shot (`agent run`)

For a partner that will finish within ~10 minutes, one blocking Bash call does
the whole job — it launches, waits for the partner to stop, and writes the JSON
answer envelope to `--output`:

```bash
keeper agent run codex "$(cat /tmp/ask.md)" --read-only --output /tmp/ans.json
# blocks until the partner stops, then exits 0 — read /tmp/ans.json
```

- Write any non-trivial ask to a file and pass its contents as the prompt
  positional — never hand-inline a long prompt (quoting, execve/ps limits).
- `--output <path>` gets the uniform envelope (see *Reading the answer*) on EVERY
  outcome, exit-code-independent. Read it once the call returns 0.
- The Bash tool caps one call at 10 minutes. For a partner that may run longer,
  do NOT hold a blocking call open — use the detached shape below (or run the
  `agent run` in the background and poll `--output`, which appears atomically
  only once complete).

## Detached + chunked wait (`agent panel start|wait`)

`keeper agent panel` launches each partner as a **detached read-only leg** and
lets you wait for it across bounded blocking calls — the same engine
`/plan:panel` drives. A single `--cli`/`--preset` member is pairing as a panel of
one; a named `--panel` fans the ask out to several models at once. Both run
identically on macOS and Linux — all detachment and polling live in the binary,
no `setsid`/`timeout`/`gtimeout` on the path.

**1. Write the prompt to a file** (a scratch path is fine):

```bash
PROMPT=$(mktemp /tmp/pair.XXXXXX.md)
cat > "$PROMPT" <<'EOF'
<your ask, verbatim>
EOF
```

**2. Start the partner detached.** `start` is **idempotent by slug** — it writes
durable per-slug state at `~/.local/state/keeper/panels/<slug>/`, launches the
leg(s), writes `<dir>/manifest.json`, prints it, and **exits 0 immediately** (it
never blocks). Re-issuing the same `start --slug <slug>` with the same prompt
reconciles the existing run (reuse terminal legs, leave running ones, relaunch
no-result ones) instead of re-fanning-out; a colliding prompt or member-set exits
2:

```bash
MANIFEST=$(keeper agent panel start "$PROMPT" --slug oauth-review --cli codex --read-only)
START_RC=$?
DIR=$(echo "$MANIFEST" | jq -r '.dir')
```

- `--slug` is **required** — a short kebab run id (`[a-z0-9-]`) you auto-derive
  from the ask (each leg launches as `panel::<slug>::<preset>`, keeping the run
  identifiable in tmux + forensics). Pick a sensible default, don't stall.
- The manifest is `{"dir":"…","slug":"…","members":[{"name","harness","yaml","pidfile"},…]}`.
  Capture `DIR`; every `wait`/`status` re-reads it — or address the run by `--slug
  <slug>`, the durable form that survives a restart. Each member's `yaml` is that
  leg's answer-envelope path.
- Pick the member with `--cli <claude|codex|pi|hermes>` (a bare harness, add `--model` /
  `--effort` / `--role` as needed) or `--preset <name>` (a catalog preset), or
  fan out with `--panel <name>`. `--panel` and `--preset`/`--cli` are mutually
  exclusive. An absent/empty `--slug`, a misconfigured/unknown panel, an undefined
  preset, a non-pairable harness, or an unreadable prompt exits 2 with no leg
  launched.

**3. Wait token-free (re-issue loop).** Each `wait` blocks ONE `--chunk` window
(default 540s ≤ 9 min, safely under Bash's 10-min single-call cap), then exits:
**0** = every leg terminal (verdict JSON on stdout), **124** = the chunk elapsed
(re-issue it), **2** = a missing/corrupt manifest or bad flags. Bound the loop
with a backstop so a wedged leg never loops forever:

```bash
BACKSTOP=6      # ~54 min of 9-min chunks; a leg still running this late is wedged
VERDICT=""
n=0
while [ "$n" -lt "$BACKSTOP" ]; do
  VERDICT=$(keeper agent panel wait --run-dir "$DIR" --chunk 540)
  WAIT_RC=$?
  [ "$WAIT_RC" -eq 0 ] && break                            # all legs terminal
  [ "$WAIT_RC" -eq 124 ] && { n=$(( n + 1 )); continue; }  # chunk elapsed — re-issue
  break                                                    # exit 2 — a failure
done
```

Each `wait` is a single blocking Bash call — token-free while it blocks; the
subcommand polls internally on a `Date.now()` deadline, so you never re-invoke
yourself between chunks. Never poll at the model level (re-invoking yourself every
few seconds) — that is the one thing that actually burns tokens.

**4. Read the verdict, then each answer.** On exit 0, `VERDICT` is
`{"dir":"…","ok":<bool>,"members":[{"name","harness","status":"ok|fail","yaml","reason"},…]}`.
`wait` **exit 0 means all-terminal, NOT all-success** — key off `ok` (true iff
every member wrote a `completed` result). The verdict is content-blind (it reads
each result only for its `outcome`); the actual answer lives in each member's
`yaml` envelope. For an `ok` verdict, read each member's answer:

```bash
echo "$VERDICT" | jq -r '.members[].yaml'   # → read + parse each as JSON
```

On `ok == false` (or a non-124 `wait` exit, or `BACKSTOP` exhausted), surface the
failing members' `reason` fields (each is that leg's terminal `outcome` —
`timed_out`, `no_message`, `launch_failed`, `bad_args` — or a corrupt/crashed-leg
note) to the human rather than reading a stale answer file.

**Re-entry & housekeeping.** The run's state is durable and slug-keyed, so a
restarted session re-attaches from the slug alone: `keeper agent panel wait --slug
<slug>` is the preferred re-entry form (no `$DIR` to carry across the restart). If a
`wait` verdict carries a `machine-rebooted` reason (a reboot killed the legs mid-wait,
returned promptly instead of spinning), re-issue `keeper agent panel start … --slug
<slug>` — its idempotent reconcile relaunches the dead legs — then `wait` again. And
`keeper agent panel status --slug <slug>` is a one-shot NON-blocking snapshot
(per-leg `completed|running|failed|absent`, no verdict wait). `keeper agent panel
prune` GCs aged-out terminal run dirs under the panels root — never a live or
in-reconcile run — for occasional housekeeping.

## Reading the answer

Each partner's `--output` (or a panel member's `yaml`) is the uniform
schema-versioned JSON envelope. The fields:

- `message` — the partner's final assistant message. This is the answer (empty
  string on a tool-only/refusal turn).
- `message_found` — whether a final message was present.
- `transcript_path` — the partner's per-backend transcript JSONL, the drill-down
  for the FULL conversation when `message` alone isn't enough. Read it only if you
  need the partner's reasoning/steps, not just its conclusion.
- `handle` / `resume_target` — the `keeper agent` launch handle + resume key.
- `elapsed_seconds` — wall time of the partner's turn.
- `outcome` — `completed` / `no_message` (success), or `timed_out` /
  `no_transcript` / `launch_failed` / `bad_args` (no usable answer — surface it to
  the human).

## Choosing the partner

| Flag | Meaning |
|---|---|
| `--preset <name>` | Named launch-config preset from the catalog `~/.config/keeper/presets.yaml` — supplies the harness + model/effort in one token (the recommended interface). Must be a real catalog entry: an unknown name or missing catalog exits 2 (run `keeper agent presets list` to see the configured names). A preset's harness drives the claude/codex/pi orchestration and its optional role; only a `--cli` whose harness disagrees with the preset fails loud. |
| `--cli claude\|codex\|pi\|hermes` | The partner CLI. **Required unless `--preset` is given.** All four launch as an interactive TUI; codex gets its cwd directory-trust pre-seeded, pi launches with `-na` (ignore project-local `.pi/` resources), and hermes gets its shell-hook allowlist + events-shim pre-seeded — all fail-open, so none stalls on a consent prompt. Reach for a DIFFERENT vendor than yourself when the user wants genuine diversity / a true second opinion. |
| `--model <m>` | Native model id, passed through (`claude`/`pi` `--model`, `codex`/`hermes` `-m`). Omit for the CLI's default; with `--preset` the launcher owns model resolution. |
| `--effort <e>` | Reasoning effort — **codex only** (passing it with a claude/pi/hermes member is an arg fault; hermes is model-only, pi takes thinking not effort). |
| `--role <r>` | Role prompt: `default` \| `planner` \| `codereviewer` \| `coplanner` (rides the leg as a `--system` block on the panel path). Pick `codereviewer` for "review this", `coplanner`/`planner` for "help me plan", `default` otherwise. |
| `--read-only` | Read-only posture (see below). Use for any audit / review / second-opinion where the partner should NOT touch the tree. |

If the user's ask is slug-less or ambiguous about which CLI/role, pick a sensible
default (a cross-vendor partner, `default` role) and say what you chose — don't
stall.

## Read-only posture (prompting-only)

`--read-only` is **prompting-only, and honest about its limits**: it prepends a
read-only directive to the partner's prompt and relies on the model following it.
keeper enforces nothing — there is no tool strip and no git audit, so nothing
stops Bash writes or `git` inside the partner if it ignores the directive. Use
`--read-only` for any "just look / just review / don't change anything" ask, but
know the guarantee is best-effort.

## What NOT to do

- Do NOT poll, tail, or `cat` an answer file before the run/wait returns. It may
  be absent or half-written until the atomic rename; the call's exit is your
  go-signal.
- This is NOT `keeper:dispatch` (launch a keeper WORKER on plan work), NOT
  `keeper:bus` (message an already-running agent), and a multi-model consensus
  panel is `/plan:panel` (which itself fans out via this). Reach for pairing when
  the user wants a one-shot answer/opinion from another model.
