## Description

**Size:** S
**Files:** docs/adr/0062-agent-surface-convergence-non-goals.md

### Approach

Write one ADR (provisional number 0062 — verify the next free number at execution time; fan-in renumbering per the ADR ladder convention) recording the agent-surface convergence decisions and non-goals: (1) the panel judge stays a Task subagent, never a `keeper agent` run — it is an in-context reducer over member answer files and the counterweight to same-family self-preference; promoting it would add a launch/window/transcript and lose in-context synthesis; (2) durability stays tiered — handoff briefs are event-sourced and size-bounded because parked delegates outlive restarts, while pair/panel runs are state-dir ephemeral; flattening ephemeral asks into the event log is a re-fold cost time-bomb; (3) the named skills stay intent presets — handoff forbids waiting by default on purpose, panel forces context isolation on purpose; no god-signature merge of the surfaces; (4) the shared contracts live in a keeper-local reference doc cited by the skills, not vendored corpus snippets — keeper operational specs do not belong in the general-engineering corpus and cross-repo re-vendoring per edit is the wrong loop; (5) launch-handle convergence is semantics-only — the three storage keys (partner names, handoff slugs, panel run identity) never merge because they anchor different durability tiers. Follow the house ADR structure (Status: Accepted with the provisional-number note, Context, Decision as numbered bold-led points, Consequences) and cross-reference the adjacent ADRs on launch triples, resume-by-name, handoff pinnability, and the described panel roster without editing them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/adr/0032-*.md and docs/adr/0033-*.md — the structural templates for a non-goals-shaped record
- docs/adr/ directory listing — confirm the actual next free number

**Optional** (reference as needed):
- docs/adr/0034-*.md, docs/adr/0040-*.md, docs/adr/0046-*.md — the adjacent records to cross-reference

### Risks

- Number collision at fan-in — keep the provisional-number note so a merge renumber is mechanical.

### Test notes

No test surface; review for forward-facing prose and correct cross-references.

## Acceptance

- [ ] One new ADR records all five decisions/non-goals with Context, Decision, and Consequences
- [ ] It cross-references the adjacent launch-triple/resume/pinnability/panel-roster ADRs and edits none of them
- [ ] The record carries the provisional-number convention note

## Done summary

## Evidence
