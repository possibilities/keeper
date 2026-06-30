## Overview

Drive the `agentwrap` name to ZERO across keeper + arthack — the terminal step after fn-1018 (which scrubs the name and relocates the config dir but freezes 5 cross-process/on-disk categories). This epic migrates those survivors: renames the `AGENTWRAP_*` env-var family to `KEEPER_AGENT_*`, relocates the live `~/.local/state/agentwrap/` runtime dir to `~/.local/state/keeper-agent/` via an inode-preserving atomic rename, removes fn-1018's transitional config fallback + legacy presets detector, deletes the retired-alias tests, and flips the retired-name lint to zero-tolerance so `agentwrap` can never return. Gated on fn-1018 fully landing.

## Quick commands

- `bun test` — green after each task
- `bash scripts/lint-retired-name.sh` — now zero-tolerance for agentwrap (planctl checks unchanged)
- `git grep -iE '\bagentwrap\b' -- ':!.keeper' ':!docs' ':!scripts/lint-retired-name.sh' ':!scripts/frozen-allowlist.txt' ':!test/lint-retired-name.test.ts'` → empty in keeper
- `cd ~/code/arthack && git grep -i agentwrap -- ':!.keeper'` → empty
- `ls ~/.local/state/keeper-agent/` shows the moved cwd-ordinals.json + tmux-runs/; old `~/.local/state/agentwrap/` is gone

## Acceptance

- [ ] `AGENTWRAP_*` env-var family renamed to `KEEPER_AGENT_*` across producer/consumer/forward-filter in lockstep; `KEEPER_AGENT_PATH` explicitly excluded from the pane-forward filter (regression-tested)
- [ ] arthack statusline reads `KEEPER_AGENT_CLAUDE_PROFILE` (+ existing `ARTHACK_CLAUDE_PROFILE`); no agentwrap remains in arthack
- [ ] `~/.local/state/agentwrap/` relocated to `~/.local/state/keeper-agent/` via inode-preserving atomic directory rename; the flock-guarded cwd-ordinals counter survives; the two divergent stateDir functions unified to one XDG-honoring source
- [ ] fn-1018's config fallback + `legacyAgentwrapPresetsPath`/`migrationHint` removed; retired-alias DB-config tests deleted; README presets-hint pruned
- [ ] `scripts/lint-retired-name.sh` enforces zero agentwrap (repo-wide grep with a defined exclusion set); planctl checks unchanged; the agentwrap frozen-allowlist block pruned
- [ ] `bun test` green; zero-tolerance lint green; agentwrap retirement documented forward-facing

## Early proof point

Task that proves the approach: `.3` (state-dir atomic relocation). If it fails: the flock-guarded counter is the riskiest surface — if an inode-preserving rename can't be made coherent across the two stateDir functions, fall back to a quiesce-then-move under a single-user maintenance assumption (no in-flight launches) before touching the lint flip.

## References

- DEPENDS ON `fn-1018-scrub-agentwrap-name-and-relocate` — removes its frozen scaffolding + renames its introduced symbols; must run after it fully lands.
- fn-889 planctl retirement: `scripts/lint-retired-name.sh` + `frozen-allowlist.txt` + `docs/plan-name-retirement.md` — the guard pattern; planctl checks must stay intact when adding the agentwrap zero-tolerance mode.
- `src/keeper-agent-path.ts` (`KEEPER_AGENT_PATH`) — the pre-existing name the forward filter must exclude.
- `src/usage-flock.ts` — the flock discipline the state-dir migration must preserve.

## Docs gaps

- **README.md**: prune the `~/.config/agentwrap/presets.yaml` migration-hint sentence once `legacyAgentwrapPresetsPath` is removed (the rest of README's agentwrap prose is fn-1018.2's).
- **docs/plan-name-retirement.md**: document the agentwrap zero-tolerance end-state (generalize to a retirements note or a sibling doc; the permanently-frozen section is empty — full retirement).
- **scripts/frozen-allowlist.txt**: prune the agentwrap survivors block + trim its header to past-tense once the sweep completes.

## Best practices

- **State-dir relocation = atomic directory rename, never copy-forward:** flock binds the inode; a copy-forward forks the lock and the cwd-ordinals counter diverges silently. `rename(old,new)` preserves the inode and IS the retirement. [practice-scout]
- **Consumer before producer for the cross-repo env var:** arthack's statusline read lands before keeper's producer rename; a transitional in-keeper `AGENTWRAP_` fallback would conflict with zero-tolerance, so hard-cut + accept a brief transient. [practice-scout]
- **Zero-tolerance is a new grep mode, not a flag flip:** a repo-wide grep with a defined exclusion set (the guard's own files, the retirement doc, `.keeper` history, kept fixtures); order it strictly after every rename + the config-fallback removal. [gap-analyst]
