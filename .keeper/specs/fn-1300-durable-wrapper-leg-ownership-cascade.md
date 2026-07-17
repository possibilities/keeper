## Overview

Give every wrapped Provider leg a durable owner — the exact wrapper Dispatch attempt that launched it — and make the daemon the single, safe actuator that tears owned legs down when their owner goes terminal or is superseded, releasing exactly that attempt's claims afterward. Ends the era of orphaned paid legs, title-inference teardown, and peer process kills over stuck claims. The full decision record is ADR 0071; this epic implements it.

## Quick commands

- `bun test ./test/provider-leg-ownership.test.ts ./test/provider-leg-cascade.test.ts` — the new suites green
- `keeper query dispatch_claims --json | jq '.data | length'` — after a wrapped worker is killed mid-task, its claims release without operator action

## Acceptance

- [ ] A wrapped Provider-leg birth without a valid owner tuple aborts before any paid process spawns
- [ ] Killing a wrapper mid-task leads, without operator action, to its legs' identity-rechecked termination, folded exit confirmation, and exact-tuple claim release
- [ ] A superseded-but-alive wrapper's legs cascade or transfer; no task double-pays two concurrent legs
- [ ] Unknown identity or unconfirmed KILL surfaces as a page-once sticky and never releases claims
- [ ] Legacy ownerless births remain on the old autoclose path, counted as a display-only drain gauge, untouched by the cascade
- [ ] Deterministic re-fold equivalence holds across the new schema step

## Early proof point

Task 1 (ordinal 1) proves the schema + projection + fold layer with refold equivalence. If it fails: re-scope the projections per ADR 0071's field lists before any producer work.

## References

- docs/adr/0071-durable-wrapper-leg-ownership-and-terminal-cascade.md — the contract this epic implements
- docs/adr/0056, 0069, 0070 — the authorities 0071 supersedes/extends
- Scout dossier (planning): all four scout reports + gap analysis were completed pre-scaffold; key reuse surfaces are cited per-task

## Docs gaps

- **docs/adr/0056-wrapped-provider-leg-window-lifecycle.md**: revise — owned-leg teardown authority moves to the cascade; bucket stays legacy-only
- **docs/adr/0069-provider-leg-death-notices-and-honest-waits.md**: replace the durable-ownership placeholder with a pointer to 0071
- **docs/install.md**: cleanup description — ownership proof + exact claim release now gate teardown
- **docs/problem-codes.md**: add cascade sticky reason codes (identity-unknown, kill-unconfirmed, promotion-failed)

## Best practices

- **Exact-incarnation preconditions on destructive ops:** delete/kill only the freshly-read identity (K8s UID-precondition pattern)
- **Finalizer discipline:** cleanup obligation registered before the external resource exists; blocked cleanup stays visible, retries idempotently
- **Signal-sent is not exited:** release keys on folded exit observation, never syscall return
- **Bounded staged shutdown:** TERM → bounded grace → KILL → bounded confirm, deadlines stored durably, never restarted by a daemon reboot

## Rollout

Two stages by protocol cohort: (1) additive schema + projections + owner stamping land inert; (2) fail-closed enforcement + shim gate + cascade + autoclose carve-out activate for the new cohort. Legacy drains to zero (query-verified), then its compatibility path is removed in a later epic. Rollback within the epic = disabling stage-2 enforcement; the additive schema stays.
