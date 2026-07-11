## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl

### Approach

Rewrite the snippet — the `{#- … -#}` header (name/summary/tags stay, summary text updates)
and the whole body — from the retired count/diversity heuristic to the described-roster
rubric. The snippet is methodology only: it teaches HOW to choose, and must never name a
concrete panel or embed a panel description, because the roster is regenerated independently
and a name here would couple every roster edit to a cross-repo re-bake. Keep the register and
length close to the current body (a bold-led paragraph or two plus a short bullet rubric) —
it bakes byte-verbatim into two keeper skill bodies. All prose present-tense; no reference to
what the guidance previously said.

Required content points (each must appear, wording yours):
- The configured roster lives in `~/.config/keeper/panel.yaml`, authored by the
  `/plan:panel-guidance` skill; each panel carries an authored strength band
  (weak|light|standard|strong|max) and a rich description. Read it live at decision time via
  `keeper agent presets list --json` — panel names are never hard-coded.
- Two-stage selection: first restate the task's stakes in a phrase, then pick the WEAKEST
  panel whose description covers it.
- Escalate a rung only on an observable trigger — genuine ambiguity, blast radius,
  irreversibility, or a security surface — never on felt confidence.
- Anti-bias lines: a shorter description is not a weaker fit, and a stronger band is not a
  tiebreaker unless a named trigger fires.
- Weak-band semantics: the weak rungs are cheap sanity duos; when one direct answer would do,
  skip the panel entirely.
- A human-named panel passes through verbatim; an ordinary panel-worthy question takes the
  roster's `default` pointer.
- When roster discovery fails or no default is configured: skip the panel, answer directly,
  and surface the config gap.

### Investigation targets

*Verify before relying — these refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl:1 — the header and body being replaced

**Optional** (reference as needed):
- /Users/mike/code/keeper/plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl — the vendored copy keeper currently bakes (register and length reference; the two files have drifted, and this arthack source is the one to rewrite)

### Risks

- Prose that names concrete panels or bands-with-descriptions couples roster edits to
  cross-repo re-bakes — keep methodology-only.

### Test notes

No arthack-side test surface; the keeper epic's re-vendor task verifies the bake gate and
prompt suite. Sanity: the file parses as a snippet template (header block intact).

## Acceptance

- [ ] The snippet source teaches the described-roster rubric with every required content point present: live roster read via presets list, two-stage weakest-covering selection, observable escalation triggers, both anti-bias lines, weak-band skip semantics, verbatim human-named panels, default-pointer path, and the missing-roster fallback.
- [ ] No panel name or per-panel description appears anywhere in the snippet.
- [ ] The embedded summary header describes the new rubric and all prose is present-tense.

## Done summary

## Evidence
