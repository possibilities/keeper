## Overview

Keeper's top-level CLI should use a small TypeScript CLI framework for command registration and shell-completion generation while preserving the existing leaf parsers and pass-through contracts. The end state is a Clerc-backed proxy registry, a `keeper completions <shell>` surface for bash/zsh/fish scripts, and installer-owned completion file placement.

## Quick commands

- `bun test test/keeper-cli.test.ts test/completions.test.ts test/install-completions.test.ts`
- `keeper --help --json | jq '.subcommands[] | select(.name == "completions")'`
- `keeper completions zsh | head -5`

## Acceptance

- [ ] Keeper carries an exact, Bun-compatible CLI framework dependency used by the top-level command registry and completion generator.
- [ ] Existing subcommand behavior, residual argv forwarding, `keeper --help --json`, and `keeper plan` / `keeper prompt` pass-through semantics stay compatible with the current tests.
- [ ] `keeper completions bash|zsh|fish` emits framework-generated scripts whose command candidates come from keeper's command metadata.
- [ ] `scripts/install.sh` installs completion files idempotently at install time without silently editing shell rc files.

## Early proof point

Task that proves the approach: task 1. If the proxy registry cannot preserve residual argv exactly, keep the manual dispatcher and use Clerc only for the completion command tree before continuing.

## References

- `cli/keeper.ts` — top-level command metadata, help index, and dispatch seam.
- `scripts/install.sh` — keeper's idempotent install footprint.
- https://clerc.js.org/ — Clerc framework overview.
- https://clerc.js.org/official-plugins/plugin-completions — Clerc completions plugin.
- `fn-1102-keeper-tabs-browser-grade-restore` overlap: its tabs work touches `cli/keeper.ts`, `README.md`, and `test/keeper-cli.test.ts`, so this epic waits for it before cutting a lane.

## Docs gaps

- **README.md**: revise install and uninstall instructions to include completion file placement and activation caveats.

## Best practices

- **Proxy before leaf migration:** let the framework own discovery and completions while leaf commands keep their established parsers and exit-code contracts.
- **No silent rc edits:** install completion files into shell-owned locations and print activation notes when a shell needs user opt-in.
- **Static first:** generate command and verb candidates from in-process metadata so common TAB paths do not need daemon reads.
