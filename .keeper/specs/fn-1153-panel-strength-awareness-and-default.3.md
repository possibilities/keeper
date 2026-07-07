## Description

**Size:** M
**Files:** plugins/prompt/corpus, scripts/vendor-corpus.ts, plugins/prompt/test/vendored-corpus.test.ts, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/README.md

### Approach

Land the vendored snippet, both BAKE sites, the extended drift gate, and the stale-doc sweep as one atomic keeper change so CI never sees a red window (the prompt suite's reachability test fails the instant a `keeper prompt render engineering/panel-strength` cite exists anywhere in plan skills without the snippet vendored). Moves: (1) re-vendor — `bun scripts/vendor-corpus.ts --sync <arthack-root>` picks up `engineering/panel-strength` (the engineering domain is already in FILTER) and rewrites vendor.lock; (2) bake into hack SKILL.md — wrap the render in BAKE guards inside the "Prefer the panel" gate, REPLACING the single-panel parenthetical ("the preset panel in ~/.config/keeper/panel.yaml — e.g. a Claude model plus a non-Claude one"); hack-side framing outside the guards maps its existing ladder onto the rubric: everyday panel route uses the configured default, the above-inline design-question route reaches for a broader configured panel; (3) bake into panel SKILL.md — in "Spawn the runner", REPLACING the "If the human named a specific panel, name it; otherwise the runner defaults to the `default` panel" line; framing outside the guards: put the panel the wielding context or the human already chose on the `Panel:` line, else omit it for the configured default (the same inference executes a routing skill and this one, so a wielder's choice flows directly into the spawn template); (4) extend the drift gate — scripts/vendor-corpus.ts and plugins/prompt/test/vendored-corpus.test.ts both hard-code HACK_SKILL only: add a PANEL_SKILL const and second verifyBakes call in each, and bump the bakeCount assertions (hack 6 to 7, panel 0 to 1); (5) sweep stale docs — fix the references/panel.md example (it shows `panels: { default: [...] }`, an invalid config since `default` is load-reserved as a panel name) to the real shape: named non-reserved panels plus the top-level `default:` pointer, noting the CLI aliases the literal `default` to the configured default panel; reword the plan README /plan:panel row (drops "two models (Opus 4.8 + GPT-5.5)") to config-agnostic wording. Consolidation, not duplication: the baked block absorbs the overlapping prose at each site; nothing baked may duplicate the sites' surviving config-agnostic neighbors. Forward-facing prose only; no concrete panel names, counts, or model rosters anywhere in committed prose.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/vendor-corpus.ts:46-56,128-138,176 — HACK_SKILL const, --sync lock-pinning (records arthack HEAD sha; the upstream snippet commit must be reachable from the tree you sync from), single verifyBakes call to extend
- plugins/prompt/test/vendored-corpus.test.ts:96-130 — verifyVendorLock, verifyBakes(HACK_SKILL), the hard-coded bakeCount === 6, and the plan-skills reachability walk
- plugins/prompt/src/vendor.ts:162-208 — BAKE guard regex and render-vs-guard byte comparison (what "byte-exact" means mechanically; the render strips snippet front-matter)
- plugins/plan/skills/hack/SKILL.md:117-125 — the panel gate prose the bake replaces (6 existing BAKE guards elsewhere in the file are the format reference)
- plugins/plan/skills/panel/SKILL.md:33-57 — the spawn-runner section and its Panel: template line
- plugins/plan/skills/panel/references/panel.md:44-60 — the invalid example block and its surrounding config prose

**Optional** (reference as needed):
- plugins/plan/README.md:170 — the /plan:panel row to reword
- cli/agent.ts:9-34 — panel help block; small wording touch only if the alias story reads wrong as-is (optional, from the epic Docs gaps)

### Risks

- Under worktree mode the epic's arthack lane may not be merged to arthack main when this task runs — vendor --sync must point at an arthack tree that contains the snippet commit (pass the lane checkout path explicitly, or verify reachability before syncing); a sync from a stale tree pins the wrong sha and the reachability test stays red
- Hand-pasted BAKE bodies that differ by one byte (trailing newline, em-dash) fail verifyBakes — paste from `keeper prompt render engineering/panel-strength` output verbatim
- fn-1149.8 and fn-1151.6 also edit plugins/plan/README.md in other sections; dep edges serialize the epics, but keep the README diff scoped to the /plan:panel row

### Test notes

`bun scripts/vendor-corpus.ts --check` clean (lock + hack + panel bakes); prompt suite green (`bun test plugins/prompt`), including reachability and both bakeCount assertions; then full `bun run test:full`. Grep the touched prose for "Opus 4.8", "GPT-5.5", "small", "large", "two models" — zero hits.

## Acceptance

- [ ] `bun scripts/vendor-corpus.ts --check` passes: vendor.lock verifies and BAKE verification covers BOTH hack and panel SKILL.md
- [ ] The prompt suite's bakeCount assertions hold at hack=7 and panel=1, and the reachability walk resolves `engineering/panel-strength` inside the vendored subset
- [ ] hack SKILL.md's panel gate and panel SKILL.md's spawn-runner section each carry the baked rubric, with the replaced prose gone and no duplicated selection guidance outside the guards
- [ ] references/panel.md shows a loadable example config (non-reserved panel names, top-level `default:` pointer) and states the `default` alias; the plan README /plan:panel row names no concrete models or panel count
- [ ] `bun run test:full` is green

## Done summary
Vendored engineering/panel-strength (scoped add preserving orient drift), baked the rubric byte-verbatim into hack + panel SKILL.md with the drift gate extended to both, and swept stale panel docs (references/panel.md loadable config + default alias note, README /plan:panel row config-agnostic).
## Evidence
