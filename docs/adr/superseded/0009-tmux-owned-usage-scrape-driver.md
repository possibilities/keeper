# 9. tmux-owned PTY driver for the usage scraper

## Status

Accepted.

## Context

`src/usage-scrape/scrape.ts` drives a TUI (claude or codex) to a usage/status
screen and scrapes the rendered text. The scraper needs a real PTY: the target
is an interactive terminal app, and Bun has no usable PTY primitive on the
scraper's target platform (macOS, run headless under a LaunchAgent) — every
option that hands the child a raw PTY and does the VT100 interpretation
in-process (`node-pty`, `Bun.Terminal`, a bare `child_process` PTY alloc) either
drops output on this Bun version, fails PTY allocation after sleep/wake (fatal
under a long-running LaunchAgent), or has no controlling tty to attach in the
first place.

## Decision

Own the PTY out-of-process: spawn a dedicated named `tmux -L agentusage-scrape`
server and let tmux do PTY allocation, VT100 rendering, and child reaping in C;
`scrape.ts` shells out to it and reads the rendered screen with
`capture-pane -p -J`. A pre-approved fallback (a headless-terminal library
pairing a PTY shim with an in-process VT100 emulator) stayed on the shelf —
the tmux driver cleared every gate:

- **Dedicated named server, explicit TERM.** `-L agentusage-scrape` isolates the
  server from any other tmux the host runs. TERM is set once via a `-f <conf>`
  sourced before `new-session` (`default-terminal xterm-256color`) — tmux
  ignores a `-e TERM` override and a post-`start-server` set arrives too late,
  so the sourced-config path is the only one that lands before the child spawns.
- **Explicit env, per-session isolation.** `new-session -d -e <K>=<V>…` injects
  the full parent env except TERM (profile selection rides `-e
  CLAUDE_CONFIG_DIR`), and `status off` / `escape-time 0` are set per-session
  (`-t`, never `-g`) so a shared server's stale globals never leak into a scrape.
- **Idle-settle capture, deadline-bounded.** The driver polls `capture-pane -pJ`
  until N consecutive snapshots are byte-identical (idle), bounded by a deadline
  — an app that never stops repainting would otherwise hang the scrape forever.
  `#{pane_dead}` is the terminal-EOF signal that stops the keystroke pumps.
  `-J` (never `-a`) rejoins wrapped lines, which matters: a wrapped URL split
  across rows by a naive capture would corrupt a downstream sentinel match.
- **Bounded cleanup.** Every scrape ends the pane with `send-keys C-c` ×2 then
  `kill-session`; a version probe below tmux 3.2 fails the scrape with a typed
  error, and a sweep kills any session left over from a prior SIGKILLed run
  (aged well past the scrape's own budget) without touching a concurrent
  fresh sibling.

## Alternatives considered

- **A headless-terminal library (PTY shim + in-process VT100 emulator).**
  Pre-approved as the fallback if the tmux driver failed its gates. Not
  consumed: the tmux driver passed every gate (TERM delivery, capture-text
  fidelity against a reference VT100 interpreter, the alternate-screen and
  idle-settle signals, geometry, env injection) against both a fixture corpus
  and a live scrape of each target, so the fallback was never exercised.

## Consequences

- The scraper depends on a `tmux` binary at or above the driver's pinned
  minimum version being present on the host; a missing or too-old binary fails
  the scrape with a typed error rather than degrading silently.
- PTY allocation, VT100 rendering, and child reaping all happen in tmux's own C
  implementation, not keeper's process — the scrape driver's job is reduced to
  spawning the server, driving keystrokes, and reading rendered text.
- The dedicated `-L agentusage-scrape` socket, `agentusage-scrape-` tmpdir
  prefix, and `agentusage-scrape.tmux.conf` name are load-bearing on-disk/IPC
  identifiers; the worker path filter that excludes scrape-driven sessions from
  unrelated session discovery matches on the same tmpdir prefix.
