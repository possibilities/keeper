# planctl Bug Fix History (5 Confirmed Defects)

**Date recorded:** 2026-02-09  
**Primary fix commit:** `cb0df21` (`Fix concurrency, registry strictness, and task spec validation`)

This document records the four confirmed defects fixed in `planctl`, including impact, root cause, implementation summary, and verification outcomes.

> **Forward pointer (fn-622, retire-hooks-tracker-db):** Several entries
> below reference the legacy `~/.local/state/claude/hooks-tracker.db`
> sidecar — the `planctl_mutations` / `events` / `job_sessions` tables.
> That sidecar was retired in fn-622: every writer was removed, every
> reader migrated to keeper (`~/code/keeper`, schema-v31), and the db
> file + `-wal` + `-shm` were deleted. The historical narratives below
> are preserved as-is (the bugs really happened against that path), but
> the live equivalents now run against keeper.db. When a description
> mentions `planctl_mutations` / `job_sessions` / a `hooks-tracker.db`
> open, mentally substitute the keeper projection of the same event
> stream; the bug-shapes (closer-job-id resolution, planner eviction,
> etc.) still apply, only the backing store changed.

---

## 1) Concurrent Spec Writes Could Drop History Entries

### Symptom
Under parallel spec mutations, not every write produced a unique version file. Some updates were overwritten or skipped in history.

### Root Cause
Version allocation (`next_version_number`) and write operations were not serialized per spec history directory, creating a race window between version scan and file write.

### Fix
- Added history-directory locking around version allocation and writes.
- Serialized writes to:
  - `history/{id}/vNNN.md`
  - `history/{id}/vNNN.meta.json`
  - `specs/{id}.md`

### Files
- `planctl/specs.py`

### Verification
- Parallel stress run (`20` concurrent updates) now consistently produces `v001 + 20` writes (`21` total versions), with no missing change messages.

---

## 2) `next` Returned First-Epic Match Instead of Global Best Task

### Symptom
`next` could pick a lower-priority task from an earlier-iterated epic even when a better candidate existed in another open epic.

### Root Cause
Selection logic returned immediately inside per-epic loops for both:
- in-progress tasks
- ready tasks

This prevented global ranking across all open epics.

### Fix
- Collected candidates across all eligible epics first.
- Applied global sort key and selected best candidate once.
- Kept current action semantics (`resume_in_progress` first, then `ready_task`).

### Files
- `planctl/run_next.py`

### Verification
- Reproduced cross-epic scenario with intentionally unfavorable epic iteration order.
- `next` now selects the globally higher-priority task.

---

## 3) Corrupt Registry Was Silently Treated as Empty

### Symptom
When `registry.json` was invalid JSON (or malformed structure), commands proceeded as if no projects were registered, masking data corruption.

### Root Cause
Registry loading used permissive safe-load behavior that collapsed parse/IO failures to `None`, then defaulted to an empty registry.

### Fix
- Made registry loading strict:
  - invalid/unreadable JSON raises a clear error
  - missing required keys (`version`, `projects`) is rejected
  - non-list `projects` is rejected
- Wired strict errors through command entry points.

### Files
- `planctl/project.py`
- `planctl/run_init.py`
- `planctl/run_detect.py`

### Verification
- Injected malformed `registry.json`.
- Confirmed `init`, `detect`, and `status` now fail fast with non-zero exit and explicit error output.

---

## 4) Task-Spec Mutations Allowed or Tolerated Malformed Specs

### Symptom
Task-spec write paths could persist malformed markdown (missing required headings), and some mutation paths previously swallowed patch failures.

### Root Cause
- No consistent pre/post heading validation in all mutating command paths.
- In some paths, section patch errors were caught and ignored.

### Fix
- Added strict task-spec validation helper and enforced it across task-spec mutations.
- Hard-fail on malformed specs before/after patch operations.
- Removed silent tolerance in completion/reset mutation flows.

### Files
- `planctl/specs.py`
- `planctl/run_task_set_spec.py`
- `planctl/run_task_set_description.py`
- `planctl/run_task_set_acceptance.py`
- `planctl/run_done.py`
- `planctl/run_task_reset.py`

### Verification
- Confirmed malformed specs now fail mutation commands with explicit validation errors.
- Confirmed valid specs continue to mutate and version correctly.

---

## 5) Done-But-Unacked Epics Silently Dropped From Plans Namespace

**Date recorded:** 2026-05-12
**Epic:** `fn-460-retain-unacked-epics-in-plans-namespace`

### Symptom
Closing an epic that had no open dependent epics caused its bundle to disappear from the jobctl server's in-memory `plans` namespace the moment the close commit landed. Downstream:

- `planctl watch`'s `approvals:` row never rendered for the pending ack.
- The `inflight_pending_ack` slot gate in `_compute_slot_occupancy` couldn't observe the unacked epic, so autopilot moved on to the next epic before the human had run `planctl epic ack`.
- `dashctl`'s pending-approval surface (`_epicPendingApproval` reading `bundle.epic.open_or_unacked`) couldn't paint the awaiting-approval glyph because the bundle was gone.

