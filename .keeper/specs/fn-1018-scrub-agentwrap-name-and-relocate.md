## Overview

Retire the legacy `agentwrap` name across keeper — the external binary is gone, replaced by the in-binary `keeper agent` launcher — and relocate the launcher's per-harness config dir from `~/.config/agentwrap/` to `~/.config/keeper/`. Forward-facing only: code, comments, docs, and user-visible strings read as if `keeper agent` was always the name; no provenance tombstones. A deliberate frozen set survives untouched: the cross-process `AGENTWRAP_*` env-var family, the `~/.local/state/agentwrap/` runtime state dir, the `legacyAgentwrapPresetsPath` leftover detector, and the retired-alias test guards — pinned by a frozen-anchor lint so no sweep can clobber them.

## Quick commands

- `bun test` — full suite green after each task
- `bash scripts/lint-retired-name.sh` — frozen-anchor guard passes (no survivor clobbered)
- `keeper agent presets list` — launcher boots, resolves config from `~/.config/keeper/`
- `git grep -iE '\bagentwrap\b' -- ':!.keeper' ':!scripts/frozen-allowlist.txt'` — only frozen survivors remain
- (arthack) `cd ~/code/arthack && stow --restow -t ~ -d system arthack && ls -la ~/.config/keeper/`

## Acceptance

- [ ] No `agentwrap` identifier, comment, doc, or user-visible string remains in keeper except the pinned frozen survivors
- [ ] `keeperAgent*` / `KeeperAgent*` / `KEEPER_AGENT_*` (transport) + `launcher*` (in-`src/agent/` flag fields) naming applied consistently, matching the existing `resolveKeeperAgentPath` precedent
- [ ] Launcher resolves per-harness config from `~/.config/keeper/`, falling back to `~/.config/agentwrap/` when the new path is absent (per-file; fail-loud plugins reader preserved)
- [ ] The `AGENTWRAP_*` env-var family, state dir, legacy presets detector, and retired-alias tests are all unchanged and anchored in the frozen allowlist
- [ ] arthack stow relocated; `~/.config/keeper/{claude,plugins}.yaml` symlinks live; `bun test` green
- [ ] Full suite green + frozen-anchor lint green

## Early proof point

Task that proves the approach: `.1` (frozen-anchor guard). If it fails: the survivor enumeration is wrong — reconcile the in/out token table before any sweep, since the guard is what makes the green suite trustworthy.

## References

- fn-889 planctl retirement: `scripts/lint-retired-name.sh` + `scripts/frozen-allowlist.txt` + `docs/plan-name-retirement.md` — the proven name-retirement guard pattern this epic reuses
- `src/keeper-agent-path.ts` / `src/db.ts:353` `resolveKeeperAgentPath` — the `keeperAgent*` / `KEEPER_AGENT_*` casing precedent
- `src/agent/config.ts:83-104` — the completed presets-dir migration (`keeperConfigDir` + legacy detector) this epic mirrors for the per-harness fallback
- Comment/doc style: `keeper prompt render code-comment-style` + `keeper prompt render future-facing-docs`

## Docs gaps

- **README.md**: scrub agentwrap prose (~lines 3310-3715), fix the line-1426 doc bug (`--agentwrap-preset` → `--x-preset`), track renamed identifier refs; line 1429 presets-hint stays (kept detector)
- **plugins/keeper/skills/dispatch/SKILL.md**: verify no residual agentwrap wording

## Best practices

- **Two-pass rename, never `sed -i 's/agentwrap/.../g'`:** symbol-rename with strings/comments off, then intentional literal/prose updates; a global replace corrupts frozen literals. [practice-scout]
- **Green tests are not sufficient signal:** a rename that rewrites a test assertion string in tandem passes while asserting the wrong thing — the frozen-anchor grep is the real guard. [practice-scout]
- **Fail-loud must survive the fallback:** the plugins reader throws only when both paths are absent; resolve-to-path keeps each reader's posture. [practice-scout]
