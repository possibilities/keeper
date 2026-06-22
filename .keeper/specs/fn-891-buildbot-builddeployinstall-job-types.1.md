## Description

**Size:** M
**Files:** system/buildbot/master.cfg

### Approach

Introduce explicit job typing WITHOUT changing any current behavior — the
foundation every later arthack task builds on. Extract the per-step
`ShellCommand` construction (master.cfg:234-263) into a shared
`_make_step(label, argv, workdir, env, halt=None)` that preserves the
dep-vs-check envelope: dep-install steps (matched by `_is_dep_install`,
:149-150) get `retry_argv` + `maxTime=DEP_STEP_MAX_TIME` + no-output
`timeout` + `haltOnFailure=True`; check steps get raw argv,
`flunkOnFailure=True`, no maxTime/timeout. The optional `halt` override lets
the deploy script step (today an explicit `haltOnFailure=True` on a
non-dep step, :323) route through the same helper without drift. Then add a
typed job model: extend each PROJECTS dict with optional `install`/`deploy`
sub-blocks, normalize to typed JobSpecs (`kind ∈ build|deploy|install`), and
build builders through a `JOB_FACTORIES` dispatch table. Apply the
builder-name suffix convention (`<name>` build, `<name>-install` install,
`<name>-deploy` deploy) and stamp `BuilderConfig(tags=["job:<kind>"])`.
Fold the existing mermaidctl-deploy block (:276-336) through the new helper
+ dispatch so it is no longer hand-special-cased — but its trigger/gating
stays exactly as-is in THIS task (the re-gate is task `.4`).

THIS TASK IS BEHAVIOR-PRESERVING: the 5 existing build builders (keeper,
arthack, vtkeep, agentusage, agentrender) and mermaidctl-deploy must
construct byte-identically (same names, steps, commands, envelope). No new
builders here.

### Investigation targets

**Required** (read before coding):
- system/buildbot/master.cfg:201-274 — the PROJECTS loop (poller/scheduler/builder derivation)
- system/buildbot/master.cfg:234-263 — the exact step_kwargs to extract into `_make_step`
- system/buildbot/master.cfg:136-150 — `DEP_INSTALL_ARGVS` + `_is_dep_install`
- system/buildbot/master.cfg:276-336 — mermaidctl-deploy block to fold through the helper (note the explicit halt at :323)
- system/buildbot/master.cfg:342-349 — ForceScheduler (must keep covering every builder)

### Risks

- The deploy script step's explicit `haltOnFailure=True` on a non-dep step is the one place the dep-vs-check default differs — the `halt` override must preserve it or deploy-step halt semantics drift.
- `checkconfig` is the only gate; it constructs but never runs schedulers/predicates, so behavior-preservation must be argued by diffing the constructed builder set, not just a green checkconfig.

### Test notes

Run `~/.local/share/uv/tools/buildbot/bin/buildbot checkconfig ~/.local/state/buildbot/master`. Compare the builder set (names, step labels, commands, halt/maxTime/timeout) before vs after to prove zero behavior change.

## Acceptance

- [ ] `_make_step` helper extracted; both PROJECTS builders and the deploy builder route through it (deploy's halt override preserved)
- [ ] typed JobSpec + `JOB_FACTORIES` dispatch in place; builder-name suffix + `tags=["job:<kind>"]` convention applied
- [ ] the 5 existing build builders + mermaidctl-deploy construct identically (names/steps/envelope unchanged)
- [ ] the suffix convention is documented as a comment next to PROJECTS
- [ ] `buildbot checkconfig` passes

## Done summary

## Evidence
