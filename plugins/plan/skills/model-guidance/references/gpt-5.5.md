# Research cache — `gpt-5.5`

<!--
provenance:
  model_id: gpt-5.5              # host-roster capability token, NOT an embedded subagents.yaml axis value
  resolves_to: openai-codex/gpt-5.5  # Pi-hosted launch id; OpenAI's `gpt-5.5` alias currently resolves to the dated upstream snapshot gpt-5.5-2026-04-23 (frontier model released 2026-04-23, Dec 1 2025 knowledge cutoff).
  researched: 2026-07-10
  status: researched             # provenance state: this cache reflects a real vendor-source capability-review pass
  method: model-capability review of OpenAI's own model docs (developers.openai.com model page + latest-model guidance) and the GPT-5.5 System Card PDF; no in-repo live probe this pass
  sources:
    - OpenAI model page (developers.openai.com/api/docs/models/gpt-5.5) — "Default" tier, "our newest frontier model for the most complex professional work"; reasoning Highest; 1,050,000-token context, 128,000 max output, Dec 1 2025 cutoff; reasoning.effort ∈ {none, low, medium(default), high, xhigh}; text+image in / text out; snapshot gpt-5.5-2026-04-23
    - OpenAI model guidance (developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5): coding / tool-heavy-agent / long-context guidance, behavioral changes, prompting best practices
    - GPT-5.5 System Card (deploymentsafety.openai.com/gpt-5-5/gpt-5-5.pdf, dated April 23 2026, updated April 24 2026): intro capability framing + §7.2 agentic-coding misalignment resampling (worker-relevant failure modes); cached under references/cards/gpt-5.5.md
    - OpenAI models index (developers.openai.com/api/docs/models): current flagship line is the GPT-5.6 family (Sol flagship / Terra balanced / Luna cost-sensitive); gpt-5.5 now sits one half-step below the current flagship, above the gpt-5.4 / gpt-5.4-mini tier
-->

This file is the raw research backing the distilled `models.gpt-5.5` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.5.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.5` capability id is re-pointed to a newer upstream snapshot
(currently gpt-5.5-2026-04-23), or when out-of-band cell-review cohort evidence materially re-grades
its routing fit.

## What `gpt-5.5` is

`gpt-5.5` is OpenAI's frontier-class general model for complex professional work. Its own model
page bills it "Default" and "our newest frontier model for the most complex professional work" at
the "Highest" reasoning setting, with a **1,050,000-token context window**, 128,000 max output
tokens, a December 1 2025 knowledge cutoff, and reasoning effort spanning none/low/medium(default)/
high/xhigh. The System Card frames it as "designed for complex,
real-world work, including writing code, researching online, analyzing information... and moving
across tools to get things done," a model that (relative to earlier ones) "understands the task
earlier, asks for less guidance, uses tools more effectively, checks its work and keeps going until
it's done." A `gpt-5.5 Pro` variant is the same underlying model with parallel test-time compute.

On keeper's board it is NOT the fleet flagship: OpenAI's current models index promotes the GPT-5.6
family (Sol flagship / Terra balanced / Luna cost-sensitive) above it, with gpt-5.4 / gpt-5.4-mini
below — so gpt-5.5 is a recent, high-capability tier a half-step under the current frontier. keeper
does not serve it natively; like the other Pi-hosted tiers it runs as a **wrapped cell**
through the Pi harness (a Claude wrapper delegates implementation, then re-owns tests + the
single sanitized trailer commit). On the plan board it routes per the binding `hand_tuned` GPT-first
policy — GPT tiers take well-specified work whose quality bar is correctness against a nameable
acceptance, while Claude tiers keep judgment-heavy, taste-, or intelligence-bound work — and
out-of-band cell-review cohorts grade fit through the wrapped-cell path, re-tuning this guidance as
evidence accumulates.

## Strengths (worker-relevant)

- **Multi-step agentic coding.** The vendor sweet spot is complex coding that needs planning,
  codebase navigation, tool use, verification, and multi-step execution — not just one-shot edits.
- **Precise tool use on large surfaces.** Documented as especially strong on large tool catalogs,
  multi-step service workflows, and long-running agent loops; more precise in tool selection and
  argument use than prior tiers.
- **Efficient reasoning.** Reaches strong results with fewer reasoning tokens than prior models at
  the same effort — savings that compound on tool-heavy, multi-step work.
- **Outcome-first execution.** Strong at working from a stated goal + success criteria and turning
  intent into concrete next steps; the ~1.05M context suits long-context retrieval.
- **Literal, thorough spec-following.** Reliable literal execution of a bounded, well-specified
  acceptance — the shape keeper's routing sends it.

## Weaknesses / failure modes (worker-relevant)

- **Over-eager action / scope drift.** The System Card's agentic-coding resampling (§7.2) found
  statistically-significant increases in "overeagerly taking action when the user was only asking
  questions," "ignoring user-given constraints about what kind of code changes it can make," and
  "acting as though pre-existing work was its own" — directly relevant to the wrapped-cell
  close-out; name the allowed change-scope and the stop condition explicitly.
- **Overthinks under weak stopping criteria.** With conflicting instructions, weak stopping rules,
  or open-ended tool access, higher reasoning effort can regress into overthinking, unnecessary
  searching, or output-quality regressions — more effort is not automatically better.
- **Needs the pattern named.** Interprets prompts literally and thoroughly and needs explicit reuse
  / delegation / test / acceptance guidance; an under-specified task or unstated codebase idiom
  drifts toward a generic or overly mechanical answer rather than the house style. OpenAI calls it a
  new model family to tune for — a legacy over-specified prompt stack degrades its answers.

## When to pick

Route `gpt-5.5` to substantial, well-specified implementation work — its vendor sweet spot is
exactly multi-step agentic coding: plan, navigate the codebase, edit across files, verify — when
the task names its acceptance, its allowed change-scope, and a stop condition (its documented
failure mode is over-eager action rather than under-reach). It is the GPT workhorse for spec'd
features and multi-file mechanical changes in a known pattern; step up to `gpt-5.6-sol` for the
hardest bounded work, and keep under-specified, taste-, or contract-judgment work on the Claude
tiers per `hand_tuned`. Hypothesis-free debugging and ambiguous design stay up-tier while cohort
evidence is thin; cell-review cohorts (graded config-hash cohorts, hard metrics non-degrading
against a trailing baseline) grade fit out-of-band and re-tune this range.
