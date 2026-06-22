## Description

**Size:** M
**Files:** system/buildbot/master.cfg

### Approach

Re-gate the deploy — a DELIBERATE behavior change. Today it is decoupled
from CI (master.cfg:282-283): a mermaidctl path change deploys regardless of
whether arthack's build is green. New behavior: deploy fires only when the
arthack build is GREEN **and** its changes touched `apps/mermaidctl/**`.

- Convert the mermaidctl-deploy scheduler (the path-filtered SingleBranchScheduler at :292-300) to a `Triggerable`.
- Append a `Trigger` step to the END of arthack's build factory: `schedulerNames=[<the triggerable>]`, `waitForFinish=False` (NEVER True — deadlocks max_builds=1), `updateSourceStamp=True` (pin the built revision), `doStepIf=<gate>`.
- The gate callable returns True iff: (a) the build is GREEN — iterate `step.build.getSteps()` finished results, all in {SUCCESS, WARNINGS, SKIPPED} (arthack checks flunk-but-don't-halt, so a naive Trigger fires on red) AND (b) the build's changes touched apps/mermaidctl/** via the existing `deploypath.is_mermaidctl_change(files)`.
- Keep mermaidctl-deploy in the ForceScheduler — manual deploy must still work (a force build carries no changes, so the gate's file check must allow the manual path; verify the ForceScheduler path bypasses the trigger gate, since force builds the deploy builder directly).

KEYSTONE UNKNOWN — reading the build's changed files inside `doStepIf`.
`is_mermaidctl_change` takes a file list, but a `doStepIf` callable receives
the BuildStep, and buildbot does NOT auto-populate a `files` property.
Investigate FIRST: `step.build.allChanges()` (yields Change objects with
`.files`) — flatten to a file list and pass to `is_mermaidctl_change`.
FALLBACK if that API is unavailable/empty in 4.3.0: add an early factory
step that collects change files into a build property, then read that
property in `doStepIf`. Verify against Buildbot 4.3.0.

### Investigation targets

**Required** (read before coding):
- system/buildbot/master.cfg:276-336 — the current deploy builder + steps to keep
- system/buildbot/master.cfg:292-300 — the current path-filtered SingleBranchScheduler to replace with a Triggerable
- system/buildbot/deploypath.py:16-28 — `is_mermaidctl_change(files: list[str]) -> bool` (prefix `apps/mermaidctl/`; empty list → False)
- Buildbot 4.3 Trigger step (waitForFinish/updateSourceStamp/doStepIf), step-common doStepIf, results constants, and the build→changes API (`allChanges`)

### Risks

- KEYSTONE: if `doStepIf` can't see changed files, deploy either never fires or fires on every green arthack commit. The build-property fallback is the mitigation — budget for it.
- Deliberate semantic change: a red arthack build must NOT deploy; a green NON-mermaidctl arthack commit must NOT deploy. Both are explicit acceptance checks.
- The manual ForceScheduler deploy path must keep working (force build of the deploy builder directly, bypassing the trigger gate).

### Test notes

checkconfig. Reason through all three cases against the gate: green+mermaidctl→deploy; green+non-mermaidctl→no deploy; red→no deploy. Force-build mermaidctl-deploy and confirm the manual path still deploys.

## Acceptance

- [ ] mermaidctl-deploy is a Triggerable fired by a gated Trigger step at the end of arthack's build factory
- [ ] deploy fires only when the arthack build is GREEN and changes touched apps/mermaidctl/**
- [ ] `waitForFinish=False`; the manual ForceScheduler deploy path still works
- [ ] a red build and a green non-mermaidctl build do NOT deploy
- [ ] `buildbot checkconfig` passes

## Done summary

## Evidence
