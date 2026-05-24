## Description

**Size:** M
**Files:** src/plan-classifier.ts (new), tests/fixtures/plan_classifier_cases.jsonl (new), test/plan-classifier.test.ts (new), scripts/gen-plan-classifier-fixture.py (new)

### Approach

Port `_compute_plan_windows` + `derive_epic_links` + `derive_job_links`
from `apps/cli_common/cli_common/planctl_invocations.py:304-756` into a
new `src/plan-classifier.ts` as a pure TypeScript module (no I/O, no
clock reads, no DB access). Exports `computePlanWindows(openers)`,
`deriveEpicLinks(invocations, windows)`, `deriveJobLinks(invocationsBySession, windowsBySession, epicId)`.

Port semantics that MUST be preserved byte-for-byte:
- Half-open `[start, next_start)` windows; last window's upper bound is `Number.MAX_SAFE_INTEGER` (NEVER JS `Infinity` — SQLite has no infinity type and bun:sqlite would coerce to NULL if ever persisted).
- `seen_window_creators` per-window suppression of `refiner` when a `creator` for the same target landed in the same window.
- `seen_links` final `(kind, target)` dedup across all windows.
- Final sort `links.sort(key=(kind, target))` ascending — total-order on the full tuple, never on a single field.
- `op === "create" AND isEpicId(target)` → `creator`. Other epic-touching mutations → `refiner` (subject to suppression).
- Skip readonly entries (mirror the Python `subject is None` gate via keeper's `subject_present === false`).

Use `parsePlanRef(target)?.kind === 'epic'` as the `isEpicId` rule
(already shared with the deriver — no second source of truth).

Window opener event shape per the locked decision: the classifier accepts
a list of opener `ts` values; consumers (the reducer fan-out) decide
which event rows feed in. The locked rule is `PreToolUse:Skill AND skill_name='plan:plan'`
only; `slash_command='/plan:plan'` UserPromptSubmit rows are NOT openers
(they'd double-fire on slash-typed invocations).

Unit handling: keeper's `events.ts` is REAL Unix seconds (not ms). The
Python compares ms; the TS port compares seconds throughout — document
the divergence with a comment block at the top of the module.

### Investigation targets

**Required** (read before coding):
- `apps/cli_common/cli_common/planctl_invocations.py:304-364` — `_compute_plan_windows`.
- `apps/cli_common/cli_common/planctl_invocations.py:366-540` — `derive_epic_links` (the core classifier).
- `apps/cli_common/cli_common/planctl_invocations.py:543-756` — `derive_job_links` (symmetric per-epic view).
- `apps/cli_common/cli_common/planctl_invocations.py:1-95` — module-level docstring + `_PLAN_PLAN_NAMES` frozenset.
- `src/derivers.ts:235-275` — `parsePlanRef` (reuse for `isEpicId`).

**Optional**:
- `apps/jobctl/tests/test_plans_namespace.py:1074-1170` — jobctl's `derive_job_links` test fixtures; useful for inspiration but the keeper port has its own fixture file.

### Risks

- Algorithm-port drift: a future Python change must be re-ported manually. Mitigation: the golden-fixture file is regenerated from the Python source and re-asserted in CI; a Python-side change that breaks parity surfaces as a fixture diff during regeneration.
- Dict-iteration / set-iteration order divergence: Python 3.7+ dicts preserve insertion order, but JS object key order is not guaranteed for non-string-keyed accumulators. Audit every collection use; only the final `(kind, target)` sort is observable.
- `ts` unit confusion: Python is ms, keeper is seconds. Both work internally; the parity test feeds seconds-shaped fixtures to the TS port and re-emits the Python's seconds-shaped output by passing `ts_ms / 1000` at fixture-generation time.

### Test notes

Test strategy: a Python script (`scripts/gen-plan-classifier-fixture.py`)
imports the jobctl module, invokes `derive_epic_links` and `derive_job_links`
on a curated set of synthetic invocation streams, and writes one JSONL
line per case to `tests/fixtures/plan_classifier_cases.jsonl`. Each line:
`{"desc": "...", "invocations": [...], "windows": [...], "expected_epic_links": [...], "expected_job_links": [...]}`.
The TS test loads the fixture and asserts byte-identical output per case.

Cover at minimum: empty session, single planctl event (one window, no
next_start boundary), creator-then-refiner-same-epic-multi-window
(BOTH edges emitted), creator-then-refiner-same-epic-same-window
(ONLY creator), refiner-without-creator, read-only verb in window
(no edges), planctl call OUTSIDE all windows (dropped), exact-window-boundary,
window opener at last event (extends to MAX_SAFE_INTEGER), two windows
back-to-back, three windows with creator in middle.

Re-generation is an explicit `bun run gen:fixtures` (or `python scripts/gen-plan-classifier-fixture.py`) — NEVER auto-update in CI.

## Acceptance

- [ ] `src/plan-classifier.ts` exports `computePlanWindows`, `deriveEpicLinks`, `deriveJobLinks` — all pure functions with no I/O.
- [ ] `tests/fixtures/plan_classifier_cases.jsonl` exists with ≥10 distinct edge cases enumerated above.
- [ ] `scripts/gen-plan-classifier-fixture.py` regenerates the fixture from the Python source; the regenerated file is byte-identical to the checked-in version.
- [ ] `test/plan-classifier.test.ts` reads the fixture and asserts byte-identical output per case.
- [ ] No third-party deps added (the module's only imports are local).
- [ ] No reference to `Infinity` in `src/plan-classifier.ts` — sentinel is `Number.MAX_SAFE_INTEGER`.

## Done summary

## Evidence
