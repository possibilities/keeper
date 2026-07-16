## Description

**Size:** S
**Files:** src/daemon.ts, test/single-instance-lock.test.ts, docs/adr/0030-single-instance-gate-and-restart-provenance.md

### Approach

Make the `degraded` outcome of the single-instance gate fail CLOSED, mirroring the existing `refused` (live-incumbent) branch. In `acquireSingleInstanceLock`, the degraded branch currently emits a warning and `return`s (booting ungated); change it to emit a two-line operator diagnostic (line 1: the inconclusive-primitive cause naming the lock path + the underlying error/`reason`; line 2: the same `launchctl kickstart -k gui/$(id -u)/arthack.keeperd` recovery line the refused branch uses) then exit the process non-zero — with an exit code DISTINGUISHABLE from refused's so a launchd-log loop is attributable (refused stays as-is; degraded uses a distinct non-zero code, verified not to collide with existing daemon exit codes). The exit fires before `openDb`/migrate/the boot-ledger append, so the degraded boot opens no DB and mints no ledger entry (this also removes a spurious `boot` ledger line the current degraded-boot writes). `decideSingleInstanceGate` (the pure classifier) is UNCHANGED — it correctly maps a throw to `degraded`. To make this fast-tier testable without driving `startDaemon` or calling `process.exit` in-process, extract a PURE outcome→action seam (e.g. `decideSingleInstanceAction(outcome, lockPath)` → `{action:"proceed", lock}` | `{action:"exit", code, message}` for refused and degraded) that the impure `acquireSingleInstanceLock` shell executes (it pins `singleInstanceLock` on proceed, prints + `process.exit(code)` on exit); the seam enacts nothing. Do NOT use `fatalExit` (a `startDaemon` closure over `db`, out of scope at this pre-openDb gate) — use a bare `process.exit` like refused. Observability floor is stderr-via-launchd (the fix stays side-effect-free before the gate, which is what makes the fail-closed crash-loop safe); the fact that a persistently-broken primitive now wedges every boot loudly on stderr but is invisible to the restart-ledger/crash-loop-distress is an ACCEPTED, documented consequence (a fuller board-attribution path is a deferred follow-up, not this task). Invert the four stale comment clusters in src/daemon.ts that document fail-open as intended (the outcome-union doc, the classifier doc's fail-open rationale, the consumer doc, and the startDaemon inline comment) to describe fail-closed-on-inconclusive — forward-facing, no provenance. Revise ADR 0030 Decision-point-1 in place (it no longer "boots anyway") and amend its Consequences (dual-writer window now also closes on the inconclusive-lock edge).

### Investigation targets

*Verify before relying — planner-verified on current main, but daemon.ts is ~14k lines and fn-1286 edits it in other regions.*

**Required** (read before coding):
- src/daemon.ts (`acquireSingleInstanceLock`, ~6987-7018) — the fix site: degraded branch (~7003) and the refused branch just below it (~7010, the message + `process.exit` mechanism to mirror)
- src/daemon.ts (`decideSingleInstanceGate` + `SingleInstanceGateOutcome`, ~6941-6968) — the pure classifier (UNCHANGED) and where the new action seam sits beside it
- src/daemon.ts (startDaemon call site, ~7029-7046) — confirms the acquire runs before `restartLedgerBootId` mint, `openDb`, and the boot-ledger append (so a degraded exit is trace-free by construction)
- test/single-instance-lock.test.ts — the pure truth-table home; new rows assert the action + exit code + diagnostic per outcome; imports the seam from `../src/daemon`
- docs/adr/0030-single-instance-gate-and-restart-provenance.md (Decision point 1, ~line 15; Consequences ~item 22)

**Optional** (reference as needed):
- src/usage-flock.ts (`FileLock.tryAcquire`, ~211-228) — returns null on EWOULDBLOCK, THROWS on any other errno (`errno=N` in the message); `openSync(lockPath,"w")` can throw EPERM/ENOSPC/EACCES before the flock — all funnel to the single catch→degraded
- the four stale comment clusters: outcome-union doc (~6933), classifier doc (~6946), consumer doc (~6980), startDaemon inline (~7031)
- src/db.ts (`resolveSingleInstanceLockPath`) — where the lock path in the diagnostic comes from

### Risks

- **fatalExit is a trap** — it is a `startDaemon` closure that closes over `db` (not open yet at the gate); reaching for it fails. Use bare `process.exit` mirroring refused.
- **Test footgun** — the fast suite must call the exported PURE seam with synthetic outcomes and assert its returned action/code/message; it must NEVER call `acquireSingleInstanceLock` (that shell calls `process.exit` — kills the runner — and `mkdirSync`). Keep the seam a standalone `export function`, the shell unexported.
- **Comment inversion must replace the rationale, not just negate it** — the classifier comment justifies fail-open ("a throw fails OPEN so a broken primitive can never wedge every boot"); the new behavior deliberately DOES wedge every boot on a persistent break — the rewrite must own that ("loud fail-closed beats silent dual-writer"), not leave a contradictory fragment.
- **disableSingleInstanceLock carve-out** — the in-process test tier sets it so `acquireSingleInstanceLock` is never called; the new exit lives inside that guard, so it never fires in-process. Preserve the guard and the singleton short-circuit; do not move the exit outside them.

### Test notes

Extend `test/single-instance-lock.test.ts` (root-phase, auto-discovered — no manifest edit; obeys the fast-test lint, so no startDaemon/spawn/openDb-without-migrate:false). Truth-table the new pure action seam: `acquired` → proceed (carries the lock); `refused` → exit with the refused code + incumbent diagnostic; `degraded` (Error throw AND non-Error throw) → exit with the distinct degraded code + a diagnostic embedding the lock path and the reason. Keep the existing `decideSingleInstanceGate` classification rows green (classifier unchanged). Rename any test-name string that says "fail OPEN" at the consumer level (now misleading). Assert the diagnostic strings are bounded (no unbounded errno/path interpolation).

## Acceptance

- [ ] A degraded (throwing/inconclusive) lock outcome makes the daemon exit non-zero before opening the DB or appending a boot-ledger entry; no second daemon can boot ungated on an inconclusive lock.
- [ ] The refused (live-incumbent) and acquired (clean) outcomes behave exactly as before — refused exits, acquired proceeds and pins the lock with its fd intact.
- [ ] The degraded exit code is distinct from the refused exit code, and the degraded diagnostic names the lock path and the underlying error.
- [ ] A pure, exported outcome→action seam exists and is truth-tabled in test/single-instance-lock.test.ts for all three outcomes (including both Error and non-Error throw shapes for degraded); the classifier stays pure and unchanged; the fast gate passes.
- [ ] No source comment or ADR 0030 decision text still describes the degraded/inconclusive outcome as intended fail-open; ADR 0030 reflects fail-closed and the widened dual-writer-window-closed consequence.

## Done summary
Single-instance gate fails CLOSED on a degraded/thrown lock (distinct exit code before openDb, ADR 0030 revised, outcome seam tested); operator re-run 17/0 on single-instance-lock suite; landed via plain-git escape (terminal-leg claims never settling adoptable) as 9df7fe32 on the epic lane
## Evidence
- Commits: 9df7fe32
- Tests: bun test single-instance-lock 17/0 (operator re-run in lane)