## Overview

The panel-cancel cleanup pass can report a launched member as torn-down-clean
(`state="cancelled"`, exit 0) when its pidfile never becomes readable within the
cleanup window — a rare under-load race that leaves a possibly-live, never-signalled
panel-member process while `cancel` returns success. This is a correctness fix to the
epic's central exact-teardown guarantee: classify an unknowable-liveness launched
member as unresolved rather than cancelled, matching the module's own
fail-toward-unresolved discipline.

## Acceptance

- [ ] A launched member (`launched_at !== null`) whose pidfile never materializes by the cancel deadline is reported `cleanup_failed`/unresolved, not `cancelled`.
- [ ] `panelCancel` returns a non-zero (unresolved) exit for that case, and the member id appears in `unresolved_cleanup`.
- [ ] A regression test exercises the pidfile-not-yet-present-at-cancel path (existing cancel tests seed the pidfile before cancelling).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Trailers confirmed missing on 1dc92fff/f099b4d7, but reconciliation is close-time git-history process (not a fresh-branch follow-up worker) and both tasks ran under their own job-gates; the task .1 finalizer spot-checked clean and tested. |
| F2 | kept | .1 | panelCancel reports a launched member with a never-readable pidfile as `cancelled` (exit 0), leaking a possibly-live unsignalled child; fix fails toward unresolved. |
| F3 | culled | — | pi finalizeScope timeout-without-force is the epic's deliberate acknowledge-only-after-settlement tradeoff, shutdown-safe via dispose(), requires a misbehaving session — theoretical. |
| F4 | culled | — | flushMicrotasks `for i<8` is a bounded test-only micro-turn nit with no hang risk or user impact. |

## Out of scope

- Commit-trailer reconciliation for tasks .1/.6 (F1) — a close-time provenance decision for the human/closer, not deferrable code work.
- The pi `"stopping"`-record backstop (F3) and the flushMicrotasks poll-until helper (F4) — culled as theoretical / test-only.
