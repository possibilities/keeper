## Description

**Size:** M
**Files:** plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/followup_submit.ts, plugins/plan/src/verbs/close_finalize.ts, plugins/plan/test/{saga-scaffold,src-scaffold-dryrun,audit-followup-submit,saga-close-finalize}.test.ts (+ the scaffold divergence conformance test)

Layer B — fail-loud backstop. When scaffold mints a `created_by_close_of` follow-up AND the SOURCE epic is multi-repo, refuse to silently default a missing per-task `target_repo`, and reject an emitted `target_repo` that is out of the source's repo set. Deterministic, content-blind (reads only the source epic's `touched_repos` — no findings, clock, or fs inference).

### Approach

1. New reject code `repo_required` (lower_snake_case) via `emitFailureEnvelope`, mirroring the `repo_invalid` emit shape (`scaffold.ts:726-732`). Insert it into the dry-run priority order (`:312-385`) AND `run()`'s priority order (`:658-739`) — both parity-locked loops.
2. Predicate (one small pure helper, used by both seams): source `touched_repos` (realpath-normalized) is a strict superset of `{primary_repo}` (realpath-normalized). When true, every follow-up task MUST carry an explicit `target_repo`; a `null` -> `repo_required`. Single-repo source -> predicate FALSE -> existing default-to-primary behavior unchanged.
3. Membership check: each emitted `target_repo` MUST be a member of the SOURCE epic's `touched_repos` (realpath-normalized) — computed against the source set, NOT the derived new-epic `touched_repos` (which contains every target by construction, so the existing `integrity.ts:287` warn is structurally dead here). An in-set violation -> `repo_required`.
4. Dry-run wiring (`followup_submit.ts:91`): extend `validateScaffoldYaml` to COLLECT `taskTargetRepos` and return it on `ScaffoldValidation` (iface `:93-99`, success return `:403`, `validationFailure` `:106`) — mirror `run()`'s collect (`:606-636`). Read the source `touched_repos` from the brief (Task 1 carries it) via `resolveAuditContext` so the dry-run and mint seams share one source-of-truth. Extend the scaffold divergence conformance test in lockstep.
5. Mint-seam guard: apply the same predicate at `scaffold.ts:769-773` / `scaffoldFollowup` so a direct mint cannot slip past. `close_finalize` already surfaces a non-zero scaffold as `SCAFFOLD_FAILED` (re-runnable, source epic stays open) — reuse it; the reject must land BEFORE `closeEpic` (`close_finalize.ts:229`). No new `CloseOutcome` variant.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/scaffold.ts:93-106, 119-121, 278-295, 312-385, 606-636, 658-739, 726-732, 769-773 — the twin-loop parse + default seam + emit shape; the `:119-121` parity comment is load-bearing.
- plugins/plan/src/verbs/followup_submit.ts:58-139 — dry-run call; `resolveAuditContext` gives `epicId` + `primaryRepo` + `brief`.
- plugins/plan/src/verbs/close_finalize.ts:130-165, 229, 240-275 — `findFollowupEpic` provenance model, irreversible `closeEpic`, `scaffoldFollowup` + `SCAFFOLD_FAILED` re-runnable contract.

**Optional** (reference as needed):
- plugins/plan/src/integrity.ts:287-301 — the existing target_repo-in-touched_repos WARN; do NOT promote it (it's dead for derived follow-up sets) — the new membership check is separate and compares the SOURCE set.

### Risks

- PARITY-LOCKED twin loops (`scaffold.ts:119-121`): `validateScaffoldYaml` and `run()` are kept behavior-identical by conformance tests, not a shared helper. Touch one loop's repo logic and you MUST mirror the other AND extend the divergence conformance test, or the dry-run and mint disagree (the planner burns its 3-resubmit budget on a reject it can't reproduce).
- Path normalization: `target_repo` is `expandPath`-normalized (`scaffold.ts:627`), `touched_repos`/`primary_repo` are `realpathOr`-normalized (`close_preflight.ts:124`), `integrity.ts` uses a third. Pick ONE normalizer and apply it on both sides of the predicate and the membership test, or a correct repo looks out-of-set (false reject) or two equal paths look distinct (mis-fire).
- Both enforcement seams must compute the predicate from the SAME source-of-truth (source `touched_repos`) and SAME normalizer.
- Existing close-finalize fixtures with a multi-repo source + no `target_repo` (`seedFollowupYaml`) will START failing once the guard lands — update those fixtures to carry `target_repo`.

### Test notes

- saga-scaffold.test.ts:464+ (`twoForeignRepos`, slow-gated): `repo_required` reject for a `created_by_close_of` multi-repo follow-up with an omitted target_repo; a PASS case with explicit per-task target_repo; a single-repo source still defaults silently (no reject); a membership-violation reject (target_repo not in source touched_repos).
- src-scaffold-dryrun.test.ts:50: `taskTargetRepos` now on the `ScaffoldValidation` return.
- audit-followup-submit.test.ts: the dry-run `repo_required` case.
- saga-close-finalize.test.ts: a multi-repo source close rejects re-runnably (`SCAFFOLD_FAILED`, source open); update `seedFollowupYaml` fixtures to carry target_repo.
- Extend the scaffold divergence conformance test for the new `taskTargetRepos` field.

## Acceptance

- [ ] `repo_required` reject when a `created_by_close_of` follow-up over a MULTI-repo source omits a task `target_repo` — at BOTH the `followup submit` dry-run and the scaffold mint seam.
- [ ] Membership check: an emitted `target_repo` not in the SOURCE epic's `touched_repos` is rejected.
- [ ] A SINGLE-repo source close is unchanged (no reject; silent default-to-primary preserved).
- [ ] `validateScaffoldYaml` collects + returns `taskTargetRepos`; both twin loops stay in lockstep and the divergence conformance test is extended.
- [ ] The reject reuses the `SCAFFOLD_FAILED` re-runnable contract (source epic stays open) and lands before `epic close`; no new `CloseOutcome` variant.
- [ ] Tests added/updated: saga-scaffold, src-scaffold-dryrun, audit-followup-submit, saga-close-finalize (slow-gated where they touch real git).

## Done summary
Added the fail-loud cross-repo follow-up guard: a created_by_close_of mint over a multi-repo source rejects repo_required when a per-task target_repo is missing or out-of-set, at both the followup-submit dry-run and the scaffold mint seam, via one shared predicate and normalizer. Single-repo sources keep the silent default-to-primary behavior; SCAFFOLD_FAILED stays re-runnable.
## Evidence
