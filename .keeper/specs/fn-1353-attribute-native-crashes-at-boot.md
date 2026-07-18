## Overview

Native runtime crashes kill keeperd before fatalExit can record a cause,
leaving boots that end with no attribution while the platform's own crash
report lands in DiagnosticReports — late, throttled during loops, and
eventually pruned. This epic implements ADR 0089: the successor boot runs
a bounded, best-effort scan with delayed re-probes, backfills attribution
onto any unattributed boot in the ledger window as enrich-line fields,
and mints a cause-based repeated-native-crash distress that catches
slow-bleed crashes the rate-based crash-loop row structurally misses.

## Quick commands

- `bun test ./test/daemon.test.ts`
- `bun run typecheck`
- Operator post-deploy: after any native crash, `tail ~/.local/state/keeper/restart-ledger.json` shows the dead boot's enrich line carrying the crash class; two attributed boots in the window surface the distress in `keeper status`.

## Acceptance

- [ ] A boot whose matching crash report exists (at boot or within the re-probe window) gains a boot_id-matched enrich attribution; exhausted probes record the explicit no-report marker.
- [ ] Two or more native-attributed boots in the decision window mint the repeated-native-crash distress row; it survives orphan GC and level-clears when the window drains.
- [ ] The scan is bounded, throw-safe, platform-gated, and never alters restart verdicts or boot lines.

## Early proof point

Task that proves the approach: ordinal 1 (the pure match/decide seams
against synthetic listings). If enrich-field threading through the
compact projection proves disruptive: carry attribution in collapse only
and have the distress decision read the collapsed view directly.

## References

- docs/adr/0089-native-crash-attribution.md — the recorded contract (refines 0081/0030)
- docs/adr/0081, docs/adr/0030 — the ledger append-only and no-guessing invariants this refines
- Witness log: ~/docs/keeper-review-remediation.md (three attributed deaths in one day; the 34-minute spacing that defeats the rate row)

## Docs gaps

- **docs/problem-codes.md**: add the repeated-native-crash row to the producer-owned distress table with a one-line crash-loop cross-reference (task deliverable)
- **CONTEXT.md**: qualified "Native-crash attribution" entry — bare "attribution" is an Avoid synonym elsewhere (task deliverable)

## Best practices

- **Parse .ips as two JSON objects, gate on the crash bug_type, prefilter by filename** — the directory mixes stackshots/spins/jetsam [macOS crash-report canon]
- **Reports arrive late and throttle during loops** — boot-only scans miss the triggering crash; per-crash report counting never fires in a real loop [ReportCrash semantics]
- **pid alone never matches** — pids recycle; pair pid with launch-time within tolerance [process-identity canon]
- **The ledger is the durable record; .ips files are ephemeral evidence** [retention semantics]
