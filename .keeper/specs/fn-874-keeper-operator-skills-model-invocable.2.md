## Description

**Size:** M
**Files:** plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/CLAUDE.md

### Approach

Two coordinated prose changes, forward-facing (present tense, no "formerly"
narration):

**(1) Relax the carve-out to PARTIAL.** At hack:183, defer:14, defer:186, and
plan/CLAUDE.md:34 the lines currently say the planning skills NEVER advertise the
`keeper:dispatch`/`keeper:autopilot` operator hatch and "the agent is left in the
dark about execution by design." Relax to: the orchestrator MAY reach for the
now-model-invocable operator skills on clear user intent, but the planning skills
still do NOT proactively drive execution mid-plan unsolicited (no
surprise-launching workers; the post-epic wrap-up stays quiet by default). KEEP
the "`/plan:hack` is slash-only (`disable-model-invocation: true`)" clause in
plan/CLAUDE.md:34 — that refers to `/plan:hack` itself, which is unchanged. Do
NOT widen hack's "Orchestration is yours to shape" closed list (:200-204) into
"freely drive execution."

**(2) Add one concise cross-skill ORCHESTRATION section to `/hack` and `/plan`**
teaching only what no single skill owns: the plan->await->plan daisy-chain
(CONSOLIDATE the existing hack:183-189 fragment — do not duplicate it), parallel
launches (`mode yolo` / dep-free epics) vs sequential (`mode armed` + epic
`depends_on_epics` + a `keeper:await complete <epic>` phase gate), and the
take-over window (capture->drive->restore via `keeper:autopilot`). REFERENCE the
skills (`keeper:dispatch`/`autopilot`/`await`) for mechanics — do NOT re-teach
per-skill detail (that lives in their bodies). For `/plan`, place the awareness
where multi-epic planning happens (near `depends_on_epics` authoring / the Phase
8 report) without bloating the phase flow.

### Investigation targets

**Required** (read before editing):
- plugins/plan/skills/hack/SKILL.md:183 — carve-out; :183-189 the daisy-chain fragment to consolidate; :200-204 the closed list (do NOT widen)
- plugins/plan/skills/defer/SKILL.md:14 and :186 — carve-out restatements
- plugins/plan/CLAUDE.md:34 — carve-out; KEEP the `/plan:hack`-slash-only clause

**Optional**:
- plugins/keeper/skills/dispatch|autopilot|await/SKILL.md — to reference skill names + behaviors accurately (post-.1 state)
- plugins/plan/skills/plan/SKILL.md — to find the least-disruptive insertion point for the orchestration awareness

### Risks

- Widening hack's closed list (:200-204) into standing "drive execution" license is the over-reach to avoid — keep the partial-stance floor (no proactive surprise-launch).
- Duplicating rather than consolidating the existing daisy-chain prose (hack:183-189) — fold it into the new section, don't leave two copies.
- `/plan` is phase-structured; the orchestration awareness must not disrupt the phase flow — keep it a tight, well-placed addition.

### Test notes

No automated gate. Re-read each relaxed line to confirm PARTIAL (orchestrator may
act on intent; no proactive surprise-launch) and that the `/plan:hack`-slash-only
clause + the closed list are intact. Confirm the orchestration section references
skills without re-teaching their internals and the daisy-chain isn't duplicated.
Subagent-reach sanity check: confirm plan WORKER subagents (`plan:worker-*`) do
not load these orchestration skills (executors run one task) — note the finding;
likely no change.

## Acceptance

- [ ] carve-out at hack:183, defer:14/186, plan/CLAUDE.md:34 relaxed to PARTIAL consistently; no line left contradicting the model-invocable reality
- [ ] `/plan:hack` stays slash-only (the plan/CLAUDE.md clause kept); hack closed list (:200-204) NOT widened into "freely drive execution"
- [ ] one concise cross-skill orchestration section added to `/hack` AND `/plan` (daisy-chain consolidated, parallel-vs-sequential, take-over), referencing skills not re-teaching them
- [ ] forward-facing prose only; subagent-reach checked (workers don't carry these skills) and noted

## Done summary
Relaxed the carve-out at hack:183/defer:14,186/plan-CLAUDE.md:34 to PARTIAL (planning flow never surprise-launches; model-invocable operator skills reachable on clear user intent), kept the /plan:hack slash-only clause and hack's closed list intact, and added a concise cross-skill orchestration section to /hack and /plan consolidating the daisy-chain fragment.
## Evidence
