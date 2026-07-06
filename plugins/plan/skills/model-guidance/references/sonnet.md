# Research cache — `sonnet`

<!--
provenance:
  model_id: sonnet            # subagents.yaml models: axis value
  resolves_to: claude-sonnet-5   # current Sonnet-tier alias at research time
  researched: 2026-07-06
  status: researched             # provenance state: this cache reflects a real research pass
  method: model-capability review (Anthropic model docs + Sonnet 5 migration guide via the claude-api skill) + in-repo worker dispatch history
  sources:
    - Anthropic model catalog / migration guide (Claude Sonnet 5): near-Opus coding+agentic quality, full low..max effort axis incl. xhigh, adaptive thinking on by default, literal instruction following, $3/$15 per MTok vs Opus 4.8 $5/$25, 1M context / 128K output
    - keeper worker dispatch history: nine sonnet×medium plan tasks (bounded refactors, targeted tests, doc/consolidation work) all completed same-day with worker_done_at stamped — routing bounded work down to sonnet holds in practice
-->

This file is the raw research backing the distilled `models.sonnet` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.sonnet.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `sonnet` alias is re-pointed to a newer model, or when the
`models:` axis in `subagents.yaml` changes.

## What `sonnet` is

`sonnet` is keeper's balanced Claude worker-model axis value, resolving to Claude Sonnet 5
(`claude-sonnet-5` at research time): 1M-token context, 128K max output, adaptive thinking on by
default, and — first for a Sonnet-tier model — the full `low | medium | high | xhigh | max` effort
axis, so every keeper effort cell renders on it. It reaches what was previously Opus-tier quality
on many coding and agentic tasks at ~60% of Opus 4.8's per-token price and lower latency. In this
selector, `sonnet` is the deliberate routing-down option: it wins when the task is bounded and
well-specified, not merely because it is short.

## Strengths (worker-relevant)

- **Near-Opus quality on bounded coding work.** The largest generational gains are exactly in
  coding and agentic execution — routine implementation, template-following, mechanical refactors,
  targeted tests, and fixes with a named surface perform at or near Opus level.
- **Cost/latency efficiency.** Sonnet-tier pricing at roughly 60% of Opus per token, with faster
  turnaround — the right trade for work where deeper reasoning would not change the outcome.
- **Literal, precise instruction following.** Follows a tightly-scoped spec exactly and does not
  silently generalize; strong fit for plan tasks with concrete observable acceptance.
- **More agentic by default.** Reaches for tools and runs self-verification loops readily; gives
  good in-progress updates without scaffolding.
- **In-repo evidence.** Every sonnet-routed plan task dispatched so far (all at `medium` effort:
  bounded refactors, straight test additions, doc/consolidation work) completed its worker turn.

## Weaknesses / failure modes (worker-relevant)

- **Less margin on ambiguous design.** More likely than Opus to pick a locally-correct fix that
  conflicts with a wider contract, or to miss a subtle abstraction boundary on open-ended work.
- **Literalism cuts both ways.** An under-specified task fails harder here — Sonnet will not infer
  the unstated intent Opus often recovers. Route ambiguity up, don't prompt around it.
- **Strict effort adherence at the low end.** At `low`/`medium` it scopes work to exactly what was
  asked; a task that hides multi-step or cross-module reasoning under-thinks rather than escalating.
- **Avoid for the highest-blast-radius work.** Migrations, wire formats, event-sourcing invariants,
  cross-repo changes, and gnarly no-hypothesis debugging keep more margin on Opus.

## When to pick (against Opus)

Pick `sonnet` for bounded, well-specified, low-blast-radius work: single-file or small multi-file
edits with concrete acceptance, obvious tests, mechanical refactors, applying an existing in-repo
pattern. Keep `opus` for contract-touching work, new patterns, cross-module architecture,
ambiguous or under-specified specs, and any task where a wrong routing-down likely fails the worker
turn. When uncertain, route up to `opus` — a wrong routing-up costs tokens; a wrong routing-down
costs a failed task.
