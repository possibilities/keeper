## Overview

`keeper dash` groups jobs into tmux-session bands but orders them WITHIN a
band by `created_at`. Reorder them by the live tmux WINDOW POSITION
(`jobs.window_index`, the `#{window_index}` a window's left-to-right visual
slot) so the board matches the operator's tmux window order and reflects
manual window swaps/moves. The column and its fold already exist (DB v71;
the restore-worker probes tmux every `data_version` pulse, posts a
`WindowIndexSnapshot`, the reducer folds it onto `jobs.window_index`, and
`restore-set.ts` already sorts by it). This work only EXPOSES that column on
the read socket and changes the dash's intra-band comparator — no new probe,
worker, fold, or migration.

## Quick commands

- `bun test test/dash-view-model.test.ts`  # fast-tier comparator proof
- `bun run test:opentui`                    # OpenTUI serial chain (dash-app)
- `bun run typecheck && bun run test:full`  # mandatory before landing

## Acceptance

- [ ] Within a session band, `keeper dash` orders jobs by live tmux window
      position; a manual `tmux` window swap reflects on the next pulse.
- [ ] Jobs with no known window index (null / non-tmux / not-yet-probed)
      sort AFTER all known-index jobs, then by `created_at`/`job_id`.
- [ ] No schema bump, no wire-contract regression for other consumers, and
      `bun run test:full` + the OpenTUI chain stay green.

## Early proof point

Task that proves the approach: `.1` — the fast `dash-view-model` ordering
test (reversed-index fixture) proves the comparator beats a stable-sort
false-pass. If it fails: revert the comparator to `created_at` order; the
wire/type additions are harmless on their own.

## References

- `src/restore-set.ts:155-179` — the precedent `window_index` comparator
  (ASC, null/non-finite to tail via `Number.isFinite`); mirror its null
  convention, do not share a helper (separate impls, note for reviewers).
- `src/reducer.ts` `foldWindowIndexSnapshot` + `src/restore-worker.ts`
  producer — the existing fold/producer this work consumes, unchanged.
- `jobs.window_index` exists since DB v71 (`src/db.ts:3822`).

## Docs gaps

- **`src/dash/view-model.ts`**: update the module docstring, the
  `buildDashModel` JSDoc, and the inline sort comment — all describe the old
  `created_at`-ASC intra-band order.
- **`src/collections.ts`**: add a display/sort-only comment for the new
  `window_index` column; prune the stale `active_since` comment that cites a
  removed AGENTS timeline.
- **`src/types.ts`**: JSDoc the new `Job.window_index` field.
- **`README.md`**: revise the `active_since` paragraph that says dash orders
  cards by `created_at` within bands (now stale).

## Best practices

- **Strict total order with an immutable final tiebreak (`job_id`):** keeps
  equal-keyed rows from flicker-swapping under the runtime's sort.
- **Null/absent index sorts last via an explicit guard, never `?? 0`:**
  window index 0 is a valid leftmost slot; coercing null to 0 would jump an
  unprobed job to the front.
- **Group-by-session THEN sort within the group (two passes):** window
  indices across different sessions are not comparable.
