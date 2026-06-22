## Description

**Size:** M
**Files:** system/buildbot/master.cfg

### Approach

Using task `.1`'s `JOB_FACTORIES`, add install builders, each chained to its
repo's GREEN build via a `Dependent` scheduler (`upstream=` that repo's
SingleBranchScheduler INSTANCE — not its name string; `builderNames=["<name>-install"]`).
Dependent green-gates for free and only enqueues a request — safe on the
serial worker. NEVER use a `Trigger(waitForFinish=True)` here: it deadlocks
`max_builds=1`. The Dependent HEAD/source-stamp caveat is benign — installs
run against the live working tree, so revision pinning is irrelevant.

Install builders:
- `keeper-install`: `bun install` (dep step) + `bun link`, workdir /Users/mike/code/keeper
- `agentrender-install`: `bun install` (dep) + `bun link`, workdir /Users/mike/code/agentrender
- `agentusage-install`: `bun install` (dep) + `uv sync` — DEPENDENCY REFRESH only; agentusage is a library with NO `bin`, so NO `bun link`. workdir /Users/mike/code/agentusage
- `dotfiles-install`: install-ONLY builder running `bootstrap.sh`, workdir /Users/mike/code/dotfiles. dotfiles has no CI build — drive it from a `Nightly(hour=3, minute=0, onlyIfChanged=False)` schedule (no GitPoller, no build builder, the schedule IS its trigger).

Add every new builder to the ForceScheduler list (:342-349) so each has a
manual path.

### Investigation targets

**Required** (read before coding):
- task `.1`'s `JOB_FACTORIES` + suffix/tags convention (build on it, don't re-special-case)
- system/buildbot/master.cfg:222-228 — the per-project SingleBranchScheduler instances to reference as Dependent `upstream`
- system/buildbot/master.cfg:342-349 — ForceScheduler list to extend

**Optional:**
- Buildbot 4.3 Dependent + Nightly scheduler docs (upstream-is-instance; onlyIfChanged)

### Risks

- `Dependent.upstream` must be the scheduler object, not its name — a string silently misbehaves.
- dotfiles `bootstrap.sh` must be safe to re-run daily — confirm idempotency (it's the install entrypoint, designed idempotent, but verify no destructive re-link).

### Test notes

checkconfig; force-build a `-install` builder and confirm it runs the right command in the right workdir. Confirm `keeper-install` ≠ `keeper` (two distinct builders).

## Acceptance

- [ ] keeper-install / agentrender-install / agentusage-install builders exist, each `Dependent` on its repo's green build
- [ ] agentusage-install runs `bun install` + `uv sync` only (no bun link)
- [ ] dotfiles-install runs bootstrap.sh on a daily Nightly (no build builder, no poller)
- [ ] all new builders added to ForceScheduler
- [ ] `buildbot checkconfig` passes

## Done summary

## Evidence
