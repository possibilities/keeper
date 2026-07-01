## Description

**Size:** M
**Files:** cli/statusline-sink.ts (new), cli/keeper.ts, src/agent/main.ts, test/statusline-sink.test.ts (new), test/agent-byte-pin.test.ts, test/agent-run-capture-golden.test.ts, test/agent-args.test.ts

Get telemetry OUT of Claude Code and into a per-session leaf file, and wire the statusLine
command onto every keeper-agent claude launch. This is the EARLY PROOF POINT: it starts by
capturing one real statusLine payload to confirm the fold's load-bearing correlation key.

### Approach

FIRST, capture one real statusLine stdin payload from a live session and confirm the contract:
does the payload's `session_id` equal the hook-sourced `jobs.job_id` (the fold's only match
key — a mismatch makes the whole feature a silent no-op)? Is `effort.level` present? What are
the exact `context_window.*` field shapes? Document this at the top of the sink module.

Build `cli/statusline-sink.ts`: read stdin to EOF (never break the pipe), `JSON.parse`, extract
`session_id`, `model.id`, `model.display_name`, `effort.level`, and
`context_window.{used_percentage,total_input_tokens,context_window_size}` (handle
`current_usage: null` before the first API call). Coalesce against the existing leaf's
last-emitted `{model, effort, context-bucket}` using hysteresis buckets (~5%); only when
something changed, atomically write `<statusline-dir>/<sanitized-session>.json` via
tmp-in-same-dir + `rename()` with a DETERMINISTIC temp name. Always exit 0, dependency-light,
never touch the DB or socket — a sink crash must never break the human's statusline. Store the
raw `session_id` (from stdin) INSIDE the leaf JSON, since the filename is sanitized (lossy) and
the fold needs the raw id.

Register `statusline-sink` in `cli/keeper.ts` (SUBCOMMANDS `:22`, USAGE, handlers `:167`),
lazy-importing `cli/statusline-sink.ts` (mirror `cli/bus.ts`).

In `src/agent/main.ts` claude branch (`buildDefaults` ~`:507` / argv assembly ~`:1589`), inject
`--settings <keeper-managed-file>` whose `statusLine.command` is
`bash -c 'tee -i >(keeper statusline-sink) | <chain>'` with `<chain>` defaulting to
`claudectl show-statusline` (configurable). Gate the injection to the claude branch ONLY
(codex/pi have no statusLine). If the human already passes `--settings`, detect it (mirror the
`hasCodexWebSearchOverride` precedent) and skip keeper's injection. Use a settings FILE, not
inline JSON.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:507 — buildDefaults (where launch args assemble); claude branch ~:1589; settings.local.json handling :1591; hasCodexWebSearchOverride override precedent
- src/agent/passthrough.ts:88 — --settings allow-list (confirm it is not otherwise claimed on the claude path)
- cli/keeper.ts:22 — SUBCOMMANDS; :167 handlers map
- cli/bus.ts — a subcommand module template
- plugins/keeper/plugin/hooks/events-writer.ts — the NEVER-blocks / fail-open discipline to mirror

**Optional** (reference as needed):
- test/agent-byte-pin.test.ts, test/agent-run-capture-golden.test.ts, test/agent-args.test.ts — the argv golden pins the new --settings default will move

### Risks

`>(...)` is bash-only — emit `bash -c` (sh/dash silently parse-fail). `tee` without `-i` dies on
SIGPIPE and breaks the display — use `tee -i` and drain stdin fully. `--settings` scalar OVERRIDES
the user's statusLine (fine — the chain re-invokes their display; keep the chain configurable).
Deterministic temp name + fast exit avoids inode/orphan buildup at render frequency. If
`session_id != job_id`, the whole feature is a silent no-op — the capture step exists to catch this.

### Test notes

Pure test drives the sink `main()` with a captured payload on stdin and asserts: the leaf content,
coalescing (no rewrite when unchanged, rewrite on bucket-cross), atomic write, and fail-open on
malformed/empty stdin (exit 0, no throw). Use a `KEEPER_STATUSLINE_DIR` override under the per-test
tmpdir. Update the three agent argv golden pins for the new `--settings` default.

## Acceptance

- [ ] A captured live payload confirms `session_id == jobs.job_id` and documents `effort.level` + `context_window.*` presence
- [ ] `keeper statusline-sink` writes a coalesced leaf (raw session_id inside), exits 0 on any input, never rewrites on unchanged values, never touches DB/socket
- [ ] keeper-agent claude launches inject the `bash -c 'tee -i >(...) | <chain>'` `--settings` wrapper (claude branch only; skipped when the human passes `--settings`); the visible statusline still renders
- [ ] Agent argv golden pins updated; `bun test` green

## Done summary
Added the keeper statusline-sink CLI (coalesced, atomic, fail-open per-session leaf writer) and the claude-only bash -c 'tee -i >(...) | <chain>' --settings injection that wires it onto every keeper-agent launch. Confirmed the load-bearing session_id==jobs.job_id correlation via the reducer invariant.
## Evidence
