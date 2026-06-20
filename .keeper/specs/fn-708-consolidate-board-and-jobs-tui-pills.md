## Overview

The `keeper board` and `keeper jobs` TUIs stamp a pill at the end of
nearly every line, and many lines carry several. A large fraction of
those pills render a field's resting/default value (`todo`, `open`,
`pending`, `unvalidated`, `stopped`, `ok`) on the majority of rows,
burying the exceptions. This epic flattens the pill surface so common
rows carry far fewer pills, with **zero loss of any information a viewer
(human or agent) can currently discern**, then applies presentation
polish (pill/line reordering, spacing) the human explicitly invited —
still strictly information-lossless.

Renderer-only: `cli/board.ts`, `cli/jobs.ts`, `src/board-render.ts`,
`test/board.test.ts`, `test/jobs.test.ts`, plus the inline HELP / README
doc surfaces. No reducer / schema / projection / keeper-py change — every
underlying state already flows to the client, and the readiness `Verdict`
is already computed client-side, so verdict-aware suppression needs no
server change. Full design, recoverability proofs, and the revised render
spec live in `~/docs/pill-inventory.md` (the source of truth).

The three lossless transforms:
- **T1 omit-default** — render a pill only for its non-resting value;
  absence ≡ the one default. Applies to approval (`pending`),
  worker_phase (`open`), runtime_status (`todo`), validated
  (`unvalidated`), job/link state (`stopped`), subagent status
  (`ok`/null/empty). A per-TUI footer legend states the convention.
- **T2 drop-constant** — drop the close-row `[status]` pill on the board
  (always `[open]` under the board filter `status='open'`). Keep the
  underlying `seg(row.status)` capability with a code note that a
  custom-filtered view must restore the pill.
- **T3 drop-when-the-verdict-text-says-it** — drop approval `[rejected]`
  when the adjacent verdict is `[blocked:job-rejected]`; drop
  `[approved]` when the verdict is `[completed]`.

Two ambiguity hazards that MUST be closed:
- `worker_phase=done` and `runtime_status=done` both render bare `[done]`
  → positional ambiguity once defaults are omitted. Render the worker
  survivor as labeled **`[worker-done]`**, never bare, and only when the
  verdict does not already pin it (verdict ∉ {completed, job-pending,
  git-uncommitted, git-orphans}).
- `runtime_status=blocked` renders `[blocked]` next to verdict
  `[blocked:*]` → relabel to **`[rt:blocked]`** (with a matching color
  bucket) to disambiguate.

Also drop the dead jobs monitor `[status]` slot (the projection never
populates it today; restore when `monitors[].status` lands).

## Quick commands

- `bun test test/board.test.ts test/jobs.test.ts` — pill-shape assertions pass
- `bun run typecheck` — no type regressions
- `keeper board` / `keeper jobs` — eyeball: common rows are bare + verdict; defaults absent; footer legend present

## Acceptance

- [ ] Every pill listed for T1 renders only at its non-default value; absence encodes the documented default
- [ ] Close-row `[status]` pill is gone on the board; underlying capability + restore-note retained
- [ ] Approval pill is suppressed where the adjacent verdict already names it (T3)
- [ ] `worker_phase=done` renders as `[worker-done]` (never bare `[done]`) and only when the verdict does not pin it
- [ ] `runtime_status=blocked` renders as `[rt:blocked]`; `[worker-done]` and `[rt:blocked]` are colored
- [ ] Dead jobs monitor `[status]` slot removed (with restore-comment)
- [ ] A per-TUI footer legend documents the absence-encodes-default convention, defined as a single constant, present in both live and piped/sidecar output
- [ ] No discernible information is lost on any row vs. the pre-change TUI (verified against the recoverability ledger in ~/docs/pill-inventory.md)
- [ ] No reducer/schema/projection/keeper-py change; renderer-only diff
- [ ] test/board.test.ts and test/jobs.test.ts updated to the new shapes and green

## Early proof point

Task that proves the approach: `.1` (extract the pure pill helpers into
`src/board-render.ts` with full unit coverage). If it fails — e.g. the
verdict-aware suppression can't be expressed cleanly as a pure
`f(row, verdict)` — fall back to in-place conditional edits in the
`cli/board.ts` closures and assert via the existing full-line string tests
(more brittle, but unblocks the views).

## References

- `~/docs/pill-inventory.md` — full design, Part 3 recoverability ledger (the proof core), Part 4 revised render spec
- `src/readiness.ts` — `Verdict` (294-298), `BlockReason` (215-227), `RunningReason` (257-261), `formatPill` (1595-1606): the client-side vocabulary driving T3 + worker-done gating
- `src/board-render.ts` — `colorizePillsInLine`/`PILL_COLORS` (236-360), `subagentLinesFor` (462-489)
- Layout-stability note (practice-scout): fixed-width slots were considered and rejected — they re-widen rows against T1's purpose, and the live-shell's whole-frame repaint already prevents flicker; row-level jitter on a low-frequency board is acceptable.

## Docs gaps

- **cli/board.ts HELP (130-259)**: revise the epic-header / task-line / creator-refiner row shapes in place to describe omit-default + add the footer legend
- **cli/jobs.ts HELP (97-168)**: revise the job-row shape in place + add the footer legend
- **README.md ## Example clients (685-849)**: revise + consolidate the hardcoded `[runtime_status][worker_phase][approval]` block and `[validated|unvalidated]`; fold in the absence-encodes-default rule
- **src/board-render.ts JSDoc**: update helpers whose output now conditionally elides at the default

## Best practices

- **Omit-default earns its keep when the resting state is common and non-actionable** (exception-finding); pin a persistent legend as the learnability mitigation and ensure it is captured in piped output.
- **Don't apply omit-default asymmetrically across adjacent fields** in a row — a blank cell can read as missing data; keep the convention uniform across both views.
- **Token-collision matrix**: before finalizing `[worker-done]`/`[rt:blocked]`, recheck that no two fields co-rendering on the same row share a token; fix one collision without introducing another.
- **Snippet context**: none attached — `find-snippets "tui pill badge render terminal status"` returned empty, no bundle was inherited, and no scout cited a promptctl snippet; keeper's internal TUI renderer surface is not covered by the cross-project snippet library.
