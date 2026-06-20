## Description

**Size:** S
**Files:** `scripts/board.ts`, `test/board.test.ts`, `CLAUDE.md`, `README.md`, `src/types.ts` (JSDocs), `src/reducer.ts` (header table + JSDocs), `src/transcript-worker.ts` (module-level docstring), `src/db.ts` (schema-version history)

### Approach

Last task. With the schema, fold, matcher, and mint all in place, this task surfaces the kind to the human eye and harmonizes every doc that names the old artifacts. The pill changes from `[limited]` to `[failed:<kind>]`; all six kinds render red on a TTY via the colorizer's new `failed:*` prefix fallback. Every CLAUDE.md / README.md / JSDoc / docstring that names `rate_limited_at` or `RateLimited` gets updated.

Specific steps:

1. **Board pill segment** (`scripts/board.ts:213-225`): rename `rateLimitedPillSeg(v)` → `apiErrorPillSeg(at, kind)`. Body: `at == null ? "" : \` [failed:\${kind}]\``. The `kind` argument is non-null when `at` is non-null per the paired-NULL invariant established in task .1 — but defensive code can fall back to `"unknown"` if for some reason `kind` is null while `at` isn't (should be unreachable; a defensive default keeps the pill from collapsing to `[failed:]`).
2. **Colorizer prefix fallback** (`scripts/board.ts:296-307`): in `colorizePillsInLine`, add a sibling check `inner.startsWith("failed:") → bucket = "error"` alongside the existing `inner.startsWith("blocked:") → bucket = "warn"`. The five existing exact-match entries unchanged; the new pill tokens (`[failed:rate_limit]`, etc.) route through the prefix fallback. Drop the `limited: "error"` entry from `PILL_COLORS` (`scripts/board.ts:264-282`) — `[limited]` is no longer rendered anywhere.
3. **Call sites** (`scripts/board.ts:338-351, 419-437, 537-544`): `renderJobLinkLines`, `renderJobLines`, `projectJobRow` all currently call `rateLimitedPillSeg(row.rate_limited_at)`. Update to `apiErrorPillSeg(row.last_api_error_at, row.last_api_error_kind)`.
4. **HELP block** (`scripts/board.ts:107-111, 156`): rewrite the prose that names `[limited]` → `[failed:<kind>]`. Add a one-line note that the six rendered kinds are `rate_limit | authentication_failed | billing_error | server_error | invalid_request | unknown` and that anything else folds to `unknown`. Note the recoverable `max_output_tokens` exclusion.
5. **Board JSDocs** (`scripts/board.ts:182-225, 314-337`): `rateLimitedPillSeg`'s JSDoc rewrite (now describes both new columns + paired-NULL invariant). `renderJobLinkLines` JSDoc updates the `JobLinkEntry` shape literal it cites.
6. **`CLAUDE.md` lines 39-46**: update the `JobLinkEntry` shape literal `{kind, job_id, title, state, rate_limited_at}` → `{kind, job_id, title, state, last_api_error_at, last_api_error_kind}`. Update the state-flip trigger list `UserPromptSubmit / Stop / SessionEnd / Killed / RateLimited` → `UserPromptSubmit / Stop / SessionEnd / Killed / ApiError`. Update the `enrichJobLink` enrichment shape mention. The `RateLimited` → `ApiError` mention is the dual-case alias: clarify that the stored event_type is still `RateLimited` for historical events, but the new synthetic event type is `ApiError` — both fold via the same arm.
7. **`README.md` lines 481-490, 606-611**: schema-vN prose updated to describe the v24 bump (rate-limited-at → api-error pair). The two SQL snippets that show `json_extract(job_links, '$.rate_limited_at')` or similar update to the new field names.
8. **`src/reducer.ts:14-50`**: module-level docstring ASCII event table. The `RateLimited` row becomes `ApiError` (with a note about dual-case fold for historical events). The `UserPromptSubmit` row's clear-list updates.
9. **`src/transcript-worker.ts:81-95`** module-level docstring rename: `RateLimited` → `ApiError`, `rate_limited_at` → `last_api_error_at`/`last_api_error_kind`, `matchRateLimit` → `matchApiError`.
10. **`src/db.ts`** module-level docstring schema-version history: extend with the v24 entry.
11. **`src/types.ts`** JSDocs at `:34, 48, 53, 272-285, 332-337`: every mention of the old column or the old event name.
12. **Board render tests** (`test/board.test.ts`): rename the test at `:251` from `"rate_limited_at non-null appends [limited] pill"` to `"last_api_error_at non-null appends [failed:<kind>] pill"`. Update the `makeLink` factory at `:205` and `makeEmbeddedJob` at `:104` to default `last_api_error_at: null, last_api_error_kind: null`. Add explicit test cases for each of the six kinds rendering `[failed:<kind>]`. Add a `colorizePillsInLine` test that asserts the inner-token red SGR sequence wraps every `failed:*` token.