### Root Cause
Both retention sites in `apps/jobctl/jobctl/run_run_server.py` gated bundle retention purely on open-epic referrers (the `_closed_epic_refs` reverse-dep index):

- `_reconcile_plans_key` Case B (the live-reconcile path) kept the bundle only when `referrers` was non-empty; otherwise it `_REMOVE`d the key.
- `_seed_one_project` (the cold-start seed) `continue`d on every `status == "done"` epic, then only shipped done epics via `closed_to_ship` populated from open-referrer scans.

Neither call site consulted `_compute_open_or_unacked(epic_data)` — the predicate that fn-450 already stamped onto every plans bundle as `epic.open_or_unacked` for the grafted-job retention path and the dashctl TS sibling.

### Fix
Widened the retention predicate at both sites to a logical OR of two arms — referrers OR `_compute_open_or_unacked(epic_data)`. The helper reads the raw epic dict (already available at both call sites); no API changes. Symmetric eviction is already wired through the existing remove arm — once `planctl epic ack` writes `closer_acked_at`, the next reconcile pass sees both arms False and drops the bundle through the unchanged `_REMOVE` branch.

- Live reconcile: `_reconcile_plans_key` Case B keeps the bundle when `referrers OR _compute_open_or_unacked(epic_data)`; the `_reevaluate_retained_jobs()` cascade tail still fires on both arms.
- Cold-start seed: `_seed_one_project` collects a parallel `unacked_to_ship` set on each `status == "done"` epic where `_compute_open_or_unacked(data) == True`, then unions it into `closed_to_ship` before the existing closed-epic ship loop runs verbatim. The reverse-dep arm is unchanged.

### Files
- `apps/jobctl/jobctl/run_run_server.py`
- `apps/prisectl/tests/test_plans_namespace.py`
- `apps/jobctl/CLAUDE.md`

### Verification
- New `TestClosedUnackedRetention` class in `apps/prisectl/tests/test_plans_namespace.py` covers the four-corner truth table (`referrers × open_or_unacked`) for the live-reconcile path plus the cold-start seed-symmetry case for done-unacked epics. Existing `TestClosedEpicShipWhenReferenced` regressions in `test_plans_namespace.py` and the `_reconcile_plans_key` cascade-tail tests in `test_grafted_retention.py` continue to pass.
- Manual smoke: close an epic with no open dependents, run `planctl watch`, confirm the `approvals:` section lists the `[N]` ack-epic row and `concurrency:` shows `1/1 in flight` (slot held by pending ack); run `planctl epic ack <eid>`, confirm both vanish on the next tick.

---

## Cap predicate did not reserve slot for ack-task pending (regressed third-worker fires before human ack)

**Date recorded:** 2026-05-13
**Epic:** `fn-472-reserve-cap-slots-for-ack-task-pending`

### Symptom
Under `task_max_concurrency=2` with three armed epics, each carrying one workable task: workers for epics A and B fire on tick 0; epic A's worker calls `planctl done` (task A.1 transitions to `pending_approval`) and exits; epic C's worker fires on the next tick — BEFORE the human acks A.1. By the time the human runs `planctl task ack`, the cap is saturated and epic A's closer never gets a slot (sits in `closable epics: [wrapped]` indefinitely). Reproduced in `/tmp/planctl-watch-debug/20260513T091121-12830/000017.frame.txt → 000023.frame.txt`.

### Root Cause
fn-465's "ack-orthogonality" design dropped the full `inflight_pending_ack` counter from `_advance_autopilot`'s cap predicate. The rationale at the time was that `pending_approval` runtime-status propagation in `_compute_workable_tasks` + `_dep_epics_runtime_complete` would naturally hold the dep chain, so a forgotten ack only slowed the chain that depended on it. That reasoning is correct for the `ack-epic` subset (closed epic, no follow-up dispatch) but wrong for the `ack-task` subset: the worker had been holding a cap slot while it ran; when the worker exited mid-`pending_approval`, the slot freed and the predicate admitted the next worker before the human could ack. The bug is invisible to end-state-only tests because everything eventually drains; it requires a sequence assertion ("third worker fires AFTER ack, not before").

