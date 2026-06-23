## Description

**Size:** M
**Files:** apps/pairctl/** (delete), system/arthack/.local/bin/pairctl (shim), monorepo workspace/turbo config

### Approach

Delete the `apps/pairctl/` package entirely (the `pairctl/` Python source, `config/claude.yaml`
+ `config/codex.yaml`, `config/prompts/*.txt`, `tests/`). Remove the installed shim — the
`~/.local/bin/pairctl` symlink AND its source under `system/arthack/.local/bin/pairctl`.
De-register pairctl from the monorepo workspace (pyproject / turbo / workspace manifests — find
every `pairctl` registration). Before deleting, grep arthack once more to confirm nothing still
IMPORTS the package (the audit found only the hook files, handled by the sibling task). Run the
arthack lint + test suite to confirm no breakage.

### Investigation targets

**Required:**
- apps/pairctl/ (the package to delete — pairctl/, config/, tests/)
- system/arthack/.local/bin/pairctl (shim source behind the ~/.local/bin symlink)
- the monorepo workspace / turbo config registering apps/pairctl

### Risks

- A lingering import would break a build — grep arthack for `pairctl` imports/invocations before deleting; the audit found none outside the package + the hooks.

### Test notes

arthack lint + test suites green after removal; `which pairctl` resolves to nothing.

## Acceptance

- [ ] apps/pairctl/ + config + prompts + tests deleted
- [ ] shim symlink + its source removed; workspace/turbo registration removed
- [ ] arthack lint + test suite green; no dangling pairctl import

## Done summary
Deleted the arthack apps/pairctl package (source, config, prompts, tests), removed the ~/.local/bin/pairctl shim and its source symlink, de-registered pairctl from the pyproject workspace, regenerated uv.lock + pnpm-lock.yaml, and rewrote codexctl cross-CLI comments forward-facing. arthack lint + full test suite green; which pairctl resolves to nothing.
## Evidence
