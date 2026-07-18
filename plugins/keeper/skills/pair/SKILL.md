---
name: pair
description: >-
  Pair with another supported model CLI — fan ONE task out to Claude or Pi, wait,
  then read its answer; or resume a prior partner conversation by
  name instead of starting cold. Use when the user wants a second opinion, a
  cross-check, or to "ask Claude / ask Pi / ask another model", a code review
  or co-plan from a different model, a read-only audit by a partner, or to
  continue talking to a partner from earlier ("resume the Pi session",
  "ask that partner a follow-up") — even when they never say "keeper" or "pair".
  Drives `keeper agent` from THIS session: a blocking `agent run` (optionally
  `--resume <name>`) for a quick single-shot, a detached `agent panel start` +
  chunked blocking `agent panel wait` loop for a longer or multi-model ask, or
  the interactive `agent resume <name>` verb to re-attach a dead partner — then
  reads the partner's JSON answer envelope. NOT for launching a keeper worker on
  plan work (that is `keeper:dispatch`) or for fire-and-forget messaging (that is
  `keeper:bus`), NOT for a multi-model consensus panel (that is
  `/plan:panel`, which itself fans out via this).
allowed-tools: Bash
argument-hint: <what to ask> [--preset <harness::model::effort> | --cli claude|pi] [--resume <name-or-id>] [--name <n>] [--role …] [--read-only]
---

# pair

Pairing fans ONE task out to another supported model CLI — `claude` or `pi` —
launched as a detached **interactive TUI** partner via `keeper agent`, and reads
the partner's final answer back as a uniform JSON envelope. It is
keeper's pairing surface: a second opinion, a cross-vendor cross-check, a code
review or co-plan from a different model, or a read-only audit. There are two
entry states: **fresh-launch** starts a brand-new partner conversation, and
**resume** continues a prior one by name instead of starting cold (see
*Resuming a partner* below). Pi launches with `-na` (`--no-approve`), ignoring the cwd's project-local
`.pi/` resources so it never stalls on Pi's trust prompt.

**Name your partners.** On a fresh launch, `--name <n>` supplies the Partner
launch handle: partner names are host-global among tracked jobs and are the
dedup, dead-resume, and live-message routing key. An unnamed partner remains
resumable by job id, but a name is easier to recall. A `--resume` launch ignores
`--name`: the resumed partner keeps its original name. `agent run --resume`
messages a positively-live Partner through its existing Agent Bus inbox and
captures the response; interactive re-attach still Refuse-lives.

