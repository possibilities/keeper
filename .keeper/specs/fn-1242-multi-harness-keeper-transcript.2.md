## Description

**Size:** S
**Files:** src/transcript/pi.ts, src/transcript/registry.ts, test/transcript-pi.test.ts

### Approach

Add the pi Transcript reader behind the task-1 seam and register it. Discovery: roots are the PI_CODING_AGENT_DIR override else the home pi agent dir, sessions under `sessions/<encoded-cwd>/<ISO-ts>_<uuid>.jsonl` where encoded-cwd is `--` plus the cwd with slashes mapped to dashes plus `--` (re-express the encoder locally; never import src/agent). list scopes to the cwd bucket by default, `--project` selects another bucket, `--global` scans all buckets; title is the LAST session_info name (renames append), firstPrompt the first user message text, updatedAt the max entry timestamp falling back to file mtime. find resolves the uuid by filename across buckets (ambiguous only on a cross-root duplicate). load reads file/append order ignoring the id/parentId tree links — a rewound session renders orphaned branch entries as a superset; comment that caveat — and tolerates every header version (v1 entries lack id/parentId, irrelevant under file order). Entry mapping onto the neutral model: message role user maps to user/text; assistant content blocks text/thinking/toolCall map to text, thinking, and tool_call (name, arguments, block id); role toolResult maps to tool_result (toolCallId, toolName, content, isError); compaction maps to a summary entry; session_info/model_change/thinking_level_change and every unknown type are skipped (metadata model = last model_change modelId). Every entry timestamp comes from the top-level ISO field so --since/--until filter correctly on show; malformed or over-cap lines fold to malformedLines via parse-common. supportsSubagents is false: a non-main --subagent selection errors and subagents is the empty list. Follow the TOCTOU read-and-catch discipline — a vanished file degrades the row, never the page.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/reader.ts, src/transcript/registry.ts, src/transcript/parse-common.ts (born in task .1) — the contract and primitives to build on
- src/agent/transcript-watch.ts:316-360 — findPiTranscriptPath/findPiTranscriptInFiles and the encodePiCwd/readPiMeta helpers (:752, :857): the reference implementation to re-express
- src/transcript/claude.ts (post-.1 shape) — the list scan-then-inspect-page pattern and read-and-catch discipline to mirror

**Optional** (reference as needed):
- a real pi sessions tree on this host — header shape {type:"session", version:3, id, timestamp, cwd}
- test/transcript-cli.test.ts — tmpdir JSONL fixture style to mirror

### Risks

- pi format versions drift (v1 linear, v3 renamed the hookMessage role to custom); file-order reading plus skip-unknown keeps this benign, but never assume id/parentId exist on an entry.
- registry.ts is shared with the codex task — the dep edge serializes the collision.

### Test notes

Synthetic fixtures under a tmpdir pi root injected via env. Cover: bucket-scoped list vs --global, title/firstPrompt/updatedAt extraction, find by uuid and not_found, load mapping of every entry kind, unknown-type skip, malformed and oversized line folding, non-main --subagent rejection, and --since/--until on show.

## Acceptance

- [ ] `keeper transcript pi list` scopes to the cwd bucket, --global lists every bucket, and items carry title, firstPrompt, and updatedAt from real header/session_info/message lines.
- [ ] `keeper transcript pi <session-id>` renders user, assistant text, thinking, tool_call, tool_result, and summary entries in file order with per-entry timestamps, and --thinking/--tools/--role/--since/--grep filter as they do for claude.
- [ ] A malformed or oversized line increments malformed_lines and never aborts the read; unknown entry types are skipped silently.
- [ ] A non-main --subagent selection fails with a no-subagents error; the JSON envelope carries harness pi and an empty subagents list.
- [ ] `bun test` green including the new pi suite.

## Done summary
Added the pi TranscriptReader (list/find/load) behind the src/transcript registry, mapping pi session JSONL (session/session_info/model_change/message/compaction) onto the harness-neutral model with bounded reads, TOCTOU-safe listing, and a no-subagents load path.
## Evidence
