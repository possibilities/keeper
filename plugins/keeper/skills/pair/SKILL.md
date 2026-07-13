---
name: pair
description: >-
  Pair with another model CLI — fan ONE task out to claude, codex, or pi, wait,
  then read its answer; or resume a prior partner conversation by
  name instead of starting cold. Use when the user wants a second opinion, a
  cross-check, or to "ask claude / ask codex / ask another model", a code review
  or co-plan from a different model, a read-only audit by a partner, or to
  continue talking to a partner from earlier ("resume the codex session",
  "ask that partner a follow-up") — even when they never say "keeper" or "pair".
  Drives `keeper agent` from THIS session: a blocking `agent run` (optionally
  `--resume <name>`) for a quick single-shot, a detached `agent panel start` +
  chunked blocking `agent panel wait` loop for a longer or multi-model ask, or
  the interactive `agent resume <name>` verb to re-attach a dead partner — then
  reads the partner's JSON answer envelope. NOT for launching a keeper worker on
  plan work (that is `keeper:dispatch`), NOT for messaging another RUNNING agent
  (that is `keeper:bus`), NOT for a multi-model consensus panel (that is
  `/plan:panel`, which itself fans out via this).
allowed-tools: Bash
argument-hint: <what to ask> [--preset <harness::model::effort> | --cli claude|codex|pi] [--resume <name-or-id>] [--name <n>] [--role …] [--read-only]
---

# pair

Pairing fans ONE task out to another model CLI — `claude`, `codex`, or `pi` —
launched as a detached **interactive TUI** partner via `keeper agent`, and reads
the partner's final answer back as a uniform JSON envelope. It is
keeper's pairing surface: a second opinion, a cross-vendor cross-check, a code
review or co-plan from a different model, or a read-only audit. There are two
entry states: **fresh-launch** starts a brand-new partner conversation, and
**resume** continues a prior one by name instead of starting cold (see
*Resuming a partner* below). Each harness that needs a first-use consent step is
pre-seeded so the window never stalls, all fail-open: for a codex partner keeper
seeds the cwd's codex directory-trust before launch so it never hangs on codex's
"trust this directory?" prompt; a pi partner launches with `-na`
(`--no-approve`), ignoring the cwd's project-local `.pi/` resources so it
likewise never stalls on pi's trust prompt.

**Name your partners.** Pass `--name <n>` on a fresh launch so the partner is
resumable by name later — an unnamed partner is still resumable by job id, but
a name is far easier to recall and to hand to a follow-up turn. A `--resume`
launch ignores `--name`: the resumed partner keeps its original name.

You wait with **blocking Bash calls**, never a Monitor — a blocking call bills
zero tokens while it blocks (the model is suspended between emitting the tool_use
and receiving the tool_result). The Bash tool's *default* foreground window is
only `120000`ms (2 min) — a call that runs past it auto-backgrounds instead of
returning an error, silently ending the wait rather than raising it. Reaching
the tool's `600000`ms (10 min) per-call ceiling requires passing the tool's
`timeout` parameter explicitly on every blocking call below; there is no
config or env var that raises the default, only the per-call parameter. There
are two shapes:

- **Quick single-shot** (`agent run`) — one blocking call, issued with
  `timeout: 600000`, that returns the answer when the partner stops. Use it for
  a partner expected to finish within ~10 minutes.
- **Detached + chunked wait** (`agent panel start` + `agent panel wait`) — launch
  the partner detached, then re-issue one explicitly-timed blocking `wait` call
  per chunk. Use it for a longer partner (past the 600000ms per-call ceiling) or
  to fan the same ask out to several models at once.

## Quick single-shot (`agent run`)

For a partner that will finish within ~10 minutes, one blocking Bash call does
the whole job — it launches, waits for the partner to stop, and writes the JSON
answer envelope to `--output`. Issue it with the Bash tool's `timeout`
parameter set explicitly to `600000`:

```bash
keeper agent run codex "$(cat /tmp/ask.md)" --read-only --name codereview-1 --output /tmp/ans.json
# issue with Bash tool timeout: 600000 — blocks until the partner stops, then
# exits 0 — read /tmp/ans.json
```

