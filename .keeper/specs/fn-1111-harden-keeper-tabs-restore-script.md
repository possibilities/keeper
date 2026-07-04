## Overview

Two targeted follow-ups surviving the audit of the keeper-tabs browser-grade
restore epic. First, close a command-injection gap in the generated revive
script: `renderSnapshotScript` shell-quotes every argv token and cwd but
interpolates agent-influenced `label`/`sessionName` values raw into `#` comment
lines, so a newline in a job title breaks out of the comment into an executed
line of a human-run script. Second, restore the bounded-scan property the prior
selection path guaranteed: the auto-pick now fully enriches every historical
generation before slicing to the newest few, an unbounded read that grows on
long-lived hosts.

## Acceptance

- [ ] No agent-influenced value can inject an executable line into the generated revive.sh / `keeper tabs dump` output; a newline-bearing label/session renders inside its `#` comment.
- [ ] `keeper tabs restore` / `list` decode snapshots only for a bounded set of generations, not the entire retained history.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Commit-set/trailer provenance note, not a code defect; tip is green (107/107) and e72a9895 is a confirmed ancestor, so finalize carries the schema-pin fix. |
| F2 | kept | .1 | Confirmed src/tabs-core.ts:332,354 — label/sessionName embedded raw into # lines of an executed script; a newline in an agent-set title injects a live command. |
| F3 | culled | — | buildTabsRestoreArgv uses bare 'keeper' argv[0]; auditor-optional PATH robustness with a narrow window (setup-tmux is already keeper-launched) — low impact. |
| F4 | merged-into-F2 | .1 | The newline-neutralization test proves F2's fix; folds into F2's task rather than standing as its own cluster. |
| F5 | culled | — | Task 2 resume-by-UUID coverage lives outside the pinned commit set — an audit-coverage gap tied to F1, no code defect shown. |
| F6 | merged-into-F2 | .1 | The Security Notes injection path is the same root cause as F2 (raw comment-line interpolation in renderSnapshotScript); folds into F2's task. |
| F7 | kept | .2 | Confirmed src/restore-set.ts loadEnrichedGenerations enriches every generation before slicing to RECENT_GENERATION_BOUND=5 — a bounded(256)->unbounded regression on the one-shot CLI read. |

## Out of scope

- Re-auditing task 2's resume-by-UUID diff (F1/F5): the epic branch tip is green and the code is unmodified here; that is an audit-coverage note for the closer, not a code change.
- PATH-independent resolution of the setup-tmux restore spawn (F3): left as-is; a later hardening pass may align it with the revive script's `process.execPath` resolution.