### Fix
Widened `_compute_slot_occupancy`'s return to a 4-tuple `(inflight_pending, inflight_running, inflight_pending_ack_task, inflight_pending_ack_epic)`. The helper splits the `_compute_pending_approvals` rows by `kind` and filters the `ack-task` count by `epic.status != "done"` so a stale `pending_approval` row on a closed epic does NOT leak a permanent reservation. `_advance_autopilot`'s cap predicate now reads `tasks_in_flight = inflight_pending + inflight_running + inflight_pending_ack_task`. `inflight_pending_ack_epic` stays outside the predicate — closed epics have no follow-up dispatch and reserving their slot would only stall unrelated armed work, so cross-epic ack-orthogonality for the epic-ack subset is preserved (under cap=1 with epic A holding a pending epic-ack, epic B's worker still fires same tick).

`_render_report`'s `slot_occupied_reason` literal stays `Literal["", "slot", "ack"]`; the `"ack"` branch is now reachable in normal flow when the cap is held exclusively by `ack-task` reservations (cap=1 with one ack-task pending and no in-flight worker paints `[waiting: ack]` on other armed rows). Manual `<N><enter>` dispatch is unchanged — it bypasses the cap predicate entirely so the human's explicit escape hatch still fires under any saturation, including ack-task-only saturation. The auditor-exclusion invariant (fn-464) is preserved structurally: `_compute_pending_approvals` never surfaces auditor rows, so neither `inflight_pending_ack_task` nor `inflight_pending_ack_epic` can count one. The existing fn-441 / fn-465 history above stays as context — fn-472 only reverses the `ack-task` slice of fn-465's design.

### Files
- `apps/planctl/planctl/run_watch.py`
- `apps/planctl/tests/test_run_watch_caps.py`
- `apps/planctl/tests/test_compute_slot_occupancy.py`
- `apps/planctl/CLAUDE.md`
- `apps/planctl/README.md`
- `apps/jobctl/CLAUDE.md`
- `apps/dashctl/CLAUDE.md`

### Verification
- New `TestThreeEpicsCapTwoAckTaskReservation` class in `test_run_watch_caps.py` reproduces the canonical bug repro: 3 armed epics, each with 1 task, no deps, `task_max_concurrency=2`. Fires workers for epics A and B; transitions epic A's task into `pending_approval`; runs one autopilot tick; asserts epic C's worker is NOT dispatched (was the observed bug at debug frame 17→18). A second test asserts that after the human acks, epic A's closer is the next dispatch (closer-first ordering).
- New `TestAckOrthogonalityCrossEpic::test_cross_epic_cap_one_ack_epic_does_not_reserve_slot` asserts that `ack-epic` rows continue to NOT reserve a slot under cap=1 — epic B's worker fires same tick.
- Existing `TestAckOrthogonalityWithinEpic::test_sibling_without_dep_*` flipped from "fires under cap=1" to "blocked by ack-task reservation under cap=1" (visible behavior reversal from fn-465 for the ack-task subset).
- `test_compute_slot_occupancy.py` rewritten for the 4-tuple shape, with new tests covering the ack-task / ack-epic split, the stale-pending-approval bound on closed epics, and the auditor-guard structural invariant.

---

## SubagentStop close-gate rejected legitimate closes when PostToolUse:Agent flipped status first

**Date recorded:** 2026-05-15
**Epic:** `fn-480-fix-subagent-stop-close-gate`

### Symptom
Per-turn subagent entries never got their `duration_ms` written, so downstream "is the subagent still running?" predicates (`dashctl isJobActive`, planctl `_is_subagent_running`) reported `true` on entries whose work was actually done. A WARN line `SubagentStop with no matching open entry agent_id=...` accompanied every affected close in the jobctl server log even though a matching `SubagentStart` had clearly fired. Visible in `planctl watch`'s `closable epics:` section never lighting up after every subagent had exited.

### Root Cause
Both `SubagentStop` matchers — the cold-parser arm at `apps/cli_common/cli_common/subagent_invocations.py:529` and the live `_apply_delta` mutator at `apps/jobctl/jobctl/run_run_server.py:3781` — gated entry matching on a conjunction: `duration_ms is None AND status == "running"`. The conjunction assumed `status == "running"` would still hold by the time `SubagentStop` arrived. Anthropic confirmed `PostToolUse:Agent` fires BEFORE `SubagentStop` for Task tool calls (the parent's `Task()` tool result comes back before the subagent's session-level Stop runs). The PostToolUse:Agent fold path legitimately flips `status` from `"running"` to `"ok"` via the `"PreToolUse-wins"` precedence tail. With status already `"ok"`, the SubagentStop matcher rejected the entry, returned BEFORE `apply_mutation`, and the close-path broadcast (the `jobs_updated` envelope) never shipped.

### Fix
Dropped the `status == "running"` clause from BOTH matchers in lockstep. The matcher gate is now `duration_ms is None` alone — one monotonic terminal field set exactly once on close, the canonical idempotency guard. Double-close protection is preserved structurally: after a successful close, `duration_ms` is non-None, so a second `SubagentStop` for the same `agent_id` walks past the closed entry. The status-precedence tail (`if status not in ("failed","unknown"): status = "ok"`) is unchanged at both sites — it becomes a no-op when PostToolUse:Agent already wrote `"ok"`, which is correct, and still preserves `failed` / `unknown` precedence. Inline comments at both sites and the package CLAUDE.md annotations were updated to document the new "open (`duration_ms is None`)" semantic.

### Files
- `apps/cli_common/cli_common/subagent_invocations.py`
- `apps/jobctl/jobctl/run_run_server.py`
- `apps/cli_common/tests/test_subagent_invocations.py`
- `apps/prisectl/tests/test_subagent_invocations_pipeline.py`
- `apps/cli_common/CLAUDE.md`
- `apps/jobctl/CLAUDE.md`

### Verification
- New `test_subagent_stop_closes_after_posttooluse_flipped_status_to_ok` in the cold-parser suite drives the bug-triggering ordering `SubagentStart → PostToolUse:Agent → SubagentStop` and asserts `duration_ms` is written and `status` stays `"ok"`.
- New `test_live_subagent_stop_closes_after_posttooluse_flipped_status_to_ok` in the live-pipeline suite drives the same three-event ordering through `_apply_delta`, asserts the same `duration_ms` / `status` outcome, asserts at least one `jobs_updated` broadcast lands (the pre-fix code returned before `apply_mutation` so no broadcast fired), and asserts the dangling-stop WARN is NOT emitted.
- Existing `test_second_stop_for_same_agent_id_is_skipped` (cold parser F8 double-close) continues to pass — `duration_ms is None` is now the sole gate and remains correct.
- Existing `test_live_subagent_stop_no_open_entry_warns` (live dangling-stop) continues to pass — the WARN substring `"SubagentStop with no matching"` is unchanged.
- `uv run pytest apps/cli_common/tests/test_subagent_invocations.py apps/prisectl/tests/test_subagent_invocations_pipeline.py` — 76 tests pass.

---

## Auto-audit observer's closer-job-id walk lost to same-pass grafted-retention eviction

**Date recorded:** 2026-05-15
**Epic:** `fn-484-auto-audit-closer-id-via-sqlite`

### Symptom
`/plan:audit` never auto-dispatched after `planctl epic ack` on an epic whose closer's verdict carried actionable non-fatal findings. The concrete instance was `fn-476-hibernated-plug-namespace-boot-splash`: the closer wrote tier_1 findings F1 + F2 (`fatal: false`), the human ran `planctl epic ack`, and the jobctl server's `_maybe_auto_audit_on_epic_ack` observer emitted two `INFO: _maybe_auto_audit_on_epic_ack: skip — no closer job in jobs namespace for ...` log lines (plug-relative seconds 2899 / 2909) instead of firing `dispatch.fire(kind="auditor")`. The human had to dispatch `/plan:audit` manually every time the bug landed.

### Root Cause
The observer resolved `closer_job_id` by walking the in-memory `jobs` namespace inside `store.lock` (the same snapshot block that captured the existing-auditor-job gate). The race path is in `apps/jobctl/jobctl/run_run_server.py::_reconcile_plans_key` Case B: `apply_mutation` lands the plans-bundle update with the new `closer_acked_at`, then the same pass runs `_reevaluate_retained_jobs()` which evicts the grafted closer row from the `jobs` namespace (the owning epic just transitioned out of `open_or_unacked`). The async observer thread snapshotted `jobs_ns` AFTER the eviction, found no closer-role row for the epic, and skipped silently. The bug was structural: the in-memory `jobs` namespace was correct for retention purposes but the wrong source for "what was the closer's job_id for this just-closed epic" because the retention predicate flips False the instant `epic.closer_acked_at` lands.

### Fix
Added a new sibling helper `_resolve_closer_job_id_for_epic(epic_id: str) -> str | None` in `apps/planctl/planctl/run_close_context.py` next to `_read_closer_verdict`. It opens `~/.local/state/claude/hooks-tracker.db` read-only and runs `SELECT js.job_id FROM planctl_mutations pm JOIN job_sessions js ON pm.session_id = js.session_id WHERE pm.op = 'close' AND pm.target = ? ORDER BY pm.ts DESC LIMIT 1` — `planctl_mutations` is durable, commits before any plans-event reaches the observer, and the `op='close' / target = epic_id` shape is canonical. Renamed the prior `_resolve_closer_job_id(session_id)` to `_resolve_closer_job_id_for_session` to free the canonical name; updated its one caller inside `_resolve_close_event`. Inside `_maybe_auto_audit_on_epic_ack`, deleted the in-memory `closer_job_id` walk; the resolution now runs OUTSIDE `store.lock` (SQLite blocking I/O is unsafe under the namespace lock) right before the verdict read. The existing-auditor-job walk stays in-memory (no race there — the auditor job hasn't been spawned yet). Updated the skip-log text from `"no closer job in jobs namespace for <bundle_key>"` to `"no close mutation in planctl_mutations for <bundle_key>"` so future "why didn't it fire" investigations land on the right table. Same skip path covers the INNER-JOIN-drop case (close row exists but `job_sessions` has no matching `session_id` — resume-replay edge).

### Files
- `apps/planctl/planctl/run_close_context.py`
- `apps/jobctl/jobctl/run_run_server.py`
- `apps/planctl/tests/test_close_context.py`
- `apps/prisectl/tests/test_auto_audit_observer.py`
- `apps/planctl/CLAUDE.md`
- `apps/jobctl/CLAUDE.md`
- `apps/planctl/docs/reference/planctl-bug-history.md`

### Verification
- New `TestFiresWhenCloserEvictedFromJobsNs::test_fires_when_closer_evicted_from_jobs_ns` in `apps/prisectl/tests/test_auto_audit_observer.py` seeds a real SQLite `hooks-tracker.db` with one `planctl_mutations` close row + one `job_sessions` mapping, leaves `jobs_ns` empty (the race-window state), and asserts `_verb_dispatch_fire` is called with `kind="auditor", task_id="__audit__"`. Two companion tests pin the INNER-JOIN-drop skip path and the latest-close-wins semantic.
- Renamed `test_no_closer_job_skipped → test_no_close_mutation_skipped` asserts the new skip-log text appears and the old `"no closer job in jobs namespace"` string is gone.
- New unit tests `test_resolve_closer_job_id_for_epic_*` in `apps/planctl/tests/test_close_context.py` cover: missing DB → None; empty DB → None; happy path → job_id; INNER-JOIN drop → None; multiple closes → latest wins; non-close mutations on the same target are ignored (load-bearing `WHERE pm.op = 'close'` clause).
- `uv run pytest apps/planctl/tests/test_close_context.py apps/prisectl/tests/test_auto_audit_observer.py -v` — 34 tests pass.

---

## Autopilot driver fed raw jobs without role projection — cap-saturation race regressed

**Date recorded:** 2026-05-15
**Epic:** `fn-489-autopilot-driver-role-projection`

### Symptom
Under `task_max_concurrency=2` with one armed epic carrying three sibling workable tasks `.1` / `.3` / `.7` (no deps), autopilot fired four workers in two ticks instead of the expected two: tick 1 fired `.1` and `.3` as designed; the dispatch observer flipped both dispatch records from `phase="awaiting_registration"` to `phase="running"` once the worker `jobs` rows registered with matching `role.kind == "worker"`; tick 2 then fired `.7` and `.8` because the cap counter `inflight_running` read 0. Production incident: fn-488 epic, sibling-task burst over a single epic. The bug was invisible to all existing tests because they pass `jobs={}` to `advance_autopilot`.

### Root Cause
Per the fn-83 contract, `role` is a snapshot-time wire projection derived on demand from each job's `skill_invocations` list — NOT stored on the in-memory `Store.namespaces["jobs"]` row. The fn-477 migration moved the autopilot driver out of `planctl watch` (which consumed already-projected wire jobs) into the plug-resident `planctl-autopilot-driver` daemon thread, which snapshots `Store.namespaces["jobs"]` directly. The raw rows have no `role` field, so every downstream consumer that filters on `j["role"]["kind"] == "worker"` (`derive_task_runtime_status` worker list-comp, `derive_epic_runtime_status` closer list-comp, `_in_progress_items` via `derive_*`, `_match_running_workers`) silently rejected every raw job. The worker list was empty, `_in_progress_items` returned empty, `inflight_running` was permanently 0, and once the dispatch observer flipped a record from `awaiting_registration` to `running` the slot became invisible to the cap counter. Each subsequent driver tick read `tasks_in_flight = 0` and fired up to cap more dispatches. A twin failure mode existed at `_compute_workable_tasks`'s `_match_running_workers` site — a `todo` task whose dep was `done` with a still-running raw worker job had its dep gate clear vacuously (worker filter rejected the raw job, workers list empty, done-path returned `complete`), surfacing the dependent task as workable while the upstream worker was still wrapping up.

### Fix
Added a small pure-CPU helper `_enrich_jobs_with_role(jobs)` to `apps/planctl/planctl/global_state.py`. The helper returns a new dict-of-dicts where each job value has been shallow-copied and stamped with a freshly-derived `role` field via `cli_common.skill_invocations.derive_role(skill_invocations)`, lazy-imported at call time to keep the module-level import graph lean. **Always overwrites** any pre-existing `role` field on input jobs — never short-circuits — to eliminate the schema-drift footgun where a stale projection at time T1 would silently bypass re-projection at time T2 if `derive_role`'s logic ever widens. Uses the canonical `job.get("skill_invocations") or []` defensive default that the four plug-side projection sites at `run_run_server.py:4599, 6873, 8570, 15494` already use. Wired into `advance_autopilot` via `jobs = _enrich_jobs_with_role(jobs)` immediately after the mode-gate early-return at line 947 and BEFORE every downstream consumer of `jobs` (`_compute_workable_tasks`, `_build_runtime_map`, `_compute_slot_occupancy`). Rebound the local `jobs` name so every callee inherits the enriched view through normal lexical scope — no parameter threading. The enrichment runs OUTSIDE `store.lock` (the driver tick already releases the lock before calling `advance_autopilot`); the shallow-copy-each-job pattern mirrors `_plans_visibly_equal`'s strip-on-shallow-copy idiom. The implicit-contract footgun was closed by three doc surfaces: a paragraph on `advance_autopilot`'s docstring naming the role-projection contract, the `apps/jobctl/CLAUDE.md` "planctl-autopilot-driver" Per-tick work bullet expansion, and this entry.

### Files
- `apps/planctl/planctl/global_state.py`
- `apps/planctl/tests/test_global_state_advance_autopilot.py`
- `apps/jobctl/CLAUDE.md`
- `apps/planctl/docs/reference/planctl-bug-history.md`

### Verification
- New `TestEnrichJobsWithRole` class in `test_global_state_advance_autopilot.py` pins the helper contract: raw-projection, always-overwrite (pre-stamped `role` is replaced), empty/missing `skill_invocations` projects `None`.
- New `TestCapSaturationRunningPhaseRaceFix` reproduces the fn-488 incident: `task_max_concurrency=2`, three workable sibling tasks under one armed epic, two raw worker jobs (no `role` field) with `state="working"` matching `.1` and `.3`, two `phase="running"` dispatches simulating post-observer-flip state. Pre-fix: third sibling fires. Post-fix: `rec.fires == []`.
- New `TestWorkableDepGateRawJobs` pins the twin: a `done` task with a still-running raw worker job hides its `todo` dependent from workable. Pre-fix: dependent surfaces (worker filter rejects raw job, runtime status returns `complete` vacuously). Post-fix: dependent is hidden.
- `uv run pytest apps/planctl/tests/test_global_state_advance_autopilot.py -k "EnrichJobsWithRole or CapSaturationRunningPhaseRaceFix or WorkableDepGateRawJobs" -v` — all green.

---

## `epic.job_links` empty after planner-session eviction (creator/refiner graft vanished post-bounce)

**Date recorded:** 2026-05-16
**Epic:** `fn-491-graft-windows-survive-planner-eviction`

### Symptom
`jobctl dump-state | jq '.plans[].epic.job_links'` returned `[]` for open epics whose planner session had ended (post-end-of-session, post-server-bounce, or never-grafted-and-not-retained), even when the planner's `/plan:plan` event AND every refiner mutation against the epic were still durably present in `~/.local/state/claude/hooks-tracker.db`. The concrete instance was `fn-488-explicit-plan-state-commit-seams`: the planner job `refactor-commit-process` ran `Skill: plan:plan` and emitted the `create` mutation against `fn-488`, but the planner session ended before the plug bounced. Post-bounce, the creator edge was missing from the epic's job_links list and the dashctl `work` pane never rendered the planner row inline on the fn-488 epic card.

### Root Cause
Every plans re-projection rebuilt `epic.job_links` from a `skill_invocations` snapshot taken solely from the live `Store.jobs` mirror (`_snapshot_skill_invocations_locked` at `apps/jobctl/jobctl/run_run_server.py`). The `planctl_invocations` half persisted in a DB-backed namespace seeded from `planctl_mutations` and survived server restarts, but the `skill_invocations` half was live-mirror-only — a planner whose `Store.jobs` row had been evicted (predicate flip on end-of-session OR post-bounce-no-graft-no-retain) contributed an empty skill_invocations list to the windowed classifier, which then drops every mutation as "outside any window" and produces no creator/refiner edges. The bug was structural: the `planctl_invocations` namespace was the source of truth for "which jobs touched this epic" but `skill_invocations` was sourced from a strictly-shorter-lived mirror, so any planner whose row had aged out of `store.jobs` (the common case for finished planners) silently lost its graft.

### Fix
Added a new sibling helper `_snapshot_skill_invocations_with_backfill(store, planctl_invocations_ns, epic_id, *, conn=None, cache=None)` in `apps/jobctl/jobctl/run_run_server.py` next to the existing `_snapshot_skill_invocations_locked` chokepoint. The wrapper composes the in-lock live snapshot (caller-must-hold-lock contract preserved) with a DB-derived backfill: for any `job_id` whose `planctl_invocations` bucket carries an entry pertaining to `epic_id` (`target == epic_id` for creator-side ops OR `epic_id == epic_id` for refiner-side ops) AND that is absent from `store.jobs`, it opens a read-only WAL conn against `DB_PATH` (`file:{DB_PATH}?mode=ro`), batches the IN-clause at a module-level `_SQLITE_VAR_CHUNK = 500`, and routes through the existing `_derive_skill_invocations_from_events` parser so the byte-identical entry shape is preserved (parity invariant intact). Merge precedence is live-wins keyed on key presence in `store.jobs` (not on list emptiness). The DB read happens OUTSIDE `store.lock` (SQLite blocking I/O is unsafe under the namespace lock). `sqlite3.OperationalError` mid-flight propagates per the "fail visibly" rule; only the boot-time `not DB_PATH.exists()` case is a log-and-skip, mirroring `_seed_planctl_invocations_namespace`. The `_unattached` sentinel is filtered upstream from the IN-list. Wired into all three plans-projection sites: `_seed_one_project` (per-pass cache shared across every epic in the project), `_make_plans_reproject` (single-epic, no cache), and `_make_bundle_mutate` inside `_reconcile_plans_key` (single-epic, no cache; read-only DB query is safe inside the surrounding `batch_mutations` block). The original `_snapshot_skill_invocations_locked` body and signature stayed unchanged — it remains the pure in-lock chokepoint composed by the wrapper. `_attach_job_links_to_bundle` and `cli_common.planctl_invocations.derive_job_links` are agnostic to the backfill — the wrapper produces a dict identical in shape to the pure live snapshot, just with extra entries for evicted planners.

### Files
- `apps/jobctl/jobctl/run_run_server.py`
- `apps/cli_common/cli_common/planctl_invocations.py`
- `apps/prisectl/tests/test_plans_namespace.py`
- `apps/jobctl/CLAUDE.md`
- `apps/cli_common/CLAUDE.md`
- `apps/dashctl/CLAUDE.md`
- `apps/planctl/docs/reference/planctl-bug-history.md`

### Verification
- New `TestSnapshotSkillInvocationsWithBackfill` class in `apps/prisectl/tests/test_plans_namespace.py` pins six contracts: (1) live-wins when the planner job is present in `store.jobs`; (2) DB backfill provides the window for an evicted planner that has matching events; (3) missing `DB_PATH` log-and-skips without crash; (4) the `_unattached` sentinel never enters the IN-list (`store.jobs` empty + sentinel-only namespace produces an empty merged dict); (5) the per-pass cache collapses N identical DB queries to 1 across multiple epics anchored by the same evicted planner; (6) `_SQLITE_VAR_CHUNK + 5` evicted ids backfill without an `OperationalError`.
- The "live-wins backfills evicted planner" test also asserts the merged snapshot feeds `derive_job_links` correctly — a creator edge for the evicted planner appears in the link list.
- `uv run pytest apps/prisectl/tests/test_plans_namespace.py apps/cli_common/tests/test_skill_invocations.py apps/prisectl/tests/test_skill_invocations_parity.py apps/prisectl/tests/test_skill_invocations_pipeline.py apps/prisectl/tests/test_grafted_retention.py apps/prisectl/tests/test_planctl_invocations_pipeline.py apps/prisectl/tests/test_plans_dispatcher.py -v` — 245 tests pass; no regressions in the windowed-classifier parity invariant.

---

## `pick_target_job` picked aborted re-claim instead of committing session; `extract_last_assistant_message` surfaced interrupt marker as final message

**Date recorded:** 2026-06-01
**Epic:** `fn-670-deterministic-committing-session`

### Symptom
`/plan:approve` false-rejected correct, committed work when a task had been claimed twice — the first session did the work and committed, the second was an aborted re-claim that exited with `[Request interrupted by user]`. The approve render's `pick_target_job` returned the freshest claim (the aborted re-claim) and `extract_last_assistant_message` read the user-role interrupt marker back as the agent's final message. Concrete instance: `fn-668-backend-exec-coordinates-on-jobs.2` — a clean committing session was outranked by an empty later re-claim and the judge rejected with `last message: interrupt marker`.

### Root Cause
Two correctness defects compounded:
1. **`pick_target_job` ranked by `created_at` only.** The freshest planctl `claim` time outranked the session that actually committed. A re-claim against an already-worked task — common when a worker hits a transient blocker, the human runs `planctl task reset`, and a fresh worker starts the task over — silently shadowed the prior committing session.
2. **`extract_last_assistant_message` accepted user OR assistant turns.** The reverse walk treated user turns as candidates with only a text-prefix `<task-notification>` filter. An interrupt marker (`type: "user"`, `content: "[Request interrupted by user]"`) survived the filter and surfaced as the agent's last message — a token-list reject substring (`please clarify`-class isn't matched here, but Rule 2 inference reads "interrupted" as needs-human and rejects).

### Fix
Server-side and consumer-side complementary. Keeper's git-worker (this epic's T1/T2) now parses the `Task:` trailer + coalesces `Job-Id:` into `committer_session_id` and `foldCommit` stamps a per-job `last_commit_for_task_at` (unix seconds) onto the matching embedded job element under each `Task:` id. This task (.3) lands the consumer-side flip in `apps/planctl/planctl/run_render_approve_context.py`:

