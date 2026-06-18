## Description

**Size:** S
**Files:** plugin/hooks/commit-guard.ts, test/commit-guard.test.ts (new), tests/test_commit_guard_hook.py (new)

### Approach

Fill in commit-guard.ts. Decision ladder, cheapest first: bypass env → exit 0; `tool_name !== "Bash"` → exit 0; **agent_id present (subagent context) → exit 0 — this is the load-bearing check; the worker must never be denied**; command doesn't match the commit pattern → exit 0; no marker for `session_id` (or kind !== work) → exit 0. Only then verify live state: `runPlanctl(["reconcile", marker.task_id])` — verdict `done`/`blocked`, typed error, or null → allow and unlink the stale marker. Otherwise emit the PreToolUse deny envelope: permissionDecision "deny", reason naming the in-flight task and instructing "resume the worker — the orchestrator never commits; set PLANCTL_GUARD_BYPASS=1 to override as a human."

Commit pattern (one regex, unit-tested): matches `git commit` and `keeper commit-work` as command tokens — start-of-string or after `&&`, `;`, `||`, `|`, `$(`, with optional `VAR=val` / `sudo` / `env` prefixes; must NOT match inside quoted strings like `echo "git commit"` (word-boundary approach accepts the documented `sh -c '...'` gap).

### Investigation targets

**Required** (read before coding):
- plugin/hooks/lib.ts — use the shared primitives; add nothing Bash-parsing-specific to the lib
- plugin/hooks/pre-hook.py:50-78 — the deny-envelope discipline mirrored in TS
- planctl/run_reconcile.py:51-67, :461-474 — verdict members and envelope shape; typed errors carry no verdict key

**Optional** (reference as needed):
- https://code.claude.com/docs/en/hooks.md — PreToolUse hookSpecificOutput deny contract

### Risks

- A false deny against the worker bricks the whole work loop — the agent_id check must precede everything except bypass/tool gating, and a missing/empty-string agent_id must be treated as main context only when the field is truly absent
- Reconcile adds ~hundreds of ms — acceptable because it only runs on commit-pattern + marker hits (rare); never on the hot path

### Test notes

bun unit tests: regex true/false table (compound commands, env prefixes, quoted false-positives, keeper commit-work forms); ladder short-circuits. Pytest slow-bucket: subprocess with fixture stdin covering main-context-deny (stub planctl shim returning in_progress verdict on PATH, marker present), worker-context-pass (agent_id set), stale-marker-allow-and-unlink, bypass.

## Acceptance

- [ ] Main-context `git commit` / `keeper commit-work` (incl. `cd x && git commit -m y`) denied while marker task reconciles in_progress; deny reason names the task id
- [ ] agent_id-present payloads always pass, regardless of marker/command
- [ ] done/blocked/error reconcile results allow AND unlink the marker; PLANCTL_GUARD_BYPASS=1 allows before any I/O
- [ ] Non-commit Bash payloads produce zero planctl subprocesses (assert via shim absence)
- [ ] bun test + fast/slow pytest green

## Done summary
Implemented the PreToolUse(Bash) commit hard-deny dispatcher: bypass/tool/agent_id/commit-pattern/marker short-circuits then a read-only reconcile that denies only on genuine in-flight verdicts and unlinks stale markers. Added a commit-pattern regex with a bun true/false table plus a slow-bucket pytest covering the full deny/allow ladder.
## Evidence
