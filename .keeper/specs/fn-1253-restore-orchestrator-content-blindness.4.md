## Description

**Size:** S
**Files:** plugins/plan/hooks/hooks.json, plugins/plan/plugin/hooks/state-read-guard.ts, plugins/plan/test/state-read-guard.test.ts

### Approach

An advisory context-hygiene guard mechanically enforces what the depth fold and gate rewrite made true: an orchestrator session has no legitimate tool access to the out-of-band content trees. A PreToolUse dispatcher for Read, Write, and Edit denies via the hook envelope (permissionDecision deny — never a non-zero exit) when the session is a marker-active work/close orchestrator, the payload carries no agent_id (subagent access stays allowed — the worker, auditor, and close-planner all legitimately read briefs and artifacts), and the target path realpath-resolves under the briefs or audits state trees. Best-effort Bash vector coverage (detecting those tree paths in commands for the same marker-active sessions) rides the same dispatcher, following the commit-guard's command-inspection precedent. Fail open on every error path: this is drift correction for an honest orchestrator, not a security boundary — the threat-model framing lands in the docs task's ADR.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/plugin/hooks/commit-guard.ts — the deny-dispatcher pattern: marker gate, agent_id discriminant, emitDeny, fail-open catch.
- plugins/plan/plugin/hooks/lib.ts — emitDeny, readStdin, readMarker, isBypassed.
- plugins/plan/hooks/hooks.json — matcher wiring for the new entry.

**Optional** (reference as needed):
- plugins/plan/test/commit-guard.test.ts — the payload-driven deny/allow test shape.

### Risks

- Over-broad matching denies the human's own session or sibling skills — the session-marker gate is the blast-radius control; test both directions.
- Path matching must tolerate relative paths and symlinks without throwing (fail open).

### Test notes

Payload-driven tests: orchestrator Read of a briefs path denies; agent_id present allows; non-marker session allows; a Bash cat vector denies; an unreadable payload silently allows.

## Acceptance

- [ ] A marker-active work/close orchestrator session's Read, Write, or Edit of paths under the briefs or audits state trees is denied via the hook envelope; subagent and non-orchestrator sessions are unaffected.
- [ ] A best-effort Bash read vector naming those trees is denied for the same sessions; any dispatcher error fails open with exit 0.
- [ ] The guard joins the plugin hook manifest alongside the existing guards; guard tests, lint, and typecheck are green.

## Done summary

## Evidence
