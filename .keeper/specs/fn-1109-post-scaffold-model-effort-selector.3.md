## Description

**Size:** M
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/CLAUDE.md, plugins/plan/README.md, docs/plugin-composition-map.md

### Approach

Wire the selector into the two scaffold-owning flows and sweep the docs, consuming the verb (task 1) and config (task 2).

**Plan skill — new Phase 6.5** between dep-wiring and validate/arm: (1) read model-selector.yaml off disk; skip the beat entirely (defaults stand) if absent/unparseable. (2) Build a fully self-contained selector prompt: the config's guidance + usage advice, the epic and per-task specs inlined (nothing the selector must read itself — the captured envelope must be complete), the candidate cells with per-task SHUFFLED order (record the seed), an explicit output contract (a single raw JSON object: one cell per task id, exactly the epic's todo set, model/effort from the configured lists, per-task rationale + confidence). (3) Launch the detached read-only leg: `keeper agent run <harness> "$PROMPT" --model <model> --read-only --output <file>` with a bounded timeout, harness+model from the config. (4) Branch on the envelope's `outcome` FIELD (never exit code — no_message also exits 0). (5) Extract the verdict: parse `message` as raw JSON, fenced-block fallback; validate schema, enum-clamp tier/model, exact todo task-id set. (6) On validation failure: exactly ONE repair retry — fresh leg, validation errors appended to the prompt — then degrade. (7) Feed the valid verdict to `keeper plan assign-cells` (label_source selector-chosen); on ANY failure path (config missing, launch_failed, timed_out, no_message, parse/schema failure post-retry, assign-cells rejection) call assign-cells with the stamped default cells, degraded outcome, and the failure reason (label_source heuristic-default) so the sidecar records the failure — and if even that fails, log one line and proceed. Phase 7 arm runs UNCONDITIONALLY after the beat; no failure mode may leave a stuck ghost.

**Tier/model authoring rule change (5d/5e)**: the planner stops choosing — every task is stamped the mechanical default cell (xhigh/opus) at scaffold, one line of prose stating the selector owns the choice. The effort-band prose leaves this file (its content now lives in the config via task 2). The defer skill gets the same treatment: default stamp at its scaffold, the same selector beat (single-cell epic) before its arm.

**Docs sweep** (forward-facing prose only; keep the CLAUDE.md linter green): plugins/plan/CLAUDE.md — Removed-verbs rationale becomes "chosen at plan/refine/select time", reconciled so the no-incremental-verb stance reads consistently beside the batch verb; add the Running-Things row for the model-guidance drift gate. plugins/plan/README.md — assign-cells verb entry (dense one-paragraph form with typed errors), revise the two "chosen at plan/refine time" sentences, extend the .keeper/ layout tree with state/selections/, add the model-guidance skill-inventory row and a one-clause selector note on the plan/defer rows. docs/plugin-composition-map.md — one line adding model-selector.yaml to the plan plugin's config surfaces. Do not promise an --agent-help for assign-cells anywhere (plan verbs carry none).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md:17-29 (phase map), :379-384 (bands leaving), :438-442 (required-on-every-task stamp site), :541 and :615-619 (the Phase 6 / Phase 7 boundary the new beat lands between)
- plugins/plan/skills/defer/SKILL.md:109-142 (scaffold + tier pick), :174-180 (arm site the defer beat precedes)
- src/agent/run-capture.ts:53-63 (9-key envelope), :72-80 (outcome→exit map; no_message is exit 0), :167-177 (harness positional + --model override)
- plugins/keeper/skills/pair/SKILL.md:47-60 — the detached `keeper agent run --read-only --output` leg idiom (atomic --output appearance)
- plugins/plan/CLAUDE.md:42 — the Removed-verbs line to reword (the one sanctioned history-bearing block)

**Optional** (reference as needed):
- plugins/plan/agents/panel-runner.md — durable-slug + chunked-wait pattern if the leg needs restart survival
- plugins/plan/README.md verb-reference section — the dense one-paragraph entry form to match
- bun scripts/lint-claude-md.ts — the size/re-narration gate the CLAUDE.md edits must keep green

### Risks

- This file set collides with fn-1106 (same SKILL.md and CLAUDE.md) — mitigated by the epic-level dep; the worker should still expect the landed text to have shifted from the line refs above
- Prompt bloat: inlining full task specs risks verbosity bias pulling long-specced tasks toward the strong model — keep the guidance distilled and note per-task spec length in the prompt so the selector can discount it

### Test notes

Skill prose has no unit surface; verification is a live round-trip: scaffold a throwaway epic in a tmp plan project, run the Phase 6.5 beat, confirm cells overwritten + sidecar committed + epic armed; then force a failure (bogus selector model) and confirm degrade → defaults stand + degraded sidecar + epic still armed. The corpus/bake drift gate must stay green after the SKILL.md edits.

## Acceptance

- [ ] A /plan:plan run stamps default cells at scaffold, runs the selector beat after dep-wiring, and arms the epic with selector-chosen cells and a committed selection sidecar when the leg succeeds
- [ ] Every selector failure mode (missing config, launch failure, timeout, empty message, invalid verdict after one repair retry, verb rejection) leaves the default cells standing, records a degraded sidecar when the verb is reachable, and still arms the epic
- [ ] /plan:defer runs the same default-stamp plus selector beat over its single-task epic before arming
- [ ] Effort-band selection prose lives only in the model-selector config; the plan and defer skills instruct stamping the mechanical default
- [ ] The plan CLAUDE.md, README, and composition-map docs describe the select-time cell flow consistently, forward-facing, with the CLAUDE.md lint gate green
- [ ] Baked-snippet and corpus drift gates remain green after the skill edits

## Done summary
Wired the post-scaffold model+effort selector beat into /plan:plan (Phase 6.5) and /plan:defer (Phase 4b): both stamp the mechanical default xhigh/opus at scaffold, run a detached read-only selector leg that overwrites cells via assign-cells (with sidecar), and degrade to defaults on every failure while still arming. Swept CLAUDE.md, README, and the composition-map docs for the select-time cell flow.
## Evidence
