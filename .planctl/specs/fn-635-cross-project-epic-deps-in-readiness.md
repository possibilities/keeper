## Overview

Adapt keeper to planctl's fn-600 cross-project epic dependency model. The
fn-600 change introduces bare `fn-N` dep ids in `epic.depends_on_epics`
that resolve cwd-then-global across configured roots, plus a
`blocked_dangling` vs `blocked_pending` split on the planctl side. Today
keeper's predicate 9 in `src/readiness.ts:398-409` looks up upstream by
full epic_id and silently treats an absent match as satisfied — a stored
bare `fn-100` (or a typo'd full id) misses the lookup and the dep gate
passes incorrectly. This epic adds a cwd-then-global resolver inside
`computeReadiness`, introduces a `dep-on-epic-dangling` BlockReason
variant (red pill, distinct from amber pending), shows project provenance
in the row pill only when cross-project, surfaces ambiguous-id cases via
a JSONL diagnostics channel on `ReadinessSnapshot`, and updates the
dashctl board summary pill and color map to match.

## Quick commands

- `bun test test/readiness.test.ts test/board.test.ts` — runs the new + existing readiness and board test coverage end-to-end
- `tail -f ~/.local/state/keeper/readiness-diagnostics.jsonl` — watch for ambiguous-id resolution diagnostics emitted by board/autopilot

## Acceptance

- [ ] `src/readiness.ts` predicate 9 resolves bare `fn-N` upstream ids cwd-then-global against an in-snapshot epics index built inside `computeReadiness`
- [ ] Tolerant forward-ref semantics: known-but-not-yet-evaluated upstream → satisfied; truly unknown upstream → `dep-on-epic-dangling`; full-id misses ALSO → dangling (fixes the pre-existing latent bug)
- [ ] Cwd-first ambiguity preference: when a bare id matches multiple epics, prefer the consumer epic's `project_dir`; only flag as dangling when 2+ matches AND no same-project match
- [ ] `BlockReason` gains `{ kind: "dep-on-epic-dangling"; upstream: string }`; `formatReasonShort` exhaustive switch updated; `assertNever` exhaustiveness guard added
- [ ] Cross-project resolved deps render `[blocked:dep-on-epic <project>::<full-id>]`; intra-project keeps existing form
- [ ] `ReadinessSnapshot` gains `diagnostics: ResolutionDiagnostic[]`; ambiguous-id resolution emits one diagnostic per occurrence per snapshot
- [ ] New `src/readiness-diagnostics.ts` module exports the `ResolutionDiagnostic` type + an `appendDiagnostic(d, logPath)` writer (single O_APPEND write, atomic under PIPE_BUF)
- [ ] `scripts/board.ts` and `scripts/autopilot.ts` drain `snap.diagnostics` per frame and append to `~/.local/state/keeper/readiness-diagnostics.jsonl`
- [ ] `scripts/board.ts` `[#N,#M]` summary pill renders `[#N]` intra-project, `[arthack::#N]` cross-project, `[?#N]` dangling — using a shared resolver helper exported from `src/readiness.ts` so summary pill and row pill agree
- [ ] `PILL_COLORS["dep-on-epic-dangling"] = "error"` (red); check ordering in `colorizePillsInLine` ensures the per-payload entry wins over the generic `blocked:*` → `warn` fallback
- [ ] `test/readiness.test.ts` coverage matrix: intra-project bare-id resolved, cross-project full-id resolved, cross-project bare-id resolved (cwd-then-global), full-id miss → dangling, bare-id miss → dangling, 2+ matches no same-project → dangling + diagnostic, 2+ matches with same-project → satisfied (cwd-first wins), tolerant forward-ref still satisfied
- [ ] `test/board.test.ts` coverage: `[arthack::#N]` cross-project provenance render, `[?#N]` dangling render, `dep-on-epic-dangling` colors red via `colorizePillsInLine`
- [ ] Existing `test/readiness.test.ts:1028-1034` `"dep-on-epic absent-from-collection counts as SATISFIED"` test split into "tolerant forward-ref (still satisfied)" and "truly unknown upstream → dangling"
- [ ] `README.md` BlockReason vocabulary + PILL_COLORS sections describe the dep-on-epic / dep-on-epic-dangling split, cross-project provenance pill format, and the new JSONL diagnostics log file
- [ ] No changes to `scripts/autopilot.ts` dispatch logic (only the diagnostics drain + log line); verdict-edge logic remains untouched
- [ ] Verification task .1 confirms (or documents the delta on) keeper's close-row `{tag:"completed"}` verdict against planctl's `derive_epic_runtime_status == "complete"` semantic

## Early proof point

Task that proves the approach: `<epic_id>.2` (the implementation). If it
fails: the cwd-then-global resolver via in-snapshot index doesn't compose
cleanly with the forward-ref tolerance; fall back to a two-pass design
where all close-row verdicts are computed before dep evaluation (mirror
the existing `applySingleTaskPerEpicMutex` / `applySingleTaskPerRootMutex`
post-pass shape).

## References

- arthack fn-600 spec — `/Users/mike/code/arthack/.planctl/specs/fn-600-cross-project-epic-dependencies.md`
- Pulumi StackReference `getOutput` vs `requireOutput` — design template for `dep-on-epic` vs `dep-on-epic-dangling` split
- Nx task pipeline + Turborepo/Bazel label resolution — fail-at-graph-construction precedents for unresolvable / ambiguous ids
- `src/readiness.ts:108-118` — existing `BlockReason` union (extension point)
- `src/readiness.ts:392-409` — predicate 9 (focal latent bug)
- `src/readiness.ts:889-926` — `formatPill` + `formatReasonShort` (exhaustive switch)
- `scripts/board.ts:376-379` — `epicNumFromId` regex (needs parallel for bare-id form)
- `scripts/board.ts:414-486` — `PILL_COLORS` + `colorizePillsInLine` (insertion point for red bucket entry)
- `scripts/board.ts:669-735` — `renderEpicBlock` `[#N,#M]` summary pill
- `src/types.ts:682` — `Epic.depends_on_epics` (string array, no schema change needed)
- `fn-633` (overlap) — fn-633 tasks .7 and .8 touch `src/readiness.ts` and `scripts/board.ts` in the predicate 6.5 / git-orphans rewrite; hard dep so this lands after fn-633's union shape stabilizes
- `scripts/autopilot.ts:140-145` — readiness-client import pattern; autopilot consumes `Verdict` snapshots and reacts to verdict edges (no dispatch logic change needed in this epic)

## Docs gaps

- **`/Users/mike/code/keeper/README.md`**: revise the BlockReason vocabulary section to add `dep-on-epic-dangling` (red) alongside `dep-on-epic` (amber); note bare `fn-N` cwd-then-global resolution semantics; document the `[arthack::#N]` cross-project provenance pill format on the epic header summary pill; document the new `~/.local/state/keeper/readiness-diagnostics.jsonl` log file and its record shape. Consolidate the existing PILL_COLORS prose paragraph rather than appending — three distinct edit sites, one coherent rewrite per docs-gap-scout

## Best practices

- **Discriminated `BlockReason` variant, not sentinel upstream:** `dep-on-epic-dangling` is its own variant carrying `upstream: string`. Folding it into `dep-on-epic` with a magic upstream value would force every consumer to re-distinguish via string-matching. [Pulumi StackReference]
- **Build the resolver index O(1) inside `computeReadiness`:** mirror the existing `taskById` pattern at `src/readiness.ts:205-212`. Don't re-walk on every dep iteration.
- **Resolver return is a discriminated union, not nullable string:** `{ kind: "found"; resolvedId; project } | { kind: "dangling" }` gives predicate 9 and the board renderer structured outcomes without re-running the lookup. [practice-scout]
- **No I/O inside `computeReadiness`:** the diagnostics channel is a returned data field; callers do the JSONL append. Preserves the pure-function contract that `test/readiness.test.ts` enforces.
- **Single-write atomic append to JSONL:** open with `O_APPEND`, write one line under PIPE_BUF (4 KiB). Concurrent appends from board.ts and autopilot.ts processes are safe without flock. [POSIX guarantee]
- **`assertNever` exhaustiveness guard:** add a `default: { const _: never = reason; return "unknown"; }` arm to `formatReasonShort` so future BlockReason variants fail at compile-time rather than silently rendering `unknown`.
