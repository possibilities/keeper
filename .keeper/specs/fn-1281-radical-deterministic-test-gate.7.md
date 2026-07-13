## Description

**Size:** M
**Files:** scripts/lint-retired-name.sh, scripts/lint-retired-name.ts, test/lint-retired-name.test.ts, src/daemon.ts, test/daemon.test.ts, src/doc-commit.ts, test/docs-pusher.test.ts, plugins/keeper/pi-extension/task-facade.ts, test/pi-task-facade.test.ts, test/keeper-cli.test.ts, test/restore-sim.test.ts, test/panel-lifecycle-integration.test.ts

### Approach

Replace shell/process/boot-shaped fast tests with importable decision cores and injected adapters. Convert retired-name parsing/classification to one in-process implementation with a single non-fast entrypoint smoke, test archive/spill/worker-list decisions without booting daemon-shaped harnesses, inject process liveness and RPC timeouts, and delete broad simulated restore/panel journeys when focused component tests already cover their transitions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/lint-retired-name.test.ts:45-50,233-239 — repeated Bash plus live-repo scan
- scripts/lint-retired-name.sh:138-180 — recursive grep passes to replace with importable classification
- test/daemon.test.ts:2749-2760,3845-3946,9578-9779 — ps/archive subprocesses and daemon-shaped boots
- plugins/keeper/pi-extension/task-facade.ts:63,138-164 — production RPC timeout seam
- test/pi-task-facade.test.ts:268-288 — two-second failure-path wait
- test/restore-sim.test.ts:1-21 — broad fake end-to-end acceptance surface
- test/panel-lifecycle-integration.test.ts:23-89 — broad simulated orchestration surface

**Optional** (reference as needed):
- plugins/plan/test/harness.ts:61-80 — in-process CLI/fake external-command precedent

### Risks

Keep command construction, exit mapping, bounded output, and error policy coverage even when real spawning disappears. Do not move shell interpolation into a new seam. A live-repo lint belongs to lint execution, not unit tests.

### Test notes

Use executable-plus-argv runner interfaces, injected liveness, and millisecond fake RPC deadlines. Before deleting broad journey files, map each unique assertion to focused survivors or explicitly retire it under ADR 0057.

### Detailed phases

1. Convert retired-name logic to an importable core and move live-tree scanning to lint.
2. Extract archive/spill/worker-list/liveness decisions from daemon-shaped tests.
3. Inject RPC deadline and CLI launcher seams.
4. Delete duplicate restore/panel simulated journeys.
5. Audit the fast manifest for remaining real subprocess calls.

### Alternatives

Keeping one fast subprocess per command was rejected; runtime adapter behavior belongs to manual diagnostics under the accepted policy.

### Non-functional targets

No listed fast test spawns Bash, Bun, ps, true, daemon, Worker, socket, git, or tmux; child environments and output limits remain production concerns tested at pure boundaries.

### Rollout

Land pure replacements and deletions atomically so the named fast gate never has a coverage gap between commits.

## Acceptance

- [ ] Listed fast suites use importable cores and injected adapters rather than real subprocess or daemon-shaped execution.
- [ ] Retired-name fixture coverage remains in-process and live-tree cleanliness moves to the lint command.
- [ ] RPC/timeout failure tests settle deterministically without production waits.
- [ ] Duplicate restore/panel pseudo-E2E files are deleted after unique assertions are accounted for.
- [ ] The fast manifest contains no unapproved real process/daemon/Worker/socket/git/tmux execution.

## Done summary

## Evidence