- **`pick_target_job`** — for a TASK id, filter the task's embedded jobs to non-`approve` entries; if ANY candidate carries a numeric `last_commit_for_task_at`, return the one with the greatest value (the latest committing session). Fall back to the legacy freshest-`created_at` pick ONLY when no candidate carries the link (pre-v49 keeper data, or task worked-but-not-committed). Defensive on missing/non-numeric (mirrored `-inf` guard). EPIC ids are unchanged — the per-task link does not apply at the epic level.
- **`extract_last_assistant_message`** — assistant-only. Restrict acceptance to `type == "assistant"` OR `role == "assistant"`. The `[Request interrupted by user]` marker (a user turn), `<task-notification>` injections (also user turns — keeper writes them as user), and human prompts are dropped structurally without text matching. The redundant `<task-notification>` text-prefix skip was removed.

Docs: `apps/planctl/skills/approve/SKILL.md` Rule 1 wording flipped (`user/assistant text turn` → `assistant text turn`), `apps/jobctl/jobctl/run_commit_work.py` `_FORBIDDEN_TRAILER_RE` comment annotated to note `Task:` is now consumed by keeper's git-worker for committing-session resolution.

### Files
- `apps/planctl/planctl/run_render_approve_context.py`
- `apps/planctl/tests/test_render_approve_context.py`
- `apps/planctl/skills/approve/SKILL.md`
- `apps/jobctl/jobctl/run_commit_work.py`
- `apps/planctl/docs/reference/planctl-bug-history.md`

