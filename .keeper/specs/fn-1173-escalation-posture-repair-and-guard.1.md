## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/escalation-guard.ts, plugins/keeper/hooks/hooks.json, src/exec-backend.ts, test/escalation-guard.test.ts, test/dispatch-command.test.ts

### Approach

New PreToolUse(Bash) hook `escalation-guard.ts`, sibling of branch-guard: a pure
`decideEscalationGuard(payload, env)` returning a deny envelope or null, dep-free
node-only, always exit 0, one JSON line. Jurisdiction is three-state: (1)
`KEEPER_ESCALATION_ROLE` set in the hook's process env -> enforce that role's allowlist and
FAIL CLOSED on internal error (emit deny; never a non-zero exit — an exception exiting 1
silently disables the guard); (2) marker absent but `agent_id` present -> inert
(branch-guard's turf); (3) neither -> inert (human session keeps the fail-open
discipline). Matching policy: tokenize to top-level executable + args (never
prefix-match raw text), split compound commands on `| ; && || &` and require EVERY
segment to pass, enforce a word boundary after the command token, strip only the fixed
wrapper set (timeout/time/nice/nohup/stdbuf/bare xargs), and deny interpreter one-liners
and heredocs (python*/node/ruby/perl/bun -e), `sh -c`/`bash -c`, env-runner families,
command/process substitution, all file redirects, `tee`, and env-assignment prefixes.
Per-role allowlists as data: `unblock`/`resolve` (diagnosis) allow the keeper read/board
subset (escalation-brief, session, plan, query, bus, dispatch, baseline, status,
show-job, search-history, find-file-history), botctl, read-only git (log show diff
status rev-parse ls-files blame grep branch-list), read utilities (rg grep find ls cat
head tail wc jq), and repo gate runners (bun test, bun run <script>); `deconflict`/`repair`
additionally allow mutating git, keeper commit-work, and the build/tool families
deconflict's frontmatter already names. Launcher side: `buildKeeperAgentLaunchArgv` emits
a FOURTH always-present `--x-tmux-env` carrier `KEEPER_ESCALATION_ROLE=<verb-or-empty>`
(the KEEPER_PLAN_WORKTREE_BRANCH always-emit pattern, so a reused tmux session never
inherits a stale role); the dispatch path sets the verb for escalation launches only.
Register the hook in plugins/keeper/hooks/hooks.json as a second Bash matcher entry and
update the manifest description. The role reaches the guard via process env inheritance —
no SessionStart capture, no jobs fold.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/branch-guard.ts — the guard template: pure decide fn, deny-envelope shape, the agent_id key, and the allowlist-over-denylist rationale in its git-stash block
- src/exec-backend.ts:998-1041 — permission posture + the three existing always-emitted --x-tmux-env carriers; add the fourth here
- plugins/keeper/hooks/hooks.json — registration shape (matcher + command) and the description field
- test/branch-guard.test.ts — the two-tier test shape to copy: table-driven pure predicate + decision-ladder envelope assertions

**Optional** (reference as needed):
- test/dispatch-command.test.ts — launch argv byte-pins that shift with the new carrier
- plugins/plan/skills/deconflict/SKILL.md — the write-capable role's legitimate tool families

### Risks

- Fail-closed inversion for marked sessions deliberately diverges from branch-guard's unconditional fail-open — keep it strictly env-gated so a human session can never be fail-closed
- An over-tight unblock list bricks live escalation sessions; every deny envelope must name the denied command so the failure is diagnosable from the session transcript
- Both Bash guards fire on every call; neither may assume the other ran

### Test notes

Two-tier suite mirroring branch-guard's: table-driven allow/deny cases per role
(including the observed bypass forms: python3 heredoc, `python3 -c`, `>` redirect, `tee`,
compound `keeper status && uv run python3 -c ...`), plus jurisdiction-ladder cases (marker
absent + agent_id, neither, marker with malformed payload -> deny for marked / silent for
unmarked). Byte-pin updates for the new argv element. No real tmux/git/daemon.

## Acceptance

- [ ] A session carrying an escalation role has off-list Bash denied via the PreToolUse JSON envelope (exit 0), including interpreter -c/-e and heredoc forms, redirects, tee, command substitution, env-runner wrappers, and compound commands where any segment is off-list
- [ ] On-list commands pass untouched for each role, and the write-capable roles' git/build/commit-work families pass while remaining denied for diagnosis roles
- [ ] Sessions with no role marker — human sessions and agent_id subagents — are never affected by the guard
- [ ] A guard-internal error (malformed payload, thrown exception) denies for a marked session and allows for an unmarked one, and the hook process exits 0 in both cases
- [ ] Every claude launch minted by the dispatch/agent launch builder carries the role env carrier — the escalation verb on escalation launches, empty otherwise — and all launch-argv byte-pin tests pass
- [ ] The hook is registered in the keeper plugin hooks manifest and the fast suite is green including the new guard tests

## Done summary
Added role-keyed escalation-guard PreToolUse(Bash) hook (allowlist per role, fail-closed for marked sessions), registered it in the keeper hooks manifest, and emitted an always-present KEEPER_ESCALATION_ROLE launch carrier from buildKeeperAgentLaunchArgv.
## Evidence
