# Research cache — `opus`

<!--
provenance:
  model_id: opus            # subagents.yaml models: axis value
  resolves_to: claude-opus-4-8   # strongest Opus-tier alias at research time
  researched: 2026-07-04
  method: model-capability review (Anthropic model docs via the claude-api skill) + in-repo worker experience
  sources:
    - Anthropic model catalog / migration guidance (Claude Opus 4.8): most-capable Opus-tier, adaptive-thinking-only surface, effort axis low..max
    - keeper worker experience: the plan worker template runs opus at every effort cell; observed behavior on multi-file, contract-touching tasks
-->

This file is the raw research backing the distilled `models.opus` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.opus.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `opus` alias is re-pointed to a newer model version, or when the
`models:` axis in `subagents.yaml` changes.

## What `opus` is

`opus` is keeper's single worker-model axis value today. It resolves to the strongest widely
released Opus-tier Claude model (`claude-opus-4-8` at research time): a 1M-token context window,
adaptive thinking, and the `low | medium | high | xhigh | max` effort axis that keeper's per-cell
worker renders bake in. It is the highest-capability model keeper routinely dispatches, so on the
current axis "pick the model" is not a real choice — every task runs on `opus` and the selector's
leverage is entirely on the effort axis. A second model on the axis (a cheaper/faster tier for
mechanical work, or an A/B candidate) is what turns model selection into a live decision.

## Strengths (worker-relevant)

- **Long-horizon autonomous execution.** State-of-the-art at multi-step, multi-file work that runs
  unattended to completion — exactly the shape of a plan task worker that must implement, test,
  commit, and stamp without a human re-steering it mid-turn.
- **Contract-shaped reasoning.** Strong on work where a wrong abstraction propagates — RPC/schema/
  wire-format/public-API changes, new-pattern introduction, cross-module refactors. This is the
  capability that makes it the safe default for `xhigh`-tier tasks.
- **Bug-finding and debugging.** Higher recall and precision than the prior generation; correctly
  distinguishes an intermittent flake from a real failure rather than declaring "fixed" after one
  clean run — the behavior the `max` effort band is reserved for.
- **Instruction adherence.** Follows a spec literally and does not silently generalize an
  instruction from one item to another — good for the tightly-scoped acceptance criteria a plan
  task carries.

## Weaknesses / failure modes (worker-relevant)

- **Under-reaches for expensive capabilities by default.** Conservative about spawning subagents,
  writing file-based memory, reaching for search, or invoking custom tools unless the prompt makes
  the trigger explicit. A worker prompt that wants these must name *when* to use them, not just that
  they exist.
- **Narration and deliberation drift.** Narrates more between steps than the prior generation and is
  more likely to pause and ask on minor choices; at high effort on routine work it can gather more
  context and deliberate beyond what the task needs. The counter is an explicit silence/act default
  in the prompt and dropping the effort band for mechanical work.
- **Overthinking at `max`.** The ceiling effort is prone to diminishing returns and overthinking on
  tasks that do not genuinely need it — reserve it, do not reach for it casually.

## When to pick (against a future second model)

Pick `opus` as the default for anything intelligence-sensitive: contract-touching work, new-pattern
introduction, gnarly debugging, or any task where a wrong call is expensive to unwind. Only route a
task away from `opus` to a cheaper/faster model when the work is genuinely mechanical (single-file,
"do exactly this") AND that model exists on the axis AND you are deliberately trading capability for
cost/latency. When uncertain, keep `opus` — it is the highest-capability tier and the cost of a
wrong routing-down is a failed task, not a slow one.
