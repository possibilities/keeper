## Overview

The /plan:work and /plan:close orchestrators must never do implementation work themselves — no edits, no lint fixes, no commits. Every non-done outcome routes back into the worker subagent. This epic enforces that mechanically in four layers: skill frontmatter tool removal (`disallowed-tools`), prompt hardening at the work skill's Phase 2b verdict switch, a planctl-owned session-marker layer (Python, inside the verbs), and three bun TypeScript hook dispatchers shipped by this plugin (PreToolUse commit hard-deny, SubagentStop worker guard, Stop checklist guard). The repo becomes deliberately polyglot: bun for hook-path code (speed), Python for the CLI; keeper (~/code/keeper) is the layout model.

Settled design decisions (canonical for all tasks):

- **Marker contract**: one JSON file per session at `~/.local/state/planctl/sessions/<session_id>.json`, schema_version 1, fields `{schema_version, session_id, kind: "work"|"close", task_id (work) | epic_id (close), created_at}`. Writers: `claim` and `worker resume` (work kind), `close-preflight` (close kind) — success paths only. Clearers: `done` and `block` (clear-if-task-matches), `close-finalize` on ANY of its four outcomes (clear-if-epic-matches). Session id comes from `CLAUDE_CODE_SESSION_ID` read directly; **fail open** — env var absent means no marker activity and the verb proceeds normally (manual/test invocations).
- **No blind trust in markers for denial**: before any deny/block, guards verify live state with a read-only planctl call (`reconcile` for the guards, status check for the commit deny). A marker whose task no longer exists or is done/blocked is stale — allow and unlink. Markers older than 7 days are unlinked on read. No SessionStart/SessionEnd sweep hooks.
- **Resume-engine precedence**: the SubagentStop guard is FIRST-CHANCE (fires inside the worker before the Task result exists, block-once max via stop_hook_active); the work skill's Phase 2b reconcile-switch machinery stays AUTHORITATIVE FALLBACK — it sees only post-guard outcomes and alone covers cold cross-session resumes and hook-disabled sessions. Both coexist by design.
- **Fail open everywhere**: any dispatcher-internal error, unparseable stdin, reconcile `tooling_error` verdict, or typed-error envelope (no `verdict` key) → exit 0, no block. `PLANCTL_GUARD_BYPASS=1` disables all three guards (checked before any I/O).
- **Deny pattern** covers both `keeper commit-work` and `git commit` in compound commands (word-boundary, `&&`/`;`/`||`/env-prefix tolerant; documented gap: `sh -c '...'` strings).
- Hook dispatchers run as standalone bun scripts (`bun <file>.ts` via hooks.json exec form with `${CLAUDE_PLUGIN_ROOT}`), read stdin once via `Bun.stdin.stream()`, emit at most one JSON envelope on stdout, never write non-JSON to stdout.

## Quick commands

- `uv run pytest tests/ -k "session_marker"` — marker layer fast-bucket tests
- `uv run pytest tests/ --run-slow -k "guard"` — dispatcher subprocess wiring tests
- `bun test` — TS dispatcher unit tests
- `echo '{"hook_event_name":"PreToolUse","session_id":"smoke","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | bun plugin/hooks/commit-guard.ts` — manual deny-path probe (no marker → empty allow)
- Live smoke (human, once): in a session with a claimed task, attempt `git commit` from the main context → expect deny naming the task; `PLANCTL_GUARD_BYPASS=1` re-attempt → allowed.

## Acceptance

- [ ] Main-context commit commands (`keeper commit-work`, `git commit`) are denied while the session's claimed task is in_progress; worker-context (agent_id present) commits always pass
- [ ] A worker stopping with a non-done, non-BLOCKED state gets exactly one corrective SubagentStop round; `BLOCKED:` returns, `tooling_error`, and stop_hook_active stops pass through
- [ ] A work-session Stop with a non-done/non-blocked claimed task blocks once with the resume checklist; close-session Stop blocks only when close-finalize never ran and no typed stop is in the last message
- [ ] `disallowed-tools: Edit, Write, NotebookEdit, TodoWrite` live in the rendered work skill and in skills/close/SKILL.md; work skill no longer pre-approves Bash(keeper:*)
- [ ] All dispatchers fail open on internal error and honor PLANCTL_GUARD_BYPASS=1
- [ ] `.ts` sources are linted by biome via the package.json lint script (covered by the commit gate's npm-lint pass)

## Early proof point

Task that proves the approach: task 2 (toolchain + hooks.json wiring + fail-open stubs visible in a live session). If it fails: reimplement the dispatchers in Python following plugin/hooks/pre-hook.py — tasks 3–5 logic carries over unchanged, only the language moves.

## References

- `~/code/keeper` — polyglot layout model: package.json + biome.json + bun.lock + hooks/hooks.json (exec entries) + TS hook scripts beside a Python package
- `~/code/arthack/claude/arthack/hooks/` — dispatcher shape inspiration only (one script per event, stdin once, one merged envelope, shared lib); no code sharing
- https://code.claude.com/docs/en/hooks.md — hook event schemas, exit-code/JSON contract, stop_hook_active, 8-block cap
- https://code.claude.com/docs/en/plugins-reference.md — hooks/hooks.json, ${CLAUDE_PLUGIN_ROOT}, exec form
- hooks.json must stay co-located at the plugin root `hooks/` (CC bug #45296; a regression test asserts this)
- SubagentStop `agent_type` arrives verbatim as `plan:worker-medium|high|xhigh|max` (verified from recorded harness events); `agent_id` presence is the canonical subagent-context discriminant

## Docs gaps

- **README.md**: revise the /plan:work skills-table row to state the orchestrators carry hook-enforced no-commit constraints; add a compact hooks subsection (marker location, hard-deny, worker guard, stop guard, bypass var)
- **AGENTS.md**: one present-tense sentence in "Skills and agents" — the plugin's hooks layer enforces the content-blind orchestrator contract mechanically

## Best practices

- **PreToolUse deny shape:** `hookSpecificOutput {hookEventName, permissionDecision: "deny", permissionDecisionReason}` — the top-level `decision` field is deprecated on this event [hooks docs]
- **Stop/SubagentStop blocking:** TOP-LEVEL `{"decision": "block", "reason": ...}`; reason is delivered to the blocked agent as its next instruction [hooks docs]
- **Always check stop_hook_active before blocking** — it signals a prior Stop-hook continuation; blocking again burns the 8-block cap [hooks docs]
- **stdout purity:** exit 0 + a single JSON object, or exit 0 with no output; diagnostics go to stderr; exit 2 discards JSON entirely [hooks docs]
- **Bun stdin:** `new Response(Bun.stdin.stream()).text()` — `process.stdin` buffers until close on macOS (Bun #18239) [bun docs]
- **The deny only constrains the agent's Bash tool**, never the human's terminal — document the bypass var, don't oversell the guarantee
