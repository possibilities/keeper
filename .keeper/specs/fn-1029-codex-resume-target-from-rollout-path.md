## Overview

Make codex a first-class citizen for the run-capture `resume_target`. Today claude/pi
partners are resumable (keeper pins their session id up front via `--session-id` and echoes it
as `resume_target`), but codex's `resume_target` is always null: codex does NOT accept a
caller-pinned session id — it assigns its own uuid, written only into its rollout file's
`session_meta.payload.id` after it starts. So codex must be discovered POST-STOP, not pinned.

The capture path ALREADY resolves the codex rollout file, and its filename literally carries the
id: `rollout-<ts>-<uuid>.jsonl`. So the fix is small and needs no new discovery machinery: parse
the uuid out of the already-resolved `transcript_path` via an injected seam, and fill
`resume_target` on the outcomes that have a transcript. The caller round-trips with
`keeper agent codex resume <id> "<prompt>"` (codex uses a `resume` subcommand, not `--resume`).

## Quick commands

- `bun run test` — full suite green (gated; no real `~/.codex` read)
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper agent run codex "list files" --output /tmp/c.json` — envelope's
  `resume_target` is the codex session uuid (was null before)

## Acceptance

- [ ] `agent run codex` / `agent wait <codex-handle>` populate `resume_target` from the resolved
  rollout path on `completed`/`no_message`/`timed_out`; `no_transcript` stays null.
- [ ] claude/pi `resume_target` UNCHANGED (still `handle.sessionId`); envelope schema UNCHANGED
  (no new key, no version bump — `resume_target` already exists).
- [ ] Pure-tier tests only (fake seam + sandboxed `CODEX_HOME`); no real `~/.codex`.

## Early proof point

The single task is the whole fix. If parsing the uuid from the transcript filename proves
fragile (an unexpected rollout naming), fall back to reusing `findCodexSessionId` (already live)
with `expectedCwd`+`startedAtMs` — same result, at the cost of its newest-mtime disambiguation.

## References

- `resume_target` is the run-capture envelope field (`run-capture.ts`), distinct from the
  crash-restore/jobs-board `resume_target` in `resume-descriptor.ts` — do NOT touch the latter.
- Why claude/pi work: `tmuxTranscriptSessionId` mints + pins their session id BEFORE launch
  (`--session-id <uuid>`), so the id is known synchronously and is both the transcript key and
  the resume value. `tmuxTranscriptSessionId` correctly returns null for codex — codex genuinely
  can't be pinned; keep it null.
- `codex-session-index.ts` (`findCodexSessionId` + `startCodexSessionNameIndexer`) is live but
  writes codex's own display-name index INSIDE the detached pane; the OUTER capture never reads
  it back. It is not the resume path — do not repurpose the indexer; add a pure filename helper.
- Timing crux: codex's id exists only AFTER it writes its first rollout `session_meta`.
  Discovery MUST be post-stop (inside `captureFromHandle`, after transcript resolution) — never
  at launch. That is exactly when a transcript is guaranteed present.

## Docs gaps

- **`src/agent/dispatch.ts` (`KEEPER_AGENT_HELP` run block ~:191)**: the envelope note lists
  `resume_target`; add a one-line forward-facing note that codex's is discovered from the rollout
  (claude/pi from the pinned session id). Part of the deliverable.
- No README change required beyond the help block unless README enumerates envelope fields.

## Best practices

- **Discover post-stop, never at launch** — the id does not exist until codex writes its rollout.
- **Parse the EXACT resolved file** — use the `transcript_path` the capture already resolved, not
  a fresh directory rescan, to avoid multi-match ambiguity.
- **Keep the parser pure** — a string-in/uuid-out helper is trivially unit-testable with no FS.
- **Seam, not import** — bind the resolver in `runCaptureSeams`; `run-capture.ts` imports TYPES
  ONLY and takes every effect as an injected dep (its dep-free contract).
