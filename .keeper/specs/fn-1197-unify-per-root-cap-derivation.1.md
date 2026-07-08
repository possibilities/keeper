## Description

**Size:** M
**Files:** src/collections.ts, src/readiness-client.ts, cli/status.ts, cli/watch.ts, src/server-worker.ts, test/db.test.ts, test/status.test.ts, test/watch.test.ts, test/readiness-client.test.ts

### Approach

Find every producer and consumer of `max_concurrent_per_root` that bypasses `effectivePerRootCap`, including whichever boot-time emission produced the observed post-boot effective=stored flip, and route them all through the one seam. The contract: identical {stored, worktree_mode} inputs yield an identical effective value on every surface, at boot and in steady state, with the floor living only inside the seam. Where a surface deliberately exposes the stored intent (e.g. a `_stored` wire field), keep the two clearly distinct — the bug class is conflating them. For the boot-status client latch: if worktree state is not available at the latch site, prefer flooring server-side before emit over widening the header (older clients then heal without a protocol change). Determine empirically which direction the observed oscillation was wrong in (boot=2 vs steady=1 under worktree-on) and pin the correct semantics with the seam's existing definition as authority.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:4521 — effectivePerRootCap, the seam; :4505 DEFAULT_MAX_CONCURRENT_PER_ROOT
- src/server-worker.ts:2082-2100 — the steady-state publisher (already floors; note its warning about omitting worktree_mode from the SELECT)
- src/readiness-client.ts:2249-2258 — fn-954 boot-status latch: latches boot.max_concurrent_per_root raw, no worktree consult
- src/collections.ts:734, cli/status.ts:363, cli/watch.ts:332 — suspect unfloored seams

**Optional** (reference as needed):
- src/readiness-inputs.ts:143, cli/board.ts:829 — examples that floor correctly
- src/daemon.ts:5990-6008 — set-autopilot-config mints the patch verbatim (stored intent) BY DESIGN; do not "fix" this seam

### Risks

- The boot-vs-steady disagreement direction is unconfirmed (which side is wrong under worktree-on); resolve from the seam definition before changing emission, not from the incident's surface reading.
- Version skew: a new viewer against a briefly-old daemon mid-upgrade must not mis-latch — keep the absent-field fallback semantics documented at the latch.

### Test notes

Regression: a pure test driving both the boot-emission path and the steady-state path with the same {stored, worktree_mode} pairs (both modes) asserting byte-identical effective values; extend the existing suites rather than minting a new file.

## Acceptance

- [ ] Boot-time and steady-state emission produce identical effective per-root values for identical {stored, worktree_mode} inputs, proven by a regression test covering both worktree modes
- [ ] No production code path reads the stored column as an effective value; all effective reads route through the derivation seam
- [ ] The stored intent stays distinctly readable on surfaces that already expose it
- [ ] keeper fast suite green

## Done summary

## Evidence
