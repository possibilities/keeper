## Description

**Size:** S
**Files:** plugins/plan/src/verbs/epics.ts, plugins/plan/test/epics.test.ts

### Approach

`keeper plan epics` stays cwd-only by charter, but its output self-identifies the
resolved project so a listing from a foreign cwd (another git repo carrying its
own stale `.keeper/`, as the dotfiles repo does) can never be silently mistaken
for a different board: the JSON envelope gains the resolved project root and
name, and the human output leads with one identity line. The genuine no-project
error path is unchanged. Document the field in the verb's help.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/epics.ts:53-90 — runEpics resolve + list + slice; plugins/plan/src/cli.ts:766 — the default limit 50
- plugins/plan/src/project.ts:76-83 — cwd-only resolveProject (the charter to preserve); :101-166 — the cwd-then-global charter that id verbs use (contrast, not adopt)

**Optional** (reference as needed):
- plugins/plan/src/state_path.ts:35-55 — resolveDataDir seam

### Test notes

Drive the verb in a temp project: envelope carries root+name; a second temp
project proves the identity distinguishes boards; no-project error unchanged.

## Acceptance

- [ ] The epics envelope and human output name the resolved project root
- [ ] The no-project error path is unchanged and non-zero
- [ ] The plan test gate passes

## Done summary

## Evidence
