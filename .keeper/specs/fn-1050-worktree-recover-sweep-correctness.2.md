## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, README.md, CLAUDE.md

### Approach

Mint recover failure rows per-(epic,repoDir): add a sibling of `worktreeFinalizeDispatchId` (src/autopilot-worker.ts:668) shaped `worktree-recover:<epicId>-<repoDirHash(repoDir)>` reusing `repoDirHash` (src/worktree-plan.ts:197). Epic-tied pass-2/pass-3 failures adopt it; the epicId:null pass-1 rows (list-failed, abort-failed, default-branch-failed, base-list-failed) KEEP the existing per-dir `worktreeRecoverDispatchId(f.dir)` fallback. The mint (autopilot-worker.ts:5957-5966) and `recoverFailuresToClear` (:632-647) compute the key identically and MUST change in lockstep — a one-sided change makes rows un-clearable. Auto-clear scoping is reason-prefix based (snapshot partition :5260-5288), so the id change does not affect scoping; verify the new full key `close::worktree-recover:<epicId>-<hash>` passes `parseDispatchKey` and `isRetryableDispatchKey` (src/dispatch-command.ts:59,109) exactly as the finalize key does, and that boot GC (src/daemon.ts:287) retains it. No schema change: the id lives in the DispatchFailed payload; `foldDispatchFailed` (src/reducer.ts:3990-4023) UPSERTs on (verb,id) unchanged and re-fold reconstructs the mixed-key history deterministically.

Deploy transition is self-healing by design and must be TESTED: persisted old-scheme bare-epic recover rows sit in openRecoverIds while fresh failures mint new keys, so `recoverFailuresToClear` level-clears them on the first post-fix cycle; a genuine finalizeEpic close-sink conflict (`close::<epic>`, non-recover reason) must remain untouched by that clear. Also assert the recover keys never intersect the daemon merge-escalation exact token (`worktree-merge-conflict`, src/daemon.ts:920).

Update README keying prose (~3566-3574, finalize prose ~3514-3520 as template) and the one-clause CLAUDE.md worktree-paragraph precision update naming the new key shape (no expansion; lint-claude-md must stay green).

Heads-up: src/autopilot-worker.ts contains a real NUL byte around offset 175300 — use `rg -a`.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:5957-5966,632-647 — the mint and the clear that must move in lockstep
- src/autopilot-worker.ts:5260-5288,604-673 — the reason-vs-id-prefix partition and both existing id mint functions
- test/autopilot-worker.test.ts:8526-8564,8577,6933 — the tests that encode the OLD key and will break; :6933 stays valid for null-epic rows
- test/autopilot-worker.test.ts:5492,5531,5553,5607 — the finalize per-repo test family to mirror
- src/dispatch-command.ts:59,109 — key parse/retryability the new id must pass

**Optional** (reference as needed):
- src/reducer.ts:3990-4023 — foldDispatchFailed UPSERT (merge_escalated_at preserved through UPSERT)
- src/daemon.ts:287,897-925 — boot GC and the merge-escalation sweep to assert non-intersection

### Risks

- A namespace collision between `worktree-recover:<epicId>-<hash>` and the null-fallback per-dir slug would cross-clear rows — improbable (slug vs base36 hash) but assert disjointness in a test
- The same-cycle clear-old/mint-new transition must not open a window where a still-blocked epic reads unblocked — lane-cut decisions consume the cycle-start snapshot; add the assertion rather than assuming

### Test notes

Mirror the finalize family: two-repo recover failures → distinct rows, disjoint clear sets, per-repo level-clear. Deploy-transition test: seed an old-scheme bare-epic recover row + a genuine close-sink conflict row; run a cycle; old row cleared, conflict row intact.

## Acceptance

- [ ] Epic-tied recover failures key per-(epic,repoDir); pass-1 null-epic rows keep the per-dir key
- [ ] Mint and clear stay in lockstep; old-scheme rows self-heal in one cycle; genuine close-sink conflicts never auto-clear
- [ ] New key passes parseDispatchKey/isRetryableDispatchKey and survives boot GC; README + CLAUDE.md clause updated; lint-claude-md green
- [ ] Full fast suite green

## Done summary

## Evidence
