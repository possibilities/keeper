## Description

**Size:** M
**Files:** cli/await.ts, cli/descriptor.ts, test/await.test.ts

### Approach

Make a long wait legible without touching the stdout terminal contract
(first met/failed line stays terminal and byte-stable). A wall-clock
heartbeat (default on, ~60s cadence, `--heartbeat <dur|off>`) emits to
stderr in both output modes — JSON lines under `--json`, prose
otherwise — naming the condition holders from the task-1 holder list,
size-bounded and truncated with a `+N more` tail (holder names are
attacker-influenced; route everything through the existing sanitized
emitter). While disconnected the heartbeat names the reconnecting state
rather than stale holders. Persist each slot's last waiting detail so
the timeout/stuck/unreachable terminal envelope reports what held the
condition at the deadline, plus a retryable classification
(timeout/unreachable retryable; not-found/deleted/no-match/stuck not).
The heartbeat timer routes through the injected timer seam and must not
double-fire against the eval loop or leak on terminate. Correct the
stale `--no-armed-line` descriptor summary (it claims a periodic line
that does not exist); that flag keeps governing only the initial armed
line.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- cli/await.ts:237 — eventLine, the sole sanitized emitter (CR/LF
  strip at :206); heartbeats must ride it
- cli/await.ts:1867-1890 — logProgress (stderr, verdict-change
  throttled) — the surface the heartbeat generalizes
- cli/await.ts:1892+ — the eval pass; :1924 dwellHandle, the injected
  timer-seam precedent
- cli/await.ts:1018 — runAwait deps seam (writeStderr, exit, timers)
- cli/descriptor.ts:753-756 — the stale --no-armed-line summary
- plugins/keeper/skills/await/SKILL.md:185-217 — the terminal grammar
  existing listeners parse (do not change stdout shapes)

### Risks

- Any stdout emission before the terminal line breaks existing
  listeners (watch skill, monitors) — heartbeats are stderr-only
- server-up's dedicated minimal subscribe must stay a no-op for
  heartbeat holder enrichment

### Test notes

Fast-tier through the injected connect factory + fake timers: heartbeat
fires during silence naming holders; suppressed at off; JSON-mode
heartbeat is one parseable stderr line; terminal envelope after a
deadline carries last-waiting detail + retryable; stdout byte-stable
against the existing terminal-shape fixtures.

## Acceptance

- [ ] A wait past the heartbeat interval emits stderr heartbeats naming
  the holders in both output modes, size-bounded, and `--heartbeat off`
  silences them
- [ ] Timeout/stuck/unreachable terminals carry the last waiting detail
  and a retryable field; stdout terminal shapes are unchanged for
  existing consumers
- [ ] The --no-armed-line summary matches its actual behavior
- [ ] Fast suite green

## Done summary

## Evidence
