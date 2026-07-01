## Overview

Make a named preset the single source of every `keeper agent <harness>` session's
default model/effort/thinking. `presets.yaml` gains `claude_default` /
`codex_default` / `pi_default` pointer keys; the per-harness
`claude.yaml`/`codex.yaml`/`pi.yaml` model/effort/thinking readers are retired;
and resolution flips FAIL-LOUD on a fresh launch that resolves nothing (unless
the caller passed both model + effort/thinking, or is resuming/passthrough).
Presets are renamed to a harness-prefixed convention
(claude-opus/claude-sonnet/codex-gpt/pi-gpt). End state: `claude.yaml` is gone and
a bare `keeper agent claude` with no configured default errors loudly instead of
silently falling back to the agent's native settings.

**Rollout — ordering matters (operator-run; the live `~/.config/keeper` files are
hand-maintained, not repo-tracked).** The code (task 1) lands + the binary
reinstalls FIRST — the current binary strict-rejects the new top-level keys. THEN
the operator, in ONE sitting: renames the presets in `~/.config/keeper/presets.yaml`
(opus→claude-opus, sonnet→claude-sonnet, gpt→codex-gpt; pi-gpt already conforms),
updates `panel.yaml` members (duo/trio), adds `claude_default: claude-opus` /
`codex_default: codex-gpt` / `pi_default: pi-gpt`, deletes the now-inert stowed
`claude.yaml` (arthack stow source + re-stow to clear the `~/.config/keeper/claude.yaml`
symlink), then smoke-tests. Between reinstall and the presets edit the operator's
own fresh launches fail-loud (no default yet) — hence one sitting. The `worker`
preset name is NOT renamed (autopilot resolves it by the literal key
`catalog.presets.worker`).

## Quick commands

- `keeper agent presets list` — the four renamed presets (+ the `_default` pointers post-rollout)
- `keeper agent presets resolve claude-opus` — resolves the renamed default
- `keeper agent claude --print "hi"` with no default configured → exit 2, self-healing error
- `keeper agent claude --model opus --effort xhigh --print "hi"` → launches (both-explicit escape)
- `keeper agent pi --model gpt-5.5:xhigh --print "hi"` → launches (pi colon-shorthand escape)

## Acceptance

- [ ] `claude_default`/`codex_default`/`pi_default` parse + strict-validate (name a defined preset with matching harness); per-harness yaml readers gone; `worker` + `presets:` unaffected
- [ ] Fresh launch (interactive + `--print` + codex `exec`/`review` + bare `keeper agent run`) with no resolvable default and not both-explicit → exit 2 with a self-healing message; `--continue`/`--resume` + passthrough exempt
- [ ] Both-explicit escape per harness incl. claude effort-env, codex `--profile`, and pi `--model id:<thinking>` shorthand
- [ ] Presets renamed harness-prefixed + `panel.yaml` + the three `_default` keys (operator rollout); `worker` untouched
- [ ] `claude.yaml` deleted end-to-end; `bun test` green

## Early proof point

Task `1` IS the whole code change — atomic because the test-harness seam removal
(dropping the launcher-default `MainDeps` fields) breaks TS compile if partial. If
it stalls (the fail-loud gate mis-categorizes a launch mode, or the seam won't
compile), recover by landing the `<harness>_default` resolution + yaml-loader
deletion first and gating the fail-loud behind a follow-up once the launch-mode
signals (`hasContinueOrResume`/`hasPrint`/`shouldPassthrough`) are proven.

## References

- `src/agent/config.ts` — `ALLOWED_CATALOG_KEYS` (~374), `loadPresetCatalog` (~400-419), `parsePreset` (~335-371), the `default` structural-key exemption precedent (~477-492), `loadLauncherDefaults`/`loadPiLauncherDefaults` (~129-181, to delete)
- `src/agent/main.ts` — resolvedPreset anchor (~1481-1503), the three branches (~1721 codex / ~1882 claude / ~1932 pi), gating signals (~1470/1505-1509/1544-1558)
- `src/agent/passthrough.ts` — the `hasExplicit*`/`resolveStartup*` helpers to reuse (~261-397); the new pi `:thinking` helper
- Decision: strict-in-catalog `<harness>_default` validation — the autopilot-worker `ConfigError`→constants swallow (`src/autopilot-worker.ts:345-369`) masks a dangling default on the unattended path, accepted because it is loud on interactive launches
- Decision: fail-loud is per-field (both-or-neither emergent), fresh-only, with claude effort-env + codex `--profile` counting as explicit
- Overlap: fn-1038 also edits `src/agent/passthrough.ts` — sequenced via an epic dep, not a behavioral one

## Docs gaps

- **README.md (~1399-1463)**: drop the `per-harness yaml` precedence tier (~1449); add the `<harness>_default` pointer-key + harness-prefixed-naming sentence — consolidate, don't append
- **src/agent/config.ts (module JSDoc ~1-18, `Preset` JSDoc ~235-239, the deleted loader docstrings)**: drop the per-harness yaml enumeration + "layers OVER yaml" framing
- **src/agent/main.ts precedence comments (~1725/1886/1935)**: drop the `yaml` tier from `explicit>env>preset>yaml>native`
- **src/agent/dispatch.ts `KEEPER_AGENT_HELP` (~110-167)**: the `--x-preset` block + `presets list/resolve` — a preset/`<harness>_default` is required on a fresh launch; hold the column-34 indent

## Best practices

- **Self-healing error text:** name the exact key to set AND the flag alternative ("Set `claude_default` in presets.yaml, or pass `--model X --effort Y`"); do not hard-code the precedence order into the text. [practice-scout]
- **Validate cross-references at load, not lazily at dispatch:** a dangling `<harness>_default` (or panel member) is caught at catalog load. [practice-scout]
- **Binary-before-config rollout:** the parser that accepts the new keys must ship before the config uses them (config-ahead-of-binary is an unfixable startup error). [practice-scout]
