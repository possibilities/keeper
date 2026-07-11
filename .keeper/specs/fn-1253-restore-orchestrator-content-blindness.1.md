## Description

**Size:** M
**Files:** plugins/plan/src/verbs/audit_gate_check.ts, plugins/plan/src/verbs/audit_submit_task.ts, plugins/plan/src/cli.ts, plugins/plan/test/saga-audit-gate-check.test.ts, plugins/plan/test/audit-submit-task.test.ts, plugins/plan/test/verbs-readonly.test.ts

### Approach

Two task-scoped audit verbs give the per-task audit gate a typed seam so the /plan:work orchestrator never opens the finding artifact. `keeper plan audit gate-check <task_id>` is read-only: it derives the task's current commit set itself (trailer-authentic scan, grouped per repo), compares against the persisted artifact's stamped hash, and emits exactly one JSON root `{exists, covers_current_commits, status, finding_ref}` with `status` clamped to the clean/mild/severe enum — anything else reads as unreadable, which reports not-covering (safe re-audit). `keeper plan audit submit-task <task_id> --file - --status <clean|mild|severe>` persists the auditor's findings payload commit-free into the per-task artifact, deriving `commits` server-side over the identical scan set gate-check uses (never trusting a caller-supplied commit list) so the staleness hash always agrees; it stamps per-finding `status: accumulated-open` when absent and rejects a bad top-level status with a typed error. Both wrap the existing audit_artifacts helpers — no reimplementation of reading, writing, or hashing. The artifact schema is a three-consumer contract (gate-check, close-preflight's finding refs, the close audit's fingerprint dedup): top-level status enum, commits as repo-grouped sha lists, findings as fingerprint+status entries — keep the two status vocabularies (top-level clean/mild/severe vs per-finding accumulated-open/fixed) distinct.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/audit_artifacts.ts:210-276 — readTaskFinding / writeTaskFinding / taskFindingCoversCommitSet + CommitGroup + computeCommitSetHash; the helpers these verbs wrap.
- plugins/plan/src/verbs/audit_submit.ts:39-87 — the submit mirror: resolveAuditContext, readPayloadCapped, SubmitError to emitSubmitError, content-blind envelope.
- plugins/plan/src/verbs/reconcile.ts:135 — exported findSourceCommits, and the ordered scan-repo set around :290-332; gate-check derives its own CommitGroup[] from these. Reconcile's flat {sha, repo}[] envelope shape is NOT the input.
- plugins/plan/src/cli.ts:405-449 — the audit group leaf-registration pattern (leafPositionals, leafUsageError click parity).

**Optional** (reference as needed):
- plugins/plan/test/audit-submit.test.ts — seeds through the same audit_artifacts writer the verb reads; copy for submit-task.
- plugins/plan/test/verbs-readonly.test.ts — the single-JSON-root conformance suite gate-check must join.

### Risks

- Hash-parity drift between the gate-check and submit-task derivations breaks idempotency in both directions (perpetual re-audit, or a stale short-circuit) — both verbs must share one derivation helper.
- findSourceCommits is fail-closed (throws on an absent git binary): gate-check surfaces a typed tooling error, never a fabricated not-covering envelope.

### Test notes

bun test in plugins/plan, fake VCS via getVcs() (no real git). Round-trip: submit-task then gate-check reports covering; a new task-trailered commit flips it; a malformed artifact status takes the clamped/unreadable path.

## Acceptance

- [ ] `keeper plan audit gate-check <task_id>` emits exactly one top-level JSON value with exists, covers_current_commits, status (null or clean/mild/severe), and finding_ref, and passes the read-only single-root conformance suite.
- [ ] `keeper plan audit submit-task <task_id> --file - --status <s>` persists the per-task finding artifact commit-free with stamped schema version, ids, and a server-side commit_set_hash; a status outside the enum is a typed error; per-finding status defaults to accumulated-open.
- [ ] Round-trip parity holds: submit-task then gate-check reports covering against an unchanged repo, and not-covering after a new task-trailered commit lands.
- [ ] A git-unavailable environment yields a typed tooling error from gate-check rather than a fabricated envelope.
- [ ] plugins/plan test, lint, and typecheck suites are green.

## Done summary

## Evidence
