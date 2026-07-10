## Description

**Size:** S
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/close/SKILL.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json

### Approach

Wielder sessions improvise a wait after spawning their backgrounded worker subagent and call the harness ScheduleWakeup tool malformed (it is loop-only and requires `prompt`), failing with "`prompt` is required when `stop` is not true" roughly once per /plan:work session. The skills must state the actual harness contract: subagent spawns are backgrounded, waiting means ending the turn, the worker's completion task-notification is the only wake path, and ScheduleWakeup/Monitor/sleep are never called to wait on a worker. Add that beat to the work skill template's Phase 2a (right after the "trust the return value" paragraph, covering initial spawn, warm resume, and cold respawn) and reword warm-path step 3 from "Wait for the worker to finish, then re-run…" to end-turn phrasing ("End the turn; the worker's next task-notification re-invokes you — then re-run…"). Apply the same discipline note to /plan:close's hand-authored SKILL.md around its subagent spawns — while preserving its documented inline 60s→180s→600s transient-API-retry backoff, which is a legitimate retry sleep, not a worker-wait; a blanket "never sleep" wording would contradict it. Keep all new prose outside Task(...) code fences and free of fenced `keeper plan` verbs the CLI doesn't have (the consistency guards scan both). The work SKILL.md is generated: edit only the template, then re-render and refresh the oracle fixture via capture-oracle (two separate commands — render writes the live gitignored skill tree, capture-oracle writes the committed fixture the parity test reads).

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl:103 — the "trust the return value" paragraph; the new beat anchors right after it (line 105 is the worker_agent_id capture paragraph)
- plugins/plan/template/skills/work.md.tmpl:147 — warm-path step 3, exact string "Wait for the worker to finish, then re-run" to reword
- plugins/plan/template/skills/work.md.tmpl:109 — Phase 2b opener "After the worker returns…"; judge whether the new 2a beat makes it read correctly as-is
- plugins/plan/skills/close/SKILL.md:123 — "Wait for the planner to finish…" plus content-blind Task spawns at :53/:80/:132/:172; the :65 auditor block documents the transient-retry backoff that must survive unchanged in meaning
- plugins/prompt/src/render_plugin_templates.ts — the renderer; skills/work/SKILL.md + its .managed-file-dont-edit sidecar are generated, never hand-edited
- plugins/prompt/test/oracle/capture.ts — sole fixture generator (`cd plugins/prompt && bun run capture-oracle`); eyeball the fixture diff before committing so a bug is never frozen as golden
- plugins/prompt/test/parity.test.ts:350 — the byte-identical drift gate that fails if the template changes without a fixture refresh
- plugins/plan/test/consistency-skills.test.ts:747-829 — template-shape guards (spawn shape, agentId capture regex, verb existence, input-shape contract) that must stay green

## Acceptance

- [ ] The rendered /plan:work skill instructs the orchestrator, for every work:worker spawn (initial, warm resume, cold respawn), that the spawn is backgrounded, waiting means ending the turn, the completion task-notification is the only wake path, and ScheduleWakeup/Monitor/sleep are never used to wait on a worker; no "Wait for the worker to finish" phrasing remains in the rendered skill.
- [ ] /plan:close's skill carries the same wait-discipline note for its subagent spawns while its documented inline transient-API-retry backoff survives unchanged in meaning.
- [ ] The live skill tree re-renders cleanly, the oracle fixture is refreshed via capture-oracle, and both the prompt suite (parity drift gate) and the plan consistency-skills suite pass.

## Done summary

## Evidence
