# Research cache — `gpt-5.6-luna`

<!--
provenance:
  model_id: gpt-5.6-luna       # host-roster capability token, NOT an embedded subagents.yaml axis value
  resolves_to: openai-codex/gpt-5.6-luna  # Pi-hosted launch id. General GPT-5.6-family model, NOT a `-codex`-tuned variant
  upstream_snapshot: GA 2026-07-09; knowledge cutoff Feb 16, 2026  # dated vendor facts, not a keeper alias
  researched: 2026-07-10
  status: researched           # provenance state: this cache reflects a real capability-review pass against vendor sources
  method: vendor-doc review (OpenAI developer model docs + the GPT-5.6 Preview System Card PDF) — web-fetched 2026-07-10, no memory claims
  sources:
    - OpenAI developer docs, GPT-5.6 Luna model page (developers.openai.com/api/docs/models/gpt-5.6-luna) — "designed for cost-sensitive, high-volume workloads… roughly corresponds to the nano model tier used in earlier GPT-5 families." Reasoning ceiling "High"; 1.05M context; 128K max output; $1/$6 per MTok; Feb 16 2026 cutoff
    - OpenAI, GPT-5.6 Preview System Card (2026-07-09): Luna is "our fastest and most cost-efficient model"; data-destructive-action + prompt-injection + health tables span sol/terra/luna
    - GitHub Copilot changelog (2026-07-09): Luna is "a lightweight, cost-efficient variant for smaller, faster tasks and also the lowest-cost option in the family."
-->

This file is the raw research backing the distilled `models.gpt-5.6-luna` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.6-luna.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.6-luna` capability id is re-pointed to a newer model version, or
when out-of-band cell-review cohort evidence materially re-grades its routing fit.

## What `gpt-5.6-luna` is

`gpt-5.6-luna` is the **lightweight tier** of OpenAI's GPT-5.6 family — "our fastest and most
cost-efficient model," the low end of the Sol / Terra / Luna release. Per OpenAI's docs it "roughly
corresponds to the nano model tier used in earlier GPT-5 families." It carries the family's **lowest
reasoning ceiling** (vendor label "High," below Terra's "Higher" and Sol's "Highest") but shares the
rest of the platform shape — a **1.05M-token context window** (unusually large for the cheap tier),
128K max output, the full none→max reasoning-effort ladder, text+image input / text output, and the
standard tool surface (functions, web + file search, computer use). Pricing is $1/$6 per MTok — the
cheapest in the family; knowledge cutoff Feb 16, 2026; GA 2026-07-09. It is built for cost-sensitive,
high-volume workloads and small, fast tasks.

In keeper it is a **wrapped cell**: keeper does not serve it natively, so a Claude wrapper delegates
implementation to the model's serving provider (the `pi` harness in the host matrix) and re-owns the
keeper close-out (tests,
soft-reset of foreign commits, the single sanitized trailer commit). On the plan board it routes
per the binding `hand_tuned` GPT-first policy — GPT tiers take well-specified work whose quality
bar is correctness against a nameable acceptance, while Claude tiers keep judgment-heavy, taste-,
or intelligence-bound work — and out-of-band cell-review cohorts grade fit through the wrapped-cell
path, re-tuning this guidance as evidence accumulates. (The exact host-matrix alias wiring is a
launch-path detail owned outside this capability research.)

## Strengths (worker-relevant)

- **Fastest, cheapest 5.6 tier.** $1/$6 per MTok, built for high-volume and small, fast tasks — the
  family's natural home for tightly-scoped mechanical work where turnaround and cost dominate.
- **Full-size context for its class.** Same 1.05M-token window as its siblings — it holds a large
  input despite the nano-lineage cost, so a big-file read-then-edit isn't context-starved.
- **Punches above its price on breadth.** On the health evals Luna "retain[s] much of the performance
  of GPT-5.6 Sol despite [its] lower cost," and it holds reasonable prompt-injection robustness
  (connectors 0.999; search/function-calling 0.897).
- **Literal execution of an unambiguous spec.** Reliable at a fully-specified, single-surface
  acceptance that leaves no design choice.

## Weaknesses / failure modes (worker-relevant)

- **Lowest reasoning ceiling in the family.** Nano-lineage "High" tier — multi-file design,
  cross-module reasoning, and ambiguous acceptance under-resolve here rather than being worked
  through; it needs the choice pre-made.
- **Weakest complex-edit safety.** Data-destructive-actions eval: 0.73 avoidance / 0.32
  avoidance+correctness — the lowest of the three, and OpenAI explicitly flags that the smaller
  Terra/Luna models underperform the larger ones "on complex tasks while avoiding edit conflicts." So
  the overwrite/data-loss risk on gnarly multi-file edits is highest here.
- **Shares the family over-eager tendency.** The system card's agentic-coding misalignment findings
  (overeager completion, permissive instruction interpretation, occasional scope-exceeding or
  over-claimed results) ride the shared post-training lineage — keep it off unsupervised destructive
  scope.
- **Newest + non-claude, unproven here.** No cell-review cohort evidence on this board yet; over-reaches
  on anything past small, bounded work.

## When to pick

Route `gpt-5.6-luna` **only** to small, reversible, near-mechanical work
with a fully-specified acceptance and a named surface — single-file edits, straight test additions,
mechanical refactors with an explicit before/after shape. It is the closest 5.6-family analog to
`gpt-5.3-codex-spark`'s niche: fast, cheap, tightly-scoped. Its weaker overwrite-avoidance means keep
it off complex multi-file edits; prefer Terra when the edit is complex enough that edit-conflict
safety matters, and Sol/opus/sonnet whenever the task needs reasoning past one surface or carries
real contract-shaped blast radius. This is advisory selection posture only — the selector has no
per-model gating mechanism, so the posture lives in guidance prose, not a code path.
