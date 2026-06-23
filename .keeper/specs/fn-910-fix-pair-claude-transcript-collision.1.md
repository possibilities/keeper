## Description

**Size:** M
**Files:** src/main.ts, src/tmux-launch.ts, src/transcript-watch.ts, test/pair-subcommands.test.ts (+ test/tmux-launch.test.ts as needed)

### Approach

Root cause (confirmed in source): the partner claude's session id diverges
from run.json's `transcriptSessionId` because the `AGENTWRAP_TMUX_SESSION_ID`
carrier is set on `req.env` (`main.ts:677-683`) but the pane env is forwarded
ONLY via `envArgs(req.options.env)` (`tmux-launch.ts:494/509`). On an existing
tmux server the inner re-exec (`main.ts:1174-1184`) does `sessionUuid = tmuxSessionUuid ?? randomUuid()`
and, not seeing the carrier, mints a FRESH uuid → writes `<fresh>.jsonl` while
the resolver looks up `<transcriptSessionId>.jsonl`, missing → newest-by-mtime
→ a concurrent driver wins. Three changes:

1. **Forward the session-id carrier into the pane** so the inner re-exec's
   existing `--session-id` push (`main.ts:1178`) uses the SAME uuid as run.json
   `transcriptSessionId`. Cleanest seam: in `launchAgentwrapInTmux` (or at the
   `main.ts:684-698` call site) when `transcriptSessionId !== null`, add
   `["AGENTWRAP_TMUX_SESSION_ID", <id>]` to the forwarded `-e` list
   (`req.options.env`), not just `req.env`. Keep run.json `transcriptSessionId`,
   the `-e` carrier, and the inner `--session-id` all sourced from the one
   `transcriptSession.sessionId`. Do NOT double-inject — the inner already skips
   when `--session-id` is present (`main.ts:1176`).

2. **Strict pinned resolution.** In `findClaudeTranscriptPath`
   (`transcript-watch.ts:189-195`), when `sessionId !== null` return the exact
   `<uuid>.jsonl` or null — NEVER fall through to `newestFreshFile`. Apply the
   same to `findPiTranscriptInFiles`' id path. Keep newest-by-mtime ONLY for the
   no-session-id case (codex). This turns any future divergence into a loud
   30s path-timeout instead of a silent wrong file.

3. **Bound `waitForTranscriptStop`** (`transcript-watch.ts:65-81`): it loops
   `while(true)` with no ceiling. Add a wall-clock deadline mirroring
   `waitForTranscriptPath`'s `DEFAULT_PATH_TIMEOUT_MS` pattern (`:44-63`), with a
   GENEROUS default (a real model turn runs minutes — codex took 238s — so
   ~600s, overridable via the existing opts). On timeout return a structured
   result; map it to the RETRYABLE (exit 4) path in `runWaitForStop`'s caller,
   mirroring the existing path-timeout mapping near `main.ts:574`.

### Investigation targets

**Required** (read before coding):
- src/main.ts:669-698 — outer detached launch (carrier on req.env, transcriptSessionId into run.json)
- src/main.ts:1172-1187 — inner re-exec `--session-id` push (the divergence point)
- src/tmux-launch.ts:457-513 — pane creation; `envArgs(req.options.env)` is the only `-e` forward
- src/tmux-launch.ts:620-625 — `envArgs`
- src/transcript-watch.ts:182-196 — `findClaudeTranscriptPath` mtime fall-through
- src/transcript-watch.ts:65-81 + :44-63 — unbounded stop wait + the bounded path-timeout pattern to mirror
- src/pair-subcommands.ts:182-249 — both verbs share `resolveTranscriptPath`

**Optional:**
- src/main.ts:431-463 — `existingSessionId` / `tmuxTranscriptSessionId`
- test/_main-harness.ts:97 — `makeHarness` (`randomUuid` seam, `spawn` recorder)
- test/pair-subcommands.test.ts:71-99 — `writeClaudeTranscript` helper

### Risks

- Codex MUST keep newest-by-mtime (it has no session pin) — scope strict-no-fallthrough to the claude/pi pinned path only; do not regress `findCodexTranscriptPath`.
- Don't double-inject `--session-id` (inner skips when present); one source of truth.
- `-e` must carry on BOTH the new-window and new-session branches (it does: lines 494/509).

### Test notes

In test/pair-subcommands.test.ts, write TWO claude transcripts under one
project dir via `writeClaudeTranscript(home, cwd, sessionId, …)`: the partner's
`<transcriptSessionId>.jsonl` and a NEWER-mtime decoy "driver" file. Assert
`show-last-message` AND `wait-for-stop` resolve the partner's pinned session,
never the newer decoy; assert strict mode returns null (not the decoy) when the
pinned file is absent. Add a launch-argv assertion (via `makeHarness`
`randomUuid` seam + spawn recorder, or test/tmux-launch.test.ts) that the inner
claude receives `--session-id` matching run.json `transcriptSessionId`. Run
`bun test && bun lint && bun typecheck`.

## Acceptance

- [ ] Partner claude launches with `--session-id` equal to run.json `transcriptSessionId` (carrier forwarded into the pane; no fresh-uuid divergence on an existing tmux server).
- [ ] `findClaudeTranscriptPath` returns exact-or-null when a session id is pinned; no newest-by-mtime fall-through for the claude/pi pinned path; codex resolution unchanged.
- [ ] `waitForTranscriptStop` is bounded by a wall-clock deadline and surfaces a structured timeout mapped to the RETRYABLE exit; no unbounded `while(true)`.
- [ ] Regression test: a concurrently-updated newer decoy transcript does NOT win — both verbs resolve the pinned partner; strict mode returns null when the pinned file is absent.
- [ ] `bun test`, `bun lint`, `bun typecheck` pass.

## Done summary

## Evidence
