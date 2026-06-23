## Overview

Replace `keeper pair`/`panel`'s bespoke tmux-window lifecycle with keeper's
tracked-job + daemon-reaper model (the one `keeper dispatch` + autopilot already
use). Switch the **claude** pair/panel partner from a headless `--print -p`
launch to an interactive TUI launched via keeper's canonical agentwrap shape
(prompt positional + `KEEPER_TMUX_SESSION` bind carrier), so claude partners
become tracked `jobs`. Generalize the window-reaper (`src/reaper-worker.ts`) with
a SECOND arm that autocloses any stopped tracked NON-plan job in a keeper-managed
session (`pair`/`panels`/`agentbus`) after an idle grace, gated by a
`disable-autoclose` session list (default EMPTY). This structurally eliminates the
unbounded PTY-window leak toward `kern.tty.ptmx_max: 511`.

**Scope split:** codex/pi don't fire keeper hooks → they never become tracked
jobs → they stay headless and keep the CLI-side synchronous reap. Interactive
codex is deferred until agentwrap emits a job per non-claude invocation.

**Fire-and-forget = the KILL only.** The CLI keeps its synchronous
`wait-for-stop`/`show-last-message` answer-capture → `--output` and the Monitor
two-line `completed` contract; only the window-kill for the claude path moves to
the daemon reaper.

## Quick commands

- Launch a claude partner, confirm it is a tracked job: `keeper pair send /tmp/p.md --cli claude --session pair --output /tmp/o.yaml` then `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id, backend_exec_birth_session_id, plan_verb, state FROM jobs ORDER BY created_at DESC LIMIT 3"`
- Confirm autoclose: wait past the idle grace, assert the window is gone; add `pair` to `disable-autoclose` and assert it persists.

## Acceptance

- [ ] claude pair/panel partners launch as interactive TUI tracked jobs (`plan_verb` NULL, birth-session ∈ {pair,panels}).
- [ ] answer-capture contract unchanged (`wait-for-stop`/`show-last-message` → `--output` + Monitor two-line `completed`).
- [ ] the reaper autocloses a stopped tracked managed-session window past the idle grace; a human's own idle claude window is NEVER reaped.
- [ ] a session in `disable-autoclose` (default empty) is not reaped — the debug opt-out.
- [ ] codex/pi keep the CLI-side synchronous reap; no codex window leak.
- [ ] agentbus windows (fn-918) are covered by the reaper arm.
- [ ] the autopilot verdict-gated reap path is unchanged; no job is double-handled.
- [ ] docs updated (CLAUDE.md/AGENTS.md, README, pair + panel skills, config).

## Early proof point

Task `.1` (interactive spawn parity + verification) proves the keystone unknown:
that an interactive TUI partner registers as a tracked job AND the single-turn
capture survives against the TUI transcript (handling the known dropped
`message_stop` bug via the existing `--timeout`) without re-tripping the
transcript-collision guard. If it fails: keep the headless spawn but mint a
synthetic job row for the partner from the CLI, or defer the epic pending
agentwrap-level job tracking.

## References

- fn-918 (agentbus wake) — `src/bus-wake.ts` already spawns tracked (`KEEPER_TMUX_SESSION=agentbus`) and stamps `@keeper_managed=agentbus`; this epic's reaper arm owns its autoclose. Wired as a dependency.
- fn-919 (plumb pair timeout through agentwrap) — OVERLAP, coordinated by hand: heavy overlap on `src/pair-command.ts` / `cli/pair.ts` / pair `SKILL.md`. This epic depends on fn-919 (lands first) and rebases on its `--stop-timeout-ms` plumbing, which survives because the synchronous `wait-for-stop` stays.
- fn-910 (pair transcript collision) — the self-collision guard interaction when dropping `stripClaudeEnv`.
- `buildAgentwrapLaunchArgv` (`src/exec-backend.ts:928-954`) — the interactive launch template the pair builder copies.
- `selectReapCandidates` (`src/reaper-worker.ts:143-197`) — the predicate the second arm extends.

## Docs gaps

- **CLAUDE.md / AGENTS.md (~35-43, autopilot section)**: the agentbus "reaping/autoclose owned by a separate cleanup system, never this repo" sentence becomes false — revise to the generalized reaper owning agentbus autoclose; "Two distinct reapers" → the third managed-session idle-grace arm.
- **README.md (~2815-2821, ~2967-2991, ~3024-3027, ~363-416)**: widen the window-reaper predicate description beyond autopilot work/close jobs; replace the agentbus placeholder; add the `disable-autoclose` config key.
- **plugins/keeper/skills/pair/SKILL.md (~118)**: fire-and-forget + reaper-gate, drop `KEEPER_PAIR_PERSIST_SESSIONS`, note codex/pi keep the synchronous reap.
- **plugins/plan/skills/panel/SKILL.md (~84-86)**: panels closes after idle grace unless `panels` is in `disable-autoclose`.

## Best practices

- **Transcript Stop is the authoritative done signal:** `pane_current_command` stays `node`/`bun` for a live TUI, so it is never a completion signal; the reaper correctly keys on job `state='stopped'` (the Stop hook). [practice-scout]
- **Don't wait indefinitely for `message_stop`** (claude-code bug #27361 drops it intermittently) — the existing `--timeout` bounds the wait. [practice-scout]
- **Fix the tmux window size at launch:** a human attaching from a smaller terminal sends SIGWINCH and can stall an Ink TUI redraw — verify the canonical agentwrap launch path already pins size. [practice-scout]
- **kill-window sends SIGHUP** which Ink TUIs may ignore (orphaned tool grandchildren) — inherited from the existing autopilot arm; a named non-goal here, not a new regression. [practice-scout]
