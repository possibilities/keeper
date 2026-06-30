## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/tmux-launch.ts, src/agent/state-sharing.ts, scripts/frozen-allowlist.txt (remove env anchors), test/agent-{codex,pi,profile-bootstrap,pair-subcommands,state-sharing,tmux-launch}.test.ts + any other AGENTWRAP_ test refs

### Approach

Rename the `AGENTWRAP_*` env-var family → `KEEPER_AGENT_*` (matches the existing `KEEPER_AGENT_PATH` precedent). Members: `AGENTWRAP_PROFILE`, `AGENTWRAP_{CLAUDE,CODEX,PI}_PROFILE` (the `agentProfileEnvName` producer), `AGENTWRAP_TMUX_SESSION_ID`, `AGENTWRAP_SKIP_LINK_GUARD`, `AGENTWRAP_SHELL`. Move the THREE-POINT carrier lockstep for `AGENTWRAP_TMUX_SESSION_ID` together: the set site (`withTranscriptSessionCarrier` in tmux-launch.ts), the read+delete (main.ts), AND the `launchScriptEnv` forward filter — change `startsWith("AGENTWRAP_")` → `startsWith("KEEPER_AGENT_")`. COLLISION FIX: the pre-existing `KEEPER_AGENT_PATH` (src/keeper-agent-path.ts) would newly match the forward filter and start crossing into panes — explicitly EXCLUDE it (`startsWith("KEEPER_AGENT_") && key !== "KEEPER_AGENT_PATH"`) and add a regression test asserting `KEEPER_AGENT_PATH` is NOT forwarded into the pane env. Keeper now emits `KEEPER_AGENT_CLAUDE_PROFILE` (arthack already reads it after .1). Update every test asserting the literal `AGENTWRAP_*` names. Remove the env-var anchors from scripts/frozen-allowlist.txt in the SAME commit (else the guard fails on the renamed literals). Do NOT touch `KEEPER_TMUX_SESSION` (an independent backend carrier). Reads use the `deps.env` DI pattern, not bare `process.env`. Grep fresh post-fn-1018; line numbers illustrative.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts — `agentProfileEnvName` producer, `AGENTWRAP_PROFILE` read, the `AGENTWRAP_TMUX_SESSION_ID` read+delete
- src/agent/tmux-launch.ts — `withTranscriptSessionCarrier` (set), `launchScriptEnv` startsWith filter, `AGENTWRAP_SHELL` emit
- src/agent/state-sharing.ts — `AGENTWRAP_SKIP_LINK_GUARD` read + hint string
- src/keeper-agent-path.ts — the `KEEPER_AGENT_PATH` the filter must exclude
- scripts/frozen-allowlist.txt — the env anchors to remove
- test/agent-{codex,pi,profile-bootstrap,pair-subcommands,state-sharing,tmux-launch}.test.ts — the `AGENTWRAP_` literal assertions

### Risks

- Carrier lockstep: rename set without read without forward-filter and `AGENTWRAP_TMUX_SESSION_ID` silently stops crossing the pane boundary. Move all three together.
- Namespace collision: the forward filter must exclude `KEEPER_AGENT_PATH` (regression-tested).
- In-flight panes forked before cutover carry the old carrier; a re-exec there won't find the new name. Single-user: drain/accept (no in-keeper `AGENTWRAP_` fallback — it would block zero-tolerance).
- Removing env anchors in the same commit as the rename keeps the guard green.

### Test notes

`bun test` green; the forward-filter regression test asserts `KEEPER_AGENT_PATH` stays out of the pane env while the `KEEPER_AGENT_*` family vars cross; `bash scripts/lint-retired-name.sh` green (env anchors removed).

## Acceptance

- [ ] All 7 family vars renamed to `KEEPER_AGENT_*`; the 3-point carrier lockstep moved together
- [ ] Forward filter excludes `KEEPER_AGENT_PATH`; regression test proves it isn't forwarded
- [ ] All `AGENTWRAP_` test refs updated; env anchors removed from frozen-allowlist.txt; lint green
- [ ] `KEEPER_TMUX_SESSION` untouched; `bun test` green

## Done summary

## Evidence
