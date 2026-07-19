## Description

**Size:** M
**Files:** src/account-router.ts, src/agent/main.ts, src/agent/args.ts, src/agent/dispatch.ts, src/agent/resume-policy.ts, src/restore-set.ts, src/exec-backend.ts, plugins/keeper/plugin/hooks/events-writer.ts, cli/descriptor.ts, cli/status.ts, test/account-router.test.ts, test/agent-account-routing.test.ts, test/agent-args.test.ts, test/agent-dispatch.test.ts, test/agent-resume-policy.test.ts, test/exec-backend.test.ts, test/tabs.test.ts, test/status.test.ts

### Approach

Extend the selector as filter-then-prefer: compute one fresh eligible managed-route set, honor an explicit per-launch account first, select an eligible Fable focus target next, and otherwise invoke the existing score/reservation/LRU/tie-break path unchanged. For non-Fable Claude, remove the focus target only when another eligible route exists. An ineligible target records visible `fallback` state and uses normal balancing; Pi never enters this policy.

Add `keeper agent accounts fable-focus set|show|clear` with permanent, absolute UTC, cycle-end, and guarded current-reset forms. Current-reset resolves a fresh target `model:Fable` boundary into absolute intent; `--expect-reset` compares through whole-second precision, requires `now < boundary`, and leaves the previous policy unchanged on stale/missing/elapsed/mismatch refusal. Set/clear is idempotent and account inspection/status expose configured policy, effective state, target eligibility, focused/fallback outcome, and safe recovery codes.

Carry Fable intent separately from Launch attribution. Explicit effective model/preset establishes or overrides it; continuation, resume, restore, and fork inherit it when no explicit override exists. Canonical Fable legacy telemetry may seed intent, while unknown legacy/null work follows normal balancing. Routing remains per process and never reuses prior account attribution as affinity. Decision-time ineligibility falls back; existing ambiguous post-spawn failure behavior remains unchanged to avoid duplicate Claude processes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/account-router.ts:171-242` — model classification and eligibility.
- `src/account-router.ts:471-539,684-746` — automatic selector and conservation scoring.
- `src/account-router.ts:552-666` — non-reserving inspection contract.
- `src/agent/main.ts:2989-3026` — one account decision per Claude process and the null-model continuation gap.
- `src/agent/resume-policy.ts:54-73,110-125` — resume decision shape without model intent.
- `src/restore-set.ts:121-181,521-529` — restore candidates and queries without classification.
- `src/agent/dispatch.ts:34-35,74-77,207-214` — current account command grammar and ordinal semantics.
- `cli/status.ts:393-563` — pure status envelope builder.

**Optional** (reference as needed):
- `src/types.ts:557-568` — current display-only model telemetry supplied by task 1's storage groundwork.
- `test/helpers/agent-main-harness.ts:182-242,344-382` — injectable launcher/resume/routing harness.
- `docs/adr/0092-durable-fable-focus-routing.md` — precedence and fallback contract.

### Risks

- Stable slot 2 is route `claude-swap:2`; the display ordinal `c1` may change and must never be persisted.
- Fable automatic model behavior and legacy telemetry must not accidentally create account affinity or classify every unknown continuation as Fable.
- A preference must not make stale, exhausted, signed-out, or otherwise invalid routes eligible.
- Concurrent focused launches still use normal reservations but do not abandon an eligible target solely because of reservation pressure.

### Test notes

Build a decision table over Fable/non-Fable, target eligible/ineligible/absent, zero/one/many alternatives, all lifetimes, explicit route precedence, unavailable policy, and exact deadline/reset boundaries. Cover fresh, continuation, resume, restore, fork, legacy, explicit model override, and Pi non-regression with injected selectors and no real Claude/cswap/tmux processes.

### Detailed phases

1. Extend pure selection and inspection with effective focus input, focused/fallback reasons, and unchanged off-policy scoring.
2. Add strict account command grammar, machine envelopes, problem codes, and guarded reset construction.
3. Thread explicit/inherited Fable intent through launch, resume, restore, fork, and attribution producers.
4. Add canonical status output and exhaustive in-process contract tests.

### Alternatives

Treating focus as a large score was rejected because target preference and non-Fable soft avoidance need explicit observable reasons around the existing score. Using `current_model_id` alone was rejected because it is display telemetry and cannot represent inherited launch purpose reliably.

### Non-functional targets

- Off-policy routing remains byte-for-byte equivalent in candidate ordering and failure behavior.
- No new native Claude fallback appears; every selected route remains a fresh eligible claude-swap candidate.
- Machine output is schema-versioned, bounded, PII-free, and safe to retry after an uncertain setter acknowledgement.

### Rollout

Do not activate the live target from a task lane. Supply the guarded command and verification output for the operator action that runs only after the epic lands.

## Acceptance

- [ ] An eligible focused route serves every automatic Fable launch, while an ineligible target visibly falls back to the unchanged normal selector.
- [ ] Non-Fable Claude avoids the focused route when another eligible route exists and uses it when it is the sole eligible route.
- [ ] Explicit account selection wins over focus and retains its existing exact-request failure semantics.
- [ ] Fresh, continuation, resume, restore, and fork paths apply explicit or inherited Fable intent without reading prior Launch attribution as affinity.
- [ ] Permanent, absolute, cycle-end, and guarded current-reset commands set, show, and clear one atomic policy with stable route identity.
- [ ] Stale, missing, elapsed, or expected-reset-mismatched activation leaves policy unchanged and returns a typed machine-visible refusal.
- [ ] Unavailable policy delivery and ineligible targets preserve Claude availability through visible normal-balancing fallback; Pi behavior is unchanged.
- [ ] Account inspection and keeper status expose target, lifetime, effective state, eligibility, focused/fallback reason, and no account PII.
- [ ] Named router, launcher, resume, restore, descriptor, and status tests pass.

## Done summary
Extended account routing with durable Fable focus: filter-then-prefer selection (focus target preferred for Fable, soft-avoided for other Claude launches, visible fallback on ineligibility), guarded permanent/absolute/cycle-end/current-reset focus commands, Fable intent threaded through launch/continuation/resume/restore/fork without account affinity, and status/inspection surfaces exposing target/lifetime/eligibility/reason with no PII.
## Evidence
