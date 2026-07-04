## Description

**Size:** M
**Files:** src/codex-state-worker.ts (new, or an extension of the codex resume producer seam), src/daemon.ts, src/agent/transcript-watch.ts, test/codex-state.test.ts (new)

### Approach

Live-state for codex, investigation-first. PROBE ORDER MATTERS: first establish
whether codex's notify external-program hook (config.toml, layered) fires
per-turn and inherits the launcher env — if yes, a notify shim is the PRIMARY
mechanism: it is liveness-coupled (dies with codex, sidestepping replay
hazards) and writes events-log NDJSON keyed on KEEPER_JOB_ID exactly like the
hermes shim. If notify is coarse (completion/approval only) or identity-blind,
fall back to the daemon-side rollout tailer: once the rollout is attributed
(the resume back-fill's originator match — this task is gated on it), forward-
tail the rollout JSONL and have MAIN mint synthetic state events. Tail-derived
events are the replay-hazard case, so they use the NON-REVIVING fold arms
(HarnessActivity for working, plain Stop for stop) and stamp ts from the
rollout line's own timestamp, never wall-clock — a boot-scan replay of a dead
session's rollout must not flicker it back to working. Verify whether the
rollout stream carries a turn-START marker (stop markers task_complete /
turn_aborted / error are already parsed for run-capture); if no start marker
exists, codex churn is stop-only — accepted, state it in the descriptor
capability flags. The producer idles on jobs with NULL resume_target (never
guesses), reads identity/metadata and event markers only (never message
content — rollouts can carry secrets), and if it is a new worker it is a
five-site registry add (count consistency with the birth-ingest worker task).
Tests sandbox CODEX_HOME with fixture rollout files; never boot real codex.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- Live probes: codex notify config (fire conditions, env inheritance, payload identity), and whether rollout JSONL carries a turn-start marker — these two decide the mechanism
- src/agent/transcript-watch.ts:404 — codexStopFromObject (the stop markers already parsed)
- src/transcript-worker.ts — the forward-tail producer precedent (content-keyed, forward-only, synthetic-event minting)
- The HarnessActivity non-reviving fold arm from the schema task — the only legal working-direction arm for tail-derived state

**Optional** (reference as needed):
- src/agent/codex-session-index.ts — rollout attribution this task consumes
- src/usage-scrape-runner.ts — bounded polling loop shape

### Risks

- fn-1098 and the birth-ingest task both edit daemon.ts — land after them (deps + epic edge), expect import-block rebase
- Upstream may remove the originator override env; unresolved attribution leaves codex presence-only — the producer must idle gracefully, not spin

### Test notes

Fixture rollouts: stop marker -> Stop event with rollout-line ts; killed row +
replayed activity line -> state stays killed (the non-revive regression case);
NULL resume_target -> producer idles; notify-shim path (if chosen) gets golden
payload -> NDJSON tests like the hermes shim.

## Acceptance

- [ ] A tracked codex session shows at minimum live stop-churn (working too if a turn-start signal verified); the mechanism chosen is recorded in the harness descriptor's capability flags
- [ ] Replaying a dead session's rollout (boot scan or tail catch-up) never changes a killed or ended row's state
- [ ] The producer idles on unattributed sessions and reads only metadata/markers, never message content
- [ ] Codex sessions with no live-state mechanism available degrade to presence-only with no errors

## Done summary

## Evidence
