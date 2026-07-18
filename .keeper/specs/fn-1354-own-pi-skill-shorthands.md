## Overview

Keeper's existing launch-scoped Pi extension owns `/hack` and `/plan` shorthand expansion, autocomplete, and discovery of the canonical Keeper skill bodies. Arthack retains its unrelated Pi and Codex resources but no longer installs Keeper's Pi skills or a global alias extension.

The rollout expands Keeper first and contracts Arthack second. Keeper does not add compatibility behavior for conflicting ambient `hack` or `plan` skills; Pi's native collision behavior remains authoritative.

## Quick commands

- `bun test test/pi-skill-autocomplete.test.ts && bun test test/pi-extension.test.ts && (cd ../arthack && uv run pytest tests/test_arthack_pi_resources.py)`

## Acceptance

- [ ] A Keeper-launched Pi discovers the canonical Hack and Plan skills and expands `/hack` and `/plan` through Pi's native skill pipeline without any Arthack-installed resource.
- [ ] Exact shorthand behavior, arguments, near misses, autocomplete, and fail-open extension registration are covered by in-process tests with no ambient Pi profile or real Pi subprocess.
- [ ] Arthack no longer creates global Pi Hack/Plan links or the alias extension, while its Codex skill installation and unrelated Pi skills remain unchanged.
- [ ] An upgraded installation can retire only the known Arthack-managed global links without deleting foreign files or symlinks.

## Early proof point

Task that proves the approach: Task 1. If dynamic resource discovery or native input transformation cannot satisfy the contract inside Keeper's existing extension, retain Arthack's implementation and refine the extension boundary before running the contraction task.

## References

- `docs/adr/0091-keeper-owned-pi-shorthands-and-skill-discovery.md`
- `docs/adr/0039-pi-task-facade-and-plan-agent-rendering.md`
- `docs/adr/0043-pi-agent-bus-session-child.md`
- Pi extension input and resource events: https://pi.dev/docs/latest/extensions
- Parallel change rollout: https://martinfowler.com/bliki/ParallelChange.html

## Docs gaps

- **`docs/install.md`**: consolidate Pi operations guidance around Keeper-owned launch-scoped shorthand and skill discovery, including refresh and verification behavior.
- **`docs/plugin-composition-map.md`**: add shorthand and skill-resource ownership to the tracked Pi extension composition map.
- **`../arthack/scripts/CLAUDE.md`**: remove the claim that Arthack installs Keeper's Pi aliases and skill links while preserving its remaining installer responsibilities.

## Best practices

- **Native transformation:** return transformed input to Pi instead of registering extension commands, so native skill expansion remains authoritative [Pi extension docs].
- **Module-relative discovery:** contribute only the two canonical skill directories resolved from the extension module, never cwd or Arthack [Pi extension docs].
- **Expand then contract:** land and prove Keeper's replacement before removing Arthack's global wiring [Parallel Change].
