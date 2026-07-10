## Description

Finding F1 (with merged test-gap F4). `keeper agent presets list`,
`keeper agent providers resolve`, and `keeper agent providers check` still
parse `~/.config/keeper/matrix.yaml` with the v1 `loadMatrix`
(`src/agent/main.ts:411` wires `loadMatrixFn: loadMatrix`; the verbs call it
at `:1716`, `:1985`, `:2085`). v1 guards top-level keys against
`ALLOWED_MATRIX_KEYS` (`src/agent/matrix.ts:204`) and hard-rejects the v2
`subagent_templates`/`subagent_models` keys, so the moment an operator
installs the mandated v2 config (per `docs/install.md` step 4) all three
verbs exit non-zero calling the required config malformed.

Cut the three verbs to `loadMatrixV2` (deriving the triples/driver they need
from the v2 roster). Merged finding F4: no test exercises these verbs against
a v2-shaped `matrix.yaml` — the doctor-verb suites (test/agent-presets,
test/agent-dispatch, test/agent-matrix) still feed v1 `route:`/`native:`/
`subagents:` fixtures, which is what let the collision ship green. Add a case
that loads the committed v2 example (`docs/examples/matrix.example.yaml`)
through each verb.

Files: src/agent/main.ts, src/agent/matrix.ts, and the doctor-verb test
suites (test/agent-presets, test/agent-dispatch, test/agent-matrix).

## Acceptance

- [ ] All three verbs load the committed v2 example without a v1 unknown-key error
- [ ] Each verb has a test asserting success against the v2 example
- [ ] Core dispatch/launch behavior is unchanged

## Done summary
Cut keeper agent presets list/providers resolve/providers check over to loadMatrixV2, adding v2 derivations (resolveModelV2, providerCheckFindingsV2, enumerateTriplesV2, lintHostTriplesV2) that mirror v1's shapes while honoring v2 shadowing (single roster-first winner) and per-capability launch-only membership; added tests loading docs/examples/matrix.example.yaml through all three verbs.
## Evidence
