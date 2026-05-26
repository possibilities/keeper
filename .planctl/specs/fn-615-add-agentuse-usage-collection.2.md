## Description

**Size:** S
**Files:** scripts/usage.ts (new), README.md, CLAUDE.md (optional trim)

### Approach

Single-collection subscriber + docs update. Clones `scripts/git.ts` shape closely.

1. **`scripts/usage.ts`** — single-collection subscriber. `const COLLECTION = "usage"`. Use `subscribeCollection` from `src/readiness-client.ts` (do NOT hand-roll an NDJSON parser). Render one line per row in the style of the other scripts:
   ```
   {id} [{target} {multiplier}x] session {session_percent}% (resets {session_resets_at}) | week {week_percent}% (resets {week_resets_at})
   ```
   Reset timestamps render as the raw ISO string for now (no client-side countdown — keeper has no freshness signal yet by design; a later epic may add one). Sidecar discipline matches `scripts/git.ts`: per-frame state JSON + frame text + unified diff under `/tmp/keeper-usage.<pid>.*`; session meta file accumulates the index; SIGINT teardown prints sidecar paths on exit. `--sock` flag for socket path override. No `--live` / TUI for the first cut.

2. **README updates** per the docs-gap list on the epic spec:
   - Update "What keeper is" collection-count phrasing and add a one-sentence `usage` description.
   - Add an Architecture paragraph for the usage producer worker following the existing template (external tree watched → message posted → synthetic event minted → reducer fold).
   - Add a one-sentence "as of schema v23" callout for the new SCHEMA_VERSION bump.
   - Add a `usage.ts` bullet in the Example clients section.
   - Add one `SELECT * FROM usage ORDER BY target, id` query example in the Inspect section.

3. **CLAUDE.md trim** — if the DO NOT list still names "Three collections register today" after task 1, update or trim the count phrasing. No new content; CLAUDE.md is invariants, not documentation.

### Investigation targets

**Required** (read before coding):
- `scripts/git.ts` — direct shape to clone: single-collection subscribe, sidecar writes, SIGINT teardown, `--sock` flag, `seg()` / row-projection helpers, byte-compare body suppression.
- `src/readiness-client.ts:~640` — `subscribeCollection` API + first-paint gate + reconnect/coalesce lifecycle.
- `src/protocol.ts` — `result` / `patch` / `meta` frame shapes; confirms the wire contract the script consumes.
- `src/collections.ts` — `USAGE_DESCRIPTOR` (lands in task 1) — defines the row shape `scripts/usage.ts` consumes (`id`, `target`, `multiplier`, `session_percent`, `session_resets_at`, `week_percent`, `week_resets_at`).
- README.md sections referenced in the epic's `## Docs gaps`.

**Optional**:
- `scripts/board.ts` — for the SGR pill colorization pattern if we later want to threshold-color the percentages.
- `scripts/autopilot.ts` — for the alt-screen TUI pattern if we later promote `usage.ts` to a `--live` view.

### Risks

- **Line format won't scale to many profiles.** With 5+ profiles the column alignment may degrade. Mitigation: pad-right the `{id}` segment to the widest observed id length; defer fancier alignment / coloring to a follow-up.
- **README count-language drift.** The "Three collections register today" phrasing appears in multiple places — missing one leaves contradictory prose. Mitigation: grep for "collections register" before editing; update every match in one pass.
- **Subscriber tested only manually.** No test/usage.test.ts — the script is a thin renderer over a tested API surface. Mitigation: rely on manual smoke + the underlying `subscribeCollection` test coverage.

### Test notes

- No new test file required — the script is a thin renderer over the already-tested `subscribeCollection`. Manual smoke check: run `bun scripts/usage.ts`, confirm one line per existing `~/.local/state/agentuse/*.json` file, observe a live update when agentuse next refreshes a profile, observe a row drop on `rm ~/.local/state/agentuse/<id>.json`.
- README rendering: not test-covered; preview locally via `glow README.md` or equivalent.

## Acceptance

- [ ] `bun scripts/usage.ts` subscribes and renders one line per agentuse profile
- [ ] Live update visible when a `<id>.json` file changes on disk with semantically-new content (e.g. percent moves)
- [ ] Fetch-only refreshes (freshness fields advance, content unchanged) produce NO visible re-render
- [ ] Profile deletion (manual `rm ~/.local/state/agentuse/<id>.json`) drops the row from the rendered output
- [ ] SIGINT cleanly tears down the subscription and prints sidecar paths on exit
- [ ] README updated for all five docs-gap items (collection count, Architecture paragraph, schema version callout, Example clients bullet, Inspect query)
- [ ] CLAUDE.md count-phrasing updated if applicable

## Done summary

## Evidence
