## Description

**Size:** M
**Files:** src/agent/main.ts, src/autopilot-worker.ts (or the extracted launch-config module if the verdict-core epic relocated it)

### Approach

Two drifted copies of "is this launch config complete?" exist: the agent-run gate (src/agent/main.ts:962-1000) only checks that a <cli>_default pointer exists, while the launcher gate (:1697-1732) validates the resolved preset supplies model plus the second axis — so an underspecified default on the run path launches a doomed detached pane that surfaces as no_transcript/timed_out instead of clean bad_args. Build one shared resolution helper answering "does the resolved preset supply model + the correct second axis for its harness" (effort for claude/codex, thinking for pi — the current gate's model&&effort check is wrong for pi; fix that as part of unification). Each gate keeps its own emission contract: the run path emits its bad_args envelope, the launcher path keeps its exit-code behavior. Fold the duplicated harness-mismatch validation (main.ts:936-961 vs 1613-1619) into the same helper if it stays mechanical; leave it if not. Separately, resolveWorkerLaunchConfig silently drops preset.harness on the autopilot worker path: within its documented never-crash swallow contract, add a loud console.error emitted once per distinct offending preset (not per reconcile cycle) stating that autopilot ignores non-claude harness values until harness dispatch lands, then continue on claude. Never throw there.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:962-1000 and :1697-1732 — the two gates and their differing emission contracts
- src/agent/main.ts:435-481 — resolveLaunchConfigSignals and unresolvedDefaultMessage, the existing partial helpers to build on
- src/agent/config.ts:150-166 — PresetHarness and the harness field the worker path drops
- resolveWorkerLaunchConfig (autopilot-worker.ts:530-556 pre-extraction; find its post-extraction home) — the swallow-to-constants contract comment

### Risks

The pi thinking-vs-effort fix changes gate #1's acceptance for pi presets — that is the intended bug fix, but call it out in the commit message. The worker-path warning must be rate-limited by preset identity or it becomes reconcile-cycle log spam.

### Test notes

Cases: underspecified claude default on the run path → bad_args (not no_transcript); pi preset with thinking but no effort → passes both gates; harness mismatch → one shared message; non-claude worker preset → exactly one warning across repeated reconcile cycles, launch proceeds on claude.

## Acceptance

- [ ] One shared launch-readiness helper; both gates route through it, emissions unchanged in shape
- [ ] pi second-axis handled correctly on both paths
- [ ] Dropped preset.harness warns loudly once per distinct preset and never throws
- [ ] `bun test` green

## Done summary

## Evidence
