## Description

**Size:** S
**Files:** plugin/.claude-plugin/plugin.json, plugin/hooks/hooks.json, plugin/hooks/events-writer.ts

### Approach

`plugin/.claude-plugin/plugin.json` declares the plugin (`name`, `description`, `version`, `author`) following the shape of `arthack/apps/hookctl/.claude-plugin/plugin.json`. `plugin/hooks/hooks.json` registers `${CLAUDE_PLUGIN_ROOT}/hooks/events-writer.ts` against all 10 hook events captured by the brief: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`, `Notification`, `SubagentStart`, `SubagentStop`.

`events-writer.ts` has `#!/usr/bin/env bun` shebang. It:
1. Reads JSON from stdin (single payload, blocking).
2. Derives `event_type` via a `_TYPE_MAP` for the half-dozen renames + snake_case fallback (mirror `hooks-tracker.py:60-64` and the derivation at `:1088-1093`).
3. Sets `pid = process.ppid` on the row (informational only — matches `os.getppid()` semantics).
4. Calls `openDb()` from `src/db.ts` (writer flags), wraps a `BEGIN IMMEDIATE; INSERT INTO events …; COMMIT` via `db.transaction(fn)` or explicit `db.exec("BEGIN IMMEDIATE")` for safety (per practice-scout: avoid the lock-upgrade `SQLITE_BUSY` path).
5. **On any failure, log to stderr and exit 0.** Per locked decision: hook never blocks Claude. Losing one event is acceptable; wedging the agent is not.
6. Imports ONLY from `bun:sqlite` and `src/db.ts` / `src/types.ts` — no third-party deps; keep cold start tight.

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/hookctl/.claude-plugin/plugin.json` — plugin manifest shape
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks.json` — hooks.json shape
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:1071-1170` — main body template: stdin parse → event_type derive → INSERT → exit
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:60-64` — `_TYPE_MAP` for hook→event_type renames
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:285-290` — `_INSERT` SQL shape

**Optional** (reference as needed):
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) — hook event timeout caps (UserPromptSubmit 30s, SessionEnd 1.5s)

### Risks

- Bun cold start (~30ms vs python3 -S ~10ms) means each hook invocation is a measurable cost. Keep the script's import graph minimal — only `bun:sqlite` (via `src/db.ts`), no `fs/promises` heavyweights, no `process.argv` parsing libs, no shelling out to `ps` or any other subprocess.
- The `SessionEnd` hook has a 1.5s timeout. If a write blocks on `SQLITE_BUSY` past that, the event is lost AND the hook gets killed mid-INSERT. `busy_timeout = 5000` is the safety net — but combined with the 1.5s SessionEnd cap, the daemon should be designed not to hold the writer lock long enough to bite.
- DROP the old `RUNNING_IN_PRISE` gate, all UDS fan-out (`_emit_insert`/`_emit_update`/`_flush_mutations`), and any `_capture_*` calls. The hook is a pure events writer.

### Test notes

- Smoke: `echo '{...}' | bun plugin/hooks/events-writer.ts` against a tmp DB, then read back via SQLite and assert one row landed.
- Full end-to-end coverage lives in task 7's integration test.

## Acceptance

- [ ] `plugin.json` declares name, description (verb-phrase), version
- [ ] `hooks.json` registers `events-writer.ts` against all 10 brief hook event types
- [ ] `events-writer.ts` reads stdin JSON, INSERTs one row per invocation with all 15 columns populated where present in payload
- [ ] Hook exits 0 on success AND on any error (with stderr log on error)
- [ ] No imports beyond `bun:sqlite` + project-local files
- [ ] `pid = process.ppid` recorded on every row

## Done summary
Added keeper plugin manifest, hooks.json registering all 10 v1 hook events, and events-writer.ts that INSERTs one row per hook invocation with all 15 columns populated; always exits 0 with stderr log on failure.
## Evidence
