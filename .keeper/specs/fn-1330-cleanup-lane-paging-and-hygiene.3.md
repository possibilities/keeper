## Description

**Size:** M
**Files:** scripts/lint-claude-md.ts, scripts/lint-source.ts, src/composite-key.ts, scripts/backstop-stats.ts, src/backstop-telemetry.ts, src/readiness.ts, test/lint-claude-md.test.ts, CLAUDE.md

### Approach

Two coupled hygiene moves. First, the six deliberate raw-NUL composite-key
separators migrate to one shared named constant in a new dep-free module so the
separator is defined exactly once; investigate leak-reachability of those keys to
emission sinks and escape at the sink only if actually reachable. Second, a
source-wide lint (modeled on the lint-retired-name walker: explicit globs,
exclusion list, pure scan functions) enforces two rules: no net-new raw NUL
literal outside the shared-constant module, and no fn-id/provenance comments —
COMMENTS-ONLY matching with a tight token (the repo id shape), never raw file
text, with fixtures trapping "fn-123" inside a string literal and a SHA-256 hex.
Existing violations freeze into a committed shrink-only per-file allowlist
(fail on net-new, never demand a big-bang cleanup — the corpus is ~1,700 comment
hits). Exempt: the lint's own file and fixtures, CLAUDE.md/AGENTS.md (symlink
double-hit), plugins/plan/CLAUDE.md, .keeper/, docs/adr/. Wire into the existing
lint entrypoint; keep runtime bounded with extension/size/path short-circuits.
Touch CLAUDE.md rule #0 in place (two lines, prune not grow) to state the widened
gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/lint-claude-md.ts:44-61 — CONTENT_PATTERNS (fn-id + provenance regexes to reuse); :163-188 — the two-literal-path main to leave intact
- scripts/lint-retired-name.ts — the walker/exclusion/count idiom to model on (self-exemption pattern included)
- scripts/backstop-stats.ts:89; src/backstop-telemetry.ts:187,363; src/readiness.ts:1817,1821,1887 — the six NUL separator sites

**Optional** (reference as needed):
- test/lint-claude-md.test.ts, test/lint-retired-name.test.ts, test/lint-matrix.test.ts — fixture idioms
- package.json lint script — the gate wiring point

### Risks

- The lint file and CLAUDE.md edit contain the banned tokens by construction — self-exemption is load-bearing
- readiness.ts is shared surface: keep the constant migration mechanical, no behavior change

### Test notes

Fixture-driven: valid/invalid cases per rule including the false-positive traps;
allowlist shrink-only enforcement (a file dropping to zero cannot regress);
symlink de-dupe; runtime bound sanity on the full tree. Verify `bun run lint`
stays green on current main after the freeze.

## Acceptance

- [ ] The six NUL separator sites import one shared named constant; raw NUL literals elsewhere fail the lint
- [ ] The comments-only fn-id/provenance rule runs source-wide behind a committed shrink-only allowlist, with false-positive fixtures proving string literals and hex digests do not trip it
- [ ] The full lint matrix passes on the frozen tree and fails on injected net-new violations
- [ ] CLAUDE.md rule #0 states the widened gate in place without growing
- [ ] Named test gates for the touched suites pass

## Done summary

## Evidence
