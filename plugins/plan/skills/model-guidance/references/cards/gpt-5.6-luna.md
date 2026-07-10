# Model card — `gpt-5.6-luna` (GPT-5.6 Preview System Card)

<!--
provenance:
  model_id: gpt-5.6-luna
  source_url: https://openai.com/index/gpt-5-6/
  resolved_url: https://deploymentsafety.openai.com/gpt-5-6/gpt-5-6.pdf
  fetched: 2026-07-10
  content_type: application/pdf
  converter: pdftotext -layout (poppler-utils), hand-trimmed to markdown
  status: cached
-->

OpenAI publishes **one system card covering the whole GPT-5.6 family** (Sol / Terra / Luna), not a
per-variant card; the *GPT-5.6 Preview System Card* is that document. Per the fallback the epic and
task spec document (mirroring the `gpt-5.3-codex-spark` precedent), this family card is cached
per-model, and this file foregrounds the **Luna-specific** excerpts — the shared safety tables break
out a Luna column, and several evals (e.g. CoT-Control) were run only on Sol/Terra, so Luna's card is
honestly thinner on some axes. This is the vendor's own card, converted from the published PDF to
markdown and cached raw (no distillation) — the primary source the `gpt-5.6-luna` research notes
(`../gpt-5.6-luna.md`) draw judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-6/` announces the family and links
the deployment-safety hub (`deploymentsafety.openai.com/gpt-5-6-preview`), which serves the PDF at
the resolved URL above. The PDF was fetched **directly** via curl (browser UA) — no Wayback fallback
was needed for the artifact; `openai.com` itself bot-blocks unauthenticated fetchers, so the landing
URL is recorded from the deployment-safety hub + search attribution, not an independent re-fetch.

Developer-doc positioning (from `developers.openai.com/api/docs/models/gpt-5.6-luna`, not the PDF):
Luna is "designed for cost-sensitive, high-volume workloads… roughly corresponds to the nano model
tier used in earlier GPT-5 families." Reasoning ceiling "High" (lowest of the three); 1,050,000-token
context; 128,000 max output; $1/$6 per MTok; Feb 16, 2026 knowledge cutoff.

## Publication

*GPT-5.6 System Card* — OpenAI, 2026-07-09.

## Introduction (verbatim excerpt, §1)

> GPT-5.6 is a new family of three models: Sol, our new flagship model; Terra, a capable lower-cost
> option; and Luna, our fastest and most cost-efficient model… Under our Preparedness Framework, we
> are treating Sol, Terra and Luna as High capability in both Cybersecurity and Biological and
> Chemical risk. None of them reach our High threshold in AI Self-Improvement.

> [Key point 1] … Separate evaluations examined misaligned behavior in agentic coding tasks and found
> GPT-5.6 shows a greater tendency than GPT-5.5 to go beyond the user's intent, including by taking or
> attempting actions that the user had not asked for, though absolute rates remain low.

The card reports performance as a curve **across reasoning-effort levels** rather than a single
score. The agentic-coding misalignment simulation (§7.2) was run against Sol, but characterizes the
shared post-training lineage the whole family — Luna included — inherits; note the activation
classifiers described in key point 3 are called out for Sol and Terra, with Luna not named there.

## Avoiding accidental data-destructive actions (verbatim excerpt, §3.3)

> In general, our larger models outperform the smaller Terra and Luna models on complex tasks while
> avoiding edit conflicts.

Luna posts the family's **lowest** overwrite-avoidance scores — the sharpest edit-conflict caution
for a coding router:

|                          | gpt-5.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|--------------------------|:-------:|:-----------:|:-------------:|:------------:|
| Avoidance only           |  0.88   |    0.83     |     0.81      |   **0.73**   |
| Avoidance + Correctness  |  0.44   |    0.44     |     0.37      |   **0.32**   |

## Robustness — prompt injection (verbatim excerpt, §4.2)

Higher = better; Luna holds up but trails its siblings on the stronger search/function-calling attacks:

| Eval                        | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|-----------------------------|:-----------:|:-------------:|:------------:|
| Connectors                  |    1.000    |     1.000     |   **0.999**  |
| Search & Function-Calling   |    0.910    |     0.946     |   **0.897**  |

## Health capability retention (verbatim excerpt, §5.1)

> GPT-5.6 Terra and GPT-5.6 Luna retain much of the performance of GPT-5.6 Sol despite their lower
> cost, both exceed[ing]… [the prior tier's scores].

This is the card's clearest evidence that Luna punches above its nano-lineage price on breadth, even
as §3.3 shows it lagging on complex-edit safety.

## Card structure

The full card (not reproduced here) covers, in order: model data + training, model safety
(disallowed content, vision, data-destructive actions, computer-use confirmations), robustness
(jailbreaks, prompt injection), health (HealthBench), hallucinations, alignment (deployment-simulation
forecasting, CoT monitorability/controllability, metagaming — the latter two run on Sol/Terra), and
the Preparedness Framework assessment across biological/chemical, cybersecurity, and AI
self-improvement, closing with limitations and references.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
