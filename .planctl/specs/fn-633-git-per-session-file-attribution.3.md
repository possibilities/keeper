## Description

**Size:** M
**Files:** src/derivers.ts, plugin/hooks/events-writer.ts, src/db.ts (migration backfill step), test/derivers.test.ts

### Approach

New pure deriver `extractBashMutation(hookEvent, toolName, data, cwd)` in `src/derivers.ts` returning `{ kind: 'pkg-install' | 'pkg-uninstall' | 'fs-remove' | 'fs-move' | 'fs-copy' | 'fs-mkdir' | 'git-tree-mutate', targets: string[] } | null`. Gated on `(PostToolUse, Bash)`. Tokenization is a small POSIX-shell-ish splitter (single/double-quote-aware; backslash escapes; no AST, no subshells, no env-assignment expansion — `KEY=VAL pnpm i` is recognized by stripping `^[A-Z_]+=...` env-prefix tokens). Pattern table covers (hardcoded canonical paths, not arg parsing):

- **Package managers:** `pnpm (install|i|add|remove|rm)` → `<cwd>/package.json`, `<git-root>/pnpm-lock.yaml`. Same shape for `npm`, `yarn`, `bun`, `uv`, `pip`, `cargo`, `poetry` with their respective lockfile/manifest names.
- **Explicit fs:** `rm`, `mv`, `cp`, `mkdir` → resolved paths from argv (relative→absolute against `cwd` from event), tilde NOT expanded (lexical only — no realpath, no filesystem hit per hook payload-only invariant).
- **Git tree-mutators:** `git checkout`, `git restore`, `git stash`, `git reset` (when no pathspec arg follows) → tree-wide sentinel `__TREE__` in targets. With a pathspec, stamp the literal pathspec (we don't expand globs).

Hook write-path wires the deriver at `plugin/hooks/events-writer.ts:354-400` alongside existing `slash_command` / `skill_name` / `planctl_*` derivers. Stamps `bash_mutation_kind` (string or NULL) and `bash_mutation_targets` (JSON array string or NULL). Bound by the named-binding INSERT at `plugin/hooks/events-writer.ts:439-475`.

**Migration backfill** inside the v30→v31 migrate() block (after the ALTER, before the rewind): same-transaction `SELECT id, hook_event, tool_name, cwd, data FROM events WHERE tool_name='Bash' AND hook_event='PostToolUse'` → for each row, re-derive via `extractBashMutation()` → `UPDATE events SET bash_mutation_kind = ?, bash_mutation_targets = ? WHERE id = ?`. Mirror the v25→v26 / v28→v29 / v29→v30 backfill precedent (db.ts:2329-2415). The backfill MUST produce identical values to the hook-stamped values for new rows — same deriver function, both call sites.

Synthetic-event lift sites (~26 named bindings across `src/daemon.ts:694-720`, `:790-816`, transcript-worker, plan-worker, seed-sweep, exit-watcher per repo-scout) need `bash_mutation_kind` / `bash_mutation_targets` passed as `null` (synthetic events are never Bash hooks).

### Investigation targets

**Required:**
- src/derivers.ts:1-39 — module conventions (regex literals at module scope, defensive shape-checks, never throws)
- src/derivers.ts:385-455 — `extractPlanctlInvocation` — closest analogue (gated on PostToolUse:Bash, parses `tool_input.command`, returns null on no match, length cap, type checks, never throws)
- src/derivers.ts:192-200 — `extractToolUseId` — pure ungated deriver shape template
- plugin/hooks/events-writer.ts:354-400 — deriver call-site pattern
- plugin/hooks/events-writer.ts:439-475 — `stmts.insertEvent.run({...})` named-binding INSERT
- src/db.ts:2329-2415 — v25→v26 / v28→v29 / v29→v30 backfill+rewind precedent
- src/db.ts:2462-2491 — `insertEvent` prepared statement (widen named bindings to include new columns)
- src/daemon.ts:694-720, :790-816 — synthetic-event lift sites that need `bash_mutation_kind: null, bash_mutation_targets: null` added
- practice-scout findings: hardcoded canonical lockfile path table per package manager (avoid arg parsing); don't realpath (filesystem hit); ignore compound `&&` chains in v1 (fall through to inferred-attribution)

### Risks

- Tokenization edge cases: heredocs (`<<EOF`), `$()`/backtick subshells, brace expansion (`mkdir {a,b}`), and quoting boundaries. Accept incompleteness — uncovered patterns fall through to inferred-attribution via mtime bracketing (task 6).
- `cwd` at hook time vs cwd in compound (`cd foo && rm bar`): the hook payload's `tool_input.command` is the raw shell command, but `events.cwd` is the cwd at hook fire — which is the cwd of the BASH process, not necessarily the cwd at the moment `rm` ran inside the compound. Accept this — compound commands degrade gracefully to inferred.
- Backfill performance on large event logs: thousands of historical Bash events. Run inside the migrate() transaction, but bench against a realistic event count to ensure boot doesn't wedge. If >5s, log progress.
- Determinism across deriver changes: a future bugfix to `extractBashMutation` would re-derive different values from stored events, breaking byte-identical re-fold. Document this as a known constraint — deriver changes require a schema-bump-with-rewind to re-backfill (same as planctl envelope precedent at v25→v26).

### Test notes

test/derivers.test.ts: ~30-40 new cases covering pkg managers (each kind × install/uninstall/add/remove), explicit fs (`rm -rf path`, `mv a b`, `cp -r src dst`, `mkdir -p deep/nested`), git tree-mutators (with and without pathspecs), negative cases (`pnpm test`, `git status`, `cat file.txt` — must return null), tokenization edge cases (quoted paths with spaces, env-prefix `K=V cmd`, leading `--`). Round-trip: hook-stamped value === backfill-re-derived value for the same event row.

## Acceptance

- [ ] `extractBashMutation()` exported from src/derivers.ts; module-scope regex/table literals; defensive null returns; never throws
- [ ] Hook write-path stamps `bash_mutation_kind` + `bash_mutation_targets` on every `PostToolUse:Bash` event row
- [ ] Migration backfill re-derives same values for every existing Bash event row inside the v30→v31 transaction
- [ ] ≥30 test cases in test/derivers.test.ts cover happy paths + null branches + tokenization edge cases + round-trip determinism
- [ ] Synthetic-event lift sites (daemon + transcript-worker + plan-worker + seed-sweep + exit-watcher) pass `null` for both new columns
- [ ] Hook still exits 0 on a malformed Bash command (defensive guard at events-writer.ts:486-493 catches deriver-side throws — but the deriver itself must not throw on any input)

## Done summary

## Evidence
