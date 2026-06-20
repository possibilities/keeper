## Overview

The git-worker pegged the daemon at ~144% CPU during the 2026-06-08
multi-agent soak. Root cause: the `data_version` poll (`DB_POLL_MS=100`,
`src/git-worker.ts:2784`) fans a `git status` snapshot out to EVERY
subscribed root on every foreign DB write. `data_version` carries no root
attribution, so a hook event dirtying repo A schedules a snapshot in repos
B/C/D too — O(roots × write-rate) `git status` shell-outs under sustained
multi-agent load (log: "coalesced N no-op GitSnapshot emit" peaked 225/min;
~9 subscribed roots; CPU fell 144%→35%→10% as writes stopped, confirming
load-driven + self-resolving).

The fix DROPS the data_version snapshot fan-out arm: `data_version` drives
membership reconcile ONLY (cheap, kept), and per-root snapshots come solely
from the existing worktree + git-common-dir FSEvents subscriptions
(`subscribeRoot`, src/git-worker.ts:2478) with the 60s heartbeat as the
single drop backstop. This is correct because those two FSEvents subs already
cover everything `git status` reflects (working tree + HEAD + index), and the
drop-triggered rescan (`isDropError → sched.schedule()`) plus the heartbeat
already own FSEvents-mute insurance. The fan-out's floor+ceiling (fn-716) were
patching a snapshot source that never belonged on the write-driven poll — the
backstop axis is time/staleness (the heartbeat), not write events. fn-716
tamed the flood; this epic removes its source.

Diagnostic-first (mirrors fn-744): task .1 builds a CPU-sampling repro and
PROVES the fan-out is the dominant cost AND that FSEvents+heartbeat fully
cover change detection BEFORE the arm is removed. The evidence-gated fallback,
if .1 shows 60s drop-recovery is too coarse under load, is to TIGHTEN THE
HEARTBEAT with a per-root staleness gate (re-snapshot a root whose
FSEvents-stamped `lastFastPathAt` has gone stale past a sub-60s threshold) —
attributed, O(stale-roots), on the heartbeat timer, NEVER back on the
data_version poll.

## Quick commands

- `bun scripts/git-worker-cpu-soak.ts` — drive the multi-agent write storm + sample daemon/git CPU (built in .1)
- `bun test test/git-worker.test.ts` — pure-decision + regression tests
- `ps -p $(pgrep -f 'src/daemon.ts') -o pid,pcpu` — before/after CPU check against the live daemon
- `bun run test` — full umbrella (fast + slow + opentui), still green

## Acceptance

- [ ] Diagnostic (.1) proves with measured evidence that the data_version
  snapshot fan-out is the dominant CPU cost AND that the per-root worktree +
  git-common-dir FSEvents subs cover all `git status`-affecting change classes
  (any FSEvents-invisible-but-data_version-visible class for an already-
  subscribed root is enumerated, or proven empty).
- [ ] The data_version snapshot fan-out arm is removed: `data_version` drives
  membership reconcile only; per-root snapshots are FSEvents-driven with the
  60s heartbeat backstop. No new DB write / synthetic event / RPC (producer-
  side, read-only DB).
- [ ] Daemon CPU is <10% at idle under the SAME soak that pegged it (144%),
  verified `ps -p $(pgrep -f 'src/daemon.ts') -o pcpu` before/after, sampling
  daemon PID AND aggregated `git` child CPU (so the cost didn't merely move to
  git PIDs).
- [ ] A genuine foreign change in any subscribed root is still observed — via
  FSEvents on the fast path, the 60s heartbeat at worst — and a regression
  test asserts a foreign write to root A does NOT fan a snapshot to roots
  B/C/D.
- [ ] Invariants intact: event-driven not polled (no raw-poll replacement of
  FSEvents); data_version poll + same-process kick contract preserved
  (membership reconcile stays); re-fold determinism / folds-never-probe
  untouched. Docs (git-worker docblock, decideDataVersionWake JSDoc, CLAUDE.md
  "No kernel watchers", README architecture) rewritten to the current state.
- [ ] `bun run test` umbrella green.

## Early proof point

Task that proves the approach: `.1`. It is the keystone — it must establish
BOTH that the fan-out is the dominant cost AND that FSEvents+heartbeat fully
cover change detection. If .1 finds a real FSEvents-invisible change class for
an already-subscribed root, the drop is unsafe as-is: fall back to the
heartbeat-staleness tightening in .3 (a per-root `lastFastPathAt`-gated
re-snapshot on the heartbeat timer) rather than dropping the backstop outright
— the data_version poll never regains a snapshot arm either way.

## References

- `src/git-worker.ts:2036` `decideDataVersionWake` (pure, the primary edit site); poll loop `:2784-2804`; fan-out `:2800-2802`; `subscribeRoot` FSEvents subs `:2478-2548`; heartbeat backstop `:2810-2839`; constants `:351-383`.
- `test/git-worker.test.ts:2932-2981` — five `decideDataVersionWake` `toEqual` tests pinning `{reconcile,schedule,nextScheduleAtMs}`; rewrite in lockstep when the return shape collapses to membership-only.
- Prior art: fn-716 (BUILT the data_version snapshot arm + floor + ceiling; acceptance bar #4 "a real foreign dirty-tree change is still observed" must survive); fn-656 (earlier git-status fanout ratchet fix).
- fn-744 (reverse-dep): its acceptance preserves the data_version-poll/kick contract this epic modifies — the kick + membership-reconcile-on-advance behavior stays intact; only the snapshot fan-out changes. fn-747 (hard dep): provides the `scripts/` Bun.spawn + pure-aggregator + padded-table harness skeleton reused by .1's CPU sampler.
- fn-742 / fn-743 / fn-746: ordering-only deps (land-last sequencing); no technical coupling.
- CPU attribution nuance: spawned `git` is charged to git PIDs, not the daemon PID — the daemon's 144% is managing O(roots) concurrent `child_process.spawn` lifecycles. Sample both.

## Best practices

- **Drive per-root work from attributed events, never an unattributed `data_version` advance:** the SQLite `data_version` pragma signals "something in this DB changed" with no finer granularity — it must only drive O(1) membership checks, never O(roots) fan-out. [SQLite pragma docs]
- **Don't remove an FSEvents backstop without a drop-triggered rescan:** `MustScanSubDirs`/`UserDropped` is a documented, common-under-high-churn macOS condition; the existing `isDropError → sched.schedule()` per-root rescan + the 60s heartbeat are the retained nets. [Watchman recrawl-on-MustScanSubDirs; @parcel/watcher #190]
- **HEARTBEAT_MS is a should-never-fire backstop, not a latency floor** (README demotion note): "heartbeat cadence" must not reintroduce a 60s floor on normal snapshot freshness.
- **Co-located cheap win (out of scope here, flag as follow-up):** `git status --no-optional-locks` avoids `.git/index.lock` contention with the human's foreground git. [VS Code "git status every second creates index.lock"]

## Docs gaps

- **src/git-worker.ts** module docblock signal (3) (lines 14-26) + `decideDataVersionWake` JSDoc (2001-2029): rewrite to current state (snapshots FSEvents-driven; data_version drives membership reconcile only) — do NOT append "as of fn-N".
- **CLAUDE.md / AGENTS.md** (symlink, edit in place) "No kernel watchers on keeper's OWN DB": clarify data_version drives membership-reconcile wakes; the git-worker snapshot arm is FSEvents-triggered.
- **README.md** design-stance bullet (~261-266) + git-worker architecture prose (~1065-1100); ensure prose does not re-promote HEARTBEAT_MS to a latency floor.
