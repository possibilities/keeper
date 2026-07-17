## Description

**Size:** M
**Files:** src/view-shell.ts, src/live-shell-core.ts, test/view-shell.test.ts, docs/adr/0019-tui-readiness-gate-over-boot-status.md

### Approach

After the reconnect grace expires, a dropped keeperd socket must be
unmistakable — today the held frame stays painted under a small
banner-suffix pill, and a whole dash has read as frozen during daemon
bounces. Design constraints established at plan time: the shim's SGR
parser STRIPS unrecognized codes including INVERSE, and the banner
renders as force-dimmed plain text — so the loud signal must ride
styling that renders in BOTH paint paths: the already-recognized red
bucket plus a plain-text DISCONNECTED token (the word "reconnect" is a
glossary Avoid synonym — never surface it in new user-visible copy; a
full-frame dim and body INVERSE are both new paint capabilities and
out of scope). The held frame stays at full brightness (content is
still useful); the post-grace indication owns its surfaces: compose
the DISCONNECTED token into the single-slot body indicator line so the
connecting spinner never overwrites it (suppress or compose — one
owner for the slot while grace is expired), and extend the
flash-restore banner guard so a transient flash cannot clobber the
disconnected state (the existing guard covers only the pre-grace
pill). Reuse the existing grace/teardown helpers — no hand-rolled
timers. Record the behavior change as a supersession note amending the
ADR that documents the current pill UX.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/view-shell.ts:1196-1224 — the disconnected branch; :621-632 the reconnecting/graceExpired state + pill; :813-834 armReconnectGrace/exitReconnecting (reuse); :629-630 the flash-restore invariant to EXTEND; :796 the spinner's single-slot refreshLive overlay; :836-849 scheduleFlashRestore/restoreBanner
- src/live-shell-core.ts:262-277 — the banner composition (plain text, force-DIM downstream)
- src/ansi-to-styled.ts:115-122, :265-269 — the recognized-SGR set and the strip rule (why red + text, not INVERSE)
- test/view-shell.test.ts — the transition suite to extend
- docs/adr/0019-tui-readiness-gate-over-boot-status.md — the pill behavior record needing the supersession note

**Optional** (reference as needed):
- src/live-shell.ts:219 (ttyOk gate), :363-366 (the passthrough fast-path), :533-542 (banner force-DIM node)

### Risks

- Styling that only renders in one paint path recreates the original problem — assert the token (text-level) in tests so the signal survives even a style-stripping terminal
- The spinner ticking every 125ms will overwrite a naive body indicator — slot ownership while grace-expired is the invariant
- Sticky SGR attributes need explicit resets; end every styled region cleanly

### Test notes

Transition tests through the existing view-shell/live-shell-core
seams: post-grace state carries the DISCONNECTED token in the
indicator line and banner; spinner ticks don't remove it; a flash +
restore during grace-expired preserves it; reconnect clears it via the
existing teardown helper.

## Acceptance

- [ ] After the reconnect grace expires the viewer shows an unmistakable DISCONNECTED indication whose plain-text token renders in both the TTY and passthrough paths
- [ ] The connecting spinner and transient flash messages can never overwrite or clobber the disconnected indication while it is active
- [ ] Reconnection restores the normal banner and indicator through the existing teardown path
- [ ] The ADR documenting the prior pill behavior carries the supersession note; the full fast correctness gates stay green

## Done summary
Grace expiry now composes an unmistakable DISCONNECTED token (red SGR + plain-text fallback) into the body indicator line and banner pill, guarded from spinner ticks and transient flashes; ADR 0019 carries the supersession note.
## Evidence
