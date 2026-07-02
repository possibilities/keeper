## Description

**Size:** M
**Files:** src/dispatch-failure-pill.ts (new), src/board-render.ts, cli/board.ts, cli/status.ts, test/dispatch-failure-pill.test.ts (new), test/board.test.ts, test/status.test.ts

Overlay sticky `dispatch_failures` reasons as board + status pills via one shared
pure module, closing Gap A (worktree-key join miss) and Gap B (work-failures never
surfaced). Render-layer only — do NOT touch `computeReadiness`, the reconciler,
`await-conditions`, folds, the DB schema, or the RPC protocol.

### Approach

1. **New pure module `src/dispatch-failure-pill.ts`** (must live in `src/` and import
   ONLY pure `src/` helpers — no `bun:sqlite`, no `icon-theme`/color, so `cli/status.ts`
   can import it without dragging TTY deps). Export two functions:
   - `classifyDispatchFailure(reason: string): string` — ordered most-specific-first
     prefix rules (NOT substring-contains): `worktree-multi-repo`→`multi-repo`;
     `worktree-finalize-conflict`/`worktree-recover-conflict`/`worktree-merge-conflict`→`merge-conflict`;
     `worktree-recover-dirty-checkout`→`dirty-tree`; `worktree-finalize-non-fast-forward`→`non-ff`.
     Fallback = the leading token before the first `:`/whitespace (reproduce the current
     `reason.split(/[:\s]/,1)[0]` behavior exactly); if that is empty, use `unknown`. NEVER
     throw, NEVER return an empty string (practice-scout: no bare `failed:` pill).
   - `resolveFailureTarget(row: {verb,id,dir}, epicIds: readonly string[]): {kind:'task',taskId:string} | {kind:'epic',epicId:string} | null`.
     For `verb==='work'`: `id` is the task id verbatim → `{kind:'task', taskId:id}`. For
     `verb==='close'`: strip a leading `worktree-finalize:`/`worktree-recover:` prefix; a
     remainder starting with `/` is a null-epic (path-keyed) row → return `null` (pill
     dropped). Otherwise match the epic: PRIMARY = boundary-checked longest-match against
     `epicIds` (sort length-desc, require the char after the matched id to be `-`/`:`/end
     so `fn-106` never matches a `fn-1061` key); pull the boundary/delimiter set into a
     named const. OPTIONAL hardening only if `repoDirHash` (`src/worktree-plan.ts:197`) is
     cleanly importable without heavy deps: strip the exact `-<repoDirHash(dir)>` suffix for
     a deterministic epic id — if importing it would pollute the pure module, skip it and
     rely on the boundary-checked match. Zero match → return `null` (warn+continue upstream;
     never throw). `bare close::<epic>` (id === an epicId) resolves to that epic directly.
2. **`src/board-render.ts`**: rename `renderCloseFailurePill`→`renderDispatchFailurePill`
   (reason-generic; used by both the close row and the new task line) and route its kind
   through `classifyDispatchFailure` instead of the inline split. Update the doc comment
   (drop the close-only framing). No colorizer/glyph change — `failed:*`→red (`:610`) and
   the `failed:` glyph catch-all already cover the new kinds.
3. **`cli/board.ts`**: in the SAME `dispatch_failures` `onRows` pass (~`:864-874`), keep
   building `closeFailures` but ALSO build a sibling `workFailures: Map<taskId,reason>`
   (declared next to `closeFailures` at `:474`, same clear+rebuild identity discipline —
   mutate in place, never reassign). Route BOTH through `resolveFailureTarget`. CRITICAL:
   mutate both maps BEFORE the `emitFrame(lastSnap)` re-emit (`:875-888`), because
   `reportSnapshotStream` can synchronously resolve the 4th-of-four snapshot latch — do NOT
   add a second subscription (no 5th latch/race). At the close render (`:675`) resolve the
   epic's failure via the resolver (not the bare `.get(epicId)`); append
   `renderDispatchFailurePill` for the work failure to `taskPillSeg` (`:646`) so it sits
   inline next to `[ready]`. Update the import (`:49`).
4. **`cli/status.ts`**: add `dispatch_failure: string[]` to `VerdictView`/`TaskView`/`EpicView`
   (`:100-113`); in `buildStatusEnvelope` (`:194-215`) derive it from the `dispatchFailures`
   arg it ALREADY receives (`:197`, currently only counted at `:225-228`) — resolve each row
   to its task/epic, classify, and collect sorted-unique kinds per target (`[]` when none) on
   the task views and the close view. Bump `STATUS_SCHEMA_VERSION` 1→2 (`:45`). Leave
   `verdict`/`pill`/`counts` untouched (readiness semantics). Import from the new pure module,
   NOT from `board-render`. Update the HELP prose + add a jq example.
5. **Docs**: `cli/board.ts` HELP one-liner (pill + vocab); `cli/status.ts` HELP prose + jq
   example (already code-adjacent). Optional low-pri `plugins/keeper/skills/autopilot/SKILL.md:219`.
   Do NOT touch CLAUDE.md.

### Investigation targets

