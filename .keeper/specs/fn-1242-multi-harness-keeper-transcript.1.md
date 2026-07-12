## Description

**Size:** M
**Files:** src/transcript/reader.ts, src/transcript/registry.ts, src/transcript/parse-common.ts, src/transcript/claude.ts, cli/transcript.ts, cli/descriptor.ts, plugins/keeper/pi-extension/keeper-events.ts, test/transcript-cli.test.ts, test/pi-extension.test.ts, test/escalation-guard.test.ts, README.md

### Approach

Introduce the Transcript reader seam and flip the CLI to the harness-first grammar in one behavior-preserving move. `src/transcript/reader.ts` defines the `TranscriptReader` contract — `harness`, `supportsSubagents`, `list(query)`, `find(query)` returning found/not_found/ambiguous (the ambiguous arm carries owner dirs plus a reader-supplied disambiguation hint), `load(handle, subagent)` — with root discovery INSIDE the reader: the CLI passes homeDir/env/configDirs, never resolved roots, so no claude-shaped roots/bucket concept leaks into the interface. `src/transcript/registry.ts` maps harness token to reader and is the single membership root: help text and the unsupported-harness error derive from its keys (claude only after this task; pi/codex join in the sibling tasks). `src/transcript/parse-common.ts` receives the harness-neutral primitives extracted from claude.ts (ParseState/pushEntry, recordOf/stringOrNull/parseTimestamp/contentText, the tool-name back-fill, malformed/startedAt/updatedAt tracking) plus a shared per-line byte-cap guard readers apply before JSON.parse; claude.ts implements the interface on top while keeping its currently-exported functions, which the test suite imports directly. cli/transcript.ts peels argv position 0 against the registry exactly as keeper agent's splitSubcommand peels its harness token, then routes the rest through the existing list/show/bare-id router; the --harness flag and validateHarness are deleted, and the hardcoded claude harness strings (two text headers, two JSON fields), the claude-worded no-roots error, the recovery hint, and the config-dir/project ambiguity hint all become reader-driven. Grammar corners: bare `keeper transcript`, `-h`/`--help`, `--agent-help`, and a harness token with empty rest print help; an unrecognized position-0 token (hermes included) fails exit 2 naming the registry keys. Migrate buildTranscriptArgv in the pi extension to emit `["transcript","claude",…]` (pure argv assembly — the extension stays jiti-isolated with no new imports) and re-spell every test and doc call site. `--config-dir` is documented claude-only; other readers ignore it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/transcript.ts:767-778 — the router gaining the harness peel; :274 validateHarness (delete); :281 parseRoots (moves behind the reader)
- cli/transcript.ts:317, 382, 509, 747 — the four hardcoded claude harness outputs; :676 recovery hint; :493 and :665 claude-worded no-roots error; :680-698 claude-specific ambiguity hint (moves into the claude reader)
- src/transcript/claude.ts:193-261 — the neutral primitives to extract; :514-522 tool-name back-fill; :415 parseLine malformed handling
- src/agent/dispatch.ts:359-395 — splitSubcommand, the leading-positional precedent to mirror
- cli/descriptor.ts:1032-1140 — transcript rows: delete the two harness flag objects (:1050-1056, :1096-1099), update summaries saying "currently claude", carry the harness grammar in the command summary (agent-command precedent at :1326 and :1339-1349)
- plugins/keeper/pi-extension/keeper-events.ts:502-530 — buildTranscriptArgv and transcriptCliArgs
- test/transcript-cli.test.ts:18-20 — direct imports from src/transcript/claude (keep those exports or update the imports); :200 run() helper (prepend the claude token)

**Optional** (reference as needed):
- test/pi-extension.test.ts:360-390 — buildTranscriptArgv assertions
- test/escalation-guard.test.ts:32 — allowlist fixture string gains the claude positional
- README.md:13 — History-forensics bullet re-spell
- cli/keeper.ts:586 — the lazy import; nothing reachable from cli/transcript.ts may pull bun:sqlite, src/db.ts, or src/agent/*

### Risks

- The largest surface of the epic; claude behavior preservation rests on the mechanical test re-spell — resist improving claude semantics while extracting.
- The suite imports claude internals directly: moving an export without updating imports breaks loudly (fine); changing encodeClaudeProject behavior breaks subtly (do not touch the encoder).
- The unsupported-harness error and help text must derive from the registry keys so the sibling reader tasks never edit the wording.

### Test notes

Re-spell the existing suite by prepending the claude token to every runTranscriptCli argv — a green suite proves the refactor is behavior-preserving. Add cases: bare/empty-rest/help routing, unknown-token and hermes rejection (exit 2 naming the supported set), --harness now rejected by strict parseArgs, and the pi-extension argv shape.

## Acceptance

- [ ] The claude positional forms (list, show with id, bare id) match the prior flag form's output for claude sessions, and the pre-existing transcript CLI suite passes with only the positional prepended.
- [ ] Bare `keeper transcript`, `-h`/`--help`, `--agent-help`, and a harness token with empty rest print help; `--harness` no longer parses anywhere.
- [ ] `keeper transcript hermes list` and any unknown position-0 token exit non-zero with a message naming the supported harness set, derived from the registry keys.
- [ ] The pi-extension transcript tool builds the claude-positional argv, its tests prove it, and the extension gains no new imports.
- [ ] No module reachable from the transcript CLI imports bun:sqlite, src/db.ts, or src/agent modules.
- [ ] `bun test` green.

## Done summary
Introduced the TranscriptReader seam (reader.ts/registry.ts/parse-common.ts) and flipped keeper transcript to the harness-first grammar (keeper transcript <harness> list|show|<session-id>); claude.ts implements the interface behind its preserved exports, --harness is gone, unregistered harnesses fail naming the registry keys, and the pi-extension + test suite are re-spelled for the new grammar.
## Evidence
