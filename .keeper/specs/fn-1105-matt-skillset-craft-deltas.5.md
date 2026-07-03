## Description

**Size:** S
**Files:** plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/landed-vs-complete.md.tmpl, plugins/prompt/corpus/vendor.lock, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/plan/references/operator-orchestration.md, plugins/keeper/skills/await/SKILL.md, plugins/plan/CLAUDE.md

### Approach

Pull the upstream snippet into keeper's vendored corpus and make it the single source at all three consumption sites. Run the vendor sync against the arthack checkout (rebuilds the vendored subset + vendor.lock). Then: hack/SKILL.md gets a BAKE region (byte-verbatim, drift-gated) replacing its landed-vs-complete prose; the plan skill's orchestration reference file (where the split task relocated the daisy-chain bullet) and await's derivation table row each get a POINTER marker above skill-specific framing that no longer restates the kernel. Update plugins/plan/CLAUDE.md's baked-snippet enumeration (four → five, naming the new ref). Each skill keeps its own application framing — only the invariant kernel is unified.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/prompt/src/vendor.ts:29 (FILTER domains) and :170-228 (verifyBakes BAKE/POINTER mechanics)
- scripts/vendor-corpus.ts — `--sync ~/code/arthack` and `--check` flows
- plugins/plan/skills/hack/SKILL.md — the four existing BAKE regions as the pattern; its landed-vs-complete prose (formerly :211 region)
- plugins/keeper/skills/await/SKILL.md:46 region — the landed table row keeping derivation framing
- plugins/plan/CLAUDE.md — the "bakes four shared keeper prompt snippets" sentence

### Risks

- The plan-side site moved in the split task — locate the daisy-chain bullet in the disclosed reference file, not at the old line.

### Test notes

`bun scripts/vendor-corpus.ts --check` green; `cd plugins/prompt && bun test` (vendored-corpus test) green.

## Acceptance

- [ ] The landed-vs-complete kernel is vendored into keeper's corpus and the vendor lock verifies
- [ ] hack BAKEs the snippet; the plan orchestration reference and await POINTER it; none of the three restates the kernel in its own words
- [ ] The plugins/plan CLAUDE.md snippet enumeration names the new bake and the correct count
- [ ] The corpus drift gate and prompt test suite pass

## Done summary
Vendored engineering/landed-vs-complete into the corpus (arthack sync); hack BAKEs it, plan orchestration ref and await POINTER it, plan CLAUDE.md bake count four->five. Drift gate + vendored-corpus tests green.
## Evidence
