## Description

**Size:** S
**Files:** ~/code/agentwrap/CLAUDE.md (= AGENTS.md symlink), repo tag + remote push

### Approach

Final step, after the keeper-side retirement (`.4`) lands. In `~/code/agentwrap`:
add a short archive-notice header to its CLAUDE.md (edit IN PLACE — AGENTS.md is
a symlink) pointing at `keeper agent …` as the replacement; push a final tag
capturing the archived state; archive the repo (GitHub-archive or leave
read-only) — do NOT delete (git history + the `bun link` rollback path are
preserved until the in-binary path has fully soaked). The `plugin_scan_dirs`
section in its CLAUDE.md should note the loading surface moved to the keeper
binary. Keep it short — a retirement header, not a rewrite; history lives in the
commit.

### Investigation targets

**Required** (read before coding):
- ~/code/agentwrap/CLAUDE.md (= AGENTS.md symlink) — the archive-notice header site; plugin_scan_dirs section ~:184-187
- ~/code/agentwrap/.git — confirm remote + current HEAD SHA for the tag

### Risks

- Do not delete the repo — archive only; it is the rollback path.
- AGENTS.md is a symlink to CLAUDE.md — edit in place, never rm+recreate.

### Test notes

No tests (external repo, docs + tag only). Sanity: the tag pushes and the
archive notice renders.

## Acceptance

- [ ] `~/code/agentwrap/CLAUDE.md` carries a short archive-notice header pointing at `keeper agent`; edited in place
- [ ] a final tag captures the archived state and is pushed to the remote
- [ ] repo archived / read-only, NOT deleted

## Done summary
Added archive-notice header to agentwrap CLAUDE.md (edited in place, AGENTS.md symlink preserved) pointing at 'keeper agent …'; noted plugin-loading surface moved to keeper. Pushed tag archived-folded-into-keeper at 732812f and GitHub-archived the repo (read-only, not deleted).
## Evidence
