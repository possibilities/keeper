## Description

**Size:** S
**Files:** src/agent/config.ts, test/agent-config.test.ts

### Approach

loadPresetCatalog augments the parsed presets.yaml catalog in memory with one
`<provider>-<model>` preset per roster pair from the matrix (harness + native model id, no
second axis — effort arrives per-run through the descriptor map). Nothing is ever written
to presets.yaml. A hand-authored preset colliding with an auto-generated name is a
fail-loud ConfigError, as is a collision with RESERVED_PRESET_NAMES. Widen
PRESET_NAME_PATTERN to admit dots (no leading dot) so dotted capability tokens like
gpt-5.5 form valid preset names. Absent matrix → catalog unchanged. Auto-presets are
full catalog citizens: panel validation, pair, and the <harness>_default pointers may
reference them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/config.ts:277-347 — Preset shape, PRESET_NAME_PATTERN, RESERVED_PRESET_NAMES
- src/agent/config.ts:456-481 — loadPresetCatalog merge point

**Optional** (reference as needed):
- src/agent/config.ts:534-602 — loadPanelSelections cross-validation consuming the catalog

### Risks

- The widened name charset touches every preset-name validation site; keep the leading-dot
  rejection so no preset name reads as a hidden file.

### Test notes

Fixture matrix + presets.yaml pairs: auto-preset resolution, collision fail-loud, dotted
names accepted, leading dot rejected, existing corpora still load, absent matrix is a no-op.

## Acceptance

- [ ] With a fixture roster the catalog exposes resolvable <provider>-<model> presets for
      every roster pair, visible to presets resolve and panel validation.
- [ ] A hand-authored preset colliding with an auto-generated name fails loud at load.
- [ ] Dotted preset and model tokens validate; leading-dot tokens are rejected; existing
      presets.yaml corpora keep loading unchanged.

## Done summary

## Evidence
