## Description

Instrument every way keeperd main can end — fatalExit, uncaught
exception/rejection, received signals (TERM/INT/HUP), and normal
return — with one bounded, synchronously-flushed attribution line to a
dedicated exit-attribution leaf (not stderr, which loses tail writes on
abrupt ends). The restart ledger's enrich pass reads that leaf first
and records its verdict.

## Acceptance

- Signal handlers, the fatalExit path, and process-level
  uncaught/unhandled hooks each write one bounded attribution record
  with a synchronous flush before exit; a SIGKILL obviously cannot, and
  the enrich pass treats leaf-absent as "hard kill or SIGKILL" rather
  than empty.
- Deterministic tests drive each soft exit path in-process and assert
  the leaf's record shape; the enrich consumer's precedence (leaf >
  crash report > empty) is test-pinned.

## Done summary
Instrumented every keeperd main exit path (fatalExit, uncaught/unhandled hooks, TERM/INT/HUP signals) to synchronously write one bounded attribution record to a dedicated exit-attribution leaf before process end. The boot-time enrich pass reads that leaf first for the prior boot, falls back to native-crash-report matching, then a typed hard-kill-or-SIGKILL verdict when neither is available (never empty), writing at most once per un-attributed prior boot. Deterministic tests pin each soft exit path's leaf record shape and the leaf-over-crash-report-over-empty enrich precedence.
## Evidence
