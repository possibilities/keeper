## Description

**Size:** S
**Files:** plugins/keeper/pi-extension/keeper-events.ts, test/pi-extension.test.ts

### Approach

Bound and harden the keeper_transcript tool bridge while keeping the extension node:*-only,
fail-open, and isolated (CLAUDE.md hook rules — never import src/transcript or pi's dep
tree). (a) Clamp model params in transcriptCliArgs: max_chars <= 60000; limit <= 100 for
list, <= 500 for show (worst-case ~4 bytes/char keeps output under the 256KB byte
maxBuffer); record applied clamps in the result details, not as errors. (b) Branch
maxBuffer overflow out of the failure path: when error.code === ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
resolve with the truncated stdout as content plus an explicit truncation notice
("truncated - narrow with grep/limit"); other errors keep failing as today. (c) Validate
session_id (and subagent) against a LOCAL copy of the safe-id shape
(^[A-Za-z0-9][A-Za-z0-9._-]*$, length <= 200) before argv assembly; reject with a clean
tool-error message before any subprocess spawns; comment that the charset deliberately
mirrors isSafeSessionId (isolation forbids the import — drift is accepted and noted).
(d) Verify pi's actual tool-parameter contract by reading the installed pi package source
read-only (pi 0.80.6 launches via `keeper agent pi`; locate the binary through keeper's
agent launch path). If pi's validation keys off Symbol.for("TypeBox/Kind"), attach that
symbol in the schema() helper via Object.defineProperty — Symbol.for is a global-registry
lookup, zero imports, isolation preserved — while keeping the plain-JSON shape. If pi
accepts plain JSON schema, close the finding by documenting that in the schema helper.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/pi-extension/keeper-events.ts:332 — TRANSCRIPT_TOOL_MAX_BUFFER; :390-421 — pushStringFlag/pushNumberFlag + transcriptCliArgs (clamp + guard sites)
- plugins/keeper/pi-extension/keeper-events.ts:428-465 — executeTranscriptTool error branch (the overflow re-route)
- plugins/keeper/pi-extension/keeper-events.ts:334-382 — schema()/stringSchema/numberSchema/booleanSchema and the string "~kind" marker
- src/transcript/claude.ts:114-120 — isSafeSessionId, the charset to mirror (do NOT import)

**Optional** (reference as needed):
- test/pi-extension.test.ts:204-243 — pure transcriptCliArgs argv tests to extend; :331 — registry assertion

### Risks

- pi's contract inspection may show tool registration ignores schema validation semantics entirely; then the marker sub-finding closes as a documented no-op
- maxBuffer counts bytes, params count chars — the clamps assume <=4 bytes/char worst case; state the assumption in a comment

### Test notes

Stay pure (no execFile spawn): test clamps and rejection at the transcriptCliArgs level,
and the overflow branch by invoking the callback path with a synthetic
ERR_CHILD_PROCESS_STDIO_MAXBUFFER error object if the structure permits.

## Acceptance

- [ ] Oversized limit/max_chars values produce bounded argv and a successful call, with the applied clamp visible in the tool result details
- [ ] A maxBuffer overflow returns the truncated transcript as content with an explicit truncation notice, not a failure message
- [ ] A session_id shaped like a flag or verb is rejected with a clear error before any subprocess spawns
- [ ] The parameters schema is confirmed against the installed pi contract, with either the TypeBox Kind symbol attached dep-free or plain-JSON acceptance documented in the schema helper
- [ ] The extension remains node:*-only and fail-open; pi-extension tests stay green and spawn no subprocess

## Done summary

## Evidence
