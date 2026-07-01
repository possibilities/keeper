## Description

**Size:** M
**Files:** plugins/plan/src/cli.ts, plugins/plan/src/verbs/detect.ts, plugins/plan/src/verbs/validate.ts (+ validation-restamp seam), plugins/plan/test/verbs-readonly.test.ts, plugins/plan/test/verbs-query.test.ts, plugins/plan/test/verbs-envelope.test.ts, plugins/plan/test/verbs-decorator-mapping.test.ts, plugins/plan/test/src-cli-groups.test.ts

### Approach

Neutralize the generic read-only trailer at its single call site — `emitTrailer()`
(`cli.ts:775-795`) fired at the guard `cli.ts:1040-1042` for any non-NO_TRACK,
non-self-emitting verb — so read/inspection verbs (state-path, detect, status,
epics, close-preflight, gist, show, list, tasks, ready, refine-context, init
read path) emit exactly one JSON value. Leave the merged self-emitters
(`emit.ts` `emitReadonly`/`emitMutating`/`emitMutatingLiteral`) and the
`didSelfEmit`/`resetSelfEmit` sentinel untouched; keep `buildPlanInvocationReadonly`
(still used by the merged footer verbs).

Two load-bearing sub-cases:
1. **detect found-false:** `keeper plan detect` in a non-plan dir today gets its
   error envelope + exit 1 SOLELY from the trailer re-resolving the project.
   Preserve that contract explicitly in detect's own path — do NOT let dropping
   the trailer regress `detect || init` from exit 1 to exit 0.
2. **validate --epic:** bring it to single-value compliance by MERGING its
   `plan_invocation` into its `{valid,errors,warnings}` envelope on the stamp
   (mutation) path; the read-only/no-op path (marker already stamped) emits the
   bare envelope with no trailer. This treats validate --epic like the mutation
   it is (it also lets the events deriver fold it as a real plan event).

Prune the stale backward-facing narration ("port of cli.py", "_emit_readonly_invocation",
"_NO_TRACK_COMMANDS") at cli.ts:8-13, 74-76, 770-795 per the forward-facing rule.
Add the conformance guard.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/cli.ts:775-795 — `emitTrailer()`, the second-line emitter to neutralize
- plugins/plan/src/cli.ts:1040-1042 — the single guard/call site firing the trailer
- plugins/plan/src/cli.ts:76 — `NO_TRACK_COMMANDS` (cat, validate)
- plugins/plan/src/verbs/detect.ts:17-41 + plugins/plan/src/project.ts:80 — detect found-false + `emitError`; the exit-1 contract to preserve
- plugins/plan/src/verbs/validate.ts + src/validation_restamp.ts — the `validate --epic` stamp/commit path to merge the invocation into
- plugins/plan/src/emit.ts:62-184 — merged self-emitters + sentinel (LEAVE UNTOUCHED)
- plugins/plan/src/invocation.ts:32-46 — `buildPlanInvocationReadonly` (KEEP — merged verbs use it)
- test/schema-version.test.ts — conformance-test shape to mirror
- plugins/plan/test/src-cli-groups.test.ts — natural home for the guard (already iterates verbs)

**Optional** (reference as needed):
- plugins/plan/test/harness.ts:398-421 — `primaryEnvelope`/`parseCliOutput` already filter the trailer (tolerant of absence)

### Risks

- detect found-false exit-1 regression if the trailer is merely deleted — the primary correctness trap; pin it with a test.
- Merging validate --epic's invocation changes a conditional-mutation path AND makes the events deriver start folding validate --epic as a plan event — verify no downstream surprise (this is the intended, correct behavior).
- close-preflight / gist / refine-context / init also fire the trailer — confirm none carries a detect-like load-bearing side effect (repo-scout: only detect does) before dropping.
- Don't reorder envelope keys (compact-JSON field order is a wire contract, invocation.ts:3-8).

### Test notes

Flip the four test files that positively assert the SEPARATE trailer from
"assert trailer present" to "assert single value / trailer absent":
verbs-readonly.test.ts (split()/expectedTrailer, ~8 asserts), verbs-query.test.ts
(split()/trailerObj; show/list/tasks trailer-target asserts), verbs-envelope.test.ts
(the "read-only invocation trailer" describe block; the "primary payload omits
plan_invocation" test becomes the norm), verbs-decorator-mapping.test.ts (trailer()
helper + read-only target extraction). Merged-footer tests (saga-find-task-commit,
saga-reconcile, claim shape) STAY. Guard: iterate every read verb via `runCli`,
`JSON.parse` the full stdout AND assert exactly one root (zero trailing
non-whitespace bytes) — NOT a line count.

## Acceptance

- [ ] Every read-only/inspection `keeper plan <verb>` (state-path, detect, status, epics, close-preflight, gist, show, list, tasks, ready, refine-context, init read path) prints exactly one top-level JSON value — `json.loads(stdout)` succeeds and `jq .` emits one value.
- [ ] `keeper plan detect` in a non-plan dir emits its found-false error envelope and exits 1 (the `detect || init` idiom is preserved), pinned by a test.
- [ ] `keeper plan validate --epic <id>` emits exactly one JSON value (invocation merged on the stamp path; bare envelope on the no-op path).
- [ ] Merged self-emit verbs (claim/block/done/scaffold/refine-apply/resolve-task/reconcile/find-task-commit/mv-repo) are byte-unchanged.
- [ ] A conformance test asserts every read verb prints exactly one top-level JSON root (root-counting, not line-count).
- [ ] Stale cli.py / `_emit_readonly_invocation` narration pruned; `bun test plugins/plan/test` green.

## Done summary

## Evidence
