## Description

**Size:** M
**Files:** cli/search-history.ts, cli/find-file-history.ts, cli/show-session-events.ts, cli/keeper.ts, test/keeper-cli.test.ts, test/*.test.ts, package.json

### Approach

Add three read-only verbs as `cli/<verb>.ts` modules copying the
`session-state.ts` skeleton (parseArgs / HELP / printPretty / run /
main / `import.meta.main` guard), registered in all three load-bearing
spots in `cli/keeper.ts` (SUBCOMMANDS tuple, USAGE block, lazy-import
handlers map). Every DB open goes through `openDb(path, { readonly:
true })` from `src/db.ts` and closes in `finally`; every `events`
payload read AND filter goes through `COALESCE(events.data,
event_blobs.data)` with `LEFT JOIN event_blobs ON event_blobs.event_id
= events.id`, or compacted (older) events are silently missed. Read
failures surface as error envelopes, not empty results. No FTS, no
schema change, and no schema-version guard in TS — in-binary readers
deliberately skip it.

Verbs: `search-history <term>` (UserPromptSubmit rows whose payload
matches LIKE, emitting ts, session_id, prompt snippet via
json_extract on the COALESCEd payload); `find-file-history
<path-fragment>` (file_attributions matches most-recent-first with
session_id, mutation time, op, source); `show-session-events
--session-id <id>` (the UserPromptSubmit/PreToolUse spine for one
session: ts, hook_event, tool_name, slash_command/skill_name/
planctl_op).

### Investigation targets

**Required** (read before coding):
- cli/session-state.ts — the skeleton to copy (parseArgs, HELP, printPretty, readonly open swallowed-vs-surfaced decision)
- cli/show-session-files.ts — required `--session-id` flag pattern for the spine verb
- cli/keeper.ts:26,41,139 — SUBCOMMANDS, USAGE, handlers map; routing test iterates SUBCOMMANDS
- src/commit-work/attribution.ts:188-238 — canonical readonly reader (openDb readonly, query in try, close in finally)
- src/reducer.ts:4863-4903 — the exact COALESCE + LEFT JOIN events/event_blobs pattern to copy verbatim
- src/db.ts:358,824,951 — CREATE blocks for events, event_blobs, file_attributions (events.data is nullable post-compaction)
- test/session-state.test.ts and test/keeper-cli.test.ts — the two required test styles (spawn-based integration + routing unit)
- test/helpers/sandbox-env.ts — sandboxEnv is mandatory for every CLI spawn (pins all KEEPER_* paths)
- package.json:16 — spawn-heavy integration tests join the non-parallel ignore list

## Acceptance

- [ ] `keeper search-history <term>` returns matching UserPromptSubmit rows (ts, session_id, prompt snippet) including compacted events, JSON on stdout
- [ ] `keeper find-file-history <path-fragment>` lists file_attributions matches most-recent-first (session_id, mutation time, op, source)
- [ ] `keeper show-session-events --session-id <id>` emits the prompt/tool-call spine for that session
- [ ] all three appear in SUBCOMMANDS, USAGE, and the handlers map; each has a HELP string; routing test extended and green
- [ ] one sandboxEnv-isolated integration test per verb (seeded rows, including one compacted-event case for search); fast tier + typecheck green

## Done summary
Added three read-only history verbs (search-history, find-file-history, show-session-events) to the keeper CLI, registered in SUBCOMMANDS/USAGE/handlers, with COALESCE(events.data, event_blobs.data) for compacted-event coverage and per-verb sandboxEnv integration tests.
## Evidence
