## Overview

The /plan:model-guidance skill goes matrix-aware and gains cached vendor model cards. Its `--state`
scope derives from `matrix.yaml`'s `subagent_models` (a model newly added to the host matrix surfaces
as a fillable gap with an adaptive "Fill new values" flow), and every axis model carries the vendor's
card as converted markdown under `references/cards/<model>.md` — provenance-headed, sha256-pinned in
the `research:` map, and REQUIRED for a model to classify `fresh`. The contract is docs/adr/0037
(committed at plan time); the drift gate stays fully offline. Builds on fn-1237 (matrix v2 single host
config), whose task 4 lands the minimal `--check` integrity-only re-scope + `--state` axes-source swap
this epic extends.

## Quick commands

- `bun plugins/plan/scripts/model-guidance-check.ts --check` — offline: structure + notes AND card hash parity
- `bun plugins/plan/scripts/model-guidance-check.ts --state | jq '.models'` — card_present / card_hash_parity / reasons per model
- `bun test plugins/plan/test/consistency-model-selector.test.ts` — pure-core lattice + disk-mode all-fresh pin

## Acceptance

- [ ] A model newly added to the host matrix's subagent_models classifies `missing` in --state and the skill's interactive flow offers to fill it, labeling the gap row "Fill new values — N: <names>" when every gap is never-researched
- [ ] Every current-axis model (opus, sonnet, gpt-5.3-codex-spark) has a committed provenance-headed card under references/cards/ whose sha256 is pinned in the research map, and the committed tree classifies all-fresh including card parity
- [ ] A model without a card cannot classify fresh: card-absent reads missing with reasons [no-card], card-drift reads stale, never-researched stays stub — and the classifier remains total (no throw path)
- [ ] --check runs green offline with no host matrix present, hashing every declared card, never parsing card headers
- [ ] SKILL.md, the config comments, CONTEXT.md, and the plan CLAUDE.md drift-gate row describe exactly the landed v2 semantics (field names byte-aligned with the envelope)

## Early proof point

Task that proves the approach: ordinal 1 (backfilling real vendor cards proves the external dependency —
the cards are fetchable and convertible at all). If it fails: re-scope the card contract from
fetched-vendor-doc to skill-authored capability digest per model, and amend ADR 0037 before the lattice
task starts.

## References

- docs/adr/0037-model-cards-pinned-as-served-markdown.md — the card contract this epic implements
- docs/adr/0036-required-host-matrix-v2-with-launch-id-entries.md — the axis-source decision (fn-1237)
- Vendor card reality (practice-scout, verified): Anthropic system-card index at anthropic.com/system-cards is durable while its PDF paths are content-addressed and volatile; OpenAI publishes openai.com/index/<model>-system-card/ landings whose content mutates in place, with codex models shipped as ADDENDA (gpt-5-3-codex-system-card); arXiv mirrors are the most stable anchors; cards are PDF-first — conversion must treat PDF extraction as the primary path
- Only two code consumers of the research map / --state envelope exist (the check script and its test; SKILL.md reads via jq) — the blast radius is deliberately small
- fn-1237 task 4 is the seam this epic threads onto: verify its landed --check/--state shape before coding the lattice

## Docs gaps

- **plugins/plan/skills/model-guidance/SKILL.md**: the primary rewire — triggers, envelope docs, card-fetch step, adaptive fill label, card-only-gap shortcut
- **plugins/plan/model-selector.yaml**: header comment repoints axis source to matrix.yaml subagent_models; research-map comment documents the card sub-mapping
- **CONTEXT.md**: add "Model card" (disambiguated from the research notes `reference`)
- **plugins/plan/CLAUDE.md**: drift-gate Running-Things row gains card-parity wording (read fn-1237.6's landed wording first — don't double-edit)

## Best practices

- **Pin the served artifact, not upstream bytes:** the hash answers "is this cache the reviewed one"; upstream drift is a human re-research trigger, never CI [lockfile / frozen-install model]
- **Two-URL provenance:** record the durable discovery URL and the resolved artifact URL per fetch — vendor CDN paths are content-addressed and rot [practice-scout, verified]
- **Keep fetched content out of the gate parser:** presence + hash only; card headers are human-facing [attacker-influenceable content discipline]
- **Markdown only in tree** — 200+ page vendor PDFs bloat git history; retain the vendor copyright notice in the cached body (internal-use cache, tolerated risk)
- **Never auto-fix hashes in CI** — re-pin only on deliberate re-research [yarn --update-checksums model]
