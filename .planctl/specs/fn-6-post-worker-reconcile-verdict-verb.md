## Overview

Add a planctl-native read-only `planctl reconcile <task_id>` verb that collapses the `/plan:work` orchestrator's post-worker reconciliation into ONE call returning a typed verdict the orchestrator switches on mechanically — the symmetric bookend to fn-5's pre-worker brief handoff. The orchestrator owns PROCESS and speaks only in typed envelopes; it no longer hand-fires `planctl show` + `keeper find-task-commit` + `keeper session-state` + `validate --epic`, nor reasons over git porcelain. Delivery cleanliness moves to the WORKER (it self-checks its own commits before returning). The orchestrator's redundant test phase is dropped — the worker can't reach `done` without a passing-test commit (commit-before-done).

NO keeper dependency: the verdict is computed entirely from planctl-native data (status via `merge_task_state`, source commits via `git log` + real-trailer parse, HEAD-visibility via `git cat-file`, epic progress via the task-state tally). This preserves the one-way keeper→planctl dependency and planctl's extractability — a planctl→keeper subprocess (for `dirty_session_files` attribution) would invert the edge into a cycle and was explicitly rejected; delivery cleanliness belongs to the worker under the content-blind division (fn-5), so the orchestrator's verdict never needs attribution. Design pinned in a `/hack` session with codex (gpt-5.5) review.

## Quick commands

- `planctl reconcile --help` — verb registered (the work-skill consistency test requires this)
- `uv run pytest tests/test_reconcile.py tests/test_work_skill_consistency.py`
- `uv run ruff check . && uv run ruff format --check . && uv run ty check`

## Acceptance

- [ ] `planctl reconcile <task_id>` is a read-only verb (readonly invocation, NULL subject/files, NO commit, never calls a mutating verb or `validate --epic`) returning a success envelope `{verdict, task_id, epic_id, status, source_commits, state_head_visible, epic_progress, assessed_at, blocked_reason|null}`.
- [ ] Verdict ∈ `done | in_progress_committed | in_progress_uncommitted | blocked | state_uncommitted | not_started | tooling_error`, per the truth table; bad/missing/ambiguous id → typed error envelope (exit 1) like `resolve-task`.
- [ ] Source-commit detection is trailer-authentic (no prose false-match, no `fn-5.1`/`fn-5.10` substring collision) and runs against `target_repo` / `epic.touched_repos`; `state_head_visible` runs `cat-file` against `state_repo`, guarding the unborn-branch case.
- [ ] The work skill's post-worker tail is a single `reconcile` call + mechanical switch; Phase 3 (orchestrator tests) is dropped; the per-task `validate --epic` is dropped.
- [ ] The worker self-checks delivery cleanliness before returning (its own session work committed).
- [ ] Docs (CLAUDE.md, AGENTS.md, commit-at-mutation-boundary.md, README.md, the workflow mermaid) describe `reconcile` and the consolidated post-worker flow in present tense.
- [ ] `uv run pytest tests/` green; ruff + ty clean.

## Early proof point

Task that proves the approach: task `.1` (the `reconcile` verb + truth table + tests). It establishes the verdict contract the skill (task `.3`) switches on. If it fails (truth table wrong, target/state repo split wrong, trailer false-match): stop and fix the verb before the skill is rewritten against it.

## References

- Design provenance: `/hack` + codex review. Symmetric bookend to fn-5 (pre-worker brief handoff). Option of a keeper-side verdict verb was rejected — `dirty_session_files` is the only fact needing keeper, and delivery cleanliness is the worker's job under the content-blind division.
- HARD DEPENDENCY on `fn-5-content-blind-orchestrator-out-of-band` (open): fn-5 rewrites the SAME work-skill post-worker phases + the SAME worker templates this epic edits, and establishes the resume machinery + content-blind division. This epic lands after fn-5. The epic dep serializes the whole epic behind fn-5 (planctl epic deps are epic-level); task `.1` (the verb) is file-disjoint from fn-5 and may be started by hand before fn-5 closes if desired.
- `fn-756` (approve/ack removal) is `done` — no live overlap remains.
- Scope: only `run_resolve_task.py` is the read-only-verb template; the existing `_find_source_commit_sha` (run_worker_resume.py) is a substring matcher being superseded by a hardened, self-contained finder here (do NOT import it — fn-5 is concurrently rewriting that file).

## Best practices

- **Trailer authenticity:** `git log --grep "Task: <id>" -F` matches prose anywhere and `-F` disables anchoring; confirm a REAL trailer via `--format='%(trailers:key=Task,valueonly=true)'` (with a `%x1f` field separator) or a `git interpret-trailers --parse` post-filter, and match the id EXACTLY (not as a substring). [practice-scout: git pretty-formats]
- **Unborn-branch guard:** run `git rev-parse --verify HEAD` before `git cat-file -e HEAD:<path>` (exit 128 on empty/orphan repo) and treat it as a distinct signal, not `not_found`/`tooling_error`. Tree paths are repo-root-relative, no leading slash. [practice-scout: git-rev-parse]
- **Fail closed:** any git subprocess failure → `tooling_error` verdict (never silently `not_started`/`done`). Use `StrEnum` (if project min Python ≥3.11) for clean JSON; write an exhaustiveness test asserting every verdict has an orchestrator handler. [practice-scout]
- **Snapshot semantics:** emit `assessed_at` + the raw signals (SHAs found, head-visibility) so the verdict is a debuggable, re-validatable snapshot; the orchestrator re-calls rather than caching across a commit boundary (TOCTOU). [practice-scout]

## Docs gaps

- **CLAUDE.md + AGENTS.md** (in sync): read-only verb list (add `reconcile`), skills-and-agents section (new `reconcile` bullet; rewrite the Phase-2b multi-call description to the single switch; Phase-3 drop; worker self-check), worker-contract/recovery paragraphs (task `.4`).
- **commit-at-mutation-boundary.md**: §3 verb-classification table (read-only `reconcile` row), §9 recovery property (reconcile switch; Phase-3 drop; renumber), §13 testing-patterns table (task `.4`).
- **README.md**: command map (`reconcile`) (task `.4`).
- **docs/diagrams/planctl-workflow.mermaid.md**: `verify` node → `reconcile`; remove the `quality` node; `reconcile -.reads.-> cli_layer` (task `.4`).