- Write any non-trivial ask to a file and pass its contents as the prompt
  positional — never hand-inline a long prompt (quoting, execve/ps limits).
- `--output <path>` gets the uniform envelope (see *Reading the answer*) on EVERY
  outcome, exit-code-independent. Read it once the call returns 0.
- `600000`ms is the Bash tool's per-call ceiling even with the explicit
  parameter. For a partner that may run longer, do NOT hold a blocking call
  open — use the detached shape below (or run the `agent run` in the
  background and poll `--output`, which appears atomically only once
  complete).
- To continue an existing partner instead of starting fresh, add `--resume
  <name-or-id>` in place of `--preset`/`--model`/`--effort` (the resumed
  session keeps its own config) — see *Resuming a partner* below.

## Detached + chunked wait (`agent panel start|wait`)

`keeper agent panel` launches each partner as a **detached read-only leg** and
lets you wait for it across bounded blocking calls — the same engine
`/plan:panel` drives. A single `--cli <harness>` member, or a single launch
triple passed to `--panel <harness::model::effort>`, is pairing as a panel of
one; a named `--panel <name>` fans the ask out to several models at once. Both
run identically on macOS and Linux — all detachment and polling live in the
binary, no `setsid`/`timeout`/`gtimeout` on the path.

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
  from the ask (each leg launches as `panel::<slug>::<member>`, keeping the run
  identifiable in tmux + forensics). Pick a sensible default, don't stall.
- The manifest is `{"dir":"…","slug":"…","members":[{"name","harness","yaml","pidfile"},…]}`.
  Capture `DIR`; every `wait`/`status` re-reads it — or address the run by `--slug
  <slug>`, the durable form that survives a restart. Each member's `yaml` is that
  leg's answer-envelope path.
- Pick the member two ways: compose a launch triple directly when you already know
  harness+model+effort — `--panel <harness::model::effort>` (a single triple is a
  panel of one) — or give a bare `--cli <claude|codex|pi>` (add `--model` /
  `--effort` as needed; omit them to fall back to that harness's configured
  `<harness>_default` triple). Run `keeper agent presets list --json` first to
  discover native ids and effective effort ranges when you don't already know
  them. `--role` rides onto a `--cli` member. Fan out several models at once with
  a named `--panel <name>`. An absent/empty `--slug`, a misconfigured/unknown
  panel, a malformed triple, a non-pairable harness, or an unreadable prompt exits
  2 with no leg launched.

**3. Wait token-free (re-issue loop).** Each `wait` call blocks ONE `--chunk`
window (default 540s = 9 min), then exits: **0** = every leg terminal (verdict
JSON on stdout), **124** = the chunk elapsed (re-issue it), **2** = a
missing/corrupt manifest or bad flags. Issue every `wait` invocation with the
Bash tool's `timeout` parameter set explicitly to `600000` — the tool's
*default* foreground window is only `120000`ms, well short of a 540s chunk, and
a call that outruns its window auto-backgrounds instead of returning 124,
silently ending the wait rather than raising it. The explicit `600000`ms
ceiling leaves ~60s of headroom over the 540s chunk.

A multi-chunk wait is **one explicitly-timed Bash call per chunk, re-issued
across separate calls — never a shell loop inside one call**: a `while` that
re-issues `wait` on exit 124 cannot complete inside a single Bash call even at
the 600000ms ceiling (six chunks alone is ~54 min), and shell state (loop
counters, captured output) does not survive between separate Bash calls
anyway. Track the re-issue count yourself and stop once it hits a backstop, so
a wedged leg never loops forever:

```bash
# Issue as its own Bash call, timeout: 600000:
VERDICT=$(keeper agent panel wait --run-dir "$DIR" --chunk 540s)
WAIT_RC=$?
# exit 0   → every leg terminal; $VERDICT is the verdict JSON
# exit 124 → chunk elapsed; issue the SAME command again as a NEW Bash call
# exit 2   → a failure; stop and surface it
```

Re-issue the identical command, one Bash call per chunk (`timeout: 600000`
every time), until it returns 0 or 2, or until you've issued it `BACKSTOP`
times — 6 re-issues ≈ 54 min of 9-min chunks; a leg still running this late is
wedged, so treat it as a failure in step 4.

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

