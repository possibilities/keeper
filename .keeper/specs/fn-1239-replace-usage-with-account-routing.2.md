## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/args.ts, src/agent/dispatch.ts, src/agent/harness.ts, src/agent/launch-config.ts, src/agent/tmux-launch.ts, test/agent-account-routing.test.ts, test/agent-launch-config.test.ts, test/agent-tmux-launch.test.ts, test/exec-backend.test.ts

### Approach

Make the account router the single Claude process-boundary decision for interactive launches, detached workers, resumes, and crash restores. A native decision preserves the existing Claude argv and environment; a managed decision composes `cswap run <slot> --share-history -- <existing Claude argv...>` exactly, sets a PII-free account-route environment carrier, and lets claude-swap own account isolation and exec handoff.

Selection is deliberately independent on every invocation. A resumed or restored conversation receives no prior-account input; `--share-history` supplies cross-account conversation visibility. Preserve the complete model, effort, session-id, resume, permissions, plugin, MCP, statusline, cwd, tmux, signal, and exit-status contract through the nested `--` boundary.

Add a read-only `keeper agent accounts check --json` diagnostic that reports integration health, snapshot age, PII-free candidates, and the route policy would choose without recording a reservation. It is a machine diagnostic, not a replacement usage UI.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts:2565 — current explicit/env/automatic profile precedence
- src/agent/main.ts:2994 — current profile-picker call and native fallback
- src/agent/main.ts:3279 — current `CLAUDE_CONFIG_DIR` and profile-identity injection
- src/agent/launch-config.ts:1 — DB-free pure launch-builder boundary shared by run/panel/pairing
- src/agent/launch-handle.ts:98 — injected cold-path effects and fail-open launch precedents
- src/exec-backend.ts:972 — common Keeper-agent argv carrier used by manual dispatch, autopilot, and restore
- /Users/mike/src/realiti4--claude-swap/src/claude_swap/cli.py:87 — exact `run` parsing and `--` forwarding grammar
- /Users/mike/src/realiti4--claude-swap/src/claude_swap/session.py:305 — session setup, same-account fast path, environment scrubbing, and POSIX exec behavior

**Optional** (reference as needed):
- test/agent-profile-bootstrap.test.ts:652 — current precedence/fallback byte pins to replace
- test/agent-tmux-launch.test.ts:200 — exact tmux environment-forwarding coverage
- test/exec-backend.test.ts:689 — shared launch and resume argv coverage

### Risks

`cswap run` must be the first claude-swap token, hardcodes the `claude` executable from PATH, emits a human account line, and may take the native same-account fast path without `CLAUDE_CONFIG_DIR`. None may corrupt Keeper attribution or argv. A timeout or lost handoff after invoking claude-swap is ambiguous and must never trigger a duplicate native launch.

### Test notes

Byte-pin native and managed argv composition for fresh, resume, restore, model/effort, plugin, statusline, permissions, MCP, leading-dash prompt, and same-account cases. Use injected runners and fake executable paths only; do not launch real claude-swap, Claude, tmux, a subprocess, or a daemon in the fast suite.

### Detailed phases

1. Add route resolution and diagnostic dependency seams to the DB-free launcher.
2. Compose the managed wrapper around the already-resolved native Claude argv without re-deriving matrix/model data.
3. Thread the account-route carrier into every launch channel and ensure non-Claude harnesses remain byte-identical.
4. Remove automatic profile selection from the active launch path while leaving deletion to task 4.

### Alternatives

Global `cswap switch`/`auto` was rejected because it mutates unrelated processes. Calling claude-swap's private session setup or discovering its session directories was rejected because the public wrapper owns that state. A durable session-account affinity was rejected by design.

### Non-functional targets

Default launches must remain byte-identical when routing is disabled. Route lookup must be bounded and DB-free. No raw external output or email enters Keeper logs. Signals, terminal sizing, cwd, argv ordering, and final process exit status remain transparent across the wrapper.

### Rollout

Keep destructive cleanup blocked behind this task. The account diagnostic must show a healthy wrapper contract before routing is enabled; if public CLI parity fails, stop and refine rather than adding an external patch.

## Acceptance

- [ ] Every Claude start, resume, and restore independently resolves an account route from the latest validated observation.
- [ ] Native fallback preserves the prior Claude launch contract when either optional integration is unavailable or balancing is disabled.
- [ ] Managed launches use exactly `cswap run <slot> --share-history -- <Claude argv...>` and preserve every native argument byte-for-byte after `--`.
- [ ] No previous launch attribution or conversation identity participates in route selection.
- [ ] The same-account claude-swap fast path still carries Keeper's selected route identity without relying on `CLAUDE_CONFIG_DIR`.
- [ ] `keeper agent accounts check --json` is read-only, PII-free, and does not reserve a route.
- [ ] Non-Claude harness launch bytes and fallback behavior remain unchanged.
- [ ] Exact-argv, environment, resume/restore, and failure-ambiguity tests pass using injected seams only.

## Done summary

## Evidence
