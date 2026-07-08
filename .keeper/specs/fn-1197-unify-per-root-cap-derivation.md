## Overview

The effective per-root concurrency cap is derived inconsistently: the steady-state serve path floors the stored intent through `effectivePerRootCap`, but boot-time emission (and several read/latch seams) surface the stored value unfloored, so the observed effective cap oscillates 1↔2 on every daemon boot (reproduced repeatedly: each restart-ledger boot entry is followed by an autopilot-change delta flipping per_root). This epic routes every producer and consumer of the effective cap through the one derivation seam so boot and steady-state are byte-identical.

## Quick commands

- `bun test test/db.test.ts test/autopilot.test.ts test/status.test.ts test/watch.test.ts` — cap derivation + surface suites
- `keeper status --json | jq .data.autopilot` — post-deploy: value stable across a daemon bounce

## Acceptance

- [ ] Boot-time and steady-state derivations produce identical effective per-root values for identical {stored, worktree_mode} inputs
- [ ] Every serve/status/watch/boot surface reports the effective cap (stored intent remains readable where the schema already exposes it distinctly)
- [ ] A regression test pins the boot-vs-steady equality for both worktree modes

## Early proof point

Task that proves the approach: `.1`. If the boot header lacks worktree state at the client latch site: floor server-side before emit (old clients heal automatically) rather than widening the header.

## References

- src/db.ts effectivePerRootCap — the single intended seam (floor lives inside it)
- Commits 1e0c3928 (introduced worktree-mode gating) and f6440bab (re-applied the clobbered banner half) — this epic closes the remaining src-side half
- Incident evidence: repeated autopilot-change deltas {per_root 1→2, stored 2, worktree on} immediately after each daemon boot

## Docs gaps

- **CONTEXT.md** (Per-root cap entry): confirm the "derived at read time" wording still holds after the fix; revise for precision if the derivation site changes

## Best practices

- **One pure derive function both paths call** — floor/clamp inside it; never two literals that can drift [practice-scout]
- **Reconciler writes only when the canonical result differs** — never feed a derived value back as a fresh input (that feedback loop is the oscillation) [practice-scout]
