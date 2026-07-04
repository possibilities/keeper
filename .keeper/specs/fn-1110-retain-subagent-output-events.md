## Overview

Keeper's retention pass sheds PostToolUse:Agent and SubagentStop bodies, so the daemon can forever reconstruct what every subagent was asked (PreToolUse:Agent is kept) but never what it answered. Move those two classes into the keep-set so subagent input/output pairs — answer, resolved model, effort — stay durably SQL-joinable in keeper.db for offline analysis.

## Quick commands

- `bun test test/compaction.test.ts` — the shed/keep split suite

## Acceptance

- [ ] After a retention pass over aged events, PostToolUse:Agent and SubagentStop rows retain their data bodies while all previously-shed classes still shed, with tests pinning the new split
