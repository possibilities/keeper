## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/branch-guard.ts, test/branch-guard.test.ts

### Approach

Close `stripGlobalFlags`'s gap so a subagent cannot bypass the branch-create/switch/worktree-add deny via a SPACE-form git global flag. Today the stripper consumes glued/equals-form globals (`--git-dir=…`) and space-form `-C`/`-c`, but not space-form long valued globals (`--git-dir <path>`, `--work-tree <path>`, `--namespace <x>`, and the rest — mirror escalation-guard's `GIT_VALUED_GLOBAL_FLAGS`: `--git-dir`/`--work-tree`/`--namespace`/`--super-prefix`/`--config-env`/`--attr-source`). Extend the stripper to consume BOTH the flag AND its value token for each, robust to a quoted/spaced value path — consume the value as one token, not a whitespace-run (`--git-dir "/my dir/.git"` must not misparse). If only the flag is stripped, its `<path>` value is misread as the subcommand and the branch-create slips through — and branch-guard fails OPEN, so the miss is silent. Drop the earlier `-P` idea: `-P` is not a git global (`-p`/`--paginate` lowercase is already handled). Keep branch-guard fail-open, exit-0, and only ever denying a subagent (`agent_id` present), never a human.

### Investigation targets

*Verify before relying — planner-verified at authoring time.*

**Required:**
- plugins/keeper/plugin/hooks/branch-guard.ts:28 — `stripGlobalFlags`: the `-C`/`-c <val>` value-consumption (~:32) and the bare/glued global alternation (~:40) — the space-form long globals extend the value-consuming shape.
- plugins/keeper/plugin/hooks/escalation-guard.ts:~425 — `GIT_VALUED_GLOBAL_FLAGS`: the authoritative valued-global list to mirror.
- test/branch-guard.test.ts — the table-driven allow/deny arrays and the `GIT_INVOCATION` → `isBranchMutatingInvocation` flow the cases exercise.

### Risks

- Value-token consumption is the correctness crux: a miss is a silent fail-open bypass. Must handle a quoted/spaced value path.
- branch-guard only denies a subagent — never false-deny a human; keep the `agent_id` gate and the exit-0 fail-open posture.

### Test notes

Deny (as a subagent): `git --git-dir /tmp/x checkout -b evil`, `git --git-dir "/my dir/.git" switch -c evil`, `git --work-tree /x worktree add /y`; allow the equivalent read commands and confirm the existing allow-cases still pass. Fast `bun test` tier.

## Acceptance

- [ ] A subagent invoking a branch create/switch/worktree-add behind a space-form valued git global (`--git-dir <path>` and every `GIT_VALUED_GLOBAL_FLAGS` sibling), including a quoted/spaced value, is denied.
- [ ] Equivalent read commands and pre-existing allow-cases are still allowed; the guard stays exit-0, fail-open, and subagent-only.
- [ ] `bun test test/branch-guard.test.ts` is green.

## Done summary

## Evidence
