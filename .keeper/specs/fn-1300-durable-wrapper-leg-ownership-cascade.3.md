## Description

**Size:** M
**Files:** src/daemon.ts, src/reducer.ts, cli/agent.ts, src/commit-work/process-identity.ts, test/provider-leg-cascade.test.ts, test/reducer-projections.test.ts

### Approach

The level-triggered cascade producer (ADR 0071): on a folded wrapper-terminal OR durably-superseded transition proven against the exact owner tuple, walk that attempt's legs from the ownership registry — write-ahead each signal event, re-probe exact identity (reuse the recycle-safe classifier) before TERM and again before KILL, honor the durably stored kill-not-before deadline and attempt caps, confirm exit only from the leg's own folded terminal event or a recycled identity (a recycle within ~1s of recorded start-time needs a corroborating pane-generation or command-mismatch signal), then mint exact-tuple release once every owned leg is settled. A closing wrapper goes terminal → cascade → release, never release-first. Unknown identity, unowned command, signal failure, or unconfirmed KILL parks the incident as a page-once blocked sticky. Split cli/agent.ts's TERM→KILL ladder into reusable identity/signal mechanics vs operator policy — the cascade terminates a working leg under owner-terminal proof, which the operator verb rightly refuses. Duplicate producer ticks and daemon restarts are fenced by the persisted incident key (owner tuple + leg_launch_id + ownership-epoch event id + phase/attempt ordinal); no boot event-id fence, no separate exit event — reuse the leg's terminal fold.

### Investigation targets

*Verify before relying.*

**Required:**
- src/commit-work/process-identity.ts:102-169 — the recycle-safe pid/start-time classifier (MUST reuse; ESRCH/start-mismatch proves gone, unreadable stays inconclusive)
- cli/agent.ts:104-252 — the identity-rechecked TERM→KILL ladder to split (mechanics vs its refuses-working policy)
- src/autopilot-worker.ts:1491-1687 — pure signal-decision matrix + injected runner pattern to mirror
- src/provider-leg-death-notice.ts:307-391 — bounded post-fold producer sweep shape (dedupe, retry-state outside the fold); coordinate paging per incident with it
- src/daemon.ts:7628-7689 — the existing wrapped-terminal discovery join this producer supersedes

**Optional:**
- test/autopilot-worker.test.ts:365-499 — TERM/grace/KILL decision-matrix test shape
- test/commit-work-process-identity.test.ts:139-248 — no-signal-to-unproven coverage pattern

### Risks

- The single riskiest mode is misreading a fast same-second pid recycle as exit proof — the corroboration rule is mandatory, not optional.
- Two producers (cascade + death-notice) react to the same terminal fold; a single incident must not double-page the operator.
- Signal syscalls can throw EPERM/ESRCH mid-ladder; every failure lands in the incident row, never a silent skip.

### Test notes

Injected clock/probe/signal runners; interruption coverage at every boundary (crash after write-ahead, before signal; after TERM, before deadline; after KILL, before confirm), duplicate-tick idempotence, superseded-authority trigger, multi-leg partial settlement blocking release, closing-posture ordering.

## Acceptance

- [ ] A killed wrapper's legs are terminated and their claims released without operator action, surviving a daemon restart at any phase boundary
- [ ] A durably-superseded live wrapper's legs cascade; the newer attempt's legs are untouched
- [ ] No signal is ever sent to an identity that fails the exact re-probe; recycled-within-1s requires corroboration before counting as exit
- [ ] Release fires only after ALL owned legs settle and is refused when the claim tuple moved
- [ ] Blocked incidents page exactly once and re-arm only on producer level-clear

## Done summary
Landed the level-triggered terminal-cascade producer: identity-rechecked TERM->KILL teardown of owned Provider legs with recycle-safe corroboration, restart-safe phase fencing, and exact-tuple claim release only after all owned legs settle; split cli/agent.ts's ladder into reusable mechanics vs operator refusal policy.
## Evidence
