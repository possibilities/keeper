## Description

**Size:** M
**Files:** planctl/run_close_finalize.py (new), planctl/cli.py, planctl/run_epic_followup_of.py (delete), tests/test_close_finalize.py (new), tests/test_epic_followup_of.py (retire/fold)

### Approach

`planctl close-finalize <epic_id> [--project]` encodes the saga in Python, deriving position purely from observable state — no saga-state file. Order: (1) resolve project + load epic; epic already `done` → return the prior terminal outcome idempotently (inspect followup-of state to pick closed_clean vs closed_with_followup; never call close again — run_epic_close's "already done" error is never hit). (2) Re-derive commit_set_hash fresh via find_commit_groups; mismatch vs persisted verdict/followup artifacts → typed `STALE_ARTIFACTS` error (refuse, never delete; a /plan:close re-run overwrites). (3) Read verdict.json: missing → typed error; fatal:true → outcome `fatal_halt` (no close, epic stays open). (4) Zero surviving decisions (all culled or empty) → `planctl epic close` → `closed_clean`. (5) Else followup-of guard ported in-process from run_epic_followup_of (scan open epics for depends_on_epics containing source, first-seen alphabetic) PLUS the completeness invariant the old skill held caller-side: expected = distinct non-null kept/merged ordinals in verdict.json; found+complete → adopt, skip scaffold; found+partial → typed `PARTIAL_FOLLOWUP` outcome (stop for human); absent → scaffold from persisted followup.yaml (missing followup.yaml with surviving decisions → typed error, fail closed) by invoking the real scaffold path (harness provides CLAUDE_CODE_SESSION_ID), then `epic close` → `closed_with_followup` with new_epic_id. Outcomes are a `CloseOutcome(str, Enum)` (closed_clean | closed_with_followup | fatal_halt | partial_followup) with a reconcile-style exhaustiveness test asserting every member has a skill handler. Retire the standalone `epic followup-of` verb: CLI registration, run module, tests — its logic lives in finalize now.

### Investigation targets

**Required** (read before coding):
- planctl/run_epic_followup_of.py:95-151 — the guard to port (completeness comparison is caller-side today; it moves in here)
- planctl/run_epic_close.py:33 — the "already done" error path finalize must never trigger (status-check-first)
- planctl/run_reconcile.py:51-67, 359-381 + tests/test_reconcile.py:655 — Verdict(str, Enum) + exhaustiveness-test template
- planctl/run_scaffold.py — entry point finalize calls against followup.yaml (mint gate applies here, unlike the dry-run)

**Optional** (reference as needed):
- planctl/run_epic_close.py — close semantics finalize wraps (closer_done_at stamp)

### Risks

The idempotency mapping is the linchpin: a re-run after success must return the same outcome, not an error. Scaffold-inside-finalize means a scaffold failure mid-saga leaves verdict+followup persisted and the epic open — exactly re-runnable, but the error envelope must say so. Crash between scaffold and close → re-run takes the found+complete adopt path; covered by a test.

### Test notes

Truth-table tests per outcome arm; idempotent re-run after each terminal; crash-resume (scaffold landed, close didn't); stale-hash refusal; missing verdict/followup fail-closed; partial-followup stop; exhaustiveness test vs the skill's switch arms; followup-of verb gone (`planctl epic followup-of` exits nonzero / unknown command).

## Acceptance

- [ ] `close-finalize` returns typed outcomes (closed_clean | closed_with_followup | fatal_halt | partial_followup) and is idempotent from observable state across re-runs
- [ ] Stale `commit_set_hash` → `STALE_ARTIFACTS` refusal; fatal verdict halts without close; partial followup stops without scaffold or close
- [ ] `epic followup-of` retired (CLI + module + tests); completeness invariant lives in finalize
- [ ] `uv run pytest tests/test_close_finalize.py -q` green; exhaustiveness test wired

## Done summary
Add close-finalize: a Python saga verb deriving its position from observable state (idempotent re-run, STALE_ARTIFACTS refusal, fatal_halt, clean/follow-up close with crash-resume adopt + partial-followup stop). CloseOutcome(str,Enum) with an exhaustiveness test; ported the followup-of completeness guard in-process and retired the standalone epic followup-of verb (CLI + module + tests).
## Evidence
