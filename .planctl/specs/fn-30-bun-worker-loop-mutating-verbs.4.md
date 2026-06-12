## Description

**Size:** M
**Files:** src/verbs/claim.ts, src/verbs/block.ts, src/discovery.ts (new), src/config.ts (new), src/brief.ts (new), src/models.ts, src/ids.ts, src/cli.ts, test/ additions

### Approach

The no-commit pair. Port the discovery subset claim needs: loadRoots (config.yaml under ~/.config/planctl/, fail-soft to [~/code], expanduser semantics), discoverProjects (immediate children of roots with .planctl/), findProjectsWithTask — only what run_claim.py calls, nothing more. ids.ts gains isTaskId and epicIdFromTask. models.ts gains workerAgentForTier. brief.ts ports assemble_brief/write_brief (claim writes <state_dir>/briefs/<task_id>.json — mkdir the briefs dir, seed_state does not create it). claim: resolution via findProjectsWithTask or --project; precondition gates with the typed nested error envelope {success:false,error:{code,message,details}} — TASK_DONE never bypassed, --force bypasses CLAIMED_BY_OTHER/TASK_BLOCKED/DEPS_UNMET; CAS under lockTask (re-read runtime inside the lock, decide CLAIMED/ALREADY_MINE/CLAIMED_BY_OTHER); saveRuntime with the exact field set (status in_progress, updated_at, assignee, claimed_at, claim_note, evidence, blocked_reason null-cleared); write brief; work marker AFTER the CAS; emit via the readonly invocation pattern (claim never commits). block: under lockTask gate done→error, saveRuntime(blocked, blocked_reason), clear work marker, readonly emit. Both verbs registered in cli.ts following the landed verb-wiring pattern.

### Investigation targets

**Required** (read before coding):
- planctl/run_claim.py — the full gate/CAS/envelope contract
- planctl/run_block.py — gates and runtime fields
- planctl/brief.py and planctl/models.py:30 — brief assembly and tier mapping
- planctl/config.py + planctl/discovery.py — the subset being ported; respect fail-soft roots loading
- tests/test_worker_verbs.py — the landed conformance pins these verbs must satisfy

**Optional** (reference as needed):
- planctl/session_markers.py — marker write/clear contract
- src/invocation.ts buildPlanctlInvocationReadonly — reuse verbatim, claim/block emit through it

### Risks

The typed error envelope (nested error object) is a different shape from emitError's flat one — claim needs both shapes in the right places. The CAS must re-read inside the lock; reading before locking reintroduces the race the lock exists to close.

### Test notes

tests/test_worker_verbs.py claim/block selections green against dist/planctl-bun; bun units for discovery/brief/gates; zero commits proven.

## Acceptance

- [ ] claim conformance tests green via the compiled binary incl. force matrix and brief_ref; block tests green
- [ ] Zero commits from both verbs under the gate; runtime field sets byte-equal on disk
- [ ] Discovery subset honors config.yaml fail-soft semantics under tmp HOME

## Done summary

## Evidence
