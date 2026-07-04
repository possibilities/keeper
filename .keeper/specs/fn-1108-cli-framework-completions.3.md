## Description

**Size:** M
**Files:** scripts/install.sh, scripts/install-completions.ts, test/install-completions.test.ts, README.md

### Approach

Add an installer helper that writes generated completion scripts into shell-appropriate user locations and reports any activation caveats. `scripts/install.sh` calls the helper after `bun link`, when the `keeper` command is available, and respects a `KEEPER_SKIP_COMPLETIONS=1` escape hatch. The helper is idempotent: reruns overwrite the same managed files with the current generated content and never append duplicate shell configuration.

The installer writes fish to its autoloaded user completion directory, writes bash to the user bash-completion directory, and writes zsh to a safe user completion directory or a writable site-functions directory when available. It must not silently edit `.zshrc`, `.bashrc`, `.bash_profile`, or fish config; when a shell needs activation, print a concise snippet for the human to opt in.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/install.sh:35 — dependency install is the first install step.
- scripts/install.sh:38 — `bun link` is the PATH seam after which `keeper` is invokable.
- scripts/install.sh:52 — installer already owns user-scoped keeper config writes.
- scripts/install.sh:63 — plugin template rendering shows the current style for repo-root Bun script calls.
- README.md:53 — install instructions describe the owned footprint.
- README.md:87 — uninstall instructions must list completion cleanup paths.

**Optional** (reference as needed):
- test/keeper-cli.test.ts:241 — existing tests demonstrate in-process dispatch testing without spawning renderers.

### Risks

Bash and zsh activation varies across macOS and Linux. Prefer safe file placement plus clear activation notes over rc-file mutation; make failures or unsupported locations visible without blocking the daemon install.

### Test notes

Factor destination selection and write planning into pure functions that accept a fake home, XDG variables, shell path, and optional brew prefix. Tests should use temporary directories only.

## Acceptance

- [ ] `scripts/install-completions.ts` installs bash, zsh, and fish completion files idempotently under user-scoped paths and prints activation notes when needed.
- [ ] `scripts/install.sh` invokes the helper after `bun link`, respects `KEEPER_SKIP_COMPLETIONS=1`, and does not silently edit shell rc files.
- [ ] Tests cover destination selection, idempotent rewrites, skip behavior, and no writes outside the provided test home.
- [ ] README install and uninstall sections document the completion footprint and activation caveats.

## Done summary
Add scripts/install-completions.ts: idempotently writes generated bash/zsh/fish completion files into shell-owned user paths, never editing rc files, printing activation notes when needed. install.sh invokes it after bun link honoring KEEPER_SKIP_COMPLETIONS=1; README documents footprint and cleanup.
## Evidence
