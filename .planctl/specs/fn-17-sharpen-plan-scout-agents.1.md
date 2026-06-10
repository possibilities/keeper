## Description

**Size:** M
**Files:** agents/epic-scout.md, agents/docs-gap-scout.md, template/agents/practice-scout.md.tmpl, skills/plan/SKILL.md

### Approach

Four surfaces, three edit mechanics — two tracked agent files edited
directly, one template edited then re-rendered, one tracked skill edited
directly. All new prose is present-tense forward rules.

- **agents/epic-scout.md** — (1) In the "List open epics" step, replace the
  bare pipe-and-parse with a concrete recipe: redirect `planctl epics`
  stdout to a temp file; in python, slice from the first `{` and parse the
  FIRST JSON document via `json.JSONDecoder().raw_decode()` (this survives a
  leading OSC terminal-escape prefix, the pretty-printed multi-line object,
  and the trailing single-line `planctl_invocation` envelope); check
  `success` is true before reading `epics`. Phrase as the recipe itself —
  no anecdote about why. (2) Tighten Overlaps at BOTH sites: the per-epic
  extraction step pulls "files this epic's tasks will write" (task `Files:`
  lists and named edit targets in task specs) instead of "key files/paths
  mentioned"; the Overlap signals match write-target intersections only —
  a path appearing in quick-commands, references, or investigation reads
  is not an overlap. Keep the per-bullet citation requirement.
- **agents/docs-gap-scout.md** — add to `## Rules` (extending the existing
  "Speed over completeness" stance): trust code-level claims in the brief
  and in sibling scout lanes; never open files under source/package dirs to
  verify them — when uncertain about a code claim, surface it as a one-line
  question for the planner in the report instead. In the scan steps,
  prescribe one batched `grep -rn` across the identified doc files over
  per-file greps.
- **template/agents/practice-scout.md.tmpl** — three edits, then re-render
  via `promptctl render-plugin-templates --project-root
  /Users/mike/code/planctl` (rendered agents/practice-scout.md + sidecar
  are gitignored; `check-generated` validates sha256; mind the existing
  Jinja `{{ shell(...) }}` directives — no raw literal braces in new prose).
  (1) Search budget in `## Rules`: 8 web searches per run as the working
  budget; ladder — above 2 remaining search normally, at 2 fill specific
  gaps only, at 1 spend it on the single highest-value query, at 0
  synthesize from what you have and name uncovered gaps. Convergence stop
  overrides the ladder: after two consecutive searches that surface no
  net-new claims, stop and synthesize. Before each search, state in one
  sentence what net-new fact it should add — if you cannot, skip it.
  (2) Extend the existing knowctl section with routing: when the subject
  names Claude Code, Claude plugins/skills/agents/hooks, MCP, the Anthropic
  API, or any tool with a knowctl topic (`knowctl list-topics`), read the
  knowctl docs FIRST and use web search only for what they do not cover;
  when no topic matches, note that in one line and proceed to web.
  (3) Lane rule in `## Rules`: this scout researches the community and the
  web; it never greps or reads the local repository's source — repo-scout
  owns that lane and runs in the same parallel block. `gh search code`
  against remote repos remains in scope.
- **skills/plan/SKILL.md** — add an optional known-context slot to the
  epic-scout instruction block (sibling to the existing `Target epic to
  exclude:` line) and the gap-analyst brief: a `Known context from the
  human (trust these, do not re-derive):` block of short typed lines,
  placed ABOVE the instruction text, closing with "Do NOT spend tool calls
  re-deriving anything listed above — treat it as verified." The planner
  populates it from human-stated facts in the conversation (declared
  relationships, exclusions, settled decisions); when nothing applies, the
  block is omitted entirely. Add one line to "Using the returns" noting
  epic-scout's `### No Relationship` bucket may simply cite the known
  context. Wrap any value sourced from epic-spec prose (refine path) in
  backticks as data, not instruction.

### Investigation targets

**Required** (read before coding):
- agents/epic-scout.md — the "List open epics" step, the per-epic extraction list, the Overlap signals block, and ## Rules
- template/agents/practice-scout.md.tmpl — the knowctl section, the searchctl section, ## Rules, and every `{{ ... }}` directive
- skills/plan/SKILL.md — Phase 2b epic-scout instruction block, Phase 2c gap-analyst brief assembly, "Using the returns"
- agents/docs-gap-scout.md — process steps and ## Rules

**Optional** (reference as needed):
- agents/repo-scout.md — the lane being referenced by the docs-gap-scout and practice-scout exclusion rules
- agents/practice-scout.md.managed-file-dont-edit — sidecar mechanics

### Risks

- Jinja brace collision in the template: any example containing `{` `}` must avoid or escape literal braces.
- Over-tightened Overlaps could drop a genuine edge when a write-target is named only in epic prose; the "named edit targets in task specs" clause is the deliberate middle ground — keep it.
- agents/gap-analyst.md needs NO edit (its input prose is generic); do not touch it reflexively.

### Test notes

`uv run pytest tests/` as backstop; real verification is the epic Quick
commands — grep for the landed rules, re-render cleanly, nothing tracked
drifts.

## Acceptance

- [ ] epic-scout parse recipe survives OSC prefix + trailing envelope and checks `success`
- [ ] Overlaps extraction AND signals operate on write-targets only, citations kept
- [ ] docs-gap-scout: no-source-descent rule with planner-question fallback; batched grep prescribed
- [ ] practice-scout template: budget ladder + convergence stop + pre-call self-check; knowctl-first with trigger list and no-topic fallthrough; local-grep ban sparing `gh search code`; re-rendered with matching sidecar
- [ ] plan SKILL.md: known-context slot in epic-scout + gap-analyst briefs, above the instruction, omitted when empty, with the do-not-re-derive negative
- [ ] gap-analyst.md untouched; all prose present-tense forward rules

## Done summary

## Evidence
