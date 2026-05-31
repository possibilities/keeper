## Overview

keeper's production diagnostic drop feed (`~/.local/state/keeper/hook-drops.ndjson`)
is polluted by the test suite. Tests fire the REAL hook
(`plugin/hooks/events-writer.ts`) against a tableless temp DB to exercise the
dead-letter / exit-0 failure path, but the spawn helpers set `KEEPER_DB` and
`KEEPER_DEAD_LETTER_DIR` to temp paths while leaving `KEEPER_DROP_LOG`
unset — so the hook's drop-record append falls through to the hardcoded
production path on every test run. Result: 176 of 180 open-phase drop records
are synthetic test session ids (`sess-deadletter-ss`, `sess-mode`), NOT
genuine lost user events — corrupting the dropwatch watcher, the dead-letter
streak, and drop classification. (We NEVER wipe the production DB, so the
"tableless DB on restart" Mechanism-B premise was entirely this test leak.)
End state: every hook-firing test spawn writes its drop-log under `tmpDir`;
a clean test run appends ZERO rows to the production feed; the feed becomes a
trustworthy signal of real drops only.

## Quick commands

- `pre=$(wc -l < ~/.local/state/keeper/hook-drops.ndjson); bun test test/events-writer.test.ts test/integration.test.ts; post=$(wc -l < ~/.local/state/keeper/hook-drops.ndjson); echo "appended $((post-pre)) rows (must be 0)"`
- `grep -c 'sess-deadletter-ss\|sess-mode' ~/.local/state/keeper/hook-drops.ndjson` — should stop growing after the fix

## Acceptance

- [ ] A full run of the hook-firing test suites appends ZERO new rows to the production `~/.local/state/keeper/hook-drops.ndjson`
- [ ] All six hook-firing spawn sites route through a shared sandboxed base env (no `...process.env` spread leaks a state path)
- [ ] No production hook logic changed (writeDropLog / dropLogPath / exit-0 contract untouched)
- [ ] README + CLAUDE.md document the `KEEPER_DROP_LOG` / `KEEPER_DEAD_LETTER_DIR` overrides and the test-isolation contract
- [ ] `bun test` green; committed to main staging only touched files

## Early proof point

Task that proves the approach: `.1`. If it fails (a spawn site still leaks):
the before/after `wc -l` delta is non-zero — grep the new rows for the
offending synthetic session id and trace which spawn site emitted it.

## References

- Root-cause trace: `~/docs/keeper-reliability/findings.md` + `streak.md` (2026-05-31)
- Hook path resolution: `plugin/hooks/events-writer.ts` `dropLogPath()` ~:415, `writeDropLog` ~:427 (swallows errors — exit-0 contract, append-only, daemon never reads it)
- SIX hook-firing spawn sites (gap-analyst correction — the request named only four): `test/events-writer.test.ts` helpers `fireViaLauncher` ~:92, `fireViaLauncherWithEnv` ~:1131 (has `undefined`-clears-key overlay — apply base AFTER the clear loop or protect state keys), `fireViaLauncherWithDeadLetter` ~:1310, PLUS inline `Bun.spawn` ~:293 (sess-broken-ps, tableless DB — guaranteed leak); `test/integration.test.ts` `fireHook` ~:152 PLUS the SIGKILL victim launcher ~:1697
- UUID regex shape already in-repo at `test/events-writer.test.ts` ~:1383

## Host-local steward follow-ups (NOT planctl tasks — no repo artifact)

These are host-local, outside the git repo, executed by the steward after the
repo PR lands (tracked in `~/docs/keeper-reliability/`, not verifiable by a
repo build gate):
- Harden `~/.local/state/keeper/dropwatch.sh` to exclude non-UUID session ids (consumer-side filter ONLY — never a hook-side write skip, which would suppress legitimate `"unknown"`-session real drops).
- One-time scrub of the 176 leaked synthetic records from `hook-drops.ndjson` (jq-filter to temp keeping only UUID-session lines, then rename — safe: append-only, daemon never reads it), THEN reset `dropwatch.baseline` to the post-scrub line count.

## Docs gaps

- **README.md** (~:388 env-var prose): fold in `KEEPER_DROP_LOG` + `KEEPER_DEAD_LETTER_DIR`, one sentence each, inline-prose style; note the dropwatch UUID skip once the host-local filter lands.
- **CLAUDE.md** (event-sourcing invariants / dead-letter cluster): one sentence on the test-side override contract (centralize spawn env; never spread `...process.env` for state-bearing vars).

## Best practices

- **Centralize all hook-spawning behind one base-env helper** so "forgot to override a state path" becomes structurally impossible — the leak class, not just this instance.
- **Override every state-bearing env var** (`KEEPER_DB`, `KEEPER_DEAD_LETTER_DIR`, `KEEPER_DROP_LOG`) in the shared base; prefer explicit overrides over HOME/XDG sandboxing (lower risk of perturbing unrelated fallback resolution).
- **Verify the env reaches the hook through the launcher chain** (helper → launcher shim → hook): the override must be set on the outermost spawn and inherited down.
