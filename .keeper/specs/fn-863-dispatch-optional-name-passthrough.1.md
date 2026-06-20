## Description

**Size:** S
**Files:** cli/dispatch.ts, src/dispatch-command.ts, README.md, test/ (dispatch suites)

Make the free-form `keeper dispatch --name` optional and a transparent
pass-through to `claude`. Builds on the shipped fn-858 dispatch command.

### Approach

- **`cli/dispatch.ts`** (free-form branch): remove the `free form requires --name <n>` argFault so `--name` is optional. Set `claudeName` only when `--name` is supplied. Decouple `label` from `--name` (today `label = name` feeds only the `--dry-run` `name:` line and the final `dispatched <label> -> session` message) — use a neutral status line that doesn't treat `--name` as a keeper concept (the passed name is already visible in the dry-run argv; the post-launch line can key off the session/prompt-source instead). KEEP the unnamed-window launch (`launch(session, launchArgv, cwd, "")`) — the CLI never renames the tab. Update `--help` and the file header comment: `--name` is OPTIONAL and a pass-through (drop "REQUIRED in free form").
- **`src/dispatch-command.ts`** (`buildDispatchLaunchArgv`): make `claudeName` optional — emit `--name <value>` only when provided, mirroring the existing `--model` / `--effort` conditional pattern. When absent, omit `--name` from the argv entirely.
- **`README.md`**: update the `keeper dispatch` free-form description — `--name` is optional and forwarded to the agent. Forward-facing prose only (state current behavior, no change history).
- **SCOPE BOUNDARY (do NOT expand):** keeper's HOOK scrapes any `claude --name` at SessionStart (keeper-wide, shared with autopilot's `(plan_verb, plan_ref)` correlation), and the renamer worker can label a window from a bound jobs row. So pass-through at the dispatch-CLI level does not stop keeper's global hook from seeing a free-form name. Excluding dispatch-launched names from keeper's correlation/renaming entirely is a deeper hook/reducer/renamer change — OUT OF SCOPE here; note it for a possible separate followup.
- **OVERLAP with fn-861** (dispatch global prompt prefix): both edit the free-form branch of `cli/dispatch.ts`, `buildDispatchLaunchArgv`, the same dispatch tests, and the same README section. Coordinate — land one then rebase the other (autopilot is paused, so no parallel-work risk). Not a hard upstream dependency.

### Investigation targets

**Required** (read before coding):
- cli/dispatch.ts:~388 — the free-form branch: the required-name `argFault`, `claudeName = name`, `label = name`. The launch at ~:438 (`launch(session, launchArgv, cwd, "")`) and dry-run/output (~:427+).
- src/dispatch-command.ts:~187-206 — `buildDispatchLaunchArgv` flags assembly; the `--model`/`--effort` conditional pattern to mirror for an optional `--name`.

**Optional** (reference as needed):
- cli/dispatch.ts:~14-16,~76 — header comment + `--help` text to update.

## Acceptance

- [ ] `--name` is optional in free form: a dispatch with no `--name` succeeds and emits NO `claude --name` in the argv.
- [ ] A provided `--name` is forwarded verbatim as `claude --name <value>`; it is not reused for the CLI `label`/status or any tab/window naming.
- [ ] `buildDispatchLaunchArgv` omits `--name` when `claudeName` is absent (mirrors `--model`/`--effort`).
- [ ] Tests updated: the "requires --name" case flipped; new cases for "omitted -> no --name in argv" and "provided -> --name forwarded"; `bun run test:full` passes.
- [ ] README free-form description updated; the hook-scrape scope boundary is noted (not implemented here).

## Done summary

## Evidence
