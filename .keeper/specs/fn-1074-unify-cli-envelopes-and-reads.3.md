## Description

**Size:** M
**Files:** cli/query.ts, cli/status.ts, cli/autopilot.ts (show), cli/ (session-summary verb), src/ (projection reads), test/status.test.ts

### Approach

Three reads that retire documented workarounds, all through the shared envelope. (1)
`keeper query tasks` — flat task rows (epic_id, task_id, title, tier, model, deps, status,
readiness verdict) so the CLAUDE.md `query epics --json | jq '.data[]'` pipeline retires. (2)
`keeper autopilot show` — the durable autopilot config + runtime state as one read; this
requires surfacing worktree_multi_repo, which is a durable autopilot_state column absent from
status .data.autopilot (cli/status.ts:311-318) — add it there too (additive; bump
STATUS_SCHEMA_VERSION per its data-shape contract and update the CLI-shape tests). (3)
`keeper session-summary <session-id>` — title, first human prompt, last result/outcome,
counts, transcript_path — so agents stop Reading multi-MB transcripts into the 25k-token cap.
While in status.ts, fold the TODO(fn-1015.4) inline drained/jammed predicate onto the shared
pure predicate rather than minting a third copy. All reads are read-only projections — no new
RPC surface.

### Investigation targets

**Required** (read before coding):
- cli/query.ts:126 — the collection allowlist to extend
- cli/status.ts:311-318 — the autopilot block + STATUS_SCHEMA_VERSION
- src/db.ts autopilot_state columns — the full durable knob set autopilot show must round-trip
- jobs table (session titles, transcript_path) + events (first UserPromptSubmit) — session-summary sources

**Optional** (reference as needed):
- cli/show-session-events.ts — adjacent read patterns to match

### Risks

- session-summary must bound its output (truncate prompt/result snippets) so it never recreates the token-cap problem it solves.
- query tasks readiness verdicts must reuse computeReadiness, not re-derive.

### Test notes

CLI-shape tests for all three; status test updated for the added autopilot field; verify each
retired workaround's replacement parity (same fields the jq pipeline produced).

## Acceptance

- [ ] query tasks / autopilot show / session-summary exist, envelope-shaped, read-only
- [ ] worktree_multi_repo present in status .data.autopilot and autopilot show; capture/restore can round-trip it
- [ ] CLAUDE.md + skill jq recipes for these reads replaced by the new verbs (same commits)

## Done summary
Added envelope-shaped reads: keeper query tasks (flat task rows + live readiness verdict, retiring the query-epics jq pipeline), keeper autopilot show (durable config incl. worktree_multi_repo), and keeper session-summary (bounded DB summary vs the transcript). Surfaced worktree_multi_repo on the readiness snapshot + status .data.autopilot (STATUS_SCHEMA_VERSION 2->3) and in the autopilot skill's capture list.
## Evidence
