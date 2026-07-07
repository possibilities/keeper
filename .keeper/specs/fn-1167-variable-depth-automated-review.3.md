## Description

**Size:** M
**Files:** plugins/plan/skills/close/SKILL.md, plugins/plan/agents/quality-auditor.md, plugins/plan/agents/close-planner.md

### Approach

The close flow consumes the depth band. The close skill's audit phase reads the band off the preflight envelope (mechanical — the orchestrator stays content-blind) and passes a depth directive line into the quality-auditor spawn. The auditor prompt gains explicit band branches: lean matches today's single pass; standard adds the full two-axis sweep; deep adds the extra dimensions (cross-file interaction sweep, contract-surface focus) and marks its gating-grade findings for refute. close-planner's vet strengthens at deep — every kept gating finding must survive an explicit refutation attempt recorded in its decision table (the refute lives inside close-planner's existing vet authority; no new agent, no new spawn site at close). Dedup rules land here: the auditor receives prior per-task finding refs from the brief and reads them; a finding fingerprint-linked (category + file + semantic match) to a per-task finding marked fixed is suppressed with a one-line note; one marked accumulated-open is surfaced as still-open, never suppressed. All three files keep their fixed report/verdict contracts — additions extend sections, never rename headings or envelope fields.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/skills/close/SKILL.md — Phase 2 auditor spawn (config-only prompt) and Phase 3 close-planner flow
- plugins/plan/agents/quality-auditor.md — the two-axis dimensions, the one-line report contract, effort frontmatter (depth varies by prompt directive, not frontmatter)
- plugins/plan/agents/close-planner.md:89-99 — verdict JSON and the vet protocol the refute strengthens

### Risks

- Prompt-layer depth means the auditor must not silently ignore the directive — the band echoes in its report meta so a mismatch is visible at vet time.
- Same-family blind-spot correlation between per-task and close audits is unmeasured — note it in the auditor prose; the close whole-surface sweep exists precisely because diff-only review misses cross-file bugs.

### Test notes

Prose surfaces — no unit tests; the contract greps (headings intact, report line shape unchanged) plus the epic board smoke cover it.

## Acceptance

- [ ] The close audit runs lean/standard/deep per the brief's band, with deep adding named dimensions and refute-marked gating findings; the report meta echoes the band
- [ ] close-planner's deep vet records a refutation attempt for every kept gating finding
- [ ] Fixed per-task findings suppress their close matches with a note; accumulated-open findings surface as still-open
- [ ] Report and verdict contracts (headings, envelope fields, one-line auditor return) are unchanged

## Done summary

## Evidence
