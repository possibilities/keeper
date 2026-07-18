# 0089 — Native-crash attribution at boot

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Refines
ADR 0081 (durable boot identity and stable restart verdict) and ADR 0030
(restart provenance): the "platform evidence remains explicitly unattributed;
the producer never guesses a cause" stance gains one sanctioned, evidence-only
exception — a crash report the platform itself wrote for the dead boot.

## Context

Native runtime crashes kill the daemon before `fatalExit` can write its enrich
line, so the ledger records only that a boot ended. The runtime prints a crash
banner whose panic body truncates in the captured stderr, while the complete
report lands in the per-user DiagnosticReports directory as an `.ips` file —
written by the platform seconds to minutes after the fault, throttled entirely
during rapid crash loops, and auto-pruned later. Repeated spaced-out segfaults
therefore stay invisible to the rate-based crash-loop distress: boots that die
half an hour apart never trip an eight-young-boots window, and the operator
learns of a crashing runtime only by hand-correlating report files.

## Decision

The successor boot attributes native crashes from platform-written evidence,
producer-side, into the append-only restart ledger — never a fold input.

- **Bounded scan with delayed re-probes.** After admission, a best-effort scan
  of the user DiagnosticReports directory runs, then a supervisor-owned timer
  re-probes a few times over the first ninety seconds before recording the
  no-report outcome — the report for the crash that triggered this boot is
  the one most likely not yet written. The scan prefilters by filename
  (process prefix and timestamp), gates on the crash `bug_type`, caps files
  inspected, bytes read, and time spent, and treats report content as
  untrusted text: size-bounded extraction, no report string ever reaches a
  subprocess. The scan never throws out of boot; on non-Darwin hosts it is a
  clean no-op, and core-dump attribution is out of scope.
- **Backfill over the compact window.** Each scan attributes ANY recent
  unattributed boot in the ledger's decision window, not only the immediate
  predecessor — write latency and throttling mean the boot that can stamp an
  attribution is rarely the boot whose crash it describes. Already-attributed
  boots are skipped; the ledger, not the ephemeral report directory, is the
  durable record.
- **Match key.** A report attributes a boot when the report pid equals the
  boot row's recorded pid AND the report's process-launch time matches the
  row's recorded start time within a small tolerance across their two
  formats; the crash time must fall inside that boot's lifetime window. The
  process path confirms when present and degrades to optional when absent or
  redacted — pid alone never suffices (pids recycle).
- **Enrich-line schema.** Attribution rides optional fields on the existing
  enrich line kind, matched to the dead boot's id: crash class (signal,
  exception type, faulting image), report identity, and an explicit
  no-report-found marker when probes exhaust — "looked and found nothing" is
  distinct from "never looked". The parser accepts enrich lines without a
  reason; collapse merges per-field so a fatalExit reason and a native
  attribution coexist on one boot id without clobbering, and the compact
  read-side projection carries the attribution fields so decisions can read
  them. Boot lines are untouched; restart verdicts never read enrich-borne
  data.
- **Repeated-native-crash distress.** A `daemon`-verb sticky row mints when
  the windowed ledger view carries two or more native-attributed boots, and
  level-clears when the window drains below that — a cause signal that fires
  on slow-bleed crashes, deliberately independent of and coexisting with the
  rate-based crash-loop row. Registration is complete or the row cannot
  survive: key constants and predicate, display rule, orphan-GC exemption,
  and the boot-block mint/clear.

## Consequences

- A crashing runtime is loud even when crashes are spaced or reports are
  throttled: the ledger accumulates attributions as evidence arrives, and the
  distress fires on the durable record rather than on ephemeral files.
- ADR 0081's no-guessing stance is preserved in substance: attribution only
  ever restates what the platform recorded, and absent evidence stays
  explicitly unattributed via the no-report marker.
- The report format is private and churns across macOS releases; parsing is
  candidate-key tolerant and degrades to partial attribution, never a boot
  failure. Report auto-pruning bounds how far back backfill can reach, and
  the scan directory is injectable so tests never read host crash reports.
