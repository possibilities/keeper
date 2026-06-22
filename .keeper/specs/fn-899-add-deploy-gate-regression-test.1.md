## Description

Add a direct unit test for _arthack_deploy_gate in arthack's
/Users/mike/code/arthack/system/buildbot/master.cfg (gate defined at
lines 470-477). Source findings: F1 (Consider) and the merged F2 (Test
Gaps item 1) -- both flag that the gate's green check has no direct test,
only the is_mermaidctl_change path predicate does
(system/tests/test_buildbot_deploypath.py). Evidence path read in audit:
master.cfg:470-477 plus the gate comment at lines 452-467.

The gate is the only thing stopping a red build (flunkOnFailure but
not haltOnFailure, so a red check step still reaches the trailing
Trigger) from deploying to production. Construct a fake build object
exposing executedSteps (with a step whose results is a FAILURE code) and
allFiles() (returning a mermaidctl path), and assert the gate returns
False; add the green-path companion (all-green steps + mermaidctl change ->
True). Keep it in-process alongside the existing deploypath test so it runs
under the same pytest tier.

## Acceptance

- [ ] Test asserts a build with a FAILURE-result step returns False from the gate.
- [ ] Test asserts an all-green build with a mermaidctl change returns True.
- [ ] Test runs in the existing system/tests pytest suite (no new harness).

## Done summary

## Evidence
