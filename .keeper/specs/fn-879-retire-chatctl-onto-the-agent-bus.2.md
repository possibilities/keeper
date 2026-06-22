## Description

**Size:** S
**Files:** pyproject.toml, uv.lock, pnpm-lock.yaml

Remove chatctl from the workspace manifest and regenerate the lockfiles so
the workspace resolves cleanly without it.

### Approach

Remove all chatctl references from `pyproject.toml`: the members entry
(~line 39 `"chatctl"`), the workspace source (~line 76 `chatctl = {
workspace = true }`), the packages/path entry (~line 117 `"apps/chatctl"`),
and the ruff/mypy config entries (~lines 221-222 `"chatctl"` / `"chatctl.*"`).
Then REGENERATE the lockfiles with the proper tools — `uv lock` for uv.lock
and `pnpm install --lockfile-only` (or the repo's standard) for
pnpm-lock.yaml — never hand-edit lockfile hashes. Verify the workspace
resolves (`uv sync` / `uv lock --check`) with chatctl gone.

### Investigation targets

**Required** (read before coding):
- pyproject.toml (all 5 chatctl refs; confirm exact lines before editing)
- the repo's lock/sync conventions (how uv.lock + pnpm-lock.yaml are normally regenerated)

### Risks

- Depends on task 1 (apps/chatctl deleted) so lock regen doesn't re-resolve the package.
- Regenerate locks with the toolchain, not by hand — a hand-edited lockfile is a landmine.
- If lock regen pulls unrelated updates, scope the change to chatctl removal (a minimal lock diff).

### Test notes

`uv lock --check` (or equivalent) passes; `grep chatctl pyproject.toml uv.lock pnpm-lock.yaml` is clean (or only inert).

## Acceptance

- [ ] All 5 chatctl references removed from pyproject.toml
- [ ] uv.lock + pnpm-lock.yaml regenerated via the toolchain (no hand edits); workspace resolves
- [ ] no chatctl reference remains in the workspace manifest or lockfiles

## Done summary

## Evidence
