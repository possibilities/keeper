## Description

**Size:** M
**Files:** src/agent/launch-handle.ts, src/agent/tmux-launch.ts, src/agent/main.ts, src/birth-record.ts, src/daemon.ts, test/birth-record.test.ts, test/birth-ingest-worker.test.ts, test/provider-leg-launch.test.ts

### Approach

Identity precedes the paid process (ADR 0071): a wrapped launch missing/malformed on the owner tuple aborts before spawn; the launcher spawns a keeper shim (recognized command signature, no paid work), promotes the shim's pid + start-time as the leg identity through the existing atomic intent→promotion protocol, and the shim execs the provider only on a one-use grant issued after a pre-exec recheck (exact claim still bound; wrapper neither terminal nor superseded). Promotion or grant failure exits the shim pre-exec. Daemon-down leaves the gate inert (holds the pane, spends nothing) until grant or bounded timeout. Birth ingestion also scans `pending/` (a crash between the two publication renames strands a complete record there today) and is idempotent on `leg_launch_id`. The Claude wrapper's SessionStart hook path is never launch authority — it remains birth *recording* only.

### Investigation targets

*Verify before relying.*

**Required:**
- src/birth-record.ts:228-349 — atomic maildir intent/promotion protocol (extend, never duplicate); publishBirthIntent's two renames
- src/agent/launch-handle.ts:225-280 — per-launch job-id mint + pane KEEPER_JOB_ID overwrite (every fresh/resumed leg re-stamps ownership)
- src/agent/tmux-launch.ts:680-714, 838-889 — the exec-array launch carrier and env allowlist the shim chain rides
- src/daemon.ts:6280-6362 — birth ingestion minting the synthetic SessionStart (add pending/ scan beside it)
- src/dispatch-command.ts:20-39 — bounded decimal attempt-carrier parser to reuse

**Optional:**
- plugins/keeper/plugin/hooks/events-writer.ts:318-328, 864-881 — Claude-side attempt carrier capture (recording parity)

### Risks

- exec preserves pid + start-time — the promoted identity stays valid for the paid process; verify on macOS `ps lstart`.
- Pane classifiers (autoclose, death-notice, harness-command checks) must recognize the shim-phase signature or they misclassify the gate window.
- Launch-carrier values are untrusted: validate the claimed owner tuple against the live claim at grant time, not at spawn time only.

### Test notes

Deterministic seams: injected grant/probe runners, no real tmux/subprocess. Cover: ownerless abort-before-spawn, promotion-fail exits pre-exec, grant withheld on terminal/superseded owner, pending/ recovery idempotent on leg_launch_id, daemon-down inert gate timeout.

## Acceptance

- [ ] A wrapped launch without a valid owner tuple spawns no provider process
- [ ] Owner terminal-or-superseded between intent and grant leaves no paid process (grant withheld, shim exits)
- [ ] A stranded pending/ birth is ingested exactly once after restart
- [ ] The shim-phase pane is never torn down or death-noticed as a provider leg
- [ ] Existing non-wrapped launch paths are behaviorally unchanged

## Done summary
Gated wrapped provider launches on durable ownership: launcher spawns an inert shim that promotes identity through the birth intent/promotion protocol and exec's the provider only after a daemon-issued, one-use pre-exec grant; birth ingestion now scans pending/ for stranded records idempotently on leg_launch_id and withholds grants for terminal/superseded owners.
## Evidence
