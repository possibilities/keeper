## Description

**Size:** S
**Files:** plugins/plan/src/verbs/unblock.ts (new), plugins/plan/src/cli.ts, plugins/plan/test/ (new/extended test)

Add a `keeper plan unblock <task_id>` verb that flips a `blocked` task back to `todo` while preserving claim history (`assignee`, `claimed_at`, `claim_note`, `evidence`) — the clean resume verb the planner uses after resolving a block. The coarse `task_reset` (clears claim/evidence/spec) is NOT a substitute.

### Approach

Mirror `block.ts` exactly: `emitReadonly` (zero-commit — state-only write to the gitignored `state/<task>.state.json`), `withTaskLock` + `loadRuntime`/`saveRuntime` via `LocalFileStateStore`. Set `status:"todo"`, clear `blocked_reason`, preserve `assignee`/`claimed_at`/`claim_note`/`evidence` (the same preserve-set `block.ts` keeps). Add a precondition gate mirroring `block`'s done-gate: error (typed) if the task is not currently `blocked`. Register in BOTH places in `plugins/plan/src/cli.ts`: the `COMMANDS[]` array (~line 112, alphabetical) and the dispatch switch (~line 852). Bare verb name (`unblock`, not `task-unblock`). Do NOT add it to `VALIDATION_RESTAMP_VERBS` — it mirrors `block`, which is explicitly a non-member.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/block.ts:54-87 — the exact mirror: emitReadonly, withTaskLock, saveRuntime, the preserve-set, the done-precondition gate (lines 59-61).
- plugins/plan/src/cli.ts:112,852-856 — the two registration sites; block's arg parsing (only --reason) for the pattern.
- plugins/plan/src/store.ts:283-327 — `LocalFileStateStore` withTaskLock/loadRuntime/saveRuntime seam.

**Optional:**
- plugins/plan/src/verbs/task_reset.ts:50,85-123 — the coarse reset, to contrast what unblock must NOT clear.
- plugins/plan/src/emit.ts — emitReadonly envelope.

### Risks

- Getting the precondition gate wrong (silently unblocking a `todo`/`done` task). Mirror block's typed-error gate precisely.
- Forgetting the second registration site (dispatch switch) → verb parses but doesn't run.

### Test notes

Add coverage in `plugins/plan/test/` following the block/reset seed-then-assert shape: seed a `blocked` runtime state via `store.saveRuntime`, run unblock, assert `status:"todo"` and that `assignee`/`claimed_at`/`claim_note`/`evidence` survived; assert the typed error on a non-blocked task. In-process, zero real git.

## Acceptance

- [ ] `keeper plan unblock <blocked_task>` flips status to `todo`, clears `blocked_reason`, preserves claim/assignee/evidence; zero commit.
- [ ] Errors (typed) on a non-blocked task.
- [ ] Registered in both `COMMANDS[]` and the dispatch switch; `keeper plan unblock --help` works.
- [ ] Test added; `bun test` (plan plugin) green.

## Done summary

## Evidence
