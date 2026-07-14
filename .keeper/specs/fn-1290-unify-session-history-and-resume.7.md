## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml

### Approach

Rewrite the authoritative arthack history-forensics snippet around `keeper history`, canonical Session references, cross-harness/project search, evidence grading, and foreground resume. Keep examples bounded and agent-oriented, preserve specialist transcript guidance only where it remains necessary, and remove every recommendation of the retired top-level readers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl:1 — authoritative rendered guidance
- claude/arthack/template/_partials/snippets/_index.yaml:936 — snippet metadata and bundle membership

**Optional** (reference as needed):
- /Users/mike/code/keeper/docs/adr/0062-unified-session-history-and-resume.md — controlling API and vocabulary
- /Users/mike/code/keeper/CONTEXT.md:113 — canonical Session terms

### Risks

Updating only Keeper's vendored copy causes the corpus drift gate to fail and loses the next upstream refresh. Examples must not overpromise untracked mutation evidence or semantic search.

### Test notes

Run arthack's targeted prompt/snippet validation required for the changed template and ensure rendered guidance contains no old command names.

### Detailed phases

1. Replace discovery, search, context-opening, file-evidence, and resume recipes with the final CLI.
2. Tighten metadata/index terms if the snippet's summary or related links change.
3. Render or validate the snippet through arthack's existing prompt tooling.

### Alternatives

Editing only Keeper's vendored leaf is rejected because `vendor.lock` declares arthack as the authoring home.

### Non-functional targets

Guidance is concise, future-facing, parseable as Markdown, and contains bounded commands suitable for agent execution.

### Rollout

Land upstream first. The dependent Keeper task vendors the exact authored revision and performs the public command removal.

## Acceptance

- [ ] The authoritative snippet teaches cross-project Claude/Pi history discovery, exact Session-reference resolution, full-text search, context pagination, graded file evidence, and foreground resume.
- [ ] No example or prose references `search-history`, `find-file-history`, semantic embeddings, or ungraded file mutation claims.
- [ ] Specialist transcript operations are retained only for harness-specific features not covered by `keeper history`.
- [ ] Arthack's focused prompt/snippet validation passes and the task commits only its declared repository files.

## Done summary

## Evidence
