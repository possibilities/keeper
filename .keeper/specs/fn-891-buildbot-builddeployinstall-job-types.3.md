## Description

**Size:** M
**Files:** system/buildbot/master.cfg, scripts/install.sh (and/or the processctl start-processes path)

### Approach

Add two builders and schedule them 4×/day, and make the scheduled install
safe to run from inside buildbot.

- `arthack-install`: runs `scripts/preinstall.sh` then `scripts/install.sh`, workdir /Users/mike/code/arthack.
- `arthack-doctor`: runs `scripts/doctor.sh` (read-only health check), workdir /Users/mike/code/arthack. KEEP IT SEPARATE from arthack-install so a failing doctor is its own red row, not masked by a green install.
- Both on `Nightly(hour=[0, 6, 12, 18], minute=0, onlyIfChanged=False)` (4×/day, time-based so they surface in `keeper builds`). Add both to ForceScheduler.

CRITICAL self-bounce mitigation: `scripts/install.sh:736` runs
`processctl start-processes`, which symlinks + `launchctl load`s the
launchagents — including `arthack.buildbot.master.plist` (RunAtLoad=true,
KeepAlive=true). When launchagents have CHANGED, that reload kills and
restarts the very buildbot master running this build, failing the build
with a worker disconnect. The fingerprint gate (install.sh:733-738) skips
the bounce when launchagents are unchanged (the common case), but a
launchagents change WILL self-kill. Mitigate: when install.sh runs under
buildbot (detect via an env var the builder step sets, e.g.
`KEEPER_BUILDBOT_INSTALL=1`, or an existing buildbot env marker), SKIP
reloading buildbot's OWN launchagent (still reload the others), or defer the
master reload. `checkconfig` (install.sh:722) is validation-only and safe.

### Investigation targets

**Required** (read before coding):
- scripts/install.sh:664-740 — the buildbot section: checkconfig (722), processctl start-processes (736), the fingerprint gate (733-738)
- the processctl `start-processes` implementation — how it symlinks + `launchctl load`s agents; where to skip one agent
- system/launchagents/.../arthack.buildbot.master.plist — RunAtLoad / KeepAlive (why a reload self-kills)
- scripts/preinstall.sh:15-18 — the 24h recency gate (so a 4×/day run self-skips, near-no-op)
- scripts/doctor.sh — confirm read-only, exit 0/1, no side effects

**Optional:**
- Buildbot 4.3 Nightly scheduler docs (hour list, onlyIfChanged)

### Risks

- KEYSTONE: get the self-bounce guard wrong and the 4×/day arthack-install self-kills the master and reports false failures. The fix must skip ONLY buildbot's own launchagent reload, not all of processctl.
- Serial worker: a 4×/day full install queues behind CI on `max_builds=1`. Off-hours scheduling + preinstall's 24h gate keep it cheap. Do NOT raise max_builds or add a second worker (a follow-up if contention bites).
- The env-detection seam must not change install.sh behavior when run normally (by a human) — only when run under buildbot.

### Test notes

Run install.sh with the buildbot env flag set and confirm it does NOT reload `arthack.buildbot.master`; run it without the flag and confirm normal behavior. checkconfig. Confirm preinstall self-skips within 24h.

## Acceptance

- [ ] arthack-install (preinstall+install) and arthack-doctor builders exist on a 4×/day Nightly, both in ForceScheduler
- [ ] when run under buildbot, install.sh does NOT bounce/kill the buildbot master's own launchagent (other agents still reload)
- [ ] doctor is a separate builder (its failure is a distinct red row)
- [ ] normal (non-buildbot) install.sh behavior is unchanged
- [ ] `buildbot checkconfig` passes

## Done summary

## Evidence
