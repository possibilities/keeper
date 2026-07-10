## Description

**Size:** M
**Files:** src/transcript/render.ts, cli/transcript.ts, cli/descriptor.ts, test/transcript-cli.test.ts

### Approach

Two interlocking contract fixes to the show renderer, plus the help/descriptor sync they
both require. First: human entry labels currently print the UNFILTERED ordinal while
`range`/`older_before`/`newer_offset`/`--offset`/`--before` are FILTERED positions — an
agent feeding a displayed `#N` back as a paging flag silently gets the wrong page. Labels
switch to the filtered page position: `page.offset + local index`, computed AFTER the
backward branch's reverse, using `page.offset` (which already includes skippedFromFront)
— NOT requestedOffset. JSON `index`/`sourceIndex` keep their ordinal semantics unchanged
(no schema bump); help text states the intentional divergence: `#N` round-trips with
paging flags under the SAME filters but is not a durable cross-filter handle.

Second: `--max-chars` becomes an honest TOTAL budget. The rendered header (including
subagent lines) counts against the budget and entries get the remainder, with a floor of
one force-fitted entry; the human-render subagent header is capped (~12 lines plus a
"+M more" tail) while JSON keeps the complete subagents array. The silent
`max(1000, maxChars - 4000)` reserve goes away or becomes exact accounting.

Sync all hand-maintained doc surfaces together: SHOW_HELP, AGENT_HELP (its
"32000-character budget" line), and the descriptor flag summaries — the descriptor stays
pure data (import-purity test). Avoid the word "cursor" in help wording (CONTEXT.md
reserves it for the fold cursor).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/render.ts:315 — entryLabel prints `#${entry.index}`; receives no page position today (plumbing change through renderTranscriptEntriesText at :339-352)
- src/transcript/render.ts:297-302 — page.offset = requestedOffset + skippedFromFront; the backward branch reverses selected at :277
- cli/transcript.ts:610 — the silent budget adjust; :285-322 renderShowText header assembly
- cli/transcript.ts:92 and :106-116 — SHOW_HELP / AGENT_HELP wording to update

**Optional** (reference as needed):
- cli/descriptor.ts:1014-1150 — transcript descriptor block (flag summaries; keep import-pure)
- test/transcript-cli.test.ts:205-228 — older_before adjacency test that must keep holding

### Risks

- An off-by-skippedFromFront in the label is exactly the bug class this fixes, reintroduced — pin it with a char-clipped backward-paging test
- TRANSCRIPT_SCHEMA_VERSION stays 1: no JSON field shapes change; if implementation pressure suggests a new JSON field, prefer deriving from page.offset + array position instead

### Test notes

Add a test where a filtered view (default meta/thinking exclusion) shows first-label ==
page.offset, and a round-trip test: take a rendered label N, re-run with --before/--offset
N under identical filters, assert adjacency. Assert human output length <= requested
--max-chars at small budgets, and the "+M more" subagent tail.

## Acceptance

- [ ] The first entry label on any page equals the page's reported start offset, and label numbers round-trip through --offset/--before to the same entries under identical filters
- [ ] Human output never exceeds the requested --max-chars, down to a documented minimum of header plus one force-fitted entry
- [ ] A many-subagent session renders a bounded header with a "+M more" tail; JSON retains the complete subagent list
- [ ] --help, --agent-help, and descriptor summaries state the total-budget semantics and the label-vs-JSON-index distinction; descriptor purity and conformance tests stay green

## Done summary

## Evidence
