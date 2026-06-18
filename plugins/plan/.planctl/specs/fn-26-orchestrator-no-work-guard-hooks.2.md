## Description

**Size:** M
**Files:** package.json (new), biome.json (new), bun.lock (new), plugin/hooks/lib.ts (new), plugin/hooks/commit-guard.ts (new stub), plugin/hooks/subagent-stop-guard.ts (new stub), plugin/hooks/stop-guard.ts (new stub), hooks/hooks.json, tests/test_generated_guard_hook.py, test/lib.test.ts (new)

### Approach

Make the repo polyglot following keeper's layout: root package.json (name, `lint` script running biome check, `test` script running bun test), biome.json, bun.lock. The `lint` script is what the commit gate's npm-lint pass discovers — verify a staged .ts change actually runs it.

`plugin/hooks/lib.ts` owns the shared dispatcher primitives: `readStdin()` via `new Response(Bun.stdin.stream()).text()`; `readMarker(sessionId)` implementing the epic-spec marker contract read side (stale >7d → unlink, return null); `isBypassed()` checking PLANCTL_GUARD_BYPASS; `runPlanctl(args)` subprocess helper with timeout returning parsed last-line JSON or null (fail open); typed emitters for the PreToolUse deny envelope and the top-level Stop/SubagentStop block decision; stdout discipline (exactly one JSON object or nothing, diagnostics to stderr).

Ship the three dispatchers as fail-open stubs (read stdin, exit 0) and register everything in hooks/hooks.json in this task so tasks 3–5 never touch the shared registry: extend the existing PreToolUse array with a Bash-matcher exec-form entry → commit-guard.ts; add SubagentStop with matcher `plan:worker-medium|plan:worker-high|plan:worker-xhigh|plan:worker-max` → subagent-stop-guard.ts; add Stop (no matcher) → stop-guard.ts. All entries exec form (`command: "bun"`, `args: ["${CLAUDE_PLUGIN_ROOT}/plugin/hooks/<file>.ts"]`). Update the index/shape assertions in tests/test_generated_guard_hook.py deliberately; keep the co-location regression test green.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/package.json, /Users/mike/code/keeper/biome.json, /Users/mike/code/keeper/hooks/hooks.json — the polyglot model: scripts, biome config, exec-form hook entries
- hooks/hooks.json — existing PreToolUse Write|Edit guard + PostToolUse Read warn entries; EXTEND arrays, never clobber
- tests/test_generated_guard_hook.py — wiring assertions that will shift; subprocess-stdin test harness pattern
- plugin/hooks/pre-hook.py:50-78 — the established dispatcher discipline the TS lib mirrors (stdin once, fail open, one envelope)

**Optional** (reference as needed):
- /Users/mike/code/arthack/claude/arthack/hooks/ — shared-lib + per-event dispatcher shape (inspiration only)
- https://code.claude.com/docs/en/plugins-reference.md — ${CLAUDE_PLUGIN_ROOT} resolution, exec vs shell form

### Risks

- hooks are snapshotted at session start — a live session won't see new hooks.json entries; verification is fixture/subprocess-based plus a documented restart note
- The SubagentStop matcher regex against colon-namespaced agent types is doc-supported but empirically unverified — if matching fails, fall back to no matcher + agent_type check inside the dispatcher (keep this fallback in mind in the dispatcher stub contract)
- biome and ruff must not fight: biome scoped to .ts only

### Test notes

bun test for lib.ts units (marker read contract incl. stale-unlink, bypass check, envelope shapes). Pytest slow-bucket subprocess test per stub: pipe fixture stdin, expect exit 0 and empty stdout. Wiring tests assert all five hooks.json entries, exec form, and co-location.

## Acceptance

- [ ] `bun test` passes; `bun run lint` (biome) passes and is discoverable from package.json by the commit gate
- [ ] hooks/hooks.json registers commit-guard (PreToolUse, Bash matcher), subagent-stop-guard (SubagentStop, four plan:worker-* types), stop-guard (Stop), all exec-form with ${CLAUDE_PLUGIN_ROOT}, existing guard entries intact
- [ ] All three stubs read stdin and exit 0 silently on every fixture; lib.ts readMarker honors the task-1 schema byte-for-byte
- [ ] tests/test_generated_guard_hook.py updated and green; co-location regression test green
- [ ] `uv run pytest tests/ --run-slow` and the fast bucket both pass

## Done summary
Made the repo polyglot (package.json/biome.json/bun.lock) and shipped plugin/hooks/lib.ts plus three fail-open guard dispatcher stubs, wired exec-form into hooks.json (commit-guard PreToolUse/Bash, subagent-stop-guard SubagentStop, stop-guard Stop). bun test + biome lint green; Python wiring + slow-bucket subprocess tests green.
## Evidence
