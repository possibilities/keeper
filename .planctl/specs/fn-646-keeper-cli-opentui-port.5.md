## Description

**Size:** M
**Files:** cli/autopilot.ts (moved from scripts/autopilot.ts), test/autopilot.test.ts, cli/keeper.ts

Cut `keeper autopilot` over — the highest-risk extraction. Autopilot
has a `--dry-run` flag, a stateful `onUnhandledKey` (space →
pause/resume gated on `!dryRun`; `v` → toggle command display via
`refreshLive`; `c` → copy), and a `setStatus` that restores to
`statusLine()` (its `[paused]`/`[playing]`/`[cmd]` chrome) rather than
`""`. Plus the dispatch side-effects (Ghostty window spawning, the
JSONL dispatch log) that must keep working.

### Approach

Move `scripts/autopilot.ts`→`cli/autopilot.ts`, `main`→`main(argv)`
(parse `--dry-run`/`--sock`/`--help` from the passed argv), neutralize
the guard, wire the dispatcher. The critical verification is that the
stateful `onUnhandledKey` still receives the exact raw-key strings it
keys off (`" "`, `"v"`, `"c"`) under the new `key.name`→raw translation
from `.2`, that the space-pause gate and the `v`-toggle `refreshLive`
still work, and that `setStatus` restoring to `statusLine()` (not `""`)
is preserved. Keep the SIGINT teardown + dispatch-log/window
side-effects intact. Update `test/autopilot.test.ts` import path;
exported dispatch/render fns stay.

Note: `fn-644` (autopilot startup-stagger) touches dispatch logic only,
not the TUI shell — no conflict with this wrapper-level cutover, but
avoid clobbering its dispatch changes if it lands first.

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:2503-2554 — the stateful `onUnhandledKey` (space/`v`/`c`)
- scripts/autopilot.ts:2485-2494 — `statusLine()` (the setStatus restore target)
- scripts/autopilot.ts:2569 — SIGINT teardown
- scripts/autopilot.ts — `--dry-run` arg + the `!dryRun` pause gate; dispatch-log + Ghostty window side-effects
- src/live-shell.ts (post-`.2`) — the `onUnhandledKey` raw-string contract + `refreshLive` semantics

### Risks

- The stateful keymap is the most fragile surface: a key-string contract drift silently kills space/`v`/`c`. Verify each against the new translation layer.
- `setStatus` must restore to `statusLine()`, not `""` — distinct from the other three TUIs.

### Test notes

Update import paths; render/dispatch-fn tests stay green. Manually
verify space pauses/resumes (and is inert under `--dry-run`), `v`
toggles the command display, `c` copies, and the status chrome restores
correctly after a copy flash.

## Acceptance

- [ ] `keeper autopilot` renders + behaves UI-identical to `bun scripts/autopilot.ts`: space pause/resume (gated `!dryRun`), `v` toggle, `c` copy, `statusLine()` status restore.
- [ ] `--dry-run` and the dispatch-log + Ghostty window side-effects preserved.
- [ ] `cli/autopilot.ts` wired into the dispatcher; SIGINT teardown preserved; `test/autopilot.test.ts` green.

## Done summary
Moved scripts/autopilot.ts → cli/autopilot.ts; main(argv) replaces Bun.argv.slice(2); import.meta.main guard neutralized; HELP usage line + docblock flipped to 'keeper autopilot'; stateful onUnhandledKey (space pause-gated on !dryRun, v toggle via refreshLive, c copy) and setStatus → statusLine() restore preserved verbatim; SIGINT teardown + dispatch-log/Ghostty side effects intact; test/autopilot.test.ts imports flipped to ../cli/autopilot (71/71 green).
## Evidence
