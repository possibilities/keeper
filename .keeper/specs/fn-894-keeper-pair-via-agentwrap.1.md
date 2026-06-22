## Description

**Size:** M
**Files:** src/dispatch.ts, src/transcript-watch.ts, src/main.ts, src/args.ts, test/

### Approach

Add two composable subcommands so a caller can decouple launch / wait / read:
`agentwrap wait-for-stop <handle>` (block until the agent's transcript shows a stop event)
and `agentwrap show-last-message <handle>` (print the partner's FINAL assistant message text,
extracted from the per-backend transcript JSONL). `<handle>` is the transcript path (or a
run id resolving to it) from the detached launch JSON. **Delete the `--wait-for-stop` launch
flag** — `keeper pair` is its first/only consumer, so there is no migration cost; the new
flow is `launch-detached → wait-for-stop → show-last-message`. The launch path keeps
`--agentwrap-tmux --agentwrap-tmux-detached` returning the machine-readable JSON immediately.
Reuse the per-backend stop-detection that already exists in `transcript-watch.ts`; the new
work is extracting the *text* of that final message (claude: last `type:"assistant"` with
`stop_reason!=="tool_use"`; codex: the `task_complete` event's message; pi: `turn.completed`).

### Investigation targets

**Required** (read before coding):
- src/transcript-watch.ts:5-10,45-61,151-230 — `TranscriptStop` shape + per-backend stop detection; extend to pull the final message text.
- src/main.ts:476-693 — launch JSON schema + the `--wait-for-stop` branch to remove.
- src/dispatch.ts:107-125 — subcommand dispatch (`splitSubcommand`); add the two verbs.
- src/args.ts — flag parsing; remove `--wait-for-stop`.

**Optional**:
- The fn-890.2 launch-contract spec (`.keeper/specs/fn-890*`) for the JSON schema_version convention.

### Risks

- Deleting `--wait-for-stop` touches fn-890's just-landed surface; fn-890.5 (in-progress) documents the transport — coordinate so its docs describe the subcommands, not the dead flag.
- Final-message extraction must define a fallback for a tool-only / empty / refusal final turn (emit a clear empty/`failed` signal, not silent "").
- `show-last-message` on an unfinished run: decide whether it errors or prints the latest assistant message so far (recommend: prints latest; `wait-for-stop` is the blocking primitive).

### Test notes

Add bun:test coverage: `wait-for-stop` blocks until a stop event appears in a fixture transcript; `show-last-message` extracts the correct final text for claude AND codex fixtures; the removed flag errors cleanly.

## Acceptance

- [ ] `agentwrap wait-for-stop <handle>` blocks until the per-backend stop event, then exits 0.
- [ ] `agentwrap show-last-message <handle>` prints the partner's final assistant message for claude and codex.
- [ ] `--wait-for-stop` flag is removed; detached launch returns the handle/transcriptPath JSON.
- [ ] Empty/tool-only final turn yields a defined signal, not a silent empty string.
- [ ] bun:test covers both subcommands per backend.

## Done summary
Added agentwrap wait-for-stop + show-last-message subcommands (per-backend final-message extraction for claude/codex/pi) and removed the --wait-for-stop launch flag; detached launch returns the handle JSON consumed by the verbs.
## Evidence
