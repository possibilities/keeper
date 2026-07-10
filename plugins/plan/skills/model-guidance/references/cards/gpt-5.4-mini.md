# Model card — `gpt-5.4-mini` (GPT-5.4 Thinking System Card, mini appendix §6)

<!--
provenance:
  model_id: gpt-5.4-mini
  source_url: https://openai.com/index/gpt-5-4-thinking-system-card/
  resolved_url: https://deploymentsafety.openai.com/gpt-5-4-thinking/gpt-5-4-thinking.pdf
  fetched: 2026-07-10
  content_type: application/pdf
  converter: pdftotext -layout (poppler-utils), hand-trimmed to markdown
  status: cached
-->

OpenAI does not publish a card scoped to `gpt-5.4-mini` on its own; the model is documented inside the
parent *GPT-5.4 Thinking System Card* as an appendix (§6, "Appendix: GPT-5.4 mini"), added March 17,
2026 with the mini launch. This is the sanctioned per-model fallback — the parent-family card cached
here per-model — but a tighter one than the `gpt-5.3-codex-spark` precedent: the parent card carries a
mini-specific appendix with its own disallowed-content, CoT-controllability, and Preparedness results,
so the excerpts below are about `gpt-5.4-mini` directly, not merely inherited from the flagship. The
`gpt-5.4-mini` alias currently pins the dated snapshot `gpt-5.4-mini-2026-03-17`. This is the vendor's
own card, converted from the published PDF to markdown and cached raw (no distillation) — the primary
source the `gpt-5.4-mini` research notes (`../gpt-5.4-mini.md`) draw judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-4-thinking-system-card/` links out
to a deployment-safety hub (`deploymentsafety.openai.com/gpt-5-4-thinking/introduction`), which links
the actual PDF at the resolved URL above. As with the flagship card, this fetch did NOT require the
Wayback Machine: `deploymentsafety.openai.com` served the PDF directly to an unauthenticated client
(HTTP 200) on the fetch date, so the bytes below are the vendor's live published PDF, unmodified.
(`openai.com` itself remains Cloudflare-gated; the durable landing URL is recorded for discovery, not
because it was the fetch host.)

## Publication

*GPT-5.4 Thinking System Card* — OpenAI, March 5, 2026; §6 "Appendix: GPT-5.4 mini" added March 17,
2026.

## Appendix opening (verbatim excerpt, §6)

> This section was added on March 17, 2026, with the launch of GPT-5.4 mini.

## Preparedness Framework (verbatim excerpt, §6.3)

> Based on our Preparedness evaluations, we have determined that GPT-5.4 mini as below High capability
> across biochemical, cybersecurity, and AI-self improvement domains.

This is the key contrast with the flagship: full GPT-5.4 Thinking is treated as **High** in
Cybersecurity, whereas `gpt-5.4-mini` sits **below** High across every Preparedness domain.

## CoT controllability (verbatim excerpt, §6.2)

> We measure GPT-5.4 mini's controllability by running CoT-Control (Yueh-Han, 2026 [15]), similarly to
> our controllability evaluation for GPT-5.4 Reasoning. We find that GPT-5.4 mini has lower CoT
> controllability than any previous model we reported CoT controllability for.

(Low CoT controllability is reported by OpenAI as a *desirable* property — it suggests the model
correspondingly lacks the ability to obfuscate its reasoning to evade monitors.)

## Capability evals vs the flagship (verbatim tables, §6.3.2–6.3.3)

Mini trails full GPT-5.4 Thinking only modestly on the agentic/coding-adjacent benchmarks:

> Cybersecurity (Table 19):
>   Capture the Flag (CTF)   pass@12   gpt-5.4-thinking 88.23%   gpt-5.4-mini 81.32%
>   CVE-Bench                pass@1    gpt-5.4-thinking 86.27%   gpt-5.4-mini 83.33%
>
> AI Self Improvement (Table 20):
>   Monorepo-Bench           pass@1    gpt-5.4-thinking 59.33%   gpt-5.4-mini 54.00%
>   OpenAI-Proof Q&A (OPQA)  pass@1    gpt-5.4-thinking 04.16%   gpt-5.4-mini 07.5%

## Card structure

The parent card (not reproduced in full) covers model data/training, baseline safety evaluations,
chain-of-thought evaluations, and the Preparedness Framework assessment for the flagship GPT-5.4
Thinking, closing with the §6 GPT-5.4 mini appendix excerpted above (disallowed-content production +
adversarial benchmarks, CoT controllability, and a Preparedness capabilities assessment across
biological/chemical, cybersecurity, and AI self-improvement). API capability facts not in the safety
card — 400K-token context, 128K max output, Aug 31 2025 knowledge cutoff, reasoning-effort
`none`→`xhigh`, positioning for high-volume coding / computer use / subagents — come from the
gpt-5.4-mini model page and the GPT-5.4 model-guidance page cited in `../gpt-5.4-mini.md`.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
