## Overview

The mermaidctl production-deploy gate (_arthack_deploy_gate in arthack's
master.cfg) is the sole bar between a red build and a production deploy, yet
only its path predicate (is_mermaidctl_change) is unit-tested -- the green
check itself has no direct coverage. checkconfig (correctly, per the
flunkOnFailure/no-halt envelope) never executes the gate callable, so a future
regression that lets a red build deploy would ship silently. This follow-up
adds a single in-process test that pins the gate's green-check behavior.

## Acceptance

- [ ] A unit test constructs a fake build with a FAILURE step and asserts the
      gate returns False (red build does not deploy).
- [ ] A companion green-path assertion confirms an all-green build with a
      mermaidctl change returns True.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | master.cfg:470-477 gate is the sole red-build-vs-deploy bar with no direct test; remedy is a real test artifact. |
| F2 | merged-into-F1 | .1 | F2 (Test Gaps: gate green-check untested) is the same ask as F1 (Consider: gate has no unit test) -- one task. |
| F3 | culled | — | dotfiles-install hardcoded path matches the existing single-machine convention; no user impact. |
| F4 | culled | — | resolveJobType -doctor->install coupling is tested + documented; only a theoretical future mislabel. |
| F5 | culled | — | _build_scheduler dispatch is already validated end-to-end by checkconfig. |
| F6 | culled | — | Test Budget is an advisory ratio note the auditor judged proportionate; no action. |
| F7 | culled | — | Security Notes affirm the design is sound; nothing to act on. |

## Out of scope

- Tokenizing the dotfiles-install absolute path (F3 -- matches existing convention).
- Hardening resolveJobType against a future non-install *-doctor builder (F4 -- theoretical).
- A dedicated _build_scheduler dispatch-class test (F5 -- checkconfig already covers it).
