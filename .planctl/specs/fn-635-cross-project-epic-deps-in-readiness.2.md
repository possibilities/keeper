## Description

**Size:** M
**Files:** src/readiness.ts, scripts/board.ts, scripts/autopilot.ts,
test/readiness.test.ts, test/board.test.ts, README.md. New file:
src/readiness-diagnostics.ts (type definitions + JSONL writer helper).

### Approach

Add a `dep-on-epic-dangling` BlockReason variant and rewrite predicate 9
in `src/readiness.ts` to use a cwd-then-global resolver. The resolver
builds two indexes inside `computeReadiness` alongside the existing
`taskById`: `epicById: Map<string, Epic>` (full id → epic) and
`epicsByNumber: Map<number, Epic[]>` (bare-id number → array of matching
epics across all projects in the input). Predicate 9 iterates
`epic.depends_on_epics`, classifies each entry as full-id or bare-`fn-N`
form, and:

- Full id form (`fn-100-foo`): lookup `epicById`. If absent → `dep-on-epic-dangling`. If present, lookup close-row verdict.
- Bare form (`fn-100`): lookup `epicsByNumber.get(100)`. Zero matches → `dep-on-epic-dangling`. One match → use it. Multiple matches → prefer the consumer epic's `project_dir`; if exactly one matches, use it; otherwise emit a `ResolutionDiagnostic` and yield `dep-on-epic-dangling`.

For close-row evaluation: tolerant forward-ref semantics — when the
upstream IS in `epicById` but its close verdict isn't yet in
`perCloseRow` (forward reference in iteration order), treat as
satisfied (preserves current handwave behavior for the rare in-snapshot
forward case). When the upstream is NOT in `epicById` → dangling.

Cross-project detection: the resolver carries the resolved epic's
`project_dir`. If `basename(upstream.project_dir) !== basename(consumer.project_dir)`,
mark the upstream as cross-project. `formatReasonShort` renders
`dep-on-epic <project>::<upstream-id>` when cross-project, else
`dep-on-epic <upstream-id>`. Cross-project provenance lives in the
RENDER layer, NOT in the `upstream` field of the BlockReason (the
payload stays a literal id so consumers can use it for lookup).

Diagnostics: `ReadinessSnapshot` gains
`diagnostics: ResolutionDiagnostic[]`. The new
`src/readiness-diagnostics.ts` exports the type plus an
`appendDiagnostic(d, logPath)` helper that does a single O_APPEND write
(under PIPE_BUF, atomic on POSIX). Callers (`scripts/board.ts` and
`scripts/autopilot.ts`) drain `snap.diagnostics` after each snapshot and
append to `~/.local/state/keeper/readiness-diagnostics.jsonl`. Record
shape: `{ts, kind: "ambiguous-dep-resolution", consumer_epic, upstream,
matches: string[]}` (extensible — new diagnostic kinds use the same
channel without changing the wire shape).

Board: update `scripts/board.ts:678-688` summary pill to call the same
shared resolver helper (exported from `src/readiness.ts`) so cross-
project deps render `[arthack::#N]` and dangling deps render `[?#N]`.
Add an `epicNumFromIdOrBare` parallel to `epicNumFromId` that matches
both `fn-100-foo` and bare `fn-100`. Add
`PILL_COLORS["dep-on-epic-dangling"] = "error"` and verify ordering in
`colorizePillsInLine` so the per-payload entry wins over the generic
`blocked:*` → `warn` fallback.

Add an `assertNever` exhaustiveness guard to `formatReasonShort` so a
future BlockReason variant addition that forgets a case is a compile
error.

Update `README.md` per the docs-gap-scout findings: BlockReason
vocabulary split, PILL_COLORS map entry, cross-project provenance pill
format documentation, JSONL log file description.

Open question: depending on task .1's finding, keeper may need a new
`isUpstreamCompleteForCrossProjectGate(epic)` helper instead of reusing
close-row `{tag:"completed"}` — confirm at implementation start.

### Investigation targets

**Required**:
- `src/readiness.ts:108-118` — `BlockReason` union (extension point)
- `src/readiness.ts:167-260` — `computeReadiness` entry, where indexes get built alongside `taskById`
- `src/readiness.ts:392-409` — predicate 9 (focal rewrite)
- `src/readiness.ts:419-545` — `evaluateCloseRow` (predicate 9 docstring at 525-527 confirms close row has no direct epic deps; verify)
- `src/readiness.ts:744-756` — `effectiveRoot` / `stringOrNull` helpers for the resolver style
- `src/readiness.ts:889-926` — `formatPill` + `formatReasonShort` exhaustive switch (add cross-project provenance prefix here)
- `scripts/board.ts:376-379` — `epicNumFromId` (needs parallel for bare-id form)
- `scripts/board.ts:414-486` — `PILL_COLORS` + `colorizePillsInLine`
- `scripts/board.ts:669-735` — `renderEpicBlock` `[#N,#M]` summary pill
- `scripts/autopilot.ts:140-145` — readiness-client import pattern; the diagnostics drain hooks in alongside the per-frame snapshot loop
- `test/readiness.test.ts:43-172` — fixture helpers (`makeEpic`, `makeTask`, `run` wrapper); the `run()` signature MAY need to update if `computeReadiness` gains a new optional parameter
- `test/readiness.test.ts:663-690` — existing dep-on-epic predicate-ordering test (template for new cross-project tests)
- `test/readiness.test.ts:1028-1034` — `"dep-on-epic absent-from-collection counts as SATISFIED"` test to split

