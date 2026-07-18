## Description

**Size:** M
**Files:** src/daemon.ts, src/restart-ledger.ts, src/dispatch-failure-key.ts, src/crash-report-scan.ts, test/daemon.test.ts, test/restart-cli.test.ts, docs/problem-codes.md, CONTEXT.md

### Approach

Implement ADR 0089 producer-side; the ledger stays a sidecar, never a
fold input. (1) New dep-free leaf `src/crash-report-scan.ts`
(node:* only, proc-starttime model): pure functions that take an
injectable directory path plus the ledger's boot-identity window and
return match verdicts — filename prefilter (process prefix +
timestamp), header/body two-object parse tolerant of duplicate keys,
bug_type crash gate, candidate-key field resolution, size-bounded
reads with caps on files inspected, total bytes, and time budget.
Match tuple per the ADR: report pid equals the boot row's pid AND
launch-time matches start_time within a small tolerance across the two
formats (write the cross-format comparator: the darwin ctime string to
epoch vs the report's launch representation), crash time inside the
boot's lifetime window; process path confirms when present, optional
when absent. (2) Boot integration in startDaemon after admission,
wrapped best-effort like the crash-loop block: scan once, then a
supervisor-owned timer re-probes a few times over ~90s (cleared on
shutdown, mirroring the git-seed watchdog ownership), re-running both
attribution and the distress decision each probe; backfill ANY
unattributed boot in the compact/decision window (predecessor is
collapse.at(-2) after this boot's append — mind the off-by-one);
idempotent (skip already-attributed boots, at most one attribution
append per boot_id); record the explicit no-report marker when probes
exhaust. Platform-gated no-op off Darwin; scan only the USER
DiagnosticReports dir; a new env var sandboxes the directory and joins
the sandboxEnv state-class list. (3) Ledger schema: optional fields on
the existing enrich kind (crash class: signal/exception/faulting
image; report identity; no-report marker; died-at when derivable) —
thread through parseRestartLedgerLine (which must accept enrich lines
without a reason), collapseRestartLedger (per-field merge: a line
only overwrites fields it carries, so a fatalExit reason and a native
attribution coexist on one boot_id), and compactRestartLedger (the
read-side projection must re-emit attribution fields or the decision
cannot see them). Boot lines untouched; restart verdicts and
cli/restart boot-identity reads must be provably unaffected.
(4) Distress: REPEATED_NATIVE_CRASH constants + predicate in
dispatch-failure-key.ts, display rule prefix-disjoint from existing
reasons, orphan-GC exemption in gcUnretryableDispatchFailures, and a
read→decide→mint-if-absent→level-clear block beside the crash-loop
one: mint when the windowed ledger view holds two or more
native-attributed boots, clear when it drains below two — deliberately
independent of and coexisting with daemon-crash-loop. Untrusted
report text is size-bounded before it reaches the ledger or event
data and never reaches a subprocess.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:7998-8045 — startDaemon boot sequence (boot-id mint, appendDurableRestartBoot; the hook point and the at(-2) predecessor subtlety)
- src/daemon.ts:9666-9719 — the crash-loop read→decide→mint→clear template; :11412-11450 mintCrashLoopDistress; :15247-15266 fatalExit's enrich append (the sibling); :609-656 the orphan-GC exemption list and its doc
- src/restart-ledger.ts:88 boundRestartReason; :125-134 parseRestartLedgerLine (rejects unknown kinds AND enrich-without-reason today); :211-258 collapseRestartLedger (unconditional reason overwrite to fix); :261-291 compactRestartLedger (re-emits only known fields); :293-318 foldBootIntoRestartLedger (window math); :435 appendRestartLedgerLine
- src/dispatch-failure-key.ts:158-160 crash-loop constants; :627 display rules (prefix-disjointness)
- src/seed-sweep.ts:99-130 — readOsStartTime and the darwin ctime format the comparator must parse
- cli/restart.ts:298-322 — boot-line-only reads that must stay unaffected
- test/daemon.test.ts:598,656 — the GC-exemption EXEMPT/DRAIN matrix to extend

**Optional** (reference as needed):
- src/proc-starttime.ts — the dep-free leaf model; src/provider-leg-death-notice.ts:263 — signal-name mapping precedent
- docs/adr/0089-native-crash-attribution.md — true up if implementation details shift
- docs/problem-codes.md:451-460 — the producer-owned distress table to extend

### Risks

- The compact projection silently dropping attribution fields is the classic failure — the distress decision must read a view that provably carries them; assert it in a test.
- The two-format launch-time comparator is the match key's weakest link: cover exact, skewed-within-tolerance, and out-of-tolerance cases, plus the pid-recycle rejection (pid matches, launch time does not).
- Duplicate enrich appends across boots (append-only cannot overwrite) — idempotency reads the ledger before appending.
- The re-probe timer must never outlive shutdown or block boot; all scan failures degrade to stderr, never a throw.
- ReportCrash throttling means loops produce fewer reports than crashes — tests must show the distress firing from ledger attributions without one report per crash.

### Test notes

Pure seams only: synthetic directory listings + boot windows drive the
scan/match functions; ledger round-trip tests cover parse/collapse/
compact with mixed reason+attribution enrich lines and the
per-field merge; the distress decide function is truth-tabled like
decideCrashLoop; the GC matrix gains the EXEMPT row. Sandbox
KEEPER_RESTART_LEDGER and the new reports-dir env in tmpdirs. Named
gates: `bun test ./test/daemon.test.ts ./test/restart-cli.test.ts`
plus `bun run typecheck`.

## Acceptance

- [ ] A synthetic crash report matching a dead boot's pid and launch time within tolerance, with crash time inside its lifetime, yields exactly one boot_id-matched enrich attribution carrying the crash class; pid-only or out-of-tolerance candidates never match; an absent process path degrades to a match, not a drop.
- [ ] Exhausted probes append the explicit no-report marker once; already-attributed boots are skipped on every later scan; backfill attributes any unattributed boot in the decision window, not only the immediate predecessor.
- [ ] Enrich lines without a reason parse; a fatalExit reason and a native attribution coexist on one boot id without clobbering; the projection feeding the distress decision provably carries attribution fields; boot lines and restart-verdict reads are unchanged.
- [ ] Two native-attributed boots in the window mint the repeated-native-crash distress exactly once; it is orphan-GC exempt, level-clears when the window drains, and coexists with the rate-based crash-loop row in tests.
- [ ] The scan is platform-gated, bounded (files, bytes, time), throw-safe out of boot, and its directory is sandboxed via the new env var in real-state tests.
- [ ] problem-codes.md carries the new distress row; CONTEXT.md carries the qualified glossary term; the recorded ADR matches shipped behavior.
- [ ] Focused named gates plus typecheck are green.

## Done summary
Added a dep-free Darwin crash-report scan matching DiagnosticReports .ips files to dead restart-ledger boots by pid and launch-time tolerance, with a bounded boot-time scan plus supervisor-owned ~90s re-probe timer; threaded native-crash enrich fields through parse/collapse/compact so a fatalExit reason and a native attribution coexist per boot; and added the repeated-native-crash distress (mint at 2+ attributed boots, orphan-GC exempt, level-clears on drain, coexists with daemon-crash-loop). Documented in problem-codes.md and CONTEXT.md.
## Evidence
