## Overview

The Capability model glossary entry in CONTEXT.md names the resolving
artifact "the host provider roster," a synonym coined nowhere else, while
every sibling entry in the same cluster canonically calls it "the host
matrix config." This is a naming-consistency fix to a document whose entire
purpose is a single canonical vocabulary — a reader cross-referencing the
cluster should meet one name for one artifact.

## Acceptance

- [ ] The Capability model entry uses the cluster's canonical term for the
      resolving artifact, consistent with the Provider / Pecking order /
      Wrapper driver entries.
- [ ] No new synonym for that artifact is introduced; the entry still reads
      precisely and keeps its definition + Avoid line.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | CONTEXT.md:36 Capability model entry says "host provider roster" while sibling entries canonically say "host matrix config" — a real cross-reference inconsistency in a naming glossary. |

## Out of scope

- Rewording or restructuring any other glossary entry.
- Any change to the resolution behavior the entry describes.