### Investigation targets

**Required**:
- `scripts/board.ts:213-307` — pill segment, colorizer, `PILL_COLORS` table. The `blocked:*` prefix fallback at `:299` is the exact pattern to mirror for `failed:*`.
- `scripts/board.ts:338-543` — three call sites consuming `row.rate_limited_at`.
- `scripts/board.ts:107-156` — HELP block prose that names the pill.
- `CLAUDE.md:39-46` — invariants table mentioning `JobLinkEntry` shape + state-flip trigger list.
- `README.md:481-490, 606-611` — schema-vN prose + SQL snippets.
- `test/board.test.ts:200-280` — existing test surface for the pill segment + `makeLink` / `makeEmbeddedJob` factory defaults.

**Optional**:
- `src/reducer.ts:14-50` — header ASCII event table; doc-only update.
- `src/transcript-worker.ts:81-95` — module-level docstring; doc-only.
- `src/db.ts` module docstring (schema-version history); doc-only.
- `src/types.ts` JSDocs at `:34, 48, 53, 272-285, 332-337` — doc-only.
- `.planctl/specs/fn-612-*.md`, `fn-613-*.md` — DO NOT EDIT (historical artifacts per planctl conventions). Flagged here so the worker doesn't accidentally touch them.

### Risks

- **Doc drift across CLAUDE.md / README.md / JSDocs** is the main risk — easy to update three of four sites and miss the fourth. The full `grep -rn 'rate_limited_at\|RateLimited\|\[limited\]'` should return zero hits in `src/`, `scripts/`, `test/`, `CLAUDE.md`, `README.md` after this task. Use that as the completeness gate.
- **`PILL_COLORS.limited` dropped** — if any test still asserts a `[limited]` token's color, it'll fail. Use the same grep to catch.
- **Render mid-flight**: between task .2 landing and this task landing, board.ts still reads the old field name (would render no pill on a real api-error). This is the dep chain's intended brief intermediate state — acceptable.

### Test notes

- One render test per kind (six positive cases) covering `apiErrorPillSeg`'s output text.
- One colorizer test that runs `colorizePillsInLine` over each of the six tokens and asserts the inner-token gets the error-bucket SGR (`\x1b[31m...\x1b[0m`). The existing `[blocked:*]` test at `test/board.test.ts:300+` is the template.
- The legacy `[limited]` pill test at `test/board.test.ts:251` becomes the `[failed:rate_limit]` pill test — same fixture, renamed assertion.

## Acceptance

- [ ] `scripts/board.ts:213-225`: `rateLimitedPillSeg` → `apiErrorPillSeg(at, kind)` returning ` [failed:<kind>]` when `at != null`, empty string otherwise.
- [ ] `scripts/board.ts:296-307`: `colorizePillsInLine` gains the `failed:*` prefix fallback routed to the `error` bucket. `PILL_COLORS.limited` entry dropped.
- [ ] All three call sites in `scripts/board.ts` updated to pass both new fields.
- [ ] `scripts/board.ts:107-156` HELP block: `[limited]` removed; `[failed:<kind>]` described with the six-kind allow-list + the `max_output_tokens` exclusion footnote.
- [ ] `CLAUDE.md` lines 39-46 updated: `JobLinkEntry` shape literal, state-flip trigger list, `enrichJobLink` enrichment shape.
- [ ] `README.md` lines 481-490, 606-611 updated: schema-vN prose, two SQL snippets.
- [ ] `src/reducer.ts:14-50`, `src/transcript-worker.ts:81-95`, `src/db.ts` module-level docstrings, `src/types.ts` JSDocs all updated.
- [ ] `test/board.test.ts`: existing `[limited]` pill test renamed; six new per-kind render tests; colorizer test for all six `failed:*` tokens; `makeLink`/`makeEmbeddedJob` factory defaults updated.
- [ ] `grep -rn 'rate_limited_at\|RateLimited\|\[limited\]' src/ scripts/ test/ CLAUDE.md README.md` returns zero hits (except inside the dual-case fold arm where `RateLimited` is the legacy event-type string, and inside the migration block where the column drop is named).
- [ ] `bun test` passes; `bun scripts/board.ts --help` renders the new HELP text without `[limited]` mentions.
- [ ] End-to-end smoke: stop keeperd, delete db, restart, force a 401 in any tracked session, observe `[failed:authentication_failed]` colored red in `bun scripts/board.ts` (TTY).

## Done summary
Renamed rateLimitedPillSeg → apiErrorPillSeg(at, kind) emitting [failed:<kind>] from the (last_api_error_at, last_api_error_kind) pair, dropped PILL_COLORS.limited, added a failed:* prefix fallback to colorizePillsInLine routing all six ApiErrorKind tokens to the error bucket (mirror of blocked:* → warn). Updated three call sites + HELP block + JSDocs; six new per-kind render tests + colorizer prefix-fallback tests + defensive null-kind fallback test.
## Evidence
