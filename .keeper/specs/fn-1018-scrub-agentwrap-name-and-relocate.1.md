## Description

**Size:** S
**Files:** scripts/frozen-allowlist.txt, test/lint-retired-name.test.ts, scripts/lint-retired-name.sh (only if a count-lock token param is needed)

### Approach

Extend the existing fn-889 frozen-allowlist + guard to cover the `agentwrap` survivors that must outlive the sweep. The guard's Check A (`anchor|<relpath>|<exact-substring>`) is token-agnostic — it greps (grep -F) that each anchored literal still appears verbatim — so adding `anchor|` records for the agentwrap freeze set protects them with no script change. Add anchors for: the cross-process env-var name strings (`AGENTWRAP_PROFILE`, `AGENTWRAP_CLAUDE_PROFILE`, `AGENTWRAP_CODEX_PROFILE`, `AGENTWRAP_PI_PROFILE`, `AGENTWRAP_TMUX_SESSION_ID`, `AGENTWRAP_SKIP_LINK_GUARD`, `AGENTWRAP_SHELL`, and the `startsWith("AGENTWRAP_")` prefix filter) at their defining sites; the `~/.local/state/agentwrap` state-dir path literal; the `legacyAgentwrapPresetsPath` `~/.config/agentwrap/presets.yaml` path; and the retired-alias test literals (`agentwrap_path`, `KEEPER_AGENTWRAP_PATH`, `agentwrapPath`) in test/config.test.ts. Update the allowlist header to note it now also covers the agentwrap retirement. Add fixture test cases (mirroring the existing planctl ones) asserting an agentwrap anchor fails-on-clobber. Do NOT anchor the fallback literals or the renamed fixture yet — those land with the tasks that create them (.3 appends the fallback anchors).

### Investigation targets

**Required** (read before coding):
- scripts/lint-retired-name.sh:1-60 — Check A/B mechanics; confirm anchor matching is grep -F (token-agnostic)
- scripts/frozen-allowlist.txt — record format (`anchor|`/`count|`/`exempt|`) + existing planctl anchors to mirror
- test/lint-retired-name.test.ts:1-90 — fixture-test harness (the `KEEPER_RETIRED_NAME_REPO_ROOT` override)
- src/agent/main.ts:332-340 (agentProfileEnvName env strings), src/agent/tmux-launch.ts:360-365,678-679,827,843,847, src/agent/state-sharing.ts:660,688, src/agent/config.ts:101-104, test/config.test.ts:51-58 — the exact survivor literals to anchor

**Optional** (reference as needed):
- docs/plan-name-retirement.md — how the guard is documented

### Risks

- Anchoring a literal whose exact substring differs from the source (whitespace/quoting) → guard false-positive. Copy the substring verbatim from the file.
- Over-anchoring a renamable token would block the legit sweep in .2. Anchor ONLY the frozen survivors enumerated here.

### Test notes

`bash scripts/lint-retired-name.sh` exits 0 on the clean tree; the new fixture tests prove an agentwrap anchor clobber exits 1. `bun test test/lint-retired-name.test.ts` green.

## Acceptance

- [ ] frozen-allowlist.txt carries `anchor|` records for every agentwrap survivor (env-var family, the `AGENTWRAP_` prefix filter, state-dir path, legacy presets path, retired-alias test literals)
- [ ] `bash scripts/lint-retired-name.sh` exits 0 on the current tree
- [ ] New fixture test asserts an agentwrap anchor clobber is caught (exit 1)
- [ ] `bun test` green; no production code renamed in this task

## Done summary

## Evidence
