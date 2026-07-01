## Description

**Size:** M
**Files:** plugins/plan/src/cli.ts, plugins/plan/src/verbs/detect.ts, plugins/plan/src/verbs/validate.ts (+ validation-restamp seam), plugins/plan/test/verbs-readonly.test.ts, plugins/plan/test/verbs-query.test.ts, plugins/plan/test/verbs-envelope.test.ts, plugins/plan/test/verbs-decorator-mapping.test.ts, plugins/plan/test/src-cli-groups.test.ts

### Approach

Neutralize the generic read-only trailer at its single call site — `emitTrailer()`
(`cli.ts:775-795`) fired at the guard `cli.ts:1040-1042` for any non-NO_TRACK,
non-self-emitting verb — so read/inspection verbs (state-path, detect, status,
epics, close-preflight, gist, show, list, tasks, ready, refine-context, init
read path) emit exactly one JSON value. `emitTrailer` writes `compactJson`
UNCONDITIONALLY regardless of `--format`, so it pollutes `--format human` today
too — dropping it cleans BOTH formats. Then **remove** the now-dead `emitTrailer`
function and its `trailerTarget`/`trailerProjectPath` plumbing (cli.ts:809-812,
875-878, 901, 935-939, 1022-1026) rather than leaving a no-op — biome will flag
the unreferenced code. Leave the merged self-emitters (`emit.ts`
`emitReadonly`/`emitMutating`/`emitMutatingLiteral`) and the
`didSelfEmit`/`resetSelfEmit` sentinel untouched; keep `buildPlanInvocationReadonly`
(still used by the merged footer verbs).

Three load-bearing sub-cases:

1. **detect found-false (a contradiction to resolve).** Today `keeper plan detect`
   in a non-plan dir emits TWO roots — `{found:false}` then a resolver error
   envelope — with exit 1 coming SOLELY from the trailer's `resolveProject`
   (`cli.ts:786`). `buildPlanInvocationReadonly` is pure, so the ONLY load-bearing
   trailer side effect in the whole CLI is this one exit-1. Collapse it to a
   SINGLE value: found-false emits one `{success:false, found:false, error:…}`
   and exits 1 — this satisfies both "one JSON value" AND the `detect || init`
   idiom. detect found-true stays `{found:true,…}` exit 0.

2. **validate --epic (three sub-paths, all single-value).** `validate.ts` prints
   `{valid,errors,warnings}` FIRST (`:183`), then `armEpicValidated` commits
   (`:194`), then on a fresh arm a SECOND `{plan_invocation}` line prints (`:202`).
   Merge the invocation into the envelope AND move the envelope print to AFTER the
   commit lands, preserving the "printed success line ⇒ commit landed" contract.
   Sub-paths: (i) fresh stamp → one `{valid,errors,warnings,plan_invocation}` +
   exit per validity; (ii) no-op (marker already stamped) → bare
   `{valid,errors,warnings}`, no trailer; (iii) commit-failed (`:195-198`, two
   roots today) → one single-value envelope (bare `commit_failed` details folded
   in) + exit 1.

3. **Every OTHER trailer verb resolves its own project first** (repo-scout +
   gap-analyst confirm only detect relies on the trailer for its side effect), so
   close-preflight / gist / refine-context / init / state-path just lose their
   second doc — verify each still exits correctly on a missing project / bad id.

Prune the stale backward-facing narration ("port of cli.py",
"_emit_readonly_invocation", "_NO_TRACK_COMMANDS") at cli.ts:8-13, 74-76, 770-795
per the forward-facing rule. Add the conformance guard.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/cli.ts:775-795 — `emitTrailer()`; :1040-1042 — the single guard/call site; :809-812/:875-878/:901/:935-939/:1022-1026 — the `trailerTarget`/`trailerProjectPath` plumbing to remove; :76 — `NO_TRACK_COMMANDS`
- plugins/plan/src/verbs/detect.ts:17-41 + plugins/plan/src/project.ts:80 — detect found-false + `emitError`; the exit-1 contract to fold into detect's own path
- plugins/plan/src/verbs/validate.ts:183/194/195-198/202 + src/validation_restamp.ts — the three validate --epic sub-paths (print-after-commit, no-op, commit-failed)
- plugins/plan/src/emit.ts:62-184 — merged self-emitters + sentinel (LEAVE UNTOUCHED)
- plugins/plan/src/invocation.ts:32-46 — `buildPlanInvocationReadonly` (pure; KEEP — merged verbs use it)
- plugins/plan/test/verbs-query.test.ts:352-361 — the golden assertion that TODAY asserts the trailer is PRESENT on `list --format human`; FLIP it to assert single-value / no-trailer (do NOT delete it — it is the locus that pins human-format cleanliness)
- plugins/plan/test/verbs-readonly.test.ts:167-181 — pins detect found-false (today two roots + exit 1); rewrite to the single-value form
- test/schema-version.test.ts — conformance-test shape to mirror; plugins/plan/test/src-cli-groups.test.ts — guard home (already iterates verbs)

