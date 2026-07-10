## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/events-writer.ts, src/types.ts, src/db.ts, src/reducer.ts, src/collections.ts, cli/statusline.ts, test/events-writer.test.ts, test/reducer-lifecycle.test.ts, test/collections.test.ts, test/statusline.test.ts, test/db.test.ts, test/refold-equivalence.test.ts

### Approach

Replace profile-directory-derived identity with explicit Launch attribution. The Claude launcher injects one PII-free route value (`default` or `claude-swap:<slot>`); SessionStart captures it as attacker-influenced bounded data, the event stream preserves it, and the jobs projection folds it deterministically into an `account_route` field.

Attribution describes only the process that emitted the event. It never binds a conversation, drives a later route, mutates account state, or uses email/config-directory basenames. A concise statusline label may render from the explicit value, while non-Claude and adopted jobs remain null/unknown unless they carry the same validated contract.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/events-writer.ts:150 — current `CLAUDE_CONFIG_DIR` normalization boundary
- plugins/keeper/plugin/hooks/events-writer.ts:705 — SessionStart environment capture
- src/reducer.ts:8269 — jobs SessionStart insert/update and current profile-name derivation
- src/reducer.ts:8369 — current profile projection seed coupled to SessionStart
- src/db.ts:1389 — historical jobs profile-name migration pattern
- src/db.ts:5162 — current jobs schema
- src/collections.ts:126 — jobs descriptor profile field
- cli/statusline.ts:241 — current profile label precedence and directory fallback

**Optional** (reference as needed):
- test/reducer-lifecycle.test.ts:5403 — current profile attribution and re-fold test shape
- test/events-writer.test.ts:988 — SessionStart environment fixture
- test/db.test.ts:379 — schema fingerprint pin

### Risks

Route data is environment- and hook-sourced, so it is untrusted and must be size/shape bounded. Slot numbers can be reused later; attribution must remain explicitly time-local and must not claim durable human identity. A schema task will collide with any concurrent migration and must take its version at merge time.

### Test notes

Cover default, managed, malformed, oversized, absent, resume, repeated SessionStart, adopted, and non-Claude events. Prove re-fold equivalence and that historical attribution cannot influence account selection. Pin the schema fingerprint and fresh/upgrade migration paths without booting a daemon or hook subprocess.

### Detailed phases

1. Define and validate the event carrier and hook extraction without logging the surrounding environment.
2. Append the forward-only schema step for event/job attribution, assigning its version at merge time.
3. Fold route attribution into jobs and expose it through the jobs descriptor/statusline.
4. Remove live profile-name derivation and profile projection seeding from SessionStart while preserving historical compatibility needed by task 6.

### Alternatives

Inferring identity from claude-swap session directories was rejected because those names include email-derived data and the same-account fast path has no directory. Persisting email or a credential-derived fingerprint was rejected because route attribution needs neither.

### Non-functional targets

Hook behavior remains fail-open and dependency-free. The new field is bounded, PII-free, deterministic on re-fold, and additive to old events. No schema migration reads wall clock, environment, process state, or external files.

### Rollout

Land attribution before dropping profile/usage projections so every new routed job remains explainable during the cutover. Old rows may retain historical profile fields until task 6 removes their live query surface.

## Acceptance

- [ ] Claude SessionStart events carry a bounded PII-free account route when the launcher supplied one and remain valid when it did not.
- [ ] Jobs deterministically expose `account_route` as `default`, `claude-swap:<slot>`, or null without deriving it from paths or email.
- [ ] Repeated/resumed events preserve correct per-process attribution without creating conversation affinity.
- [ ] Statusline and jobs-query output use explicit route attribution and never inspect `CLAUDE_CONFIG_DIR` for an account label.
- [ ] Old events fold safely with a null route and malformed new values cannot throw inside a fold.
- [ ] Schema fingerprint, zero-to-head migration, upgrade migration, and re-fold-equivalence tests pass.

## Done summary

## Evidence
