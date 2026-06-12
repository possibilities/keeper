## Description

From audit finding F4 (evidence path cli/setup-tmux.ts:494-520). The
`--kill-sessions` busy-pane gate in `main()` guards the destructive
`killAllSessions` call: when `sweepBusyPanes` returns busy panes, a
non-TTY stdin must refuse and `process.exit(1)` BEFORE reaching
`killAllSessions` (line 518), and an aborted y/N `confirm()` must
likewise exit 1 having killed nothing. The decision primitives
(`sweepBusyPanes`, `parseBusyPanes`, `renderBusyTable`, `isBusyCommand`)
are covered, but the busy->TTY-gate->kill call-ordering invariant — the
one safety-critical path, since a regression silently tears down the
human's live tmux sessions — is not. Add tests that drive `main()`
through an injected `SyncSpawnFn` and assert no kill argv was spawned on
both the non-TTY-with-busy branch and the abort-on-N branch.

## Acceptance

- [ ] Non-TTY stdin with busy panes present: `main()` exits 1 and spawns no `kill-session`/`kill-server` argv.
- [ ] Aborted (N) confirmation with busy panes present: `main()` exits 1 and spawns no kill argv.
- [ ] An empty busy sweep proceeds to setup without prompting.

## Done summary
Added main() tests pinning the --kill-sessions busy-pane gate: non-TTY-with-busy and aborted-N branches both exit 1 spawning no kill argv, and an empty busy sweep proceeds to setup without prompting. Made main()'s spawn injectable to drive the gate in-process.
## Evidence
