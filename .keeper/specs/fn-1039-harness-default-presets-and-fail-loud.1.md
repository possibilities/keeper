## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/main.ts, src/agent/passthrough.ts, src/agent/run-capture.ts, src/agent/dispatch.ts, README.md, test/agent-config.test.ts, test/helpers/agent-main-harness.ts, test/agent-codex*.test.ts, test/agent-pi*.test.ts, test/agent-presets*.test.ts, test/agent-run-capture.test.ts

### Approach

One atomic contract change (the test-harness seam forces one commit). Steps:

1. **Catalog pointer keys (config.ts).** Extend `ALLOWED_CATALOG_KEYS` (~374) with `claude_default`/`codex_default`/`pi_default`; add them to `PresetCatalog` (~255-257). In `loadPresetCatalog` (~400-419) parse each as an optional string, exempt from `validatePresetName` (mirror the `default` structural-key precedent ~477-492), and STRICT-validate: each must name a defined preset whose harness matches the key prefix — fail-loud (ConfigError, message shape mirroring `resolvePreset` ~502-516: file + key + offending harness + expected). Keep them TOP-LEVEL siblings of `presets:` so they never collide with the `worker` preset key.
2. **Delete the yaml loaders.** Remove `loadLauncherDefaults` + `loadPiLauncherDefaults` (config.ts ~129-181; keep shared `readMapping`/`isFile`/`value`). Remove `loadLauncherDefaultsFn`/`loadCodexLauncherDefaultsFn`/`loadPiLauncherDefaultsFn` from `MainDeps` (main.ts ~152-166) + `realDeps` (~238-243).
3. **Resolution + fail-loud (main.ts).** At the resolvedPreset anchor (~1481-1503): when no `--x-preset`/dispatch preset, fall back to `catalog.<harness>_default` → `resolvePreset`. In the three branches (codex ~1721 / claude ~1882 / pi ~1932) drop the `?? yamlModel/Effort/Thinking` layer. Add the fail-loud gate: on a FRESH launch (NOT `hasContinueOrResume`, NOT `shouldPassthrough`; `hasPrint` IS fresh) where the final resolved model OR effort/thinking is null and not supplied explicitly → `deps.writeErr("Error: ...")` + `deps.exit(2)`. Per-field (both-or-neither emergent). Self-healing message names the key + flag alternative, not the chain order.
4. **Explicit-escape legs (reuse passthrough helpers, do NOT duplicate).** claude: model=`hasExplicitModelArg`, effort=`hasExplicitEffortArg` OR `CLAUDE_CODE_EFFORT_LEVEL` env. codex: model=`hasExplicitCodexModelArg`, effort=`hasExplicitCodexEffortArg`, and `--profile` (`hasExplicitCodexProfileArg`) EXEMPTS codex. pi: model=`hasExplicitModelArg` OR colon-shorthand, thinking=`hasExplicitThinkingArg` OR colon-shorthand.
5. **Pi `:thinking` shorthand helper (passthrough.ts — NEW, none exists today).** Extract the `--model` value (split `--model x` + joined `--model=x`), split on the LAST `:`, and if the suffix is a valid pi thinking token (off/minimal/low/medium/high/xhigh) treat it as thinking-supplied: satisfies the escape leg AND suppresses the default-`--thinking` injection (pi parses `:thinking` from `--model` itself, so keeper must not add a conflicting `--thinking`). NOTE: passthrough.ts is also edited by fn-1038.2 — coordinate on the shared file.
6. **run-capture (run-capture.ts ~136-145).** Drop the stale `preset > yaml` tier from the run/wait-capture overlay; apply the same fail-loud (uniform `bad_args`/exit-2 envelope) when a bare `keeper agent run`/`wait` resolves nothing.
7. **Docs (prune, present-tense, no provenance).** config.ts module JSDoc (~1-18) + the deleted loader docstrings + `Preset` JSDoc (~235-239); main.ts precedence comments (~1725/1886/1935 — drop the yaml tier); dispatch.ts `KEEPER_AGENT_HELP` (~110-167, hold col-34 indent); README presets block (~1399-1463 — drop yaml tier at ~1449, add pointer-key + harness-prefix sentence, consolidate).
8. **Test-seam migration (ATOMIC).** Remove the 6 `launcher*` option fields + 3 `load*LauncherDefaultsFn` dep stubs from `agent-main-harness.ts` (~76-83/152-165); migrate the ~34 call-sites (agent-codex/agent-pi/agent-presets/agent-profile-bootstrap) passing `launcherModel:`/`piLauncherThinking:` → a `presetCatalog` carrying a `<harness>_default`. Delete the `loadLauncherDefaults`/`loadPiLauncherDefaults` describe blocks (agent-config.test.ts ~45-99) + the per-harness reader block (~387-411). Add `<harness>_default` valid/invalid/harness-mismatch cases (~132-264 style). Add fail-loud exit-2 tests (mirror agent-run-capture.test.ts ~845-857): bare fresh → exit 2; lone `--model` → exit 2; `--model`+`--effort` → ok; resume → no fail-loud; `pi --model id:xhigh` → ok.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts — `ALLOWED_CATALOG_KEYS` (~374), `rejectUnknownKeys` (~377-390), `loadPresetCatalog` (~400-419), `parsePreset` (~335-371), `resolvePreset` (~502-516), `PresetCatalog` (~255-257), the `default` structural-key exemption (~477-492), `loadLauncherDefaults`/`loadPiLauncherDefaults` (~129-181)
- src/agent/main.ts — resolvedPreset anchor (~1481-1503), three branches (~1721 codex / ~1882 claude / ~1932 pi), gating signals `hasContinueOrResume` (~1470/1505-1509) / `hasPrint` / `shouldPassthrough` (~1544-1558), MainDeps (~152-166) + realDeps (~238-243), early run/wait-capture dispatch (~1341-1345), `resolveCodexStartupModelOverride`/`EffortOverride` (~416-434)
- src/agent/passthrough.ts — `hasExplicit*` + `resolveStartup{Model,Effort,Thinking}Override` (~261-397); `hasExplicitModelArg` value-blindness (~294)
- src/autopilot-worker.ts — `resolveWorkerLaunchConfig` ConfigError→constants swallow (~345-369) — use `grep -a`
- src/agent/run-capture.ts — capture parser + stale `preset > yaml` comment (~136-145)
- test/helpers/agent-main-harness.ts — the seam (~76-83/152-165); test/agent-config.test.ts (~45-99, ~132-264, ~387-411); test/agent-run-capture.test.ts (~845-857) exit-2 pattern; test/agent-byte-pin.test.ts (~253-263) fixture shape

