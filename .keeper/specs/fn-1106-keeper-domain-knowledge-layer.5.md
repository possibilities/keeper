## Description

**Size:** S
**Files:** plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/domain-docs.md.tmpl, plugins/prompt/corpus/vendor.lock, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/CLAUDE.md

### Approach

Vendor-sync the upstream snippet work (new domain-docs + three revisions) into keeper's corpus, then bake the domain-modeling reflex into the two interactive writer skills. hack/SKILL.md: a BAKE region (byte-verbatim, drift-gated) — the reflex applies during investigation and sketch conversations. plan/SKILL.md: wire the reflex into the Phase 2d flow (a resolved priority-question tradeoff passing the 3-part test becomes an ADR written before scaffold; a sharpened term updates CONTEXT.md before worker briefs consume it) — BAKE or POINTER per how much of the snippet the phase needs inline; follow the existing convention (hack bakes, operator surfaces point). Update the plugins/plan CLAUDE.md baked-snippet enumeration to the new count. The three revised snippets propagate through the sync; verify no existing BAKE region drifted (re-bake if a revised snippet is baked anywhere).

### Investigation targets

*Verify before relying.*

**Required**:
- scripts/vendor-corpus.ts --sync / --check flow; plugins/prompt/src/vendor.ts verifyBakes
- plugins/plan/skills/hack/SKILL.md existing BAKE regions (now five after the craft-deltas epic) and plugins/plan/skills/plan/SKILL.md Phase 2d (as reshaped by the craft-deltas split task)
- plugins/plan/CLAUDE.md snippet enumeration sentence

### Risks

- Both skill files were reshaped by the craft-deltas epic — locate insertion points in the landed text, not planning-time line refs.

### Test notes

`bun scripts/vendor-corpus.ts --check` and the prompt suite green.

## Acceptance

- [ ] The vendored corpus carries the new and revised snippets and the lock verifies
- [ ] hack bakes the domain-modeling reflex; plan's Phase 2d flow writes ADRs at plan time and glossary updates before scaffold, per the baked/pointed snippet
- [ ] The plugins/plan CLAUDE.md enumeration names the correct bake count
- [ ] Drift gate and prompt suite pass

## Done summary
Vendor-synced the arthack corpus to 305e1025 (new engineering/domain-docs snippet + revised claude-md-scope/code-comment-style/future-facing-docs), baked the domain-modeling reflex into hack/SKILL.md (sixth BAKE guard) and pointed plan/SKILL.md Phase 2d at it, bumped the plugins/plan CLAUDE.md bake count, and recaptured prompt oracle goldens. Drift gate and prompt suite green.
## Evidence
