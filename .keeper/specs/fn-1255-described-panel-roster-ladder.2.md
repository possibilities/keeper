## Description

**Size:** M
**Files:** plugins/plan/panel-selector.yaml, plugins/plan/scripts/panel-guidance-check.ts, plugins/plan/test/consistency-panel-selector.test.ts

### Approach

Land the approved roster VERBATIM (embedded below) as `plugins/plan/panel-selector.yaml`,
and build its purely-structural gate mirroring the model-guidance-check house shape: a pure
core over already-parsed data returning `{ok, errors[]}` so the fast suite drives every
failure mode in-process, `--check` as the default verb, unknown args exit 2, an
`import.meta.main` guard, and NO host/matrix read (host-blind — cube membership is verified
at install time by `keeper agent providers check`, deliberately not in CI). Policy the gate
enforces on the committed file: top-level keys exactly {panels, default}; exactly 10 panels;
per-panel keys exactly {strength, members, description}; strength drawn from the closed enum
weak|light|standard|strong|max with at least one weak and one max panel; 2–3 members each,
every member shaped `<harness>::<model>::<effort>` with three non-empty segments, harness in
{claude, codex, pi}, effort in {high, xhigh, max} (full triple grammar and cube membership
stay with the loader and providers check); no duplicate members within a panel (a duplicated
member is a degenerate panel — distinct from the loader, where duplicates stay legal);
description length within 150–900 characters (near-uniformity guard against selection
length-bias); `default` present and naming a defined panel.

The committed roster (land byte-verbatim, including comments):

