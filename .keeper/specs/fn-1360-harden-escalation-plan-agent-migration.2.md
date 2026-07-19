## Description

Add the two missing end-to-end tests for this epic's headline paths
(finding F1 and F5):

- F1: the `default_pin` fallback is never exercised because every fixture
  and example matrix carries explicit `agent_pins` for the four new
  agents. Add a test loading a host matrix with a new agent's pin omitted
  that asserts (a) the plain-rendered `.md` frontmatter carries the
  `default_pin` model/effort (renderAgents `?? defaultPins.get(stem)`),
  and (b) `planRoles` throws when the `default_pin` effort is absent from
  the host effort axis (the new `!matrix.efforts.includes(pin.effort)`
  throw). Touches plugins/prompt/test/ (render_plugin_templates.test.ts
  and/or the compile path over prompt_compiler.ts).
- F5: nothing confirms the confinement engages for the new plan:* agent
  types. grant-guard keys on bare agent_type via `escalationRoleFor` with
  no `plan:` prefix normalization, and no test drives a plan:-prefixed
  spawn. Add an integration assertion that a spawned escalation subagent's
  in-tree write is denied without a matching grant leaf and allowed with
  one, exercising the agent_type the harness actually delivers for a
  Task(subagent_type="plan:repairer") spawn.

Files: plugins/prompt/test/render_plugin_templates.test.ts, plugins/keeper/plugin/hooks/grant-guard.ts (test seam)

## Acceptance

- [ ] A test loads a host matrix omitting a new agent's pin and asserts the rendered frontmatter carries the default_pin model/effort
- [ ] A test asserts planRoles throws when the default_pin effort is not in the host effort axis
- [ ] An integration test proves a spawned escalation subagent's write is grant-gated (denied without a grant leaf, allowed with one) for the agent_type delivered by a plan:* Task spawn

## Done summary
Added end-to-end coverage for the default_pin fallback (render + compile paths, including the effort-axis throw) and for plan-qualified escalation grant confinement (denied without a grant leaf, allowed with one, for a plan:repairer Task spawn).
## Evidence
