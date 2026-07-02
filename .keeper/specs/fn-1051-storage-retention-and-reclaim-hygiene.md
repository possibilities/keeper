## Overview

keeper.db carries 439MB of permanently un-sheddable body bytes (65% of live bodies, growing ~71MB/week) because the compaction shed-guard's mutation-path clause fires on every shed-class row carrying `tool_input.file_path` while `mutation_path` is only ever stamped for the four mutation tools. Alongside: recovered dead-letter rows and their NDJSON archive never prune (93MB), and the server.stderr rotation sidecar exists in-repo but was never wired into install. This epic scopes the guard correctly, adds a resurrection-safe dead-letter retention pass, and makes rotation + reclaimable-space observability real.

## Quick commands

- `bun test test/compaction.test.ts` — guard + re-fold-equivalence coverage
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT count(*) FROM events WHERE hook_event='PostToolUse' AND tool_name='Read' AND data IS NOT NULL"` — drains toward 0 within ~30min of passes post-deploy
- `launchctl print gui/$(id -u)/arthack.keeperd.logrotate` — sidecar loaded post-install

## Acceptance

- [ ] PostToolUse:Read (and every non-mutation shed-class) body sheds; the four mutation tools still owing a mutation_path backfill stay inline; re-fold equivalence proven over the newly-shed class
- [ ] Recovered dead-letter rows and fully-resolved sealed archive files prune with NO resurrection path (a pruned row can never be re-ingested as waiting); waiting rows and events-log files untouched
- [ ] install.sh idempotently loads the logrotate sidecar and its command resolves under launchd's /bin/sh
- [ ] Retention pass logs reclaimable freelist bytes only on 100MB step crossings

## Early proof point

Task that proves the approach: `.1` — the new "Read row carrying file_path SHEDS" assertion is red on current source, green after the one-clause fix. If it fails: the guard clause can be decomposed further with the class predicate left byte-identical.

## References

- Post-landing operator step (not a task): run offline `keeper reclaim` once the backlog drains to recover file bytes (~0.5GB) — body-NULL only feeds the freelist
- The resurrection hazard: `scanDeadLetterDir` INSERT OR IGNOREs every surviving file line; row-delete without file-delete re-replays as waiting
- fn-837 context: the shed CLASS stays widened; only the backfill-guard clause narrows to the four tools it was written for

## Docs gaps

- **README.md** (~3984-4052): describe the corrected guard allow-list directly; collapse the historical widening narrative; verify the sentinel paragraph still reads true
- **README.md** (~4305-4328): prune the completed one-time catch-up runbook
- **README.md** (~246-254, ~4249-4288): consolidate the recovered dead-letter retention story into the existing dead-letter + reclaim prose
- **README.md** (~629-643): rotation sidecar step becomes install.sh-owned

## Best practices

- **Paced batches over one-shot:** the existing 20×500 5-min cadence drains the 54k-row backlog in ~30min without WAL spikes or write-lock holds
- **Truncate-in-place is the only child-fd-safe rotation under launchd** — the existing sidecar design is correct; rename+recreate silently orphans inherited fds
- **Unlink order is direction-specific here:** orphaned recovered ROWS are harmless; orphaned dead-letter FILES resurrect — invert the generic rows-then-files advice
