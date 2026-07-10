# Model card — `gpt-5.4` (GPT-5.4 Thinking System Card)

<!--
provenance:
  model_id: gpt-5.4
  source_url: https://openai.com/index/gpt-5-4-thinking-system-card/
  resolved_url: https://deploymentsafety.openai.com/gpt-5-4-thinking/gpt-5-4-thinking.pdf
  fetched: 2026-07-10
  content_type: application/pdf
  converter: pdftotext -layout (poppler-utils), hand-trimmed to markdown
  status: cached
-->

The API alias `gpt-5.4` is the frontier reasoning model this card documents — OpenAI refers to it
throughout as *GPT-5.4 Thinking* / `gpt-5.4-thinking`, and the `gpt-5.4` alias currently pins the
dated snapshot `gpt-5.4-2026-03-05` (the card's own date). This is the vendor's own card, converted
from the published PDF to markdown and cached raw (no distillation) — the primary source the `gpt-5.4`
research notes (`../gpt-5.4.md`) draw judgment from.

Discovery chain: the durable landing page `openai.com/index/gpt-5-4-thinking-system-card/` links out
to a deployment-safety hub (`deploymentsafety.openai.com/gpt-5-4-thinking/introduction`), which links
the actual PDF at the resolved URL above — a three-hop discovery, none of the three URLs
content-addressed nor guaranteed durable. Unlike the `gpt-5.3-codex-spark` card, this fetch did NOT
require the Wayback Machine: `deploymentsafety.openai.com` served the PDF directly to an
unauthenticated client (HTTP 200) on the fetch date, so the bytes below are the vendor's live
published PDF, unmodified. (`openai.com` itself remains Cloudflare-gated; the durable landing URL is
recorded for discovery, not because it was the fetch host.)

## Publication

*GPT-5.4 Thinking System Card* — OpenAI, March 5, 2026. The GPT-5.4 mini appendix (§6) was added
March 17, 2026.

## Introduction (verbatim excerpt, §1)

> GPT-5.4 Thinking is the latest reasoning model in the GPT-5 series, and explained in our blog.
> The comprehensive safety mitigation approach for this model is similar to previous models in this
> series, but 5.4 Thinking is the first general purpose model to have implemented mitigations for
> High capability in Cybersecurity. The approach to cyber safety builds on the latest approaches
> implemented for GPT-5.3 Codex, in ChatGPT and the API.
>
> In this card we also refer to GPT-5.4 Thinking as gpt-5.4-thinking. Note that there is not a
> model named GPT-5.3 Thinking, so the main model to baseline against is GPT-5.2 Thinking.

## Avoid Accidental Data-Destructive Actions (verbatim excerpt, §3.7)

> As with GPT-5.3-Codex, we ran our destructive actions evaluation that measures the model's ability
> to preserve user-produced changes and avoid taking accidental destructive actions. We find that
> GPT-5.4 Thinking performs approximately on par with GPT-5.3-Codex.
>
> Destructive action can also be particularly prevalent when agents operate deletion-inducing tasks
> (e.g., file reversion and cleanup) in complex workspaces with ongoing changes from users or even
> other agents. A safe and collaborative agent should distinguish between their work and user work,
> protect user changes by default, and recover from mistakes. Therefore, we trained our agents to
> revert their own changes after long rollouts while protecting implicit, simulated user work. On
> evaluations involving challenging, long-rollout traces, GPT-5.4-Thinking performs much better than
> earlier models in tracking and reverting its operations while leaving user work intact.

Reported figures: destructive-action avoidance 0.86 (gpt-5.2-codex 0.76, gpt-5.3-codex 0.88);
perfect reversion 0.18 (0.09 / 0.01); user work preserved 0.53 (0.18 / 0.08).

## Cybersecurity capability (verbatim excerpt, §5.1.2)

> GPT-5.4-Thinking is highly capable, closely matching the results for GPT-5.3-Codex. Because of this
> strong performance, we similarly treat GPT-5.4-Thinking as High under the Preparedness Framework.
>
> Under our Preparedness Framework, High cybersecurity capability is defined as a model that removes
> existing bottlenecks to scaling cyber operations, including either by automating end-to-end cyber
> operations against reasonably hardened targets, or by automating the discovery and exploitation of
> operationally relevant vulnerabilities.
>
> We are treating this model as High, even though we cannot be certain that it actually has these
> capabilities, because it meets the requirements of each of our canary thresholds and we therefore
> cannot rule out the possibility that it is in fact Cyber High.

## Card structure

The full card (not reproduced here) covers, in order: model data and training; baseline model safety
evaluations (disallowed content, production benchmarks, jailbreaks, prompt injection, vision, health,
accidental data-destructive actions, user confirmations during computer use, bias); chain-of-thought
evaluations (monitorability and controllability — the latter drawing on CoT-Control tasks built from
GPQA, MMLU-Pro, HLE, BFCL, and SWE-Bench Verified); the Preparedness Framework capability +
safeguards assessment across biological/chemical, cybersecurity, and AI self-improvement (with a
dedicated cyber-safeguards section and threat taxonomy); and a closing GPT-5.4 mini appendix (§6). API
capability facts not in the safety card — 1.05M-token context, 128K max output, Aug 31 2025 knowledge
cutoff, reasoning-effort `none`→`xhigh`, built-in computer use, native compaction — come from the
GPT-5.4 model page and model-guidance page cited in `../gpt-5.4.md`.

## Copyright

© OpenAI. Cached here as an internal review artifact under the tolerated-risk allowance in
docs/adr/0037; not a redistribution license.