### Risks

- **autopilot-worker swallow masks a bad default:** a strict dangling `<harness>_default` throwing in `loadPresetCatalog` makes `resolveWorkerLaunchConfig` fall to `WORKER_MODEL`/`WORKER_EFFORT` — invisible on the unattended path. Accepted (loud on interactive); do NOT add a strict/lenient distinction inside the worker.
- **Test-seam is atomic-or-broken** — a half-removed `MainDeps` field breaks TS compile; land in one commit.
- **`scripts/lint-retired-name.sh` Check B** count-pinned files FAIL on token-count drift — verify the loader deletions don't touch a pinned file.
- **passthrough.ts overlaps fn-1038.2** — coordinate on the shared file (epic dep sequences it).

### Test notes

- `bun test` in-process (no daemon/subprocess). shellcheck N/A (no shell here); `bun scripts/lint-claude-md.ts` only if CLAUDE.md changes (it should not).
- Exit-2 via `deps.writeErr` + `deps.exit(2)`; `throwingExit` in the harness turns it into a catchable throw (`expectExit`).

## Acceptance

- [ ] `claude_default`/`codex_default`/`pi_default` accepted as top-level keys, each strict-validated to name a defined preset with matching harness (fail-loud otherwise); `worker` preset + `presets:` unaffected
- [ ] `loadLauncherDefaults` + `loadPiLauncherDefaults` + their 3 `MainDeps`/`realDeps` fns removed; no `claude.yaml`/`codex.yaml`/`pi.yaml` model/effort/thinking read remains
- [ ] Fresh launch (interactive + `--print` + codex `exec`/`review` + bare `keeper agent run`) with no `--x-preset`, no `<harness>_default`, not both-explicit → exit 2 with a self-healing message (names the key + flag); `--continue`/`--resume` + passthrough exempt
- [ ] Both-explicit escape: claude (`--model` + `--effort`/env), codex (`--model` + `-c` effort OR `--profile`), pi (`--model` + `--thinking` OR `--model id:<thinking>`)
- [ ] pi `--model <id>:<thinking>` counts as thinking-supplied AND suppresses the default-`--thinking` injection (no conflicting flag)
- [ ] run-capture drops the yaml tier + honors fail-loud (`bad_args` exit 2)
- [ ] Docs pruned present-tense (config.ts JSDoc, main.ts precedence comments, `KEEPER_AGENT_HELP`, README presets block) — no yaml-tier reference remains
- [ ] Test-seam migrated in one commit; `bun test` green; `lint-retired-name`/`lint-claude-md` clean

## Done summary

## Evidence
