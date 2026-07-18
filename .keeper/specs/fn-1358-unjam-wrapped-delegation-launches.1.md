## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/plugin/hooks/grant-guard.ts, test/wrapped-guard.test.ts, test/grant-guard.test.ts, plugins/plan/template/_partials/worker-implement-wrapped.md, plugins/plan/workers/, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json

### Approach

Verify-then-fix, three arms. (1) RED-REPRO the lexer: seed a corpus
from the REAL failing launches (query the events log for session
9897dd3c's Bash commands containing `agent run`) plus the POSIX
checklist — quote-run concatenation into one word, empty quoted words
preserved, comments only at word start, backslash-newline ordering,
ANSI-C quoting — judged against a static POSIX word-splitting
reference table (never a live shell; test doctrine). Fix ONLY
divergences where the lexer wrongly DENIES a well-formed single-argv
launch; never loosen toward bash where that would weaken the CVE deny
corpus (comment-stripping and ANSI-C stay conservative; a tightening
that names its construct is acceptable). "Zero divergences proven" is
a valid, complete outcome for this arm — land the characterization
lock test and change nothing. A proven lexer fix propagates to
grant-guard's byte-identical copy ONLY (re-run its corpus);
wrong-tree/branch variants and the derivers fold copy are out of
scope (fold determinism forbids the latter categorically).
(2) ACTIONABLE DENIALS, scoped to the wrappedAgentViolation run-gate
strings (no return-type change): each denial names the construct,
states expected-vs-received positional counts, excerpts the first
offending token TRUNCATED and sanitized (never echo the full
worker-composed command; one size-bounded line), distinguishes the
option-lookalike-in-prose case from the quoting case, denies an
empty-string positional by name, and carries the explicit steer:
do not retry the same quoting — single short quoted instruction,
content in --system-file. Keep the name-the-construct property the
existing substring tests assert; extend those tests.
(3) MANIFEST: the wrapped partial's launch and resume templates
mandate the trivially-parseable shape — a single-line, double-quoted,
substitution-free short instruction (resume stays inline within the
existing allowlist; no new flag, no ADR) — and the Failure map gains
the guard-denied branch: a PreToolUse deny of the launch command
means reshape per the denial's steer and retry BOUNDED times (state
the bound), never write an envelope, never classify it
TOOLING_FAILURE; only leg-side outcomes reach the envelope taxonomy.
Recompile the generated worker cohort (`keeper prompt compile --role
work:worker --target claude`) and regenerate the render golden at the
worker's actual base — generated outputs are never hand-edited.

### Investigation targets

*Verify before relying — refs are planner-verified at authoring time.*

**Required**:
- plugins/keeper/plugin/hooks/wrapped-guard.ts:147-256 (lexSegments), :567-657 (wrappedAgentViolation; positional gate :636, binding :639-648, index-4 assumption :613), :896-946 (deny-reason builders)
- test/wrapped-guard.test.ts:45-263 (truth tables; CVE corpus :234-263 — must never flip), :265-274 (name-the-construct), :302 (bashPayload harness)
- plugins/plan/template/_partials/worker-implement-wrapped.md:19-57 (contract-write rule :19, launch :26-33, resume :43-48, Failure map :52-57)
- plugins/keeper/plugin/hooks/grant-guard.ts:208 (the byte-identical lexer copy)
- The events log for session 9897dd3c — the real failing command corpus

**Optional**:
- docs/adr/0050-wrapped-delegation-guard.md (stay inside its allowlist decision)
- plugins/plan/CLAUDE.md (generated-outputs rule)

### Risks

- Loosening the lexer toward bash on comments or ANSI-C opens bypasses — the asymmetry rule is load-bearing; every lexer edit re-runs the full deny corpus in BOTH guards it lands in.
- The recompile touches every wrapped cell — regenerate, never hand-edit; regenerate the golden fresh at the merged base (the fn-1348 dep guarantees ordering on the singleton fixture).
- The denial excerpt is worker-influenced text — bound and sanitize it; no raw command echo.

### Test notes

Corpus-driven: real failing commands (allow after reshape guidance
applies, or deny with the RIGHT reason), POSIX checklist cases as
lock tests, empty-positional deny, option-in-prose deny hint,
CVE corpus green in wrapped-guard AND grant-guard. Manifest render:
the recompiled cohort and golden pass their oracle test. Named gates:
`bun test test/wrapped-guard.test.ts test/grant-guard.test.ts` and
`bun test plugins/prompt/test/oracle/render-plugin-templates.test.ts`
plus `bun run typecheck`.

## Acceptance

- [ ] The red-repro corpus (seeded from the real failing launches plus the POSIX checklist) is landed as tests; any lexer change is a proven wrongly-denies fix mirrored to grant-guard only, and the CVE deny corpus is green in both guards — or the lexer is proven correct and locked, with zero production lexer change.
- [ ] Every run-gate denial names its construct, carries expected-vs-received counts with a bounded sanitized excerpt, distinguishes quoting splits from option-lookalikes, denies empty instructions by name, and steers away from same-shape retries.
- [ ] The wrapped manifest mandates the single-line quoted substitution-free instruction shape for launch and resume, and its Failure map routes a guard-denied launch to bounded reshape-and-retry — never an envelope-absent TOOLING_FAILURE.
- [ ] The worker cohort is recompiled and the render golden regenerated at the merged base; generated outputs carry no hand edits.
- [ ] Focused named gates plus typecheck are green.

## Done summary

## Evidence
