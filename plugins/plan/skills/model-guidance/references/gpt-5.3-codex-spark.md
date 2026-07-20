# Research cache — `gpt-5.3-codex-spark`

<!--
provenance:
  model_id: gpt-5.3-codex-spark  # host-roster capability token, NOT an embedded subagents.yaml axis value
  resolves_to: openai-codex/gpt-5.3-codex-spark  # Pi-hosted launch id; the capability remains its basename
  researched: 2026-07-09
  status: researched             # provenance state: this cache reflects a real capability-review pass
  method: model-capability review (OpenAI Codex gpt-5.3-codex-spark model docs) + in-repo planning-session live probe of the Pi wrapped-cell path + committed selection-sidecar cohort review
  sources:
    - OpenAI Codex gpt-5.3-codex-spark model card / capability docs: a fast, lightweight coding tier tuned for quick, tightly-scoped edits with a lower reasoning ceiling than the heavier codex tiers
    - keeper wrapped-cell architecture (ADR 0010): gpt-5.3-codex-spark is a host-roster capability model Claude does not serve natively; a Claude wrapper delegates implementation to the Pi provider and re-owns tests/commit
    - planning-session live probe: Pi's host-matrix entry launches `openai-codex/gpt-5.3-codex-spark`; the capability token remains the basename
    - committed selection-sidecar cohort evidence: successful fixed-shape multi-file Spark completion, with no evidence for open-ended diagnosis, contract/security design, or subtle contract/security reasoning
-->

This file is the raw research backing the distilled `models.gpt-5.3-codex-spark` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.3-codex-spark.sha256` to this
file's bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.3-codex-spark` capability id is re-pointed to a newer model
version, or when out-of-band cell-review cohort evidence materially re-grades its routing fit.

## What `gpt-5.3-codex-spark` is

`gpt-5.3-codex-spark` is a **wrapped cell** capability: keeper does not serve it natively, so a Claude
wrapper delegates implementation to the model's serving provider (the `pi` harness in the host
matrix) and re-owns the keeper close-out (tests, soft-reset of foreign commits, the single sanitized
trailer commit). It is a fast, lightweight coding tier tuned for quick, tightly-scoped edits — the
low end of the codex model family, built for snappy turnaround on small, well-bounded work rather
than deep multi-step reasoning. On the plan board it routes per the binding `hand_tuned` GPT-first
policy, and its capability ceiling keeps its lane narrow — small, fully-specified mechanical work —
with committed selection sidecars as the measurement source for cell-review cohorts that grade fit
and re-tune this guidance as evidence accumulates.

A dispatch note the launch path (not this capability research) owns: the Pi provider's host-matrix
entry uses the provider-qualified `openai-codex/gpt-5.3-codex-spark` launch id; the derived
`gpt-5.3-codex-spark` capability token remains the model-selection axis.

## Strengths (worker-relevant)

- **Snappy fixed-shape changes.** Fast turnaround on tightly-scoped edits confined to one surface or
  a few explicitly named files, where the acceptance leaves no design choice.
- **Straight test additions.** Reliable at adding a mechanical test against an already-named
  assertion shape.
- **Mechanical refactors.** Handles a templated, pattern-following refactor with an explicit
  before/after shape.
- **Literal execution of an unambiguous spec.** Follows a fully-specified acceptance precisely when
  the task leaves no interpretation to make.

## Weaknesses / failure modes (worker-relevant)

- **Lower reasoning ceiling.** A lighter tier than the heavier Pi-hosted and Claude models — multi-file
  design and cross-module reasoning under-resolve here rather than being reliably worked through.
- **Ambiguous acceptance under-resolves.** An under-specified or interpretation-requiring acceptance
  is a poor fit; it needs the choice pre-made, not discovered.
- **Shorter effective context across a long agentic loop.** Holds less context than the heavier
  tiers over an extended multi-step task, so a long investigation-then-implement loop degrades faster
  here.
- **Contract-shaped blast radius.** Higher risk when the task must design a contract, schema, or wire
  shape, or reason through a subtle contract/security invariant where a wrong abstraction propagates
  past the task. This is distinct from small fixed-shape mechanical implementation or deterministic
  verification of an already-specified contract/schema/wire invariant, which stays eligible when the
  acceptance leaves no design choice.

## When to pick

Route `gpt-5.3-codex-spark` **only** to small, reversible, fixed-shape work with a fully-specified
acceptance — single-file edits, straight test additions, mechanical refactors with an explicit
before/after shape and a named surface, small fixed-shape mechanical implementation/verification of
an already-specified contract, schema, wire, or correctness invariant, or a small multi-file edit
where every file is explicitly named and the verification is deterministic. The committed cohort
evidence supports that fixed-shape multi-file edge; it does not support open-ended diagnosis,
contract/security design, ambiguous judgment, subtle contract/security reasoning, or long
trajectories. Widen its range only when committed selection-sidecar cohorts (graded config-hash
cohorts, hard metrics non-degrading against a trailing baseline) show it right-sized for a task class,
never by default.
