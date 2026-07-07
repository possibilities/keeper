## Description

**Size:** M
**Files:** plugins/plan/agents/selection-auditor.md, plugins/plan/src/verbs/selection_audit_brief.ts, plugins/plan/src/verbs/selection_review_submit.ts, plugins/plan/src/selection_review_file.ts, plugins/plan verb registry, plugins/plan/test

### Approach

Three pieces: brief, judge, submit. `keeper plan selection-audit-brief <epic>` assembles
the audit context under gitignored state: for each AUDITABLE completed task — its spec,
assigned {tier, model}, the selection sidecar's rationale/confidence/label_source plus
config/input hashes, per-task diff stats derived from Task-trailer commits (files
touched, line counts), and the done summary. Auditable excludes tasks whose cell was a
degraded default (label_source heuristic-default) and tasks with no executed-worker
evidence (no Task-trailer commit and no job) — grading non-decisions poisons the
dataset. The verb errors distinctly when a review file already exists, unless --force.

The new plan:selection-auditor subagent (frontmatter model opus, effort high; read-only
tools plus Bash for read-only keeper and git queries) grades each auditable task on the
3-way categorical underpowered / right-sized / overpowered with one evidence sentence,
grounded in the assembled record — and abstains toward right-sized when signals are
thin. Its prompt carries the anti-self-preference frame: grade against the outcome
record, never model reputation, and never re-litigate the policy itself. Returns one raw
JSON verdict.

`keeper plan selection-review-submit <epic> --file -` validates the verdict (3-way enum,
exact auditable-task coverage, no extras), writes the committed review file at
.keeper/selection-reviews/<epic>.json (schema-versioned; each verdict snapshots the
graded {tier, model} and the selection config/input hashes so re-selects cannot orphan
the join; rides the verb auto-commit), and sets the task-2 overlay flag ONLY when at
least one verdict is non-right-sized, with the counts summary as payload. A fully
right-sized epic writes the dataset file and raises no flag.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/selection_sidecar.ts — sidecar schema + hashes to snapshot; the REPLACE contract the review file must NOT inherit (write-once + --force instead)
- plugins/plan/src/verbs/selection_brief.ts:189-289 — the brief-assembly verb pattern to mirror
- plugins/plan/src/verbs/close_preflight.ts:197-204 — what per-task facts close already assembles (commit_groups carry the Task-trailer commits)
- plugins/plan/agents/model-selector.md — the config-only spawn + raw-JSON return contract to mirror for the auditor

**Optional** (reference as needed):
- cli/commit-work.ts — Task trailer conventions for locating per-task commits
- keeper find-task-commit --help — the trailer-lookup verb the brief can shell

### Risks

- Grade quality is capped by the assemblable signal set; the abstain-toward-right-sized
  instruction is the guard against manufactured verdicts.
- Same-family judging bias is mitigated, not eliminated — the prompt grounds verdicts in
  signals; a cross-harness judge is future work, out of scope here.

### Test notes

Brief assembly against a fixture epic tree (auditable-subset exclusion cases); submit
validation (bad enum, missing task, extra task, double-write without --force);
flag-set-only-on-misfit; snapshot fields present in the written file.

## Acceptance

- [ ] The audit brief excludes degraded-default and never-executed tasks and carries
      diff stats plus sidecar provenance for every auditable one.
- [ ] Submit writes a committed review file whose verdicts snapshot the graded cell and
      selection hashes, sets the flag only when a non-right-sized verdict exists, and
      refuses a second write without --force.
- [ ] Malformed auditor output is rejected with a distinct code, leaving no flag and no file.

## Done summary
Added selection-audit-brief (content-blind grading record: spec, cell, sidecar provenance+hashes, Task-trailer diff stats, done summary; excludes degraded-default + never-executed), the selection-auditor subagent (3-way grade grounded in the outcome record), and selection-review-submit (validates verdict, lands the committed per-epic review dataset snapshotting graded cell+hashes, sets the display-only misfit flag only on a non-right-sized verdict). Added commitNumstat to the PlanVcs facade+fake.
## Evidence
