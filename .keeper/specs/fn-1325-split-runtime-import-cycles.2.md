## Description

**Size:** M
**Files:** src/restore-worker.ts, src/tabs-core.ts, src/tmux-boot-seed.ts, src/server-generation-probe.ts, test/restore-worker.test.ts, test/tabs.test.ts, test/tmux-boot-seed.test.ts

### Approach

Move `probeServerGeneration` and its injected spawn contract into a dependency-neutral leaf consumed by restore-worker, tabs-core, and tmux-boot-seed. Continue using exec-backend's sole generation argv builder and parser; preserve each caller's current distinction among confirmed absence, malformed output, spawn failure, timeout, and signal. Keep tabs-core's render and launcher-prefix ownership unless a neutral extraction is necessary—never fork those implementations to make the graph pass.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/restore-worker.ts:806-863 — injected Generation probe and worker-side degradation semantics
- src/restore-worker.ts:1074-1085,1131-1135 — tabs-core render/prefix consumers
- src/restore-worker.ts:1228-1231 — current worker startup guard
- src/tabs-core.ts:914-950 — tabs-side timeout/signal refusal versus confirmed absence
- src/tmux-boot-seed.ts:62-63,127-151 — third probe consumer and topology integration
- src/exec-backend.ts:485-498,522-565 — canonical Generation argv, parser, and producer
- test/restore-worker.test.ts:884-941 — probe success and malformed/spawn failure fixtures
- test/tabs.test.ts:1466-1495 — timeout/signal versus absent semantics

**Optional** (reference as needed):
- src/tabs-core.ts:722-799,1407-1414 — shared restore script and launcher-prefix implementation
- test/restore-worker.test.ts:1231-1262 — restore script mode/exclusion behavior

### Risks

- Changing module evaluation time can freeze environment-derived launcher defaults earlier or later
- Collapsing caller-specific timeout and absence semantics can restore against the wrong live Generation
- A stale tmux-boot-seed import can preserve an indirect cycle even if the named pair looks clean

### Test notes

Keep injected spawn tests in-process. Cover all three consumers, canonical valid and malformed Generation values, thrown/nonzero probes, timeout/signal distinction, no duplicated builder/parser, render parity, mode 0600, and worker import inertness.

## Acceptance

- [ ] `tabs-core` has no runtime import path back to `restore-worker`, and all three consumers use one dependency-neutral Generation probe
- [ ] The probe mints identity only through exec-backend's canonical argv/parser and accepts no alternate Generation format
- [ ] Restore-worker, tabs-core, and tmux-boot-seed preserve their existing success, absence, malformed, spawn-failure, timeout, and signal classifications
- [ ] Restore script rendering, launcher-prefix evaluation, mode 0600, exclusion behavior, and worker lifecycle remain unchanged
- [ ] Focused restore, tabs, boot-seed tests plus typecheck pass

## Done summary
Extracted probeServerGeneration and its SpawnSyncFn contract into a dependency-neutral src/server-generation-probe.ts leaf, breaking the tabs-core <-> restore-worker runtime import cycle while preserving every consumer's existing probe classification and worker/render behavior.
## Evidence
