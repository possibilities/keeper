## Overview

A `/plan:work` worker subagent created a git branch (`git checkout -b fn-841-...`) unprompted, because nothing stopped it: the worker prompt had no "work in place" guardrail, the brief surfaced a misleading `Branch:` line, and there was no hard enforcement. This epic adds a keeper-plugin `PreToolUse` branch-guard hook that hard-blocks SUBAGENTS (detected via `agent_id` presence in the hook payload) from creating OR switching git branches, and removes the two soft pressures. End state: subagents physically cannot create/switch branches (denied via the `PreToolUse` JSON envelope), the worker prompt explicitly forbids it, and the brief no longer implies per-epic branches. The human's own interactive sessions are never affected.

## Quick commands

- `echo '{"tool_name":"Bash","agent_id":"x","tool_input":{"command":"git checkout -b foo"}}' | bun plugins/keeper/plugin/hooks/branch-guard.ts`  # expect permissionDecision:"deny"
- `echo '{"tool_name":"Bash","tool_input":{"command":"git checkout -b foo"}}' | bun plugins/keeper/plugin/hooks/branch-guard.ts`  # no agent_id -> no decision (allow)
- `echo '{"tool_name":"Bash","agent_id":"x","tool_input":{"command":"git status"}}' | bun plugins/keeper/plugin/hooks/branch-guard.ts`  # ordinary git -> allow
- `bun run test:full`  # keeper hook tests
- `(cd plugins/plan && PLANCTL_RUN_SLOW=1 bun test)`  # plan gist test

## Acceptance

- [ ] A subagent (agent_id present) is hard-blocked from git branch create AND switch forms; ordinary git and file-restore stay allowed.
- [ ] Non-subagent sessions (no agent_id) — incl. the human's interactive claude and the /plan:work orchestrator — are never blocked.
- [ ] No escape-hatch / bypass env var exists.
- [ ] The worker prompt template forbids branch create/switch and the rendered worker-*.md carry it; the brief's `Branch:` line is gone.
- [ ] Docs (CLAUDE.md/AGENTS.md, README, keeper manifests, plan CLAUDE.md) describe the two-hook reality with the deny-via-JSON (still exit 0) nuance.
- [ ] `bun run test:full` and plan slow-tier tests green.

## Early proof point

Task that proves the approach: `.1` (branch-guard hook + classifier + decision-ladder test). If it fails (two-PreToolUse-hooks merge doesn't let the deny win, or agent_id isn't in the payload as assumed): fall back to a minimal standalone deny hook to confirm the mechanism + re-confirm the live payload shape before wiring the full classifier.

## References

- Root-cause forensics: branch created by a `plan:worker-xhigh` subagent (agent_id `a3a3dc...`) at the start of fn-841; transcript shows it improvised "I should create a branch for this epic's work."
- Structural template: `plugins/plan/plugin/hooks/commit-guard.ts` (PreToolUse hard-deny dispatcher — INVERT its agent_id gate).
- Deny mechanism (authoritative Claude Code hooks docs): exit-0 + `hookSpecificOutput.permissionDecision:"deny"`; `agent_id` present only inside subagent calls.

## Docs gaps

- **CLAUDE.md / AGENTS.md `## Hook rules`**: narrow "always exit 0 / never block" to add the branch-guard carve-out (denies via JSON, still exits 0); update the one-hook intro paragraph.
- **README.md `## Architecture` + plugins/keeper bullet**: name the branch-guard and its contract.
- **plugins/keeper/hooks/hooks.json + .claude-plugin/plugin.json descriptions**: cover the two-hook surface (handled in task .1).
- **plugins/plan/CLAUDE.md `## Skills and agents`**: cross-ref the keeper branch-guard enforcing the worker invariant.

## Best practices

- **Deny via exit-0 + JSON `permissionDecision:"deny"`** (not exit 2 — exit 0 is required for JSON to be processed); `permissionDecisionReason` is shown to the subagent, so use it to instruct "work in place." [Claude Code hooks docs]
- **`agent_id` presence is the only subagent signal** (no `is_subagent` boolean exists); empty string != present (use truthiness). [Claude Code hooks docs]
- **Don't call git from the hook** (lock/reentrancy); scan the whole command string (not `tokenizeShell`, which truncates at the first `;|&`); accept python-subprocess / git-alias bypass as out of scope for the accidental-behavior threat model.
