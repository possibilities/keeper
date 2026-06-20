## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/branch-guard.ts (new), plugins/keeper/hooks/hooks.json, plugins/keeper/.claude-plugin/plugin.json, test/branch-guard.test.ts (new)

### Approach

New `PreToolUse(Bash)` hook that hard-blocks subagent-originated git branch create/switch. Mirror the structure of the existing deny dispatcher `plugins/plan/plugin/hooks/commit-guard.ts` but INVERT the agent gate: commit-guard early-returns when `agent_id` is present; branch-guard must DENY when `agent_id` (or `agent_type`) is present and ALLOW when absent. Read stdin once, `JSON.parse`, pull `{tool_name, agent_id, agent_type, tool_input.command}`. Return early (allow, emit nothing) when `tool_name !== "Bash"`, when `agent_id` is falsy (empty string counts as absent — use truthiness), or when the command matches no branch-mutating form. Deny via exit-0 + JSON envelope `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<tell the subagent to work in place on the current branch; never create/switch branches; use `git restore` / `git checkout -- <path>` for file ops>"}}`. INLINE the ~8-line deny envelope — do NOT import plan's `lib.ts` from the vendored subtree. Fail OPEN on any parse error or unexpected input (`main().catch()` -> exit 0, no decision). Make ZERO subprocess/filesystem/git/DB calls — pure function of the payload.

Classifier: export a pure predicate (e.g. `isBranchMutatingCommand(command): boolean`) so it gets an in-process truth table, mirroring commit-guard's exported predicate. Scan the WHOLE raw command string with regex (including subshell bodies) — do NOT rely on `src/derivers.ts` `tokenizeShell` as the sole scanner (it truncates at the first `;|&`, so `... && git checkout -b x` would slip through). Tolerate leading env-prefixes (`VAR=val`), `sudo`/`env`, and git global flags (`git -C <dir> ...`, `--git-dir=`). Treat the presence of compound separators (`&&`/`;`/`|`), command substitution (`$()`/backticks), and `sh -c`/`bash -c` wrappers carrying a git branch verb as deny-worthy.

DENY set: `git checkout` with `-b`/`-B`/`--orphan`; `git switch` with `-c`/`-C`/`--create`/`--orphan`; bare `git switch <ref>` (no `-c` — unambiguous switch); bare `git checkout <X>` when NO `--` separator (per human ruling: block; the switch-vs-restore ambiguity resolves toward block); `git branch <newname>` (bare positional, no list/delete flags); `git worktree add`. ALLOW set: `git checkout -- <path>`, `git restore`, `git branch` with no positional or with `-d`/`-D`/`-m`/`--list`/`-a`/`-v`/`-r`/`--show-current` (non-create), and all ordinary git (status/add/commit/push/pull/fetch/log/diff/show/stash).

Register in `plugins/keeper/hooks/hooks.json`: add a SECOND `PreToolUse` entry (matcher `"Bash"`) pointing at `${CLAUDE_PLUGIN_ROOT}/plugin/hooks/branch-guard.ts`, ALONGSIDE the existing events-writer `"*"` entry (both fire — events-writer still logs the attempt). Update the hooks.json top-level `description` to name both hooks. Update `plugins/keeper/.claude-plugin/plugin.json` `description` to cover the two-hook surface.

### Investigation targets

**Required** (read before coding):
- plugins/plan/plugin/hooks/commit-guard.ts:1-92 — structural template (stdin read, parse, classify, emitDeny, fail-open); INVERT the agent_id gate at ~:56-60.
- plugins/plan/plugin/hooks/lib.ts:172-180 — emitDeny envelope shape to inline (permissionDecision:"deny"); :31-33 readStdin; do NOT wire isBypassed (:36-38) — no escape hatch.
- plugins/keeper/plugin/hooks/events-writer.ts:66-85 (readStdin), :599-633 (agent_id/agent_type extraction at :632-633), :874-881 (exit discipline) — keeper-plugin hook conventions + the blessed import allow-list (src/derivers.ts is importable here).
- plugins/keeper/hooks/hooks.json — existing PreToolUse "*" registration to mirror (hooks.json lives at plugins/keeper/hooks/ but commands point at ${CLAUDE_PLUGIN_ROOT}/plugin/hooks/).
- plugins/plan/test/commit-guard.test.ts:24-64 (pure classifier table) + :66+ (subprocess decision-ladder) — the test template.

