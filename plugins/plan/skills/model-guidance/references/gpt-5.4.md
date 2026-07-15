# Research cache — `gpt-5.4`

<!--
provenance:
  model_id: gpt-5.4              # host-roster capability token, served through Pi as a wrapped cell
  resolves_to: openai-codex/gpt-5.4  # Pi-hosted launch id; the vendor `gpt-5.4` alias currently pins the dated upstream snapshot gpt-5.4-2026-03-05
  researched: 2026-07-10
  status: researched            # provenance state: this cache reflects a real web-sourced capability-review pass
  method: web-sourced capability review of OpenAI's own gpt-5.4 API model page, the GPT-5.4 model-guidance page, and the GPT-5.4 Thinking System Card (March 5, 2026). No in-repo Pi live probe — capability judgment is drawn from vendor docs + the cached card, not a wrapped-cell run
  sources:
    - OpenAI API model page (developers.openai.com/api/docs/models/gpt-5.4): 1,050,000-token context window, 128,000 max output tokens, Aug 31 2025 knowledge cutoff, $2.50 / $15 per 1M input/output ($0.25 cached input), reasoning.effort none|low|medium|high|xhigh (none = default + lowest), text+image in / text out; >272K-input prompts priced 2x input / 1.5x output for the session
    - OpenAI GPT-5.4 model guidance (developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4) — "frontier model for professional work across the API and Codex"; brings GPT-5.3-Codex coding to the flagship; new tool_search deferred loading, 1M context, first mainline model with built-in computer use, first mainline model trained for native compaction
    - GPT-5.4 Thinking System Card (OpenAI, March 5, 2026): treated as High capability in Cybersecurity; destructive-action-avoidance 0.86 and much-improved user-work preservation (0.53) / self-reversion (0.18) vs earlier codex models
-->

This file is the raw research backing the distilled `models.gpt-5.4` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.4.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.4` capability id is re-pointed to a newer upstream snapshot
(currently `gpt-5.4-2026-03-05`), or when out-of-band cell-review cohort evidence materially
re-grades its routing fit.

## What `gpt-5.4` is

`gpt-5.4` is a **wrapped cell** capability: keeper does not serve it natively, so a Claude wrapper
delegates implementation to the model's serving provider (the `pi` harness in the host matrix)
and re-owns the keeper close-out (tests, soft-reset of foreign commits, the single sanitized trailer
commit). Upstream it is OpenAI's **frontier general-purpose reasoning model** — the flagship of the
GPT-5.4 generation, released for professional work "across the API and Codex," with a **1.05M-token
context window**, a 128K max output, and reasoning-effort control (`none` default through `xhigh`).
OpenAI's own framing is that GPT-5.4 folds the coding capability of GPT-5.3-Codex into the mainline
flagship: production-quality code, polished front-end UI, repo-pattern following, and multi-file
changes "with fewer retries," plus a strong out-of-the-box coding personality. It is the first
mainline model with built-in computer use and native compaction, and it reduces end-to-end time and
token/tool-call count on multi-step agentic trajectories.

On the plan board it routes per the binding `hand_tuned` GPT-first policy — GPT tiers take
well-specified work whose quality bar is correctness against a nameable acceptance, while Claude
tiers keep judgment-heavy, taste-, or intelligence-bound work — and out-of-band cell-review cohorts
grade fit through the wrapped-cell path, re-tuning this guidance as evidence accumulates.

## Strengths (worker-relevant)

- **Frontier agentic coding.** Strong at production-quality multi-file changes with fewer retries and
  a capable build-run-verify-fix loop — the most capable non-claude coding tier in the fleet.
- **Very large context.** 1.05M-token window comfortably holds a whole subsystem, a long file set, or
  an extended agentic trajectory in one request — headroom no light tier has.
- **Strong instruction-following + repo-pattern adherence.** Follows repo-specific conventions and a
  detailed spec closely; low prompt-tuning overhead.
- **Token/tool-call efficiency on long trajectories.** Native compaction and reduced end-to-end time
  make it economical on tool-heavy, multi-step work despite the higher per-token price.
- **Preserves user work.** System-card destructive-action evals show markedly better tracking and
  reverting of its own edits while leaving concurrent user/agent work intact.

## Weaknesses / failure modes (worker-relevant)

- **Unproven through the wrapped-cell path.** Capability is vendor-documented, not yet cohort-graded
  through Keeper's Pi harness — integration evidence, not model strength, is the open question.
- **Not the intelligence-bound exception.** For a genuinely nameable reasoning-bound task, opus is the
  reserved exception; gpt-5.4 is a capable generalist, not that ceiling.
- **`none`-default reasoning under-thinks if unguided.** Its lowest effort is the default; a task that
  needs deliberate reasoning must be dispatched at a raised effort (or prompted to outline steps),
  else it answers too shallowly.
- **Cost + long-context surcharge.** At $2.50/$15 per 1M it is the priciest non-claude tier, and
  prompts over 272K input tokens carry a 2x-input / 1.5x-output session surcharge — wasteful on work a
  light tier would clear.

## When to pick

Route `gpt-5.4` to well-specified implementation work where its distinguishing headroom — a 1.05M
context, strict repo-pattern adherence, and steady agentic execution — is the deciding factor:
multi-file mechanical changes with an explicit shape, big-working-set edits, and long tool-heavy
trajectories with a named acceptance. It sits above the light tiers (`gpt-5.4-mini`,
`gpt-5.3-codex-spark`) and a step below `gpt-5.5` / `gpt-5.6-sol` in reasoning ceiling, so prefer
those for genuinely hard multi-step reasoning and reach for gpt-5.4 when the work is substantial but
the path is explicit. Dispatch it at an explicit effort band (its upstream default is its lowest).
Judgment-heavy, under-specified, or intelligence-bound work stays on the Claude tiers per
`hand_tuned`; cell-review cohorts (graded config-hash cohorts, hard metrics non-degrading against a
trailing baseline) grade fit out-of-band and re-tune this range.
