## Description

**Size:** S
**Files:** scripts/install.sh, plist/arthack.keeperd.logrotate.plist, src/daemon.ts, src/compaction.ts, test/compaction.test.ts, README.md

### Approach

Two small legs. (1) Rotation: fix the sidecar plist command so it resolves under launchd's /bin/sh — `$UID` is a bash/zsh builtin, not POSIX-sh; use `$(id -u)` — then add an idempotent install block to scripts/install.sh: `bootout || true; enable; bootstrap` is sufficient (RunAtLoad=false means nothing fires at install time; mirror only as much of the main plist's cmp+fingerprint gate at install.sh:59-107 as buys real idempotency). Verify post-install with `launchctl print`. Note the sidecar's weekly `kickstart -k` restarts keeperd — safe by design (autopilot resumes durable paused state; lanes re-derive) but update the README install step (~629-643) to state install.sh owns it.

(2) Observability: export a reclaimable-bytes helper from src/compaction.ts (freelistPageCount at :774 is module-private; multiply by PRAGMA page_size) and log it from the retention pass ONLY on 100MB step crossings (latch the last-logged step; re-log when the pool grows another step) — an unconditional per-pass log would grow the very file this epic bounds. The log line names the remedy: run offline `keeper reclaim`.

### Investigation targets

**Required** (read before coding):
- plist/arthack.keeperd.logrotate.plist — the ProgramArguments sh command to fix
- scripts/install.sh:59-107 — the main plist idempotency gate to selectively mirror
- src/compaction.ts:774-830 — freelistPageCount and the sentinel block
- src/daemon.ts:5568-5651 — where the step-latched log hangs

**Optional** (reference as needed):
- plist/arthack.keeperd.plist:92-93 — StandardErrorPath, why rotation must be external

### Risks

- install.sh runs on the human's live machine — a bad bootstrap loop could wedge the LaunchAgent domain; keep the block minimal and bail loudly on unexpected launchctl errors

### Test notes

The freelist helper + step-latch logic get fast-tier unit tests (pure math + injected pragma reads). install.sh changes are shell — verify by running install.sh twice (idempotent) and `launchctl print gui/$(id -u)/arthack.keeperd.logrotate` on the live machine as the evidence step; no automated test boots launchd.

## Acceptance

- [ ] Sidecar loads via install.sh idempotently; its command resolves under /bin/sh (no $UID)
- [ ] Freelist log fires only on 100MB step crossings and names the reclaim remedy
- [ ] README install step updated; full fast suite green

## Done summary
Fixed the logrotate sidecar plist to resolve $(id -u) under launchd /bin/sh and made install.sh load it idempotently; added reclaimableFreelistBytes + a step-latched reclaimable-space log that fires only on 100MB freelist crossings naming 'keeper reclaim'.
## Evidence
