# 0057 — Named fast gate and deterministic proof policy

## Status

Accepted. Extends ADR 0005's suite Baseline contract and narrows ADR 0051's testing allowance.

## Context

Keeper's root test command is operational infrastructure: humans run it directly, the Baseline worker runs it in a scratch checkout, and merge-finalize runs it before landing a lane. The package script historically encoded its fast phase as the first segment of an `&&` chain, so Baseline and merge-finalize parsed shell text to discover the command. A direct `bun test` bypassed that contract, including its package exclusions, concurrency cap, orphan reaping, and separate OpenTUI phase.

The default suite also accumulated work that did not match its pure in-process contract: repeated full migration ladders in tests unrelated to migration, real storage compaction and corruption journeys, subprocess matrices, production-sized fixtures, wall-clock timeout proofs, fixed sleeps, and optional real-git/tmux/process correctness tiers. Those tests made the suite slow and contention-sensitive while duplicating narrower decision seams.

The trade-off is deliberate: a smaller deterministic proof can miss integration behavior that a real journey observes. Keeper already runs continuously in the same single-user environment, while slow and flaky landing gates tax every change and are frequently bypassed or distrusted.

## Decision

Keeper has one stable named root fast phase, `test:gate`. Humans, the Baseline worker, and merge-finalize invoke that script directly; no consumer parses `package.json` shell text to discover it. `test` composes `test:gate` with the serial, non-isolated OpenTUI phase. `test:full` remains the root, plan, and prompt package gate.

A side-effect-free Bun preload rejects direct aggregate discovery. Direct `bun test` is permitted only when it names explicit `*.test.ts` files; directories, globs, name-only filters, watch, and coverage options do not authorize aggregate discovery by themselves. The preload is an ergonomic accident guard, not a security boundary. Wrapped and escalation command guards agree with the same distinction.

Every correctness proof that can block landing belongs to a deterministic fast package gate. Keeper carries no opt-in slow correctness tier and no real-git promotion gate. Expensive end-to-end, tmux, git, detached-process, production-scale, and wall-clock tests are deleted rather than quarantined. Benchmarks and manual diagnostics may exist outside correctness gates, but their results never decide whether a change lands.

The default proof policy is:

- Inject clocks, schedulers, process runners, storage operations, and cleanup decisions; test state transitions without sleeping or spawning.
- Use migrated template clones for tests that consume the current schema. Run the migration ladder only when migration behavior is the subject.
- Keep a compact data-integrity matrix: ladder shape and fingerprint, zero-to-head and latest-transition migration, representative destructive/backfill behavior, downgrade refusal, reopen/idempotence, deterministic Re-fold equivalence, retention keep-set safety, and small file-backed SQLite checks only where persistence or corruption semantics are the contract.
- Keep OpenTUI runtime tests in their explicit serial phase until the pinned Bun/native-loader failure is disproved.
- Keep test execution lock-free, per-run capped, sandboxed, bounded by process-group deadlines, and protected by exact orphan-worker cleanup.
- Fail closed when a required package, phase, manifest entry, or expected test set is absent.

The performance objectives on the reference host are 10 seconds for `test:gate`, 12 seconds for `test`, and 20 seconds for `test:full`. Every run reports monotonic stage and total timings. Shared/local runs warn above those objectives. A dedicated `KEEPER_TEST_ENFORCE_BUDGET=1` reference run fails above 15, 18, and 30 seconds respectively. Baseline and merge-finalize enforce correctness and a generous hang deadline, not the performance budget, because shared-host contention is not evidence of a code regression.

## Consequences

The sanctioned aggregate commands become explicit interfaces rather than shell-layout conventions. Renaming or restructuring a package script requires updating one named contract, and accidental bare discovery fails before loading the suite.

The fast suite intentionally provides less integration coverage. Production dogfooding and operator diagnostics are the integration safety net; correctness gates favor narrow proofs that remain cheap enough to run on every change. ADR 0051's bounded real panel smoke is outside the correctness policy and is removed unless retained as a non-blocking manual diagnostic.

Migration and storage semantics keep real SQLite coverage where fakes would be dishonest, but fixtures remain tiny and purpose-built. Repeated current-schema setup, scale, and hardware-sensitive timing are not correctness evidence.

Performance budgets are reproducible on a qualified reference run without making a contended developer machine or shared Baseline worker flaky. Hang deadlines, cleanup, and correctness verdicts remain hard failures everywhere.
