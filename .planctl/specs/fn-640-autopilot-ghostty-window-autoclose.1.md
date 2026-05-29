## Description

**Size:** M
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

### Approach

Five coordinated changes in `scripts/autopilot.ts` (client-side, NOT the reducer):

1. **Shell generalization + drop-to-shell.** In `launchInGhostty` (~:1780),
   replace the hardcoded `/bin/zsh -l -i -c <cmd>` with
   `${shell} -l -i -c '<workerShellCommand> ; exec ${shell} -l -i'` where
   `shell = validateShell(process.env.SHELL) ?? "/bin/zsh"`. `validateShell`:
   require an absolute path that `fs.existsSync`, containing no `"`
   (AppleScript string-literal injection guard) — else fall back to
   `/bin/zsh`. The trailing `; exec ${shell} -l -i` keeps claude a CHILD of a
   live login+interactive shell (zsh `exec_opt` is off under `-i` — verified)
   and drops to a fresh interactive shell if claude exits before auto-close
   fires. Preserve the `-l -i` rationale comment (it applies to any
   login+interactive shell, not just zsh).

2. **Window-id capture + persist.** Adapt the AppleScript to
   `set w to new window with configuration cfg` + a trailing `return id of w`
   (KEEP the `new surface configuration` form — it carries `command`/cwd).
   Isolate osascript's stdout from the yabai tail: run osascript as its OWN
   `Bun.spawn` capturing stdout (the bare `tab-group-…` id), then fire the
   `sleep 0.3 && yabai -m window --space 5` move as a separate
   fire-and-forget step. Read stdout+stderr concurrently
   (`Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])`).
   On osascript exit 0 with a non-empty trimmed id: (a) stamp `windowId` onto
   the LIVE in-memory `DispatchEntry` (find by `${verb}::${id}` in
   `dispatchLog`, mutate by reference) so auto-close works within the same
   run, AND (b) append a `{"kind":"window", ts, verb, id, windowId}` row via a
   raw `appendFileSync` (NOT `logDispatch` — that re-pushes a display entry /
   re-adds `dispatchedKeys` / restamps kind), wrapped in try/catch → `noteLine`.
   On non-zero exit or empty id: write no window row, `noteLine` the failure
   (the window simply will not auto-close; the shell fallback covers it).

3. **Auto-close trigger.** Add
   `closeWindow: (windowId: string | undefined) => void` to
   `DetectJobTransitionsDeps` (~:1224-1256). In `detectJobTransitions`, call
   `deps.closeWindow(entry.windowId)` at BOTH `completedKeys`-entry sites: the
   disappearance branch (~:1312-1330, BEFORE its `continue`) and the terminal
   `ended`/`killed` branch (~:1355-1372). The `completedKeys.has(key)` guard at
   ~:1302 ensures once-per-key. `entry` is in loop scope.

4. **closeWindow production wiring.** In the deps build (~:2021-2031), wire the
   real `closeWindow`: when `windowId` is undefined OR `dryRun`, no-op
   (`noteLine` the intended close under dryRun); else fire-and-forget
   `Bun.spawn` osascript using the VERIFIED repeat-loop close pattern
   (`tell application "Ghostty"` / `repeat with w in every window` /
   `if id of w is wid then close window w` / `return` / `end` / `return "not-found"`)
   — NOT `close window id "..."` (errors -2741) and NOT `close w` (errors -1708).
   stderr → `noteLine`; never throw into the transitions loop.

5. **hydrate fold + docs.** In `hydrateDispatchLog` (~:1086-1170) pass 1, parse
   the `window` kind into a second `Map<string,string>` keyed by `${verb}::${id}`
   (latest-ts-wins; type-guard `windowId`/`verb`/`id` as strings, skip
   otherwise); in pass 2 (~:1156-1168) stamp `entry.windowId` onto the matching
   surviving restored launch entry before pushing. Then update the file-level
   JSDoc (lines 1–150) and `HELP` constant (lines 153–250) in lockstep (three
   kinds → four, `$SHELL` narrative, auto-close sentence) and tighten the stale
   README.md autopilot paragraph (lines 464–485).

### Investigation targets

