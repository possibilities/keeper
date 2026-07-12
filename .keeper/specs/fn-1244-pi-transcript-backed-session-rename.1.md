## Description

**Size:** M
**Files:** src/transcript/model.ts, src/transcript/pi.ts, cli/transcript.ts, cli/descriptor.ts, test/transcript-pi.test.ts, test/transcript-cli.test.ts

### Approach

Extend the landed Transcript reader seam with a machine-oriented `keeper transcript pi turn <session-id> --leaf <entry-id|root> --format json` contract. The Pi reader walks parent links from the requested leaf, then a harness-neutral Latest-turn reducer finds the most recent non-empty user text and includes subsequent assistant text only when the response sequence has a successful terminal `stop`; thinking, tools, results, images, custom entries, and summaries never enter the turn. The envelope distinguishes a valid empty turn from every read/leaf/truncation failure and returns a stable selected-leaf token suitable for command-side stale-result checks.

Bound prompt and response text independently to 8 KiB each, expose truncation flags, and preserve the existing list/show behavior from fn-1242. `root` explicitly selects an empty branch; an absent/malformed/foreign leaf is an error rather than a fallback to physical file order.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `.keeper/specs/fn-1242-multi-harness-keeper-transcript.1.md:1` — landed reader/registry and harness-first CLI contract this task extends
- `.keeper/specs/fn-1242-multi-harness-keeper-transcript.2.md:1` — Pi reader's initial file-order behavior and entry mapping
- `src/transcript/model.ts:1` — neutral role/kind/text/ordinal surface for the Latest-turn reducer
- `cli/transcript.ts:730` — existing structured show envelope and error conventions
- Pi `docs/session-format.md` SessionManager tree API — parent/leaf semantics that physical file order cannot represent

**Optional** (reference as needed):
- `test/transcript-cli.test.ts:200` — existing bounded JSON fixture and CLI assertion patterns
- `src/agent/transcript-watch.ts:316` — Pi session discovery precedent only; do not import from `src/agent`

### Risks

- A selected leaf can point at metadata after the response; branch walking must retain the full path while turn reduction ignores metadata.
- Intermediate assistant messages can end in tool use; aggregate their text only when a later assistant message terminates successfully, and reject aborted/error/length partial output.
- This task lands after fn-1242 and must preserve its registry seam and existing exports rather than reopening the reader architecture.

### Test notes

Use synthetic Pi trees containing abandoned later-file branches, metadata leaves, prompt-only branches, multi-message tool-use responses, aborted/length/error responses, empty/image-only user entries, oversized text, malformed parent links, unknown leaves, and explicit root selection. Keep every test pure and filesystem-sandboxed.

## Acceptance

- [ ] `keeper transcript pi turn <session-id> --leaf <entry-id|root> --format json` returns `turn: null` for a valid branch with no non-empty user text, or `{ prompt, response }` where response is null until a complete assistant response exists.
- [ ] Turn selection follows only the requested leaf-to-root parent path; abandoned entries later in the JSONL file cannot influence the result, and root/unknown/malformed/foreign leaf cases are unambiguous.
- [ ] Assistant text is aggregated in order only after a successful terminal stop; thinking, tool calls/results, images, custom messages, summaries, and incomplete assistant output are excluded.
- [ ] Prompt and response are capped at 8192 characters each with explicit truncation metadata; malformed transcript data, an invalid leaf, and command failure never masquerade as `turn: null`.
- [ ] Existing `keeper transcript <harness> list/show/<session-id>` behavior and bounded paging remain unchanged for every registered reader.
- [ ] `bun test test/transcript-pi.test.ts test/transcript-cli.test.ts` and the full fast suite are green.

## Done summary
Added keeper transcript pi turn: a branch-aware (leaf-to-root parentId walk) Latest-turn JSON contract aggregating assistant text across tool-use messages, gated on a successful terminal stop, with independently capped+truncation-flagged prompt/response and explicit empty/prompt-only/complete states distinct from read/leaf failures.
## Evidence
