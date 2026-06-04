## Overview

`/plan:queue` does two things: it scaffolds a single-task epic AND flips
the board priority (`queue_jump`). This epic splits those roles. `defer`
becomes the sole single-task scaffolder (absorbing queue's create role and
converting from a generated template to a hand-written source skill), and a
new `/plan:next` skill flips priority on an *existing* epic via a new
`planctl epic queue-jump` CLI verb. Keeper needs zero changes — its reducer
already derives `queue_jump` from any event carrying `planctl_queue_jump=1`
(sticky-true), so a post-hoc envelope on an existing epic id projects the
`!`-prefixed `sort_path` automatically.

## Quick commands

- `uv run pytest tests/test_run_epic_queue_jump.py tests/test_next_skill_consistency.py tests/test_defer_skill_consistency.py`
- `planctl epic queue-jump --help`
- `uv run ruff check . && uv run ty check`

## Acceptance

- [ ] `planctl epic queue-jump <epic_id>` flips `queue_jump=true` on an existing epic, emits an envelope carrying `queue_jump:true`, and short-circuits read-only when already set.
- [ ] `/plan:next` is a hand-written tracked skill (`name: next`) that resolves an epic id (arg or conversation inference) and calls `epic queue-jump`.
- [ ] `/plan:queue` is gone; `defer` is a hand-written tracked source skill (`name: defer`), the shared template is deleted.
- [ ] All prose (the `/plan:plan` menu, README, AGENTS.md, CLAUDE.md, commit-at-mutation-boundary.md) reflects the defer+next model present-tense, no tombstones.
- [ ] `uv run pytest tests/`, `ruff check .`, `ruff format --check .`, `ty check` all pass.

## Early proof point

Task that proves the approach: `.1` (the `epic queue-jump` verb). If the
envelope doesn't carry `queue_jump:true` or the verb lands in
VALIDATION_RESTAMP_VERBS, the whole priority path is wrong — stop and fix
before building the skill on top.

## References

- `planctl/run_epic_invalidate.py` — the exact template for the new verb (conditionally-mutating epic verb with read-only short-circuit).
- keeper `src/reducer.ts` (~line 5649) — derives `queue_jump` by scanning ALL events for `planctl_queue_jump=1`; no keeper change needed.
- CLAUDE.md "Doc & comment style" — present-tense only, no backward-facing tombstones.

## Snippet context

No snippet/bundle substrate attached: the subject is planctl's own
skill/CLI internals (a direct `/plan:plan` invocation, no inherited
bundle), and planctl's snippet substrate is not the subject matter. The
in-repo file:line refs in each task's Investigation targets carry the
context instead.
