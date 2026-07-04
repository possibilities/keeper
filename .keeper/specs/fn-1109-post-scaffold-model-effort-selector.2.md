## Description

**Size:** M
**Files:** plugins/plan/model-selector.yaml, plugins/plan/skills/model-guidance/SKILL.md, plugins/plan/skills/model-guidance/references/opus.md, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/test/consistency-model-selector.test.ts, plugins/plan/subagents.yaml

### Approach

Two coupled deliverables that land together because the skill OWNS the config's content.

**`plugins/plan/model-selector.yaml`** — the policy config, repo-committed and read off disk by the plan/defer orchestrators only (never a verb, never compile-embedded): `selector: {harness, model}` (the leg the selector runs as — harness is one of the agent-run harness tokens, model an opaque passthrough string, hand-tuned to the strongest available); `efforts:` one guidance block per configured effort (the bands migrating out of the plan skill's tier prose — concrete, behavioral, worker-facing selection advice); `models:` one guidance block per configured model (concrete behavioral guidance distilled from research — strengths, weaknesses, when-to-pick); a `research:` provenance map recording, per model, the references/ cache file and its content hash. Include short usage advice for the selector (how to weigh effort vs model, default-when-uncertain rule).

**`plugins/plan/skills/model-guidance/`** — a hand-authored static skill (no .tmpl, no managed-file sidecar; hack/prompt are the structural precedents) whose job is owning that config's content: for each model on the subagents.yaml `models:` axis, research current capability signal (web + local experience), cache it as a provenance-headed markdown (research date, sources, model id) at `references/<model>.md`, then distill into the config's guidance blocks and update the research hash map. Adding a model = one-line subagents.yaml edit + run this skill to backfill; the gate below fails until backfilled. Seed v1 in this task: author `references/opus.md` (modest research pass) and migrate the four effort bands from the plan skill prose into the config (this task authors the config CONTENT only; the plan-skill prose removal is task 3's edit — no shared files).

**Drift gate** — `plugins/plan/scripts/model-guidance-check.ts --check`, mirroring the vendor-corpus check shape (report-or-exit): (a) coverage both directions — every subagents.yaml axis value (efforts AND models, read from DISK via the loader's disk mode, not the compiled embed) has exactly one guidance block, and no block exists for a non-axis value; (b) hash parity — every research map entry's recorded hash matches the current references/ file, and every configured model has a research entry. Asserted in the fast suite via a consistency test following the generated-guard pattern. Add the one-line cross-reference to the subagents.yaml header comment so the axis source-of-truth stays singular, and note the gate command where the check registry expects it (task 3 owns the CLAUDE.md Running-Things row — do not edit CLAUDE.md here).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/subagents.yaml + plugins/plan/src/subagents_config.ts:106-134 — the axes, the disk-vs-embed dual loader (the gate must use the disk path), and the header comment to cross-reference
- scripts/vendor-corpus.ts — the --check/--sync report-or-exit drift-gate shape to mirror
- plugins/plan/test/consistency-generated-guard.test.ts:126-144 — the "artifact exactly covers config axes" test pattern (mind the WORKERS_RENDERED-style guard idiom for unrendered checkouts)
- plugins/plan/skills/plan/SKILL.md:379-384 — the effort bands whose CONTENT migrates into the config (read-only here; task 3 edits that file)
- docs/skill-authoring.md + plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/prompt/SKILL.md — static-skill structure precedents (frontmatter, references/ subfolder)

**Optional** (reference as needed):
- plugins/plan/skills/panel/references/panel.md — references/ progressive-disclosure precedent
- plugins/prompt/corpus/vendor.lock — the "lock is the review point" provenance-manifest idea the research hash map adapts

### Risks

- Research staleness: the gate enforces parity, not freshness — mitigation is the provenance header (date, sources) in each cache file plus the skill prose prescribing a re-run cadence trigger (model list change, model version bump)
- Guidance verbosity: distilled bands must stay short — the whole config rides inside every selector prompt; raw research stays in references/, never in the prompt

### Test notes

consistency-model-selector.test.ts (fast tier, pure disk reads): axis coverage both directions, hash parity, missing-research-entry failure, extra-block failure. Run the check script in-process (import its check function) rather than spawning.

## Acceptance

- [ ] A repo-committed model-selector config exists carrying the selector's own harness+model, a guidance block for every configured effort and model, selector usage advice, and a research-provenance map — readable off disk without any compile step
- [ ] A model-guidance skill documents and owns the research→cache→distill flow, with a provenance-headed research markdown committed for every configured model
- [ ] A --check drift gate fails on any axis-coverage mismatch (either direction) or research-cache hash mismatch, and the fast test suite asserts it
- [ ] The subagents.yaml header cross-references the guidance config, keeping the axis source-of-truth singular

## Done summary
Added model-selector.yaml (repo-committed selector policy: harness+model, per-effort/per-model guidance, research provenance map) plus the model-guidance skill that owns its research->cache->distill flow, a config<->axes coverage + hash-parity drift gate (model-guidance-check.ts) asserted in the fast suite, and a subagents.yaml header cross-reference keeping the axis source-of-truth singular.
## Evidence
