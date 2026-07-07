## Description

**Size:** M
**Files:** src/exec-backend.ts, src/tabs-core.ts, src/agent/main.ts, test/agent-byte-pin.test.ts, test/tabs.test.ts, test/exec-backend.test.ts

### Approach

Make the resume transport honor the documented identity contract: every resume launch carries the original keeper job id, and birth records stamp the harness-native resume target rather than the minted job id. `buildKeeperAgentLaunchArgv` gains a job-id input and emits a fourth repeated `--x-tmux-env KEEPER_JOB_ID=<id>` carrier on resume launches, following the existing unconditional last-wins carrier pattern — prompt-mode launches emit the empty `KEEPER_JOB_ID=` overwrite so a stale value in a reused tmux session env can never poison a fresh launch. Thread the id from callers: `keeperAgentLaunch`'s spec, `EnsureLaunchedFn`/`makeEnsureLaunched` (signature gains the candidate's job id), and `renderSnapshotScript` (dumped revive scripts carry the carrier per line). In the launcher, a resume launch (`hasContinueOrResume`) stamps the birth record's `resume_target` from the resume-target value present in the harness argv (pi `--session`, codex `resume`, hermes `--resume`), never from the fresh/carried job id — so identity (job id) and resume key (native target) stay distinct per the glossary.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/exec-backend.ts:964-1042 — buildKeeperAgentLaunchArgv; the three existing --x-tmux-env carriers and the "last-wins per dup key" + byte-pin notes
- src/agent/main.ts:2548-2604 — armBirthRecord: carried KEEPER_JOB_ID fold, resume_target stamp
- src/agent/args.ts:174-203 — isContinueOrResumeArg per harness (pi's `--session` counts as resume)
- src/tabs-core.ts:126-137, 855-880 — EnsureLaunchedFn contract + makeEnsureLaunched
- test/agent-byte-pin.test.ts + test/helpers/agent-main-harness.ts:165 — the argv pins that break with this change

**Optional** (reference as needed):
- src/exec-backend.ts:1213-1276 — keeperAgentLaunch spec plumbing
- src/tabs-core.ts:341-437 — renderSnapshotScript (dump-side carrier emission)
- src/agent/main.ts:2384-2398 — the fresh --session-id mint gate (resume launches skip it)

### Risks

- Byte-pin suites red if pinned argv arrays are not updated in the same change.
- A stale KEEPER_JOB_ID leaking into unrelated fresh launches — the unconditional empty-overwrite carrier is the guard; test it.

### Test notes

Byte-pin the new resume argv (with carrier) and the prompt argv (empty carrier). Drive keeper agent main through the harness with a carried env + resume argv and assert the birth-record draft reuses the carried id and stamps the argv-native resume target.

## Acceptance

- [ ] A resumed non-claude agent folds onto its original keeper job row — no orphan row is minted when the transport-built launch is replayed.
- [ ] Resume launches built by the exec-backend transport and by the dumped revive script both carry the job-identity env; prompt launches carry the empty overwrite carrier.
- [ ] Birth records on resume stamp resume_target to the harness-native target from the argv, never the minted or carried job id.
- [ ] All byte-pin suites updated in the same change and green.

## Done summary
Resume transport now carries the original keeper job id (KEEPER_JOB_ID env carrier on resume launches, empty overwrite on prompt launches) through buildKeeperAgentLaunchArgv/LaunchSpec/EnsureLaunchedFn/renderSnapshotScript, and armBirthRecord stamps resume_target from the harness-native argv token so a resumed non-claude tab folds onto its original job row and re-emits its native resume key.
## Evidence
