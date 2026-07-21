## Description

**Size:** M
**Files:** cli/await.ts, cli/descriptor.ts, src/await-conditions.ts, src/protocol.ts, src/await-worker.ts, src/quota-threshold.ts, test/await.test.ts, test/await-worker.test.ts, test/rpc-handlers.test.ts, test/reducer-projections.test.ts, test/keeper-cli.test.ts

### Approach

Add inclusive raw-percent conditions `context-used-at-least <percent>` and `weekly-quota-at-most <percent>`, validating finite fractional values in `[0,100]`. Context binds the ambient exact runtime subject and remains foreground-only; it participates in `--probe`, `--require-transition`, and AND expressions, but any durable expression containing it refuses before arming and a terminal target yields a bounded target-ended failure.

Weekly quota supports foreground and durable use. Resolve `route:current` once into provider, stable Claude Account route or opaque Codex alias, weekly meter, Codex quota scope, and resolution time before accepting the condition; explicit routes use the same validation. Re-evaluate from validated Capacity readers using provider-owned freshness/eligibility semantics, leaving missing/stale/unavailable/removed evidence waiting. Add mutually exclusive durable `--follow-up`/`--follow-up-file` inputs through the existing bounded spill seam, preserve generic omission compatibility, and enable one coalesced durable idle wake no slower than 30 seconds without refreshing providers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/await.ts:382-405` — parsed condition union and slot structure.
- `cli/await.ts:800-969` — condition arity, duplicate, and mode validation.
- `cli/await.ts:3086-3138` — foreground-to-durable condition serialization.
- `cli/await.ts:3256-3308` — generic follow-up generation and bounded spill request.
- `src/protocol.ts:355-414` — durable condition vocabulary and generic request payload.
- `src/await-worker.ts:174-246` — firing acknowledgement, stable launch identity, and verbatim follow-up dispatch.
- `src/await-worker.ts:272-432` — server-side condition evaluation.
- `src/await-worker.ts:540-606` — current DB-only worker wake loop.
- `src/wake-worker.ts:127-209` — reusable coalesced idle wake.

**Optional** (reference as needed):
- `src/account-observation.ts:22-104` — Claude weekly Capacity source and trust fields.
- `src/codex-account-router.ts:118-151` — scoped Codex observation vocabulary.
- `test/await-worker.test.ts:1-535` — exhaustive condition-kind and lifecycle fixture pattern.

### Risks

The foreground Monitor must observe exact leaf changes that do not advance keeper.db without adding a tight polling loop. Durable route capture and prompt spill cleanup must not leave half-armed intent, and the condition-kind mirrors must stay exhaustive across CLI, protocol, RPC, worker, help, and tests. `done` continues to mean accepted/bound follow-up launch, never completed follow-up work.

### Test notes

Cover numeric boundaries and equality, already-true/transition/probe behavior, mixed AND expressions, durable-context refusal, target-ended context, route-resolution races, unsupported scope/meter refusal, stale/unavailable/removed evidence, reset semantics shared with each provider, sidecar-only firing with no DB commit, restart/cancel/timeout races, exact prompt delivery, prompt cleanup, launch failure, and secret canaries. Use manual clocks/schedulers and temporary sidecars only.

### Detailed phases

1. Add pure canonical threshold predicates and foreground condition grammar/evaluation.
2. Freeze and serialize authoritative weekly route/meter/scope intent for durable rows.
3. Add bounded follow-up inputs and preserve existing firing/cancel/bind fences.
4. Enable shared idle re-evaluation and complete exhaustive protocol/help/test mirrors.

### Alternatives

A generic meter-expression DSL was rejected for the initial contract because provider windows are dynamic and the requested weekly use case has one stable semantic. Filesystem watchers per await were rejected in favor of the existing coalesced recovery wake. A durable context condition was rejected because its follow-up has a different context window.

### Non-functional targets

Foreground out-of-band conditions react on a bounded low-cost cadence; durable sidecar-only changes are rechecked within 30 seconds. Evaluation never invokes observers, opens writable DB connections, reads credentials, or appends lifecycle state outside main.

### Rollout

New condition kinds and follow-up flags are additive. Existing durable rows, generic follow-up omission, transition behavior, cancellation ownership, timeouts, and request RPC remain compatible; no schema step or RPC allowlist change is introduced.

## Acceptance

- [ ] Context and weekly-quota conditions accept finite inclusive percentages in `[0,100]`, compare raw canonical values at equality, and reject malformed values with stable usage errors.
- [ ] Foreground context waits bind proven exact runtime telemetry, honor immediate/transition/probe/AND behavior, fail when the target ends, and reject every durable expression containing a context segment before arm.
- [ ] Weekly quota waits freeze a concrete provider, stable route/alias, weekly meter, scope, and resolution time; absent authoritative current routing refuses arm and later routing changes never retarget the condition.
- [ ] Missing, malformed, stale, unavailable, or removed frozen-route evidence remains visibly waiting and never becomes zero usage/capacity or a false threshold match.
- [ ] Durable `--follow-up` and `--follow-up-file` preserve the exact bounded document, are mutually exclusive, clean failed-arm artifacts, and do not expose prompt content through diagnostic/list/error paths.
- [ ] A fired follow-up uses normal independent account routing and preserves existing firing-before-effect, cancellation race, stable effect identity, bounded never-bound recovery, and launch-accepted-not-completed semantics.
- [ ] Sidecar-only changes and elapsed deadlines cause durable re-evaluation within 30 seconds without an unrelated SQLite commit, per-await watcher, observer refresh, or fixed sleep.
- [ ] Durable condition allowlists, protocol validation, worker cases, reducer round trips, CLI/help descriptors, and targeted tests remain exhaustive and green without a migration or new RPC.

## Done summary

## Evidence
