## Overview

The keeper epic board (`cli/board.ts renderJobLinkLines`) lists, under each
epic, every session that touched it, tagged with a link `kind`
(`creator` / `refiner`) derived purely from the planctl op in
`src/plan-classifier.ts` `classifyEntry`. Since the v77 ungate-windows change
(commit 9469e064), every epic-mutating op grafts — so each epic shows one
`creator` plus a pile of `refiner` edges that are actually every autopiloted
`/plan:work` worker (`keeper plan done`) and the `/plan:close` closer
(`keeper plan epic close`). That is clutter: workers are redundant with the
task rows, and both roles are already self-evident from the job title's
`work::` / `close::` spawn-name prefix.

End state: keep the two-kind `creator` / `refiner` taxonomy unchanged, but
exclude the worker's `done` op and the closer's `close` op from producing any
link edge. `refiner` then means only genuine plan-shaping edits
(`refine-apply`, `/plan:next` queue jumps, `epic set-*`, deps, direct CLI).
The link kind is display-only (board renderer is the sole reader), so the
blast radius is the classifier plus a rewind/re-fold migration to purge the
stale persisted edges.

## Quick commands

- `cd /Users/mike/code/keeper && bun run test:full` — full suite (fast tier does NOT cover db/reducer/migration/classifier paths)
- After rebuild + daemon restart + migration, no autopilot session should carry a link edge:
  `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT count(*) FROM epics, json_each(epics.job_links) je WHERE json_extract(je.value,'$.title') LIKE 'work::%' OR json_extract(je.value,'$.title') LIKE 'close::%'"` — expect 0
- Genuine refiners survive: an epic touched by `refine-apply` / `/plan:next` still shows its `refiner` edge.

## Acceptance

- [ ] `classifyEntry` returns null for `op === "done"` and `op === "close"`; `create`/`scaffold`→`creator` and other epic-naming mutations→`refiner` unchanged.
- [ ] After the migration, no `work::` / `close::` session carries a `jobs.epic_links` / `epics.job_links` edge; genuine refiners still do; the `creator` edge is unchanged.
- [ ] A from-scratch re-fold reproduces byte-identical `epic_links` / `job_links`; `created_by_closer_of` follow-up lineage stays intact.
- [ ] `bun run test:full` passes.

## Early proof point

Task that proves the approach: `.1` (it is the whole change). If the migration's
re-fold diverges or wedges the reducer: fall back to a narrower wipe of only the
`jobs`/`epics` link columns and re-derive in-place, rather than a full cursor-0
rewind — but only if mirroring the proven v77 block fails.

## References

- Migration template: commit `9469e064` (v77 ungate), the rewind/wipe/re-fold block at `src/db.ts:4028-4045` — mirror its shape (it corrects the SAME classifier over-population).
- `src/reducer.ts:5740-5765` `created_by_closer_of` — keys on the child's CREATOR edge + the closer's job-row `plan_verb`, NOT a parent refiner edge; the exclusion does not touch it (proven by `test/reducer-links.test.ts:1994`).
- CLAUDE.md event-sourcing invariants: byte-identical re-fold; never-wipe live-only projections without `rewindLiveProjection`.

## Docs gaps

- **`src/plan-classifier.ts`** (module docstring line ~7 "every epic-mutating op links … the only skip" + the "Two-kind taxonomy" block + `classifyEntry` docstring): add a `**Autopilot-op exclusions.**` sub-section documenting the `done`/`close` skips; correct "the only skip" claim.
- **`README.md`** Architecture (the "gated only by the read-only `subject_present` skip" line, ~2338-2341): note the `done`/`close` exclusion; add a v80 schema callout following the v77 block pattern (~2265-2283).
- **`CLAUDE.md`** Migrations section: bump the stale `v76→v79` version reference (line ~74) to the new top version.
- Do NOT revise `.keeper/specs/fn-598*` / `fn-695*` — historical record per repo convention.

## Best practices

- **Wipe + reset cursor atomically, let the boot drain re-fold:** the migration `.immediate()` tx only wipes the projections and rewinds the cursor; the normal post-migrate boot drain does the full re-fold (do NOT fold inline in the migration tx). Mirrors v77; avoids holding the write lock across a full-log replay.
- **Classifier stays a pure constant-time branch:** no clock/env/fs reads — the new skips are pure, so re-fold determinism holds by construction.
