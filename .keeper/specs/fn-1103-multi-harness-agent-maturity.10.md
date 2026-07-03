## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/keeper-events.ts (new — final home per pi's -e contract), src/agent/launch-config.ts, src/agent/harness.ts, test/pi-extension.test.ts (new)

### Approach

M3b for pi. pi has no subprocess hooks but supports in-process TypeScript
extensions consuming AgentHarness events (tool_call, tool_result, message_end,
session_before_compact, ...). Ship a keeper extension the launcher arms
EPHEMERALLY on every pi launch (the -e per-launch mechanism — never a persistent
pi install, which would fire on non-keeper pi sessions). The extension translates
pi events into keeper's events-log NDJSON contract in its own per-pid file:
session start/end -> SessionStart/SessionEnd, turn start (message/prompt begin)
-> UserPromptSubmit-shaped (drives working), message_end -> Stop, tool events ->
Pre/PostToolUse — investigate the exact AgentHarness event vocabulary against
the installed pi version before locking the map. Identity: EVERY line's
session_id field is set to KEEPER_JOB_ID from env (the join key to the
birth-record row; for pi this equals the pinned session uuid); the extension
NO-OPS entirely when KEEPER_JOB_ID is absent. Discipline (hook-writer class,
same as the hermes shim): top-level fail-open guard so a throwing extension can
never crash the human's pi session — verify pi's extension-error isolation live;
host-runtime primitives only (node:* — no Bun.*, no bun:sqlite, no keeper db
imports); JSON-encode every payload field; bound line size; never write to
stdout/stderr of the host.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- Live probes: pi -e semantics (path? module? per-launch scope), the AgentHarness event vocabulary and payload shapes on the installed pi, pi's runtime (node vs bun) and extension-error isolation behavior
- plugins/keeper/plugin/hooks/events-writer.ts:555-665 — KNOWN_EVENT_COLUMNS + buildEventBindings (the exact NDJSON contract, including the session_id join)
- The hermes shim task's event map — keep the two translations structurally parallel

**Optional** (reference as needed):
- src/agent/launch-config.ts — where per-harness launch args are composed (the arming site)

### Risks

- pi extension API drift breaks the translation silently — version-pin against the installed pi and let golden-fixture tests catch shape changes
- If pi does not isolate extension errors, a bug here crashes real sessions — the top-level guard plus live verification is load-bearing, not optional
- Double-arming (persistent install + -e) would double every event line — ephemeral-only is a hard rule

### Test notes

Pure translation-function unit tests with golden pi-event fixtures -> exact
NDJSON lines (injection cases: quotes/newlines in tool payloads); no-op cases
(missing KEEPER_JOB_ID, unknown event kinds); never boot real pi in tests.

## Acceptance

- [ ] A keeper-launched pi session (interactive or detached) shows live working/stopped churn on the board, keyed to the same jobs row its birth record seeded
- [ ] A pi session launched outside keeper (no keeper env marker) gets zero extension output and no orphan events
- [ ] Extension failure or absence degrades pi to presence-only tracking; a deliberately-throwing translation in tests never propagates out of the guard
- [ ] Hostile payload content (quotes, newlines, shell metacharacters) round-trips as data in valid NDJSON lines

## Done summary

## Evidence
