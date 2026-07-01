## Description

**Size:** M
**Files:** plugins/prompt/src/render_plugin_templates.ts, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/agents/worker-*.md (regenerate + delete old), plugins/prompt/test/oracle/fixtures/render-plugin-templates.json (regenerate via oracle/capture.ts), plugins/plan/src/models.ts, plugins/plan/src/verbs/{claim.ts,worker_resume.ts,resolve_task.ts}, plugins/plan/hooks/hooks.json, plugins/plan/test/*, plugins/plan/README.md, plugins/plan/CLAUDE.md

### Approach

Add an **agents-only, additive** 2-D matrix branch to `renderAgents` gated on the template being listed
in `subagents.yaml`'s `subagents:`; keep the existing 1-D `variants:` path byte-identical for every other
template (the oracle fixture pins it). Sort both axes before the cartesian product for stable ordering,
bind `current_model` + `current_effort`, output `worker-<model>-<effort>.md` + sidecar. Update
`worker.md.tmpl`: drop `variants:`, set `name: worker-{{ current_model }}-{{ current_effort }}`,
`model: {{ current_model }}`, `effort: "{{ current_effort }}"`. Regenerate the agent files, **explicitly
delete** the four old `agents/worker-{medium,high,xhigh,max}.md` + `.managed-file-dont-edit` sidecars
(agents have no orphan-prune), and regenerate the render-parity oracle fixture. In `models.ts`, compose
`plan:worker-<model>-<effort>` where model is the sole `models:` entry for now (still one axis of real
variation); update the claim/resume/resolve composed-name string accordingly. Collapse the `SubagentStop`
matcher to the `plan:worker-` prefix. Update naming prose in README (:155), plan CLAUDE.md (:32, drop
"four worker agents"), and the work skill render-note (:60).

### Investigation targets

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:112 (`sourceVariants`), :488-571 (`renderAgents`), :573-619 (commands-only orphan-prune — why deletion is manual)
- plugins/plan/template/agents/worker.md.tmpl:1-9 — frontmatter to rebind
- plugins/prompt/test/oracle/fixtures/render-plugin-templates.json + plugins/prompt/test/oracle/capture.ts — regenerate mechanism, and parity.test.ts consumer
- plugins/plan/hooks/hooks.json:40 — the exact-name matcher → prefix; confirm the harness treats it as a prefix/regex
- plugins/plan/src/verbs/claim.ts:357, worker_resume.ts:173, resolve_task.ts:134 — the composed-name emit sites

**Optional** (reference as needed):
- plugins/plan/test/consistency-generated-guard.test.ts:99-105 — the exact-name assertion to rewrite for the prefix

### Risks

- Byte-parity: do NOT refactor the shared `variants:` fan-out or the sidecar/sha serialization; add the matrix as a new branch only, or unrelated oracle fixtures break.
- Stale files: the four old `worker-<tier>.md` will not auto-prune — delete them and their sidecars explicitly, else the prefix matcher still resolves them.
- Deploy skew: landing generation + resolver name-composition + matcher together in this task keeps the binary and the on-disk agent set from momentarily disagreeing.

### Test notes

Rewrite `consistency-generated-guard.test.ts` for the prefix; update the name literals in saga-claim,
verbs-worker, saga-validate-resolve, saga-worker-resume, src-brief-claim, subagent-stop-guard,
consistency-skills. Regenerate the oracle fixture. Add a both-directions assertion: on-disk agent set ==
expected render of `subagents.yaml` (a removed cell must fail if the stale file remains).

## Acceptance

- [ ] Generated agents are `plan:worker-opus-<effort>.md`; the four old `worker-<tier>.md` + sidecars are gone.
- [ ] The 1-D `variants:` render path is byte-identical; the oracle fixture is regenerated and parity passes.
- [ ] `/plan:work` spawns `plan:worker-opus-<effort>`; the `SubagentStop` matcher is the `plan:worker-` prefix.
- [ ] Both-directions consistency check passes (no stale or missing cell).
- [ ] Naming prose in README / plan CLAUDE.md / work SKILL render-note reflects the matrix.

## Done summary

## Evidence
