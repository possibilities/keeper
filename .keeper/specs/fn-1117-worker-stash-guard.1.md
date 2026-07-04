## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/branch-guard.ts, test/branch-guard.test.ts

### Approach

Extend the branch-guard's pure per-invocation predicate so a recognized
`git stash` invocation from a subagent (`agent_id`/`agent_type` present) is
denied unless its verb is on the read-only/ref-free allowlist {list, show,
create}. Verb resolution: after the existing global-flag strip, the verb is
exactly `tokens[0]`; an empty token list (bare `git stash` — git defines it
as `push`), a leading flag (`-u`, `-m msg`), or any non-allowlisted word
denies. Deny-by-default is scoped to the verb axis after a clean parse — an
unparseable command still fails open (exit 0, allow), preserving the hook's
fail-open contract. `pop` and `apply` are denied on the "touches the shared
stack or materializes stashed files into this tree" axis even though `apply`
never writes refs/stash — state that rationale in a code comment so a future
reader doesn't relax it. Broaden the single shared DENY_REASON (predicate
stays boolean, one code path) so the message covers both rules: never
create/switch branches AND never touch `git stash` — refs/stash is one stack
shared by every sibling worktree and the human's checkout; for file-level
undo use `git restore <path>`; to park work use a temp commit, never stash.
The hook stays a dependency-free pure function: no subprocess, no fs, no DB;
deny only via the PreToolUse JSON envelope; always exit 0.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/branch-guard.ts:67-149 — isBranchMutatingInvocation verb dispatch; the stash block slots before the final `return false`
- plugins/keeper/plugin/hooks/branch-guard.ts:143-146 — worktree block: the existing per-verb precedent (inverse polarity: it denies one verb, stash allows three)
- plugins/keeper/plugin/hooks/branch-guard.ts:182-186 — DENY_REASON const and its decideBranchGuard emit site (~line 232)
- test/branch-guard.test.ts:18-119 — deny/allow case-table idiom; `"git stash"` sits in the ALLOW array (~line 111) and must move to DENY
- test/branch-guard.test.ts:141-232 — decision-ladder tests (bashPayload helper); extend the reason assertion

**Optional** (reference as needed):
- plugins/keeper/plugin/hooks/branch-guard.ts:28-56 — stripGlobalFlags/subcommandTokens; reuse as-is, global flags are stripped before the stash block sees tokens
- plugins/keeper/plugin/hooks/branch-guard.ts:151-180 — SHELL_WRAPPER/GIT_INVOCATION recursion; wrapped/compound stash coverage comes free but must be asserted
- src/derivers.ts:678 — GIT_TREE_MUTATORS classifies `git stash` for events-log attribution; unrelated surface, do NOT touch

### Risks

- The `-m <allowlist-word>` operand bypass (`git stash -m show`): tokens[0] resolution denies it; pin the case so a future "skip flags then find verb" refactor can't reintroduce the bypass.
- Alias-laundered stash (`git -c alias.x=stash x push`, repo `[alias] st = stash`) cannot be resolved by a dep-free hook — an accepted gap documented in a code comment; the worker-prose ban (task 2) is the backstop.
- The guard fires only when agent context is present: the human and the daemon's own git stay ungated by design.

### Test notes

Extend the existing case-table arrays. DENY: bare `git stash`, `push`,
`push -u -m x`, `save`, `pop`, `apply`, `apply stash@{0}`, `drop`, `clear`,
`store deadbeef`, `branch b`, `export`, `import`, flag-only forms (`-u`,
`-p`, `--all`, `--include-untracked`), the `-m show` bypass pin, an unknown
verb (`puhs`), and wrapped/compound forms (`sh -c "git stash pop"`,
`git status && git stash`, `$(git stash pop)`, `FOO=1 git stash pop`,
`git -C /x stash pop`). ALLOW: `list`, `list --oneline`, `show`, `show -p`,
`create`, `create msg`, non-stash git commands unchanged, and any stash form
with NO agent context. Ladder: a stash deny envelope asserts the broadened
reason names the shared stash stack and `git restore`. Run
`bun test test/branch-guard.test.ts`, then the full fast `bun test`.

## Acceptance

- [ ] With agent context present, every mutating stash form — bare `git stash`, push/save in any flag form, pop, apply, drop, clear, store, branch, export, import, and verbs unknown today — produces the PreToolUse deny envelope (permissionDecision "deny", exit 0), including shell-wrapped and compound-command forms
- [ ] With agent context present, `git stash list`, `git stash show` (including diff flags), and `git stash create` are allowed; without agent context every stash form remains allowed
- [ ] `git stash -m show` (message-operand collision) is denied, pinned by a dedicated test
- [ ] The deny reason names the shared stash stack hazard and the `git restore <path>` alternative
- [ ] The branch-guard suite and the repo fast suite are green

## Done summary
Extended the branch-guard hook to deny every mutating/materializing git stash verb from subagents via the PreToolUse envelope (allowlist: list/show/create), broadened the shared DENY_REASON to name the shared refs/stash hazard and git restore alternative, and added a full stash deny/allow truth-table plus ladder tests.
## Evidence
