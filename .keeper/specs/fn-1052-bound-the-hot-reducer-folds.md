## Overview

Two folds hold the single-writer BEGIN IMMEDIATE lock for unbounded durations: the SubagentStart arm JSON-parses every still-unbound PreToolUse:Agent candidate for the session (avg 2.6s / max 27.6s), and the syncPlanLinks orphan path loads the whole commit_trailer_facts table plus every touching session's full plan history (documented 437s incident). Both are deterministic-replayed projections, so every bounding must be a pure optimization proven byte-identical under LIVE-fold semantics — which also means fixing the latent future-read divergence both reads carry today (no event-id ceiling).

## Quick commands

- `bun test test/reducer-links.test.ts test/subagent-invocations.test.ts test/refold-equivalence.test.ts test/reducer-lifecycle.test.ts`
- watch daemon stderr for `[fold-slow] SubagentStart` and `[pretufold-breakdown]` lines post-deploy — they should stop appearing

## Acceptance

- [ ] SubagentStart per-event cost no longer grows with a session's accumulated agent-call count; warm-vs-cold byte-equal proven
- [ ] The orphan syncPlanLinks path is structurally bounded (mechanism chosen from measurement, not assumption); the 437s class is closed
- [ ] Both reads carry an event-id ceiling; re-fold matches live-fold bytes over the affected arms, with new equivalence cases covering the orphan-last-touch and orphan-to-normal-transition scenarios
- [ ] No schema bump, no new RPC, no fold may throw; memos are pure optimizations that cold-rebuild byte-identically

## Early proof point

Task that proves the approach: `.1` — the parse-cache memo with warm-vs-cold byte-equality on the existing test template. If it fails: the parse cache degrades to caching only parse RESULTS keyed by event id with the live query untouched, which cannot change bytes by construction.

## References

- The exact memo template: gitAttribMemos (src/reducer.ts:1215-1456) with boot-seed warmer + __resetForTest + warm-vs-cold test (test/reducer-lifecycle.test.ts:2040-2119)
- The id-ceiling precedent: MonitorProvenanceMemo clamps to currentEventId-1 (src/reducer.ts:8722-8809); the commit-facts read must instead clamp INCLUSIVE of the current event
- commit_trailer_facts is append-only (INSERT OR IGNORE on event_id PK, no UPDATE/DELETE) — a watermark memo over it needs no invalidation story

## Docs gaps

- **README.md** (~3068-3076): orphan-path prose currently states the full cross-session sweep as permanent design — revise to the landed bound
- **README.md** (~2962 template): peer incident paragraphs for both folds (old O() class, mechanism, new invariant, validation)
- **README.md** (~734): [subagentfold-breakdown] diagnostics note

## Best practices

- **Per-key replace-merge bounds fan-out to O(local degree)** — the normal path already proves the shape in-repo
- **A watermark memo is projection-adjacent state, never a fold input** — cold start must reproduce the unbounded scan byte-for-byte
- **Never trust checkpointed state from a buggy-fold era** — if the ceiling fix changes re-fold bytes, the change is to re-fold (matching live history), never a wipe of live projections
