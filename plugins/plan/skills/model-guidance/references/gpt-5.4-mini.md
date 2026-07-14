# Research cache — `gpt-5.4-mini`

<!--
provenance:
  model_id: gpt-5.4-mini         # host-roster capability token, served through Pi as a wrapped cell
  resolves_to: openai-codex/gpt-5.4-mini  # Pi-hosted launch id; the vendor `gpt-5.4-mini` alias currently pins the dated upstream snapshot gpt-5.4-mini-2026-03-17
  researched: 2026-07-10
  status: researched             # provenance state: this cache reflects a real web-sourced capability-review pass
  method: web-sourced capability review of OpenAI's own gpt-5.4-mini API model page, the GPT-5.4 model-guidance page, and the GPT-5.4 mini appendix (§6) of the GPT-5.4 Thinking System Card (added March 17, 2026). No in-repo Pi live probe — capability judgment is drawn from vendor docs + the cached card, not a wrapped-cell run
  sources:
    - OpenAI API model page (developers.openai.com/api/docs/models/gpt-5.4-mini) — "Our strongest mini model yet for coding, computer use, and subagents"; 400,000-token context window, 128,000 max output tokens, Aug 31 2025 knowledge cutoff, $0.75 / $4.50 per 1M input/output ($0.075 cached input), reasoning.effort none|low|medium|high|xhigh (none = default), text+image in / text out
    - OpenAI GPT-5.4 model guidance (developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4): mini positioned for "high-volume coding, computer use, and agent workflows that still need strong reasoning" — a faster, more efficient variant of gpt-5.4 above gpt-5.4-nano
    - GPT-5.4 Thinking System Card §6 (OpenAI, appendix added March 17, 2026): gpt-5.4-mini rated BELOW High capability across biochemical, cybersecurity, and AI-self-improvement — trails full gpt-5.4-thinking modestly on agentic/coding benchmarks (Monorepo-Bench 54.00% vs 59.33%, CVE-Bench 83.33% vs 86.27%, CTF 81.32% vs 88.23%)
-->

This file is the raw research backing the distilled `models.gpt-5.4-mini` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.4-mini.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.4-mini` capability id is re-pointed to a newer upstream snapshot
(currently `gpt-5.4-mini-2026-03-17`), or when out-of-band cell-review cohort evidence materially
re-grades its routing fit.

## What `gpt-5.4-mini` is

`gpt-5.4-mini` is a **wrapped cell** capability: keeper does not serve it natively, so a Claude
wrapper delegates implementation to the model's serving provider (the `pi` harness in the host
matrix) and re-owns the keeper close-out (tests, soft-reset of foreign commits, the single sanitized
trailer commit). Upstream it is OpenAI's **fast, efficient mini variant of GPT-5.4** — "our strongest
mini model yet for coding, computer use, and subagents," bringing the flagship's strengths to a
smaller model built for high-volume workloads. It keeps a **400K-token context window**, 128K max
output, and the same reasoning-effort control (`none` default through `xhigh`) at roughly a third of
full gpt-5.4's price ($0.75 / $4.50 per 1M). OpenAI positions it for work that "still needs strong
reasoning," and the system-card appendix rates it *below* High capability across every Preparedness
domain while trailing the full model only modestly on agentic-coding benchmarks — so it is a genuine
light-but-capable tier, not a token-cheap toy.

On the plan board it routes per the binding `hand_tuned` GPT-first policy — GPT tiers take
well-specified work whose quality bar is correctness against a nameable acceptance, while Claude
tiers keep judgment-heavy, taste-, or intelligence-bound work — and out-of-band cell-review cohorts
grade fit through the wrapped-cell path, re-tuning this guidance as evidence accumulates.

## Strengths (worker-relevant)

- **Strongest light-tier reasoning in the fleet.** Retains real reasoning-effort control and trails
  full gpt-5.4 only modestly on agentic/coding benchmarks — a clear step up from
  `gpt-5.3-codex-spark`'s lower ceiling.
- **Fast + cheap for bounded work.** Fast speed class at ~1/3 the full model's price; well-suited to
  high-volume mechanical edits and tightly-scoped test/refactor work.
- **Generous context for a light tier.** 400K-token window holds a substantial file set or a
  multi-step agent trajectory — far more headroom than spark for a bounded-but-not-tiny task.
- **Built for computer use + subagents.** Vendor-tuned for agent/computer-use loops, so it holds up
  in a bounded build-run-verify loop better than a pure quick-edit tier.

## Weaknesses / failure modes (worker-relevant)

- **Below the full model's ceiling.** A mini variant — multi-file design, cross-module reasoning, and
  ambiguous acceptance under-resolve here relative to full gpt-5.4 or sonnet; give it the choice
  pre-made, not discovered.
- **Unproven through the wrapped-cell path.** Capability is vendor-documented, not yet cohort-graded
  through Keeper's Pi harness — integration evidence, not raw strength, is the open question.
- **`none`-default reasoning under-thinks if unguided.** Its lowest effort is the default; work that
  needs deliberation must be dispatched at a raised effort or it answers too shallowly.
- **Contract-shaped blast radius.** Higher risk on contract-, schema-, or wire-shaped changes where a
  wrong abstraction propagates past the task — the class the routing policy keeps every light tier
  away from.

## When to pick

Route `gpt-5.4-mini` to **bounded mechanical work where speed matters and some real reasoning or
working-set headroom is needed** — high-volume single-file edits, straight test additions, mechanical
refactors with an explicit before/after shape, and bounded agent/computer-use loops. It is a
light/fast tier like `gpt-5.3-codex-spark`, but with meaningfully more headroom: retained reasoning
and a 400K context let it carry bounded-but-not-tiny tasks that spark's "tiny fully-specified only"
ceiling would strand — so prefer mini over spark once a bounded task needs any reasoning or a larger
working set, and prefer spark only for the smallest fully-specified mechanical edits. Step **up** to
full `gpt-5.4`, `gpt-5.6-terra`, or `gpt-5.5` when the task needs frontier reasoning, a >400K working
set, or design judgment spanning more than one surface; judgment-heavy or under-specified work stays
Claude-side per `hand_tuned` (opus only on a nameable intelligence-bound exception). Dispatch at an
explicit effort band (its upstream default is its lowest); cell-review cohorts grade fit out-of-band
and re-tune this range.
