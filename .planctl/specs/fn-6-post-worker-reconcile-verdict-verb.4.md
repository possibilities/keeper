## Description

**Size:** S
**Files:** CLAUDE.md, AGENTS.md, docs/reference/commit-at-mutation-boundary.md, README.md, docs/diagrams/planctl-workflow.mermaid.md

Sync the human-facing docs to the `reconcile` verb + the consolidated post-worker flow. Lands last (deps on .1/.2/.3) and, per the epic dep, after fn-5 — especially fn-5 task `.4`, which rewrites the same doc sections; build on its final shape, don't fight it. Present-tense only (no "used to" tombstones), except the sanctioned bug-history record (untouched).

### Approach

- **CLAUDE.md AND AGENTS.md** (identical, edit both same commit): add `reconcile` to the read-only verb list; add a `reconcile` bullet in the skills-and-agents section (read-only verdict verb, the 7-value enum, no-keeper guarantee, readonly invocation); rewrite the Phase-2b multi-call description to the single `reconcile` switch + Phase-3 drop + the worker delivery self-check; update the worker-contract/recovery paragraphs.
- **docs/reference/commit-at-mutation-boundary.md**: add a read-only `reconcile` row to the §3 verb-classification table; rewrite the §9 recovery property for the `reconcile` switch and the dropped Phase 3 (renumber); add a `reconcile` row to the §13 testing-patterns table.
- **README.md**: add `reconcile` to the command map (read-only post-worker verdict; no keeper dep).
- **docs/diagrams/planctl-workflow.mermaid.md**: rename the `verify` node to `reconcile`, remove the `quality` node, draw `reconcile -.reads.-> cli_layer`, and route `reconcile`→`ship` on the `done` verdict.

### Investigation targets

**Required**:
- CLAUDE.md + AGENTS.md — read-only verb list, skills-and-agents section, worker-contract/recovery paragraphs.
- docs/reference/commit-at-mutation-boundary.md — §3 table, §9 recovery property, §13 testing table.
- README.md — command map.
- docs/diagrams/planctl-workflow.mermaid.md — the Work Skill subgraph (verify/quality nodes).

### Risks

- **fn-5 task .4 overlap** — same doc sections. This task lands after fn-5 (epic dep); rebase prose onto fn-5's final wording, follow the shared-tree rule if dirty.
- **CLAUDE.md/AGENTS.md drift** — keep them byte-identical.

### Test notes

No code tests. Verify the mermaid still parses; grep for accidental "used to"/"formerly"/"no longer" phrasing.

## Acceptance

- [ ] CLAUDE.md + AGENTS.md updated in sync (read-only verb list, reconcile bullet, post-worker flow, worker self-check).
- [ ] commit-at-mutation-boundary.md §3/§9/§13 updated; README command map + workflow mermaid updated.
- [ ] All edits present-tense; no backward-facing tombstones.

## Done summary

## Evidence
