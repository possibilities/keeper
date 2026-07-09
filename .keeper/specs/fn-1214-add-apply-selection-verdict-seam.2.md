## Description

**Size:** S
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/skills/close/SKILL.md, plugins/plan/README.md

### Approach

Collapse the four selector beats onto the verb so every calling skill runs the identical shape: `keeper plan selection-brief` → spawn `plan:model-selector` (config-only prompt, unchanged) → pipe the Task return VERBATIM to `keeper plan apply-selection <epic> --file -` (plus `--from-followup` in the close beat) → on a failure envelope, relay its details array as the VALIDATION_ERRORS block to ONE fresh selector spawn → on a second failure, `apply-selection <epic> --degraded <reason>` (live beats) or skip to a verdict-less finalize (close beat). Delete the skill-side JSON parsing, fenced-block extraction, enum-clamp/coverage prose, assign-cells heredoc assembly, and the close beat's Write-tool verdict authoring — validation and writing are the verb's job now; the skills keep only spawn + one-retry orchestration and the never-block degrade contract. The close beat pins the verb envelope's verdict_path and threads it to `close-finalize --selection-verdict`. The arm invariants stay verbatim: every live path still reaches the Phase 7 arm, close never blocks on selection.

README: add the apply-selection verb paragraph (dense single-paragraph style with an inline Typed errors list), consolidate the assign-cells paragraph so the shared cell-write/sidecar core is described once with two entry points (YAML batch vs raw stdin verdict), and reword the /plan:close command-table row to the verb-staged verdict path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md:591-667 — Phase 6.5 (6.5a-6.5e + failure invariant), and :811-819 — the R6 refine convergence that cites the same beat
- plugins/plan/skills/defer/SKILL.md:173-212 — Phase 4b single-task beat
- plugins/plan/skills/close/SKILL.md:149-227 — Phase 3.5; 3.5e's Write-tool verdict assembly is what the verb replaces
- plugins/plan/test/consistency-skills.test.ts:164,194-199 — every `keeper plan <verb>` in a defer/close fenced bash block must resolve --help exit 0
- plugins/plan/README.md:52,65-67,186-193 — verb list, assign-cells paragraph, command table

**Optional** (reference as needed):
- docs/problem-codes.md — cite the registered code names accurately in the retry prose

### Risks

- The four beats must stay mutually consistent (same call shape, same failure relay, same degrade wording) — divergence between them recreates the triplication drift this epic removes.

### Test notes

Plan plugin fast suite green (consistency-skills resolves every fenced verb against the real CLI). Grep the three skills to confirm no assign-cells cell-heredoc or Write-tool verdict assembly remains in a selector beat; assign-cells stays documented as the public batch primitive in the README.

## Acceptance

- [ ] All four beats (plan Phase 6.5, plan R6, defer Phase 4b, close Phase 3.5) invoke apply-selection with the piped selector return; no skill parses, enum-clamps, or transcribes selector JSON, and no skill writes a verdict file with the Write tool
- [ ] Each beat states the same two-strike contract — first failure envelope relayed as VALIDATION_ERRORS to one fresh selector, second failure degrading via --degraded (live) or a verdict-less finalize (close) — and the existing arm/never-block invariants remain stated verbatim
- [ ] plugins/plan/README.md documents apply-selection, describes the shared core once across both entry points, and the /plan:close row reflects the verb-staged verdict path
- [ ] The plan plugin fast suite is green, including the skill-prose consistency gate

## Done summary

## Evidence
