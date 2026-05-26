## Description

**Size:** S
**Files:** `src/transcript-worker.ts`, `src/daemon.ts`, `test/transcript-worker.test.ts` (new), `test/reducer.test.ts` (additional `ApiError` kind coverage)

### Approach

With the schema and reducer fold-arm in place from task .1, this task lights up the producer side. The transcript matcher generalizes from one-kind (`error: "rate_limit"`) to six-kind dispatch; the worker→main message renames; the daemon mints `ApiError` synthetic events (not `RateLimited`) for all new emissions. After this task lands, a 401 / `Please run /login` line in any tracked transcript becomes a `[failed:authentication_failed]`-stamped session in the `jobs` projection (the board still renders the old `[limited]` shape for now — task .3 does that surface change).

Specific steps:

1. **Matcher** (`src/transcript-worker.ts:150-207`): rename `matchRateLimit` → `matchApiError`. Returned type `RateLimitLine` → `ApiErrorLine` carrying `{sessionId, text, kind}`. The kind comes from `parsed.error?.type` if present; otherwise from `parsed.error` if it's a bare string (the older transcript shape today's matcher reads). Dispatch on the six-kind allow-list — `"rate_limit"`, `"authentication_failed"`, `"billing_error"`, `"server_error"`, `"invalid_request"` map to themselves; anything else (including the SDK's own `"unknown"` AND `"max_output_tokens"`) falls through to `"unknown"`. The four guard clauses stay verbatim — `type:"assistant"`, `isApiErrorMessage:true`, valid `sessionId`, parseable `message.content[0].text`. **Negative gates**: explicitly return null for `type:"system"` rows with `subtype:"api_retry"` (an `SDKAPIRetryMessage` — transient retry, session still live) and for `SDKRateLimitEvent` rows (quota notification, distinct envelope). Both are confirmed by practice-scout against openclaude's SDK types.
2. **Pre-filter** (`src/transcript-worker.ts:561-562` inside `dispatchLine`): widen from `line.includes('"rate_limit"')` to `line.includes('"isApiErrorMessage":true')`. This is the cheap-substring optimization that lets us skip `JSON.parse` on every assistant message. The new needle is the strictest filter that still catches every real terminal-error envelope and skips both negative-gate frames. Verify against real captured transcript lines before committing.
3. **Worker→main message** (`src/transcript-worker.ts:91-95`): `RateLimitedMessage` → `ApiErrorMessage` carrying `{kind: ApiErrorKind, sessionId: string, text: string}`. Update the `postMessage` shape at `:689-706`.
4. **TranscriptWorker callback** (`src/transcript-worker.ts:251-269`): `onRateLimited` constructor slot → `onApiError(sessionId, text, kind)`. Update the call site at `:597`. Update the JSDoc.
5. **Daemon mint** (`src/daemon.ts:84, 272, 311-351`): import rename. `onmessage` discriminator union updated. The `rate-limited` arm becomes an `api-error` arm; `stmts.insertEvent.run({...})` now sets `$hook_event: "ApiError"`, `$event_type: "api_error"`, `$data: JSON.stringify({kind, text})`. All other sparse columns stay null per synthetic-event convention.
6. **Tests** (`test/transcript-worker.test.ts`, new — repo-scout confirmed there's no current rate-limit matcher coverage): one positive test per kind in the six-kind union; one negative test for `api_retry`; one negative test for `SDKRateLimitEvent`; one fallback test for an unrecognized kind string → `"unknown"`; one boundary test for `max_output_tokens` confirming it folds to `"unknown"` (defensive — the matcher should be inert on max_output_tokens but the test pins the behavior).
7. **Reducer cross-test** (`test/reducer.test.ts`): one new fold-arm test per non-`rate_limit` kind, asserting both columns get stamped with the correct kind and that `state` flips to `'stopped'` (the existing `case "RateLimited"` test from task .1 already covers `rate_limit`).

### Investigation targets

**Required**:
- `src/transcript-worker.ts:150-207` — current `matchRateLimit` + `RateLimitLine`; the generalization template.
- `src/transcript-worker.ts:556-598` — `dispatchLine` cheap pre-filter + the on-match emit path.
- `src/daemon.ts:271-352` — synthetic-event mint sequence; the exact column-binding shape for the `stmts.insertEvent.run({...})` call.
- openclaude SDK types `SDKAssistantMessageError` — practice-scout's report references the canonical shape; confirm the wire field is `error.type` vs. bare `error` against captured transcripts in `~/.claude/projects/**/*.jsonl`.
- `~/.claude/projects/-Users-mike-code-agentuse/2164484b-e74a-4f26-b716-b80b44c4de61.jsonl` — a real captured 401 envelope; useful as a test fixture.

**Optional**:
- `src/transcript-worker.ts:81-95` — module-level docstring + `RateLimitedMessage` interface (rename surface for task .3's doc sweep — leave the rename here but the surrounding docstring sweep is task .3).

### Risks

- **Wire-shape variance**: the captured 401 line shows `"error":"authentication_failed"` (a bare string), but openclaude's TypeScript declares `SDKAssistantMessageError.error.type`. Older transcripts may emit the bare-string shape; newer ones may emit the structured shape. The matcher should accept both: read `parsed.error?.type ?? parsed.error` as the kind string. Confirm against multiple captured transcripts before committing.
- **Pre-filter substring choice** can silently regress: `'"isApiErrorMessage":true'` is the strict choice but depends on JSON.stringify never inserting a space after the colon. Bun's `JSON.stringify` doesn't, and neither does Claude Code's (verified against captured lines), but a more defensive needle is `'"isApiErrorMessage"'` (matches even with whitespace). Slight perf cost; correctness-first.
- **Negative-gate test rigor**: missing a negative case for `api_retry` or `SDKRateLimitEvent` means the matcher silently false-positives in production. Both negatives MUST be in the test set, with a real captured-line fixture if possible.

### Test notes

- Use real captured transcript lines as fixtures where possible — they're authoritative about wire shape. Fixtures live inline in the test (small enough); the `src/transcript-worker.ts` matcher is pure (no I/O), so test invocation is `matchApiError(JSON.parse(fixtureLine))`.
- The reducer cross-tests in `test/reducer.test.ts` should follow the existing `RateLimited` test pattern at `:3588-3625` (now renamed in task .1). One per non-rate_limit kind.

## Acceptance

- [ ] `src/transcript-worker.ts`: `matchRateLimit` → `matchApiError` with six-kind dispatch + `"unknown"` fallback. Gate fields preserved. Negative gates for `api_retry` system frames + `SDKRateLimitEvent` frames added. Returned `{sessionId, text, kind}`.
- [ ] `src/transcript-worker.ts:561-562`: `dispatchLine` pre-filter widened to `line.includes('"isApiErrorMessage":true')` (or the chosen safe variant).
- [ ] `src/transcript-worker.ts:91-95`: `RateLimitedMessage` → `ApiErrorMessage` carrying `{kind, sessionId, text}`. Worker `postMessage` updated.
- [ ] `src/transcript-worker.ts:251-269`: constructor callback `onRateLimited` → `onApiError(sessionId, text, kind)`. Call site at `:597` updated.
- [ ] `src/daemon.ts:84, 272, 311-351`: import + discriminator + mint all updated. Synthetic event minted as `hook_event: "ApiError"`, `event_type: "api_error"`, `data: JSON.stringify({kind, text})`. All sparse columns null.
- [ ] `test/transcript-worker.test.ts`: six positive matcher tests (one per kind), two negative tests (api_retry + SDKRateLimitEvent), one unrecognized-kind → `"unknown"` test, one `max_output_tokens` → `"unknown"` boundary test.
- [ ] `test/reducer.test.ts`: one fold-arm test per non-`rate_limit` kind. Both columns stamped, state flipped to `'stopped'`, terminal rows not resurrected.
- [ ] `bun test` passes.
- [ ] End-to-end smoke: a live keeperd folding a real `authentication_failed` envelope from a tracked session lands `last_api_error_kind = "authentication_failed"` in the `jobs` row. Verify via `sqlite3 ~/.local/state/keeper/keeperd.db "SELECT job_id, last_api_error_at, last_api_error_kind FROM jobs WHERE last_api_error_at IS NOT NULL"`.

## Done summary
Generalized transcript matcher from one-kind rate_limit to six-kind ApiError dispatch (matchRateLimit→matchApiError, RateLimitedMessage→ApiErrorMessage, daemon mints synthetic ApiError with data.kind). Pre-filter widened to '"isApiErrorMessage":true'; negative gates for api_retry + SDKRateLimitEvent. New transcript-worker matcher tests (positive per-kind, real captured 401 fixture, fallbacks, negative gates, dispatchLine integration) and widened reducer cross-test asserting state/at on each non-rate_limit kind.
## Evidence
