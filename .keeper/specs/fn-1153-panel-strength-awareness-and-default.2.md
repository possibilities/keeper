## Description

**Size:** S
**Files:** src/pair/panel.ts, src/agent/main.ts, test/pair-panel.test.ts, test/agent-panel-cli.test.ts

### Approach

Make the reserved name `default` resolve to the configured default panel at both resolution entry points, so `--panel default` and `presets resolve default` behave exactly like the no-argument default path. The name is load-reserved (no user panel or preset may take it), so the alias shadows nothing. Two sites, which do NOT share a resolver: (1) `resolvePanelMembers` in src/pair/panel.ts — normalize `name === "default"` to `selections.default` before the panels lookup; when `selections.default` is null, fail loud with a message that names what was typed (shape: `--panel default given but no default panel set in panel.yaml`), distinct from the existing no-flag guard message; (2) `runPresetsResolve` in src/agent/main.ts — same normalization after selections load, before the panels lookup (note a catalog preset lookup runs first there and `default` can never hit it — reserved). `presets resolve default` reports the resolved target panel's real name in its envelope (pointer dereference, git-HEAD style), not the literal `default`. Update the `resolvePanelMembers` docstring (an "unknown name" no longer includes `default`) and the PANEL_HELP `--panel` line to state `default` is an accepted alias for the configured default panel. Preserve every existing fail-loud invariant: unknown names still exit 2; no-flag with no configured default still exits 2.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/pair/panel.ts:298-345 — resolvePanelMembers + its docstring (the primary alias site; selections.default is a sibling field it currently never dereferences)
- src/pair/panel.ts:1055-1069 — panelStart's `args.panel ?? config.selections.default` caller and its null guard (the trap; the alias makes the explicit-flag path converge with this)
- src/agent/main.ts:1280-1346 — runPresetsResolve's independent inline resolution (second alias site, after selections load ~:1310, before the panels lookup ~:1321)
- src/agent/config.ts:327-346 and :583-599 — `default` in RESERVED_PRESET_NAMES; selections.default load-validated null-or-defined (the invariants that make the alias safe and non-looping)
- test/pair-panel.test.ts:368 and :394 — the absent-flag default test and the fail-loud test; your new cases mirror these
- Grep all `resolvePanelMembers` callers — the alias changes the resolver contract for every caller, not just panelStart

**Optional** (reference as needed):
- test/agent-panel-cli.test.ts:74,307,324,342 — existing `--panel default` fixtures that exit 2 via earlier gates (arg-split, config-missing, missing slug); audit that none assert a reserved-name-specific error string
- src/pair/panel.ts:1703-1740 — PANEL_HELP usage block (the `--panel <name>` help line to reword)

### Risks

- The two entry points drifting: an alias landed in only one leaves `presets resolve default` broken while `panel start --panel default` works — acceptance covers both
- A panel-of-one path regression: `--panel <preset-name>` (bare catalog preset as a 1-member panel) must keep working untouched

### Test notes

Pure-function tests in the existing style (panelStart with injected makeDeps({catalog, selections}), assertions on spawns[].argv; pure resolver cases near the resolveAdHocMember describe block). New cases: explicit `--panel default` resolves the configured default's members; `--panel default` with `default: null` exits 2 with the typed-name message; `presets resolve default` emits the resolved panel envelope; unknown panel name still exits 2. Root suite: `bun test` green.

## Acceptance

- [ ] `keeper agent panel start <prompt> --slug <s> --panel default` resolves the configured default panel's members (no exit 2) in the injected-deps test harness
- [ ] `keeper agent presets resolve default` emits the configured default panel's envelope, reporting the resolved panel's real name
- [ ] With no `default` configured, `--panel default` and `presets resolve default` exit 2 with a message naming `default` as what was typed; the no-flag guard message is unchanged
- [ ] Unknown panel/preset names still exit 2; bare-preset panel-of-one resolution is unchanged; root `bun test` suite is green

## Done summary
Aliased the reserved name 'default' to the configured default panel at both resolution entry points (resolvePanelMembers and runPresetsResolve), so '--panel default' and 'presets resolve default' resolve the default panel; null-default fails loud naming what was typed, and the resolve envelope reports the resolved panel's real name.
## Evidence
