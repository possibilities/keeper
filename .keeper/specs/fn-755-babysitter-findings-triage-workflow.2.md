## Description

**Size:** S
**Files:** claude/arthack/template/commands/babysit-new.md.tmpl (new)

An arthack slash command that interviews the human for a sitter's goals and
scaffolds its `~/docs/babysitters/<slug>/` home per the task .1 contract.

### Approach

Model the template on `topic.md.tmpl` (the interview→scaffold→validate skeleton):
`disable-model-invocation: true`, `$0` for the slug arg, numbered `## Steps`.
Steps: (1) require a `<slug>` arg; (2) a short plain-text goals interview (what the
sitter watches, what "done"/end-state looks like or "ongoing", any known
heuristics); (3) scaffold `~/docs/babysitters/<slug>/{charter.md,processed.jsonl,rounds/,README.md}`
seeding `charter.md` Goals/Understanding/End-state/Heuristics/Sitter-facts from the
interview and the .1 contract; (4) **idempotency: never clobber an existing
charter.md or processed.jsonl** — if the home exists, report and stop (offer to
open it), don't overwrite human-authored heuristics or the verdict ledger; (5)
`git -C ~/docs add` + commit the new home. Frontmatter `allowed-tools` modeled on
/hack: Read, Write, Edit, Bash(git ...), Bash(planctl ...), Skill.

### Investigation targets

**Required:**
- claude/arthack/template/commands/topic.md.tmpl — the interview→scaffold→validate skeleton + disable-model-invocation + $0
- babysitters/FINDINGS-LEDGER.md (from task .1) — the charter/home contract to seed
- ~/docs/keeper-reliability/README.md — README/charter tone + file-index style

**Optional:**
- claude/arthack/template/commands/hack.md.tmpl:1-11 — frontmatter + Jinja prelude conventions

### Risks

- Rendered commands are generated artifacts — edit only the `.tmpl`; never the rendered `commands/*.md` (generated-guard sidecar). Re-render via `promptctl render-plugin-templates --project-root /Users/mike/code/arthack` (auto via scripts/install.sh).
- Clobber-safety is the load-bearing behavior: a second run on an existing slug must preserve the charter + ledger.

### Test notes

Render via `promptctl render-plugin-templates` and confirm `commands/babysit-new.md` materializes with a valid frontmatter + sidecar (the existing arthack render tests cover discovery). Dry-run the scaffold on a throwaway slug; re-run to confirm idempotency.

## Acceptance

- [ ] `babysit-new.md.tmpl` renders to a valid command; human-invoke-only
- [ ] Running it scaffolds the full `~/docs/babysitters/<slug>/` home and seeds charter.md from the interview
- [ ] A second run on an existing slug does NOT clobber charter.md / processed.jsonl
- [ ] The new home is committed to the ~/docs git repo

## Done summary
Added claude/arthack/template/commands/babysit-new.md.tmpl: a human-invoke-only slash command that interviews for a sitter's triage goals and idempotently scaffolds ~/docs/babysitters/<slug>/ (charter.md, empty processed.jsonl, rounds/, README.md) per the fn-755 ledger contract, never clobbering an existing charter/ledger, and commits the new home to the ~/docs git repo.
## Evidence
