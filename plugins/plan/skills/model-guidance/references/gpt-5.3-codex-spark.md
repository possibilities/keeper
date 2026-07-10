# Research cache — `gpt-5.3-codex-spark`

<!--
provenance:
  model_id: gpt-5.3-codex-spark  # host-roster capability model (matrix.yaml alias target), NOT an embedded subagents.yaml axis value
  resolves_to: gpt-5.3-codex-spark  # bare capability id served through the codex harness; codex accepts the bare id directly, no alias target needed
  researched: 2026-07-09
  status: researched             # provenance state: this cache reflects a real capability-review pass
  method: model-capability review (OpenAI Codex gpt-5.3-codex-spark model docs) + in-repo planning-session live probe of the codex wrapped-cell path
  sources:
    - OpenAI Codex gpt-5.3-codex-spark model card / capability docs: a fast, lightweight coding tier tuned for quick, tightly-scoped edits with a lower reasoning ceiling than the heavier codex tiers
    - keeper wrapped-cell architecture (ADR 0010): gpt-5.3-codex-spark is a host-roster capability model claude does not serve natively; a claude wrapper delegates implementation to the codex provider and re-owns tests/commit
    - planning-session live probe: the codex provider's host matrix entry runs the bare `gpt-5.3-codex-spark` capability id directly at startup — unlike pi's provider-qualified slashed-id requirement, codex needs no matrix alias target for this model
-->

This file is the raw research backing the distilled `models.gpt-5.3-codex-spark` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.3-codex-spark.sha256` to this
file's bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.3-codex-spark` capability id is re-pointed to a newer model
version, or when out-of-band cell-review cohort evidence materially re-grades its routing fit.

## What `gpt-5.3-codex-spark` is

`gpt-5.3-codex-spark` is a **wrapped cell** capability: keeper does not serve it natively, so a claude
wrapper delegates implementation to the model's serving provider (the `codex` harness in the host
matrix) and re-owns the keeper close-out (tests, soft-reset of foreign commits, the single sanitized
trailer commit). It is a fast, lightweight coding tier tuned for quick, tightly-scoped edits — the
low end of the codex model family, built for snappy turnaround on small, well-bounded work rather
than deep multi-step reasoning. On the plan board it routes per the binding `hand_tuned` GPT-first
policy, and its capability ceiling keeps its lane narrow — small, fully-specified mechanical work —
with out-of-band cell-review cohorts grading fit and re-tuning this guidance as evidence
accumulates.

A dispatch note the launch path (not this capability research) owns: the codex provider's host matrix
entry accepts the bare `gpt-5.3-codex-spark` capability id directly, so this model needs no
provider-qualified slashed alias target in the host matrix — unlike `pi`-served models, which reject a
bare id at startup.

## Strengths (worker-relevant)

- **Snappy single-file changes.** Fast turnaround on a tightly-scoped edit confined to one surface,
  where the acceptance leaves no design choice.
- **Straight test additions.** Reliable at adding a mechanical test against an already-named
  assertion shape.
- **Mechanical refactors.** Handles a templated, pattern-following refactor with an explicit
  before/after shape.
- **Literal execution of an unambiguous spec.** Follows a fully-specified acceptance precisely when
  the task leaves no interpretation to make.

## Weaknesses / failure modes (worker-relevant)

- **Lower reasoning ceiling.** A lighter tier than the heavier codex and claude models — multi-file
  design and cross-module reasoning under-resolve here rather than being reliably worked through.
- **Ambiguous acceptance under-resolves.** An under-specified or interpretation-requiring acceptance
  is a poor fit; it needs the choice pre-made, not discovered.
- **Shorter effective context across a long agentic loop.** Holds less context than the heavier
  tiers over an extended multi-step task, so a long investigation-then-implement loop degrades faster
  here.
- **Contract-shaped blast radius.** Higher risk on contract-, schema-, or wire-shaped changes where a
  wrong abstraction propagates past the task — exactly the class the routing policy keeps it away
  from.

## When to pick

Route `gpt-5.3-codex-spark` **only** to small, reversible, near-mechanical work with a fully-specified
acceptance — single-file edits, straight test additions, mechanical refactors with an explicit
before/after shape and a named surface. Widen its range only as out-of-band cell-review cohorts
(graded config-hash cohorts, hard metrics non-degrading against a trailing baseline) show it
right-sized for a task class, never by default. Keep it off anything needing investigation,
contract-shaped reasoning, or judgment spanning more than one surface — route those up to a
higher-capability model. This is advisory selection posture only — the selector has no
gpt-5.3-codex-spark gating mechanism, so the posture lives in guidance prose, not a code path.
