# Research cache — `gpt-5.6-terra`

<!--
provenance:
  model_id: gpt-5.6-terra      # host-roster capability token, NOT an embedded subagents.yaml axis value
  resolves_to: openai-codex/gpt-5.6-terra  # Pi-hosted launch id. General GPT-5.6-family model, NOT a `-codex`-tuned variant
  upstream_snapshot: GA 2026-07-09; knowledge cutoff Feb 16, 2026  # dated vendor facts, not a keeper alias
  researched: 2026-07-10
  status: researched           # provenance state: this cache reflects a real capability-review pass against vendor sources
  method: vendor-doc review (OpenAI developer model docs + the GPT-5.6 Preview System Card PDF) — web-fetched 2026-07-10, no memory claims
  sources:
    - OpenAI developer docs, GPT-5.6 Terra model page (developers.openai.com/api/docs/models/gpt-5.6-terra) — "designed for workloads that balance intelligence and cost… roughly corresponds to the mini model tier used in earlier GPT-5 families." Reasoning ceiling "Higher"; 1.05M context; 128K max output; $2.50/$15 per MTok; Feb 16 2026 cutoff
    - OpenAI, GPT-5.6 Preview System Card (2026-07-09): Terra is "a capable lower-cost option"; data-destructive-action + prompt-injection + health tables span sol/terra/luna
    - GitHub Copilot changelog (2026-07-09): Terra is "the balanced default. A strong all-round choice for everyday interactive and agentic coding."
    - OpenAI launch note (via community.openai.com preview thread, secondary): Terra positioned as "a balanced everyday model with GPT-5.5-competitive performance at 2x lower cost" — directional, not benchmarked here
-->

This file is the raw research backing the distilled `models.gpt-5.6-terra` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.6-terra.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.6-terra` capability id is re-pointed to a newer model version,
or when out-of-band cell-review cohort evidence materially re-grades its routing fit.

## What `gpt-5.6-terra` is

`gpt-5.6-terra` is the **balanced middle tier** of OpenAI's GPT-5.6 family — the "capable lower-cost
option" between the Sol flagship and the Luna lightweight tier. Per OpenAI's docs it "roughly
corresponds to the mini model tier used in earlier GPT-5 families." It shares the family's platform
shape — a **1.05M-token context window**, 128K max output, the full none→max reasoning-effort ladder,
text+image input / text output, and the standard tool surface (functions, web + file search,
computer use) — but sits one notch below Sol on reasoning ceiling (vendor label "Higher" vs Sol's
"Highest"). Pricing is $2.50/$15 per MTok, half of Sol's input cost; knowledge cutoff Feb 16, 2026;
GA 2026-07-09. OpenAI positions it as the balanced everyday default, and its launch materials frame
performance as GPT-5.5-competitive at roughly half the cost (a directional vendor claim, not a
benchmark reproduced here).

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

- **Best capability/cost ratio in the family.** OpenAI's balanced everyday tier for interactive and
  agentic coding at half Sol's input price; on the health evals Terra "retain[s] much of the
  performance of GPT-5.6 Sol despite [its] lower cost."
- **Full-size context and effort ladder.** Same 1.05M-token window and none→max reasoning ladder as
  the flagship — it is a "mini"-lineage tier only in cost/ceiling, not in context budget.
- **Strong tool/injection robustness.** Highest of the three variants on the search/function-calling
  prompt-injection eval (0.946; connectors 1.000) — a good fit for tool-driven agentic loops.
- **Literal execution of a bounded spec.** As a capable generalist it follows a well-specified,
  named-surface acceptance reliably without needing the top tier's ceiling.

## Weaknesses / failure modes (worker-relevant)

- **Below Sol on complex-edit safety.** Data-destructive-actions eval: 0.81 avoidance / 0.37
  avoidance+correctness, under Sol's 0.83/0.44 — OpenAI notes the larger models "outperform the
  smaller Terra and Luna models on complex tasks while avoiding edit conflicts," so gnarly multi-file
  edits carry more overwrite/conflict risk here than on Sol.
- **Mini-lineage reasoning ceiling.** One notch below Sol; deep multi-step design and cross-module
  reasoning under-resolve relative to the flagship rather than being reliably worked through.
- **Shares the family over-eager tendency.** The system card's agentic-coding misalignment findings
  (overeager task completion, permissive interpretation of instructions, occasional scope-exceeding
  or over-claimed results) are documented against the shared post-training lineage — supervise on
  long agentic runs, don't hand it unsupervised destructive scope.
- **Newest + non-claude, unproven here.** No cell-review cohort evidence on this board's task classes
  yet; its right-sized range here is unmeasured.

## When to pick

Route `gpt-5.6-terra` as the everyday GPT tier for ordinary well-specified implementation work —
bounded features, multi-step edits, and tool-driven loops with a named acceptance — the balanced
first reach when a task does not need Sol's ceiling. Prefer Terra over Sol when the work does not
need that ceiling, and over Luna when the edit is complex enough that overwrite avoidance and
reasoning depth matter. Contract-, schema-, or wire-shaped changes and hypothesis-free debugging
route up while cohort evidence is thin; judgment-heavy or under-specified work stays Claude-side per
`hand_tuned` (`opus` only on a nameable intelligence-bound reason). Supervise long agentic runs
(family over-eager tendency); cell-review cohorts grade fit out-of-band and re-tune this range.
