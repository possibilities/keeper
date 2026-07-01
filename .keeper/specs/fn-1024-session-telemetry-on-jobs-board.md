## Overview

Project each session's CURRENT model, reasoning effort, and context-window usage onto the
`jobs` projection so they render on the jobs board — current values only, no history. A
`keeper statusline-sink` CLI (injected fleet-wide via `keeper agent --settings` as a
`bash -c 'tee -i >(keeper statusline-sink) | claudectl show-statusline'` wrapper) reads the
Claude Code statusLine stdin JSON, coalesces, and writes a per-session leaf file; a new
`statusline-worker` file-watch producer folds a synthetic `SessionTelemetry` event onto new
nullable `jobs` columns. The whole thing copies two proven keeper archetypes: the
`UsageSnapshot`/`usage-worker` external-producer→coalesce→mint→fold chain, and the `ApiError`
partial-UPDATE jobs fold arm.

## Quick commands

- `echo '{"session_id":"S","model":{"id":"claude-opus-4-8","display_name":"Opus"},"effort":{"level":"high"},"context_window":{"used_percentage":42.5,"total_input_tokens":85000,"context_window_size":200000}}' | keeper statusline-sink` — writes/updates one leaf, exits 0
- `keeper jobs` / the board view — a live session row shows its model, effort, and context%
- `bun test test/db.test.ts test/schema-version.test.ts test/refold-equivalence.test.ts` — schema + re-fold gates green

## Acceptance

- [ ] A live keeper-agent claude session's jobs row shows current model, effort, and context% on the board, updating as they change mid-session
- [ ] Values are sourced from the statusLine payload, coalesced so the event log does not churn per render
- [ ] `SCHEMA_VERSION` is 100, whitelisted in `keeper/api.py`, and two from-scratch re-folds stay byte-identical
- [ ] The sink never breaks the human's visible statusline (fail-open, display still renders)
- [ ] `bun test` fully green

## Early proof point

Task that proves the approach: `.2` (statusline capture). It captures one real statusLine
payload and confirms the load-bearing contract — that the payload's `session_id` equals the
hook-sourced `jobs.job_id` (the fold's only match key; a mismatch makes the whole feature a
silent no-op) and whether `effort.level` is present. If it fails: revisit the correlation key
(a different id field) or degrade effort to NULL, before building the daemon-side fold.

## References

- Producer/coalesce/mint/fold archetype: `src/usage-worker.ts` (`UsageScanner` :560, `usageGateKey` :498, `seedFromDb` :809, `main()` :900), mint `src/daemon.ts:3966` + `serializeUsageSnapshot` :1175 + `mintUsageEventTolerant` :3990, decode/fold `src/reducer.ts` `extractUsageSnapshot` :2890 / `projectUsageRow` :3001
- jobs partial-UPDATE fold arm to mirror (but NOT its `state` flip): `src/reducer.ts` `case "ApiError"` :8134, `projectJobsRow` :7643
- migration recipe: `src/db.ts` `SCHEMA_VERSION` :49, `addColumnIfMissing` :1949, frozen `CREATE_JOBS` note :834, v-step example :5384; whitelist `keeper/api.py:392`
- agent launch seam: `src/agent/main.ts` `buildDefaults` ~:507, claude branch ~:1589, override-detection precedent `hasCodexWebSearchOverride`; `--settings` passthrough allow-list `src/agent/passthrough.ts:88`
- statusLine stdin contract: `model.id`/`model.display_name`, `effort.level` (low/medium/high/xhigh/max; may be absent), `context_window.{used_percentage,total_input_tokens,context_window_size,current_usage}` (`current_usage` null before first API call)

## Docs gaps

- **README.md `## Architecture`**: add the statusline worker to the worker roster (next ordinal + renumber cross-refs), a `SessionTelemetry` event/projection paragraph, a v100 entry in the jobs column-history block, the `statusline-sink` CLI subcommand, and a `keeper agent --settings` launch-config note
- **CLAUDE.md**: one sole-writer line for the sink's per-session leaf-file write surface (the `@parcel/watcher`-on-external-tree carve-out already covers the worker)
- **keeper/api.py**: `# v100` comment above the whitelist entry (follow the file's existing fn-id comment pattern)

## Best practices

- **`>(...)` is bash-only:** the injected command MUST be `bash -c '...'`; `sh`/`dash` silently parse-fail while the display still prints (masked telemetry loss). [bash manual]
- **`tee -i` + read full stdin:** if the sink exits before draining stdin, `tee` takes SIGPIPE and dies, breaking the pipe to the display. [SO #63025706]
- **Atomic leaf write:** tmp-in-same-dir + `rename()` with a DETERMINISTIC temp name (`.<session>.tmp`) — avoids partial reads and inode exhaustion from per-render temp files; skip `fsync` (advisory data). [LWN atomic-writes]
- **`--settings` scalar override:** injecting `statusLine` replaces the user's for that session (fine — the chain re-invokes their display; keep the chain target configurable). Precedence #2, loses only to managed policy. Prefer a settings FILE over inline JSON (nested single-quote fragility). [Claude Code settings docs]
- **Use `used_percentage` directly:** do not recompute % from `total_input_tokens` (may be cumulative across versions) or a hardcoded window size (1M is per-request/beta-gated). [community statusline schema]
