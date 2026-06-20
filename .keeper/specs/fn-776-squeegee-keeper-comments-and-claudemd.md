## Overview

Remove ~7,800 bloat comment lines from keeper's TypeScript (provenance ticket refs, incident narration, blocks restating code) and compress CLAUDE.md from 348 to ~120 lines, in provably comment-only diffs. A token-level verifier script gates every scrub. Net behavior change: zero.

## Scrub standard

DELETE: ticket/epic ids (fn-NNN) and incident dates; "supersedes/formerly/used to" history; narration blocks that restate the code below them (state-machine tables, boot-sequence walkthroughs, per-column schema origin stories, per-constant essays); comments restating what an identifier already says.
KEEP: any comment stating a constraint the code cannot show. The sacred list below is a FLOOR, not a whitelist — src/ carries ~256 invariant-style markers beyond it. If uncertain whether a comment is load-bearing: KEEP IT. Compress kept constraints to their minimal future-facing form (no ids, no dates).
NEVER TOUCH: the 5 biome-ignore directives (src/plan-worker.ts:2157, plugin/hooks/events-writer.ts:654, src/derivers.ts:179, src/derivers.ts:452, src/readiness-client.ts:690) — leave their lines and the line between directive and code unedited. Trailing same-line comments may be deleted but the code portion of the line stays byte-identical.
NEVER: rewrite, reorder, or "improve" code while scrubbing. Any token-sequence change = task failure; fix by reverting that file and re-scrubbing, at most once, then escalate.

## Sacred constraints (KEEP floor)

1. Re-fold determinism: never read wall-clock/env/fs/process-liveness inside a fold; use the event's ts (reducer.ts)
2. Cursor + projection advance in ONE BEGIN IMMEDIATE transaction — the exactly-once guarantee (reducer.ts)
3. Never throw inside a fold — malformed data folds to a safe value; a throw wedges the reducer (reducer.ts)
4. Hook always exits 0 — non-zero can fail-closed the human's session (plugin/hooks)
5. Hook never imports bun:sqlite/db.ts — cold-start budget; a stray db.ts symbol re-drags the 6.5k-line module (plugin/hooks)
6. Readiness predicate rank order is load-bearing — reordering silently breaks autopilot (readiness.ts)
7. UNIT TRAP: cooldown/guard constants are SECONDS; never compare against *_TTL_MS values (autopilot-worker.ts — keep ONCE, prominently)
8. Ordering chain ceilingMs (60s) < PENDING_DISPATCH_TTL_MS (120s) < REDISPATCH_COOLDOWN_S (200s) is load-bearing (autopilot-worker.ts)
9. No kernel watchers on keeper's OWN DB — FSEvents drops same-process/WAL writes; data_version polling only; external trees are the carve-out (git-worker/db)
10. SCHEMA_VERSION bumps must update SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the same commit (db.ts)
11. Paired-NULL invariants: (last_api_error_at, last_api_error_kind) and sibling pairs move together — write both or clear both (types.ts)
12. Worker owning an external resource must release it in its own shutdown handler; supervisor only terminates (daemon.ts)

## Verification recipe (every scrub task)

1. Scrub the file(s)
2. `bun scripts/assert-comment-only.ts <files>` — token-sequence equality vs `git show HEAD:<path>`, transpile-output equality, protected-pattern counts not decreased
3. `biome check --write <touched files>` (plugin/ files: invoke biome on the explicit path — plugin/ is OUTSIDE the lint roots, tsconfig, and commit-work's lint arms; the verifier is the only gate there)
4. Re-run the verifier post-format (the committed bytes must be the verified bytes)
5. `bun run typecheck` green; `bun run test:full` — run once pre-scrub to baseline, post-scrub run must add ZERO new failures
6. `keeper commit-work` — one commit per task, deleted-line count in the message body

## Quick commands

- `bun scripts/assert-comment-only.ts src/reducer.ts` — prove a scrub is comment-only
- `wc -l CLAUDE.md` — compression target <= 130

## Acceptance

- [ ] Verifier script exists with fixture tests; gates all scrub tasks including plugin/
- [ ] All six scrub clusters land with verifier + typecheck + biome + test:full green and zero new test failures
- [ ] All 5 biome-ignore directives survive on their original code lines
- [ ] CLAUDE.md <= 130 lines, AGENTS.md symlink intact, zero fn-NNN ids and incident dates in kept text
- [ ] Every task's Done summary reports comment lines and characters deleted (scoreboard)

## Early proof point

Task that proves the approach: ordinal 1 (the verifier). If it fails: fall back to transpile-output comparison plus protected-pattern grep as the gate and proceed with extra reviewer scrutiny on cluster diffs.

## References

- Verifier approach: TypeScript createScanner(skipTrivia) token comparison; ts.transpileModule equality as second check
- `src/commit-work/lint-matrix.ts` — why plugin/ escapes the commit-time lint arms
- README `## Architecture` already owns the system narrative — CLAUDE.md content duplicated there is DELETED, not moved

## Docs gaps

- **README.md**: both cross-references into CLAUDE.md (the `## Test isolation` pointer near l.550 and any other `CLAUDE.md` mention) must still resolve after compression — prune the pointer if the target section changed

## Best practices

- **If uncertain, keep:** uncertainty resolves toward preservation, never deletion
- **Reviewer signal:** `git diff -w` on a scrub commit should show no `+` lines beyond blank-line normalization
- **No helpful reformulation:** comment scrubs never touch code style, names, or structure — that is a different epic
