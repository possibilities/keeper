## Overview

Build the `gitpolice` sitter in ~/code/sitter: a read-only observer of
keeper.db that builds a complete census of raw `git` usage by agents
(reads included) plus every `keeper commit-work` invocation, captures
near-time keeper projection snapshots alongside write-class fallbacks,
and writes deduped followups for write-class fallbacks and orphan files.
The census is the evidence base for fixing keeper's git projections until
agents never need raw git. Triage home already exists at
~/docs/babysitters/gitpolice/ (charter is the producer contract to match).

## Quick commands

- `cd ~/code/sitter && bun test` — full suite including the new census/classifier/scanner tests
- `cd ~/code/sitter && bun run gitpolice/watch.ts --json` — ad-hoc read-only scan against the live keeper.db
- `cd ~/code/sitter && bun run gitpolice/watch.ts --tick && cat ~/.local/state/babysitters/gitpolice/census.ndjson | tail` — one tick, inspect census output

## Acceptance

- [ ] `gitpolice/watch.ts --tick` appends one census NDJSON record per git invocation (per simple command in command position, across all `;|&`-joined segments) and per `keeper commit-work` invocation, exactly once across ticks via the event-id cursor
- [ ] Write-class (class != read) census records embed projection snapshots (file_attributions by session+project, git_status row, jobs git_* counts via job_id=session_id); read-only usage produces census rows but never a finding
- [ ] `raw-git-write` followups page once per (session_id, project_dir); `orphan-files` followups page per project_dir while git_status.orphaned_count > 0; both conform to FINDINGS-LEDGER.md
- [ ] One shared SUPPORTED_SCHEMA_VERSIONS pin in lib/ gates both sitters; the membership-pin test moves with it
- [ ] Scanner always exits 0 (missing DB, skew, corrupt cursor, append failure all degrade); heartbeat stamped every tick
- [ ] plist template + agents/gitpolice.md land; README/CLAUDE.md name both sitters and the hoisted pin location

## Early proof point

Task that proves the approach: `.1` (the pure tokenizer/classifier over real
command strings). If it fails: fall back to keeper's first-segment-only
tokenizeShell vendored verbatim and accept compound-command undercount as a
documented v1 blind spot.

## References

- ~/docs/babysitters/gitpolice/charter.md — producer contract: census path, key scheme `raw-git-write:<session_id>::<project_dir>`, categories
- ~/code/sitter/FINDINGS-LEDGER.md — followup/key/ledger contract (key as primary join, resurface rule)
- ~/code/sitter/performance/watch.ts — structural template: tick() (~2435), scan() (~1625), backstop-baseline cursor precedent (~1161), seen-state machinery (~2050)
- /Users/mike/code/keeper/src/derivers.ts — vendor source: tokenizeShell (644), extractBashMutation gate (~857), ENV_PREFIX_RE (498), BASH_COMMAND_CAP (488). COPY, never import (build-pin fence)
- /Users/mike/code/keeper/src/reducer.ts:7 — `job_id === session_id` invariant (the session→job join); :1867 keeper's own `jobs.job_id = fa.session_id` join
- git command-list.txt (https://github.com/git/git/blob/master/command-list.txt) — subcommand classification ground truth

## Docs gaps

- **README.md**: enumerate both sitters; repoint SUPPORTED_SCHEMA_VERSIONS references to lib/; add gitpolice launchd setup/teardown + --json line
- **CLAUDE.md**: whitelist-invariant location to lib/; name both sitters; add gitpolice/watch.ts to layout
- **FINDINGS-LEDGER.md**: add gitpolice to the implementing-sitters enumeration (lines 14-19)
- **~/docs/babysitters/gitpolice/charter.md**: cross-check Sitter facts once agents/gitpolice.md lands (verify, not blind-update)

## Best practices

- **Cursor-after-write ordering:** advance the event-id watermark only after the census append durably lands; on failure accept duplicate rows over permanent gaps [Elastic Agent / WAL-consumer pattern]
- **No bare /git/ regex:** detect git only in command position via a quote-aware state-machine tokenizer; `echo git status`, `GIT_SSH_COMMAND=…`, `hub --vcs git` are false positives for naive search [Shell Language Processing, arxiv 2107.02438]
- **checkout/stash traps:** `git checkout` always mutates; bare `git stash` = `stash push` (mutates) while `stash list/show` are reads — classify by sub-subcommand, strip global flags (-C, -c, --no-pager) first [git-scm.com]
- **Snapshot-stable reads:** wrap the scan in one read transaction for a stable WAL snapshot; fetch the batch, close the DB, then do file I/O (a held read txn blocks keeper's checkpoints) [sqlite.org/wal.html]
- **Daemon-owned rotation:** rotate census segments at tick start (the one-shot process model makes this trivially safe); never external logrotate [Elastic Agent]
