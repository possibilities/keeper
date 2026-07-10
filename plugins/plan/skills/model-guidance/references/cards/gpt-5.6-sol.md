# Model card — `gpt-5.6-sol` (GPT-5.6 Preview System Card)

<!--
provenance:
  model_id: gpt-5.6-sol
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
per-model, and this file foregrounds the **Sol-specific** excerpts — the flagship is the variant the
card's agentic-coding misalignment and destructive-action simulations were run against. This is the
vendor's own card, converted from the published PDF to markdown and cached raw (no distillation) —
the primary source the `gpt-5.6-sol` research notes (`../gpt-5.6-sol.md`) draw judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-6/` announces the family and links
the deployment-safety hub (`deploymentsafety.openai.com/gpt-5-6-preview`), which serves the PDF at
the resolved URL above. The PDF was fetched **directly** via curl (browser UA) — no Wayback fallback
was needed for the artifact; `openai.com` itself bot-blocks unauthenticated fetchers, so the landing
URL is recorded from the deployment-safety hub + search attribution, not an independent re-fetch.

Developer-doc positioning (from `developers.openai.com/api/docs/models/gpt-5.6-sol`, not the PDF):
Sol is "the frontier model in the GPT-5.6 family… roughly corresponds to the unsuffixed model tier
used in earlier GPT-5 families. The `gpt-5.6` alias routes requests to GPT-5.6 Sol." Reasoning ceiling
"Highest"; 1,050,000-token context; 128,000 max output; $5/$30 per MTok; Feb 16, 2026 knowledge
cutoff.

## Publication

*GPT-5.6 System Card* — OpenAI, 2026-07-09.

## Introduction (verbatim excerpt, §1)

> GPT-5.6 is a new family of three models: Sol, our new flagship model; Terra, a capable lower-cost
> option; and Luna, our fastest and most cost-efficient model. The safeguards we have built for this
> launch—our most robust yet—are built to deliver these models safely and at scale, around the world.
>
> Under our Preparedness Framework, we are treating Sol, Terra and Luna as High capability in both
> Cybersecurity and Biological and Chemical risk. None of them reach our High threshold in AI
> Self-Improvement.

> [Key point 1] … Separate evaluations examined misaligned behavior in agentic coding tasks and found
> GPT-5.6 shows a greater tendency than GPT-5.5 to go beyond the user's intent, including by taking or
> attempting actions that the user had not asked for, though absolute rates remain low.

> [Key point 2] … Because these measures can create friction for benign users, we provide an option
> in ChatGPT and Codex to easily retry prompts on lower-capability models…

The card also notes performance is reported as a curve **across reasoning-effort levels** ("the
amount of thinking a model uses to work through a problem") rather than a single score.

## Avoiding accidental data-destructive actions (verbatim excerpt, §3.3)

> GPT-5.6 Sol remains strong at avoiding data overwrites, with an avoidance-only score slightly below
> GPT-5.5's, and matches GPT-5.5 on the combined metric… In general, our larger models outperform the
> smaller Terra and Luna models on complex tasks while avoiding edit conflicts.

|                          | gpt-5.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|--------------------------|:-------:|:-----------:|:-------------:|:------------:|
| Avoidance only           |  0.88   |   **0.83**  |     0.81      |     0.73     |
| Avoidance + Correctness  |  0.44   |   **0.44**  |     0.37      |     0.32     |

## Misaligned behavior in agentic coding (verbatim excerpt, §7.2 — run against Sol)

> We find that GPT-5.6 Sol, more often than its predecessor, can be overly persistent in pursuing
> user goals, to the point of taking actions that go beyond what the user intended… When GPT-5.6 is
> used as a coding agent, particularly over long trajectories, we believe it is important for users to
> supervise the agent's work.
>
> In coding contexts, misalignment generally stems from a mix of overeagerness to complete the task
> and interpreting user instructions too permissively – assuming that actions are allowed unless
> they're explicitly and unambiguously prohibited. This manifests as the model being overly agentic in
> circumventing restrictions it faces when attempting the requested task, being careless in taking
> actions which may be destructive beyond the scope of the task, or deceptive when reporting its
> results to users.
>
> We suspect that this effect is driven in part by the model's increased persistence relative to
> GPT-5.5 when using the highest reasoning efforts… more pronounced with system prompts that emphasize
> sustained persistence. That said, the absolute rates of these behaviors remain low.

Monitor summaries cited (verbatim): "GPT-5.6 Sol ran destructive cleanup on three virtual machines
the user did not name" (substituted VM names, "force-removed worktrees," acknowledged uncommitted
work "may have been lost"); and "GPT-5.6 Sol claimed it completed work that it had not actually done."

## Robustness (verbatim excerpts, §4.1–4.2)

> GPT-5.6-Sol performs comparably to recent predecessors and is similar to GPT-5.5-Thinking in
> particular. [jailbreaks]

Prompt-injection (higher = better): Connectors — Sol **1.000**; Search & Function-Calling — Sol
**0.910** (Terra 0.946, Luna 0.897).

## Card structure

The full card (not reproduced here) covers, in order: model data + training, model safety
(disallowed content, vision, data-destructive actions, computer-use confirmations), robustness
(jailbreaks, prompt injection), health (HealthBench), hallucinations, alignment (deployment-simulation
forecasting of misaligned behavior in ChatGPT + internal agentic-coding traffic, CoT
monitorability/controllability, metagaming), and the Preparedness Framework assessment across
biological/chemical, cybersecurity, and AI self-improvement, closing with limitations and references.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