**Required** (read before coding):
- cli/board.ts:474,646,675,864-888,49 — closeFailures decl / taskPillSeg append / close lookup / the onRows builder + snapshot re-emit latch ordering / the import.
- src/board-render.ts:460-466 — renderCloseFailurePill body (rename target); :58 `pill()`; :597-618 bucketForToken (`failed:*`→red already present); :25 icon-theme import + the "imports ONLY from src/" module rule; :324 import-stability note.
- cli/status.ts:45,55,100-113,158-162,194-215,225-228,426-436 — schema const, FINALIZE_NON_FF_REASON, view interfaces, verdictView shaper, the board.map, current dispatchFailures use, the out-of-band fetch (failures arrive as the pure builder's 3rd arg).
- src/db.ts:1092-1102 — dispatch_failures schema (verb,id,reason,dir; PK(verb,id)).
- test/board.test.ts:1851-1885 (renderCloseFailurePill suite → rename+extend for short vocab), :1274-1277 (colorizer failed:* fallback covers new kinds), :46 (import).
- test/status.test.ts:116-293 — buildStatusEnvelope describe + fixture harness (calls with a failures array at :136/:195); imports `Row` from ../src/protocol.
- test/dispatch-command.test.ts:57-63 — null-epic recover key forms (abs-path/slug) for resolver test fixtures.

**Optional** (reference as needed):
- src/worktree-plan.ts:197 — exported `repoDirHash` (only if cleanly importable for the optional exact-strip; else skip).
- plugins/plan/src/verbs/ready.ts:47 — existing `blocked_by: string[]` (naming-collision context).
- CLAUDE.md Autopilot section — the single source of truth for the key grammar + reason literals; pin the exact mint-site strings from there / the worktree-reconcile module rather than trusting a source grep alone (the strings are template-built and easy to miss).

### Risks

- **Resolver false-attribution**: `<epic>-<repoHash>` is not uniquely invertible from the id string; null-epic recover keys embed a worktree path containing `keeper/epic/<epicId>`. Mitigate: `/`-leading remainder → null; boundary-checked longest-match; optional exact `repoDirHash(dir)` strip. Wrong pill is cosmetic (render-only) — never gate dispatch on it.
- **Snapshot-latch race**: adding a second subscription for work failures would add a 5th latch report + a race. Extend the existing onRows; mutate both maps before emitFrame.
- **Existing-test drift**: test/board.test.ts:1861-1884 pins the OLD long tokens (`failed:worktree-merge-conflict`, `failed:worktree-finalize-non-fast-forward`) and the empty-reason case (:1856-1858). The short vocab changes these — update them, and reconcile the never-empty-token rule with the empty-reason test.
- **Over-collapse**: keep `non-ff`/`dirty-tree`/`multi-repo` distinct from `merge-conflict` — they route to different operator actions.

### Test notes

- New `test/dispatch-failure-pill.test.ts`: classifier map (each vocab entry + fallback + empty/`:`-leading reason) and resolver (work=verbatim; bare close::<epic>; worktree-finalize/recover key→epic; the fn-106 vs fn-1061 boundary case with a multi-epic id set; `/`-leading null-epic → null; zero-match → null).
- Rename+extend the board pill suite; add board fixtures for a worktree-finalize close pill and a ready-task work pill.
- Extend buildStatusEnvelope tests with a `close::worktree-finalize:<epic>-<hash>` row and a `work::<task>` multi-repo row, asserting `dispatch_failure` (sorted-unique, `[]` when clean) on close + task views and `schema_version === 2`.

## Acceptance

- [ ] `src/dispatch-failure-pill.ts` is pure (no bun:sqlite / icon-theme / color imports); `classifyDispatchFailure` maps the short vocab via ordered prefixes, never throws, never returns empty (unknown→leading token→`unknown`).
- [ ] `resolveFailureTarget` returns the task for `work::`, the epic for `close::` (bare + worktree-prefixed), `null` for `/`-leading/null-epic and zero-match; boundary-checked so `fn-106` never matches an `fn-1061` key.
- [ ] `renderCloseFailurePill`→`renderDispatchFailurePill` renamed and routed through the classifier; imports updated in cli/board.ts (:49) and test/board.test.ts (:46).
- [ ] `keeper board`: worktree finalize/recover conflict → `[failed:merge-conflict]` on the close row; a `work::`-blocked ready task → `[ready] [failed:multi-repo]` inline. Both maps rebuilt in one onRows pass before emitFrame; no second subscription.
- [ ] `keeper status`: `dispatch_failure: string[]` (sorted-unique kinds, `[]` when clean) on task + close views; `STATUS_SCHEMA_VERSION` 1→2; `StatusData` interface + HELP prose + jq example updated. verdict/pill/counts unchanged.
- [ ] cli/board.ts HELP gains the pill/vocab one-liner. CLAUDE.md untouched.
- [ ] `bun test` (board + status + new module suites), `bun run typecheck`, `bunx biome check` all green.

## Done summary
Added pure src/dispatch-failure-pill.ts (classifier + key->target resolver) and wired the board TUI + keeper status to overlay sticky dispatch_failures as [failed:<kind>] pills / dispatch_failure: string[] (schema v2). Closes Gap A (worktree-key join) and Gap B (work:: failures); render-only.
## Evidence
