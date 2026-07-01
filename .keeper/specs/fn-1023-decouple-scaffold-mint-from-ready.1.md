## Description

**Size:** M
**Files:** plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/validate.ts, plugins/plan/src/verbs/close_finalize.ts, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/skills/close/SKILL.md, plugins/plan/CLAUDE.md, plugins/plan/README.md, plugins/plan/test/saga-scaffold.test.ts, plugins/plan/test/saga-close-finalize.test.ts

### Approach

Flip `scaffold` to mint `last_validated_at: null` and defer the "ready" arm to
an explicit `validate --epic` at every mint site — in ONE commit (the change is
atomic; a partial landing leaves new epics as permanent ghosts, and the existing
scaffold-marker tests fail until flipped). Reuse the existing nullable marker and
`validate --epic`; touch `VALIDATION_RESTAMP_VERBS` zero times (scaffold + validate
are non-members). Four code moves: (1) `scaffold.ts` mint `null` instead of
`nowIso()`; (2) factor a NON-exiting arm seam out of `validate.ts` (returns a
status, no `process.exit`) so close-finalize can arm in-process without corrupting
its envelope — keep the CLI `validate` verb's `process.exit` wrapper for external
callers; (3) `close_finalize.ts` arm the follow-up at the `closed_with_followup`
emit chokepoint via that seam; (4) wire the create-path (`/plan:plan` SKILL) and
defer-path (`/plan:defer` SKILL) arm steps. Then flip the two source tests, add a
close-finalize arm assertion, and prune/rewrite the stale docs.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/scaffold.ts:1143-1155 — the integrity gate (early-return no-op on failure) then the `epicDef.last_validated_at = nowIso()` stamp at 1155. Change 1155 to `null`; leave 1143-1151 untouched.
- plugins/plan/src/verbs/validate.ts:67,127-161 — `runValidate(epicId, format)`; the null→timestamp write (130-136); `autoCommitFromInvocation` at 148; `process.exit(1)` + `commit_failed` compact envelope at 147-161. Factor the core into a non-exiting arm returning a status; the CLI verb keeps exiting.
- plugins/plan/src/verbs/close_finalize.ts:199-224,246-281,451,541,546,569 — `runCaptured` (stdout-swap; `process.exit` skips its finally, so an exiting arm would swallow the failure line); `scaffoldFollowup` (mints + `parseScaffoldEpicId` at 270, returns `newEpicId` at 280); the THREE paths to `closed_with_followup` (451 idempotent-done re-run, 541 adopt-existing-complete, 569 fresh scaffold); `partial_followup` at 546 (must NOT arm). Arm at the chokepoint covering all three closing paths, excluding partial.
- plugins/plan/src/verbs/epic_add_deps.ts:232-240 — restamp fires ONLY inside `if (newEdges > 0)`; a dep-free epic gets no restamp, so the create-path arm must be UNCONDITIONAL.
- src/plan-worker.ts:766-770 — daemon folds committed HEAD only (why an uncommitted post-`commit_failed` stamp is invisible until the next commit sweeps it).

**Optional** (reference as needed):
- plugins/plan/src/validation_restamp.ts:28-40 — `VALIDATION_RESTAMP_VERBS` (11 members; scaffold + validate deliberately absent). This change adds nothing here.
- src/readiness.ts:8-48, src/board-render.ts:259-272 — read-only marker consumers (predicate 2 + `validatedPill`); confirm no daemon-side edit is needed.
- plugins/plan/skills/plan/SKILL.md:343-345,596-608 and skills/defer,skills/close SKILL.md — the flow prose to update.

### Risks

- **Atomicity:** scaffold-mints-null and all three arm sites must land together; do NOT split across commits/tasks (any intermediate state births permanent ghosts, and CI breaks until the scaffold-marker tests flip).
- **close-finalize envelope corruption:** the in-process arm must use the non-exiting seam — calling `runValidate` as-is `process.exit(1)`s on `commit_failed`, skipping `runCaptured`'s stdout restore, corrupting the terminal envelope, and can register a spurious autopilot `dispatch_failure` after the irreversible close. Fold an arm failure into the outcome instead.
- **Adopt-path coverage:** arming "after scaffoldFollowup" misses the two crash-resume adopt paths (451, 541). Arm at the emit chokepoint. Never arm `partial_followup` (a half-built tree must stay non-dispatchable).
- **commit_failed recovery premise (ACCEPTED):** a `commit_failed` during the arm leaves the stamp on disk but HEAD null; a `validate --epic` re-run short-circuits and does NOT re-commit. This is a rare, visible dashed ghost recoverable by the next `.keeper/` commit (documented sweep) — surface the envelope verbatim like every keeper `commit_failed`; build no special recovery, no GC/ABANDONED state.

### Test notes

- Flip plugins/plan/test/saga-scaffold.test.ts:220-222 (`not.toBeNull()` → `toBeNull()`; the test name references the marker) and 589-598 (the "fresh epic carries a microsecond-precise validated marker" test — its whole purpose inverts to "carries a null ghost marker").
- Add an arm assertion to plugins/plan/test/saga-close-finalize.test.ts: in the `closed_with_followup` block (~282-345) and the idempotent-rerun test (~347, which exercises the `status==done` adopt path), assert the follow-up epic's `last_validated_at` is non-null after close.
- Confirm no OTHER source test asserts scaffold immediate-ready: src-api-spine.test.ts:202, verbs-envelope.test.ts:415/480, src-integrity.test.ts already seed/expect `null` (unaffected); worktree-block-state.test.ts:205 is a restamp verb, not fresh scaffold.
- Use `KEEPER_PLAN_NOW` for deterministic stamps; the `withProject` harness runs real git so the marker write rides a genuine `.keeper/` commit.
- Verify the `scaffold --agent-help`/`--help` strings carry no "stamps `last_validated_at`" / "validated" / "ready" language; update to describe the ghost output if present.

## Acceptance

- [ ] `scaffold` mints `last_validated_at: null`; integrity gate unchanged (malformed trees still rejected atomically with no writes).
- [ ] `validate.ts` exposes a non-exiting arm seam (returns a status, no `process.exit`); the `validate --epic` CLI verb behavior is unchanged for external callers.
- [ ] `/plan:plan` create-path SKILL runs `validate --epic <id>` unconditionally after Phase 6 (arms dep-free and dep-bearing epics alike); Phase 5/7 prose updated.
- [ ] `/plan:defer` SKILL arms its scaffolded epic; the "only mutating verb is scaffold" guardrail + Phase 5 report updated.
- [ ] close-finalize arms the follow-up at the `closed_with_followup` chokepoint across all three closing paths, excludes `partial_followup`, and an arm failure folds into the outcome without corrupting the envelope or hard-exiting post-close.
- [ ] `commit_failed` during any arm surfaces the envelope verbatim (no special recovery), consistent with existing keeper commit-failure handling.
- [ ] saga-scaffold.test.ts:220 and :589 flipped to assert the null ghost; a close-finalize follow-up arm assertion added (covering the adopt path).
- [ ] Docs pruned/rewritten: plan/CLAUDE.md "Validation marker" (both halves + the 14→11 count), plan SKILL.md Phase 5/7, defer SKILL.md, close SKILL.md, README validate-envelope wording; no stale scaffold-stamps-inline claim survives anywhere.
- [ ] `bun test` green (and `bun run test:slow` where the close-finalize/scaffold real-git blocks apply); lint + typecheck clean.

## Done summary

## Evidence
