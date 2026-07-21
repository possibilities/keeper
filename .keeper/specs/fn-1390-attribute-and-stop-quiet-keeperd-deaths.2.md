## Description

Extend the enrich probe to consult OS-level evidence for the dead pid
(unified log jetsam/memory-pressure records inside the boot's lifetime
window) and to record a typed verdict enum instead of an empty reason.
Sample main RSS into the periodic serve-health report so a
memory-growth death leaves a visible ramp in the last reports before
the end, then run the forensic pass over the four recorded quiet ends
and write the per-end verdicts.

## Acceptance

- The enrich row for a daemon end carries a typed verdict (one of
  watchdog / operator / soft-exit-leaf / os-memory-kill / signal /
  no-evidence) with the supporting probe output bounded inline; tests
  cover the classifier over fixture probe outputs.
- serve-health reports carry main RSS; the ledger keeps the last N
  reports' RSS values accessible for the enrich pass.
- The four historical quiet ends each have a written verdict in the
  epic Done summary, including ruling the 73a71722e serve-path change
  and #88 starvation in or out for the afternoon pair.

## Done summary
Extended the enrich probe with a typed exit verdict (watchdog/operator/soft-exit-leaf/os-memory-kill/signal/no-evidence) backed by a bounded async unified-log jetsam probe and install.sh's operator-reload attribution leaf, plus main-RSS history persisted every serve-health tick for the enrich pass. Classifier tested against fixture leaf/native-crash/operator/jetsam inputs.

Forensic pass on the four recorded 07-20 quiet ends (EDT):
1. boot 272f1b94 (pid 13095, died ~04:50:32) -> OPERATOR: install.sh reload (plist FSEvent 2.4s before the successor boot, the confirmed reload signature).
2. boot b1856fa0 (pid 92251, died ~08:14:54) -> OPERATOR: install.sh reload (same FSEvent signature, ~2s before successor).
3. boot 27a0b574 (pid 53298, died ~16:15:25, 31.2min runtime) -> OPERATOR: install.sh reload (full unified-log chain: "Setting service ... enabled (initiated by launchctl<-bash<-python3.14)" then plist FSEvent then "removing service", 2s before death).
4. boot bb356594 (pid 56332, died ~16:21:46, 6.35min runtime) -> NO-EVIDENCE, genuinely unattributed. Ruled out: native crash report (probe exhausted, no match), OS-level jetsam/memory-pressure kill (unified-log scan of the full lifetime window: zero matches), operator reload (no plist FSEvent or leaf timestamp in-window), watchdog (no fatalExit reason recorded). Per epic requirement, also ruled out: 73a71722e (status: stop walking the events b-tree for event_count, landed 15:43:45, rode both afternoon boots) -- inspection shows the diff only deletes a try/catched COUNT(*) query and substitutes an already-computed value, adding no new throwable path, and is load-reducing; and #88 main-thread ingest-starvation (~/docs/keeper-phase2-backlog.md) -- its signature (TERM-unresponsive SIGKILL escalation, rpc_unreachable, dark boot) is a MORNING-only phenomenon (~08:44-10:12 EDT) whose fixes (33ad317a2 @ 12:04, 07dddd86a @ 13:38) landed hours before this afternoon pair, and bb356594's window shows none of its symptoms. Best remaining read (unconfirmable): a soft exit predating this epic's exit-attribution leaf instrumentation (landed 20:07:40, after all four deaths) on a boot freshly reloaded by #3's install.sh run -- no forensic trace survives past the bare boot row. A repeat of this shape now carries a leaf, an OS-memory verdict, or an operator match.

Tally: 3/4 operator (install.sh reload), 1/4 no-evidence after exhausting every available forensic source, with both of the epic's named suspects explicitly ruled out for the unattributed one.
## Evidence
- Commits: c53d7502bf2a2b2b9d05f099a7e1d6867c660de1