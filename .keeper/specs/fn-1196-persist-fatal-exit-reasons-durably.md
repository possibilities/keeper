## Overview

keeperd's `fatalExit` path exits without recording why: server.stdout/stderr do not survive respawns usably, and the restart ledger stores bare timestamps. A restart burst (4 boots in 28 minutes observed) is undiagnosable after the fact. This epic makes the fatal reason durable: ledger entries become objects carrying the named reason, written synchronously and atomically before exit, with the crash-loop decision unchanged.

## Quick commands

- `bun test test/daemon.test.ts` — ledger pure-fn suite (parse/update/decide/read/write)
- `cat ~/.local/state/keeper/restart-ledger.json` — post-deploy: newest entry carries a reason after any fatal exit

## Acceptance

- [ ] A fatal exit records its named reason durably in the restart ledger before the process exits
- [ ] Legacy bare-number ledgers (and mixed shapes) parse without error and count identically for the crash-loop decision
- [ ] Crash-loop distress semantics unchanged: decision reads timestamps only

## Early proof point

Task that proves the approach: `.1`. If the ledger-shape change ripples wider than expected: keep the on-disk shape dual-read (objects preferred, numbers tolerated) and land the reason field only.

## References

- docs/adr/0003-fatal-exit-over-self-heal.md — the fatalExit-over-self-heal contract this extends
- Incident evidence: restart ledger showed [1783523498879,1783524420547,1783524913665,1783525148005], launchd last exit code 1, no fatal reason recoverable

## Docs gaps

- **docs/adr/0003-fatal-exit-over-self-heal.md**: amend with the ledger schema decision ({ts, reason} entries) once landed
- **plugins/keeper/skills/watch/SKILL.md**: sharpen the read-the-restart-ledger-before-bouncing guidance — the ledger now names the fatal reason

## Best practices

- **Persist the reason yourself, atomically, before exit** — never rely on stdout surviving a respawn; write-tmp-then-rename, sync, 0600 [practice-scout]
- **launchd holds the StandardOutPath fd** — rename-based rotation orphans it (silent log loss); if rotation is added, truncate-in-place [practice-scout]
- **Rate, not count, detects a crash loop** — keep the decision on the ts field; the reason is forensics, never an input to the counter
