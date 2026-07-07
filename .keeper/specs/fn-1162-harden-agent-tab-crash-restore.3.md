## Description

**Size:** M
**Files:** src/restore-set.ts, src/tabs-core.ts, src/restore-worker.ts, docs/adr/, test/restore-set.test.ts, test/tabs.test.ts, test/restore-worker.test.ts

### Approach

Selection offers the generation that just died. Consolidate the duplicated auto-pick (restore-set's topology deriver and tabs-core's selection mirror) into one exported selection function in restore-set.ts that both consume — the two surfaces must be structurally incapable of drifting. Flip the pick to recency-first: newest eligible dead generation wins (eligibility unchanged: non-degenerate, restorable > 0, inside the idle cutoff, newest-5 decode bound); restorable count becomes display metadata. Redefine `ambiguous` for recency-first semantics: the pick is contested when an older in-window generation is substantially richer than the newest pick (threshold shape chosen with tests) — preserving the escalate-or-refuse contract for genuinely contested states. Generation identity becomes keeper-owned: one exported builder is the sole producer of generation-id strings, used by every emitter (restore-worker probe pulse, topology snapshot emitters), plus a read-time canonicalizer so a probe-format change can never fork one server boot into two competing generations; legacy bare-pid ids alias where derivable and otherwise age out of the decode window. Record the decision as a new ADR (MADR style like docs/adr/0009; pick the next unused number deliberately — numbering collides at 0007/0008/0011): context is the observed boot-split, decision is single-builder + read-time canonicalization, consequence is aliasing/age-out for legacy rows.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/restore-set.ts:791-853 — deriveLastGenerationSetFromTopology auto-pick + ambiguous computation
- src/tabs-core.ts:505-573 — selectRestoreGeneration mirror (docstrings promise identical computation)
- src/restore-worker.ts:766-842 — hashGenerationId + backendExecStartPulse (the boundary mint to fold the canonical builder into)
- src/restore-set.ts:258-312 — GENERATION_SUMMARY_SQL + the v107 tmux_generation_id generated column

**Optional** (reference as needed):
- src/tabs-core.ts:445-461 — defaultProbeGeneration (`#{pid}:#{start_time}` probe)
- docs/adr/0009-tmux-owned-usage-scrape-driver.md — MADR exemplar
- test/restore-set.test.ts:92 — seedJob fixture helpers carrying backend_exec_generation_id

### Risks

- The ambiguous redefinition changes picker-trigger frequency — tests must pin both the common case (just-killed wins silently) and the contested case.
- Canonicalizing at read time must not break the v107 generated-column index path (keep grouping on the stored column; canonicalize when grouping results).

### Test notes

Seed two dead generations: just-killed with N restorable and 2-day-old with M > N — auto-pick must be the newest, contested flag per threshold. Alias test: bare `21705` and `21705:1783191303` group as one boot. EXPLAIN assertion for the index stays green.

## Acceptance

- [ ] With a just-killed generation and an older richer one both in-window, the auto-pick is the just-killed one; the richer one is reachable only through the ambiguous escalation.
- [ ] The list view and the restore offer compute from one exported selection function — no duplicated comparator remains.
- [ ] One server boot observed under two probe formats reads as one generation (canonicalizer test), and a future format change cannot fork identity.
- [ ] An ADR records the canonical generation-identity decision.

## Done summary
Consolidated the generation auto-pick into one exported selectGenerationFromEnriched consumed by both the deriver and list view, flipped it to recency-first (newest eligible wins; older-substantially-richer flags ambiguous), and made generation identity keeper-owned via a single buildGenerationId producer plus a read-time canonicalizer that folds a boot seen under two probe formats into one. Recorded ADR 0013.
## Evidence
