## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/hermes-events-shim.ts (new), src/hermes-trust.ts (new), src/agent/launch-handle.ts, test/hermes-trust.test.ts (new), test/hermes-shim.test.ts (new)

### Approach

M3b for hermes: a tiny fail-open shim that hermes's native shell-hook system
executes, translating hermes events into keeper's events-log NDJSON contract
(KNOWN_EVENT_COLUMNS keys, one line per event, its own per-pid file — the
existing ingester and fold do the rest, zero reducer work). Event map: 
on_session_start -> SessionStart, on_session_end -> SessionEnd,
pre_llm_call -> UserPromptSubmit-shaped (drives working), pre/post_tool_call ->
Pre/PostToolUse, subagent_start/stop -> SubagentStart/Stop,
api_request_error -> the ApiError pill, pre_approval_request -> the
permission-prompt Notification — investigate the turn-end signal (hermes has no
per-turn Stop; acceptable initial degrade: working until session end, note it).
Identity: session_id = KEEPER_JOB_ID from env (hook subprocesses inherit the
launcher env THROUGH hermes — verify; fallback join key is the shim's parent
hermes pid matched against the birth record); the hermes NATIVE session id (hook
stdin payload) rides the SessionStart row's resume_target column. Discipline
inherited from keeper hook rules: always exit 0, no bun:sqlite, JSON-encode every
payload field (tool_input is attacker-influenced — NDJSON injection), bound line
size, log privately never to stdout (stdout is hermes's hook control channel),
stay fast (host hook timeouts kill slow shims). Seeder src/hermes-trust.ts
(codex-trust template: node:*-only, fail-open, O_EXCL lock): registers the shim
in ~/.hermes/config.yaml hooks: block via a conservative idempotent managed edit
(YAML, not TOML — no blind append), pre-writes the (event, command) entries into
~/.hermes/shell-hooks-allowlist.json (non-TTY registration is SILENTLY skipped
without consent — this is the load-bearing gate), and re-seeds on shim version
bump (hooks bind at hermes startup). Launcher already exports
HERMES_ACCEPT_HOOKS=1 as the belt.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/events-writer.ts:555-830 — KNOWN_EVENT_COLUMNS + buildEventBindings (the exact line contract the shim must emit)
- src/codex-trust.ts — the seeder template (locking, fail-open, idempotency)
- Live probes: `hermes hooks list/test/doctor`, ~/.hermes/config.yaml hooks schema, shell-hooks-allowlist.json entry shape, and whether launcher env reaches hook stdin/env
- The events-log ingest path — confirm a second per-pid writer coexists (file-per-writer, offsets are per-(path,inode))

**Optional** (reference as needed):
- plugins/keeper/plugin/hooks/branch-guard.ts — hook discipline conventions

### Risks

- Hermes hook payload schema drift silently orphans events — version-pin the shim against the documented payload and let doctor-style checks surface drift
- A YAML edit gone wrong breaks the user's hermes config — managed-block edit with backup, fail-open, never destructive
- Shim consent revocation degrades to presence-only — that is the designed floor, never an error

### Test notes

Shim: golden fixture payloads per hermes event -> exact NDJSON lines (injection
cases: quotes/newlines in tool_input); exit 0 on garbage stdin. Seeder: fresh
config, existing config with unrelated hooks, re-seed on version bump, torn-lock
recovery. End-to-end (slow tier): hermes session shows working/stopped churn.

## Acceptance

- [ ] A seeded hermes launch fires hooks without any interactive consent prompt, and the session's jobs row shows live state churn (working during activity, ended on session end)
- [ ] The shim's rows converge on the SAME jobs row as the birth record (keeper job id), and the hermes native session id lands as the row's resume target
- [ ] Hook payload content with quotes/newlines/shell metacharacters round-trips as data — no torn NDJSON lines, no shell interpretation, nothing written to stdout
- [ ] Removing consent or the shim degrades that harness to presence-only tracking with no errors anywhere

## Done summary

## Evidence
