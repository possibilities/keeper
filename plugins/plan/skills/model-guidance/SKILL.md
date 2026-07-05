---
name: model-guidance
description: Author and refresh the selector policy config (plugins/plan/model-selector.yaml) — research each configured worker model, cache the raw signal under references/, distill it into the config's guidance blocks, and re-hash. Use when a model or effort is added to subagents.yaml, when a model alias is re-pointed to a newer version, or when the model-guidance drift gate fails.
argument-hint: "[model to research, or blank to refresh all]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(shasum:*), Bash(bun plugins/plan/scripts/model-guidance-check.ts:*), WebSearch, WebFetch
---

# Model guidance

Own the content of `plugins/plan/model-selector.yaml` — the post-scaffold selector's policy
config. The config rides inside every selector brief, so it must stay short, concrete, and current;
this skill is how it gets authored and kept honest. The `selection-brief` verb and the orchestrators only
*read* the config — nothing regenerates it automatically. That is deliberate: model guidance is
researched judgment, and a human owns when it is refreshed.

The unit of work is one **axis value**. The `efforts:` and `models:` axes live in
`plugins/plan/subagents.yaml` (the single source of truth); this config must carry exactly one
guidance block per configured value and no block for a non-axis value. The drift gate enforces both
directions plus research-cache hash parity — keep it green.

## When to invoke

- A model or effort was added to `subagents.yaml` — backfill its guidance block (and, for a model,
  its research cache) here. The gate fails until you do.
- A model alias was re-pointed to a newer version — re-research it and re-distill.
- The drift gate (`bun plugins/plan/scripts/model-guidance-check.ts --check`) failed — reconcile
  the reported direction (missing block, extra block, missing research entry, or hash mismatch).

## The research → cache → distill flow

For each model on the `subagents.yaml` `models:` axis:

1. **Research** the current capability signal — web (the model's own capability/behavior docs) plus
   in-repo worker experience. Focus on what a worker cares about: strengths, failure modes, and
   when to pick this tier over another.
2. **Cache** the raw research as a provenance-headed markdown at `references/<model>.md`. The header
   records the research date, the model id it resolves to, the method, and the sources. This file is
   the review point — depth and citations live here, never in the config.
3. **Distill** into `model-selector.yaml`:
   - `models.<model>` — a short behavioral block (strengths, weaknesses, when-to-pick). Prompt-sized;
     raw research stays in `references/`.
   - `efforts.<effort>` — for each configured effort, concrete worker-facing advice on when to route
     a task to that band (difficulty and blast radius, not line count).
4. **Re-hash.** Recompute the reference file's sha256 and update `research.<model>.sha256`:
   ```bash
   shasum -a 256 plugins/plan/skills/model-guidance/references/<model>.md
   ```
   Then set `research.<model>.reference` to the path relative to the plan plugin root
   (`skills/model-guidance/references/<model>.md`).

## Verify

Run the drift gate and confirm it passes:

```bash
bun plugins/plan/scripts/model-guidance-check.ts --check
```

It asserts config↔axes coverage (both directions, for efforts and models) and config↔research-cache
hash parity (every configured model has a research entry whose recorded hash matches the file on
disk). The fast test suite (`plugins/plan/test/consistency-model-selector.test.ts`) asserts the same
check in-process, so a red gate is a red suite.

## Cadence

The gate enforces hash *parity*, not *freshness* — a stale-but-consistent cache passes. Re-run the
research when the trigger fires: the `models:` axis changes, or a model alias is re-pointed to a
newer version. The provenance header in each `references/<model>.md` records when it was last done.

## Keep the blocks short

Every efforts:/models: block is loaded into the selector brief on every run. Distilled bands stay
a few sentences; if you find yourself pasting research prose, it belongs in `references/`, not the
config. Density over volume: each clause should change how the selector routes a task.
