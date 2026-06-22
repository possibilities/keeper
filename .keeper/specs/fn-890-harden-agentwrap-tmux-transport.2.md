## Description

**Size:** M
**Files:** src/main.ts, src/tmux-launch.ts

Make the tmux-launch a stable machine-readable contract a programmatic caller
can bind on. Two coupled changes: print the window-created JSON immediately,
decoupled from the transcript-stop wait (Patch B), and a stable single-line
JSON schema plus a distinct exit-code taxonomy (Patch G).

### Approach

- **Immediate result (B):** in `main()` (~543-625) the `await waitForTranscriptPath` (~575) is UNCONDITIONAL today and gates the JSON print behind up to 30s. Move the window-created JSON print to immediately after `parseCreatedTarget` succeeds, and gate the transcript-path poll + stop-wait + the `transcriptPath===null → exit 1` branch (~583) behind `tmuxLaunch.options.waitForStop`. Non-`--wait-for-stop` launches print one line and exit 0 at once.
- **Single schema (B+G):** ONE JSON shape for both modes — `{ schema_version, session, windowId, paneId, runDir, launchScript, transcriptPath, waitedForStop }`. Non-wait mode emits it with `transcriptPath:null, waitedForStop:false`. `--wait-for-stop` emits the SAME shape populated. No two-line / `phase` discriminator. Built in `tmuxMetadata` (~459-489).
- **Exit codes (G):** extend `TmuxLaunchError(message, exitCode)` (the sole carrier, ~14-21) usage to mint distinct codes: tmux-not-found (~224) and session-not-found → 3 (prereq/no-op); timeout / lock contention (from the spawn-hardening timeout result) → 4 (transient/retryable); parse failures (~540/544) and other internals → 1; bad-args stays 2. Map them through the top-level catch (~618-624). Emit a structured JSON error object (with `schema_version` + a machine reason) even on non-zero exit (Pattern A), diagnostics to stderr.

### Investigation targets

**Required:**
- src/main.ts:543-625 — the tmux-mode branch; B lives here (the unconditional `await waitForTranscriptPath` at :575, the `--wait-for-stop` null→exit1 at :583, the catch at :618-624).
- src/main.ts:459-489 — `tmuxMetadata` (the JSON shape); add `schema_version`, unify the modes.
- src/transcript-watch.ts:24,27 — `DEFAULT_PATH_TIMEOUT_MS=30_000` + `waitForTranscriptPath` (the wait that B gates).
- src/tmux-launch.ts:14-21,586-589,224,540-544 — `TmuxLaunchError` + `tmuxError` + the not-found/parse exit sites G reclassifies.

**Optional:**
- test/tmux-launch.test.ts:84-90,166-171 — `parseJsonOutput` (parses the LAST stdout line); pin the new schema + that non-wait mode is a single line.

### Risks

- Back-compat: existing non-keeper callers no longer get a 30s-delayed JSON with a populated `transcriptPath` by default. Document the behavior change (CLAUDE.md says the JSON "includes transcript path"); no shim needed but call it out.
- Exit-code collisions: do NOT reuse 2 (bad-args) for prereq/transient; pin every code in a test so the taxonomy can't silently drift.
- `schema_version` must appear on BOTH the success and the error JSON.

### Test notes

Via `makeHarness` + injected `runTmuxCommandFn`: assert non-`--wait-for-stop` prints exactly one JSON line with `transcriptPath:null, waitedForStop:false` and exits 0 WITHOUT invoking the transcript watcher; `--wait-for-stop` emits the same schema populated; a simulated tmux-not-found exits 3, a timeout exits 4, a parse failure exits 1, and each emits a structured JSON error.

## Acceptance

- [ ] Non-`--wait-for-stop` tmux launch prints one JSON line and exits 0 immediately after the window is created (no transcript-path wait).
- [ ] One JSON schema with `schema_version` serves both modes; non-wait carries `transcriptPath:null, waitedForStop:false`.
- [ ] Exit codes: not-found/session-not-found=3, timeout/contention=4, bad-args=2, internal/parse=1, success=0; a structured JSON error is emitted on non-zero exit.
- [ ] `bun lint && bun typecheck && bun test` green; CLAUDE.md tmux-transport JSON/exit-code description updated to match.

## Done summary
tmux mode now prints one schema_version'd JSON line immediately for non-wait launches (decoupled from the transcript poll) and a distinct exit-code taxonomy (3 prereq, 4 transient, 1 internal, 2 bad-args) with a structured JSON error on every non-zero exit.
## Evidence
