## Description

**Size:** M
**Files:** src/agent/args.ts, src/agent/main.ts, src/agent/dispatch.ts, new src/agent/modal-host.ts (the PTY-host launch path), test/agent-modal-host.slow.test.ts, test/* (flag-parse unit tests)

### Approach

Add the opt-in `--agentwrap-modal` boolean to `ParsedArgs` + `parseArgsForAgent`
following the `agentwrapProfile`/`explicitAgentwrapProfile` template, and STRIP it
from `remainingArgs` so the child never sees it. Fork ONLY the claude/pi interactive
spawn tail at `src/agent/main.ts:1295`, AFTER all setup (state-sharing, profile,
session-uuid, plugin discovery), guarded to claude only — leave the Codex tail
(`:1024`) and the no-flag path byte-identical (pure branch via the existing
`deps.spawn`/`deps.exit` seams). Precondition-gate: require an interactive TTY
(stdin+stdout `isTTY`) and reject `-p`/`--print`; error clearly for codex/pi and
non-TTY. The new host spawns the child via `Bun.spawn(runCmd, { terminal: {cols,rows,
data, exit}, env: {...process.env} })` — the env spread is load-bearing (the TMUX
strip + `KEEPER_TMUX_PANE` carry only reach the child through it). Raw passthrough:
real stdin → `terminal.write()` (raw `Uint8Array`, no TextDecoder), child `data` →
`process.stdout.write()`; forward `process.stdout` "resize" → `terminal.resize()`;
handle job control (the PTY child is NOT in the parent foreground pgroup, so
ctrl-c/ctrl-z/SIGWINCH do not auto-propagate — forward them explicitly). Read the
child's REAL exit code out-of-band (not `proc.exited`, which is PTY-lifecycle status;
fallback exit 1). Detect the reserved hotkey byte(s) in the passthrough stream and
fire a stub callback (the modal is wired in `.2`). Restore the terminal on EVERY exit
path — normal, child crash, signal, `uncaughtException` — before propagating the
child's disposition.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:683 — tmux-branch fork point; :1295 claude/pi tail (fork here); :1024 Codex tail (LEAVE ALONE); :1255-1269 TMUX strip + KEEPER_TMUX_PANE carry; :441-476 --session-id resolve (preserve push to child)
- src/agent/run.ts:37-61 — `defaultSpawn` env spread to replicate; :68-118 `runWithJobControl` signal wiring to mirror for the PTY child
- src/agent/args.ts:29-53 — `ParsedArgs`; :71-127 `parseArgsForAgent` flag parse+strip template
- node_modules/bun-types/bun.d.ts:7010-7046 — `Bun.spawn({terminal})`; :7822-7859 — Terminal `write`/`resize`/`setRawMode`/`ref`/`unref`, `data`/`exit`/`drain`
- src/agent/dispatch.ts:39,66 — USAGE + AGENTWRAP_HELP (document the flag)

**Optional** (reference as needed):
- src/agent/tty.ts:72 — `readSingleChar` bun:ffi tcgetattr/tcsetattr restore-on-exit idiom (real-TTY raw-mode toggle)
- src/live-shell-core.ts:451-496 — `feedStdin` CSI/SS3 escape parser for hotkey-byte interception
- src/dash/exit-triggers.ts — SIGHUP/stdin-EOF/orphan teardown set (injectable)

### Risks

- PTY child not in the parent foreground process group → ctrl-c/ctrl-z/SIGWINCH require manual forwarding; this is the biggest mechanics risk and the reason this is the keystone/early-proof task.
- `proc.exited` != child exit code (PTY-lifecycle status); out-of-band read needed, fallback exit 1.
- Forgetting `env:{...process.env}` silently no-ops the TMUX-strip truecolor fix.
- Bun's `terminal:` PTY behavior under Ghostty must be validated empirically; if it can't host claude cleanly, fall back to `bun:ffi` openpty.

### Test notes

- In-process unit tests (no renderer): flag parse+strip, claude-only + TTY/interactive precondition guard, no-flag path unchanged. Use `sandboxEnv` for any real subprocess.
- Real-PTY passthrough smoke as `test/agent-modal-host.slow.test.ts` (ignore-listed from the default tier; `retryUntil`, never `Bun.sleep`): child echoes, resize forwards, exit code propagates, terminal restored after exit.

## Acceptance

- [ ] `--agentwrap-modal` parses, is stripped from child argv, and is documented under an "Experimental flags (opt-in)" section in `AGENTWRAP_HELP`
- [ ] The flag forks ONLY the claude interactive tail; the Codex tail (:1024) and the no-flag path remain byte-identical
- [ ] The flag errors clearly for codex/pi and for non-interactive / non-TTY invocations (`-p`/`--print`, piped stdout)
- [ ] claude runs under `Bun.spawn({terminal})` with raw passthrough indistinguishable from a normal launch — truecolor (via the replicated env spread), resize forwarding, working ctrl-c/ctrl-z
- [ ] The child's REAL exit code is propagated (out-of-band, not `proc.exited`); fallback exit 1 on read failure
- [ ] The terminal is restored on every exit path (normal/crash/signal/uncaughtException) — no raw mode, alt-screen, or `?2026` left pending
- [ ] The reserved hotkey is detected in the passthrough byte stream and fires a stub callback (modal wired in .2)

## Done summary

## Evidence
