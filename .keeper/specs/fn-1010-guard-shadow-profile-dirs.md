## Overview

Prevent the "Claude auth lands in the wrong config dir" collision that stranded a
real Max-20x account in `~/.claude-profiles/default/` (a dir nothing reads under the
"default" id, while "default" canonically resolves to `~/.claude`). Four moves, all
keeper-only: a reserved-profile-name guard at every profile-dir `mkdir` site; a fix
for the live multiplier split-brain (default's tier is read from the shadow today);
read-only shadow-dir detection (a `keeper agent profiles check` diagnostic + a narrow
`keeper usage` advisory); and a guided reconcile runbook. keeper's destructive-fs
surface stays at EXACTLY ZERO — no auto-move, no auto-delete (the only Max-20x login
currently lives in that shadow dir).

This is plank 2 of an effort; plank 1 (the usage TUI account-state surfacing) shipped
as fn-1006/fn-1007, so tracked-profile health is already visible — this plank adds the
UNTRACKED shadow-dir half plus the prevention guard.

## Quick commands

- `keeper agent profiles check` — lists shadow/stray/auth-bearing `~/.claude-profiles` dirs; exit 0 clean / 9 findings / 1 tool-error.
- `keeper agent profiles check --json | jq` — machine-readable findings (id + remediation per finding).
- `keeper usage` — an auth-bearing `default/` shadow surfaces a one-line advisory pointing at the check.
- `bun test test/agent-profile-bootstrap.test.ts test/usage-scraper-worker.test.ts`

## Acceptance

- [ ] No keeper code path can `mkdir ~/.claude-profiles/{"",default}` (or a path-escaping name) — guarded at all four mkdir sites, fail-loud (StateError → exit 1).
- [ ] `default`'s tier multiplier resolves from `~/.claude/.claude.json`, not the `~/.claude-profiles/default` shadow (boot + re-resolve).
- [ ] `keeper agent profiles check [--json]` reports shadow/stray/auth-bearing dirs read-only (never moves/deletes), with sane exit codes.
- [ ] `keeper usage` shows a narrow advisory for an auth-bearing `default/` shadow, computed in-process (no daemon round-trip).
- [ ] An operator reconcile runbook documents the manual re-home; keeper performs no fs mutation.
- [ ] Guard + detector cover BOTH claude (`~/.claude-profiles`) and pi (`~/.pi-profiles`); tests sandbox a tmp home.

## Early proof point

Task that proves the approach: `.1` (the reserved-name guard) — it ships the prevention
value alone and proves the shared `assertProfileDirNameAllowed` helper + the all-four-sites
placement. If the path-validation or a mkdir-site placement is wrong, it surfaces here
before the detector (task .2) builds on the shared reserved-name knowledge.

## References

- Panel-vetted design (Opus 4.8 + GPT-5.5): scope = guard + producer-fix + detect + guided runbook, NO automated reconcile.
- The "accepted edge" this closes: src/epic-deps.ts:95-98 (a profile basenamed `default` collides with the agentusage default on usage.id='default').
- Sibling shipped: fn-1007 surfaces tracked-profile health (signed_out / no_subscription) in `keeper usage` — so this plank's detection targets UNTRACKED shadow/stray dirs, not tracked health.
- Reserved-name precedent to mirror: RESERVED_PRESET_NAMES (src/agent/config.ts:307) + PRESET_NAME_PATTERN (:326) + validatePresetName (:346-356) — but the guard throws StateError (state layer, exit 1), NOT ConfigError (exit 2).
- Transition note (benign): once task .4 lands, signed-out `~/.claude` honestly resolves `default` to 1x/no-subscription (replacing the misleading 20x-from-shadow); it self-corrects when the operator re-auths `~/.claude` per the runbook. No harmful window.

## Docs gaps

- **src/agent/dispatch.ts**: add a "Profile diagnostics" block to AGENTWRAP_HELP (mirror "Preset resolution" ~:102-108) + `profiles check` to USAGE_HELP (:44-62). (task .2)
- **cli/usage.ts HELP (:54-107)**: add a narrow detection-hint line pointing at `keeper agent profiles check`. (task .3)
- **README.md presets block (~:1402-1420)**: add `keeper agent profiles check [--json]` alongside the presets commands. (task .2)
- **README.md producer section (~:2944-2962)**: note default's tier reads from `~/.claude`, not `~/.claude-profiles/default`. (task .4)
- **README.md `## Backup & restore` (~:3787)**: new `### Re-homing a stranded account` numbered runbook + explicit non-automation note. (task .4)
- **CLAUDE.md**: one imperative bullet — `""`/`default` profile names reserved + path-escape rejected; never hand-create `~/.claude-profiles/default`. (task .1)

## Best practices

- **Allowlist regex, not denylist**, and run the separator/`..`/null-byte checks as ATOMIC checks on RAW input BEFORE any `path.normalize` (normalize silently resolves `foo/../bar`→`bar`). [practice-scout]
- **Normalize NFC for validation/comparison but mkdir the ORIGINAL string** — macOS stores NFD, so writing a normalized name then `readdir` mismatches your own existence checks. [practice-scout]
- **Never leak the resolved absolute path** in the guard's user-facing error — only the name + reason. [practice-scout]
- **Doctor CLI**: stdout=data / stderr=prose, stable per-finding `id` + `remediation` (JSON doubles as runbook), summary line, and NEVER auto-fix. [practice-scout]
- **Safe JSON reads**: a parse/IO failure on a profile's `.claude.json` is a FINDING, not a crash — continue scanning; distinguish ENOENT from real IO; never log token contents. [practice-scout]
