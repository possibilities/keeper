## Overview

The transcript worker only matches one `isApiErrorMessage` envelope today (`error: "rate_limit"`), so when Claude Code stops a session with `authentication_failed`, `server_error`, `billing_error`, or `invalid_request`, the board renders the row as `[stopped]` with no signal as to why. A 30-day transcript inventory confirmed the four observed kinds; the openclaude SDK declares six terminal kinds (excluding the recoverable `max_output_tokens`).

Replace the narrow `jobs.rate_limited_at REAL` column with a two-field signal `jobs.last_api_error_at REAL` + `jobs.last_api_error_kind TEXT`, generalize the transcript matcher to dispatch on all six kinds, rename the synthetic event `RateLimited` → `ApiError`, and render `[failed:<kind>]` in board.ts colored red via a `failed:*` prefix fallback in the colorizer (mirrors the existing `blocked:*` → warn fallback). Historical `RateLimited` events keep folding deterministically via a dual-case fold-time alias — no stored-event rewrite, no data backfill.

The change touches event-log re-fold determinism (the `EmbeddedJobElement` shape inside `epics.jobs` JSON arrays widens, which requires the v17→v18-style rewind-and-redrain migration pattern, not a paired-ADD-only) and the persisted `JobLinkEntry` shape (`enrichJobLink` enrichment widens — single source of truth shared by live reducer fan-out, jobs-write fan-out, and the migration backfill).

## Quick commands

- `bun test test/db.test.ts -t "v23.*v24"` — migration test for the schema bump
- `bun test test/reducer.test.ts -t "ApiError"` — fold arm + dual-case historical-alias coverage
- `bun test test/transcript-worker.test.ts -t "matchApiError"` — matcher coverage across the six kinds + negative coverage on `api_retry` / `SDKRateLimitEvent`
- `bun test test/board.test.ts -t "failed:"` — pill render + colorizer prefix-fallback coverage
- End-to-end smoke: stop keeperd, delete db, restart, force a 401 in any tracked session (run `claude` with a stale token), observe `[failed:authentication_failed]` in `bun scripts/board.ts`

## Acceptance

