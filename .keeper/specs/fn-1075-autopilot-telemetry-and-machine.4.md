## Description

**Size:** M
**Files:** README.md or docs/ (composition map), CLAUDE.md (worker-launch sentence), src/agent/main.ts (comment-level), scripts/ or test/ (composition assertion)

### Approach

Observe-now scope (the gate decision is the dissolution study's). Document the plugin
composition per launch channel as verified reality: interactive + keeper-agent launches load
plugins.yaml (keeper + plan + arthack incl. its 8-sub-hook PreToolUse dispatcher with blanket
auto-approve and uv/pnpm command rewrites, PostToolUse command_advice, UserPromptSubmit
reminders); autopilot workers ALSO inherit the full plugins.yaml because agent/main.ts:2194-2222
gates discovery only on agent==="claude" with no worker gate — the per-cell --plugin-dir
(exec-backend.ts:874-876) is additive, not isolating. Correct the root CLAUDE.md worker-launch
sentence to this reality. Add a cheap standing assertion (test or script) that derives the
per-channel plugin set from config+code so the map cannot silently rot. Document the
logged-vs-executed skew: events-writer logs the ORIGINAL command (events-writer.ts:829-830)
while arthack's updatedInput changes what executes — state it in the forensics snippet/doc so
miners stop misreading rewritten commands as typed. Run the lint_failed spike forensics: 125
lint_failed on 2026-07-02 vs 5-18/day baseline (60 in keeper) — mine events read-only for the
failing linter/file clusters, identify the root cause, fix it if it is a one-line config/lint
issue, otherwise file the finding in the epic's Done summary with evidence. Do NOT add
pre-linting; commit-work stays the single lint seam.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:2194-2222 + src/agent/plugins.ts — the discovery gate reality
- src/exec-backend.ts:870-876 — worker flag assembly
- plugins/keeper/plugin/hooks/events-writer.ts:802,829-830 — original-command logging
- ~/.local/state/keeper/keeper.db (readonly) — lint_failed rows for the spike window

### Risks

- This task changes documentation + adds observation; any behavior change to plugin loading is out of scope (study territory) — resist the pull.

### Test notes

The composition assertion runs in the fast tier without booting anything (derive from config
parsing + flag-assembly seams).

## Acceptance

- [ ] Composition map documents all channels with file:line grounding; CLAUDE.md sentence corrected
- [ ] Standing assertion pins the per-channel plugin set; logged-vs-executed skew documented in the forensics surface
- [ ] lint_failed spike root-caused with evidence (fixed if trivial, filed if not)

## Done summary
Documented plugin composition per launch channel (docs/plugin-composition-map.md) with file:line grounding: every claude launch — interactive AND autopilot worker — inherits the full plugins.yaml (keeper+plan+arthack) via the sole agent==='claude' gate (main.ts:2194); the per-cell --plugin-dir is additive, not isolating. Corrected the CLAUDE.md worker-launch sentence, annotated the discovery gate + the events-writer logged-vs-executed skew (stored data=typed command, arthack rewrites what runs). Standing test test/plugin-composition-map.test.ts pins the config-parse and flag-assembly seams. lint_failed spike forensics: NOT a lint regression — a measurement artifact. Events carry ZERO genuine commit-work lint_failed envelopes (0/787k); every count is a substring proxy. 2026-07-02 had 146 mentions of which 89 (61%) co-occur with fn-1062/fn-1075, two epics literally scoped around commit-work lint failures; baseline days show 0 meta-epic co-occurrence. No code fix applies (filed, not fixed).
## Evidence
