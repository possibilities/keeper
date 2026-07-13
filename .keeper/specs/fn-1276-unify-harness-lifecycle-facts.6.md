## Description

**Size:** M
**Files:** scripts/audit-session-activity.ts, test/session-activity-audit.test.ts, test/readiness.test.ts, test/silent-stream-cut.test.ts, test/reducer-projections.test.ts, test/pi-extension.test.ts, test/autoclose-worker.test.ts, test/autopilot-worker.test.ts, test/restore-set.test.ts, test/restore-verify.test.ts, docs/install.md, docs/problem-codes.md, README.md

### Approach

Close the epic with an adversarial lifecycle matrix spanning activity, claims, transcript settlement, autoclose, finalize, restore, and resource cleanup. Build a read-only audit that classifies Claude/Pi rows from an explicit database path without mutating keeper state, and pair it with sanitized deterministic fixtures representing the observed bus-only idle pane, genuine child activity, orphan open child under terminal parent, stale evidence, delayed old start, cut/clean reorder, and restore/cleanup races.

Keep all automated tests hermetic; the audit accepts snapshots but tests only temporary databases. Report aggregate reason counts and identifiers needed for follow-up, never transcript bodies, prompts, shell output, or credentials.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `test/readiness.test.ts:257-297,904-1055` — readiness and occupancy matrix patterns.
- `test/silent-stream-cut.test.ts:134-259` — transcript ordering fixtures.
- `test/autoclose-worker.test.ts:162-625` — pure eligibility/actuation safety matrix.
- `test/reducer-projections.test.ts:2630-2776` — dispatch attribution and re-fold fixtures.
- `test/restore-set.test.ts:472-519,1288-1372,1499-1658` — restore exclusion and identity race fixtures.
- `test/exit-watcher.test.ts:551-917,1137-1313` — correction versus detect-only patterns.

**Optional** (reference as needed):
- `test/pi-extension.test.ts:58-145` — provider adapter goldens.
- `CONTEXT.md` — canonical Harness activity, Dispatch attempt/claim, and Resource-hold terms.
- `docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md` — cross-consumer transition contract.

### Risks

Live corpus counts move and cannot be acceptance thresholds. A diagnostic that opens the live database read-write or logs transcript content would violate the evidence constraints. A final test task must not become a substitute for focused tests in earlier implementation tasks.

### Test notes

Use `freshMemDb()`/`freshDbFile()` and injected clocks/probes only. Include duplicate/reordered events, daemon restart boundaries, legacy unfenced sessions, empty databases, partial transcript tails, multiple concurrent children, unknown/degraded evidence, renewed activity during cleanup grace, and stale resource identity.

### Detailed phases

1. Define a compact cross-consumer scenario table from ADR 0055 and encode it as pure fixtures.
2. Add the read-only audit with explicit path, bounded output, and no daemon/socket dependency.
3. Replay representative Claude/Pi lifecycle schedules and diff old versus new classifications diagnostically.
4. Run focused suites, the root fast suite, and the full root/plan/prompt gate.
5. Consolidate install/problem-code/README guidance to match the final observable behavior.

### Alternatives

Querying the resident daemon from tests was rejected because task lanes cannot verify undeployed code and tests must remain isolated. Exact historical count assertions were rejected because retention and live activity move continuously.

### Non-functional targets

Audit cost is linear in the selected bounded cohort, opens SQLite read-only, emits no sensitive payloads, and never writes the database or state directories. Fast tests stay within the repository’s bounded parallel gate and contain no sleeps.

### Rollout

Run the audit against a copied or read-only production snapshot before close, then perform resident-daemon verification only as an explicit operator post-deploy step after finalize. Keep legacy classification deltas in aggregate evidence until pre-change sessions age out.

## Acceptance

- [ ] A hermetic cross-consumer scenario matrix covers active, quiescent, unknown, parked-owner, stale-attempt, transcript-settlement, autoclose, finalize, restore, and stale-cleanup outcomes for Claude and Pi.
- [ ] A read-only audit accepts an explicit database path, produces bounded aggregate/reason output, and cannot write keeper state or expose transcript contents.
- [ ] Sanitized fixtures reproduce the stopped bus-only pane, genuine child activity, terminal-parent orphan child, delayed old start, cut/clean reorder, renewed activity, and restore/cleanup race regressions.
- [ ] Focused suites, `bun test`, and `bun run test:full` pass without booting a daemon, Worker, tmux, socket, subprocess, git, or live database.
- [ ] Operator docs use the canonical lifecycle vocabulary and give actionable recovery for unknown activity, stale attempts, settlement failures, and cleanup conflicts without duplicating ADR rationale.

## Done summary
Added a hermetic cross-consumer lifecycle scenario matrix, a bounded read-only audit script (scripts/audit-session-activity.ts) over Harness activity/Dispatch claims/Resource holds, and consolidated install/problem-codes/README operator guidance, closing the epic.
## Evidence