**Optional** (reference as needed):
- src/derivers.ts:687-761 (tokenizeShell — reference only, NOT the sole scanner), :541 ENV_PREFIX_RE, :788-802 firstPositional — env-prefix/flag-handling patterns.
- anthropics/claude-code/examples/hooks/bash_command_validator_example.py — official PreToolUse Bash blocking reference.

### Risks

- Shell-parse robustness: regex over a free-form command string is inherently leaky (python/node subprocess and git aliases bypass it — accepted out of scope for the accidental-behavior threat model). Cover all create+switch forms + compound/subshell/env-prefix; err toward deny. Note the python-subprocess limit, don't chase it.
- Bare `git checkout <X>` false-positives on `git checkout <file>` (no `--`): accepted per human ruling; the deny reason MUST point the agent to `git restore` / `git checkout -- <path>`.
- Two PreToolUse(Bash) hooks in one plugin: confirm Claude Code merges the envelopes (events-writer emits no decision; branch-guard may deny) with deny winning — the core integration assumption; cover it in the subprocess test.

### Test notes

Mirror commit-guard.test.ts: (1) in-process truth table over the exported predicate — every DENY form (`checkout -b/-B/--orphan`, `switch -c/-C/--create/--orphan`, bare `switch <ref>`, bare `checkout <ref>`, `branch <newname>`, `worktree add`, plus `cd x && git checkout -b y`, `sh -c "git switch z"`, `FOO=1 git checkout -b w`, `git -C /p checkout -b v`) and every ALLOW form (`git status`, `git add`, `git commit`, `git push`, `git checkout -- file.ts`, `git restore file.ts`, `git branch`, `git branch -d x`, `git log --grep "git checkout -b"`, `git branch --show-current`). (2) subprocess decision-ladder: agent_id present + deny-form -> deny envelope on stdout; agent_id absent + deny-form -> no decision; malformed stdin -> fail-open exit 0. Use test/helpers/sandbox-env.ts sandboxEnv for spawn isolation, retryUntil for async. Run `bun run test:full` before landing (touches hook process paths).

## Acceptance

- [ ] plugins/keeper/plugin/hooks/branch-guard.ts denies branch create AND switch (all forms above) when agent_id present, allows when absent, via exit-0 + permissionDecision:"deny" JSON.
- [ ] Exported pure classifier covers the full deny/allow truth table incl. compound, subshell, env-prefix, and git global-flag forms; bare `git checkout <X>` (no `--`) is denied; `git checkout -- <path>` and `git restore` are allowed.
- [ ] Hook makes zero subprocess/fs/git/DB calls and fails OPEN (exit 0, no decision) on any parse error.
- [ ] plugins/keeper/hooks/hooks.json registers a second PreToolUse(Bash) entry alongside events-writer (both fire); top-level description names both hooks.
- [ ] plugins/keeper/.claude-plugin/plugin.json description covers the two-hook surface.
- [ ] In-process classifier truth table + subprocess decision-ladder tests pass; `bun run test:full` green.

## Done summary
Added plugins/keeper/plugin/hooks/branch-guard.ts: a pure-payload PreToolUse(Bash) hard-deny that blocks subagents (agent_id/agent_type present) from git branch create/switch/worktree-add forms while allowing file-restore and ordinary git, registered as a second PreToolUse(Bash) hook alongside events-writer with a 70-test classifier + decision-ladder suite.
## Evidence
