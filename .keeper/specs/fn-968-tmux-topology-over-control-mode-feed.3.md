## Description

**Size:** M
**Files:** test/refold-equivalence.test.ts, test/tmux-control-worker.slow.test.ts, test/tmux-boot-seed.test.ts, README.md

### Approach

Prove the producer relocation is byte-identical downstream and the old source is fully silenced, then
update the architecture docs.

- Re-fold determinism: a from-scratch re-fold over a log containing both pre-relocation (restore-worker)
  and post-relocation (control-worker) `TmuxTopologySnapshot` events reproduces byte-identical deterministic
  projections (the live-only location columns are charter-excluded as before; the floor + boot-seed unchanged).
- Dual-source equivalence (golden): the control-worker's `TmuxTopologySnapshot` payload for a fixed tmux
  state equals the restore-worker poll's payload for the same state — pin a golden fixture.
- Live path (`*.slow.test.ts`, allowlisted in scripts/test-real-git-allowlist.txt): attach a real `tmux -C`
  to a throwaway `-L` server, drive window/session changes, assert the topology snapshot tracks; kill+restart
  the server and assert the restore-worker's generation probe still fires the boundary (the recycle guard
  survives the relocation). Poll with `retryUntil`, never `Bun.sleep`; sandbox all state via `sandboxEnv`.
- README `## Architecture`: add the control-worker's numbered worker paragraph (focus + topology emission,
  reconnect lifecycle); strip the topology-poll arm from the restore-snapshot worker block (it keeps the
  restore.json mirror + the cheap generation probe); update the "timer-poll"/"topology poller" phrasings to
  the real-time control-worker. Current-behavior-only — no change history in prose.

### Investigation targets

**Required** (read before coding):
- test/refold-equivalence.test.ts — the re-fold determinism harness + the no-op-arm pinning test (must stay green; the relocation does not touch the predicate).
- test/tmux-control-worker.slow.test.ts — the existing real-`tmux -C` harness to extend with topology assertions.
- README.md `## Architecture` — the worker enumeration + projection-class taxonomy + the topology-poll/"timer-poll" passages docs-gap-scout flagged.

### Risks

- The re-fold test must treat the live-only location columns as charter-excluded (they already are) — don't assert byte-identity on them.
- The reconnect/generation test is the gap most likely to be missed — assert the boundary re-fires after a server restart.

### Test notes

Fast tier carries the re-fold + golden-equivalence tests; the real-tmux attach/reconnect test is
`*.slow.test.ts` only. `bun run test:full` before landing.

## Acceptance

- [ ] A re-fold over mixed-source topology events reproduces byte-identical deterministic projections; the no-op-arm pinning test stays green.
- [ ] A golden dual-source equivalence test asserts control-worker payload == old restore-worker payload for a fixed state.
- [ ] The slow real-tmux test asserts topology tracks live changes AND the generation boundary re-fires after a server restart.
- [ ] README architecture reflects the control-worker as topology producer and the restore-worker shed of its topology poll (current-behavior-only).

## Done summary
Pinned the topology producer relocation byte-identical: a mixed-source TmuxTopologySnapshot re-fold in refold-equivalence proves the live location columns are charter-excluded (floor-gated historical topology no-ops) and the deterministic class re-folds identically across both producer eras; extended the slow real-tmux test to assert the topology tracks a live session change AND the generation boundary re-fires after a kill+restart; updated README to make the control-worker the documented topology producer (new tenth-worker paragraph) and shed the restore-worker of its topology poll.
## Evidence
