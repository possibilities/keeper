## Description

**Size:** M
**Files:** src/keeper-state-dir.ts (new), src/pair/panel.ts, test/agent-panel-cli.test.ts

### Approach

Add a dep-free `keeperStateDir()` mirroring `keeperConfigDir()` (src/agent/config.ts:70):
`KEEPER_STATE_DIR` env override else `join(homedir(),".local","state","keeper")` —
keeper's deliberately-non-XDG convention (src/usage-picker.ts:53); do NOT reuse the
XDG-honoring `defaultKeeperAgentStateDir`/`keeper-agent` dir. In `panelStart`
(src/pair/panel.ts:613), when `--dir` is absent derive the dir as
`keeperStateDir()/panels/<slug>/` (mkdir 0700) instead of the random tmpdir (:676);
`--dir` stays a location override (task .2 threads the full machinery through both).
Stamp `boot_epoch_ms = deps.now() - os.uptime()*1000` into the manifest and add a
`deps.bootEpochMs`/thread `deps.now` seam (panelStart does not read the clock today).
Persist a per-leg `launched_at` and reorder to write the manifest SKELETON (members +
boot_epoch + generation 1 + intended pidfile/yaml paths) BEFORE the spawn loop, then
update each entry post-spawn — preserving the current spawn-throw→`pidfile:null` signal
(:715, consumed at :504) while making a crash mid-fan-out reconstructable. Extend
`parseManifest` (:549) to validate `boot_epoch_ms` (number) and per-leg `launched_at`,
mirroring the `slug` guard (:559). Update the header import-island comment (:26-28) for
the new `src/keeper-state-dir` import; keep bun:sqlite out.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:70 — keeperConfigDir(), the exact env-override-else-home shape to mirror
- src/usage-picker.ts:53 — why ~/.local/state (non-XDG); src/agent/tmux-launch.ts defaultKeeperAgentStateDir — the XDG one to NOT reuse
- src/pair/panel.ts:613,665,676,681,704-728,549,120 — panelStart, --dir vs mint branches, prompt.md write, manifest write + PanelManifest shape, parseManifest, the slug field
- src/pair/panel.ts:26-28,157-173 — the dep-free import-island comment + PanelDeps seams (now/sleep/pidAlive) to extend
- src/agent/cwd-ordinal.ts:1-90 — fail-open state-dir + one-time rename-migration precedent

**Optional** (reference as needed):
- src/pair/panel.ts:437 writeFileAtomic (reuse for the manifest + sentinel writes)

### Risks

- Writing to a real state dir in tests pollutes ~/.local/state — the test seam MUST override the root via KEEPER_STATE_DIR (sandboxEnv) or a PanelDeps field.
- os.uptime() is not injectable — without a bootEpochMs/now seam, reboot cannot be tested deterministically.
- Manifest-before-spawn must still record a per-leg spawn-throw (don't lose the pidfile:null launch-failed signal).

### Test notes

- Assert the dir is `keeperStateDir()/panels/<slug>/` (via KEEPER_STATE_DIR sandbox), the manifest carries `boot_epoch_ms` + per-leg `launched_at`, and parseManifest round-trips + rejects a malformed boot_epoch. Mirror makeDeps/makeAdHocDeps (test/pair-panel.test.ts:80, test/agent-panel-cli.test.ts:366) + sandboxEnv (:50).

## Acceptance

- [ ] `keeperStateDir()` is a dep-free leaf mirroring keeperConfigDir (KEEPER_STATE_DIR env, non-XDG ~/.local/state/keeper)
- [ ] `start` without `--dir` writes to `~/.local/state/keeper/panels/<slug>/` (0700); manifest carries `boot_epoch_ms` + per-leg `launched_at`; skeleton written before spawn with the spawn-throw signal preserved
- [ ] `parseManifest` validates the new fields; a `deps.bootEpochMs`/`now` seam makes boot-epoch injectable
- [ ] panel.ts stays bun:sqlite-free; import-island comment updated; lint + typecheck + test green

## Done summary

## Evidence
