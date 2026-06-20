## Description

**Size:** S
**Files:** skills/await/SKILL.md (renamed from skills/keeper-await/SKILL.md), README.md

Rename the skill and rewrite its docs (plus README) to match the final CLI
grammar from task `.1`. Depends on `.1` because the SKILL.md must document
the exact emitted line shapes and condition set that `.1` finalizes.

### Approach

1. **Rename** `skills/keeper-await/SKILL.md` → `skills/await/SKILL.md`
   (`git mv` the file; the directory rename comes for free). Frontmatter
   `name: keeper-await` → `name: await` (this is what makes it resolve as
   `/keeper:await` AND bare `/await`). H1 `# keeper-await` → `# await`.
2. **Broaden the `description` frontmatter** so it auto-triggers on
   git-state phrasings ("wait for the project to be clean", "wait until
   everything's committed"), job-state phrasings ("wait for the other
   agents to finish", "wait until everyone else is done working"), AND
   combinations — while KEEPING the existing planctl-id triggers. Keep
   `allowed-tools: Monitor Bash`.
3. **Rewrite the body**: the parse table gains `git-clean` and
   `agents-idle` rows (no planctl id; project-scoped to cwd's repo) and an
   explanation of the `<cond> and <cond> ...` AND grammar. The `planctl
   show` pre-check step applies ONLY to `complete`/`unblocked` — git/jobs
   conditions have no off-board pre-check (note this explicitly). The
   Monitor wiring example shows an AND form
   (`keeper await git-clean and agents-idle`). Update the terminal-line /
   exit-code table to match `.1`'s output (incl. `failed reason=no-git-root`
   and how the line names which condition fired). Prune the examples to a
   minimal set that covers the new surface (don't just append): keep one
   planctl example, add one `git-clean`, one `agents-idle`, one
   combination. Update "What NOT to do" for the new families.
4. **README**: update the `## Example clients` prose (~L469) and the
   `await.ts` module-map bullet + shell examples (~L785) to name the full
   condition set and show one AND-combination example (replace, don't add
   a third). No `## Architecture` change (client-only). No CLAUDE.md change
   (out of its scope — confirmed by docs-gap-scout).

### Investigation targets

**Required** (read before coding):
- skills/keeper-await/SKILL.md — the file to rename + rewrite (full current structure).
- cli/await.ts:66 `HELP` (as finalized by task .1) — the authoritative condition list + line shapes to mirror in SKILL.md/README.
- README.md ~L469 (`## Example clients`) and ~L785 (`await.ts` module-map bullet + shell examples).

**Optional** (reference as needed):
- CLAUDE.md note: `AGENTS.md` is a symlink to it — never touched here; do not rm+recreate either.

### Risks

- **Doc drift from `.1`.** The dep on `.1` exists precisely so the emitted
  line shapes are final; mirror `HELP` verbatim rather than re-inventing
  phrasing.
- **Skill-loader resolution by directory name.** The skill is registered
  as `keeper:keeper-await`; renaming the dir + `name:` is what re-points
  it. Verify the new `/keeper:await` and `/await` resolve after the rename.

### Test notes

No automated tests (docs/skill only). Verify by: `git mv` preserves
history; the SKILL.md frontmatter parses; the documented commands match
`keeper await --help` output byte-for-byte on the condition list.

## Acceptance

- [ ] `skills/await/SKILL.md` exists (renamed via `git mv`), `skills/keeper-await/` is gone, `name: await`, H1 `# await`.
- [ ] `description` triggers on git-state, job-state, and combination phrasings plus the existing planctl-id triggers.
- [ ] Body documents `git-clean`/`agents-idle` (project-scoped, no pre-check), the `and` grammar, the updated line/exit-code table, and a minimal pruned example set incl. one combination.
- [ ] README `## Example clients` prose + `await.ts` module-map bullet/examples updated to the full condition set with one AND example; no `## Architecture`/CLAUDE.md change.
- [ ] Documented condition list matches `keeper await --help` exactly.

## Done summary
Renamed skills/keeper-await -> skills/await (name: await), broadened the description to git/jobs/combination phrasings, rewrote the body to document git-clean/agents-idle conditions, the AND grammar, the no-git-root failure, and the updated line/exit-code table with a minimal pruned example set. Updated README example-clients prose and the await.ts module-map bullet/examples to the full condition set with one AND example. Documented condition list matches keeper await --help.
## Evidence
