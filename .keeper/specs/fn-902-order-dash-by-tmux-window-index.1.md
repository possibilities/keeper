## Description

**Size:** M
**Files:** src/collections.ts, src/types.ts, src/dash/view-model.ts, test/dash-view-model.test.ts, test/dash-app.test.ts, test/collections.test.ts, README.md

### Approach

Expose the already-folded `jobs.window_index` on the read socket and sort
the dash on it. (1) Add `"window_index"` to `JOBS_DESCRIPTOR.columns` in
`src/collections.ts` with a one-line `// Display/sort-only.` comment — do
NOT add it to `sortable` / `filters` / `jsonColumns` (it is a plain INTEGER
scalar sorted CLIENT-side). (2) Add `window_index: number | null` to the
`Job` interface in `src/types.ts` with a forward-facing JSDoc (live tmux
`#{window_index}`, the window's left-to-right VISUAL position, folded from
`WindowIndexSnapshot`, display/sort-only). (3) In `src/dash/view-model.ts`,
thread `window_index` into the parallel `sortKey` map (the comparator reads
`sortKey`, not the `Job` — add it alongside `created`/`id`) and make it the
PRIMARY sort key: a KNOWN index (treat `typeof === "number" && Number.isFinite`
as known — mirror `restore-set.ts:161-179`) sorts ASC and precedes any
unknown (null/undefined/non-finite, which sorts last); ties break by
`created_at` ASC then `job_id` ASC. The readiness-client decodes jobs via a
generic `row as unknown as Job` cast (`src/readiness-client.ts:1539-1542`),
so the column flows through with NO decoder change once it is in `columns`.

### Investigation targets

**Required** (read before coding):
- src/collections.ts:69-112 — `JOBS_DESCRIPTOR.columns` (add the column here; note the `active_since`/`monitors` display-only comment style; `sortable` allowlist at :115)
- src/types.ts:266-432 — `Job` interface (add the field; match the paired-null JSDoc style of `active_since`/`backend_exec_*`)
- src/dash/view-model.ts:313-346 — the `sortKey` map (:315,330) + the `byCreated` comparator (:335-346) — the edit site
- src/restore-set.ts:155-179 — the precedent comparator: window_index ASC, known-precedes-unknown, `Number.isFinite` guard. Mirror the null convention (separate impl, do not extract a shared helper).
- src/readiness-client.ts:1539-1542 — confirm the generic cast (no decoder change)

**Optional** (reference as needed):
- src/reducer.ts (foldWindowIndexSnapshot, ~:3215) + src/restore-worker.ts (producer) — context only; DO NOT change the fold/producer
- test/restore-set.test.ts:364,553 — the "reverse the window_index so a stable-sort false-pass can't hide" fixture idiom; mirror it in the new dash test
- test/dash-view-model.test.ts:40-72 — `makeJob` literal (add the field; ordering cases home here)
- test/dash-app.test.ts:55-87 — `makeJob` literal (add the field)
- test/collections.test.ts:212,225 — the targeted `toContain` assertion style

### Risks

- `window_index` is producer-fed (a tmux probe at record time) but folded
  from PERSISTED `WindowIndexSnapshot` events — this task only READS it on
  the wire. Do NOT touch the fold/retention, do NOT add it to
  `LIVE_ONLY_JOBS_COLUMNS`, and do NOT bump `SCHEMA_VERSION` (the column
  exists at v71).
- A non-finite/null index must sort last via the explicit guard — NaN
  poisons `Array.sort`, and `?? 0` would wrongly front-rank an unprobed job
  (window 0 is a real leftmost slot).
- Freshness is pulse-bounded (a swap reflects on the restore-worker's next
  `data_version` pulse — lags only on a fully idle board). Accepted; do not
  try to make it frame-tight.

### Test notes

- Put the ordering proof in the FAST `test/dash-view-model.test.ts` (pure,
  no `@opentui`): assert window_index beats `created_at` within one session,
  nulls tail, and use a REVERSED window_index vs created_at fixture so a
  stable-sort false-pass can't pass. Add `window_index: null` to its
  `makeJob`.
- `test/dash-app.test.ts` needs `window_index` added to its `makeJob`; an
  optional frame-order assertion is nice but the behavior proof belongs in
  the fast test. It is in the OpenTUI serial chain — validate via
  `bun run test`, NEVER a bare `bun test --parallel`.
- Add `expect(JOBS_DESCRIPTOR.columns).toContain("window_index")` to
  `test/collections.test.ts`; confirm no test asserts the full column array
  (length/`toEqual`) that an added column would break.
- Update the stale ordering comments (view-model docstring/JSDoc/inline,
  collections column comment + the stale `active_since` note, types JSDoc,
  README `active_since` paragraph). `bun run typecheck` then `bun run test:full`.

## Acceptance

- [ ] `"window_index"` is in `JOBS_DESCRIPTOR.columns`; it is NOT in `sortable`, `filters`, or `jsonColumns`.
- [ ] `Job.window_index: number | null` exists with a forward-facing JSDoc; both dash `makeJob` fixtures set it; `test/collections.test.ts` asserts `toContain("window_index")`.
- [ ] The dash intra-session comparator orders: known `window_index` ASC → `created_at` ASC → `job_id` ASC, with null/undefined/non-finite indices sorting AFTER all known ones (window 0 stays a valid leftmost slot, not "unknown").
- [ ] A fast `dash-view-model` test proves window_index beats created_at within a session and nulls tail, using a reversed-index fixture (no stable-sort false-pass).
- [ ] The stale `created_at`-order comments/docstrings (view-model.ts, collections.ts, types.ts, README) are updated to the new order; no ticket/epic ids in the prose.
- [ ] `bun run typecheck` clean; `bun run test` (OpenTUI chain) and `bun run test:full` green; no `SCHEMA_VERSION` / `keeper/api.py` change.

## Done summary

## Evidence
