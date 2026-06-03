---
name: review-work
description: >-
  Review a planctl task or epic's implementation via Codex CLI — invoke
  `planctl codex work-review`, parse the verdict (SHIP / NEEDS_WORK), persist
  `work_review_status` on the task or epic, and report. Slash-command only;
  never auto-invoked from `/plan:work`. Accepts task ids, epic ids, or
  `--base <sha>`.
argument-hint: "<fn-N-slug.M | fn-N-slug> [--base <sha>]"
allowed-tools: Bash(planctl:*), Read
disable-model-invocation: true
---

# Review Work

Conduct a Codex-backed Carmack-level review of an epic's or task's implementation.
Single backend (Codex CLI). No auto-loop. No backend selection surface.

## When to invoke

The human typed `/plan:review-work <id>` or `/plan:review-work <id> --base <sha>`.
The argument must be an existing planctl task id (`fn-N-slug.M`) or epic id (`fn-N-slug`),
optionally with `--base <sha>` to override the automatically-derived base commit.

---

## Phase 0 — Pre-flight

```bash
planctl detect
```

If `found: false`: *"no planctl project detected. run `/plan:plan <request>` first to create one."* Stop.

If `found: true`: proceed.

---

## Phase 1 — Input handling

Parse `$ARGUMENTS` **greedy-first** (check task id before epic id so
`fn-1-slug.2` isn't silently treated as the epic `fn-1-slug`):

Parse for an optional `--base <sha>` flag first, then the positional id:

- If `--base <sha>` is present: capture `base_sha`; strip it from `$ARGUMENTS` before id matching.
- **Empty `$ARGUMENTS` (after stripping `--base`)**: ask *"which task or epic should I review? pass the id (`fn-N-slug.M` for a task, `fn-N-slug` for an epic)."* Wait for the human's reply, then re-enter Phase 1 with that reply.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?\.\d+`** (task id): capture `subject_id`, set `mode = task`. Proceed to Phase 2.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?$`** (epic id): capture `subject_id`, set `mode = epic`. Proceed to Phase 2.
- **`--base <sha>` provided but no id**: `subject_id = null`, `mode = branch`. Proceed to Phase 2.
- **Otherwise**: error — *"unrecognised input. pass a task id like `fn-7-add-auth.1` or an epic id like `fn-7-add-auth`."* Stop.

---

## Phase 2 — Re-anchor

Load current state so the Codex invocation has the freshest possible context:

**Task mode** (`mode = task`):

```bash
planctl show <subject_id>
planctl cat <subject_id>
# also load parent epic for context:
planctl show <epic_id>
planctl cat <epic_id>
```

**Epic mode** (`mode = epic`):

```bash
planctl show <subject_id>
planctl cat <subject_id>
planctl tasks --epic <subject_id>
# for each task listed, read its spec:
planctl cat <task_id>
```

**Branch mode** (`mode = branch`, only `--base` given):

No planctl calls needed. Proceed.

**Render snippet context.** Skipped entirely in branch mode (no id, no spec metadata to resolve). For task and epic modes, fire `promptctl render-spec` once against the subject id and capture stdout. This is the inheritor-tier substrate consumption seam: the planner authored `epic.snippets` / `epic.bundles` (and per-task `task.snippets` / `task.bundles` for task mode) at planning time; `render-spec` resolves them into one prose blob this skill reads as authoritative pre-curated context. One call per skill run.

```bash
# task mode — render against the task id so task.snippets/bundles AND inherited epic context land
promptctl render-spec <subject_id> --format human

# epic mode — render against the epic id
promptctl render-spec <subject_id> --format human
```

Pin the captured stdout as `BUNDLE_CONTEXT`. Empty stdout is legal — the spec has no curated substrate set. On non-zero exit, surface the stderr verbatim and stop.

Pass `## Snippet context` block to the Codex critic by surfacing it to the human under a `## Snippet context` header above the Phase 3 invocation log when `BUNDLE_CONTEXT` is non-empty; omit the section entirely when empty (no blank header). It's pre-rendered curated context the planner curated at epic time. The current `planctl codex work-review` CLI does not accept a snippet-context flag — until that lands, the prose anchors *this skill's* working context (used when distilling Codex's free-form review into the Phase 3 one-line summary surfaced to the human).

Quote back a one-sentence summary so the human sees state is loaded:
- Task mode: *"reviewing `<subject_id>` (task): spec loaded. invoking codex."*
- Epic mode: *"reviewing `<subject_id>` (epic): N tasks, spec ~M lines. invoking codex."*
- Branch mode: *"reviewing branch diff from `<base_sha[:12]>`. invoking codex."*

---

## Phase 3 — Invoke Codex

Build the command. The `--receipt` path:
- Task: `/tmp/work-review-receipt-<subject_id>.json`
- Epic: `/tmp/work-review-receipt-<subject_id>.json`
- Branch: `/tmp/work-review-receipt-branch.json`

**Task or epic id (no explicit `--base`):**

```bash
planctl codex work-review <subject_id> \
  --receipt /tmp/work-review-receipt-<subject_id>.json
```

**With explicit `--base <sha>`:**

```bash
planctl codex work-review <subject_id> \
  --base <base_sha> \
  --receipt /tmp/work-review-receipt-<subject_id>.json
```

**Branch mode (no id):**

```bash
planctl codex work-review \
  --base <base_sha> \
  --receipt /tmp/work-review-receipt-branch.json
```

Parse the returned JSON envelope. The envelope shape:

```json
{
  "success": true,
  "verdict": "SHIP | NEEDS_WORK | null",
  "review": "<full review text>",
  "receipt_path": "/tmp/work-review-receipt-<id>.json"
}
```

Surface to the human:
- **Verdict** on its own line: `Verdict: SHIP` / `Verdict: NEEDS_WORK` / `Verdict: (none — parse failure)`
- **One-line summary** distilled from the `review` text (the full text can be long — offer the receipt path for reading the full review)
- The receipt path so the human can inspect

Example output:
```
Verdict: NEEDS_WORK
Summary: implementation covers the happy path but error handling in the OAuth callback is missing — see receipt for details.
Full review: /tmp/work-review-receipt-fn-7-add-auth.1.json
```

If the command fails (non-zero exit, `success: false`): surface the error verbatim and stop. Do not call any set-work-review-status command if Codex didn't return a verdict.

---

## Phase 4 — Corrected execution order: Persist status + Loop gate

**Persist always, gate the loop after.**

Map verdict → status:

| Verdict | Status |
|---------|--------|
| `SHIP` | `ship` |
| `NEEDS_WORK` | `needs_work` |
| `null` / parse failure | `unknown` |

**Task mode:**

```bash
planctl task set-work-review-status <subject_id> --status <status>
```

**Epic mode:**

```bash
planctl epic set-work-review-status <subject_id> --status <status>
```

**Branch mode:** No planctl state to update — skip.

**Loop gate:**

If verdict is `NEEDS_WORK`:

Announce: *"verdict: NEEDS_WORK. address the feedback and re-run `/plan:review-work <id>` when ready. the receipt persists at `/tmp/work-review-receipt-<id>.json` — the next invocation automatically becomes a re-review."*

Then stop. **Do NOT auto-loop.** The human decides whether to fix and re-review.

If verdict is `SHIP` or `null`: proceed to Phase 5.

`set-work-review-status` auto-commits its scope inline — the task/epic JSON state commit lands the moment the verb returns success. Branch mode has no `.planctl/` state to commit (no `set-work-review-status` call fires).

---

## Phase 5 — Report

One-line summary:

```
<mode> <subject_id> review: <status>. Verdict: <SHIP|NEEDS_WORK|null>. Receipt: /tmp/work-review-receipt-<id>.json.
```

---

## Out of scope (still cut)

- **Auto-loop** — the slash command returns once, verdict and all. If the human wants iteration, they fix the issue and re-run `/plan:review-work <id>`. The receipt path persists and automatically becomes a re-review on next invocation (the `--receipt` flag passes the same path). **Do not rebuild the auto-loop** — if you're tempted to add it, open a new planctl task instead.
- **Backend selection** — no `--backend` flag, no `WORK_REVIEW_BACKEND` env var. Always Codex.
- **Blocking on NEEDS_WORK** — the review never blocks `/plan:work` from continuing. It is advisory: the human reads the receipt and decides.