## Resuming a partner

A name is a lookup, never a resume key — `--resume <name-or-id>` (or the
`resume` verb below) resolves the name against the current job's title, its
former names, or a job/session-id prefix, and continues that partner's
conversation rather than starting cold. Resolution rules:

- **Current or former name, or id.** A partner renamed mid-conversation is
  still found by any name it has ever carried.
- **Newest-non-live wins, and is echoed.** Several non-live matches for a name
  collapse to the most recently updated one; keeper prints which job/harness it
  picked. An exact tie among equally-recent matches is ambiguous — resume by
  the exact job id instead.
- **A live target refuses, pointing at the bus.** A partner still running is
  never resumed (that would create two writers on one conversation) — message
  it instead: `keeper bus chat send <name-or-id> "<msg>"`.
- **Resume is cwd-scoped.** Both shapes below launch in the matched partner's
  recorded cwd, because claude and codex store sessions per-cwd.
- **Resuming chains.** Each resume mints a fresh session carrying the matched
  partner's name, so resuming the same name again continues the newest
  lineage, not the original conversation.

**Interactive re-attach** — `keeper agent resume <name-or-id> "<follow-up ask>"`
drops you into the partner's TUI with the follow-up already queued:

```bash
keeper agent resume codereview-1 "now check the error-handling paths too"
```

**Resumed capture** — add `--resume <name-or-id>` to `agent run` to deliver a
follow-up ask and capture the resumed session's new final answer in the same
uniform envelope (`--model`/`--effort`/`--preset` are rejected alongside
`--resume` — the resumed session keeps its own config):

```bash
keeper agent run codex "now check the error-handling paths too" \
  --resume codereview-1 --output /tmp/ans2.json
# issue with Bash tool timeout: 600000 — read /tmp/ans2.json on exit 0
```

## Reading the answer

Each partner's `--output` (or a panel member's `yaml`) is the uniform
schema-versioned JSON envelope. The fields:

- `message` — the partner's final assistant message. This is the answer (empty
  string on a tool-only/refusal turn). For a claude partner, capture reads this
  from the **settled stop** — the transcript stop marker capture accepts as
  terminal because no background agent the partner launched is still live at
  that point — so a partner that ends a turn early while a background agent is
  still working never gets captured mid-flight. codex/pi have no
  background-agent concept, so their capture is a plain final-message read.
- `message_found` — whether a final message was present.
- `transcript_path` — the partner's per-backend transcript JSONL, the drill-down
  for the FULL conversation when `message` alone isn't enough. Read it only if you
  need the partner's reasoning/steps, not just its conclusion.
- `handle` / `resume_target` — the `keeper agent` launch handle + the native
  id `--resume` would need to continue this exact session (prefer resuming by
  the `--name` you gave the partner instead — a name outlives any one id).
- `elapsed_seconds` — wall time of the partner's turn.
- `outcome` — `completed` / `no_message` (success), or `timed_out` /
  `no_transcript` / `launch_failed` / `bad_args` (no usable answer — surface it to
  the human).

## Choosing the partner

Two ways to name a partner: **compose a triple directly** (`<harness>::<model>::<effort>`) when you
already know the harness, model, and effort you want, or **enumerate then pick** — run
`keeper agent presets list --json` to discover the configured native ids and each model's effective
effort range, then compose the triple from what you found.

**Right-size the partner — the same difficulty-and-diversity philosophy the
model guidance and panel roster use, applied to one leg:**

- **Human-named axes win — select only the rest.** Any harness, model, or effort
  the human states is fixed and overrides the rubric; the selection fills ONLY
  the axes they left open. "Ask codex" fixes the harness but still picks model +
  effort; "use gpt-5.5" fixes the model but still picks its effort; a full
  `<harness>::<model>::<effort>` triple defers nothing.
- **Diversity first — default to a DIFFERENT family than yourself.** A second
  opinion earns its keep on another family's blind spots, so bias to a different
  vendor than the calling session unless the human named one or the ask turns on
  one family's own idiom (Claude-tuned taste/wording → a claude partner is fair;
  a correctness/algorithmic cross-check → go cross-family).
