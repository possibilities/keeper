## Description

**Size:** M
**Files:** src/transcript/codex.ts, src/transcript/registry.ts, test/transcript-codex.test.ts

### Approach

Add the codex rollout reader behind the seam and register it. Discovery: root is the CODEX_HOME override else the home codex dir, rollouts under `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (the filename timestamp uses dash separators with a literal T — parse the uuid from the filename tail, never the timestamp shape); the archived/ subdir is deliberately excluded, stated in a code comment. find is a filename-uuid scan across day-dirs with no content read. list walks day-dirs — narrowed by the --since window when given, with an mtime pre-filter before opening any file — and head-reads only a bounded slice of line 1 (session_meta) for cwd/id/startedAt; the default scope filters session_meta cwd equal to the project (cwd), --project overrides, --global skips the filter, and unwindowed history stays reachable at one bounded head-slice per file. load maps response_item as the structural spine: message role user to user/text, assistant to assistant/text, developer to system with meta true; function_call to tool_call (name, JSON-parsed arguments, call_id), function_call_output to tool_result (call_id, output, isError when present), web_search_call to a web_search-named tool_call; reasoning is skipped (encrypted_content is never rendered). event_msg contributes ONLY agent_reasoning variants, mapped to thinking (file-order interleaving keeps each adjacent to its turn); event_msg agent_message/user_message are suppressed as response_item duplicates — except list firstPrompt, which prefers event_msg user_message because the response_item user turn is padded with injected instruction dumps. Entries order and time-filter by the TOP-LEVEL RolloutLine timestamp, never a payload's inner timestamp. Tolerate a session_meta missing its session id (backfill from the filename uuid) and bare pre-envelope meta lines (fall back to top-level fields); unknown payload/line types and malformed/over-cap lines fold to skip/malformedLines via parse-common. Metadata: project from session_meta cwd, startedAt from the meta line timestamp, updatedAt from the last line timestamp, model from the last turn_context model when present. supportsSubagents is false.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/reader.ts, parse-common.ts, and pi.ts (born in .1/.2) — the contract, primitives, and sibling reader shape
- src/agent/codex-session-index.ts:91, :197-264, :272, :383 — codexSessionIdFromRolloutPath, the adoption scan's bounded walk, windowDayDirs, and the bounded readSessionMeta head read: the reference implementations to re-express
- src/agent/transcript-watch.ts:190-210 and :580-660 — the existing codex payload-shape knowledge (codexMessageText, codexStopFromObject)

**Optional** (reference as needed):
- a real codex sessions tree on this host — rollout line shapes {timestamp, type, payload}
- test/transcript-pi.test.ts (from .2) — fixture style to mirror

### Risks

- An old or partial rollout carrying only event_msg agent_message (no response_item message) would drop assistant text under the spine rule — at rest both always exist; if cheap, emit agent_message only when its turn produced no response_item assistant message.
- list --global with no --since head-reads every rollout in history — acceptable at one bounded slice per file, but keep the mtime pre-filter wired for windowed calls.
- registry.ts is shared with .2 — the dep edge already serializes it.

### Test notes

Synthetic day-dir fixtures under a tmpdir codex home injected via env. Cover: windowed vs unwindowed list, cwd scoping, archived/ exclusion, find by filename uuid, spine mapping of each response_item kind, agent_reasoning-to-thinking interleave, agent_message/user_message dedup plus the firstPrompt preference, developer-role system meta entries, encrypted reasoning skipped, session_meta id backfill and bare meta lines, malformed/oversized folding, and non-main --subagent rejection.

## Acceptance

- [ ] `keeper transcript codex list` scopes to the cwd via session_meta, honors --global/--project/--since, excludes archived/, and reaches old sessions when unwindowed.
- [ ] `keeper transcript codex <session-id>` renders user and assistant text, tool_call/tool_result pairs, and thinking (from agent_reasoning, gated by --thinking) in top-level-timestamp order; event_msg message duplicates never render; encrypted reasoning never renders.
- [ ] list firstPrompt shows the clean human turn, preferring event_msg user_message over the padded response_item user turn.
- [ ] Malformed, oversized, bare-meta, and unknown-type lines fold to counters or skips — never a throw; a meta line missing its session id backfills from the filename.
- [ ] A non-main --subagent selection fails with a no-subagents error; the JSON envelope carries harness codex and an empty subagents list.
- [ ] `bun test` green including the new codex suite.

## Done summary

## Evidence
