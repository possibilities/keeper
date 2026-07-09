# Research cache — `gpt-5.5`

<!--
provenance:
  model_id: gpt-5.5              # host-roster capability model (matrix.yaml alias target), NOT an embedded subagents.yaml axis value
  resolves_to: gpt-5.5          # capability id served through the pi harness; the launch path uses the provider-qualified slashed native id
  researched: 2026-07-09
  status: researched             # provenance state: this cache reflects a real capability-review pass
  method: model-capability review (OpenAI GPT-5.5 model docs) + in-repo planning-session live probe of the pi wrapped-cell path
  sources:
    - OpenAI GPT-5.5 model card / capability docs: coding+agentic generalist, strong multi-step reasoning, broad language and framework breadth, explicit reasoning-effort control
    - keeper wrapped-cell architecture (ADR 0010): gpt-5.5 is a host-roster capability model claude does not serve natively; a claude wrapper delegates implementation to the pi provider and re-owns tests/commit
    - planning-session live probe: pi rejects the bare `gpt-5.5` capability id at startup (no transcript) and runs only with the provider-qualified slashed native id — the alias-target charset relaxation is evidence-forced, not speculative
-->

This file is the raw research backing the distilled `models.gpt-5.5` guidance block in
`plugins/plan/model-selector.yaml`. It is the review point: the config carries the short,
prompt-sized distillation; the depth and citations live here. The drift gate
(`model-guidance-check.ts --check`) pins the config's `research.gpt-5.5.sha256` to this file's
bytes, so an edit here without re-distilling + re-hashing fails the fast suite.

Re-run this research when the `gpt-5.5` capability id is re-pointed to a newer model version, or
when out-of-band cell-review cohorts justify widening its trickle-posture routing range.

## What `gpt-5.5` is

`gpt-5.5` is the first non-claude worker capability the plan selector routes to. keeper does not
serve it natively: it is a **wrapped cell** — a claude wrapper delegates the implementation to the
model's serving provider (the `pi` harness in the host matrix) and re-owns the keeper close-out
(tests, soft-reset of foreign commits, the single sanitized trailer commit). It is a capable
GPT-5.5-generation generalist coding model: strong multi-step reasoning, broad breadth across
languages and frameworks, and explicit reasoning-effort control. On the plan board it is introduced
under a deliberate **trickle posture** — routed only to genuinely-bounded mechanical work until
graded cell-review cohorts justify promotion — so "pick gpt-5.5" is not yet a broad default but a
narrow, evidence-gated routing choice.

A dispatch note the launch path (not this capability research) owns: `pi` rejects the bare `gpt-5.5`
capability id at startup and runs only when handed the provider-qualified slashed native id, so the
matrix alias target for this model is a slashed id, not the bare capability token.

## Strengths (worker-relevant)

- **From-scratch implementation against a clear spec.** Strong at building a bounded, well-specified
  surface from the ground up — the shape of a low/medium-band plan task with an explicit acceptance
  and a named surface.
- **Algorithmic and data-transformation work.** Good recall on self-contained algorithmic and
  data-shaping tasks where the acceptance is concrete and the blast radius is one surface.
- **Breadth and multi-step reasoning.** Wide language/framework coverage and sustained progress on a
  well-scoped agentic loop, so a mechanical multi-file edit in a known pattern holds together.
- **Literal execution of an unambiguous acceptance.** Follows a tightly-scoped spec precisely when
  the task leaves no design choice — a fit for straight test additions and mechanical refactors.

## Weaknesses / failure modes (worker-relevant)

- **Literalism on an under-specified spec.** Leans literal when the acceptance is ambiguous; it will
  not recover the unstated intent a top-tier model often infers, so under-specified work fails harder
  here — keep ambiguity on a higher tier rather than prompting around it.
- **Idiom drift.** Can drift from a codebase's established idioms and conventions unless the task
  names the in-repo pattern to follow; less reliable at matching house style unprompted than a model
  with deeper in-context adherence.
- **Weaker flake/real-failure discrimination.** Less sure than the top capability tier at telling an
  intermittent flake from a real failure in open-ended, hypothesis-free debugging.
- **Contract-shaped blast radius.** Higher risk on contract-, schema-, or wire-shaped changes where a
  wrong abstraction propagates past the task — exactly the class the trickle posture keeps it away
  from.

## When to pick (under the trickle posture)

Route `gpt-5.5` **only** to genuinely-bounded mechanical work — the low/medium band shapes:
single-surface edits, straight test additions, mechanical refactors with an explicit acceptance and
a named surface. Widen its range only as out-of-band cell-review cohorts (graded config-hash
cohorts, hard metrics non-degrading against a trailing baseline) show it right-sized for a task
class, never by default. Keep it off contract/schema/wire-shaped changes and hypothesis-free
debugging: those keep more margin on a higher-capability tier. This is advisory selection posture
only — the selector has no gpt-5.5 gating mechanism, so the posture lives in guidance prose, not a
code path.
