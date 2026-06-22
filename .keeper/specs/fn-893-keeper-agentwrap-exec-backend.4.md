## Description

**Size:** S
**Files:** README.md, docs/exec-backend.md, plugins/keeper/skills/dispatch/SKILL.md, test/exec-backend.test.ts

Bring docs to the landed state and pin the cross-repo contract with a
byte-fixture, then run the full test gate.

### Approach

- **Drift-guard fixture:** add a byte-pinned fixture of agentwrap's actual one-line launch JSON (`schema_version:1` + `session`/`windowId`/`paneId` + `transcriptPath:null`) and assert keeper's parser consumes it and that the `TMUX_EXIT` 1/2/3/4 mapping matches agentwrap's landed taxonomy. This is the cross-repo drift guard (the JSON/exit-code contract has no shared module). Capture the fixture from agentwrap's real output, not hand-authored, so drift is detectable.
- **Docs (forward-facing, revise not append):** README `## Config` (valid `exec_backend` values + `agentwrap_path` + YAML example) and `## Architecture` (drop "tmux is the sole backend"); docs/exec-backend.md (name both backends; convert the "Extending to a new backend" guide to current-state how-it-works); dispatch SKILL.md lines 4,21 ("tmux window" → "managed window").
- **Full gate:** run `bun run test:full` (this epic touches daemon/worker/db/exec paths — the fast tier does not cover them).

### Investigation targets

**Required:**
- test/exec-backend.test.ts — existing JSON/argv assertion patterns to extend with the fixture.
- README.md `## Config` (~343-381) + `## Architecture` (~2645,2734).
- docs/exec-backend.md:4,21-45,256-278.
- plugins/keeper/skills/dispatch/SKILL.md:4,21.

### Risks

- docs/exec-backend.md overlaps open epic fn-887 (rebase if it lands first).
- The fixture must be captured from agentwrap's real stdout (a hand-authored fixture that drifts from reality defeats the guard).

### Test notes

`bun run test:full` must be green. The fixture test fails loudly if agentwrap's JSON/exit-code contract drifts.

## Acceptance

- [ ] A byte-pinned agentwrap-stdout fixture guards keeper's JSON parser + the exit-code map; it fails on contract drift.
- [ ] README, docs/exec-backend.md, and dispatch SKILL.md reflect the two-backend reality (forward-facing, revised not appended).
- [ ] `bun run test:full` is green.

## Done summary
Pinned the cross-repo agentwrap JSON/exit-code contract with a byte-captured stdout fixture + drift-guard tests, and revised README, docs/exec-backend.md, and the dispatch SKILL.md to document the two-backend (tmux + agentwrap) reality. Full gate green.
## Evidence
