## Description

**Size:** M
**Files:** planctl/run_epic_queue_jump.py (new), planctl/cli.py, planctl/commit_messages.py, tests/test_run_epic_queue_jump.py (new)

Add a `planctl epic queue-jump <epic_id>` mutating verb that flips
`queue_jump=true` on an existing epic and rides the priority signal on
its `planctl_invocation` envelope so keeper projects the `!`-prefixed
`sort_path`. This is the contract the `/plan:next` skill consumes.

### Approach

Mirror `planctl/run_epic_invalidate.py` almost exactly:
- New `planctl/run_epic_queue_jump.py` with `run(args)`: resolve project,
  load `epics/<epic_id>.json` (emit_error if missing), read
  `primary_repo`. If `queue_jump is True` → short-circuit: emit a
  `build_planctl_invocation_readonly("queue-jump", epic_id, ...)` envelope
  (no write, no commit). Else set `epic_def["queue_jump"]=True`, bump
  `updated_at=now_iso()`, `atomic_write_json`, then
  `emit(..., verb="queue-jump", target=epic_id, repo_root=..., primary_repo=..., queue_jump=True)`.
  `emit()` builds the invocation with `queue_jump=True` so keeper folds it.
- Register `@epic_group.command("queue-jump")` in `planctl/cli.py`
  immediately after the `invalidate` command (~line 1169), lazy-importing
  `planctl.run_epic_queue_jump`.
- Add `"queue-jump": lambda t, d: _subject("queue-jump", t, d)` to
  `VERB_TEMPLATES` in `planctl/commit_messages.py`, near the `invalidate`
  entry, with a one-line comment noting it is a priority-flag verb (not
  structural).
- Update the `queue_jump` scaffold-field help comment in `planctl/cli.py`
  (~line 419) to note the flag can also be set post-hoc via
  `planctl epic queue-jump` (`/plan:next`), instead of only at mint time.
- Do NOT add `queue-jump` to `planctl/validation_restamp.py`
  `VALIDATION_RESTAMP_VERBS` — `queue_jump` is a board-priority signal,
  not structural plan content (same stance as `invalidate`, `approve`,
  `task-set-tier`). Do NOT touch `models.py` — `normalize_epic` already
  defaults `queue_jump=False`.

### Investigation targets

**Required** (read before coding):
- planctl/run_epic_invalidate.py — the template to mirror (short-circuit + emit shapes).
- planctl/cli.py ~line 1169 — the `invalidate` command registration to place `queue-jump` after.
- planctl/cli.py ~line 419 — the scaffold `queue_jump` help comment to update.
- planctl/commit_messages.py ~line 71 — the `invalidate` VERB_TEMPLATES entry; add `queue-jump` nearby.
- planctl/output.py (emit signature) — confirm `queue_jump` kwarg threads to `build_planctl_invocation`.
- planctl/invocation.py — `build_planctl_invocation` / `build_planctl_invocation_readonly` signatures.

### Test notes

New `tests/test_run_epic_queue_jump.py`: (1) verb flips `queue_jump` false→true on the epic JSON and the success envelope's `planctl_invocation` carries `queue_jump:true`; (2) idempotent short-circuit when already true (no second commit, readonly envelope); (3) missing epic → error envelope exit 1. Use `CliRunner` in-process like the sibling epic-verb tests.

## Acceptance

- [ ] `planctl epic queue-jump <epic_id> --help` exits 0.
- [ ] On a `queue_jump:false` epic, the verb sets it true, writes the JSON, and the envelope `planctl_invocation.queue_jump` is `true`.
- [ ] On an already-true epic, the verb is read-only (no JSON rewrite, no `chore(planctl)` commit) and reports the short-circuit.
- [ ] `queue-jump` is NOT in `VALIDATION_RESTAMP_VERBS`.
- [ ] New test file passes; `ruff`/`ty` clean.

## Done summary
Added planctl epic queue-jump verb: flips queue_jump=true on an existing epic and rides queue_jump:true on the planctl_invocation envelope (mirrors run_epic_invalidate). Read-only short-circuit when already true; not in VALIDATION_RESTAMP_VERBS. New test file covers false→true, idempotent short-circuit, and missing-epic error.
## Evidence
