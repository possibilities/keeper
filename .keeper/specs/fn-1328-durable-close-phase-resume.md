## Overview

A close retry re-runs the whole expensive three-agent pipeline even when the prior
closer already persisted every phase artifact and only `close-finalize` failed
transiently. This epic makes the closer resume at the first unfinished durable
phase: `close-preflight` gains a deterministic validator that grades each phase's
persisted artifacts against the fresh lane-aware commit-set hash and emits a
content-blind resume signal the closer skill switches on — mirroring the existing
`blocking_followup` short-circuit. A stale commit set invalidates the first stale
phase and everything downstream, degrading cleanly to a full re-audit.

## Quick commands

- cd plugins/plan && bun test ./test/saga-close-preflight.test.ts && bun test ./test/saga-close-finalize.test.ts
- cd plugins/plan && bun run test:gate

## Acceptance

- [ ] A redispatched close whose prior run persisted fresh report/verdict/follow-up/selection artifacts and failed only at finalize spawns zero new agents and finalizes exactly once
- [ ] A moved commit set (stale stamped hash) resumes as a full re-audit with no stale artifact trusted
- [ ] `findings=0` and `fatal` verdict branches resume identically to a fresh run (skipped phases graded not_needed, never re-spawned)
- [ ] The resume decision is verb-emitted typed data; the closer skill never reads `state/audits` artifacts

## Early proof point

Task ordinal 1 proves the approach: the preflight validator + envelope field with the
seeded all-fresh and stale scenarios green. If it fails: fall back to emitting only a
boolean skip-to-finalize signal for the evidence path (all phases fresh) and keep
full re-run for every partial state.

## References

- plugins/plan/skills/close/SKILL.md — five-phase saga; `blocking_followup` short-circuit is the resume-shaped precedent
- plugins/plan/src/verbs/close_preflight.ts:471-490 — envelope fold point; fresh hash at :360
- plugins/plan/src/verbs/close_finalize.ts:723-763 — STALE_ARTIFACTS + lane-aware hash note; MERGE_IN_PROGRESS origin :385-404 (follow-up scaffold refusal)
- plugins/plan/src/audit_artifacts.ts:251-265 — taskFindingCoversCommitSet (validator to mirror); computeCommitSetHash :294-308 (sole staleness key)
- Epic deps: none detected (fn-1325 / fn-1326 verified disjoint)

## Docs gaps

- **docs/adr/ (new record)**: durable close-phase artifacts + hash-gated resume decision; cross-reference ADR 0070, 0028, and the 0031→0055 lineage
- **CONTEXT.md**: one clustered glossary entry for the durable close-phase artifact / resume-gate term, disambiguated from Restore, Harness resume, and Resume cursor; avoid overloading "receipt"
- **CLAUDE.md**: at most one line only if close-retry semantics change what a retry re-runs; the mechanism lives in the ADR

## Best practices

- **Receipts record goal-achieved, not code-ran:** per-phase artifact + stamped input hash, re-validated on every resume — status flags alone never gate a skip [Azure/AWS saga guidance, Temporal]
- **Deterministic control plane:** the LLM obeys a verb-emitted resume decision, never computes skip/re-run from prose [arxiv 2508.02721]
- **Per-phase keys:** each phase validates by its own key (commit-set hash; the selection verdict by follow-up-doc input_hash), never one global flag
- **Close the check-to-use gap:** validate via the schema-gated reader and consume the same typed facts; artifacts are 0600 commit-free state