### Verification
- New tests in `TestPickTargetJob`: `test_task_id_prefers_committing_session_over_later_claim` reproduces the canonical bug repro (committing session with older `created_at` outranks a later non-committing re-claim); `test_task_id_picks_latest_committer_when_multiple_carry_link` pins the greatest-`last_commit_for_task_at` selection; `test_task_id_falls_back_to_freshest_claim_when_no_link` pins the pre-v49 / never-committed degradation path; `test_task_id_committer_link_non_numeric_treated_as_absent` pins the defensive guard.
- New tests in `TestExtractLastAssistantMessage`: `test_skips_trailing_interrupt_user_turn` reproduces the canonical interrupt-marker shadow; `test_skips_human_prompt_user_turn` pins the human-prompt skip. `test_string_content_accepted_verbatim` flipped from a `role: "user"` turn to `role: "assistant"` (intended behavior change under the new contract).
- `uv run pytest apps/planctl/tests/test_render_approve_context.py -q` — green.

---

## Closer follow-up discovery matched any dependent epic instead of its own scaffolded follow-up

**Date recorded:** 2026-06-10
**Epic:** `fn-15-stamp-closer-follow-up-provenance`

### Symptom
A `/plan:close` run wedged in perpetual `partial_followup`: keeper autopilot re-dispatched `close::<source>` forever (the fn-12/fn-13 incident, 2026-06-10). `close-finalize` adopted an unrelated, human-planned epic — one that legitimately declared `depends_on_epics: [<source>]` for real work-ordering reasons — as the audit follow-up. Its task count did not match the expected surviving-cluster count, so the completeness gate parked the close at `partial_followup` and the source epic never closed. An exact count match would have been worse: the closer would have silently adopted the unrelated epic as the follow-up and closed the source `closed_with_followup`, falsely tying the two epics together.

