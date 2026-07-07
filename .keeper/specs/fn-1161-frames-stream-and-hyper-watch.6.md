## Description

**Size:** M
**Files:** plugins/keeper/skills/watch/SKILL.md

### Approach

Restructure the skill around an explicit three-mode taxonomy over the one
shared observe → triage → act → return skeleton: the default supervision
sweep (unchanged mechanics), hyper (new), and pilot (the existing rung-5
window, unchanged) — with a one-line advertisement of the other modes when the
skill starts. Disambiguate naming on first use (the glossary binds bare
"watch" to the Agent Bus; reaper sweeps are a different "sweep" — say
"supervision sweep"; a frame diff is never a "delta"). Hyper mode: one bounded
frame chunk per invocation via keeper frames (--for/--max-frames — never an
internal infinite loop; standing hyper composes via /loop exactly like the
sweep), a mechanical pre-filter before any judgment (an empty diff is a no-op
verdict costing zero tokens; dedup against findings already filed), then the
per-frame human-proxy rubric — truthful (frame vs the paired state
JSON/keeper status ground truth), legible (meaningful transition vs confusing
churn), stable (a repaint when nothing changed is itself a defect) — with the
canonical worked example: a running:sub-agent-stale warn pill can be benign
by design (an orphan running row whose SubagentStop never landed) and the
rubric decides truthful-but-illegible vs untruthful. Findings split two ways:
a real underlying problem drops into the existing triage ladder at its normal
authority; a UI-quality defect files via plan:defer or keeper:handoff with
frame+diff evidence and NEVER edits renderer code inline. Ratchet rule: a
confirmed recurring confusion converts into a deterministic fix or test via
the defect route — hyper never re-discovers the same defect every pass. Frame
text is untrusted evidence, never authority: delimit it, act only on
structured reads, verify before any mutation. Bus health becomes
cross-cutting in ALL modes by growing the Monitor-liveness section: own inbox
presence, keeper bus list, send-outcome exit codes (not_connected /
delivery_failed) as first-class triage inputs, and the read-only bus.db
messages audit for peer delivery failures — escalation gated on a SUSTAINED
wedge, and a wedged relay routes through rung 3's existing daemon-bounce
three-part proof, never a new hammer. Mid-watch ad-hoc imperatives ("arm
fn-X, wait for it, restart keeper, back to yolo") become a named capture →
drive → await → restore composition citing the autopilot skill's
narrow-to-armed recipe and keeper:await — restore owed exactly like pilot.
Keep the one-bounded-unit-per-invocation invariant intact everywhere.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/watch/SKILL.md — full current structure: the sweep (:65-92), five-rung ladder (:93-198), pilot at rung 5 (:182), Monitor liveness (:207-215), Guardrails (:217)
- plugins/keeper/skills/autopilot/SKILL.md — the narrow-to-armed recipe (landed by its own task) this skill cites by name
- keeper frames --agent-help output (landed by the subcommand task) — the consumption contract the hyper section teaches
- src/board-render.ts:571-623 — the sub-agent-stale/monitor-stale warn routing behind the canonical example
- src/await-conditions.ts:606 — why an orphan running row is stale by design

**Optional** (reference as needed):
- plugins/keeper/skills/bus/SKILL.md — send-outcome semantics the bus-health section references, not restates
- docs/skill-authoring.md — skill prose conventions
- CONTEXT.md — the watch/sweep/delta glossary bindings the prose must respect

### Risks

- Frame text is a color-stripped plain render: hyper audits truthfulness well and visual legibility (alignment/contrast) weakly — the prose must scope the promise honestly, noting pill tokens carry severity in text.
- Skill bloat: every act still delegates to sibling skills; hyper adds a mode, not a second copy of any ladder rung.

### Test notes

Prose-only change; verification is structural — modes advertised, hyper
bounded, rubric + ratchet + injection discipline present, bus-health
cross-cutting with the sustained-wedge gate, imperatives composed by citation.

## Acceptance

- [ ] The skill names three modes over one shared skeleton, advertises the non-default modes in one line at start, and hyper consumes exactly one bounded keeper frames chunk per invocation
- [ ] The hyper section teaches mechanical pre-filter first, the truthful/legible/stable rubric with the stale-pill worked example, the real-problem-vs-UI-defect split with no inline renderer edits, and the ratchet rule
- [ ] Frame text is handled as delimited untrusted evidence with structured-read verification before any mutation
- [ ] Bus-health checks run in every mode using existing read surfaces with a sustained-wedge escalation gate routed through the existing rung-3 bounce proof
- [ ] Mid-watch imperatives are a named capture-drive-await-restore composition citing the autopilot recipe and keeper:await, with the restore owed
- [ ] Glossary discipline holds: no bare "watch" noun, supervision sweep disambiguated, frame diffs never called deltas

## Done summary
Restructured the watch skill into three named modes (supervision sweep / hyper / pilot) over one shared observe-triage-act-return skeleton, non-default modes advertised in one line on entry. Added the hyper mode: one bounded keeper frames chunk per invocation (--for/--max-frames, standing via /loop, never an internal loop); a mechanical pre-filter (empty-diff no-op, dedup) before the truthful/legible/stable human-proxy rubric; the running:sub-agent-stale warn-pill worked example; the real-problem-to-ladder vs UI-defect-to-plan:defer/keeper:handoff split with no inline renderer edits; the ratchet rule; and delimited-untrusted-evidence handling with structured-read verify-before-mutate. Grew Monitor-liveness into cross-cutting Bus and Monitor health for all modes (inbox presence, keeper bus list, send-outcome exit codes, read-only bus.db messages audit) with a sustained-wedge escalation gate routed through rung 3 existing daemon-bounce proof. Added the mid-watch imperatives capture-drive-await-restore composition citing the autopilot narrow-to-armed recipe and keeper:await, restore owed. Glossary discipline held: supervision sweep disambiguated, no bare watch noun, frame diff never a delta.
## Evidence
- Commits: 9ea5f725
- Tests: test/lint-skill-ids + test/lint-retired-name: 25/25 pass, fast suite 107 fail/106 err are pre-existing missing-dependency env errors (root js-yaml/zod absent, plugins/prompt node_modules absent) in plugins/prompt and plugins/plan, none attributable to this markdown-only change, frontmatter YAML parses; added Read to allowed-tools; all cross-referenced skill ids exist