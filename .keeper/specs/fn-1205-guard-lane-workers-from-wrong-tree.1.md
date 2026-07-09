## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/wrong-tree-guard.ts, plugins/keeper/hooks/hooks.json, plugins/keeper/test (hook suite), CLAUDE.md

### Approach

New PreToolUse hook, structured like branch-guard (pure payload decision, deny via the JSON envelope, always exit 0) but marker-keyed like escalation-guard: it arms only when KEEPER_PLAN_WORKTREE is present and non-empty (the launch-injected lane path; absent/empty — including serial launches and the human's own session — the hook is inert-allow). Decision rule: resolve the write target; deny iff it lands inside a tracked repo working tree whose toplevel is not the lane realpath — with .keeper/ paths under any repo allowlisted (plan state legitimately writes to primary_repo/.keeper), and a small unconditional denylist (.git/config and credential-shaped paths) regardless of lane. Everything outside tracked repos (temp, scratchpad, home, state dirs) is allowed untouched. Register two matchers (Write|Edit|MultiEdit and Bash), reusing escalation-guard's existing Bash write-vector detection (redirects, heredocs, interpreters, tee/in-place editors) rather than inventing a parser; string parsing is best-effort audit by explicit discipline — state that in the hook header. Realpath both sides; when the target cannot resolve (create-new paths), resolve the nearest existing ancestor; on any resolution error, allow (fail-open) and log privately. node:* imports only, no bun:sqlite, size-bounded single-line JSON logging, never host stdout.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/branch-guard.ts:250 — the deny-envelope structure and payload parsing to mirror
- plugins/keeper/plugin/hooks/escalation-guard.ts:747 — env-marker read; its write-bypass-class detection to reuse
- src/exec-backend.ts:1142 — where KEEPER_PLAN_WORKTREE is injected (realpath-normalized, torn down at finalize)
- plugins/keeper/hooks/hooks.json — dual-matcher registration precedent (sidecar-writer)

### Risks

- How the guard learns "tracked repo toplevels": prefer deriving from the write target itself (walk up to a .git boundary) over reading keeper config — hooks must stay dep-free and fast.
- Env propagation: confirm KEEPER_PLAN_WORKTREE actually reaches the hook subprocess in a lane launch (escalation-guard's marker proves the channel; verify for this variable).

### Test notes

Hook-level tests with synthetic payloads: lane-marked + shared-checkout target → deny; lane-marked + own-lane target → allow; .keeper under primary repo → allow; unmarked session → allow-all; Bash vectors (redirect, heredoc, tee, sed -i) into the shared checkout → deny; unresolvable path → allow; .git/config anywhere → deny.

## Acceptance

- [ ] Lane-marked writes into a non-lane tracked repo tree are denied via the envelope across direct tools and the detected Bash write vectors
- [ ] .keeper plan-state writes, temp/home/state-dir writes, and all unmarked sessions are unaffected
- [ ] The hook is fail-open on every internal error path and emits nothing on host stdout
- [ ] CLAUDE.md's hook bullet reflects seven hooks; the plugin hook suite is green
- [ ] keeper fast suite green

## Done summary
Added the wrong-tree-guard PreToolUse hook (Write|Edit|MultiEdit|Bash) that denies a worktree-lane worker's write into any non-lane tracked repo tree — direct file_path plus best-effort Bash redirect/heredoc/tee/sed -i vectors — while allowing .keeper plan-state, temp/home/state, and own-lane writes, denying .git/config+credentials regardless of lane, and failing open. Registered the dual matcher, bumped CLAUDE.md to seven hooks, and added a 67-case pure+real-fs test suite.
## Evidence
