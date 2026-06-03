---
name: review-epic
description: >-
  Review a planctl epic's implementation via Codex CLI — invoke
  `planctl codex epic-review`, parse the verdict (SHIP / NEEDS_WORK), persist
  `epic_review_status` on the epic, and report. Slash-command only;
  never auto-invoked from `/plan:work`. Accepts epic ids only; rejects
  task ids. Optional `--base <sha>` passthrough.
argument-hint: "<fn-N-slug> [--base <sha>]"
allowed-tools: Bash(planctl:*), Read
disable-model-invocation: true
---

# Review Epic

Conduct a Codex-backed spec-compliance review of a completed epic's implementation.
Asks "did the combined work deliver what the epic spec promised?" — not a code-quality
check, but a requirement-coverage check. Three-phase: extract requirements → forward
coverage spec→code → reverse coverage code→spec. Single backend (Codex CLI). No
auto-loop. No backend selection surface.

## When to invoke

The human typed `/plan:review-epic <epic_id>` or `/plan:review-epic <epic_id> --base <sha>`.
The argument must be an existing planctl epic id (`fn-N-slug`). Task ids are an error.

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
`fn-1-slug.2` isn't silently promoted to `fn-1-slug`):

Parse for an optional `--base <sha>` flag first, then the positional id:

- If `--base <sha>` is present: capture `base_sha`; strip it from `$ARGUMENTS` before id matching.
- **Empty `$ARGUMENTS` (after stripping `--base`)**: ask *"which epic should I review? pass the epic id (`fn-N-slug`)."* Wait for the human's reply, then re-enter Phase 1 with that reply.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?\.\d+` (task id)**: error — *"`review-epic` operates on epics only. pass the parent epic id (e.g. `fn-N-slug`), not a task id. for task-level review, use `/plan:review-work`."* Stop.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?$` (epic id)**: capture `epic_id`. Proceed to Phase 2.
- **Otherwise**: error — *"unrecognised input. pass an epic id like `fn-7-add-auth`."* Stop.

---

## Phase 2 — Re-anchor

Load current epic + task state so the Codex invocation has the freshest possible context:

```bash
planctl show <epic_id>
planctl cat <epic_id>
planctl tasks --epic <epic_id>
```

Then for each task listed, read its spec:

```bash
planctl cat <task_id>
```

**Render snippet context.** Fire `promptctl render-spec <epic_id>` once and capture its stdout. This is the inheritor-tier substrate consumption seam: the planner authored `epic.snippets` / `epic.bundles` at planning time; `render-spec` resolves them into one prose blob this skill reads as authoritative pre-curated context. One call per skill run — paid here so the skill doesn't re-fetch via `find-snippets` / `show-snippet` / `render` while distilling the Codex verdict in Phase 3.

```bash
promptctl render-spec <epic_id> --format human
```

Pin the captured stdout as `BUNDLE_CONTEXT`. Empty stdout is legal — the epic has no curated substrate set. On non-zero exit, surface the stderr verbatim and stop.

Pass `## Snippet context` block to the Codex critic by surfacing it to the human under a `## Snippet context` header above the Phase 3 invocation log when `BUNDLE_CONTEXT` is non-empty; omit the section entirely when empty (no blank header). It's pre-rendered curated context the planner curated at epic time. The current `planctl codex epic-review` CLI does not accept a snippet-context flag — until that lands, the prose anchors *this skill's* working context (used when distilling Codex's free-form review into the Phase 3 one-line summary surfaced to the human).

Quote back a one-sentence summary so the human sees state is loaded:
*"reviewing `<epic_id>` (epic): N tasks, spec ~M lines. invoking codex."*

(Count lines in the `cat` output to fill M; task count from the tasks list.)

---

## Phase 3 — Invoke Codex

Build the receipt path: `/tmp/epic-review-receipt-<epic_id>.json`

**Epic id (no explicit `--base`):**

```bash
planctl codex epic-review <epic_id> \
  --receipt /tmp/epic-review-receipt-<epic_id>.json
```

**With explicit `--base <sha>`:**

```bash
planctl codex epic-review <epic_id> \
  --base <base_sha> \
  --receipt /tmp/epic-review-receipt-<epic_id>.json
```

Parse the returned JSON envelope. The envelope shape:

```json
{
  "success": true,
  "verdict": "SHIP | NEEDS_WORK | null",
  "review": "<full review text>",
  "receipt_path": "/tmp/epic-review-receipt-<epic_id>.json"
}
```

Surface to the human:
- **Verdict** on its own line: `Verdict: SHIP` / `Verdict: NEEDS_WORK` / `Verdict: (none — parse failure)`
- **One-line summary** distilled from the `review` text (the full text can be long — offer the receipt path for reading the full review)
- The receipt path so the human can inspect

Example output:
```
Verdict: NEEDS_WORK
Summary: epic delivered the core backend surface but the dogfood acceptance criterion is unmet — see receipt for details.
Full review: /tmp/epic-review-receipt-fn-13-add-epic-review-skill.json
```

If the command fails (non-zero exit, `success: false`): surface the error verbatim and stop. Do not call `planctl epic set-epic-review-status` if Codex didn't return a verdict.

---

## Phase 4 — Persist status + Loop gate

**Persist always, gate the loop after.**

Map verdict → status:

| Verdict | Status |
|---------|--------|
| `SHIP` | `ship` |
| `NEEDS_WORK` | `needs_work` |
| `null` / parse failure | `unknown` |

```bash
planctl epic set-epic-review-status <epic_id> --status <status>
```

**Loop gate:**

If verdict is `NEEDS_WORK`:

Announce: *"verdict: NEEDS_WORK. address the feedback and re-run `/plan:review-epic <epic_id>` when ready. the receipt persists at `/tmp/epic-review-receipt-<epic_id>.json` — the next invocation automatically becomes a re-review."*

Then stop. **Do NOT auto-loop.** The human decides whether to fix and re-review.

If verdict is `SHIP` or `null`: proceed to Phase 5.

`set-epic-review-status` auto-commits its scope inline — the epic JSON state commit lands the moment the verb returns success. No separate state-commit seam.

---

## Phase 5 — Report

One-line summary:

```
Epic <epic_id> review: <status>. Verdict: <SHIP|NEEDS_WORK|null>. Receipt: /tmp/epic-review-receipt-<epic_id>.json.
```

---

## Out of scope (still cut)

- **Auto-loop** — the slash command returns once, verdict and all. If the human wants iteration, they address the feedback and re-run `/plan:review-epic <epic_id>`. The receipt path persists and automatically becomes a re-review on next invocation (the `--receipt` flag passes the same path). **Do not rebuild the auto-loop** — if you're tempted to add it, open a new planctl task instead.
- **Backend selection** — no `--backend` flag, no `EPIC_REVIEW_BACKEND` env var. Always Codex.
- **Task-level review** — task-id input is an error, not a silent epic-promotion. Task-level review is `/plan:review-work`.
