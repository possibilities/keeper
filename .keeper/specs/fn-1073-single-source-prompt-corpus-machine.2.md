## Description

**Size:** M
**Files:** plugins/prompt/src/render_plugin_templates.ts, plugins/prompt/src/check_generated.ts, scripts/promote.sh, scripts/install.sh, test/consistency-skills.test.ts

### Approach

Teach discoverPluginDirs (render_plugin_templates.ts:236-276) to scan `plugins/*` so a
repo-root `--project-root` discovers keeper's plan plugin, making sidecar `source_template`
repo-root-relative — which fixes check_generated's regenerate hint for free (check_generated.ts:218
walks to .git; :226-228 joins the stored path onto it). Verify check_generated end-to-end after
the discovery change and adjust its resolution if any sidecar semantics remain plugin-relative.
Fix promote.sh:67 (today it renders zero plugins). Add a render step to scripts/install.sh and
the CI path so a fresh clone regenerates workers/, skills/work/, agents/practice-scout.md before
tests. Copy the existing skipIf gate (consistency-generated-guard.test.ts:33-37, WORKERS_RENDERED
+ test.skipIf at :127,:207) into the un-gated generated-work-plugins block in
consistency-skills.test.ts (~:388) — do not invent a new gate. Constraint from gap analysis:
the discovery change flips every sidecar's frozen bytes — sidecars are gitignored so regeneration
is local, but the committed discovery fix and any committed render/lint changes must land in one
commit so the drift gate never reports false drift.

### Investigation targets

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:236-276 — the three scan branches (claude/*, apps/*, root-manifest)
- plugins/prompt/src/check_generated.ts:218,226-228 — root walk + join
- scripts/promote.sh:67 — the no-op invocation
- test/consistency-generated-guard.test.ts:33-37,127,207 — the skipIf pattern to copy

**Optional** (reference as needed):
- plugins/plan/.gitignore:16-38 — what is gitignored (rendered outputs + sidecars)
- plugins/prompt/src/render_plugin_templates.ts:28-36,147-153 — byte-frozen sidecar serialization

### Risks

- Existing sidecars on developer machines were rendered with plugin-relative source_template; first re-render after this change rewrites them — harmless (gitignored) but the regenerate-hint text must match the new semantics everywhere.
- CI render must not require arthack: the worker templates live in keeper, so the render step must succeed on a keeper-only checkout.

### Test notes

Fresh-clone simulation is the acceptance proof: remove rendered outputs, run install/CI render,
run `bun test` — consistency suites pass, no hard-fail on missing renders. Keep the fresh-clone
check in CI/integration, never the pure unit tier.

## Acceptance

- [ ] promote.sh render step reports the plan plugin rendered (>0)
- [ ] check-generated regenerate hints name existing paths and a working command
- [ ] Fresh clone: install/CI render produces workers/ and skills/work/, consistency-skills passes (skipIf-gated when un-rendered)
- [ ] All landed in commits that keep the drift gate green at every point

## Done summary
discoverPluginDirs scans plugins/* and resolveAgentOutput resolves render_to against the plugin dir, so a keeper repo-root render discovers the plan plugin, keeps worker cells at plugins/plan/workers/, and writes repo-root-relative sidecars that check_generated resolves to existing paths. promote.sh reports >0 cells rendered, install.sh renders generated files on a fresh clone, and consistency-skills gates its per-cell block on WORKERS_RENDERED.
## Evidence
