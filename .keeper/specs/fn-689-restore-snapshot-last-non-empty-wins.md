## Overview

`scripts/restore-agents.ts` is useless today because `restore.json` is empty
exactly when you'd want to restore from it. The restore-worker rewrites the
side-file on every content change — INCLUDING a change to empty — so when
agents wind down (SessionEnd→`ended` / Killed→`killed` drop them from the
`working`/`stopped` live set) or a reboot's `seedKilledSweep` marks dead pids
killed before the worker spawns, the file gets overwritten with
`{sessions:{}}`. The recovery event itself destroys the snapshot.

Fix: adopt browser "restore previous session" semantics — **last-non-empty-wins**.
The worker keeps writing the live descriptor while non-empty, but SKIPS the
write whenever the descriptor is empty, preserving the last populated snapshot
on disk. Single file, repurposed write policy — no new file, no schema bump,
no event-log coupling (the side-file is a non-projection per the worker
contract).

## Quick commands

- `bun test test/restore-worker.test.ts` — the gate + reboot-preservation tests
- `bun scripts/restore-agents.ts` — dry-run; after a real session it should now list the prior agents instead of "nothing to restore"

## Acceptance

- [ ] `restorePulse` never overwrites `restore.json` with an empty descriptor — the skip is UNCONDITIONAL on empty (not gated on `lastHash`), so the fresh-process reboot case (`lastHash===null`, empty live set) preserves the pre-crash file
- [ ] empty-skip does not advance `state.lastHash`; a later non-empty pulse still writes
- [ ] doc comments + README + CLAUDE.md updated from "write-on-change" to "last-non-empty-wins"

## Early proof point

Task that proves the approach: `.1` — the reboot-preservation test (`lastHash===null` + empty live set leaves a populated file intact) is the single assertion that the whole fix exists to satisfy. If it fails: the guard is mis-placed (gated on `lastHash` or sitting after the write) — move it to an unconditional early-return right after `buildRestoreDescriptor`.

## References

- `src/restore-worker.ts:260-323` — `restorePulse`, the fix site (hash gate at 290, write+`lastHash=` at 310-312)
- `src/daemon.ts` ~1210 (`seedKilledSweep`) / ~2848 (restore-worker spawn) — the reboot ordering that makes the empty-skip load-bearing
- epic fn-677 — the original restore-snapshot substrate this repurposes

## Docs gaps

- **src/restore-worker.ts** (file header JSDoc): replace "rewrites … ONLY when the hash differs" / "write-on-change" framing with last-non-empty-wins (skip on empty descriptor; rationale: survive reboot/seed-sweep zeroing)
- **scripts/restore-agents.ts** (file header JSDoc, lines ~5-6): "the restore-worker maintains write-on-change" → last-non-empty-wins; note the file intentionally outlives zeroing events and is not always current-state
- **README.md** (~434-438 "latest-always" one-liner; ~1638-1658 tenth-worker paragraph): revise the write-policy description in place to last-non-empty-wins; keep each to one paragraph, no appended "also" clause
- **CLAUDE.md** ("Sole-writer rules", ~73-80): extend the restore-worker sole-writer sentence with one subordinate clause noting an empty descriptor does NOT overwrite a prior snapshot

## Best practices

- **Skip-on-empty must be unconditional** (Chrome/Firefox/VS Code "last known good" pattern): never overwrite a populated session file with an empty payload. Gating on `lastHash !== null` reintroduces the reboot bug. [browser session-restore]
- **Preserve the atomic temp+rename write** for every write that DOES happen; the fix only adds an early `return`, it must not regress `atomicWriteFile`. [POSIX rename atomicity]
