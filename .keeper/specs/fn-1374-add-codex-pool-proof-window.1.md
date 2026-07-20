## Description

**Size:** M
**Files:** integrations/pi-codex-pool/src/index.ts, src/agent/main.ts, src/codex-pool-activation.ts, test/codex-pool-activation.test.ts, test/agent-account-routing.test.ts

### Approach

Introduce an explicitly-armed, duration-bounded proof-window state (a CLI verb or an
operator-set marker the launch path reads — worker's judgment, but it must be impossible to
arm accidentally and impossible to persist past its deadline or a restart). While armed, the
companion on the real `keeper agent pi` launch path builds the pooled delegate exactly as
active mode would, routing across enrolled aliases, so the proof collector can observe the
routing/stream clauses honestly. The activation gate itself does not weaken: thirteen clauses,
fresh report, refusal on any invalidation — the window exists only to make observation
possible. Env/config binding must reach the launched session the same way active mode's does.

### Investigation targets

*Verify before relying — these file:line refs come from the fn-1356 operator's live verdict.*

**Required** (read before coding):
- integrations/pi-codex-pool/src/index.ts:138-146 — the native-mode branch that skips pooledDelegate
- src/agent/main.ts:4304 — where MODE=active is derived from persisted activation.json
- src/codex-pool-activation.ts:518-534 — the proven-report refusal (must stay intact)

### Risks

- A proof window that survives restart or arms silently becomes a backdoor activation; the bound and explicit arming are load-bearing.
- The window must not touch credential material or weaken the sanitized-observer contract.

## Acceptance

- [ ] armed window ⇒ pooled routing observable on the real launch path; expired/absent window ⇒ native behavior byte-identical to today
- [ ] window state never survives its deadline, a daemon restart, or a session restart
- [ ] activation gate refusal behavior unchanged; suites green

## Done summary
Added an explicit, 15-minute launch-scoped Codex pool proof window bound to the launcher pid: --x-codex-pool-proof-window=arm on a fresh managed keeper agent pi launch makes the companion build the pooled delegate and route across enrolled aliases (mode=proof) exactly as active mode would, while the activation gate's thirteen-clause fresh-report refusal is untouched. The window lives only in the launch env, is rejected on resume/passthrough or malformed markers, is re-validated on wall clock plus parent pid on every stream call, and never persists past its deadline or a restart.
## Evidence
