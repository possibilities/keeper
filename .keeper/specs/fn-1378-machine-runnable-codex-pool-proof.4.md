## Description

**Size:** S
**Files:** docs/install.md, integrations/pi-codex-pool/README.md, docs/problem-codes.md, CONTEXT.md

### Approach

Rewrite the proof documentation to the machine-runnable path — delete the
slash-command walkthrough steps rather than appending beside them. The
install walkthrough covers arming a window and running the managed proof
probe; the companion README's live-proof section describes the tool, the
two seams, and the attestation contract; the problem-codes table gains or
revises rows only where verdict production changed. CONTEXT.md gains
glossary entries for the forced-refresh seam, the fault-injection seam,
and the sharpened proof-window/genuineness vocabulary (a seam-driven
provider-boundary fault is genuine; a self-reported or replica-produced
report is not) consistent with ADR 0098. All prose forward-facing: no
provenance, no fn-ids.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/install.md:245-262 — the walkthrough section to rewrite
- integrations/pi-codex-pool/README.md:36,48-52 — the live-proof section
- docs/problem-codes.md:146-163 — the Pi Codex pool table
- docs/adr/0098-machine-runnable-codex-pool-proof.md — the vocabulary source

### Risks

- CONTEXT.md may carry unrelated in-flight edits at execution time; touch only the glossary entries this task owns

### Test notes

`bun scripts/lint-claude-md.ts` stays green; grep asserts no slash-command proof steps remain in install.md.

## Acceptance

- [ ] The install walkthrough documents only the machine-runnable proof path
- [ ] The companion README describes the tool, seams, and attestation contract
- [ ] CONTEXT.md defines both seams and the genuineness distinction consistently with the ADR
- [ ] No doc gains provenance/history prose; doc linters green

## Done summary
Rewrote the codex-pool proof docs for the managed machine-runnable path: install walkthrough drops slash commands for the managed proof probe, the companion README covers the tool/seams/attestation contract, problem-codes reflects re-derived verdicts, and CONTEXT.md gains the seam and genuineness glossary entries.
## Evidence
