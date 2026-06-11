## Description

**Size:** S
**Files:** test/daemon.test.ts or scripts/ (repro lives wherever it fits the repo's pattern — NOT wired into CI), .planctl evidence only otherwise

### Approach

Prove the fix empirically and close the bun question. (a) Repro loop:
a script or manually-run test that boots the in-process daemon
(test/helpers/in-process-daemon.ts, full worker set) in a loop under
induced CPU load (e.g. concurrent bun test shards or a spin-load
helper), tearing down cleanly each iteration. Pass bar: 50 consecutive
clean boots under load on the patched tree; record how many iterations
the UNPATCHED tree needs to fail (sanity that the repro actually
exercises the race — if the unpatched tree won't fail in 200
iterations, say so honestly in Evidence rather than claiming the repro
validates anything). Do NOT wire the load loop into CI (it would
recreate the contention flake CI just escaped); it is a
manually-invoked validation tool. (b) bun check: current runtime
1.3.14 — check bun's changelog/issues for releases carrying the
#29277 lazyLoadSQLite call_once fix (and #29275); record disposition
in Evidence. Pre-agreed interpretation: the openDb retry and
prepareStmts:false land REGARDLESS (defense-in-depth + cold-start
win); if a fixed bun exists, note the upgrade as a separate follow-up
decision for the human — do not bump bun in this epic.

### Investigation targets

**Required** (read before coding):
- test/helpers/in-process-daemon.ts — the harness + fn-749 workers selector
- test/daemon.test.ts fn-747 keystone — the boot/teardown shape to loop

### Risks

- A repro that cannot reproduce the unpatched failure proves nothing — report that outcome honestly instead of over-claiming
- Running the load loop inside CI would re-introduce the flake class this epic kills — keep it manual

### Test notes

The deliverable IS the evidence: iteration counts, failure signatures seen (if any), bun disposition. bun run test:full green after everything lands.

## Acceptance

- [ ] 50 consecutive clean boots under induced load on the patched tree, or an honest account of why the bar was adjusted
- [ ] Unpatched-tree failure reproduction attempted and the outcome recorded either way
- [ ] bun #29277/#29275 disposition recorded; no bun bump in this epic
- [ ] bun run test:full green

## Done summary
Added scripts/worker-open-boot-soak.ts: a manual (never-CI) full-worker-set in-process boot loop under induced CPU load. Patched/HEAD tree passed 50/50 clean boots; bun #29277 fix still unmerged (no bump). Unpatched-probe did not reproduce locally in 200 boots — reported honestly.
## Evidence
