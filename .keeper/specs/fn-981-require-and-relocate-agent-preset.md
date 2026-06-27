## Overview

Relocate the agent launch-config out of the hardcoded `~/.config/agentwrap/presets.yaml`
into `~/.config/keeper/`, split it into two purpose-scoped files — `presets.yaml` (the
catalog of possible presets) and `panel.yaml` (which presets each panel assembles) — and
REVERSE the fail-open posture: a preset referenced by name (`keeper pair --preset`,
`keeper dispatch --preset`, `keeper agent --agentwrap-preset`) or any panel operation now
hard-fails (exit 2) on a missing or invalid config. There is NO pair config — pairing uses
`--preset <catalog-name>`. The autopilot worker is the one deliberate fail-open carve-out
(coalesces to `sonnet`/`max` so the daemon never crashes on bad config). Agents discover
available presets via `keeper agent presets list`, surfaced in skills / advice / `--help`
so they reference real preset names.

## Quick commands

- `keeper agent presets list` — enumerate configured catalog presets + panels
- `keeper agent presets resolve <name>` — resolved preset/panel JSON (existing contract)
- `keeper agent --agentwrap-preset claude-opus-xhigh '/p'` — hard-fails exit 2 if catalog missing/invalid
- `bun run test:full` — mandatory; touches launcher/daemon/worker + argv-pin + import-graph guards

## Acceptance

- [ ] Two files under `~/.config/keeper/` — `presets.yaml` (catalog) + `panel.yaml` (panel selections) — read ONLY by the dep-free `src/agent/config.ts` island; bundle-grep import-graph guards stay green (launcher never reaches `src/db.ts`).
- [ ] `keeper pair --preset X`, `keeper dispatch --preset X`, `keeper agent --agentwrap-preset X`, and every panel op hard-fail exit 2 with a specific message (file path + bad name + sorted available names) on a missing/invalid catalog or panel file; the legacy `opus`+`codex` panel fallback is removed; there is no `pair.yaml`.
- [ ] Autopilot worker launch stays fail-open — coalesces to `sonnet`/`max` when the catalog or `worker` preset is absent (the sole carve-out); the daemon never crashes on bad config.
- [ ] Bare `keeper pair` with no `--preset` needs no config (legacy `--cli/--model/--effort` path unchanged).
- [ ] `keeper agent presets list` discovers catalog presets + panels; pair / dispatch / panel skills + their `--help`/`--agent-help` point agents at it; no static preset-name lists that rot.
- [ ] Single `KEEPER_CONFIG_DIR` env seam (derives both paths) replaces `KEEPER_PRESETS_CONFIG`; clean cutover with a migration hint naming the leftover `~/.config/agentwrap/presets.yaml`.

## Early proof point

Task that proves the approach: `fn-N.1` — split the island + reverse the posture while BOTH
the dep-free import-graph guard AND the autopilot worker fail-open carve-out still hold. If
they cannot co-exist (the worker's catalog read drags a required-file throw into the daemon),
recover by giving the worker a separate catalog-only loader whose missing-file path returns
constants directly rather than throwing.

## References

- `fn-937-agent-launch-config-presets` (landed) — introduced the single `presets.yaml` registry + the presets/panels/pair/dispatch/autopilot consumers this epic relocates, splits, and hardens.
- `src/db.ts:229` `resolveConfigPath()` — the existing `~/.config/keeper/` + env resolver pattern. It lives in the SQLite island, so the dep-free `config.ts` CANNOT import it — parallel the pattern in a new island-local `keeperConfigDir()`.
- `~/.config/keeper/config.yaml` already exists (governed by `KEEPER_CONFIG` in `db.ts`); the two new files are peers in that dir under a separate env convention.

## Docs gaps

- **README.md** (~line 1371): rewrite the presets section — two files under `~/.config/keeper/`, required+validated posture, worker fail-open as the sole exception; drop the "fail-open on missing" / "fail-SAFE swallowed-to-constants" framing for the user surfaces.
- **src/agent/config.ts** (~lines 1-13 header): replace the agentwrap paths + absence semantics in place (rule #0: prune, don't narrate history).
- **plugins/keeper/skills/{pair,dispatch}/SKILL.md**: new path, exit-2 conditions, `presets list` discovery.
- **plugins/plan/skills/panel/references/panel.md** (~44-47): delete the "Zero-config fallback" section; **plugins/plan/agents/panel-runner.md** (~74/87): name the new file + add the missing/invalid-config exit-2 condition.

## Best practices

- **Name the file + the bad name + the sorted available names** in every fail-loud message (dbt pattern); never a generic "not found" — `resolvePreset` already does this, extend it to panel/selection misses. [dbt profiles]
- **The fail-open carve-out uses hardcoded constants**, never a fallback YAML or last-known-good cache (circular + TOCTOU). [Temporal/Azure resilience]
- **No back-compat shim** — clean cutover; the first post-cutover run emits an explicit migration hint naming the old path and the new layout. [buf/NuGet migration UX]