**Optional** (reference as needed):
- plugins/plan/test/harness.ts:398-421 — `primaryEnvelope`/`parseCliOutput` already filter the trailer (tolerant of absence)

### Risks

- **detect found-false is the primary correctness trap** — a naive trailer delete regresses `detect || init` from exit 1 to exit 0. Pin the single-value + exit-1 shape with a test.
- Merging validate --epic's invocation makes the events deriver start folding validate --epic as a plan event (intended/correct); the print-after-commit reorder must not break the commit-ordering contract, and the commit-failed sub-path must stay single-value + exit 1.
- `--format human` cleanliness is easy to miss: a worker satisfying only the JSON acceptance could DELETE the human-trailer assertion instead of flipping it — the acceptance below pins the flip.
- Don't reorder envelope keys (compact-JSON field order is a wire contract, invocation.ts:3-8).

### Test notes

Flip the four test files that positively assert the SEPARATE trailer from
"assert present" to "assert single value / trailer absent": verbs-readonly.test.ts
(split()/expectedTrailer, ~8 asserts + the found-false rewrite), verbs-query.test.ts
(split()/trailerObj; show/list/tasks trailer-target asserts; the L352-361 human
golden FLIP), verbs-envelope.test.ts (the "read-only invocation trailer" describe
block; the "primary payload omits plan_invocation" test becomes the norm),
verbs-decorator-mapping.test.ts (trailer() helper + read-only target extraction).
Merged-footer tests (saga-find-task-commit, saga-reconcile, claim shape) STAY.
Guard: iterate every read verb via `runCli` on BOTH `--format json` and
`--format human`, AND across error paths (detect found-false / state-path
missing-project / bad-id show|refine-context — the paths most likely to
double-emit); count roots by repeated `JSON.parse` over the buffer (assert exactly
one root / zero trailing non-whitespace bytes) — pretty output is multi-line, so a
line-count heuristic is WRONG.

## Acceptance

- [ ] Every read-only/inspection `keeper plan <verb>` (state-path, detect, status, epics, close-preflight, gist, show, list, tasks, ready, refine-context, init read path) prints exactly one top-level JSON value on stdout under BOTH `--format json` and `--format human` — `json.loads(stdout)` succeeds and `jq .` emits one value.
- [ ] `keeper plan detect` in a non-plan dir emits a single `{success:false, found:false, error:…}` value and exits 1 (the `detect || init` idiom preserved); found-true stays `{found:true,…}` exit 0. Pinned by the rewritten `verbs-readonly.test.ts` case.
- [ ] `keeper plan validate --epic <id>` emits exactly one JSON value on all three sub-paths — fresh stamp (invocation merged, envelope printed AFTER the commit lands), already-stamped no-op (bare envelope), and commit-failed (single-value envelope + exit 1).
- [ ] The `list --format human` trailer assertion (verbs-query.test.ts:352-361) is FLIPPED to assert single-value / no-trailer, not deleted.
- [ ] Merged self-emit verbs (claim/block/done/scaffold/refine-apply/resolve-task/reconcile/find-task-commit/mv-repo) are byte-unchanged.
- [ ] A conformance test asserts every read verb prints exactly one top-level JSON root (root-counting via repeated JSON.parse) across both formats AND the error paths (found-false / missing-project / bad-id).
- [ ] The dead `emitTrailer` function and `trailerTarget`/`trailerProjectPath` plumbing are removed (no no-op left); stale cli.py / `_emit_readonly_invocation` narration pruned; `bun test plugins/plan/test` and `bun run lint` green.

## Done summary
Read/inspection keeper plan verbs now emit exactly one top-level JSON value: dropped the generic plan_invocation trailer, folded detect found-false into a single {success,found,error}+exit-1 value, merged validate --epic's invocation into its single envelope, and added a root-counting single-value conformance guard across both formats and the error paths.
## Evidence
