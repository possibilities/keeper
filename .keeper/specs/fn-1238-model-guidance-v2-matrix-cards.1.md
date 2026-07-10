## Description

**Size:** S
**Files:** plugins/plan/skills/model-guidance/references/cards/opus.md (new), plugins/plan/skills/model-guidance/references/cards/sonnet.md (new), plugins/plan/skills/model-guidance/references/cards/gpt-5.3-codex-spark.md (new), plugins/plan/model-selector.yaml

### Approach

Fetch and cache the canonical vendor card for each current axis model as converted markdown, landing the
files AND their research-map declarations as INERT data: the current config coercion ignores unknown keys
on a research entry, so `card: {reference, sha256}` sub-mappings pass through silently until the lattice
task teaches the schema to read them — no gate or test goes red in between, which is the point of this
task running first. Discovery per vendor: Anthropic models (opus, sonnet) resolve through the durable
system-cards index (anthropic.com/system-cards) to the current CDN PDF; gpt-5.3-codex-spark's canonical
artifact is the gpt-5.3-codex system-card addendum (openai.com/index/... landing), falling back to the
parent-family card with the choice recorded in provenance. Convert via WebFetch extraction (PDF-first
reality — the landing HTML is a summary, not the card), trim boilerplate navigation, keep the body
size-bounded and retain the vendor's copyright notice. Each file opens with a first-comment provenance
header (the gate will never parse it — human/skill-facing): model_id, source_url (durable index/landing),
resolved_url (artifact actually fetched), fetched (date), content_type, converter, status: cached. Then
add the card sub-mapping under each research.<model> in model-selector.yaml with the file's real sha256
(Bash shasum -a 256). Cards are raw source cache — do NOT touch the models: guidance blocks or the notes
files. If a canonical card is genuinely unfetchable after the documented fallbacks, return
BLOCKED: SPEC_UNCLEAR naming exactly what was tried — never fabricate card content.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/model-selector.yaml:158-171 — the research: map shape the card sub-mappings join
- plugins/plan/scripts/model-guidance-check.ts:128-155 — coerceModelSelectorConfig: confirm unknown research-entry keys pass through (the inertness this task relies on)
- plugins/plan/skills/model-guidance/references/opus.md — the existing first-comment provenance-header style to mirror

**Optional** (reference as needed):
- docs/adr/0037-model-cards-pinned-as-served-markdown.md — the contract (two-URL provenance, markdown-only, copyright retention)

### Risks

- Vendor page shape drift — the index/landing URLs in the epic References are the discovery anchors, not gospel; record what actually resolved
- WebFetch PDF extraction quality varies — a readable, model-specific capability document is the bar, not a perfect conversion

### Test notes

Inertness proof: `bun plugins/plan/scripts/model-guidance-check.ts --check` green and `bun test` (plan
suite) green WITH the yaml entries present, before any schema change exists.

## Acceptance

- [ ] Three card files exist under references/cards/, each opening with a complete first-comment provenance header (model_id, source_url, resolved_url, fetched, content_type, converter, status) and retaining the vendor's copyright notice
- [ ] Each card body is substantive model-specific capability content (not an error page or bare summary stub)
- [ ] Each research.<model> entry in model-selector.yaml carries a card sub-mapping whose sha256 matches the on-disk file
- [ ] Only markdown was added — no PDF or binary artifacts anywhere in the tree
- [ ] The drift gate and the plan fast suite pass with the new entries present (inert-data proof)

## Done summary
Backfilled provenance-headed vendor system-card caches for opus, sonnet, and gpt-5.3-codex-spark under references/cards/, with sha256-pinned card sub-mappings in model-selector.yaml. Landed as inert data (--check and the plan fast suite pass unchanged) since the current coercion ignores unknown research-entry keys.
## Evidence
