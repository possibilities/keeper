## Description

The 2.4GB events store (1.57M rows, ~780K still carrying 1.2GB of cold
bodies) makes every periodic maintenance pass — retention shed, cold-history
compaction, mutation_path backfill — a multi-minute main-thread grind. That
grind starves message-driven ingest applies and the RPC surface, trips the
serve-liveness watchdog's busy-lag detector in steady state, and turns each
watchdog recycle into collateral damage (orphaned live workers, larger
catchup backlog for the successor boot). This epic makes main-thread
maintenance time-budgeted, drains the cold-body backlog under that budget,
and gives operators first-class visibility into ingest lag and breach-time
causes.

Serializes with the daemon.ts collision group (fn-1386, fn-1352 carry
protective dep edges behind this epic).

## Acceptance

- No single main-loop tick holds the event loop past the serve-lag
  threshold on account of maintenance work; the cold-body backlog drains to
  the retention watermark; status surfaces ingest lag; a lag-breach streak
  logs its cause.

## Done summary

## Evidence
