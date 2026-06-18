## Description

**Size:** M
**Files:** planctl/session_markers.py (new), planctl/run_claim.py, planctl/run_done.py, planctl/run_block.py, planctl/run_close_preflight.py, planctl/run_close_finalize.py, the `worker resume` runner module, tests/test_session_markers.py (new)

### Approach

Create `planctl/session_markers.py` owning the full marker contract from the epic spec: schema_version-1 JSON at `~/.local/state/planctl/sessions/<session_id>.json` with `{schema_version, session_id, kind, task_id|epic_id, created_at}`. Public helpers: `write_work_marker(task_id)`, `write_close_marker(epic_id)`, `clear_work_marker(task_id)` (clear-if-matches), `clear_close_marker(epic_id)`, `read_marker(session_id)`. Session id resolves from `CLAUDE_CODE_SESSION_ID` inside the helper — absent env var makes every helper a silent no-op (fail open; manual and test invocations must not error or write). All filesystem errors are swallowed (marker IO must never fail a verb). Readers unlink markers older than 7 days.

Wire success-path calls into the six verbs: `claim` and `worker resume` write the work marker; `done` and `block` clear it (only when the marker's task_id matches the verb's target); `close-preflight` writes the close marker; `close-finalize` clears it on any of its four outcomes. Write/clear must happen only after the verb's own decision is final (claim: after the CAS commit point, alongside the success envelope; never on a typed-error path).

### Investigation targets

**Required** (read before coding):
- planctl/invocation.py:94-105 — existing session-id resolution (fail-closed, mutating path only); the marker helper reads the same env var but fails OPEN — do not reuse the fail-closed function
- planctl/run_claim.py:291-390 — CAS-under-lock structure and the success envelope; marker write belongs on the success path only
- planctl/run_done.py:147-152 and planctl/run_block.py:62-66 — clear sites
- planctl/run_close_preflight.py:255-272 and planctl/run_close_finalize.py:68-80 — close marker write/clear sites; close-finalize clears on every CloseOutcome member
- planctl/run_epic_create.py:16 — XDG-state path precedent (`~/.local/state/planctl/`)

**Optional** (reference as needed):
- tests/conftest.py — fast/slow bucket autouse stubs; marker tests are pure-filesystem and belong in the fast bucket (tmp_path + monkeypatched HOME/env)

### Risks

- The marker schema is consumed by the TS dispatchers (tasks 3–5) — field names and kinds are a cross-language contract; deviating from the epic-spec schema breaks them silently.
- A marker write on a claim error path would create a guard lockout for a task that was never claimed — write strictly on success.

### Test notes

Fast-bucket pytest: helper unit tests (write/clear/clear-if-mismatch/read/stale-unlink/no-env-no-op/io-error-swallow) plus per-verb integration tests asserting marker presence/absence after each verb against a tmp HOME. Locate the `worker resume` runner with a repo search before editing.

## Acceptance

- [ ] `planctl claim` (success) and `planctl worker resume` (success) write a work marker matching the epic-spec schema; typed-error paths write nothing
- [ ] `planctl done` / `planctl block` clear the marker only when its task_id matches; a mismatched marker is left intact
- [ ] `planctl close-preflight` writes the close marker; `close-finalize` clears it on all four outcomes
- [ ] With CLAUDE_CODE_SESSION_ID unset, every helper is a no-op and all six verbs behave exactly as before (existing tests stay green)
- [ ] Marker IO failures (unwritable dir) never fail a verb
- [ ] New tests live in the fast bucket; `uv run pytest tests/` passes

## Done summary
Added planctl/session_markers.py owning the schema_version-1 session-marker contract (fail-open, IO-swallowed, 7-day stale-unlink) and wired success-path writes into claim/worker-resume/close-preflight plus clear-if-matches into done/block/close-finalize. New fast-bucket tests cover helpers and per-verb wiring.
## Evidence
