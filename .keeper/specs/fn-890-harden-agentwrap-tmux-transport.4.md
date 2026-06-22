## Description

**Size:** M
**Files:** src/tmux-launch.ts

Bound the unbounded `$stateDir/tmux-runs/<runId>/` artifact accumulation
(Patch H): a startup GC sweep gated on age AND liveness with a count-cap, plus
a `--no-artifacts` flag that suppresses run-dir writes entirely for callers
that do not need the launch.sh/run.json trail.

### Approach

- **Marker + sweep:** write a liveness marker into each run dir at create time (a pid file, or reuse `run.json`). The GC sweep (run once at launch start, before creating the new run dir) deletes a run dir ONLY when its `mtime`/`createdAt` is older than a TTL AND its marker pid is not alive (or the run is recorded complete). Add a count-cap (keep at most N most-recent) as a secondary policy, deleting oldest-first subject to the same liveness gate. Path-traversal-guard every delete: assert the target is a direct child of the `tmux-runs` root (`defaultAgentwrapStateDir`, ~201-207) before `rmSync`. Never `fs.watch`; sweep synchronously at startup.
- **Pid caveat:** agentwrap exits immediately (detached), so its OWN pid dies at once — do NOT key liveness on the agentwrap pid (that would sweep every dir instantly). Key on the surviving pane/agent, or fall back to age-only with a generous TTL if the surviving pid is not knowable at write time. Document the choice.
- **`--no-artifacts` flag:** add to `parseAgentwrapTmuxArgs`; when set, skip `writeLaunchArtifacts`/`writeRunMetadata` and inline the launch command without a launch.sh (or a tmpfile cleaned on exec). Ensure the JSON result still returns (with `runDir:null, launchScript:null`).

### Investigation targets

**Required:**
- src/tmux-launch.ts:458-470 — `writeLaunchArtifacts` (mkdir + launch.sh); GC + `--no-artifacts` hook here.
- src/tmux-launch.ts:549-584 — `writeRunMetadata` (run.json; note the uninjected `new Date().toISOString()` at ~564 — inject a clock seam only if a deterministic test needs it).
- src/tmux-launch.ts:201-207 — `defaultAgentwrapStateDir` (the GC root).
- src/tmux-launch.ts:72-159 — `parseAgentwrapTmuxArgs` (the `--no-artifacts` flag).

### Risks

- Sweeping an in-flight run dir (one mid-write by a concurrent agentwrap) deletes launch.sh out from under a starting pane — the age + liveness gate plus "sweep before creating this run's dir" must prevent it.
- Keying liveness on the wrong pid bricks GC (sweeps everything or nothing) — see the pid caveat.
- `--no-artifacts` must still produce a valid JSON result and a working launch (the inline path must preserve the `-l -i` re-exec semantics).

### Test notes

Unit-test the sweep predicate (age+liveness+cap, path-traversal guard) with a temp `tmux-runs` fixture and synthetic dirs (old+dead → deleted; old+alive → kept; recent → kept; over-cap oldest dead → deleted; `../escape` → never deleted). Harness test: `--no-artifacts` skips dir creation and still returns JSON + a valid launch command.

## Acceptance

- [ ] Startup sweep deletes only run dirs that are BOTH past-TTL AND not-live; respects a count-cap; never deletes a non-child of the GC root or an in-flight run.
- [ ] Liveness keys on a surviving pid (not agentwrap's own), or documented age-only fallback.
- [ ] `--no-artifacts` suppresses launch.sh/run.json, still returns valid JSON (`runDir:null, launchScript:null`) and a working launch.
- [ ] `bun lint && bun typecheck && bun test` green; `AGENTWRAP_HELP` lists `--no-artifacts`.

## Done summary

## Evidence