**Optional**:
- `src/types.ts:658-786` — `Epic` shape (especially `project_dir`, `depends_on_epics`)
- CLAUDE.md "Design stance" section — design the projection for what's true, not what consumers expect

### Risks

- The tolerant-forward-ref + dangling-on-truly-unknown split needs careful test coverage; getting the predicate-9 absent-from-perCloseRow vs absent-from-epicById distinction wrong silently mis-gates.
- `PILL_COLORS` ordering risk: if the generic `blocked:*` → `warn` fallback fires before the specific `dep-on-epic-dangling` → `error` entry, dangling deps would render amber instead of red. Verify by reading `colorizePillsInLine` end-to-end.
- The diagnostics JSONL writer races between board.ts and autopilot.ts processes. O_APPEND + single-write under PIPE_BUF is the atomic guarantee; verify each diagnostic line stays under 4 KiB (a few hundred bytes max in practice).
- fn-633 task .7 reshapes the BlockReason union and predicate 6.5 in the same file. Hard dep means this lands AFTER fn-633 — re-confirm union shape and integration point at implementation time (the dep is wired, but the line numbers above will drift).
- Adding a new optional parameter to `computeReadiness` ripples to the `run()` test helper at `test/readiness.test.ts:162-172` — update the helper signature and any callers in lockstep.

### Test notes

Unit tests in `test/readiness.test.ts` exercise the resolver and
predicate 9 directly (the established pure-function fixture pattern).
Tests in `test/board.test.ts` exercise the new `epicNumFromIdOrBare`
helper, the summary pill render with cross-project / dangling forms,
and `PILL_COLORS` lookup for `dep-on-epic-dangling`. New tests for
`src/readiness-diagnostics.ts` cover the writer's append behavior
against a tmp log path.

Manual smoke after landing: spin up keeperd with cross-project deps
wired (one keeper epic depends on an arthack epic via planctl
`epic add-deps`), confirm board renders `[arthack::#N]` provenance and
that approving the arthack upstream clears the block on the
keeper-side task. Wire a bare-id ambiguous case (two `fn-100` epics
visible) and confirm a diagnostic lands in
`~/.local/state/keeper/readiness-diagnostics.jsonl`.

## Acceptance

- [ ] `BlockReason` includes `{ kind: "dep-on-epic-dangling"; upstream: string }`; `formatReasonShort` exhaustive switch updated; `assertNever` guard added
- [ ] `ReadinessSnapshot` includes `diagnostics: ResolutionDiagnostic[]`
- [ ] `computeReadiness` builds `epicById` and `epicsByNumber` indexes alongside the existing `taskById`
- [ ] Predicate 9 implements cwd-then-global resolution with tolerant forward-ref semantics and `dep-on-epic-dangling` for truly-unknown upstream ids (bare-form AND full-form misses)
- [ ] Bare-id ambiguity: 2+ matches with cwd-first preference; only dangling + diagnostic when no same-project match disambiguates
- [ ] `formatReasonShort` renders cross-project provenance prefix (`<project>::<id>`) ONLY when consumer + upstream `project_dir`s differ
- [ ] `src/readiness-diagnostics.ts` exports `ResolutionDiagnostic` type + `appendDiagnostic(d, logPath)` writer with O_APPEND single-write semantics
- [ ] `scripts/board.ts` and `scripts/autopilot.ts` drain `snap.diagnostics` per frame and append to `~/.local/state/keeper/readiness-diagnostics.jsonl`
- [ ] Shared resolver helper exported from `src/readiness.ts` so the board's `[#N,#M]` summary pill uses the same resolution path as predicate 9
- [ ] `scripts/board.ts` `[#N,#M]` summary pill renders `[#N]` intra-project, `[arthack::#N]` cross-project, `[?#N]` dangling
- [ ] `PILL_COLORS["dep-on-epic-dangling"] = "error"`; ordering check in `colorizePillsInLine` ensures it wins over the generic `blocked:*` → `warn` fallback
- [ ] `test/readiness.test.ts` adds the full matrix of resolver outcomes (intra-project bare-id, cross-project full-id, cross-project bare-id, full-id miss, bare-id miss, 2+ matches no same-project, 2+ matches with same-project, tolerant forward-ref)
- [ ] `test/board.test.ts` adds pill rendering + color tests for the new variants
- [ ] Existing `"dep-on-epic absent-from-collection counts as SATISFIED"` test split into "tolerant forward-ref (still satisfied)" and "truly unknown upstream → dangling"
- [ ] `README.md` updated per docs-gap-scout findings (BlockReason vocabulary split + PILL_COLORS section + cross-project provenance prose + JSONL log file documentation)
- [ ] No changes to `scripts/autopilot.ts` dispatch logic (only the diagnostics drain + log line); verdict-edge logic remains untouched — verified by re-reading the per-frame loop end-to-end after the diagnostic-drain hook lands

## Done summary

## Evidence