**Required** (read before coding):
- `scripts/autopilot.ts:1730-1836` — `launchInGhostty`: `/bin/zsh` hardcode (:1780), appleScript array (:1781-1787), shellLine + yabai tail (:1795-1799), `Bun.spawn` + `proc.exited.then` stderr-only read (:1812-1830), dry-run gate (:1811)
- `scripts/autopilot.ts:1288-1374` — `detectJobTransitions`: disappearance `completedKeys.add` (:1313), terminal `completedKeys.add` (:1356), once-per-key guard (:1302)
- `scripts/autopilot.ts:1224-1256` — `DetectJobTransitionsDeps` interface (add `closeWindow`)
- `scripts/autopilot.ts:1050-1170` — `hydrateDispatchLog` two-pass parse/fold (`launchRows` Map ~:1143, pass-2 push ~:1156-1168)
- `scripts/autopilot.ts:263-285` — `DispatchEntry` interface (add `windowId?: string`, mirror the `dry?`/`pid?` optional-field idiom)
- `scripts/autopilot.ts:1711-1721` — `logDispatch` JSONL append idiom (mirror the try/catch+noteLine shape for the window row, but a raw append)
- `scripts/autopilot.ts:2021-2045` — production deps build + `detectJobTransitions` call site
- `scripts/autopilot.ts:1589-1595` — `noteLine` (sole warn sink)
- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef` — `window.id` text (:43), `close window` (:53), `new window` returns `window` (:169-174)

**Optional** (reference as needed):
- `test/autopilot.test.ts:755-795` — `makeDispatchEntry` builder + inline deps-mock pattern (noteLine/appendLine push to arrays)
- `test/autopilot.test.ts:878-1126` — hydrate tests (`writeDispatchLog` to a `mkdtempSync` temp dir)

### Risks

- Window-id capture is async (`proc.exited.then`); if it raced a same-tick
  completion the windowId might not be stamped yet — rare, shell fallback
  covers it. Must stamp the LIVE entry by reference, else auto-close only
  works after a restart (silent bug).
- The osascript close form is verified-uncertain across variants: use the
  repeat-loop (`whose id is`), not `close window id "..."` (-2741). Verify
  hands-on against a real window.
- ctrl+z merely SUSPENDS claude (no `SessionEnd`), so no completion fires
  while suspended — the vim fallback is safe. If claude is killed or the epic
  disappears while the human is in the dropped shell, `closeWindow` yanks it;
  acceptable per "close means kill everything."
- yabai tail must not pollute the captured stdout — isolate osascript's spawn.
- AppleScript string-literal injection: validate `$SHELL` has no `"`; keep
  `workerShellCommand` single-quoted at the `-c` boundary.

### Test notes

- Extend the `detectJobTransitions` test (~:770-860): inject a recording
  `closeWindow: (id) => closedIds.push(id)`; assert `closedIds` carries
  `entry.windowId` after BOTH the disappearance and terminal branches, and
  that the `completedKeys.has` guard suppresses a second close on a repeat tick.
- Add a `hydrateDispatchLog` case: a `window` row folds `windowId` onto its
  matching restored launch entry; latest-ts-wins on duplicate window rows; an
  old log with no window row leaves `windowId` undefined.
- `launchInGhostty` is a `main()` closure (not exported) — no unit test for the
  live osascript spawn; cover via the injected-dep + `hydrateDispatchLog`
  seams. Manual smoke: `autopilot --dry` then a real dispatch — confirm a
  `window` row lands and the window auto-closes on completion.

## Acceptance

- [ ] worker command wrapped as `${shell} -l -i -c '<cmd> ; exec ${shell} -l -i'`; shell = validated `process.env.SHELL` (absolute, exists, no `"`) with `/bin/zsh` fallback
- [ ] AppleScript returns the window id (`set w … / return id of w`, surface-config form kept); osascript stdout captured in isolation from the yabai move
- [ ] new dispatch.log `window` kind written via raw append (try/catch + noteLine), NOT `logDispatch`; `windowId` also stamped onto the live in-memory `DispatchEntry`
- [ ] `hydrateDispatchLog` folds `windowId` onto restored entries by `${verb}::${id}` (latest-ts-wins, type-guarded)
- [ ] `DetectJobTransitionsDeps` gains `closeWindow`; `detectJobTransitions` calls it at both `completedKeys`-entry sites; once-per-key via the existing guard
- [ ] `closeWindow` uses the verified repeat-loop close pattern; no-ops on undefined/stale id and under dry-run; fire-and-forget, stderr → noteLine, never throws
- [ ] JSDoc + HELP updated in lockstep to four kinds; README autopilot paragraph tightened
- [ ] `bun test --isolate` passes (new closeWindow + hydrate-fold assertions); `bun run lint` + `bun run typecheck` clean

## Done summary
Generalized autopilot's Ghostty launch to validated $SHELL (with /bin/zsh fallback) and a chained interactive-shell fallback, captured the spawned window id into a new dispatch.log `window` row (folded back via hydrateDispatchLog), and wired closeWindow into detectJobTransitions at both completedKeys-entry sites so parked Ghostty surfaces auto-close in lockstep with the agent's terminal state.
## Evidence
