## Overview

The v2 host-matrix cutover landed core dispatch and worker launch on the new
schema, but three operator diagnostic verbs still parse the mandated config
with the v1 loader and reject it, and several shipped claims/comments still
describe the retired embedded-matrix world. This follow-up finishes the cutover
on the operator-facing surfaces: fix the verbs (with the v2 test coverage whose
absence let the regression ship), and align the stale claims to the shipped
reality.

## Acceptance

- [ ] `keeper agent presets list`, `providers resolve`, and `providers check` load the mandated v2 `matrix.yaml` without a v1 unknown-key error
- [ ] A test loads the committed v2 example through each of the three verbs
- [ ] Every shipped claim/comment about shadow logging and the embedded matrix matches actual behavior

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Three operator verbs (main.ts:1716/1985/2085) parse via v1 loadMatrix (matrix.ts:204 ALLOWED_MATRIX_KEYS), which rejects the mandated v2 subagent_templates key. |
| F4 | merged-into-F1 | .1 | F4 (no v2-shaped verb fixture) is F1's test-coverage side — the missing v2 fixture let F1 ship green, so it folds into F1's task. |
| F2 | kept | .2 | .shadowed is computed (matrix.ts:911 / host_matrix.ts:374) but read only by tests; CONTEXT.md:37 and install.md:78 falsely claim it is logged/visible. |
| F3 | kept | .2 | models.ts:165 comment names the deleted embeddedWorkerAgentFor and misdescribes the now-required-matrix architecture. |

## Out of scope

- Any change to the v2 schema, core dispatch, or worker-launch paths (all shipped correct on v2)
- The launcher-enumeration mechanics beyond what the three verbs need to read v2
