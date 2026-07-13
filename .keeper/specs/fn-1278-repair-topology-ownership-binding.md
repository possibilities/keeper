## Overview

A managed tmux pane can be observed before its Harness job reaches the jobs projection. The control worker then has no ownership to attach, and a later SessionStart is invisible when the physical tmux topology stays unchanged, leaving the live job without a Generation and permanently outside fail-closed cleanup. Reconcile DB-only ownership changes through the topology producer so every live exact pane/job binding converges without weakening autoclose policy or pane-recycle safety.

## Quick commands

- `bun test test/tmux-focus-derive.test.ts test/tmux-control-worker.test.ts test/reducer-projections.test.ts test/restore-set.test.ts`
- `bun test`

## Acceptance

- [ ] A pane observed before its job exists is re-emitted with ownership after the job commits, even when the physical tmux topology does not change.
- [ ] The later attributed topology event gives the live matching job a non-null canonical Generation, removing Generation absence as a permanent autoclose exclusion.
- [ ] Connected reconciliation coalesces DB write bursts, loses no wake during initialization or an in-flight refresh, and stays bounded below the autoclose grace.
- [ ] Ambiguous ownership, malformed or degraded observations, absent panes, terminal jobs, and cross-Generation pane reuse remain fail-closed.
- [ ] The topology, control-worker, fold, restore, and root fast suites pass without real tmux, subprocesses, Workers, sockets, or fixed sleeps.

## Early proof point

Task that proves the approach: task 1. If connected DB-change reconciliation cannot compose safely with the control stream, retain the same ownership-sensitive dedup contract and drive a bounded unresolved-job refresh through the existing serialized control reread seam.

## References

- `docs/adr/0013-canonical-generation-identity.md`
- `src/tmux-control-worker.ts`
- `src/tmux-focus-derive.ts`
- tmux control-mode protocol: https://github.com/tmux/tmux/wiki/Control-Mode

## Best practices

- **Snapshot plus ordered reconciliation:** install complete topology snapshots atomically and coalesce refresh requests without suppressing ownership transitions. [tmux control-mode protocol]
- **Stable identity:** correlate by canonical Generation and `%pane` identity, never titles, indices, process text, or wall-clock ordering. [tmux(1)]
- **Deterministic race proof:** script the exact ordering with barriers and injected seams rather than timing sleeps.
