## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/hooks/hooks.json, test/wrapped-guard.test.ts

Add the eighth PreToolUse hook. It fires only when `KEEPER_WRAPPED_CELL` is present AND the
tool payload carries `agent_id`/`agent_type` (a subagent — the wrapped `work:worker`), and
denies every source-editing vector while permitting the delegation + keeper close-out surface.
Single-state: because the dumb-courier wrapper (task 3) never edits source, there is no phase
gate and no result-envelope unlock — edits are denied for the whole run.

### Approach

A dep-free `node:*`-only dispatcher with a pure exported `decideWrappedGuard(payload, env, probe?)`
returning a deny envelope or `null`, plus a thin `main()`. Deny via
`{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }`
as ONE JSON line; always exit 0. Fail CLOSED (deny the guarded tools) when marked and on any
parse ambiguity; stay inert (return null, no output) for an unmarked session so a human is never
blocked. Never import `bun:sqlite`/`src/db.ts`. Size-bound the stdin read; treat every payload
field as inert data (no shell interpolation); private single-line-JSON logging via the
`wrong-tree-guard.ts` `makeLogSink` pattern.

**Denied always:** Edit, MultiEdit, NotebookEdit; Write whose target resolves inside the repo
working tree (reuse `wrong-tree-guard.ts` `TreeProbe`/`repoToplevel` — a Write OUTSIDE the tree,
e.g. the scratchpad contract file, is allowed).

**Bash decision — allowlist, not blocklist:** reject the whole shell-operator/expansion surface
up front, strip env-var prefixes and wrapper builtins, deny re-entrant wrappers (`sh -c`, `xargs`,
`find -exec`, `env`, etc.) — reuse escalation-guard's `lexSegments` / `stripWrappers` / `WRAPPERS`
/ interpreter + git classification wholesale. Allow exact command families: `keeper agent`
(`run`/`--resume`/`wait`/`wait-for-stop`/`show-last-message`/`providers resolve`), `keeper session state`,
`keeper plan` read verbs plus `done`, `keeper commit-work`, read-only + staging git
(`git add`/`status`/`log`/`diff`/`show`/`rev-parse`/`reset --soft`), and the project test runner.
Treat as DENIED in-tree write vectors: redirects/heredocs/`tee`/`sed -i` (via `wrong-tree-guard.ts`
`extractBashTargets`) AND content-injecting git/file ops — `git apply`/`git am`/`patch`/`cp`/`mv`/`tar -x`
targeting the tree.

Wire the hook into `plugins/keeper/hooks/hooks.json` PreToolUse for `Write|Edit|MultiEdit|Bash`
(NotebookEdit if the matcher supports it) and extend the hooks.json `description` string to enumerate
it as the eighth hook, terse, matching the existing cadence.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- plugins/keeper/plugin/hooks/escalation-guard.ts — `decideEscalationGuard` (~:744), `evaluateEscalationCommand` (~:663), `lexSegments`, `stripWrappers`, `WRAPPERS`, git/interpreter classification; the primary template.
- plugins/keeper/plugin/hooks/wrong-tree-guard.ts — `collectTargets` (~:475), `extractBashTargets` (~:438), `TreeProbe`/`repoToplevel`, `makeLogSink` (~:653).
- plugins/keeper/plugin/hooks/branch-guard.ts — `decideBranchGuard` (~:249) `agent_id`/`agent_type` subagent keying.
- plugins/keeper/hooks/hooks.json — the PreToolUse array + the enumerating `description` string.

**Optional:**
- test/escalation-guard.test.ts, test/wrong-tree-guard.test.ts — the table-driven allow/deny + decision-ladder test shape to mirror.

### Risks

- Blocklist thinking loses (CVE-2025-66032): the Bash decision MUST reject the operator/expansion surface then allow exact shapes, or a bypass smuggles a native write. Use the documented 8-bypass corpus as deny test vectors.
- The leg-launch shell shape (`sh -c 'nohup … keeper agent run …'`) is exactly what the allowlist rejects. This task must resolve the leg-launch mechanism WITH task 3: prefer a keeper-native detach so the worker issues a clean `keeper agent run` (no shell operators); if a detach mode does not exist, either add one (widen this task) or grant one exact-shape allowlist exception (parser-differential risk — document it). Flag as an in-task decision at implementation time.
- `agent_id` must actually be present on a wrapped `work:worker`'s tool payloads (branch-guard relies on the same signal for `work:worker`); confirm, or the guard is inert where it must bite.

### Test notes

Table-driven allow/deny arrays over `decideWrappedGuard`: allowed close-out/delegation commands,
denied edits, denied in-tree write vectors incl `git apply`/`patch`/`cp`/heredoc/redirect, denied
re-entrant wrappers and operator/expansion bypasses (the CVE corpus). Decision-ladder: inert when
unmarked, inert when marked-but-no-agent_id, deny when marked+agent_id, deny on parse ambiguity.
Include an explicit assertion documenting deny-precedence intent (the guard emits deny regardless of
any sibling allow). Inject the `TreeProbe`/fs seam; no real fs/daemon/subprocess.

## Acceptance

- [ ] `decideWrappedGuard` denies Edit/MultiEdit/NotebookEdit and every in-tree Bash write vector (redirect/heredoc/tee/sed -i, git apply/am, patch, cp/mv/tar into the tree) for a marked wrapped-worker payload.
- [ ] It permits the delegation + close-out surface (keeper agent run/--resume/wait, keeper commit-work, keeper plan done + reads, keeper session state, read-only + staging git, the test runner) and a Write outside the repo tree.
- [ ] The Bash decision rejects the shell-operator/expansion surface and re-entrant wrappers before any allow, surviving the documented bypass corpus as deny vectors.
- [ ] The hook is inert for an unmarked session and for a marked payload lacking agent_id; it fails closed (deny) when marked and on parse ambiguity; every path exits 0 and emits at most one JSON line.
- [ ] hooks.json wires the hook on Write/Edit/MultiEdit/Bash and its `description` enumerates it as the eighth hook.

## Done summary

## Evidence
