## Description

**Size:** S
**Files:** CLAUDE.md, AGENTS.md, docs/reference/commit-at-mutation-boundary.md, README.md, docs/diagrams/planctl-workflow.mermaid.md

Sync the human-facing reference docs to the brief-file handoff and content-blind orchestrator contract. Lands last (deps on .1/.2/.3) so the behavior is final and the concurrent fn-756.3 doc edits settle first. Present-tense only — no backward-facing "used to" language (project doc rule), except the sanctioned bug-history record (untouched here).

### Approach

- **CLAUDE.md AND AGENTS.md** (identical content, edit both in the same commit): inheritor-skills bullet → `claim` writes the brief file (incl. pre-rendered snippet context) and `/plan:work` passes `brief_ref`; runtime-state-only `claim` description → add the `state/briefs/<task_id>.json` write (still gitignored, no commit); add the `worker resume` typed-envelope shape; note the content-blind orchestrator principle (process-only, resume-as-recovery).
- **docs/reference/commit-at-mutation-boundary.md**: runtime-state-only table row for `claim` → mention the briefs write; §9 worker-contract recovery property → add the dirty-after-done within-budget auto-resume.
- **README.md**: `claim` "returns the full worker briefing" → writes a brief + returns `brief_ref`; the runtime-only-verb parenthetical.
- **docs/diagrams/planctl-workflow.mermaid.md**: the `claim` node label → reflects a `brief_ref` to a written brief file.

### Investigation targets

**Required**:
- CLAUDE.md + AGENTS.md — the inheritor-skills bullet, runtime-state-only verbs bullet, skills/agents section (find the `claim`/`/plan:work`/`worker resume` descriptions).
- docs/reference/commit-at-mutation-boundary.md — the runtime-state-only table + §9 worker contract / recovery budget.
- README.md — the `claim` verb description + runtime-only parenthetical.
- docs/diagrams/planctl-workflow.mermaid.md — the `claim` node.

### Risks

- **fn-756.3 overlap on CLAUDE.md + commit-at-mutation-boundary.md** — both are concurrently edited by the approve/ack removal. Landing last reduces but does not eliminate conflict; if dirty on this task, follow the shared-tree rule (commit only this session's hunks) and rebase prose carefully.
- **CLAUDE.md/AGENTS.md drift** — they must stay byte-identical; edit both.

### Test notes

No code tests. Verify mermaid still parses if a linter exists; otherwise visual check. Confirm no "used to"/"formerly"/"no longer" phrasing crept in.

## Acceptance

- [ ] CLAUDE.md + AGENTS.md updated in sync (brief handoff, runtime-state-only `claim` briefs write, worker-resume envelope, content-blind principle).
- [ ] commit-at-mutation-boundary.md runtime-state-only row + §9 recovery property updated.
- [ ] README.md + workflow mermaid `claim` node updated.
- [ ] All edits present-tense; no backward-facing tombstones.

## Done summary

## Evidence
