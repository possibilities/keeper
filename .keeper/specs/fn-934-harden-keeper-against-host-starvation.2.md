## Description

**Size:** M
**Files:** src/reaper-worker.ts, src/db.ts, src/daemon.ts, test/reaper-worker.test.ts, README.md, CLAUDE.md

### Approach

Add a THIRD reaper arm `selectOrphanedProcessCandidates(...)` to `src/reaper-worker.ts`,
spread into `selectFromDb` (~:341-349) alongside the existing two arms, that kills
agent-orphaned runaway host processes. Keep the selection predicate PURE with injected
seams (`enumeratePids` / `isAlive` / `readStartTime` / `readPpid` / `readUid` /
`readExePath` / `nowSecs`) — mirror `reprobeLoop`'s injected-probe shape — so it is
unit-testable with a synthetic process census; reuse `isPidAlive` (src/server-worker.ts:907)
and `readOsStartTime` (src/seed-sweep.ts:101). Pid enumeration + uid/exe-path reads are
net-new (no existing enumerator). The kill GATE is a closed conjunction so it matches
ONLY known runaway classes and NEVER keeperd, a live plan worker, the human's shell, or
a legit long process:

  uid == self  AND  process-info read succeeded (proc_pidinfo non-zero/non-partial)
  AND  ppid == 1 (reparented orphan)  AND  exe_path matches a CLOSED runaway allow-list
  (orphaned `bun test --test-worker`, infinite-loop shell harnesses, leaked flock_peer)
  AND  age > minAge (launch-race guard, several minutes)  AND  pid NOT in keeper's live
  job/pane set (a read-only `jobs` lookup of live pids excludes keeper's own tree).

Match on exe_path, never the (spoofable, 16-char-truncated) process name. Kill via a
NET-NEW raw-pid actuator (`process.kill`) — the existing actuator is tmux `killWindow`
only. Escalate two-phase WITHOUT an in-cycle blocking sleep: a first match sends SIGTERM
and stamps the in-memory cooldown; the NEXT tick that still sees the same `(pid,start_time)`
alive sends SIGKILL. Re-fingerprint `(pid,start_time)` at the TOCTOU pre-kill re-check
(defends against pid reuse). The arm NEVER throws (log-and-skip; ESRCH/EPERM on kill are
non-fatal) — a throw would crash the worker (onerror→fatalExit). Add an `arm=orphan
pid=… exe=…` audit fragment to `describeCandidate`. New config `disableOrphanReap`
(a `string[]` of exe-signatures to exempt, mirroring the `disableAutoclose` shape at
src/db.ts:165) threads through `daemon.ts` workerData. Update the README reaper taxonomy
(two arms → three) + the CLAUDE.md "three distinct reapers" block (→ four).

### Investigation targets

**Required** (read before coding):
- src/reaper-worker.ts:175, :259, :322-350 — the two existing arms + `selectFromDb` spread point
- src/reaper-worker.ts:376-411 — `reaperCycle` TOCTOU re-check + in-memory cooldown + the single `killWindow` actuator (the raw-pid actuator is net-new alongside it)
- src/reaper-worker.ts:416 — `describeCandidate` (add the orphan audit fragment)
- src/exit-watcher.ts:321 — `reprobeLoop`, the injected-probe / age-gated sweep model
- src/server-worker.ts:907 — `isPidAlive`; src/seed-sweep.ts:101 — `readOsStartTime`; src/bus-worker.ts:564 — the `ps -o ppid=` precedent
- src/db.ts:165 — `disableAutoclose: string[]` config precedent; src/daemon.ts (reaper spawn + workerData wiring)

### Risks

- Killing the wrong process is catastrophic and self-inflicting. The closed conjunction + uid-scope + exe_path (not name) + re-fingerprint-at-TOCTOU + exclude-keeper's-live-set are ALL load-bearing — none optional.
- A blocking SIGTERM-grace sleep would stall the 1s tick — use the two-phase cooldown model instead.
- A throw crashes the worker (fatalExit) — every probe/kill path must be a logged non-fatal skip.

### Test notes

PURE unit test: drive `selectOrphanedProcessCandidates` with a SYNTHETIC process census
+ injected seams — prove it selects an orphaned runaway, and proves it does NOT select
(each on its own row): a live-parented test run, keeperd's own pid, a live plan-worker
pid, the human's shell, an other-uid process, a too-young process, a probe-failed pid.
Any real-`ps`/real-process integration goes in `*.slow.test.ts` + scripts/test-real-git-allowlist.txt
(the no-real-git rule generalizes to no-real-process). `bun run test:full`.

## Acceptance

- [ ] A new pure `selectOrphanedProcessCandidates` arm composes into `selectFromDb`; selection is testable with an injected synthetic census (no real `ps` in the fast tier).
- [ ] The kill gate is the closed conjunction (uid==self ∧ proc-info-ok ∧ ppid==1 ∧ exe_path in a closed allow-list ∧ age>min ∧ pid∉keeper's live set); it provably never selects keeperd, a live worker, the human's shell, or an other-uid process.
- [ ] Kill is a raw-pid actuator with two-phase SIGTERM→(next tick)→SIGKILL via cooldown, re-fingerprinting `(pid,start_time)` at the TOCTOU recheck; no in-cycle blocking sleep; arm never throws.
- [ ] `disableOrphanReap` config (string[] exe-signature exemptions) threads through workerData; an `arm=orphan` audit line is emitted per attempt.
- [ ] README reaper taxonomy + CLAUDE.md "reapers" block updated (→ the orphan arm); `bun run test:full` green.

## Done summary

## Evidence