Use **blocking Bash calls**, never a Monitor. Shared wait and envelope mechanics
live in the [Chunked wait](../../../../docs/agent-surface-contracts.md#chunked-wait)
and [Answer envelope](../../../../docs/agent-surface-contracts.md#answer-envelope)
contracts; on wording disputes those sections win.

## Quick single-shot (`agent run`)

For a partner that will finish within ~10 minutes, one blocking Bash call does
the whole job — it launches, waits for the partner to stop, and writes the JSON
answer envelope to `--output`. Issue it with the Bash tool's `timeout`
parameter set explicitly to `600000`:

```bash
keeper agent run pi "$(cat /tmp/ask.md)" --read-only --name codereview-1 --output /tmp/ans.json
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
one; a named `--panel <name>` fans the ask out to several models at once. All
run identically on macOS and Linux — all detachment and polling live in the
binary, no `setsid`/`timeout`/`gtimeout` on the path.

**1. Write the prompt to a file** (a scratch path is fine):

```bash
PROMPT=$(mktemp /tmp/pair.XXXXXX.md)
cat > "$PROMPT" <<'EOF'
<your ask, verbatim>
EOF
```

**2. Start the partner detached.** Choose a required, short kebab-case slug.
`start` exits immediately with the manifest; re-issuing that slug reconciles its
durable run rather than creating another fan-out:

Canonical contract: docs/agent-surface-contracts.md — on wording disputes the doc wins.

```bash
MANIFEST=$(keeper agent panel start "$PROMPT" --slug oauth-review --cli pi --read-only)
START_RC=$?
DIR=$(echo "$MANIFEST" | jq -r '.dir')
```

- `--slug` is **required** — a short kebab display/discovery label (`[a-z0-9-]`)
  you auto-derive from the ask. Each leg launches as `panel::<slug>::<member>`;
  the manifest's opaque `request_id`, not this slug, is the panel request handle.
  Pick a sensible default, don't stall.
- The manifest includes `dir`, `slug`, and `request_id`. Capture `DIR` and
  `request_id`: `wait`/`status` can rediscover the request by display slug or
  `DIR`, while the opaque identity owns admission and retries. Each member's
  `yaml` is that leg's answer-envelope path.
- Pick the member two ways: compose a launch triple directly when you already know
  harness+model+effort — `--panel <harness::model::effort>` (a single triple is a
  panel of one) — or give a bare `--cli <claude|pi>` (add `--model` /
  `--effort` as needed; omit them to fall back to that harness's configured
  `<harness>_default` triple). Run `keeper agent presets list --json` first to
  discover native ids and effective effort ranges when you don't already know
  them. `--role` rides onto a `--cli` member. Fan out several models at once with
  a named `--panel <name>`. An absent/empty `--slug`, a misconfigured/unknown
  panel, a malformed triple, a non-pairable harness, or an unreadable prompt exits
  2 with no leg launched.

**3. Wait token-free, then read the answer.** Run `keeper agent panel wait
--run-dir "$DIR" --chunk 540s` under the Chunked wait contract. Once its terminal
verdict is available, use each successful member's `yaml` path and read the
standard answer envelope under the Answer envelope contract. Do not inspect an
answer before the terminal verdict.

**Re-entry & housekeeping.** The request is durable; its display slug rediscovers
its directory, while its opaque `request_id` remains the true identity. A restarted
session can use `keeper agent panel wait --slug <slug>` without carrying `$DIR`. If a
wait reports `machine-rebooted`, re-issue `keeper agent panel start … --slug <slug>`
to reconcile the existing request, then wait again. `keeper agent panel status --slug
<slug>` is a non-blocking snapshot, and `keeper agent panel prune` GCs eligible
terminal run dirs.

## Resuming a partner

A name is a partner launch handle — `--resume <name-or-id>` (or the `resume`
verb below) resolves it against the current job's title, its former names, or a
job/session-id prefix, and continues a dead partner's conversation rather than
starting cold. Resolution rules:

- **Current or former name, or id.** A partner renamed mid-conversation is
  still found by any name it has ever carried.
- **Newest-non-live wins, and is echoed.** Several non-live matches for a name
  collapse to the most recently updated one; keeper prints which job/harness it
  picked. An exact tie among equally-recent matches is ambiguous — resume by
  the exact job id instead.
- **Refuse-live never creates a second writer.** Interactive `agent resume`
  refuses a Partner still running. `agent run --resume` instead pins the exact
  live job identity, sends one bounded Bus artifact through the Partner's
  existing inbox, and captures only the response after that injected message.
- **Resume is cwd-scoped.** Both supported harnesses launch in the matched
  partner's recorded cwd, preserving the original session's project context.
- **Resuming chains.** Each resume mints a fresh session carrying the matched
  partner's name, so resuming the same name again continues the newest
  lineage, not the original conversation.

**Interactive re-attach** — `keeper agent resume <name-or-id> "<follow-up ask>"`
drops you into the partner's TUI with the follow-up already queued:

```bash
keeper agent resume codereview-1 "now check the error-handling paths too"
```

**Resumed or live capture** — add `--resume <name-or-id>` to `agent run` to
deliver a follow-up ask and capture the new final answer in the same uniform
envelope. A dead Partner is resumed; a positively-live Partner receives one
bounded Bus artifact without another Harness writer. Delivery acknowledgement
alone is never an answer: capture waits until the matching injected-message
boundary appears in the exact transcript, then accepts a later settled stop.
Only one response-bearing request per exact Partner is admitted, and an
ambiguous send is never retried. `--model`/`--effort`/`--preset` are rejected
alongside `--resume` because the Partner keeps its own config:

```bash
keeper agent run pi "now check the error-handling paths too" \
  --resume codereview-1 --output /tmp/ans2.json
# issue with Bash tool timeout: 600000 — read /tmp/ans2.json on exit 0
```

A delivered `timed_out` means only that response observation expired: the live
Partner is left untouched. Do not resend. Use the stderr-provided
`keeper agent show-last-message <transcript> --agent <cli>` command to recover a
late answer.

## Reading the answer

Each partner's `--output` (or a panel member's `yaml`) is the uniform answer
envelope. Read `message` as the answer after a terminal result; inspect the
transcript only when the conclusion alone is insufficient, and surface a
non-usable `outcome` rather than a stale answer.

Canonical contract: docs/agent-surface-contracts.md — on wording disputes the doc wins.

## Choosing the partner

Two ways to name a partner: **compose a triple directly** (`<harness>::<model>::<effort>`) when you
already know the harness, model, and effort you want, or **enumerate then pick** — run
`keeper agent presets list --json` to discover the configured native ids and each model's effective
effort range, then compose the triple from what you found.

**Right-size the partner — the same difficulty-and-diversity philosophy the
model guidance and panel roster use, applied to one leg:**

- **Human-named axes win — select only the rest.** Any harness, model, or effort
  the human states is fixed and overrides the rubric; the selection fills ONLY
  the axes they left open. "Ask Pi" fixes the harness but still picks model +
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
| `--cli claude\|pi` | The supported partner CLI. **Required unless `--preset`/`--panel` already names a triple.** Both launch as interactive TUIs; Pi launches with `-na` (ignore project-local `.pi/` resources) so it does not stall on a consent prompt. Reach for a DIFFERENT vendor than yourself when the user wants genuine diversity / a true second opinion. |
| `--model <m>` | Native model id, passed through to the selected harness. Omit for the CLI's default; a triple already supplies it unless this overrides. |
| `--effort <e>` | Reasoning effort supplied by a launch triple; choose an available triple from `keeper agent presets list --json`. |
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

`agent run` supplies the final-message deliverable directive. Do not add a
second copy when composing a partner prompt.

Canonical contract: docs/agent-surface-contracts.md — on wording disputes the doc wins.

## What NOT to do

- Do NOT poll, tail, or `cat` an answer file before the run/wait returns. It may
  be absent or half-written until the atomic rename; the call's exit is your
  go-signal.
- This is NOT `keeper:dispatch` (launch a keeper WORKER on plan work), NOT
  `keeper:bus` (message an already-running agent), and a multi-model consensus
  panel is `/plan:panel` (which itself fans out via this). Reach for pairing when
  the user wants a one-shot answer/opinion from another model.
