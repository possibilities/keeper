## Description

**Size:** M — SUPERVISED (live CI)
**Files:** ~/code/arthack/scripts/install.sh (§6d build/promote, §4c codex), ~/code/arthack/system/buildbot/master.cfg, ~/.local/bin/planctl

### Approach

Drop the `planctl` binary build/promote from `install.sh` §6d (native `keeper plan` replaces it) and remove `~/.local/bin/planctl`. Remove the `planctl` entry from buildbot `master.cfg` PROJECTS (its GitPoller/scheduler/builder), `checkconfig`, reload the running master. Ensure the Codex `/hack` symlink resolves to `~/code/keeper/plugins/plan/skills/hack/SKILL.md` (install.sh §4c source is already correct — refresh the on-disk symlink). SUPERVISED — touches the running buildbot.

### Investigation targets
**Required**:
- install.sh §6d (`install_bun_cli`/build), §4c (codex symlink), §6d planctl_verify
- system/buildbot/master.cfg PROJECTS (the `planctl` entry ~line 85)
- scripts/lib/bun-cli.sh (the install_bun_cli example comment)

### Risks
- buildbot is live (pid running) — `checkconfig` must pass before reload, or CI wedges.
- Don't remove the binary until native `keeper plan` (epic 1) is confirmed working everywhere.

### Test notes
`buildbot checkconfig` green; reloaded master has no `planctl` builder; `keeper plan status` works with no `~/.local/bin/planctl`.

## Acceptance
- [ ] `planctl` binary build/promote dropped; `~/.local/bin/planctl` gone; `keeper plan` still works
- [ ] buildbot `planctl` builder removed; checkconfig green; master reloaded
- [ ] Codex `/hack` symlink → subtree; install.sh §4c source correct
## Done summary
Dropped install.sh 6d planctl Bun build/promote and removed ~/.local/bin/planctl (keeper plan is native); deleted dead lib/bun-cli.sh; removed the planctl builder from buildbot master.cfg (checkconfig green, master bounced/reloaded with 6 builders, no planctl); refreshed Codex /hack symlink to the plan-plugin subtree.
## Evidence