```yaml
# Panel roster + selection guidance — a WEAK->STRONG ladder of 10 panels.
#
# AUTHORED by the /panel-guidance skill and verified by its structural drift gate
# plus `keeper agent providers check` (cube membership). A panel is a named,
# ordered selection of launch triples (<harness>::<model>::<effort>) convened to
# answer one question in parallel — each leg blind to the others, a judge fusing
# them. The panel-choosing guidance matches a question's stakes to a rung by
# reading each panel's `strength` + `description` live via
# `keeper agent presets list --json`; panel NAMES are never hard-coded downstream.
#
# Weakness comes from MODEL TIER, not from dropping effort: every leg runs at
# high/xhigh/max so a light panel still thinks hard, it just thinks with a
# lighter model. claude's lightest configured tier is sonnet, so the weak rungs
# are GPT-only; claude participation starts at the light band. Cross-family
# diversity (claude vs the GPT tiers) is the strength lever on the upper rungs —
# two families disagreeing is the signal a panel exists to find.

default: workhorse

panels:
  featherweight:
    strength: weak
    members:
      - codex::gpt-5.3-codex-spark::high
      - pi::openai-codex/gpt-5.4-mini::high
    description: >-
      The floor — the two lightest GPT tiers across two harnesses, at high
      effort. A cheap, near-instant sanity duo: bring a trivial or low-stakes
      question where you mostly want a second pair of eyes on an obvious miss,
      not deep reasoning. Low ceiling by model tier, not by effort, and no
      claude leg — single-family agreement is weak evidence. Never bring hard,
      contract-shaped, or high-blast-radius work here; if one direct answer
      would do, skip the panel entirely.

  light-duo:
    strength: weak
    members:
      - codex::gpt-5.6-luna::high
      - pi::openai-codex/gpt-5.4::high
    description: >-
      Two newer-generation light GPT tiers across two harnesses, at high
      effort — a slightly higher floor than featherweight at similar speed.
      Best for mechanical, fully-specified cross-checks — "does this small
      change look right", straight test-shape or refactor review — where you
      want quick independent agreement without paying for a flagship. Still one
      model family and a low reasoning ceiling: route multi-file design,
      ambiguous acceptance, or anything security-shaped upward.

  light-trio:
    strength: light
    members:
      - claude::sonnet::high
      - codex::gpt-5.6-luna::high
      - pi::openai-codex/gpt-5.4-mini::high
    description: >-
      A claude workhorse anchor over two light GPT legs, all at high effort —
      breadth plus one trustworthy leg, and the cheapest rung with cross-family
      signal. Reach for it on a low-to-moderate question where catching a blind
      spot matters more than a high reasoning ceiling, or when a weak rung's
      GPT-only agreement isn't evidence enough. Not for hard reasoning: light
      legs agreeing on a hard question is weak evidence — step up to a standard
      rung.

  workhorse:
    strength: standard
    members:
      - claude::sonnet::high
      - codex::gpt-5.6-terra::high
    description: >-
      The calibrated everyday default — one Claude workhorse and one balanced GPT
      tier, cross-family at high effort. The right reach for an ordinary
      panel-worthy question: moderate stakes, some judgment, one clean round of
      independent cross-checking across two families. Where an ambiguous "is this
      even panel-worthy" lands; a redundant fan-out here is cheaper than an
      under-checked answer.

  workhorse-trio:
    strength: standard
    members:
      - claude::sonnet::xhigh
      - codex::gpt-5.6-terra::high
      - pi::openai-codex/gpt-5.4::high
    description: >-
      A three-leg everyday panel — the workhorse duo plus a third GPT leg on a
      distinct harness, Claude pushed to xhigh. Buys a tie-breaker and wider
      coverage over `workhorse` when a moderate question has several plausible
      answers and you want a majority signal, not just two-way agree/disagree.
      Standard cost, one slower leg. Step up to a strong rung when being wrong is
      expensive.

  claude-council:
    strength: strong
    members:
      - claude::opus::xhigh
      - claude::sonnet::xhigh
    description: >-
      An all-Claude council: opus and sonnet at xhigh, deliberately within one
      family. Use when the question turns on Claude-tuned strengths where the GPT
      family is a poor cross-checker — taste, user-facing wording, delicate
      in-repo idiom, design and API-surface judgment, creative or greenfield
      shaping. You trade cross-family diversity for two strong same-family
      reasoners that speak the house idiom, so their agreement is weaker evidence
      than a cross-family panel's (shared-family blind spot). For
      correctness/algorithmic questions prefer a cross-family rung.

  crossfamily:
    strength: strong
    members:
      - claude::sonnet::xhigh
      - codex::gpt-5.5::xhigh
    description: >-
      The strong balanced duo — a Claude workhorse and a frontier-class GPT tier,
      both at xhigh, maximum family diversity at two legs. Reach for it when the
      answer anchors above inline work and being confidently wrong is expensive,
      but the question is focused enough that two deep independent legs suffice.
      Best cost/strength ratio on the strong end; go to `deep-duo` or higher when
      you need flagship ceilings.

  deep-duo:
    strength: strong
    members:
      - claude::opus::xhigh
      - codex::gpt-5.6-sol::xhigh
    description: >-
      Two flagships, cross-family, at xhigh — opus and the top GPT tier. For
      genuinely hard questions: a subtle correctness or security invariant, a
      novel algorithm or design, a cross-cutting architectural call, an
      intermittent bug with competing root-cause hypotheses, long-horizon
      planning. Both legs can actually resolve the hard part; their independent
      agreement is high-confidence, their disagreement is exactly the signal you
      convened the panel to find. Expensive and as slow as its slowest flagship.

  triad:
    strength: strong
    members:
      - claude::opus::xhigh
      - codex::gpt-5.6-sol::xhigh
      - pi::openai-codex/gpt-5.5::xhigh
    description: >-
      The three-leg strong panel — opus plus two frontier GPT legs on distinct
      harnesses, two families across all three harnesses, at xhigh. Adds a
      decisive third vote and broader coverage over `deep-duo` for a hard question
      with real branch risk — adversarial design review, a schema/API/migration
      contract, a security boundary — where a two-way split would leave you stuck.
      The default choice when a hard question is also high-stakes but not
      irreversible.

  apex:
    strength: max
    members:
      - claude::opus::max
      - codex::gpt-5.6-sol::max
      - pi::openai-codex/gpt-5.5::max
    description: >-
      The ceiling — three flagships across two families and all three harnesses,
      every leg at max effort. The most cross-checking keeper can convene, and the
      most expensive and slowest. Reserve it for decisions where confidently-wrong
      is very expensive and hard to reverse: a security or data-integrity call, an
      irreversible migration or wire contract, an architecture choice a whole epic
      rides on. Overkill for anything a strong rung already covers — max effort has
      diminishing returns on routine work.
```

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/scripts/model-guidance-check.ts:653 — reportOrExit; :667-683 main/arg handling; the pure-core-over-loaded-data shape to mirror
- plugins/plan/test/consistency-model-selector.test.ts:59-65 — the in-process gate assertion pattern to copy

**Optional** (reference as needed):
- plugins/plan/model-selector.yaml — sibling committed-config formatting conventions

### Risks

- Do not import root src/ modules into the plan plugin's script — the gate performs its own
  local three-segment structural member check; the full triple grammar stays with the root
  loader.

### Test notes

The new consistency test asserts the gate is green on the committed roster in-process, and
drives each failure class (panel count, member bounds, band enum, effort set, missing
weak/max rung, duplicate member, description bounds, bad or missing default, unknown keys at
either level) through the pure core with hand-built inputs.

## Acceptance

- [ ] `plugins/plan/panel-selector.yaml` carries the ten described panels and `default: workhorse` byte-for-byte as specified, with no haiku member and every effort in {high, xhigh, max}.
- [ ] `bun plugins/plan/scripts/panel-guidance-check.ts --check` exits 0 on the committed roster, and the pure core rejects every enumerated policy-violation class.
- [ ] The plan suite is green including the new consistency test.

## Done summary

## Evidence