### Root Cause
`_find_followup_epic` discovered "the follow-up a prior crashed close run scaffolded" by scanning for the first open epic whose `depends_on_epics` contained the source id. That structural heuristic — adoption by label inference rather than positive ownership — cannot distinguish the closer's own scaffolded follow-up from any human-planned epic that depends on the source. Both carry the same dep edge; the dep edge is a real dependency, not a provenance signal. (Pattern analog: Kubernetes label-selector adoption vs. `ownerReferences` — the former is the documented false-adoption failure class.)

### Fix
Positive provenance. The close saga's scaffold step now stamps `created_by_close_of: <source_epic_id>` onto the minted follow-up epic JSON, and discovery matches ONLY on that stamp:

- **`run_scaffold.run`** reads an internal-only `getattr(args, "created_by_close_of", None)` arg (mirrors the `allow_duplicate` defensive pattern) and, when set, adds the key to the in-memory `epic_def` dict before the integrity gate — the stamp rides the same single `atomic_write_json` as the epic, so a crash leaves either no follow-up file or a complete stamped one (no stampless-epic window). The CLI `scaffold_cmd` gains NO flag and the `followup.yaml` schema learns nothing, so a hand-authored plan cannot spoof provenance.
- **`run_close_finalize._scaffold_followup`** threads `created_by_close_of=<source>` into scaffold's `SimpleNamespace`.
- **`run_close_finalize._find_followup_epic`** keeps `sorted(glob())` first-seen determinism and the `actual_tasks` count but flips its predicate to exactly `ep_def.get("created_by_close_of") == source_epic_id` — the `depends_on_epics` membership test is dropped entirely, not even retained as a sanity check. Both call sites (idempotent replay; adopt/partial) inherit the new behavior. The `actual_tasks == expected` count gate is unchanged: a stamped under-provisioned follow-up is still `partial_followup`.
- **`normalize_epic`** defaults the additive field to `None` (no SCHEMA_VERSION bump, matching the `queue_jump` / `close_reason` precedents). There is no backfill — pre-fix closer-minted follow-ups stay unstamped, since backfilling via dep-edge inference would re-execute the removed heuristic.