- **Size effort to the ask's difficulty and blast radius, not its length.** A
  quick sanity check or mechanical review → a light tier; a hard correctness,
  security, or design cross-check → a frontier tier at high/xhigh. A long prompt
  is not a hard question — match the model to the reasoning, not the word count.
- **Ground the pick in the model guidance.** Read the per-model capability blocks
  in `plugins/plan/model-selector.yaml` (`models:` / `efforts:`) for the
  strengths, weaknesses, and when-to-pick behind each tier, and
  `keeper agent presets list --json` for the available per-harness triples and
  which are cells; choose the model + effort from those, not from memory.
- **Ambiguous ask → pick and say so, never stall.** Choose a sensible cross-family
  partner at an effort matched to the stakes and `default` role, and state what
  you chose in one line so the human can redirect.

| Flag | Meaning |
|---|---|
| `--preset <triple>` | **`agent run` only** (Quick single-shot). A launch triple `<harness>::<model>::<effort>` — supplies harness + model + effort in one token. The triple's harness must equal the `<cli>` positional, or it's an arg fault. `agent panel start`'s ad-hoc member has no `--preset`; compose the triple with `--panel <triple>` there instead (see *Detached + chunked wait* above). |
| `--cli claude\|codex\|pi` | The partner CLI. **Required unless `--preset`/`--panel` already names a triple.** All three launch as an interactive TUI; codex gets its cwd directory-trust pre-seeded and pi launches with `-na` (ignore project-local `.pi/` resources), both fail-open so neither stalls on a consent prompt. Reach for a DIFFERENT vendor than yourself when the user wants genuine diversity / a true second opinion. |
| `--model <m>` | Native model id, passed through (`claude`/`pi` `--model`, `codex` `-m`). Omit for the CLI's default; a triple already supplies it unless this overrides. |
| `--effort <e>` | Reasoning effort — **codex only** (passing it with a claude/pi member is an arg fault; pi takes thinking not effort). |
| `--role <r>` | Role prompt: `default` \| `planner` \| `codereviewer` \| `coplanner` (rides the leg as a `--system` block on the panel path; pairs with `--cli`, not with a bare triple). Pick `codereviewer` for "review this", `coplanner`/`planner` for "help me plan", `default` otherwise. |
| `--read-only` | Read-only posture (see below). Use for any audit / review / second-opinion where the partner should NOT touch the tree. |
| `--name <n>` | **`agent run` only.** Names the partner so it is resumable by name later — pass it on a fresh launch; a `--resume` launch ignores it and keeps the partner's original name. |
| `--resume <name-or-id>` | **`agent run` only.** Continues a prior partner by current/former name or id instead of launching fresh (see *Resuming a partner*). Rejects `--preset`/`--model`/`--effort`; `--session`/`--name` are silently dropped — the resumed session keeps its own. |

## Read-only posture (prompting-only)

`--read-only` is **prompting-only, and honest about its limits**: it prepends a
read-only directive to the partner's prompt and relies on the model following it.
keeper enforces nothing — there is no tool strip and no git audit, so nothing
stops Bash writes or `git` inside the partner if it ignores the directive. Use
`--read-only` for any "just look / just review / don't change anything" ask, but
know the guarantee is best-effort.

## Final-message contract (always on)

Every `agent run` prompt — every partner, every posture, with or without
`--read-only` — carries a final-message directive ahead of the task text: the
partner's final message is the captured deliverable, so it must be one
complete, self-contained answer, never a back-reference to an earlier message
or an answer-then-follow-up delta. The directive also tells the partner to
avoid background agents and background tasks, and to fold any already-running
one's results into that one final message before ending its turn. `agent run`
injects this directive automatically as a single always-on prompt block — it
is the sole place this contract is injected, so nothing here or in a prompt
you write needs to (or should) restate it.

## What NOT to do

- Do NOT poll, tail, or `cat` an answer file before the run/wait returns. It may
  be absent or half-written until the atomic rename; the call's exit is your
  go-signal.
- This is NOT `keeper:dispatch` (launch a keeper WORKER on plan work), NOT
  `keeper:bus` (message an already-running agent), and a multi-model consensus
  panel is `/plan:panel` (which itself fans out via this). Reach for pairing when
  the user wants a one-shot answer/opinion from another model.
