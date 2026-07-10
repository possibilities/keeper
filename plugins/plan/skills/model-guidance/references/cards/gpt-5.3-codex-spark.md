# Model card — `gpt-5.3-codex-spark` (GPT-5.3-Codex system card addendum)

<!--
provenance:
  model_id: gpt-5.3-codex-spark
  source_url: https://openai.com/index/gpt-5-3-codex-system-card/
  resolved_url: https://deploymentsafety.openai.com/gpt-5-3-codex/gpt-5-3-codex.pdf
  fetched: 2026-07-10
  content_type: application/pdf
  converter: pdftotext -layout (poppler-utils), hand-trimmed to markdown
  status: cached
-->

OpenAI does not publish a card scoped to `gpt-5.3-codex-spark` specifically; the host-roster
capability model resolves for card purposes to the parent-family card, the *GPT-5.3-Codex System
Card* addendum, per the fallback the epic and task spec document. This is the vendor's own card,
converted from the published PDF to markdown and cached raw (no distillation) — the primary
source the `gpt-5.3-codex-spark` research notes (`../gpt-5.3-codex-spark.md`) draw judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-3-codex-system-card/` links out
to a deployment-safety hub (`deploymentsafety.openai.com/gpt-5-3-codex`), which in turn links the
actual PDF at the resolved URL above — a three-hop discovery, none of the three URLs
content-addressed, but none guaranteed durable either. `openai.com` blocks unauthenticated
fetchers (Cloudflare bot-challenge) as of this fetch; the content above was retrieved through the
Wayback Machine's archived snapshot of the same chain (archived 2026-07-08/09) rather than a live
fetch — noted here as a fallback path, not fabrication: the archived bytes are the vendor's
published PDF, unmodified.

## Publication

*GPT-5.3-Codex System Card* — OpenAI, February 5, 2026.

## Introduction (verbatim excerpt, §1)

> GPT-5.3-Codex is the most capable agentic coding model to date, combining the frontier coding
> performance of GPT-5.2-Codex with the reasoning and professional knowledge capabilities of
> GPT-5.2. This enables it to take on long-running tasks that involve research, tool use, and
> complex execution. Much like a colleague, you can steer and interact with GPT-5.3-Codex while
> it's working, without losing context.
>
> Like other recent models, it is being treated as High capability on biology, and is being
> deployed with the corresponding suite of safeguards we use for other models in the GPT-5
> family. It does not reach High capability on AI self-improvement.
>
> This is the first launch we are treating as High capability in the Cybersecurity domain under
> our Preparedness Framework, activating the associated safeguards. We do not have definitive
> evidence that this model reaches our High threshold, but are taking a precautionary approach
> because we cannot rule out the possibility that it may be capable enough to reach the
> threshold.

## Product-specific risk mitigations (verbatim excerpt, §3.1–3.2)

> Codex agents are intended to operate within isolated, secure environments to minimize potential
> risks during task execution... When using Codex in the cloud, the agent runs with access to an
> isolated container hosted by OpenAI, effectively its own computer with network access disabled
> by default... When using Codex locally on MacOS, Linux, and Windows, the agent executes commands
> within a sandbox by default. On MacOS, this sandboxing is enforced using Seatbelt policies... On
> Linux, a combination of seccomp and landlock is utilized... Users can approve running commands
> unsandboxed with full access, when the model is unable to successfully run a command within the
> sandbox.
>
> As part of our commitment to iterative deployment, we originally launched Codex cloud with a
> strictly network-disabled, sandboxed task-execution environment... We enable users to decide on
> a per-project basis which sites, if any, to let the agent access while it is running.

## Model-specific risk mitigations (verbatim excerpt, §4.1.1)

> Coding agents have access to powerful tools — file systems, Git, package managers, and other
> development interfaces — that enable them to act autonomously. While these capabilities unlock
> productivity, they also introduce high-impact failure modes that involve deletion or corruption
> of data.

## Baseline evaluation note (verbatim excerpt, §2.1)

> We do not believe these conversational evals are reflective of real-world risk in the context of
> this coding-focused model... GPT-5.3-Codex generally performs on par with or close to
> GPT-5.2-Thinking when used in a conversational setting. As explained in the GPT-5.1-Codex-Max
> system card, the model is not intended for conversational use.

## Card structure

The full card (not reproduced here) covers, in order: baseline model safety evaluations
(disallowed-content benchmarks vs. GPT-5.2-Thinking), product-specific risk mitigations (agent
sandbox, network access), model-specific risk mitigations (data-destructive action avoidance),
and Preparedness Framework capability + safeguards assessment across biological/chemical,
cybersecurity, and AI self-improvement categories, closing with limitations (identity
verification/recidivism detection limits, policy gray areas, undiscovered universal jailbreaks)
and references.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
