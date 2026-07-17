## Description

**Size:** M
**Files:** src/agent/pair-subcommands.ts, src/agent/transcript-watch.ts, src/agent/run-capture.ts, src/agent/main.ts, src/agent/tmux-launch.ts, test/agent-pair-subcommands.test.ts, test/agent-run-capture.test.ts, test/agent-run-capture-golden.test.ts, test/agent-transcript-background.test.ts, test/agent-tmux-launch.test.ts, docs/agent-surface-contracts.md

### Approach

Extend the existing pinned-handle wait/capture stack rather than forking it. A run-id handle carries enough exact identity and a per-harness invocation boundary for an injected, DB-free liveness seam to re-derive the matching Keeper job's folded state during transcript discovery and stop polling; already-terminal partners short-circuit. Direct transcript-path handles lack lifecycle identity and retain transcript-only behavior.

A settled stop proven fresh for this invocation wins over later clean teardown. When no fresh stop exists and exact lifecycle evidence becomes terminal, all three surfaces return a typed `partner_died`; stale stops and whole-transcript message scans cannot leak a prior turn into a resumed or delayed capture.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/pair-subcommands.ts:30-52` — `ResolvedHandle` currently lacks lifecycle identity; preserve direct-path compatibility.
- `src/agent/pair-subcommands.ts:244-302` — one absolute wait deadline currently spans transcript discovery and stop polling without liveness.
- `src/agent/transcript-watch.ts:96-153` — both polling loops need the same injectable death rail; resumed Pi currently samples its stop floor too late for delayed waits.
- `src/agent/transcript-watch.ts:155-205` — whole-file message fallback can surface prior-turn output.
- `src/agent/run-capture.ts:326-365` — closed outcome/exit taxonomy and exact nine-key envelope.
- `src/agent/run-capture.ts:802-885` — shared `agent run`/`agent wait` compose path and stop/message precedence.
- `src/agent/main.ts:840-934` — raw `wait-for-stop` machine surface and injected seam boundary.
- `src/agent/tmux-launch.ts:1206-1245` — durable run metadata available to delayed run-id waits.

**Optional** (reference as needed):
- `test/agent-run-capture-golden.test.ts` — exact envelope key and outcome snapshot.
- `test/agent-transcript-background.test.ts:326-522` — settled-stop and resumed-Pi fixtures.
- `docs/agent-surface-contracts.md:24-43` — canonical answer-envelope contract.

### Risks

- Window absence is not death because autoclose may remove a successfully settled Provider leg.
- `src/agent/run-capture.ts` must remain free of `bun:sqlite` and heavyweight daemon imports.
- A stop/death race must be deterministic: fresh completion wins; unknown probe results do not become death.
- A stop may predate a delayed waiter, so freshness cannot be sampled only when the waiter starts.

### Test notes

Use injected clocks, liveness outcomes, and transcript mutations. Cover terminal-before-path, terminal-during-path, terminal-during-stop, current-stop-plus-clean-end, stale resumed Claude/Pi stops, delayed waits, direct-path unknown identity, malformed/vanished transcripts, and exact envelope/output exit behavior.

### Detailed phases

1. Carry exact lifecycle identity and a persisted invocation freshness boundary through run metadata and `ResolvedHandle` without changing direct-path behavior.
2. Add one injectable tri-state lifecycle probe to both transcript-path and stop polling under the existing absolute deadline.
3. Extend wait results, run-capture outcomes, raw wait output, and message selection with deterministic stop/death precedence.
4. Update the golden contract and canonical agent-surface documentation in place.

### Alternatives

- Do not use pane/window absence as the liveness source; cleanup makes it ambiguous.
- Do not sample a structural stop floor only at delayed-wait entry; a completed new turn may already be present.
- Do not import Keeper's SQLite layer into run-capture; inject a narrow query seam.

### Non-functional targets

- Proven death is observable within one existing transcript poll interval under a healthy daemon query path.
- The check adds no busy loop, second wall-clock budget, or unbounded transcript scan.
- Existing successful envelope key order and direct-path command behavior remain compatible.

### Rollout

No migration is required. Existing run artifacts without the new optional identity/boundary fields retain current transcript-only behavior rather than being misclassified dead.

## Acceptance

- [ ] A run-id partner already terminal before transcript creation, or becoming terminal during transcript discovery or stop polling, returns typed `partner_died` within one liveness recheck and does not consume the remaining stop timeout.
- [ ] A fresh settled stop for the invocation returns `completed` or `no_message` even if clean SessionEnd follows, while prior-turn stops/messages cannot satisfy resumed or delayed waits.
- [ ] `agent run`, `agent wait`, and `wait-for-stop` expose the documented death discriminator and non-success exit behavior without changing the nine envelope keys or falsely claiming death for a direct-path handle.
- [ ] The capture dependency graph stays DB-free and all named agent capture, transcript, metadata, and golden suites pass.

## Done summary

## Evidence
