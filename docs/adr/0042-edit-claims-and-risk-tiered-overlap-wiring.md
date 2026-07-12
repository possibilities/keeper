# 42. Structured edit claims and risk-tiered overlap wiring

## Status

Proposed. ADR number PROVISIONAL — assigned at merge (renumber if a sibling epic lands
one first).

## Context

Plan-time conflict prevention was an honor system. Each task's predicted write set lived
as an unparsed prose `**Files:**` line inside spec markdown; the "shared path means a dep
edge" rule was purely cognitive, with a scaffold validator that checks only dep ordinals
and cycles; every inter-epic overlap epic-scout surfaced was hard-wired into a full
serializing `depends_on_epics` edge, identical to a true dependency; sibling epics
scaffolded in the same session were structurally invisible to epic-scout; and the landed
ground truth — the Commit event payload's `files[]` + `task_ids[]` — was recorded but
never read back by any surface.

Two facts changed the calculus. The escalation backend (0007, 0039: resolver → deconflict
→ one terminal page) now makes a lost merge race cheap. And same-file overlap is a
high-recall, low-precision conflict signal — mined studies put textual conflict rates at
roughly 7–20% of concurrent same-file edits, so uniform serialization pays a silent
parallelism tax on mostly-benign overlaps while enforcing nothing mechanically.

## Decision

1. **Tasks carry a structured `edit_claims` field** — claim kinds exactly `path` (exact
   repo-relative), `glob` (bounded pattern, `*` never crossing `/`), and `resource`
   (a logical singleton token, e.g. the schema ladder), each with `expected` or
   `possible` certainty. The field is required-present on new tasks; an explicit empty
   list means "no predictable repo writes." The prose `Files:` line becomes a
   deterministic derived render of the claims — one source of truth, never two
   hand-authored copies. Claim values are agent-authored input: invalid patterns
   (`..`, absolute, backslash) are rejected loudly, never normalized silently.
2. **Scaffold gains an overlap gate.** Same-repo task pairs that are DAG-incomparable
   (neither transitively reaches the other) REJECT with `write_overlap_unordered` iff
   both claims are `expected` and the hit is same-kind exact — equal normalized path, or
   equal resource token. Every softer intersection (a glob on either side, `possible` on
   either side) WARNs without blocking. `--allow-overlap` downgrades rejects to warnings.
3. **Inter-epic overlap wiring is risk-tiered.** Expected exact-path or resource
   collisions wire a hard `depends_on_epics` edge; soft/glob overlaps become an advisory
   References note and the epics race into the resolver. A deterministic pre-arm sweep
   intersects claims across all open epics — covering same-session siblings the
   commit-reading epic-scout cannot see — and feeds the same tiered action.
4. **Ground truth closes the loop out-of-band.** Conflicted file sets are captured by the
   merge producer and ride the DispatchFailed payload into a `dispatch_failures` column;
   a calibration report diffs each landed task's claims against the Commit-event
   `files[]` per certainty tier (precision and recall separately, never accuracy). The
   report is a committed dataset in the selection-review shape — never a fold, because a
   files-per-task projection folded from history is a re-fold time-bomb.
5. **The build is gated by measurement.** The implementing epic's first task buckets
   historical conflicts (sibling file-overlap vs base-drift vs other); if file-overlap is
   not the dominant class, the task hard-blocks at a designed check-in and the epic is
   re-planned toward the dominant class instead of building the claims machinery.

## Consequences

- Overlap knowledge becomes machine-readable and mechanically enforced where collision is
  near-certain, advisory where soft — trading a small hard-gate friction (with an escape
  hatch) for restored parallelism on benign overlaps that the backend can now absorb.
- The gate's value is bounded by claim accuracy, not gate logic: prose-era sampling put
  file predictions near 75% precision / 69% recall. The calibration report is the
  instrument that tunes the tiers and decides the named follow-ups — a dispatch-time
  overlap defer at the reconciler, and a dedicated post-decomposition edit-surface scout.
- Accepted holes: rename collisions (path claims cannot see content-based rename
  detection) and semantic conflicts (a large share of textually-clean merges still fail
  build or test) stay invisible to file claims — the resolver pipeline remains the
  backstop, and the gate must never be read as a safety guarantee that weakens it.
- Hard-serialized pairs never race, so their absence from conflict data is selection
  bias, not gate precision — calibration keeps that distinction explicit
  (selective-labels bias).
