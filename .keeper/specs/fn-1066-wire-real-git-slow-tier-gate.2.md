## Description

**Size:** S
**Files:** plugins/plan/scripts/promote.sh, plugins/plan/test/consistency-generated-guard.test.ts

### Approach

Add a slow-tier gate step to promote.sh: after the build and existing drift guards, run the plan slow suite; under set -euo pipefail any failure blocks promotion. Add a `--skip-slow` flag that bypasses the gate while printing a loud, unmissable warning — the emergency hatch, not a routine path. Separately, fix the clean-checkout footgun in consistency-generated-guard.test.ts: the workers/-dependent assertions (readdirSync around line 129, findWorkManifests around line 202) get an existsSync-gated skip so a checkout that never rendered the gitignored workers/ cells fails soft; every other test in the file still runs. Promotion-time drift coverage is preserved because promote.sh renders before its guards run.

### Investigation targets

**Required** (read before coding):
- plugins/plan/scripts/promote.sh — current step order (build, binary-embed grep guard, render/git-status guard)
- plugins/plan/test/consistency-generated-guard.test.ts:129,202 — the two workers/-dependent sites

**Optional** (reference as needed):
- plugins/plan/.gitignore — which generated paths are ignored

### Risks

Do not touch the load-bearing binary-embed grep guard (promote.sh:35-46). The dead-looking second guard (promote.sh:48-56) is epic fn-papercut territory — leave it alone here.

### Test notes

Simulate a clean checkout by temporarily moving workers/ aside and running the guard test; run promote.sh end-to-end once with the slow tier green and once with an injected failure to prove it blocks.

## Acceptance

- [ ] promote.sh runs the slow tier by default and a slow-tier failure blocks promotion
- [ ] `--skip-slow` bypasses with a loud warning
- [ ] consistency-generated-guard.test.ts passes with workers/ absent and with workers/ rendered
- [ ] test-full.ts env scrub untouched

## Done summary
promote.sh now runs the real-git slow tier by default and hard-blocks promotion on any failure; --skip-slow is a loud emergency bypass. consistency-generated-guard.test.ts skips its two workers/-enumerating tests when the gitignored cells are absent so a clean checkout fails soft.
## Evidence
