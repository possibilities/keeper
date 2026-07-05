# Research cache — `sonnet`

<!--
provenance:
  model_id: sonnet            # subagents.yaml models: axis value
  resolves_to: Claude Sonnet-tier alias
  researched: 2026-07-05
  method: model-capability review from available Anthropic guidance + in-repo worker routing needs
  sources:
    - Anthropic model guidance for Sonnet-tier models: balanced capability, lower cost/latency than Opus-tier, suitable for most coding tasks
    - keeper worker experience: plan tasks vary from mechanical edits to contract-sensitive autonomous work; model routing should protect the latter
-->

This file is the raw research backing the distilled `models.sonnet` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.sonnet.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `sonnet` alias is re-pointed to a newer model, or when the
`models:` axis in `subagents.yaml` changes.

## What `sonnet` is

`sonnet` is keeper's balanced Claude worker-model axis value. It is meant to be cheaper and faster
than `opus` while remaining capable enough for bounded implementation work, local refactors, and
straightforward bug fixes. In this selector, `sonnet` is a deliberate routing-down option: it should
win when the task has a clear path and low coordination risk, not merely because the task is short.

## Strengths (worker-relevant)

- **High throughput on bounded coding work.** Good fit for tasks with explicit acceptance criteria,
  known in-repo patterns, and a small or moderate file set.
- **Cost/latency efficiency.** A better default than Opus for mechanical edits, test additions,
  polish, and template-following work where deeper reasoning is unlikely to change the outcome.
- **Instruction following on scoped specs.** Performs well when the work is framed as concrete steps
  with observable acceptance and little ambiguity.
- **Adequate debugging for named causes.** Can handle ordinary bug fixes when the likely root cause
  or failing surface is already identified.

## Weaknesses / failure modes (worker-relevant)

- **Lower ceiling on ambiguous design.** More likely than Opus to miss a subtle abstraction boundary
  or choose a locally-correct fix that conflicts with a wider contract.
- **Less margin on cross-repo or schema work.** Avoid for migrations, wire formats, public APIs,
  event-sourcing invariants, and changes where a wrong call propagates beyond the touched files.
- **Weaker on gnarly debugging.** When the task needs hypothesis generation, flake triage, or
  security-style adversarial review, route to Opus instead.

## When to pick (against Opus)

Pick `sonnet` for routine implementation where the path is clear: single-file or small multi-file
edits, obvious tests, straightforward UI/text polish, mechanical refactors, or applying an existing
pattern. Keep `opus` for contract-touching work, new patterns, cross-module architecture, high-blast
radius changes, or any task where a wrong routing-down would likely fail the worker turn. When
uncertain, route up to `opus`.
