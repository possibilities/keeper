## Overview

Fix the three verified live defects from the 2026-06-09 server deep review (Tier 1
items 1-3, full evidence: ~/docs/keeper-reliability/2026-06-09-server-deep-review.md):
(1) the post-fn-756 v13 approval FS backfill that rewrites committed `.planctl` epic
files on every keeperd boot, (2) the plan-worker fork storm (in-HEAD `git cat-file`
probe before the change-gate) that starves the realtime plan pipeline to ~227s
staleness, and (3) the transcript-worker 60s heartbeat re-reading ~733MB/min of
unchanged transcripts. Defects 2+3 explain most of keeperd's 27-45% steady-state CPU.
End state: boot never mutates `.planctl` trees, the plan pipeline is realtime again
(heartbeat rescue rate ~0), and steady-state CPU drops to single digits. All three
fixes are producer/boot-side — no reducer change, no schema bump, no keeper-py change.

## Quick commands

- `bun test --parallel --timeout=30000` — full suite green
- `git -C ~/code/keeper status --porcelain .planctl` after a keeperd restart — empty (boot no longer dirties planctl trees; spot-check another watched planctl repo too)
- `bun run scripts/backstop-stats.ts` — plan-heartbeat rescue rate trending to ~0 (was 50% at p50 228s staleness)
- `ps -o %cpu= -p $(pgrep -fl keeperd | awk '{print $1}' | head -1)` — steady-state CPU in single digits after a few minutes of multi-agent load

## Acceptance

- [ ] keeperd boot leaves every `.planctl` tree byte-identical; the v13 approval FS backfill (both passes) is deleted, not gated
- [ ] plan-worker runs the fn-629 in-HEAD probe ONLY on changed/first-seen snapshots; unchanged re-scans fork zero `git cat-file` processes; fn-629/fn-627 gate semantics preserved exactly (pending paths still probe, gated paths never touch `lastEmitted`/`pathToId`)
- [ ] transcript heartbeat skips unchanged files via a per-path {size, mtimeMs} memo separate from `pathState`; fn-720 rescued accounting unchanged
- [ ] no reducer / schema / keeper-py changes anywhere in the diff

## Early proof point

Task that proves the approach: task 2 (the gate reorder). Its spy-on-isTracked tests
must pass without touching the gated-path bookkeeping invariants (plan-worker.ts:1447-1469
doc block). If they cannot: stop and re-derive the ordering against the fn-629/fn-712
specs rather than weakening the gate.

## References

- ~/docs/keeper-reliability/2026-06-09-server-deep-review.md — the deep-review report (Tier 1 items 1-3 are this epic)
- .planctl/specs/fn-629-*.md, fn-712-*.md, fn-737-*.md — the in-HEAD gate, the batched pending drain, and the fold-latency-tail evidence the reorder must respect
- .planctl/specs/fn-720-*.md — backstop-telemetry contract (rescued accounting must survive both perf fixes)
- fn-756 (schema v63) — stripped the approval surface; the reason defect 1 is a regression engine
- Decision record (gap analysis): delete-not-gate for the v13 FS backfill (a post-openDb version read always sees 63 — a naive gate is a silent no-op; and post-fn-756 the approval field has zero consumers, so backfill serves nothing even on a real v12 DB)

## Docs gaps

- **README.md ~1222-1235**: fn-629 gate prose — revise to change-gate-first (probe fires only on changed snapshots) [task 2]
- **README.md ~1194-1209**: transcript producer — add one sentence on the heartbeat size/mtime memo [task 3]
- **README.md / CLAUDE.md approval-ladder prose** (~116, ~181-191, ~225-229, ~264-266 + "Plans are READ-ONLY except approval" section): stale post-fn-756 — DEFERRED to the upcoming fn-756-residue-sweep epic, not this one

## Best practices

- **Never write back to files you also watch:** FSEvents has no self-exemption; the deleted backfill was a boot-time self-fire into the plan-worker's own watch tree
- **Gate subprocess I/O behind cheap in-process state:** macOS spawn cost is ~2-5ms (fork+exec+dyld+codesign); the in-memory change-gate compare is nanoseconds
- **Use mtimeMs (sub-second float), gate on size first:** APFS stores ns, Bun returns ms float; whole-second truncation false-skips same-second appends
- **Memo writes only after successful stat AND successful scan:** a transient EACCES must never poison the memo into permanently suppressing a file
- **In-memory memo only:** persisting it risks permanently suppressing rescues after rotation; an empty memo on restart just means one full re-scan (safe)
