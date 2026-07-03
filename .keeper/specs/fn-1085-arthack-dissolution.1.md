## Description

**Size:** S
**Files:** src/exec-backend.ts, test/ (exec-backend argv tests)

### Approach

Add `--dangerously-skip-permissions` and `--permission-mode acceptEdits` to the WORKER
branch of buildKeeperAgentLaunchArgv, mirroring the pair-launch precedent — workers are
detached automated sessions with no human to prompt. Interactive launches keep their
existing posture untouched. Note in the argv-builder comment the one non-obvious fact:
deny-via-envelope hooks (branch-guard) still enforce under skip-permissions — this changes
prompting, not guarding. Extend the argv test matrix to pin both flags on the worker branch
and their absence on the interactive branch.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts buildKeeperAgentLaunchArgv — the worker/interactive branch split (study anchor :879-908; re-verify current lines)
- The pair path's permission flags in src/agent launch-config (study anchor launch-config.ts:217-222) — the precedent to mirror

### Risks

- acceptEdits vs skip-permissions interplay: verify the harness treats both flags together as the pair path does; snapshot the exact argv.

### Test notes

Argv unit tests only (pure builder); no live launch in the fast tier.

## Acceptance

- [ ] Worker argv carries both flags; interactive argv unchanged; tests pin both branches
- [ ] Builder comment states the deny-hooks-still-enforce fact

## Done summary
Added --permission-mode acceptEdits --dangerously-skip-permissions to buildKeeperAgentLaunchArgv (worker launch argv), mirroring the pair path; workers now carry keeper-owned permission posture instead of relying on a host auto-approve hook. Deny-via-envelope hooks still enforce. Byte-pin tests updated (exec-backend, restore-agents) plus a positive posture pin.
## Evidence
