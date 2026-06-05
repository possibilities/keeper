## Description

**Size:** S
**Files:** CLAUDE.md, README.md, keeper/api.py (docstring), plus any keeper-repo skill/prompt referencing jobctl

### Approach

Update keeper's own docs and sweep the keeper repo for residual `jobctl`
references now that the verbs are live. CLAUDE.md: the schema-coupling rule
(~115-120) naming "jobctl commit-work" as the keeper-py consumer → `keeper
commit-work`; the "jobctl-stamped" Job-Id trailer note (~134) → keeper-stamped
or drop the tool attribution (the invariant is what matters); reconcile the
stale "flock shared with planctl's auto-commit" claim — planctl's auto-commit
takes no flock, and `keeper commit-work` uses an isolated keeper-branded lock.
README.md: add `commit-work`/`find-task-commit`/`session-state`/
`show-session-files` to the CLI subcommand list; if this epic touches
SCHEMA_VERSION (it should NOT — readers use the existing file_attributions
shape), no schema-history entry is needed. keeper/api.py docstring: rename the
`get_session_dirty_files` consumer (coordinate with task 4 which removes the
function — this task only fixes prose that survives). Final sweep: `rg -n
'jobctl' ~/code/keeper` returns only archival/historical mentions.

### Investigation targets

**Required** (read before coding):
- ~/code/keeper/CLAUDE.md — the three callouts (~115-120, ~134, the flock-shared line)
- ~/code/keeper/README.md — the CLI subcommand list + schema-history template

### Risks

- Coordinate the api.py docstring edit with task 4 (which deletes the function) to avoid a merge stomp on the same file.
- Don't rewrite archival/historical CLAUDE.md prose that describes past behavior accurately.

### Test notes

`rg -n 'jobctl commit-work' ~/code/keeper` returns zero functional refs;
docs render correctly; `pnpm lint`/`typecheck` unaffected.

## Acceptance

- [ ] CLAUDE.md three callouts updated (schema consumer, Job-Id trailer attribution, flock-shared reconcile).
- [ ] README lists the four new subcommands.
- [ ] keeper repo `rg jobctl commit-work` clean of functional refs.

## Done summary

## Evidence
