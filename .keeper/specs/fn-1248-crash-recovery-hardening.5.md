## Description

**Size:** M
**Files:** (determined by reproduction — candidates: src/git-worker.ts, src/daemon.ts)

### Approach

REPRODUCE FIRST — this is the softest item. The reported source (autopilot
merge-gate deferral) has ZERO `console.*` calls and the merge-gate defer map is
ephemeral and mints no row, so the ~39k-lines/boot are NOT there. Read the
LaunchAgent daemon log (`~/.local/state/keeper/server.stdout` /
`server.stderr`) to find the actual high-volume emitter before designing any fix.
Likely candidates: `src/git-worker.ts` (16 console calls — per-repo git probe
output), `src/daemon.ts` relay handlers (139 console calls), or git-subprocess
stderr from the once-per-cycle merge-gate landed/ancestor probe multiplied by
cycle frequency (cycles are level-triggered on every `PRAGMA data_version` bump).

Once the emitter is identified, bound its volume: per-key coalesce (log the first
occurrence + a periodic "N suppressed" summary) OR demote steady-state boot
chatter below the default log level. Do not silence a genuinely diagnostic error
path — coalesce it. State the chosen shape in the Done summary.

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- ~/.local/state/keeper/server.stdout, ~/.local/state/keeper/server.stderr — the actual accumulation site; grep for the repeated line
- src/git-worker.ts — 16 console calls (per-repo git probes)
- src/reconcile-core.ts:695-732,1680-1836 — the ephemeral merge-gate defer map (confirm it is NOT the emitter)

**Optional:**
- src/daemon.ts — relay handlers (~139 console calls)

### Risks

- Fixing the wrong file leaves the 39k lines/boot in place — the identify step gates the fix.
- Over-suppression could hide a real error edge; coalesce with a suppressed-count summary rather than dropping.

### Test notes

Add a unit test around the coalescing/rate-limit helper (first emitted, subsequent suppressed with a count) once the emitter is located. Reproduction evidence (the offending log line + a count) goes in Evidence.

## Acceptance

- [ ] The actual ~39k-lines/boot emitter is identified from the daemon log (named in the Done summary), not assumed.
- [ ] Boot log volume from that path is bounded (coalesced with a suppressed-count summary or demoted below default level).
- [ ] No genuinely diagnostic error edge is silently dropped.

## Done summary

## Evidence
