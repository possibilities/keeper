## Overview

Four verified small defects left over from the review, swept in one bounded epic — explicitly not a general cleanup mandate. Sequenced after the verdict-core epic because the harness fail-loud touches the same launch-config region that epic restructures.

## Quick commands

- `grep -c export src/pair/panel.ts` — returns a count once the NUL byte is gone (BSD grep currently skips the file as binary)
- `keeper agent run claude "hi" --preset <underspecified>` — must fail as clean bad_args, not a doomed detached pane

## Acceptance

- [ ] src/pair/panel.ts reads as text to file/grep/git grep; memo-key behavior unchanged
- [ ] Fresh-launch readiness resolution shared between the agent-run and launcher gates, each keeping its own emission contract; pi's second axis (thinking, not effort) handled correctly
- [ ] A non-claude preset.harness reaching the worker launch path warns loudly (once per distinct preset) and continues on claude — never throws in the reconcile cycle
- [ ] Dead surfaces (hasMergeInProgress export, promote.sh second drift guard) removed or repointed only after verifying redundancy

## Early proof point

Task that proves the approach: `.1` (mechanical fixes land clean with the suite green). If it fails: the items are independent — land what is verified and drop what is not.

## References

- src/agent/config.ts — the preset/harness single source the gate helper builds on
- The reconcile never-crash contract around resolveWorkerLaunchConfig (autopilot-worker.ts launch-config region): swallow-to-constants documented; fail-loud here means warn-and-continue
