## Description

**Size:** M
**Files:** keeper CLAUDE.md/AGENTS.md/README.md + comments, ~/code/arthack/{CLAUDE.md,claude/CLAUDE.md,scripts/CLAUDE.md,system/CLAUDE.md}

### Approach

Forward-facing sweep of every remaining `planctl` mention in docs + comments across keeper and arthack: the data-dir rule (`.keeper/`), the plan-as-keeper-subcommand framing, the plan-worker/autopilot docs, the stale arthack sibling-repo descriptions. State the present (`keeper plan`, `.keeper/`) — never narrate the rename.

### Investigation targets
**Required**:
- `rg -n 'planctl' ~/code/keeper ~/code/arthack --glob '!**/.git/**' --glob '!**/.keeper/**'` — the residue (skip vendored history + frozen fixtures)

### Risks
- Don't rewrite vendored `plugins/plan/.keeper/specs` history or frozen test fixtures.

### Test notes
`rg -n 'planctl' <live docs+code>` returns only fixtures/vendored-history.

## Acceptance
- [ ] no live `planctl` mention in keeper/arthack docs or comments; forward-facing only
## Done summary
Forward-facing sweep of stale planctl mentions across keeper docs (CLAUDE.md/README.md + autopilot-worker comment) and arthack docs (CLAUDE.md, claude/scripts/system CLAUDE.md): present-tense keeper plan / .keeper/ framing. Schema column names, the 'planctl' source-badge value, Planctl-Op trailers, and the live ~/.local/bin/planctl binary cord (cut-the-cord task's scope) left unchanged.
## Evidence
