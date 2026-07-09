# 30. Single-instance gate and runtime-qualified restart forensics

Status: accepted

## Context

Multiple keeperd processes were observed running concurrently against the production state dir: foreign boots (dev panes, CI-spawned daemons) probed the live daemon's sockets, recorded the live daemon's wedge as their own crash reasons in the shared restart ledger, and — because the only admission check was a TOCTOU pid-file (`acquireLock`) running inside the server/bus workers, after main had already opened and migrated the DB — each foreign boot was briefly a second writer and migrator on keeper.db.

The restart ledger compounded the forensics problem: its read-modify-write update stamped a dying boot's own boot timestamp as "now" and filtered out any entry at or after that timestamp, deleting overlapping newer boots. The crash-loop detector therefore undercounted precisely during overlapping-boot storms — many launchd runs surviving as a handful of ledger entries, below the distress threshold.

Two further facts constrain the design. `XPC_SERVICE_NAME` — the natural launchd-provenance signal — is a mutable heuristic (user-space tools such as direnv overwrite it), so it cannot gate enforcement. And the buildbot pipeline legitimately bounces keeperd via launchctl on green builds, which is indistinguishable from a genuine launchd crash-restart by provenance alone: counting raw boots would page the human during normal CI.

## Decision

1. **Hard single-instance gate.** Main acquires a kernel `flock(2)` (`LOCK_EX|LOCK_NB`, via the existing `usage-flock` FileLock primitive) on a dedicated `keeperd.lock` file at the top of `startDaemon()`, before `openDb()`, `migrate()`, or any worker spawn. The fd lives for the process lifetime, carries `FD_CLOEXEC`, and is owned by module scope on main — no worker thread may close it. A live incumbent fails the boot closed: exit 1, naming the holder and the `launchctl kickstart` recovery line. An inconclusive primitive (dlopen failure, exotic FS) logs loudly and boots anyway. Socket and lock unlinks become ownership-checked so a dying stray can never unlink a live daemon's socket.
2. **Append-only NDJSON restart ledger keyed by `boot_id`.** Boot appends one line (`boot_id`, timestamp, provenance); `fatalExit` appends one enrichment line matched on `boot_id`, never on timestamp — killing both the overlap-erase and double-count classes. Compaction and window-aging happen only at boot, in the process holding the single-instance lock. The legacy JSON-array shape is dual-read at compaction so the crash-loop count survives the format transition.
3. **Provenance is a forensic label, never an enforcement input.** Tri-state — `launchd` / `unknown` / `foreign` — derived from the `XPC_SERVICE_NAME` heuristic, with missing or garbage values mapping to `unknown`. All lines are retained; a `foreign` line is prime evidence that something ran a stray daemon.
4. **Runtime-qualified crash-loop counting.** A boot counts toward the distress threshold only when its predecessor died young (short runtime before death), mirroring launchd's own throttle model: repeated early deaths are a crash loop; bounces of healthy long-running daemons are not, no matter who bounced them. `foreign` boots are excluded from the count entirely; `unknown` counts. `decideCrashLoop` stays a pure timestamp counter — the producer collapses lines per `boot_id`, applies the runtime qualification, and filters provenance before handing it bare timestamps.

## Consequences

- A second daemon now dies in milliseconds, before touching the DB — the second-writer/second-migrator window is closed.
- CI bounce storms and operator kickstarts no longer trip the distress row; genuine rapid-death loops still do, and undercounting during overlapping-boot storms is fixed.
- A wedged-but-alive daemon holds the flock and blocks every replacement, so serve-liveness watchdog correctness is a prerequisite for the gate's safety; both land in the same epic.
- The test sandbox gains a `KEEPER_SINGLE_INSTANCE_LOCK` state class in the same commit as the gate — a host-wide lock without it would wedge parallel test runners.
- The restart-ledger mechanism described in ADR 0003 (replace-in-place JSON array) is superseded by this record; 0003's core stance — fatalExit over in-process self-heal — is unchanged.
