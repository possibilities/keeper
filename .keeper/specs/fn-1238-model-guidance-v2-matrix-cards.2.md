## Description

**Size:** M
**Files:** plugins/plan/scripts/model-guidance-check.ts, plugins/plan/test/consistency-model-selector.test.ts

### Approach

Thread the card contract through the check script on top of fn-1237's landed seam — FIRST verify what
task fn-1237.4 actually landed (--check may already be integrity-only and --state may already read
matrix.yaml subagent_models; function shapes like coverageErrors/unionEfforts may be gone) and build on
that form. Coercion: ResearchEntry gains an OPTIONAL nested `card: {reference, sha256}` — absent key means
no card; a present-but-partial or malformed card mapping fails coercion loudly naming the model (same
loudness as the notes fields: a declared-but-broken pin never passes silently); a card.reference equal to
the notes reference is rejected loudly (copy-paste guard). --check: extend the hash-parity loop to every
DECLARED card, mirroring the notes loop's tolerance (research entries for non-axis models still hash;
block-only extras are never forced to carry cards); the gate NEVER parses card headers — presence + hash
only, fetched vendor content stays out of the gate parser. --state lattice in classifyModel, precedence
pinned and total: structural absence (no block / no research entry / no notes file) → missing; notes
provenance not researched → stub (card irrelevant); notes researched + notes-hash drift → stale; notes
researched + parity + card absent (undeclared OR declared-but-file-missing) → missing (backfill class);
notes researched + parity + card present + card-hash drift → stale; both parities + presence → fresh.
Envelope: ModelStateEntry gains `card_present: boolean`, `card_hash_parity: boolean | null`, and
`reasons: string[]` drawn exactly from [no-block, no-research-entry, no-notes-file, notes-not-researched,
notes-hash-drift, no-card, card-hash-drift] — empty exactly when fresh, listing every contributing cause
otherwise. These field names are the stable jq contract the skill-docs task quotes byte-aligned. The
classifier stays throw-free; card paths resolve through the existing referenceText/referenceHash resolvers
(no new resolver field). The efforts axis stays card-free.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves —
and fn-1237.4 lands between planning and this task: re-locate these anchors in the landed file first.*

**Required** (read before coding):
- plugins/plan/scripts/model-guidance-check.ts:128-155 — coercion site for the card sub-mapping
- plugins/plan/scripts/model-guidance-check.ts:246-267 — the --check research-parity loop to extend (note its extra-tolerance comments)
- plugins/plan/scripts/model-guidance-check.ts:322-340, 412-439 — ModelStateEntry envelope + the classifyModel lattice to extend
- plugins/plan/scripts/model-guidance-check.ts:342-353, 466-493 — GuidanceStateInput resolvers (cards ride these) + the FromDisk wrappers fn-1237.4 re-sourced
- plugins/plan/test/consistency-model-selector.test.ts:147-159, 411-465 — the disk-mode fresh pin to tighten card-inclusively, and the hand-built pure-core input builders (baseStateInput/refWith) the new lattice cases follow

**Optional** (reference as needed):
- docs/adr/0037-model-cards-pinned-as-served-markdown.md — precedence + parse-vs-hash rationale
- plugins/plan/test/saga-selection-brief.test.ts:184-189 — the KEEPER_CONFIG_DIR fixture-pin pattern (fn-1237.4 applies it to this test's disk block)

### Risks

- fn-1237.4 seam drift — the anchors above describe the pre-swap file; thread onto whatever landed, keeping the pure-core + FromDisk split intact
- Reason-enum churn — the skill-docs task quotes these names verbatim; changing them after this task lands means re-touching SKILL.md

### Test notes

Pure-core cases (hand-built inputs, independent hashes) covering every precedence row, the partial-card
loud coercion, and the copy-paste guard; disk-mode block asserts the committed tree all-fresh INCLUDING
card parity under the pinned config-dir fixture. The classifier must classify every fixture without
throwing.

## Acceptance

- [ ] A research entry with no card key loads; a partial/malformed card mapping or a card path equal to the notes path fails coercion loudly naming the model
- [ ] --check hashes every declared card, failing on a missing file or mismatch, and runs green offline on a host with no matrix; it never reads card header content
- [ ] --state classifies per the pinned precedence: notes-fresh-card-absent reads missing with reasons [no-card]; card-drift reads stale with reasons [card-hash-drift]; never-researched stays stub regardless of card; fresh requires notes parity, card presence, and card parity
- [ ] Every model entry in the --state envelope carries card_present, card_hash_parity, and reasons — reasons empty exactly when fresh — and no fixture input makes the classifier throw
- [ ] The disk-mode test pins the committed tree all-fresh including card parity under the pinned config-dir fixture

## Done summary
Threaded the model-card contract through model-guidance-check: optional research.<model>.card coercion (loud on partial/malformed/copy-paste), --check hashes every declared card presence+hash only, and the --state lattice requires a present hash-matching card for fresh, emitting card_present/card_hash_parity/reasons per model.
## Evidence
