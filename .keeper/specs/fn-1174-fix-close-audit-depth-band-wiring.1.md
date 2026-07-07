## Description

Originating finding F1 (with merged F2, F3). Evidence path:
`plugins/plan/src/verbs/close_preflight.ts:183` reads
`policyDoc.close_depth` as a band-keyed mapping and `bandMatches`
(`:148-150`) reads `min_tasks`/`min_diff_lines`/`min_touched_repos`, but
the committed `plugins/plan/audit-policy.yaml` provides a `depth_bands`
LIST of `{depth, min_task_count, min_diff_loc, min_touched_repos}` entries
(only `min_touched_repos` matches). On the real config
`policyDoc.close_depth` is `undefined`, so `deriveDepthBand` hits the
`typeof closeDepth !== "object"` guard and returns
`{ band: "lean", reasons: ["policy_no_depth_bands"] }` unconditionally —
the DEPTH_BAND is always lean+degraded and the variable-depth feature is
inert.

Point the consumer at the real config shape: read `depth_bands` as a
richest-first list, key thresholds on `min_task_count`/`min_diff_loc`/
`min_touched_repos` (matching `plugins/plan/scripts/audit-policy-check.ts`
and `consistency-audit-policy.test.ts`, which both already assert the
`depth_bands` list). The config + drift gate are the source of truth — the
consumer is the side that is wrong.

Files:
- `plugins/plan/src/verbs/close_preflight.ts` (`deriveDepthBand`,
  `bandMatches`, `DEPTH_RANK`, and the doc comments describing the shape).
- `plugins/plan/scripts/audit-policy-check.ts` (F3: extend the drift gate
  to cross-check the keys the runtime consumer reads against the file, so
  consumer and config cannot silently diverge again).
- The close-preflight / deriveDepthBand test file (F2: add a regression
  test threading the REAL committed `audit-policy.yaml`).

## Acceptance

- [ ] `deriveDepthBand` over the committed `audit-policy.yaml` with a
      deep-sized signal set (>= 8 tasks, >= 2000 diff loc, >= 2 repos)
      returns `band === "deep"`; a standard-sized set returns
      `"standard"`; a small set returns `"lean"`.
- [ ] Close-preflight over a deep-sized epic stamps
      `depth.degraded === false` and no `policy_no_depth_bands` reason.
- [ ] A regression test feeds the on-disk policy (not a hand-built
      `close_depth` fixture) and asserts the rising, non-degraded band.
- [ ] The audit-policy drift gate fails if the consumer's read keys drift
      from the file; `bun plugins/plan/scripts/audit-policy-check.ts
      --check` and the fast suite stay green.

## Done summary

## Evidence
