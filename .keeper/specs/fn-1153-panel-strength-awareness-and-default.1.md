## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml

### Approach

Author the canonical panel-strength rubric as a new snippet in the arthack prompt corpus, `engineering` domain. The snippet is the single source every panel-wielding skill bakes; it states the invariant contract of the panel config and the selection procedure, in wording that stays correct no matter how many panels exist or what they are named. Content it must carry: (1) the config shape — `~/.config/keeper/panel.yaml` defines one or more named panels (ordered preset selections); at most one is the configured default via a top-level `default` pointer; panels may be defined, renamed, or removed at any time; (2) the strength signal — a panel's strength is read from its member count and harness diversity; a stronger panel buys more independent cross-checking at proportional cost and runs as slow as its slowest member; (3) the selection procedure — the human named a panel: pass it verbatim; ordinary panel-worthy question: use the configured default (omit any panel argument); the answer anchors above-inline work or being confidently wrong is expensive: run `keeper agent presets list` (`--json` for structure) and pick a broader configured panel; ambiguous: the default; (4) the failure branch — when roster discovery fails or no default is configured, skip the panel, answer without it, and note the config gap to the human. Write for the wielding inference ("the human", never "the user"); forward-facing prose only.

The snippet body must be static: no `{{` / `{%` template metacharacters (the byte-exact bake breaks on templating, and roster values are never interpolated at render time). Front-matter is the house `{#- ... -#}` comment block (name/summary/domain/audience/severity/tags/scope/phase). Author via `keeper prompt save-snippet` (incremental sorted index insert) or hand-author the .md.tmpl and run `keeper prompt build-snippets`. The corpus `_index.yaml` is a generated artifact and is ALREADY DIRTY in the arthack working tree from a prior rebuild — rebuild on top of the pending change and reconcile; never clobber it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- claude/arthack/template/_partials/snippets/engineering/build-forward-no-fallback.md.tmpl — front-matter block shape and body register to match
- claude/arthack/template/_partials/snippets/engineering/escalate-inline-or-plan.md.tmpl — a sibling rubric snippet consumed via BAKE by the same hack SKILL.md; match its imperative, config-agnostic voice
- ~/code/keeper/plugins/prompt/src/save_snippet.ts and build_snippets.ts — the two authoring paths and the index contract (token-estimate, used-in stamps)

**Optional** (reference as needed):
- ~/code/keeper/plugins/plan/skills/hack/SKILL.md:117-125 — the panel gate this snippet's render will replace prose inside (consumer context; do not edit here)
- `keeper agent presets list --json` output — the envelope the rubric tells wielders to read ({presets, panels:[{name,members}], default})

### Risks

- Wording that accidentally names or counts panels ("two levels", "small/large", model names) defeats the whole design — grep your own body before finishing
- Clobbering the dirty `_index.yaml` loses an unrelated pending rebuild

### Test notes

`keeper prompt render engineering/panel-strength` emits the body; `keeper prompt build-snippets --check` passes (index in sync); `keeper prompt find-snippets "panel strength"` ranks it.

## Acceptance

- [ ] `keeper prompt render engineering/panel-strength` succeeds and the rendered body carries the config contract, the member-count/harness-diversity strength signal, the four-branch selection procedure, and the discovery-failure branch
- [ ] The body names no concrete panel name, panel count, or model roster, and contains no `{{` or `{%` sequences
- [ ] `keeper prompt build-snippets --check` exits clean with the new snippet indexed, with the pre-existing pending index change preserved
- [ ] Snippet front-matter carries domain `engineering` and follows the house comment-block format

## Done summary

## Evidence
