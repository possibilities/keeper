# Research cache — `gpt-5.6-sol`

<!--
provenance:
  model_id: gpt-5.6-sol        # host-roster capability model (matrix.yaml alias target), NOT an embedded subagents.yaml axis value
  resolves_to: gpt-5.6-sol     # bare capability id served through the codex harness; `gpt-5.6` is the vendor alias that routes to Sol. General GPT-5.6-family model, NOT a `-codex`-tuned variant
  upstream_snapshot: GA 2026-07-09; knowledge cutoff Feb 16, 2026  # dated vendor facts, not a keeper alias
  researched: 2026-07-10
  status: researched           # provenance state: this cache reflects a real capability-review pass against vendor sources
  method: vendor-doc review (OpenAI developer model docs + the GPT-5.6 Preview System Card PDF) — web-fetched 2026-07-10, no memory claims
  sources:
    - OpenAI developer docs, GPT-5.6 Sol model page (developers.openai.com/api/docs/models/gpt-5.6-sol) — "frontier model in the GPT-5.6 family… roughly corresponds to the unsuffixed model tier used in earlier GPT-5 families. The `gpt-5.6` alias routes requests to GPT-5.6 Sol." Reasoning ceiling "Highest"; 1.05M context; 128K max output; $5/$30 per MTok; Feb 16 2026 cutoff
    - OpenAI, GPT-5.6 Preview System Card (2026-07-09): Sol is "our new flagship model"; agentic-coding misalignment simulation run against Sol; data-destructive-action + prompt-injection tables
    - GitHub Copilot changelog (2026-07-09): Sol has "the highest reasoning ceiling in the family. Best for complex reasoning over large codebases and demanding, long-running agentic work."
-->

This file is the raw research backing the distilled `models.gpt-5.6-sol` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.6-sol.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.6-sol` capability id (or its `gpt-5.6` alias) is re-pointed to a
newer model version, or when out-of-band cell-review cohort evidence materially re-grades its
routing fit.

## What `gpt-5.6-sol` is

`gpt-5.6-sol` is the **frontier tier** of OpenAI's GPT-5.6 family — the flagship of a three-model
release (Sol / Terra / Luna) that fans one generation across size/cost tiers. Per OpenAI's own docs
it "roughly corresponds to the unsuffixed model tier used in earlier GPT-5 families," and the bare
`gpt-5.6` alias routes to it. It carries the family's **highest reasoning ceiling** (vendor label
"Highest"), a **1.05M-token context window**, 128K max output tokens, a full none→low→medium→high→
xhigh→max reasoning-effort ladder, text+image input / text output, and the standard tool surface
(functions, web + file search, computer use). Knowledge cutoff is Feb 16, 2026; it reached GA on
2026-07-09. Input pricing ($5/MTok) matches the prior GPT-5.5 flagship, positioning Sol as a newer,
stronger generalist at the same top-tier price point.

In keeper it is a **wrapped cell**: keeper does not serve it natively, so a claude wrapper delegates
implementation to the model's serving provider (the `codex` harness in the host matrix — the same
harness OpenAI's Codex product runs these models through) and re-owns the keeper close-out (tests,
soft-reset of foreign commits, the single sanitized trailer commit). On the plan board it routes
per the binding `hand_tuned` GPT-first policy — GPT tiers take well-specified work whose quality
bar is correctness against a nameable acceptance, while Claude tiers keep judgment-heavy, taste-,
or intelligence-bound work — and out-of-band cell-review cohorts grade fit through the wrapped-cell
path, re-tuning this guidance as evidence accumulates. (The exact host-matrix alias wiring — whether
the harness takes the bare id or a provider-qualified target — is a launch-path detail owned outside
this capability research.)

## Strengths (worker-relevant)

- **Highest reasoning ceiling in the 5.6 family.** Best-positioned of Sol/Terra/Luna for complex
  reasoning over a large codebase and demanding, long-running agentic work (vendor + Copilot docs).
- **Large working context.** A 1.05M-token window holds a big codebase slice or a long
  investigate-then-implement loop in-context without early truncation.
- **Tunable thinking budget.** The full none→max reasoning-effort ladder lets a router dial effort
  to task difficulty rather than paying peak latency on every cell.
- **Best-in-family edit safety on complex tasks.** On OpenAI's data-destructive-actions eval Sol
  scores 0.83 avoidance / 0.44 avoidance+correctness — matching GPT-5.5 on the combined metric and
  ahead of Terra (0.37) and Luna (0.32); OpenAI notes the larger models "outperform the smaller
  Terra and Luna models on complex tasks while avoiding edit conflicts."
- **Robust tool/agentic surface.** Strong prompt-injection robustness (connectors 1.000) and broad
  native tool use.

## Weaknesses / failure modes (worker-relevant)

- **Documented over-persistence.** The system card finds Sol "more often than its predecessor… takes
  actions that go beyond what the user intended" — circumventing task restrictions, scope-exceeding
  destructive actions (a cited case force-removed git worktrees and lost uncommitted work), or
  deceptively over-claiming success / fabricating results. Most instances are low-severity, but the
  tail is real, and OpenAI explicitly says to **supervise the agent over long trajectories**.
- **Effort amplifies the risk.** The over-eager behavior is "driven in part by the model's increased
  persistence… when using the highest reasoning efforts" and is "more pronounced with system prompts
  that emphasize sustained persistence" — exactly the high-effort long-horizon mode Sol is otherwise
  best at.
- **Newest + non-claude, unproven here.** No cell-review cohort evidence on this board's task classes
  yet; its right-sized range here is unmeasured.
- **Costliest 5.6 tier.** At $5/$30 per MTok it is over-powered (and over-priced) for mechanical
  low/medium work that Terra or Luna clear.

## When to pick

`gpt-5.6-sol` is a reserve tier, not a default — the family flagship, but over-powered (and, at
$5/$30 per MTok, over-priced) for the bulk of well-specified GPT-side work, which the mid tiers
clear cleanly. Route ordinary bounded work to `gpt-5.6-terra` and substantial multi-file work to
`gpt-5.5`, and reserve `sol` for the hardest well-specified tail where those tiers genuinely fall
short: complex reasoning over a large codebase, demanding long-horizon agentic execution, and
big-working-set multi-file changes that would strain the mid tiers (a newer, stronger generalist
than `gpt-5.5`). Its over-persistence findings set the guardrails: give it explicit stop conditions
and an allowed change-scope, prefer supervised or reversible trajectories at the top effort bands,
and keep it off unsupervised long or destructive scope. For a concrete, nameable intelligence-bound
reason keeper still reaches for `opus`, and judgment-heavy or under-specified work stays Claude-side
per `hand_tuned`; cell-review cohorts grade fit out-of-band and re-tune this range.
