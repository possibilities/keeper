## Description

**Size:** S
**Files:** src/main.ts, test/ (main-flow test via _main-harness.ts), CLAUDE.md

### Approach

claudewrap-side half (lands AFTER keeper). Strip the native tmux vars from the env Claude inherits, carrying the pane id to the keeper carrier first. In `src/main.ts`, inside the existing tmux block (~435, `if ((deps.env.TMUX ?? "") !== "")` — gating on `$TMUX` present makes it nested-idempotent): `const pane = deps.env.TMUX_PANE ?? ""; if (pane !== "") deps.env.KEEPER_TMUX_PANE = pane;` then `delete deps.env.TMUX; delete deps.env.TMUX_PANE;` plus an `actionLog.push(...)` (mirror the :443-449 assign+log pattern). The mutation reaches Claude because `deps.env === process.env` (:81) and `defaultSpawn` inherits `process.env` (run.ts; no `env:` key) — do NOT touch run.ts. Add two comments: a cross-reference that `KEEPER_TMUX_PANE` must match `~/code/keeper/src/exec-backend.ts` (drift guard), and an anti-fix note that the spawn intentionally passes no `env:` (adding one without spreading `...process.env` would drop the carrier and `PATH`).

### Investigation targets

**Required** (read before coding):
- src/main.ts:435-437 — the tmux detection block to extend
- src/main.ts:443-449 — `deps.env` mutation + `actionLog.push` pattern to mirror
- src/main.ts:81 — `realDeps().env === process.env` (why in-place mutation reaches Claude)
- src/run.ts:37-53 — `defaultSpawn` Bun.spawn with no `env:` key (the mechanism; NOT changed)
- test/_main-harness.ts — `makeHarness`, `HarnessOptions.env`, recorded `spawned[]`; assert env via `deps.env` post-`main()`, NOT spawn args

**Optional**:
- CLAUDE.md — existing invariant sections (style for the new env-strip section)

### Risks

- Lockstep: keeper (task 1) must be deployed before this matters; the end-to-end acceptance needs both landed + keeper plugin reinstall + keeperd restart.
- Asserting env via recorded spawn args would be wrong (`SpawnFn` carries only argv) — assert via `deps.env`.

### Test notes

Via `test/_main-harness.ts`: (a) `env` with `TMUX`+`TMUX_PANE` → after `main()`, `deps.env` has no `TMUX`/`TMUX_PANE` and `KEEPER_TMUX_PANE === <pane>`; (b) no `TMUX` → block skipped, no `KEEPER_TMUX_PANE` set; (c) `TMUX` present but `TMUX_PANE` empty/absent → no carrier set. Assert on `deps.env`, not recorded `spawned`.

## Acceptance

- [ ] under tmux (`$TMUX` set), `main()` deletes `TMUX`+`TMUX_PANE` from the child env after setting `KEEPER_TMUX_PANE` to the pane id (only when `TMUX_PANE` non-empty)
- [ ] the block is a no-op when `$TMUX` absent (nested-safe); run.ts untouched
- [ ] cross-ref comment (→ keeper exec-backend.ts) + anti-fix `env:` comment present; `claudewrap/CLAUDE.md` documents the env-strip
- [ ] `bun test` (asserts the mutation via `deps.env`), `bun lint`, `bun typecheck` green
- [ ] end-to-end after both deploy: a new claudewrap session in tmux renders truecolor (`tmux capture-pane -e` shows `48;2`, not `48;5;37`); `/rename` still renames the tmux window; OSC 52 copy reaches the clipboard

## Done summary

## Evidence
