## Overview

A wrapped capability model can never dispatch: the launch carries only the orchestrator session model (the task's capability model is not threaded), so the producer's host-matrix route probe classifies the wrong model, and the shared resolution seam's reject arm only chooses between rejection kinds — a routed wrapped candidate still mints worker-cell-invalid instead of resolving to its rendered cell dir. Thread the task's capability model onto the launch, and make the seam resolve a routed wrapped candidate to the host cell path (manifest and shadow checks still applying), so a wrapped cell dispatches with the same guard discipline as a native one.

## Quick commands

- `bun test test/worker-cell.test.ts test/autopilot-worker.test.ts test/dispatch-cli.test.ts` — seam, producer, and CLI parity suites
- With a fixture matrix serving a wrapped model whose cell is rendered: dispatch resolution returns the cell dir; with the manifest absent: worker-cell-missing with the regen hint; with no provider: worker-cell-no-route

## Acceptance

- [ ] A todo task carrying a host-matrix wrapped model dispatches with --plugin-dir pointing at its rendered workers cell, through both the autopilot producer and the manual dispatch CLI, while native-cell behavior and every existing sticky-reason pin stay byte-identical
