## Description

**Size:** S
**Files:** src/agent/config.ts, scripts/install.sh, README.md

### Approach

Ship a keeper-owned default launch config so `keeper agent` runs without arthack's stow package:
install.sh writes a default ~/.config/keeper/plugins.yaml when the file is absent, containing
keeper's two plugin_dirs (plugins/keeper, plugins/plan) and no arthack scan dirs. Decision
already made (observe-now): existing machines keep their current file untouched — the default
applies only where no file exists. Update the loadPluginSources ConfigError message
(src/agent/config.ts:8-60) to stop prescribing arthack's install as the recovery; name the
install.sh step or the file to create instead. Collapse README's "Load the plugins" manual step
accordingly.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:8-60 — loadPluginSources + ConfigError text
- scripts/install.sh — where the default-write step lands
- The live ~/.config/keeper/plugins.yaml — a symlink into arthack today; the installer must not clobber an existing file OR symlink

### Risks

- Never overwrite an existing plugins.yaml (file or symlink) — presence check must treat a symlink as present even if dangling.

### Test notes

Unit-test the default-write decision through a pure seam (present/absent/symlink cases);
manual proof: move the real file aside, run install.sh, `keeper agent claude --help` boots.

## Acceptance

- [ ] Fresh machine (no plugins.yaml): install.sh writes the keeper-only default and keeper agent launches
- [ ] Existing file or symlink: installer leaves it byte-untouched
- [ ] ConfigError recovery text references keeper's own install path, not arthack's stow

## Done summary

## Evidence
