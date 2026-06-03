---
name: review-quality
description: >-
  Run a quality audit on a planctl task or epic — resolve trailer commits,
  spawn the quality-auditor agent via Task tool, and report. Slash-command
  only; never auto-invoked from free text. Manual escape hatch for re-runs
  after fixes, mid-epic audits, or single-task audits in isolation. The
  auto-invoke path lives exclusively in `/plan:close`.
argument-hint: "<task-or-epic-id>"
allowed-tools: Bash(planctl:*), Bash(jobctl:*), Read, Task
disable-model-invocation: true
---

# Review Quality

Run a quality audit on a task or epic's implementation using the `quality-auditor` agent.
Diff scope is derived from `Task:` commit trailers — never a raw branch diff or `--base` range.

## When to invoke

The human typed `/plan:review-quality <id>`.
The argument must be an existing planctl task id (`fn-N-slug.M`) or epic id (`fn-N-slug`).

---

## Phase 0 — Pre-flight

```bash
planctl detect
```

If `found: false`: *"no planctl project detected. run `/plan:plan <request>` first to create one."* Stop.

If `found: true`: proceed.

---

## Phase 1 — Input handling

Validate `$ARGUMENTS` against the strict regex **before any shell interpolation** (injection guard):
accepted pattern: `^fn-\d+(-[a-z0-9-]+)?(\.\d+)?$`

Parse **greedy-first** (check task id before epic id so `fn-1-slug.2` isn't silently treated as the epic `fn-1-slug`):

- **Empty `$ARGUMENTS`**: ask *"which task or epic should I audit? pass the id (`fn-N-slug.M` for a task, `fn-N-slug` for an epic)."* Wait for the human's reply, then re-enter Phase 1 with that reply.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?\.\d+`** (task id with `.M` suffix — check this pattern first): capture `subject_id`, set `mode = task`. Proceed to Phase 2.
- **`$ARGUMENTS` matches `^fn-\d+(-[a-z0-9-]+)?$`** (epic id, no task suffix — check only after task pattern fails): capture `subject_id`, set `mode = epic`. Proceed to Phase 2.
- **`$ARGUMENTS` does not match `^fn-\d+(-[a-z0-9-]+)?(\.\d+)?$`**: error — *"invalid id format. pass a task id like `fn-7-add-auth.1` or an epic id like `fn-7-add-auth`."* Stop. Do NOT attempt shell interpolation of an unvalidated id.

---

## Phase 2 — Re-anchor

Load current state so the audit has fresh context:

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
```

Quote back a one-sentence summary so the human sees state is loaded:
- Task mode: *"auditing `<subject_id>` (task): spec loaded. resolving commits."*
- Epic mode: *"auditing `<subject_id>` (epic): N tasks. resolving commits."*

---

## Phase 3 — Resolve trailer commit set

Resolve the `COMMITS` list from `Task:` trailers. Pass the validated `subject_id` as an argument to `jobctl find-task-commit`, never string-interpolated unsafely.

**Task mode:**

```bash
jobctl find-task-commit <subject_id> | jq -c '.commits[]'
```

Group by repo:

```bash
jobctl find-task-commit <subject_id> | jq -c '[.commits[] | {sha, repo}] | group_by(.repo) | map({repo: .[0].repo, shas: map(.sha)})'
```

If none found, `COMMIT_GROUPS='[]'`.

**Epic mode:**

Collect all task ids for the epic first:

```bash
planctl tasks --epic <subject_id>
```

Then run `jobctl find-task-commit` for each task id (including the epic id itself for any epic-scoped commits), accumulate all `{sha, repo}` rows, and group by repo:

```bash
(
  planctl tasks --epic <subject_id> | jq -r '.tasks[].id' | while read task_id; do
    jobctl find-task-commit "$task_id" | jq -c '.commits[]'
  done
  jobctl find-task-commit <subject_id> | jq -c '.commits[]'
) | jq -sc 'group_by(.repo) | map({repo: .[0].repo, shas: (map(.sha) | unique)})'
```

`jobctl find-task-commit` uses two-stage matching: a grep pre-filter on commit messages followed by `interpret-trailers --parse` to confirm real trailers (not prose). Returns `{success: true, commits: [{sha, repo}, ...]}` — empty list when none found.

Result is `COMMIT_GROUPS` — a JSON array of `{repo, shas: [...]}` objects, one entry per distinct repo. If none found, `COMMIT_GROUPS='[]'`.

---

## Phase 4 — Spawn quality-auditor agent

Build the prompt and spawn via Task tool with `subagent_type: plan:quality-auditor`:

**Task mode:**

```
Run a quality audit on the following task.

TASK_ID: <subject_id>

--- COMMIT_GROUPS ---
<COMMIT_GROUPS JSON array>
```

**Epic mode:**

```
Run a quality audit on the following epic.

EPIC_ID: <subject_id>

--- COMMIT_GROUPS ---
<COMMIT_GROUPS JSON array>
```

Wait for the agent to return its report.

Note: exactly one of `TASK_ID` / `EPIC_ID` is set per invocation — never both, never neither.

---

## Phase 5 — Report

Surface the agent's returned report inline.

Then append a one-line verdict summary:

```
<mode> <subject_id> audit complete.
```

---

## Out of scope (intentional)

- **No `quality_audit_status` field** — advisory only; no state mutations, no receipt round-trip, no fix loop.
- **No self-commit** — the agent's Task return value IS the report; the caller already has it inline. No `.planctl/` diff to commit.
- **No state commit** — every mutating planctl verb auto-commits its own scope inline at `emit()` (fn-587). This skill performs no state mutation (advisory only — no `quality_audit_status` field, no verdict persistence), so no commit fires. If a future change adds a state mutation here (e.g. a `quality_audit_status` field), the mutating verb that writes it will auto-commit its scope without any seam wiring needed.
- **No auto-loop** — returns once with the report. Human re-runs manually if needed.
- **No `--base <sha>` flag** — diff scope is always trailer-derived. If you're tempted to add it, open a new planctl task.
- **No backend selection** — always the `quality-auditor` Claude agent; no Codex path, no `--backend` flag.
