## Description

Originating finding F1 (Critical). Evidence: `src/integrity-probe.ts:249`
spawns the literal `"botctl"` inside `sendBotctlPage`, and the symbols
`sendBotctlPage` / `BotctlPageOutcome` / `classifyBotctlPageOutcome`
(src/integrity-probe.ts:204-256, imported at src/daemon.ts:220) all carry
the stale `Botctl` vocabulary. Mainline commit `d19e9d9e` renamed every
page spawn to `"agentbot"` (now 7 sites in main: src/daemon.ts x5,
src/backup.ts, src/integrity-probe.ts). Because the epic MOVED the spawn
logic into a new helper while main renamed the old inline sites, a
three-way merge can auto-resolve with no conflict and silently keep the
dead `botctl` literal.

Files to change:
- `src/integrity-probe.ts` — the `"botctl"` spawn literal and the
  `sendBotctlPage` / `BotctlPageOutcome` / `BotctlPageSpawn` /
  `classifyBotctlPageOutcome` symbols → `agentbot` vocabulary.
- `src/daemon.ts` — the import and call sites (:220, :552, :11332).
- Sweep `docs/problem-codes.md` and any comments for stale `botctl` references.

## Acceptance

- [ ] `grep -rn '"botctl"\|Botctl' src/ cli/` returns nothing
- [ ] Every daemon page spawns the `agentbot` binary
- [ ] The paging truth-table tests in test/daemon.test.ts pass under the renamed symbols

## Done summary

## Evidence
