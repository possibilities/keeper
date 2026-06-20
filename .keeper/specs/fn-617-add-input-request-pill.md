## Overview

Surface "session blocked on `AskUserQuestion`" on the keeper board the same
way fn-616 surfaces API errors — a `(last_input_request_at, last_input_request_kind)`
column pair on `jobs`, a `matchAskUserQuestion()` parser in
`src/transcript-worker.ts` that mints a synthetic `InputRequest` event from
a forward-tailed transcript line, a `reducer.ts` arm cloned from
`RateLimited` that flips `state→'stopped'` and stamps both columns under
the terminal guard, four clear paths (`UserPromptSubmit`, `SessionStart`,
and gated `PreToolUse` / `PostToolUse` because `AskUserQuestion` fires no
hooks of its own), and a `[awaiting:<kind>]` board pill colored as `warn`
(yellow) via a new `awaiting:*` prefix fallback in `colorizePillsInLine`.
Initial `InputRequestKind` union: single member `"ask_user_question"`,
future-extensible to `ExitPlanMode` and any other built-in interactive
tool that surfaces a question without a hook.

## Quick commands

- `bun test` — full suite must pass; new reducer / matcher / board tests
  cover the stamp, all four clear paths, re-fold determinism, and the
  colorizer.
- `bun src/daemon.ts &` then drive a real session through
  `AskUserQuestion` and watch `bun scripts/board.ts` — the session row
  should render `[stopped] [awaiting:ask_user_question]` in yellow until
  the human answers, then the `[awaiting:*]` segment drops.

## Acceptance

- [ ] Fresh DB schema (`CREATE_JOBS`) carries both new columns; a v(N-1)→v(N)
      migration on a populated DB lands them via `addColumnIfMissing` and
      re-folds without diff.
- [ ] `InputRequest` synthetic event fold stamps both columns + flips
      `state → 'stopped'`, terminal-guarded against `ENDED`/`KILLED`,
      syncs only when `res.changes > 0`.
- [ ] Four clear arms zero both columns: `UserPromptSubmit` + `SessionStart`
      unconditionally (cheap when already NULL), `PreToolUse` + `PostToolUse`
      gated on `last_input_request_at IS NOT NULL` (hot path — these fire
      on every tool call).
- [ ] Transcript matcher emits `InputRequestMessage{ kind:"input-request",
      sessionId, requestKind:"ask_user_question" }` on assistant turns whose
      `message.content[]` includes `{type:"tool_use", name:"AskUserQuestion"}`,
      iterating the content array (NOT indexing `content[0]`). Pre-filter
      tightens to `'"name":"AskUserQuestion"'` for disjointness from the
      existing `custom-title` / `"rate_limit"` needles AND fn-616's six
      api-error needles.
- [ ] Board renders `[awaiting:ask_user_question]` in `warn` (yellow) via
      the new `awaiting:*` prefix fallback in `colorizePillsInLine`, wired
      into `renderJobLinkLines`, `renderJobLines`, and `projectJobRow`,
      stacking after `[state]` / `[limited]` / `[failed:*]`.
- [ ] From-scratch re-fold (rewind cursor + `DELETE FROM jobs/epics` +
      re-drain) produces byte-identical `jobs` rows, `epics.job_links[]`,
      `epics.tasks[].jobs[]`, and embedded `epics.jobs[]` arrays
      including both new columns.

## Early proof point

Task that proves the approach: `add-input-request-pill.1`. The schema bump
+ reducer fold determinism is the keystone — if the rewind-and-redrain
step or the `enrichJobLink` key-order extension breaks byte-identity,
every downstream task (matcher, board pill) inherits the corruption.
If it fails: pull the rewind step from the version guard and re-derive
against fn-616's task .1 shape (which lands the same template); the
`(at, kind)` pair pattern is identical to fn-616's so a mirror correction
is the recovery.

## References

- Hard dep `fn-616-generalize-api-error-pill` — establishes the
  `(last_<noun>_at, last_<noun>_kind)` schema convention, the
  `apiErrorPillSeg(at, kind)` / `[failed:<kind>]` rendering shape, and
  the prefix-colorizer fallback registration pattern. This epic mirrors
  fn-616 one-for-one with `awaiting:*` / `warn` instead of `failed:*` /
  `error`.

## Docs gaps

- **`README.md` "What keeper is" (~line 10)**: `jobs` state enum sentence
  — consolidate with the existing `rate_limited_at` / `last_api_error_at`
  mention; do not append a new clause.
- **`README.md` Architecture (~lines 454-461)**: transcript-worker
  paragraph — splice `InputRequest` alongside `TranscriptTitle` /
  `RateLimited` as a third class of synthetic event the worker produces.
- **`README.md` Architecture (~lines 473-491)**: schema version callout +
  `jobs` column list — add `last_input_request_at` / `last_input_request_kind`
  with their clear-on semantics (UPS/SessionStart unconditional;
  PreToolUse/PostToolUse gated).
- **`README.md` Example clients (~lines 295-315)**: board pill vocabulary
  — add `[awaiting:<kind>]` in `warn` (yellow) to the bracketed enumeration.
- **`README.md` Inspect (~line 578)**: jobs SELECT comment — add the
  new column names if the default query carries them.

## Best practices

- **Iterate `message.content[]`, don't index `content[0]`.** Rate-limit's
  `matchRateLimit` reads `content[0]` because synthetics carry a single
  text block; real assistant turns interleave text + N tool_uses. Walk
  the array looking for `{type:"tool_use", name:"AskUserQuestion"}`.
- **Tighten the pre-filter to `'"name":"AskUserQuestion"'`** so a future
  `custom-title` line or rate-limit text containing the literal word
  "AskUserQuestion" outside a `name` field can't false-positive.
- **AskUserQuestion fires no hooks of its own** (verified empirically:
  `hookName` grep against two real AskUserQuestion sessions). That's the
  WHY for the `PreToolUse` / `PostToolUse` clear arms — call it out in
  the reducer-arm JSDoc next to the gating rationale.
- **PreToolUse / PostToolUse arms are hot** (50+ fires per turn).
  Gate the clear UPDATE on `last_input_request_at IS NOT NULL`; the
  UPS/SessionStart arms stay unguarded (rare events, NULLifying NULL is
  a no-op).
- **The schema bump triggers rewind-and-redrain** because `EmbeddedJob`
  gains the new pair — same pattern as v17→v18 rate_limited_at and
  whatever step fn-616 lands. Skipping the rewind leaves a mixed-schema
  embedded array on existing epics, silently breaking re-fold determinism.
