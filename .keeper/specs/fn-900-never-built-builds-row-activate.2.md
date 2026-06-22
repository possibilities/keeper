## Description

**Size:** S
**Files:** none (operational rollout — no code edits)

### Approach

OPERATOR-RUN, not for the autopilot: this reloads the keeper daemon, which
would disrupt a keeper-dispatched worker mid-run. The human / driving
session runs it AFTER task `.1` has landed and the keeper daemon has been
restarted to run the new code.

1. Gate + reload buildbot: `~/.local/share/uv/tools/buildbot/bin/buildbot
   checkconfig ~/.local/state/buildbot/master` then `buildbot reconfig
   ~/.local/state/buildbot/master` to register the fn-891 builders.
   NOTE: reconfig ACTIVATES the fn-891.3 schedulers (4x/day arthack-install
   with the self-bounce guard) and fn-891.4 (re-gated mermaidctl-deploy) —
   the human has accepted this.
2. Reload the keeper daemon (its LaunchAgent) so task `.1`'s code is live and
   the builds-worker re-enumerates immediately (otherwise it picks the new
   builders up on its next poll tick).
3. Force-build ONLY the cheap install builders via the web UI or `POST
   /api/v2/forceschedulers/force`: keeper-install, agentrender-install,
   agentusage-install, arthack-doctor, dotfiles-install. Do NOT force
   arthack-install (heavy full install.sh; let it fire on its natural
   Nightly).
4. Verify `keeper builds` shows every build/deploy/install/dotfiles job with
   its fn-891.5 type tag — never-built ones as `never built` rows (from task
   `.1`), force-built ones with real status.

### Investigation targets

**Required** (read before running):
- arthack/system/buildbot/master.cfg — the builder names to expect after reconfig (keeper-install, agentrender-install, agentusage-install, arthack-install, arthack-doctor, dotfiles-install, mermaidctl-deploy)
- the keeper daemon LaunchAgent label (how it's reloaded) and the buildbot ForceScheduler `/api/v2/forceschedulers/force` endpoint

### Risks

- reconfig activates the .3/.4 schedulers (accepted) — confirm the self-bounce guard from fn-891.3 holds (the master is not killed by a subsequent arthack-install).
- if a freshly-reconfigured builder transiently lands with empty `masterids`, the worker ghost-filters it — re-poll/re-check rather than assuming it failed.
- do NOT force arthack-install here.

## Acceptance

- [ ] checkconfig passes and `buildbot reconfig` registers the new builders (REST `/api/v2/builders` lists the `*-install` builders, `dotfiles-install`, `arthack-doctor`)
- [ ] keeper daemon reloaded; the new builders appear in `keeper builds` as `never built` rows
- [ ] the cheap install builders are force-built and show real status; arthack-install is left to its natural Nightly
- [ ] all three job types + dotfiles are visible on `keeper builds` with type tags; the buildbot master was not self-bounced

## Done summary

## Evidence
