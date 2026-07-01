## Description

**Size:** M
**Files:** src/pair/panel.ts, test/pair-panel.test.ts, test/agent-panel-cli.test.ts

### Approach

Make `panelStart` idempotent-by-slug. Before touching the dir, acquire the per-slug
advisory lock `FileLock.tryAcquire(<dir>/.lock)` (src/usage-flock.ts, flock/CLOEXEC so
detached legs never inherit it); on contention fail-fast exit 2 with a slug-scoped
message (never block — a blocking acquire would wedge the caller's single Bash call).
Then the identity guard: compare the incoming prompt to the stored `prompt.md`
(byte-exact) AND the freshly-resolved member set to the manifest's members; either
mismatch → exit 2 (a colliding slug never silently merges). If no manifest exists →
fresh start (task .1 path). If it exists → RECONCILE per leg via a shared leg-state
read factored from `evaluateLeg` (:487): (1) a terminal result file present (ANY
outcome — completed OR failed) → REUSE, do not relaunch (resume is not retry); (2)
else if the manifest's `boot_epoch_ms` differs from the current beyond a GENEROUS
(minutes) tolerance → machine rebooted → the leg is dead → RELAUNCH; (3) else same-boot
→ `process.kill(pid,0)` (EPERM=alive, only ESRCH=dead; treat a zombie as dead) + the
launched_at-based grace → alive⇒leave, dead⇒RELAUNCH. Relaunch writes to a
per-generation result PATH (`<preset>.g<N>.yaml`) and repoints the manifest entry —
dedup by path-uniqueness inside panel.ts; do NOT change writeEnvelopeAtomic
(src/agent/main.ts:880) and do NOT SIGTERM a presumed-dead leg (the O_EXCL-free shared
writer + unique paths make the live winner authoritative). Re-stamp `boot_epoch_ms` to
the current boot whenever any leg is relaunched; rewrite the manifest atomically each
reconcile so lock-free readers (wait/status) never see a torn file. Route `--dir`
through this identical machinery (lock + reconcile + boot-epoch + identity).

### Investigation targets

**Required** (read before coding):
- src/usage-flock.ts:169+ — FileLock acquire/tryAcquire/release; LOCK_EX/LOCK_NB, FD_CLOEXEC-before-flock (the reason a hand-rolled lock leaks into legs)
- src/pair/panel.ts:487-533 — evaluateLeg (result→pid→running classifier) to factor into a shared reconcile read; :472 readPid, :805 pidAlive, :514 grace
- src/pair/panel.ts:613-728 — panelStart: dir resolution, prompt.md write (:681), member resolution + leg-launch loop (:698-716), manifest write (:718)
- src/agent/main.ts:880 — writeEnvelopeAtomic renames-and-overwrites (NOT O_EXCL) — the reason dedup rides per-generation paths, not a writer change
- src/pair/panel.ts:360-408 — buildPanelLegArgv + the `--name panel::<slug>::<preset>` leg name (stays stable; generation rides the result path, not the name)

### Risks

- Concurrency: the lock is held only during reconcile; a still-running detached run is lock-free (task .3 prune must account for this) — the lock's job is to serialize two DRIVERS, not mark liveness.
- Same-boot pid recycle with no result: bounded by grace + the wait BACKSTOP (accepted residual — no cross-platform start-time check).
- Reboot with completed results: completed result files are boot-independent and MUST still be reused on a boot mismatch; only non-terminal legs relaunch.
- Member-set reconcile: keying on member.name against a changed member set would orphan/add legs — the identity guard refuses this up front.

### Test notes

- Reconcile matrix via injected deps (no real processes): seed <preset>.g1.yaml result files + .pidfile + a manifest, then re-run start and assert reuse (completed AND failed), leave-running (pidAlive true), relaunch (pidfile dead / boot_epoch mismatch). Assert lock contention → exit 2, prompt-mismatch → exit 2, member-set-mismatch → exit 2, and a relaunch repoints to <preset>.g2.yaml. Drive boot-epoch via the deps.bootEpochMs seam.

## Acceptance

- [ ] Re-issuing `start --slug X` reconciles per leg: terminal (completed OR failed) reused, running left, no-result relaunched to a new-generation path
- [ ] boot_epoch mismatch relaunches every non-terminal leg (completed still reused); same-boot uses pidfile + launched_at grace
- [ ] Per-slug FileLock serializes drivers (fail-fast exit 2 on contention); prompt-or-member-set mismatch exits 2
- [ ] writeEnvelopeAtomic (main.ts) untouched; no SIGTERM of presumed-dead legs; panel.ts still dep-free
- [ ] Reconcile matrix + lock/identity tests pass via injected deps; suite green

## Done summary
panelStart is now idempotent-by-slug: under a per-slug FileLock it reconciles each leg (reuse terminal, leave running, relaunch no-result/rebooted to a new-generation result path), re-stamping boot-epoch + bumping generation on relaunch, with a prompt/member-set identity guard refusing colliding-slug merges (exit 2).
## Evidence
