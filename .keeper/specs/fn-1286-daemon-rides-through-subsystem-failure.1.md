## Description

**Size:** M
**Files:** src/daemon.ts, src/backup.ts, src/integrity-probe.ts, src/maintenance-worker.ts, src/dispatch-failure-key.ts, docs/problem-codes.md, test/daemon.test.ts

### Approach

Operator paging shells out to the external `botctl` binary from 8+ copy-pasted spawn sites, each swallowing spawn failure as a logged "(non-fatal)" — when the binary is absent, `human_notified_at` stays NULL forever and nothing surfaces that paging itself is down. Consolidate the daemon's page spawns into one helper that captures the spawn/exit outcome and preserves the existing contract exactly: a failed page returns `notify_failed`, never stamps `human_notified_at`, and the row re-sweeps (a page is never lost). New behavior: when the failure is permanent-absence-shaped (spawn throw / ENOENT — not a transient non-zero exit, which would mint noise every sweep), mint one idempotent, level-triggered paging-channel-down distress row (new key in the dispatch-failure-key vocabulary) that level-clears on the next successful page. The non-daemon best-effort sinks (backup, integrity-probe, maintenance-worker) adopt the helper where it drops in cheaply but keep their fail-open shape; the daemon page-once sweeps are the required scope.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (daemon.ts is ~14.5k lines and fn-1282 is deleting regions of it).*

**Required** (read before coding):
- src/daemon.ts:12671-12695 — notifyHumanOfSharedCheckout: the canonical swallow (spawn throw → "(non-fatal)" log → notify_failed)
- src/daemon.ts:12718-12738 — notifyHumanOfRepair: sibling spawn, same defect
- src/daemon.ts:2346-2375 — runSharedCheckoutPageSweep: the pure page-once sweep with injected notifyHuman/mintNotified — the seam tests pin
- src/dispatch-failure-key.ts — the single distress-key vocabulary; add the paging-down key here, not inline
- src/daemon.ts:494-496 — producer-owned rows exempt from retry_dispatch clears (the new row is producer-owned, positive level-clear only)

**Optional** (reference as needed):
- src/daemon.ts:11698, 11967, 12267 — the remaining daemon botctl spawn sites
- src/backup.ts:103-117, src/integrity-probe.ts:197-225, src/maintenance-worker.ts:41-48 — non-dispatch_failures best-effort sinks
- docs/problem-codes.md — pipe-table format for the new code row

### Risks

- The `notify_failed` re-sweep contract is load-bearing: stamping `human_notified_at` on any failure path permanently silences a real page. The helper must be provably conservative here.
- maintenance-worker runs on a worker thread — if its sink adopts the helper, the distress mint must relay through main (workers never write keeper.db).

### Test notes

Truth-table the helper's outcome classification (spawn-throw/ENOENT → permanent, non-zero exit → transient, zero → notified) as a pure seam; assert notify_failed never stamps; assert the meta-distress mints once (idempotent) and level-clears on a subsequent success. Register any new test file with the fn-1281 named test:gate manifest — the gate fails closed on undiscovered suites. No real botctl spawn in the fast tier — inject the spawn outcome.

## Acceptance

- [ ] A page spawn failure caused by a missing pager binary mints exactly one visible paging-channel-down distress row, which level-clears on the next successful page.
- [ ] A failed page never stamps the target row's human_notified_at; the page re-sweeps and eventually lands when the channel recovers.
- [ ] The daemon's page spawn sites route through one shared helper with captured outcomes; no page path swallows a spawn failure silently.
- [ ] The touched suites and the named deterministic gate pass.

## Done summary

## Evidence
