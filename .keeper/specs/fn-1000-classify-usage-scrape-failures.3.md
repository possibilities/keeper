## Description

**Size:** S
**Files:** cli/usage.ts, test/usage.test.ts, README.md

### Approach

Teach `keeper usage` to use `error_kind` as the stale-error row label while keeping the type/message content in the body. Map `format_changed` to `format`, `panel_missing` to `panel`, `scrape_failed` to `scrape`, `upstream_limited` to `upstream`, and `runner_failed` to `runner`; fall back to the current `error` label when kind is null or unrecognized. Add a fixture representing the current Codex weekly-line failure and assert it renders as a format-drift line without fixing the parser.

### Investigation targets

**Required** (read before coding):
- cli/usage.ts:348 — RowCells stale-error fields.
- cli/usage.ts:400 — current stale-error content and relative-time rendering.
- cli/usage.ts:850 — usage stream change-gate fields include error axes.
- test/usage.test.ts:1320 — current stale-error render test.
- test/usage.test.ts:1377 — missing-error render test.
- README.md:1283 — user-facing usage row behavior.
- README.md:2903 — producer/consumer architecture description.

**Optional** (reference as needed):
- /Users/mike/.local/state/agentusage/codex.error.json — live sidecar shape for a manual smoke check; do not bake absolute temp paths into tests.

### Risks

The line must remain compact: the existing truncation/alignment behavior keeps the reset column stable, so only the label should vary. Unknown kinds should degrade to `error`, never hide the detailed exception.

### Test notes

Extend the pure renderer tests; no daemon, worker, PTY, or real `keeper usage` snapshot is needed for the unit proof. A manual `keeper usage --snapshot` after both producer and consumer tasks land is useful evidence that the live Codex row shows the format label.

## Acceptance

- [ ] Rows with `error_kind` render a kind-specific label and preserve type/message/age.
- [ ] Rows with null or unknown `error_kind` keep the existing `error` label.
- [ ] Current Codex weekly-line parse failure fixture renders as `format` and still shows `CodexStatusParseError`.
- [ ] README describes the classified stale-error labels.
- [ ] Targeted usage renderer tests pass.

## Done summary
keeper usage now renders error_kind as a short stale-error label (format/panel/scrape/upstream/runner), falling back to error for null/unknown kinds while keeping the full type:message body and ticking age; README documents the labels and tests cover the Codex weekly-line format-drift fixture.
## Evidence
