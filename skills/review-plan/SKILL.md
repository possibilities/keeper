---
name: review-plan
description: Review a planctl epic's plan via Codex — invoke the Carmack-criteria critique, parse the verdict (SHIP/NEEDS_WORK/MAJOR_RETHINK), persist plan_review_status, and report. Slash-command only; never auto-invoked from /plan:plan. Use when human types "/plan:review-plan <epic_id>".
argument-hint: "<fn-N-slug>"
allowed-tools: Bash(planctl:*), Read
---

# Review Plan

Conduct a Codex-backed Carmack-level review of an epic's plan spec + tasks.
Single backend (Codex CLI). No auto-loop. No backend selection surface.

## When to invoke

The human typed `/plan:review-plan <epic_id>`. The argument must be an
existing planctl epic id (`fn-N-slug`). Task ids are an error. Empty input
prompts.

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

- **Empty `$ARGUMENTS`**: ask *"which epic should I review? pass the epic id (`fn-N-slug`)."* Wait for the human's reply, then re-enter Phase 1 with that reply.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?\.\d+` (task id)**: error — *"`review-plan` operates on epics only. pass the parent epic id (e.g. `fn-N-slug`), not a task id. for task-level review, use `/plan:review-work`."* Stop.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?$` (epic id)**: capture `epic_id`. Proceed to Phase 2.
- **Otherwise**: error — *"unrecognised input. pass an epic id like `fn-7-add-auth`."* Stop.

---

## Phase 2 — Re-anchor

Load current epic + task state so the Codex invocation has the freshest possible context in scope:

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

Pass `## Snippet context` block to the Codex critic by surfacing it to the human under a `## Snippet context` header above the Phase 3 invocation log when `BUNDLE_CONTEXT` is non-empty; omit the section entirely when empty (no blank header). It's pre-rendered curated context the planner curated at epic time. The current `planctl codex plan-review` CLI does not accept a snippet-context flag — until that lands, the prose anchors *this skill's* working context (used when distilling Codex's free-form review into the Phase 3 one-line summary surfaced to the human).

Quote back a one-sentence summary so the human sees state is loaded:
*"reviewing `<epic_id>`: N tasks, epic spec ~M lines. invoking codex."*

(Count lines in the `cat` output to fill M; task count from the tasks list.)

---

## Phase 3 — Invoke Codex

```bash
planctl codex plan-review <epic_id> \
  --receipt /tmp/plan-review-receipt-<epic_id>.json
```

Parse the returned JSON envelope. The envelope shape:

```json
{
  "success": true,
  "verdict": "SHIP | NEEDS_WORK | MAJOR_RETHINK | null",
  "review": "<full review text>",
  "receipt_path": "/tmp/plan-review-receipt-<epic_id>.json"
}
```

Surface to the human:
- **Verdict** on its own line: `Verdict: SHIP` / `Verdict: NEEDS_WORK` / `Verdict: MAJOR_RETHINK` / `Verdict: (none — parse failure)`
- **One-line summary** distilled from the `review` text (the full text can be long — offer the receipt path for reading the full review)
- The receipt path so the human can inspect

Example output:
```
Verdict: NEEDS_WORK
Summary: plan is solid on approach but three acceptance criteria are underspecified — see receipt for details.
Full review: /tmp/plan-review-receipt-fn-7-add-auth.json
```

If the command fails (non-zero exit, `success: false`): surface the error verbatim and stop. Do not call `planctl epic set-plan-review-status` if Codex didn't return a verdict.

---

## Phase 4 — Loop gate (human-driven)

If verdict is `NEEDS_WORK` or `MAJOR_RETHINK`:

Announce: *"verdict: <VERDICT>. address the feedback with `/plan:plan <epic_id> <refine note>` then re-run `/plan:review-plan <epic_id>`. the receipt persists at `/tmp/plan-review-receipt-<epic_id>.json` — the next invocation will automatically become a re-review."*

Then stop. **Do NOT auto-loop.** The human decides whether to refine and re-review.

If verdict is `SHIP` or `null`: proceed to Phase 5.

---

## Phase 5 — Persist status

Map verdict → status:

| Verdict | Status |
|---------|--------|
| `SHIP` | `ship` |
| `NEEDS_WORK` | `needs_work` |
| `MAJOR_RETHINK` | `needs_work` |
| `null` / parse failure | `unknown` |

```bash
planctl epic set-plan-review-status <epic_id> --status <status>
```

(For `NEEDS_WORK` / `MAJOR_RETHINK` this runs before the Phase 4 stop — persist the status regardless of verdict so `planctl show` reflects reality. Adjust Phase 4's position mentally: persist → announce gate → stop.)

**Corrected execution order** (phases 4 and 5 interleave):

1. Parse verdict.
2. **Always** call `planctl epic set-plan-review-status`.
3. If verdict is `NEEDS_WORK` or `MAJOR_RETHINK`: print the gate message and stop (no Phase 6).
4. If verdict is `SHIP` or `null`: proceed to Phase 6.

`set-plan-review-status` auto-commits its scope inline — the epic JSON state commit lands the moment the verb returns success. No separate state-commit seam.

---

## Phase 6 — Report

One-line summary:

```
Epic <epic_id> review: <status>. Verdict: <SHIP|NEEDS_WORK|MAJOR_RETHINK|null>. Receipt: /tmp/plan-review-receipt-<epic_id>.json.
```

---

## Out of scope (still cut)

- **Auto-loop** — the slash command returns once, verdict and all. Rationale: a slash command that holds a multi-minute agent-driven fix loop breaks the "run the slash command, see the result" mental model. If the human wants iteration, they `/plan:plan <epic_id> <note>` then re-run `/plan:review-plan <epic_id>`. The receipt path persists and automatically becomes a re-review on next invocation (the `--receipt` flag passes the same path). **Do not rebuild the auto-loop** — if you're tempted to add it, open a new planctl task instead.
- **Backend selection** — no `--backend` flag, no `PLAN_REVIEW_BACKEND` env var, no `.planctl/config.json` lookup. Always Codex.
- **Task-level review** — task-id input is an error, not a silent epic-promotion. Task-level review is `/plan:review-work`.
- **RepoPrompt backend** — rp workflow removed with the rest of RepoPrompt.
