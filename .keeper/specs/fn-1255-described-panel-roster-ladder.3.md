## Description

**Size:** S
**Files:** plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/_index.yaml, plugins/prompt/corpus/vendor.lock, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/prompt/test/oracle/fixtures/render.json

### Approach

Pull the rewritten panel-strength snippet through the vendor pipeline. Precondition first:
confirm the arthack source at
/Users/mike/code/arthack/claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl
already carries the described-roster rubric (it reads the roster live via presets list and
picks the weakest covering rung); if it still teaches the count/diversity heuristic, the
upstream epic has not landed in the arthack checkout — stop and report blocked rather than
vendoring stale prose. Then run `bun scripts/vendor-corpus.ts --sync /Users/mike/code/arthack`,
which re-copies the filtered corpus subset, rebuilds the filtered snippet index, rewrites
vendor.lock, and re-renders the BAKE guard regions in both the hack and panel skill bodies.
Re-record the prompt oracle golden entry for the panel-strength render. Finish with
`bun scripts/vendor-corpus.ts --check` exiting 0 and the prompt suite green. The sync sweeps
the whole filtered subset from arthack HEAD — if unrelated snippets drifted upstream, keep
the commit scoped to the panel-strength change set where possible and surface any unrelated
sweep in the Done summary rather than silently landing it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/vendor-corpus.ts:55-56 — the HACK_SKILL/PANEL_SKILL bake targets and the --sync/--check flows
- plugins/prompt/corpus/vendor.lock:28 — the panel-strength sha pin the sync rewrites

**Optional** (reference as needed):
- plugins/prompt/test/oracle/fixtures/render.json — the golden carrying a panel-strength render entry (~line 338)
- plugins/prompt/src/vendor.ts — verifyBakes/verifyVendorLock internals

### Risks

- The oracle golden is a separate stateful step the sync does not touch — dropping it leaves
  the prompt suite red.

### Test notes

`bun scripts/vendor-corpus.ts --check` plus the prompt suite are the gates; also re-run the
plan-suite bake-drift assertion if present.

## Acceptance

- [ ] The vendored corpus copy, snippet index summary, vendor.lock, and both skill BAKE regions carry the new rubric, and the vendor drift gate exits 0.
- [ ] The prompt suite is green including the re-recorded render golden.

## Done summary

## Evidence