- [ ] Schema migrates v23 → v24: `jobs.rate_limited_at` dropped, `jobs.last_api_error_at REAL` + `jobs.last_api_error_kind TEXT` added; `SCHEMA_VERSION` bumped at `src/db.ts:56`; both columns also added to the `CREATE_JOBS` literal verbatim per the lockstep convention.
- [ ] v23 → v24 migration follows the v17→v18 rewind-and-redrain pattern (`reducer_state.last_event_id = 0` + `DELETE FROM jobs/epics/subagent_invocations`), version-guarded so a re-run can't corrupt an already-migrated schema. The `EmbeddedJobElement` shape change inside `epics.jobs` JSON arrays forces this — a paired-ADD-only migration would leave neighbour entries with mixed old+new shape.
- [ ] Reducer's `case "RateLimited"` becomes a dual-case fold: both `case "RateLimited"` (forever, for historical events; forces `kind = "rate_limit"`) AND `case "ApiError"` (new mint; reads `event.data.kind ?? "unknown"`). Both arms write `last_api_error_at` + `last_api_error_kind` in a single compound UPDATE. Stop / SessionEnd / Killed preserve both columns; only `ApiError` arm sets, only `UserPromptSubmit` revival arm clears.
- [ ] `UserPromptSubmit` revival arm clears BOTH new columns together (paired-NULL invariant maintained at fold layer, not via SQLite CHECK).
- [ ] `enrichJobLink` SELECT widens to read `(title, state, last_api_error_at, last_api_error_kind)`. `JobLinkEntry` persisted JSON shape gains both new fields and drops `rate_limited_at`. Key order in the entry literal is byte-stable across live reducer + jobs-write fan-out + migration backfill (single shared helper).
- [ ] `syncJobLinksOnJobWrite` trigger column set updated to include both new columns; the docstring at `src/reducer.ts:1744` updated.
- [ ] `Job`, `EmbeddedJob`, `EmbeddedJobElement`, `JobsRowForSync` types widen; `buildEmbeddedJob` fills both fields; `collections.ts:104` JOBS_DESCRIPTOR.columns swaps.
- [ ] Transcript matcher `matchRateLimit` → `matchApiError`. Gate fields stay `type:"assistant"` + `isApiErrorMessage:true` + valid `sessionId`. Dispatch on `error.type ∈ {"rate_limit", "authentication_failed", "billing_error", "server_error", "invalid_request"}` to the explicit kind; anything else (including the SDK's own `"unknown"`) folds to `"unknown"`. **`max_output_tokens` is explicitly excluded** — openclaude's query loop treats it as recoverable via compact+retry, so stamping would mis-classify recovering sessions. `SDKAPIRetryMessage` (`type:"system", subtype:"api_retry"`) and `SDKRateLimitEvent` (quota notification) MUST NOT match.
- [ ] `dispatchLine` cheap pre-filter widens from `line.includes('"rate_limit"')` to `line.includes('"isApiErrorMessage":true')` — covers all six kinds without false-positiving on the two skipped frames.
- [ ] Worker→main message: `RateLimitedMessage` → `ApiErrorMessage` carrying `{kind, sessionId, text}`. Daemon synthetic-event mint at `src/daemon.ts:311-351` switches from `hook_event:"RateLimited", event_type:"rate_limited", data.rate_limit_text` to `hook_event:"ApiError", event_type:"api_error", data: {kind, text}`. All sparse columns null per synthetic convention.
- [ ] `scripts/board.ts`: `rateLimitedPillSeg(v)` → `apiErrorPillSeg(at, kind)` returning ` [failed:<kind>]` when `at != null`. Colorizer gains a `failed:*` prefix fallback routed to the `error` bucket (alongside the existing `blocked:*` → warn fallback). `PILL_COLORS.limited` dropped. All three call sites (`renderJobLinkLines`, `renderJobLines`, `projectJobRow`) updated to pass both new fields.
- [ ] All six `[failed:<kind>]` tokens render red on a TTY (the four observed + `billing_error` + `invalid_request`); verified by a colorizer test that runs each token through `colorizePillsInLine` and asserts the inner-token SGR matches the `error` bucket sequence.
- [ ] HELP text in `scripts/board.ts:107-111`, module-level docstring, and `renderJobLinkLines` JSDoc updated to describe `[failed:<kind>]` and the failed:* prefix fallback. `[limited]` removed from all user-facing prose.
- [ ] `CLAUDE.md` lines 39-46 updated: `JobLinkEntry` shape literal, the `state` flip-trigger list (`RateLimited` → `ApiError`), the `enrichJobLink` enrichment shape. `README.md` schema-vN prose + the two SQL snippets at lines 481-490, 606-611 updated. `AGENTS.md` symlink unchanged (in-place edit of `CLAUDE.md`).
- [ ] Existing tests with `rate_limited_at: null` defaults (35+ occurrences across `test/reducer.test.ts`, `test/board.test.ts`, `test/readiness.test.ts`, `test/db.test.ts`) migrated to the new two-field defaults; the v20→v21 migration test sibling at `test/db.test.ts:3100` (`expect(ver.value).toBe("23")`) updated to "24".
- [ ] New tests: migration test for v23 → v24 (`test/db.test.ts`, mirroring the v17→v18 / v20→v21 pattern); `case "ApiError"` reducer test covering all six kinds + unknown-fallback + dual-case alias on stored `RateLimited` rows; `matchApiError` matcher tests for the six kinds + negative coverage on `api_retry` and `SDKRateLimitEvent` lines; board render test for `[failed:rate_limit]`, `[failed:authentication_failed]`, `[failed:server_error]`, `[failed:billing_error]`, `[failed:invalid_request]`, `[failed:unknown]` pills.
- [ ] `bun test` passes; `bun run lint` (or repo's lint pipeline) passes; existing tests that don't touch the rate-limit path remain unmodified.

## Early proof point

Task that proves the approach: `<epic_id>.1` (schema migration + reducer rewrite + JobLinkEntry widening). If the v23 → v24 migration cleanly rewinds-and-redrains AND the existing rate-limit-path tests pass under the dual-case fold (the historical `RateLimited` events still fold to `kind="rate_limit"` and produce byte-identical projection rows), the keystone is proven. Tasks .2 and .3 are mechanical extensions. If it fails: the most likely failure modes are (a) the rewind missing a projection table, leaving mixed-shape entries — fix by inspecting the v17→v18 step at `src/db.ts:1495-1500` byte-for-byte, or (b) the `enrichJobLink` literal key order drifting between live and backfill paths — fix by routing the migration backfill through the same helper rather than re-inlining the SELECT.

## References

- `src/db.ts:1460-1500` — v17→v18 rewind-and-redrain template (this is the migration pattern, NOT v20→v21's in-place re-derive — embedded shape changes force the rewind).
- `src/db.ts:1820-1961` — v20→v21 in-place re-derive (informative; not the chosen pattern here).
- `src/reducer.ts:1716` — `enrichJobLink` (single source of truth; live + backfill must route through this).
- `CLAUDE.md` — "Event-sourcing invariants" section (re-fold determinism contract, schema defaults match zero-event projection, the JobLinkEntry shape is part of the persisted contract).
- openclaude SDK types `SDKAssistantMessageError` — canonical seven-kind union (`authentication_failed | billing_error | rate_limit | invalid_request | server_error | unknown | max_output_tokens`). We stamp six (excluding `max_output_tokens`). Source: `Gitlawb/openclaude` `src/entrypoints/sdk/coreTypes.generated.ts`.
- `SDKAPIRetryMessage` + `SDKRateLimitEvent` (also from openclaude) — the two frame types the matcher MUST NOT trigger on.

## Docs gaps

- **`CLAUDE.md` lines 39-46**: `JobLinkEntry` shape literal `{kind, job_id, title, state, rate_limited_at}` → `{kind, job_id, title, state, last_api_error_at, last_api_error_kind}`; the state-flip trigger list `UserPromptSubmit / Stop / SessionEnd / Killed / RateLimited` → replace `RateLimited` with `ApiError`; the `enrichJobLink` enrichment shape line.
- **`README.md` lines 481-490, 606-611**: schema-vN prose (bump from v21 narrative to v24) and the two SQL snippets that show the json_extract keys.
- **`src/reducer.ts:14-50`**: module-level docstring ASCII event table — `RateLimited` row becomes `ApiError`; `UserPromptSubmit` row's clear-list updates from `rate_limited_at` to the new pair.
- **`src/transcript-worker.ts:81-95`**: module-level docstring (renames `RateLimited`, `rate_limited_at`, `matchRateLimit`) + `RateLimitedMessage` interface rename + `TranscriptWorker` constructor JSDoc.
- **`src/db.ts`**: module-level docstring schema-version history (currently lists v23 as the high-water mark — extend with v24 entry).
- **`src/types.ts:34, 48, 53, 56-62, 272-285, 323-338`**: `JobLinkEntry`, `Job`, `EmbeddedJob` interfaces + every JSDoc that names the old column.
- **`src/readiness.ts:615`**: predicate-3 JSDoc enrichment-shape mention.
- **`scripts/board.ts:107-111` HELP block** + `rateLimitedPillSeg` JSDoc + `renderJobLinkLines` JSDoc — `[limited]` removed from user-facing prose.
- **`.planctl/specs/fn-612-*.md`, `fn-613-*.md`** — historical, read-only per planctl conventions. Do NOT edit; flagged here for awareness only.

## Best practices

- **Express the event-type rename at fold time with a dual-case alias, never via stored-data rewrite.** Stored `events.event_type = 'RateLimited'` rows are immutable per CLAUDE.md "hook/main is sole writer" + "append-only" invariants. The reducer switch must accept both `"RateLimited"` (legacy, forces `kind="rate_limit"`) AND `"ApiError"` (new, reads `data.kind`). Source: industry consensus (Greg Young, Axon framework, Vaughn Vernon). Rewriting stored event_type strings would break re-fold determinism from event 0.
- **Canonicalize NULL explicitly in the `enrichJobLink` JSON literal.** When the `jobs` row is missing at enrich time, emit `last_api_error_at: null, last_api_error_kind: null` (both as JSON nulls), never omit the keys. Omitting vs. emitting nulls produces different `JSON.stringify` bytes — breaks the byte-identical re-fold contract. The single shared helper enforces this; live + jobs-write + migration backfill all route through it. Source: practice-scout + keeper's own existing "safe value" convention.
- **Paired-NULL invariant lives at the reducer layer, NOT as SQLite CHECK constraint.** SQLite `ADD COLUMN` with `CHECK` is partial (constraint only evaluates on new writes; existing rows not validated). More importantly, a CHECK violation mid-fold rolls back the cursor advance and wedges the reducer — directly violates CLAUDE.md's "never throw inside the fold transaction." Both columns move together in a single compound UPDATE; that's the enforcement seam.
- **Pre-filter substring must gate on `'"isApiErrorMessage":true'`, not just `'"error"'` or the kind strings.** A too-broad substring causes `JSON.parse + matchApiError` to run on every assistant message — perf regression on busy transcripts. A too-narrow substring (e.g. `'"rate_limit"'`) misses the other five kinds. The flag is the only field every isApiErrorMessage envelope guarantees. Source: practice-scout, openclaude type generator.
- **`max_output_tokens` is recoverable; never stamp on it.** openclaude's query loop withholds the error and attempts compact+retry (`query.ts:1268-1339`). Stamping would mark a session that's actively recovering as failed — false-positive in `[failed:max_output_tokens]`. The matcher's six-kind allow-list is the gate; anything not in the list (including `max_output_tokens`) folds via the `"unknown"` fallback ONLY when the message is also a terminal `isApiErrorMessage:true` envelope (which `max_output_tokens` may or may not be, depending on SDK behavior — staying safe by not stamping).
