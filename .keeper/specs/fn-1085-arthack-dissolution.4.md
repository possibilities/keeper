## Description

**Size:** S
**Files:** scripts/ (clean-machine check script), README.md, docs/plugin-composition-map.md, ~/.config/keeper (gate flip — config only, no source)

### Approach

Prove the end state and land it here. Scripted check (manual/CI tool, not the fast tier):
simulated fresh environment (scratch HOME + config dir, no arthack checkout reachable) →
installer writes the keeper-only plugins.yaml → `keeper agent claude` passthrough boots →
prompt renders resolve from the vendored subset → worker argv carries the permission flags
and (gate ON) no third-party plugins. Then flip the isolation gate ON in THIS machine's
launcher config and verify the next real worker launch argv (observe, don't force a
dispatch). Update README + composition map: arthack is an optional plugin; document the
opt-back-in (append the scan dir to your own config).

### Investigation targets

**Required** (read before coding):
- scripts/ensure-plugin-config.ts + scripts/install.sh — the fresh-machine write path being proven
- The .3 gate knob location — flipped here

### Risks

- The scratch-environment probe must not touch the real ~/.config/keeper or the live daemon state (sandbox env vars throughout).

### Test notes

The check script IS the deliverable proof; keep it re-runnable and side-effect-free outside its scratch dirs.

## Acceptance

- [ ] Clean-machine script passes end to end with no arthack checkout
- [ ] Gate ON for this machine; a real worker launch verified isolated
- [ ] Docs updated (optional-plugin story + opt-in recipe)

## Done summary

## Evidence
