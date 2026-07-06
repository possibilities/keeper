## Description

**Size:** S
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/plan/test/consistency-skills.test.ts

### Approach

The skill gains an explicit runner return contract: exactly two valid shapes, each identified by its first line — `PANEL_ANSWER` (strip the marker line, absorb the fused answer under the existing absorb-then-answer rules) or `PANEL_RUN_FAILED` (the existing failure branch). Matching is first-line shape, never substring — a fused answer that merely mentions a sentinel string is not a failure. Anything else — status narration, "waiting" prose, promises of future work, an empty or error-shaped Task return — is a malformed return: never absorbed as an answer, never a reason to end the turn in a waiting state. On the first malformed return the skill re-drives once: re-spawn plan:panel-runner with the byte-identical Task prompt including the same Slug: line captured from the first spawn (never re-derived — panel start reconciles idempotently by slug and reuses terminal legs, so the re-drive is cheap and cannot double-fan-out). A second malformed return is surfaced to the human as a panel failure quoting the runner's raw return verbatim — no further retries. Natural home: extend the "On a panel failure" section into the full contract check, and note the marker strip where absorb-then-answer begins. Add consistency-skills.test.ts assertions pinning the SKILL prose: both first-line literals present, and the single same-slug re-drive documented. Keep the existing PANEL_RUN_FAILED literal intact; do not introduce the phrase "never in a subagent". This task consumes the marker the runner-hardening task defines — read the landed Step 6 text rather than assuming it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/panel/SKILL.md:32-50 — Spawn-the-runner Task block and Slug derivation; capture-and-replay lands here
- plugins/plan/skills/panel/SKILL.md:57-62 — "On a panel failure", which the contract check extends
- plugins/plan/skills/panel/SKILL.md:64-70 — absorb-then-answer, where the marker strip integrates
- plugins/plan/agents/panel-runner.md — Step 6 as landed by the runner-hardening task: the exact marker definition this contract consumes
- plugins/plan/test/consistency-skills.test.ts:456-510 — existing panel assertions

**Optional** (reference as needed):
- plugins/plan/skills/panel/references/panel.md — deliberately unchanged (independence mechanics only; no wait or contract prose)

### Risks

- Contract drift against the runner: the first-line literals must byte-match what Step 6 defines — the dep edge exists so the landed text can be read

### Test notes

`bun test plugins/plan/test/consistency-skills.test.ts` green; new assertions fail against pre-change SKILL prose.

## Acceptance

- [ ] The skill documents the runner return contract as exactly two first-line-identified shapes (success marker, failure sentinel) and treats anything else as a malformed return that is never absorbed as an answer
- [ ] The documented malformed-return recovery is one re-drive with the byte-identical prompt and same slug, then surfacing the failure quoting the raw return — no unbounded retries and no turn ending in a waiting state
- [ ] The consistency test suite passes, including new assertions pinning the two-shape contract and the single same-slug re-drive in the skill prose

## Done summary

## Evidence
