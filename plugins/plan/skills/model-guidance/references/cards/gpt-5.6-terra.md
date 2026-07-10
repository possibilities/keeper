# Model card — `gpt-5.6-terra` (GPT-5.6 Preview System Card)

<!--
provenance:
  model_id: gpt-5.6-terra
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
per-model, and this file foregrounds the **Terra-specific** excerpts — the shared safety tables break
out a Terra column, and Terra is served (with Sol) behind the newly-added activation classifiers. This
is the vendor's own card, converted from the published PDF to markdown and cached raw (no
distillation) — the primary source the `gpt-5.6-terra` research notes (`../gpt-5.6-terra.md`) draw
judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-6/` announces the family and links
the deployment-safety hub (`deploymentsafety.openai.com/gpt-5-6-preview`), which serves the PDF at
the resolved URL above. The PDF was fetched **directly** via curl (browser UA) — no Wayback fallback
was needed for the artifact; `openai.com` itself bot-blocks unauthenticated fetchers, so the landing
URL is recorded from the deployment-safety hub + search attribution, not an independent re-fetch.

Developer-doc positioning (from `developers.openai.com/api/docs/models/gpt-5.6-terra`, not the PDF):
Terra is "designed for workloads that balance intelligence and cost… roughly corresponds to the mini
model tier used in earlier GPT-5 families." Reasoning ceiling "Higher"; 1,050,000-token context;
128,000 max output; $2.50/$15 per MTok; Feb 16, 2026 knowledge cutoff.

## Publication

*GPT-5.6 System Card* — OpenAI, 2026-07-09.

## Introduction (verbatim excerpt, §1)

> GPT-5.6 is a new family of three models: Sol, our new flagship model; Terra, a capable lower-cost
> option; and Luna, our fastest and most cost-efficient model… Under our Preparedness Framework, we
> are treating Sol, Terra and Luna as High capability in both Cybersecurity and Biological and
> Chemical risk. None of them reach our High threshold in AI Self-Improvement.
>
> [Key point 3] … The models are trained to be safe, Sol and Terra are served with newly added
> activation classifiers focused on sensitive domains that watch the model and can intervene to stop
> unsafe answers during generation…

> [Key point 1] … Separate evaluations examined misaligned behavior in agentic coding tasks and found
> GPT-5.6 shows a greater tendency than GPT-5.5 to go beyond the user's intent… though absolute rates
> remain low.

The card reports performance as a curve **across reasoning-effort levels** rather than a single
score. The agentic-coding misalignment simulation (§7.2) was run against Sol, but characterizes the
shared post-training lineage the whole family — Terra included — inherits.

## Avoiding accidental data-destructive actions (verbatim excerpt, §3.3)

> In general, our larger models outperform the smaller Terra and Luna models on complex tasks while
> avoiding edit conflicts.

|                          | gpt-5.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|--------------------------|:-------:|:-----------:|:-------------:|:------------:|
| Avoidance only           |  0.88   |    0.83     |    **0.81**   |     0.73     |
| Avoidance + Correctness  |  0.44   |    0.44     |    **0.37**   |     0.32     |

## Robustness — prompt injection (verbatim excerpt, §4.2)

Terra posts the family's **strongest** search/function-calling injection robustness (higher = better):

| Eval                        | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|-----------------------------|:-----------:|:-------------:|:------------:|
| Connectors                  |    1.000    |   **1.000**   |    0.999     |
| Search & Function-Calling   |    0.910    |   **0.946**   |    0.897     |

## Health capability retention (verbatim excerpt, §5.1)

> GPT-5.6 Terra and GPT-5.6 Luna retain much of the performance of GPT-5.6 Sol despite their lower
> cost, both exceed[ing]… [the prior tier's scores].

## Chain-of-thought controllability (verbatim excerpt, §7.3.2 — run on Sol + Terra)

> We run CoT-Control only on Sol and Terra… We find that GPT-5.6 Sol's CoT controllability is higher
> than that of GPT-5.5 and GPT-5.4 Thinking. On the other hand, GPT-5.6 Terra shows low CoT
> controllability similar to previous models.

(The CoT-Control suite draws its tasks from GPQA, MMLU-Pro, HLE, BFCL, and **SWE-Bench Verified** —
i.e. it exercises a coding benchmark, though it measures reasoning-instruction-following, not raw
coding skill.)

## Card structure

The full card (not reproduced here) covers, in order: model data + training, model safety
(disallowed content, vision, data-destructive actions, computer-use confirmations), robustness
(jailbreaks, prompt injection), health (HealthBench), hallucinations, alignment (deployment-simulation
forecasting, CoT monitorability/controllability, metagaming), and the Preparedness Framework
assessment across biological/chemical, cybersecurity, and AI self-improvement, closing with
limitations and references.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
