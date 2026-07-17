## Overview

Build the ADR 0073 smoke tier: one sandboxed, parent-deadline-owned executable that boots a real keeperd and proves the contracts fixtures structurally cannot — the served frame/probe contract, main's fatal path under a killed worker, and the restart CLI's evidence verdict — then wire it as a named slow gate required at close-finalize for epics touching the daemon Load surface.

## Quick commands

- `bun run test:slow-daemon` — the smoke gate green against a sandboxed keeperd

## Acceptance

- [ ] A sandboxed real keeperd boots, catches up, and its served steady-state and catch-up frame shapes are asserted as the probe contract
- [ ] Killing a real worker proves main's fatal path, bounded teardown, lock/socket cleanup, and the restart-ledger row
- [ ] The restart CLI's verdict runs end-to-end against the sandboxed daemon with only the launchctl seam injected
- [ ] The smoke runs behind its own named gate, required at close-finalize only for daemon load-surface epics, and never joins the correctness gates
- [ ] A hung scenario is killed by the parent deadline and reads as a bounded red, never a wedge

## Early proof point

Task 1 (ordinal 1) proves the harness: sandboxed boot, deadline ownership, and the frame-contract scenario. If it fails: re-examine whether keeperd can boot fully sandboxed before building scenarios atop it.

## References

- docs/adr/0073-sandboxed-real-daemon-smoke-tier.md — the contract this epic implements
- test/slow/commit-work-publication-realgit.test.ts + the test:slow-git gate — the existing slow-tier precedent to mirror

## Docs gaps

- **docs/testing.md**: document the new named slow gate and its finalize conditional