Docs: README `/plan:close` source-link sentence rewritten (discovery rides `created_by_close_of`; the dep edge remains a real dependency but is not the provenance signal); CLAUDE.md `close-finalize` contract sentence added.

### Files
- `planctl/run_scaffold.py`
- `planctl/run_close_finalize.py`
- `planctl/models.py`
- `tests/test_close_finalize.py`
- `README.md`
- `CLAUDE.md`
- `docs/reference/planctl-bug-history.md`

### Verification
- `test_preexisting_dependent_without_stamp_ignored` — the fn-13 regression: a source epic with surviving findings plus an unrelated open dependent (dep edge, NO stamp, different task count) finalizes by ignoring the dependent, scaffolding the real follow-up, and closing the source `closed_with_followup` with the freshly-minted id.
- `test_closed_with_followup_scaffolds_and_closes` extended to assert the minted follow-up carries `created_by_close_of == source`.
- `test_plain_scaffold_does_not_stamp_provenance` pins that a plain `planctl scaffold` (no internal arg) leaves the field unstamped (None).
- `test_crash_resume_adopts_scaffolded_followup` and `test_partial_followup_stops_without_close` updated to stamp their pre-created follow-ups (modeling the closer's own crashed scaffold); the count gate stays the partial driver.
- `uv run pytest tests/test_close_finalize.py -q` and `uv run pytest tests/ -q` — green.

---

## Notes

- These fixes were implemented without changing core CLI surface area.
- Behavioral changes are defensive and correctness-oriented:
  - stronger integrity guarantees
  - deterministic scheduling behavior
  - explicit failure on corrupted state
