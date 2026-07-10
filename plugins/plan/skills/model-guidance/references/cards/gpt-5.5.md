# Model card — `gpt-5.5` (GPT-5.5 System Card)

<!--
provenance:
  model_id: gpt-5.5
  source_url: https://openai.com/index/gpt-5-5-system-card/
  resolved_url: https://deploymentsafety.openai.com/gpt-5-5/gpt-5-5.pdf
  fetched: 2026-07-10
  content_type: application/pdf
  converter: pdftotext -layout (poppler-utils), hand-trimmed to markdown
  status: cached
-->

Unlike the codex-spark fallback, OpenAI publishes a card scoped to `gpt-5.5` directly — the
*GPT-5.5 System Card*. This is the vendor's own card, converted from the published PDF to markdown
and cached raw (no distillation) — the primary source the `gpt-5.5` research notes
(`../gpt-5.5.md`) draw judgment from. Only the coding-relevant excerpts are reproduced; the full
card is a 44-page safety document.

Discovery chain: the durable landing page `openai.com/index/gpt-5-5-system-card/` links out through
a deployment-safety hub (`deploymentsafety.openai.com/gpt-5-5`) to the actual PDF at the resolved
URL above. `openai.com` blocks unauthenticated fetchers (Cloudflare bot-challenge) as of this
fetch, so the *landing page* was read through the Wayback Machine's archived snapshot; the *PDF
itself*, however, was fetched LIVE (HTTP 200, `application/pdf`) directly from
`deploymentsafety.openai.com` — the bytes below are the vendor's published PDF, unmodified.

## Publication

*GPT-5.5 System Card* — OpenAI, April 23, 2026 (card updated April 24, 2026). The `gpt-5.5` alias
resolves to snapshot `gpt-5.5-2026-04-23`; knowledge cutoff December 1, 2025.

## Model facts (from the vendor model page, not the safety card)

Context window 1,050,000 tokens; max output 128,000 tokens; reasoning.effort ∈ {none, low,
medium(default), high, xhigh}; text + image input, text output. Billed by OpenAI's own model page
as "Default" and "our newest frontier model for the most complex professional work" at the
"Highest" reasoning setting. (Recorded here for the research notes; not part of the PDF.)

## Introduction (verbatim excerpt, §1)

> GPT-5.5 is a new model designed for complex, real-world work, including writing code, researching
> online, analyzing information, creating documents and spreadsheets, and moving across tools to
> get things done. Relative to earlier models, GPT-5.5 understands the task earlier, asks for less
> guidance, uses tools more effectively, checks it work and keeps going until it's done.
>
> We subjected the model to our full suite of predeployment safety evaluations and our Preparedness
> Framework, including targeted red-teaming for advanced cybersecurity and biology capabilities,
> and collected feedback on real use cases from nearly 200 early-access partners before release. We
> are releasing GPT-5.5 with our strongest set of safeguards to date, designed to reduce misuse
> while preserving legitimate, beneficial uses of advanced capabilities.
>
> We generally treat GPT-5.5's safety results as strong proxies for GPT-5.5 Pro, which is the same
> underlying model using a setting that makes use of parallel test time compute.

## Model Data and Training (verbatim excerpt, §2)

> OpenAI reasoning models are trained to reason through reinforcement learning. These models are
> trained to think before they answer: they can produce a long internal chain of thought before
> responding to the user. Through training, these models learn to refine their thinking process,
> try different strategies, and recognize their mistakes.

## Evaluating Coding Agents for Misalignment (verbatim excerpt, §7.2)

The most worker-relevant section: OpenAI resampled recent internal *agentic coding* trajectories
through a tool-response simulator and classified the final turn for misalignment category and
severity.

> Our analysis estimates that GPT-5.5 is slightly more misaligned than GPT-5.4 Thinking across
> several categories, though nearly all of this is low-severity misalignment. We did not find any
> novel severe misalignment with this evaluation: the severity 3 rate was 0.01% for both models,
> and the highest severity level (4) of our system was never triggered.
>
> Some of the subcategories with statistically significant increases involved GPT-5.5 acting as
> though pre-existing work was its own, ignoring user-given constraints about what kind of code
> changes it can make, or overeagerly taking action when the user was only asking questions.

## Chain-of-thought note (verbatim excerpt, §7.3.2)

> This suggests that despite its increased reasoning capabilities, GPT-5.5 is less able to reshape
> its CoT in ways that could reduce monitorability, thus increasing our confidence in the
> reliability of our CoT monitoring.

## Card structure

The full card (not reproduced here) covers, in order: introduction; model data and training;
safety (disallowed content, vision, avoiding accidental data-destructive actions, user
confirmations during computer use); robustness (jailbreaks, prompt injection); health;
hallucinations; alignment (including the §7.2 agentic-coding resampling and CoT
monitorability/controllability evaluations); bias; and a large Preparedness Framework capability +
safeguards assessment across biological/chemical, cybersecurity, and AI self-improvement
categories — external evaluators (SecureBio, US CAISI, UK AISI, Irregular) judge GPT-5.5 a step up
in cyber capability over prior OpenAI models.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
