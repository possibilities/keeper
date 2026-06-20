## Description

**Size:** M
**Files:** scripts/autopilot.ts, scripts/board.ts, scripts/git.ts, README.md

### Approach

With task 1 done (uniform subscribe contract across all three scripts)
and task 2 done (`src/live-shell.ts` exists and is tested), this task
threads the shell into each script's emit seam, renames the flag, and
updates the docs.

Per-script changes (do all three; they're near-identical):

1. Swap `clear: { type: "boolean", default: false }` for `live: ...`
   in the `parseArgs` schema.
2. Replace `clearMode = values.clear` with `liveMode = values.live`.
3. Change the top-level renderer's return type from `string` to
   `string[]` (today's renderers already end with `.join("\n")` on
   a `lines` array — strip the join and return `lines`).
4. Construct the shell at startup:
   `const liveShell = createLiveShell({ enabled: liveMode });`
5. At the emit seam (`emitFrameIfChanged` / `emitFrame` / `emit`),
   replace the existing `if (clearMode) process.stdout.write("\x1b[2J\x1b[H"); log(frameText)` block with a single
   `liveShell.pushFrame(lines)` call. Keep the byte-compare
   suppression in the script (`lastBody`) — it stays the gate that
   decides whether to push.
6. Keep the indexed-sidecar carve-out, but gate it on `liveMode`
   (same shape as the old `clearMode` gate). Sidecars are unchanged
   beyond the variable rename.
7. In the SIGINT handler: call `liveShell.dispose()` BEFORE
   `handle.dispose()` (terminal restoration before subscription
   teardown).
8. Strip every `--clear` mention from the script's top-of-file JSDoc
   and the `HELP` constant; replace with `--live` plus a one-line
   key-bindings cheatsheet:

   ```
   --live           Real TUI mode (alt-screen + keyboard nav).
                    When not a TTY, behaves as if --live was not set.
                    Keys: ←/h/k prev frame, →/l/j next, g oldest,
                          G/End/Esc return to live, q/Ctrl-C quit.
   ```

9. Verify visually by running each script in a real terminal and
   poking the keys (TUI behavior is not type-checkable).

README change (`README.md:258-347`, `## Example clients` section):

- For each of the three script entries (`board.ts`, `autopilot.ts`,
  `git.ts`), rewrite the `--clear` paragraph in place. Posture is
  **replace, not append** — no `--clear` stub, no "previously
  `--clear`" callout.
- Replace the two-line shell-example blocks: `bun scripts/X.ts
  --clear` → `bun scripts/X.ts --live`.
- Shift the behavioral prose from "clears the terminal each frame"
  to the alt-screen + keyboard nav model. Mention the key cheatsheet.

### Investigation targets

**Required** (read before coding):
- `scripts/autopilot.ts:208-411` — main(); the seams at `:226`
  (`clearMode`), `:365-379` (`emitFrameIfChanged`), `:407-410` (SIGINT).
- `scripts/board.ts:233-675` — main(); the seams at `:251`
  (`clearMode`), `:612-643` (`emitFrame`), `:664-674` (SIGINT).
- `scripts/git.ts` (post-task-1 shape) — main(); the seams roughly at
  `clearMode`, `emit()`, and SIGINT after the migration.
- `README.md:258-347` — `## Example clients`; the exact lines flagged
  by docs-gap-scout.
- `src/live-shell.ts` (from task 2) — factory + return type.

**Optional** (reference as needed):
- `test/autopilot.test.ts`, `test/board.test.ts` — verify renderer
  signature change to `string[]` doesn't break existing tests; update
  test expectations if helpers were importing the joined string.

### Risks

- **Renderer return-type change ripples into tests:** `test/autopilot.test.ts` and `test/board.test.ts` import `renderEpicCommands` / `projectRows` / similar named exports. If any test asserts on the joined string, update to `.join("\n")` at the call site or compare arrays.
- **`git.ts` SIGINT body diverges briefly during the rebase:** task 1 collapsed git's SIGINT to uniform shape; this task adds the shell's `dispose()` call before `handle.dispose()`. Be careful to land both in the right order (this task depends on task 1).
- **JSDoc carries `--clear` in three places per file:** top-of-file header, HELP const, and inline comments referencing the `--clear` mode. Grep for `--clear` and `clearMode` across the repo before declaring done.
- **README example blocks have fenced-code formatting** — keep the existing fence language hint (`sh`) and indentation.

### Test notes

- `bun run lint && bun run typecheck && bun test` must pass cleanly across the whole repo.
- Manual smoke test in a real terminal: `bun scripts/board.ts --live` → resize the window → arrow keys → `G` → `q`. Same for autopilot + git. Type-checking does not catch TUI regressions; visual verification is required for this task.
- Verify non-TTY path: `bun scripts/board.ts --live | head -20` produces plain text (no ANSI), then exits.

## Acceptance

- [ ] All three scripts accept `--live` in `parseArgs`; `--clear` is removed (parseArgs rejects it as unknown).
- [ ] Each script's top-level renderer returns `string[]`; the live-shell consumes lines.
- [ ] Emit seams call `liveShell.pushFrame(lines)` only; no direct `\x1b[2J\x1b[H` writes remain in the scripts.
- [ ] SIGINT in each script: `liveShell.dispose()` → `handle.dispose()` → `process.exit(0)`.
- [ ] Indexed-sidecar carve-out re-gated on `liveMode` (was `clearMode`); behavior unchanged.
- [ ] All `--clear` and `clearMode` mentions removed from all three scripts (JSDoc, HELP const, parseArgs, code body) — `grep -rE 'clearMode|--clear' scripts/ src/` returns no hits.
- [ ] README `## Example clients` section updated for all three scripts; no `--clear` stub remains. `grep -n -- '--clear' README.md` returns no hits.
- [ ] Manual TUI smoke test passes in a real terminal: alt-screen enters, per-line diff visible, keyboard nav works, `q` exits cleanly with terminal restored.
- [ ] Non-TTY smoke test: piping the script's output produces plain text with no ANSI.
- [ ] `bun run lint && bun run typecheck && bun test` pass.

## Done summary
Wired createLiveShell into autopilot/board/git scripts: renamed --clear to --live, top-level renderers return string[], emit seam calls liveShell.pushFrame(lines), SIGINT order is liveShell.dispose() then handle.dispose(), README ## Example clients updated in place to cover --live for all three scripts.
## Evidence
