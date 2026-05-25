## Overview

Switch keeper's hook-time `extractPlanctlInvocation` deriver from
parsing the *input* bash command via `PLANCTL_COMMAND_RE` to parsing
the authoritative `planctl_invocation` envelope the planctl CLI emits
on every mutating call's stdout (the top-level `planctl_invocation`
key inside `data.tool_response.stdout`). Two consequences: two-word
verbs (`planctl epic close fn-N-foo`) now carry their real epic id
instead of stamping `target="close"`; and `scaffold` — the canonical
create path on this codebase, zero `epic-create` events have ever
fired — is recognized as a creator by extending the classifier
predicate. A v19→v20 migration NULL-outs every PreToolUse:Bash row's
`planctl_*` columns and re-stamps from the matching PostToolUse:Bash
rows; the per-session `jobs.epic_links` + per-epic `epics.job_links`
projections are re-derived from scratch. Outcome: 647 live epics
light up with creator (scaffold) and refiner (epic-close,
task-set-tier, …) edges on the keeper board.

## Quick commands

- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT epic_id, json_array_length(job_links) AS n FROM epics WHERE json_array_length(job_links) > 0 ORDER BY n DESC LIMIT 10"` — post-migration, this should return non-empty (today it returns zero rows across all 647 epics)
- `bun scripts/board.ts` — visual confirmation; creator/refiner lines appear indented under epic headers (the render-side commit 25f8a53 already ships the consumer)

## Acceptance

- [ ] `extractPlanctlInvocation` gates on PostToolUse:Bash and parses the `planctl_invocation` envelope from `data.tool_response.stdout`
- [ ] `PLANCTL_COMMAND_RE` and `PLANCTL_READONLY_VERBS` removed from src/derivers.ts
- [ ] Classifier creator predicate (src/plan-classifier.ts:289-294) accepts `op === "scaffold"` alongside `op === "create"`
- [ ] Hook (plugin/hooks/events-writer.ts) gates the deriver call on PostToolUse:Bash
- [ ] v19→v20 migration: Pass 0 NULL-outs PreToolUse:Bash rows; Pass 1 re-stamps from PostToolUse:Bash rows via the new deriver; Pass 2a/b replay per-session `jobs.epic_links` + per-epic `epics.job_links` re-derive; ANALYZE epilogue
- [ ] `SCHEMA_VERSION = 20` in src/db.ts
- [ ] Test fixture inversions land (notably test/events-writer.test.ts line 874 assertion flips from "PostToolUse:Bash with planctl leaves columns NULL" to "stamps columns from envelope")
- [ ] On a live keeperd reboot, the keeper board renders creator/refiner lines on existing epics
- [ ] Re-fold determinism preserved — test/reducer.test.ts:3159 rewind+DELETE+drain still green

## Early proof point

Task that proves the approach: `<epic_id>.1`. Validates that the
envelope-parse path correctly stamps `planctl_op` / `planctl_target`
/ `planctl_epic_id` on new events (no migration needed for this
proof). If the deriver shape is wrong, every downstream test fails
obviously; if the classifier predicate extension is wrong, the
`scaffold → creator` predicate test fails in isolation. Recovery:
revert the deriver rewrite (single-file undo); the classifier
extension is independent and can ship alone for partial improvement.

## References

- `.planctl/specs/fn-598-creator-refiner-from-planctl-invocations.6.md` — the canonical epic that built the original (now-being-replaced) input-command-regex deriver, `syncPlanctlLinks` fan-out, and v13→v14 backfill. Read for the original design rationale before locking the inverse fix.
- `src/db.ts:1018-1253` — v13→v14 backfill block. Structural template for the v19→v20 backfill; mirror pass shape exactly (version-guard → Pass 1 → Pass 2a → Pass 2b → ANALYZE).
- `plugin/hooks/events-writer.ts:93-109` — `extractSubagentAgentId` — the canonical precedent for a PostToolUse + `tool_response`-reading deriver. The new `extractPlanctlInvocation` mirrors its defensive-probe shape.
- `apps/cli_common/cli_common/planctl_invocations.py` — Python reference classifier. Keeper documents a deliberate TS-only divergence: scaffold-as-creator is keeper-only, the Python audit layer is unaffected.

## Docs gaps

- **README.md** (lines 32-35): the planctl_op derivation paragraph names PreToolUse:Bash + regex parsing; update to PostToolUse:Bash + envelope parsing.
- **README.md** (line 379): creator definition extends from `epic-create` to include `scaffold`.
- **CLAUDE.md** (line 65, Event-sourcing invariants): the hook-side derivers paragraph names `extractPlanctlInvocation` against PreToolUse:Bash; update to PostToolUse:Bash; delete the `PLANCTL_READONLY_VERBS` reference (envelope-presence replaces the allowlist).
- **src/derivers.ts inline JSDoc**: rewrite `PlanctlInvocation` and `extractPlanctlInvocation` JSDoc blocks; the `PLANCTL_COMMAND_RE` and `PLANCTL_READONLY_VERBS` docs vanish with their constants.
- **src/plan-classifier.ts**: update `normalizePlanctlOp` JSDoc + `ClassifierInvocation` interface JSDoc cross-references to reflect PostToolUse as the source event.
- **plugin/hooks/events-writer.ts** (line 337-343): comment block names PreToolUse:Bash + regex framing; update to PostToolUse:Bash + envelope framing.
- **src/db.ts** v13→v14 historical comments (lines 1018-1030): leave unchanged — they describe what the v14 backfill did. The new v20 block carries its own comments per the v14 style.

## Best practices

- **Use envelope-presence as the mutation sentinel, not an allowlist.** Source: practice-scout report. The CLI's own structured output is authoritative; new verbs auto-covered; verb renames create no gaps; `PLANCTL_READONLY_VERBS` allowlist (with its "every new planctl verb requires a code change to avoid misclassification" maintenance tax) becomes deletable.
- **Length-cap stdout before `JSON.parse`.** Source: practice-scout. planctl envelopes are tiny; cap at 64KB. Combined with a `startsWith('{')` pre-parse hint, near-zero cost on non-JSON Bash stdout (which is most of it).
- **Gate on exact `hookEvent === 'PostToolUse'` (not a prefix).** Source: practice-scout + Claude Code hooks docs. `PostToolUseFailure` has no `tool_response` field; a failed command's `tool_input.command` is NOT the safe fallback (re-introduces the input-coupling problem).
- **bun:sqlite #1332 still open.** Source: practice-scout (verified 2026-01). The v13→v14 backfill already uses `db.run()` (uncached) to sidestep the statement-cache invalidation bug; v20 backfill must follow the same discipline.
- **PII bound to `subject_present` boolean.** The deriver projects only the boolean (`envelope.subject != null`); subject text itself stays in `data` (the immutable event blob has always captured stdout — no new PII surface at the projection layer).

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/planctl-envelope-driven-creator-refiner` — the originating sketch that traced the root cause (two-word verb regex parse + scaffold unrecognized) and proposed the envelope-driven fix
