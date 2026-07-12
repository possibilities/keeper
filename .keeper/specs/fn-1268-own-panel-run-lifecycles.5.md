## Description

**Size:** M
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/plan/template/agents/panel-runner.md.tmpl, plugins/plan/agents/panel-runner.md, plugins/plan/agents/panel-runner.md.managed-file-dont-edit, plugins/plan/template/agents/panel-judge.md.tmpl, plugins/plan/agents/panel-judge.md, plugins/plan/test/consistency-skills.test.ts, test/panel-doc-durations.test.ts

### Approach

Make the public panel skill reserve one request before spawning the runner and pass a structured control header containing the opaque run handle separately from the question text. The runner performs one deterministic panel execution against that handle, never derives a slug or re-drives fan-out, and invokes the typed judge exactly once through generic `Task(subagent_type, description, prompt)`. Keep panelist prompts free of orchestration instructions, preserve content-blind answer-file handoff, and make malformed judge output terminal rather than retryable. Ensure cancellation of the runner's Task scope reaches both its active panel execution and nested judge scope.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/panel/SKILL.md:25 — the skill is the public shim and currently delegates reservation/slug choice to model-authored control text.
- plugins/plan/skills/panel/SKILL.md:94 — malformed runner output currently permits one Task re-drive.
- plugins/plan/template/agents/panel-runner.md.tmpl:43 — runner input currently treats the entire task as opaque and copies it verbatim, including orchestration prose.
- plugins/plan/template/agents/panel-runner.md.tmpl:84 — model-directed start/wait logic currently owns launch and retry counting.
- plugins/plan/template/agents/panel-runner.md.tmpl:237 — judge ownership already uses the desired generic Task vocabulary.

**Optional** (reference as needed):
- plugins/plan/template/agents/panel-judge.md.tmpl:1 — judge already denies further Task delegation.
- plugins/plan/test/consistency-skills.test.ts:609 — static runner checks provide the compatibility baseline.

### Risks

A control header must be structurally separated from untrusted question text so a question cannot forge ownership fields. The runner must not read panelist answer content, and generated files must be updated through their owning template/render path. Cancellation during judge execution needs one terminal run state without asking the model to run cleanup commands.

### Test notes

Add executable workflow tests for one reservation, one runner Task, one member fan-out, no fresh-slug retry, recursive question text treated as data, one judge Task, no judge retry, quorum filtering, cancellation during fan-out and judging, and exact two-sentinel return shapes. Keep static body-parity tests for Claude/Pi rendering.

### Detailed phases

1. Define the harness-neutral control header and reserve-before-Task flow.
2. Replace model-owned start/wait loops with one deterministic run-handle operation.
3. Preserve one typed judge Task and bind its lifecycle to the owned run.
4. Remove malformed-return and judge retries.
5. Render managed agents and pin workflow/cardinality tests.

### Alternatives

Passing the entire orchestration request verbatim to panelists is rejected because it caused recursive launch. Moving the judge to detached `agent run` is rejected because it loses typed Task semantics.

### Non-functional targets

Panelist content never enters the runner context; user question text cannot mutate control fields; shared agent bodies contain no Pi-specific lifecycle vocabulary.

### Rollout

Keep old runner invocations fail-loud until they reserve a request handle; do not silently fall back to model-derived slugs.

## Acceptance

- [ ] The panel skill reserves exactly one request and passes a non-forgeable structured run handle separately from question text.
- [ ] Panelists receive the inquiry without panel-orchestration directives, while preserving the substantive evidence and requested answer shape.
- [ ] The runner cannot create a fresh slug, start more than one fan-out, or retry malformed output under a new request.
- [ ] The judge is invoked exactly once through the unchanged generic Task contract and remains content-blind until synthesis.
- [ ] Runner cancellation propagates to active member execution and the nested judge ownership scope.
- [ ] Claude and Pi generated agent bodies remain equivalent apart from harness metadata.

## Done summary

## Evidence
