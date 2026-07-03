## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/landed-vs-complete.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml

### Approach

Author the single-source invariant kernel for keeper's landed-vs-complete semantics as a new snippet in the arthack prompt corpus (the upstream keeper vendors from). Content is the kernel ONLY — the invariant definitions, no per-skill framing: `landed <epic>` fires when the epic's lane is merged to the default branch, degrades to `complete` semantics when worktree mode is off, and for a multi-repo epic fires only once ALL per-repo groups have merged; `complete <id>` is done-AND-idle and, under worktree mode, can fire while files are not yet on the default branch (a dependent lane is cut before the upstream's finalize merge) — so planning daisy-chains gate on `landed`, not `complete`. Follow the existing snippet file conventions (frontmatter, verbatim body) and add the `_index.yaml` row (name, summary, domain engineering, tags, token-estimate) so the snippet is inside keeper's vendoring FILTER (domain engineering auto-vendors).

### Investigation targets

*Verify before relying.*

**Required**:
- An existing engineering snippet + its `_index.yaml` row in this repo (e.g. future-facing-docs) — the file-shape and index conventions to match
- The three authoritative wordings being unified, read from the keeper checkout: plugins/plan/skills/hack/SKILL.md:211 region, plugins/plan/skills/plan/SKILL.md:589 region, plugins/keeper/skills/await/SKILL.md:46 table row (await's is the richest)

### Risks

- Kernel-vs-framing boundary: over-extract and the consuming skills lose context; under-extract and the copies stay divergent. The kernel is the semantics; application prose ("prefer over complete for a daisy-chain") stays in each skill.

## Acceptance

- [ ] A landed-vs-complete snippet exists in the engineering domain of the arthack corpus with a valid index row, stating lane-merge semantics, worktree-off degradation, multi-repo all-groups, and the complete-fires-early caveat
- [ ] The snippet body carries no skill-specific framing or instructions to a particular caller
- [ ] Corpus tooling in this repo (index validation / snippet build) passes

## Done summary

## Evidence
