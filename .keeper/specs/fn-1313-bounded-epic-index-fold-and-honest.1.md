## Description

**Size:** M
**Files:** src/reducer.ts, test/refold-equivalence.test.ts, test/reducer-lifecycle.test.ts

### Approach

Replace buildEpicIndex's per-fold full `epics` scan with a per-`Database`
WeakMap memo holding `{seeded, epicById, epicsByNumber}` maintained IN
PLACE: the first index read seeds it with exactly one full scan; after
that, every fold write that changes an index-relevant column (`epic_id`,
`epic_number`, `project_dir`, `status`) patches the affected entry inside
the same fold, and index reads return the memo. Invalidate-and-rebuild is
structurally wrong here — the epic fold writes its own row before reading
the index, so a drop-on-write goes cold every fold and bounds nothing.
The memo feeds the DETERMINISTIC `resolved_epic_deps` projection (sacred
re-fold class), so byte-identity to a fresh scan at every read is the
contract: patch by re-SELECTing the single mutated row and converting via
the same row→Epic helper the scan uses (guarantees NULL-coalescing
parity); keep each `epicsByNumber` bucket sorted by `epic_id` after every
mutation (an `epic_number` change removes from the old bucket and inserts
sorted into the new one); patch ONLY when the DB write actually landed —
a tombstone-suppressed shell insert patches nothing, a delete of a
nonexistent epic patches nothing, and a re-created epic (tombstone
cleared then upserted) is re-added. The patch path is total (never
throws) and reads no wall-clock/env/fs. Do not name any field
"Generation" (glossary term for tmux server boots) — a `seeded` boolean
suffices; no counter is needed. Export a `__resetEpicIndexMemoForTest`
and wire it into the refold harness wherever the epics projection is
wiped on a reused connection: unlike the two append-only watermark memos
(which survive rewinds), this memo mirrors a MUTABLE table and must reset
with the wipe. Follow the existing WeakMap-memo idiom; write new comments
forward-facing (no fn-id provenance).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:9490-9522 — buildEpicIndex, the scan to memoize; docstring already asserts re-fold byte-identity
- src/reducer.ts:735, :973 — the two index read sites (EpicSnapshot fold, EpicDeleted fold); note :694 upserts THIS epic's row before the :735 read
- src/reducer.ts:653-668 — insertEpicShellIfNotTombstoned choke point; call sites :884/:8334/:8462/:9428; the patch belongs on the actually-ran branch
- src/reducer.ts:954-967 — EpicDeleted DELETE + tombstone mint; :972 pre==null guard
- src/reducer.ts:9462-9480 — epicLiteToEpic, the row→Epic conversion the patch must reuse
- test/reducer-lifecycle.test.ts:2556-2643 — the warm-vs-cold memo test template (rewind + wipe + reset + re-drain + JSON byte equality)
- test/refold-equivalence.test.ts:837-858 — rewindAndWipeProjections (wipes epics on a reused connection; must gain the memo reset)

**Optional** (reference as needed):
- src/reducer.ts:1433-1478 — GitAttribMemo precedent (WeakMap + __reset...ForTest + warm); NOTE it is live-only/watermark — the shape to copy, not the lifecycle
- src/reducer.ts:11190-11313 — MonitorProvenanceMemo; its docstring's byte-identity argument is the genre to emulate

### Risks

- Any drift between patch and scan (bucket order, NULL coalescing, a missed writer site) silently diverges `resolved_epic_deps` on warm folds — caught only by the equivalence suites; treat every one of the ~7 index-relevant writer sites as in scope and prove each with an adversarial sequence
- A patch that throws inside the fold violates the never-throw invariant; the patch must be total

### Test notes

Extend the refold-equivalence charter suite with warm-vs-cold-vs-fresh-scan
cases over adversarial sequences: epic_number change (bucket move + re-sort),
tombstone-suppressed shell insert, delete of a nonexistent epic, re-create
after tombstone, and interleaved snapshot/delete churn. Reuse the
reducer-lifecycle warm-vs-cold template for the memo lifecycle itself.

## Acceptance

- [ ] A warm connection serves the epic-dep index from the in-process memo (no per-fold full scan); a cold connection's first read seeds it with exactly one full scan
- [ ] `epics.resolved_epic_deps` and `epic_dep_edges` bytes are identical across warm folds, a cold from-scratch re-fold, and the pre-change fresh-scan behavior, over adversarial snapshot/delete/tombstone/re-create/number-change sequences
- [ ] The refold-equivalence harness resets the epic-index memo wherever it wipes the epics projection on a reused connection
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence
