## Overview

The plan island's `loadHostMatrix` and the launcher island's `loadMatrix`
parse the same `matrix.yaml` but disagree on one error path: a present-but-
unreadable file. The plan island silently falls back to claude-only defaults
(contradicting its own line-219 fail-loud contract); the launcher island
faults. This reconciles the plan island to fail-loud on a genuine read
failure of a present file, and pins the two hand-written parsers together
with a cross-island parity test so this class of drift is caught mechanically.

## Acceptance

- [ ] A present-but-unreadable `matrix.yaml` fails loud in the plan island (typed error), matching the launcher island and the stated contract; a genuinely absent / not-a-file path still returns null and falls back.
- [ ] A cross-island parity test feeds one fixture roster to both parsers and asserts the same accept/reject verdict, plus a test covering the present-but-unreadable path.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | subagents_config.ts:223-229 wraps readFileSync in the statSync try/catch and returns null, silently falling back on a present-but-unreadable matrix.yaml against the line-219 fail-loud contract and diverging from matrix.ts:116. |
| F2 | merged-into-F1 | .1 | F2 (duplicated parser across islands) folds into F1: its parity-test remedy is the regression guard for the drift F1 confirmed, landing in F1's reconciliation commit rather than a boundary-blocked parser merge. |
| F3 | merged-into-F1 | .1 | F3 (no test for the present-but-unreadable path) is the test half of F1's fix and lands in the same task as F1. |

## Out of scope

- Merging the two parsers into one shared module — blocked by the documented island boundary (the plan island's dep graph must not reach `src/agent`); the parity test is the sanctioned alternative.
