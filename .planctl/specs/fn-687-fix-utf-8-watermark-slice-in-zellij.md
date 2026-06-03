## Overview

`scanZellijEventsDir` in `src/daemon.ts` advances `priorOffset` as a byte
count (via `Buffer.byteLength`) but slices the file text with
`text.slice(priorOffset)`, which counts UTF-16 code units. The two indices
diverge the moment any consumed line contains a multi-byte UTF-8 character
(e.g. an emoji in a tab name). When they diverge the slice over-shoots,
truncating the start of the next unconsumed line, which then fails
`JSON.parse` and is silently dropped — and the bad offset is persisted, so
the corruption compounds on every subsequent scan. Since tab names are
transcript-title-derived and emoji are common, this degrades reap-by-tab-id
and the tab-namer worker in normal use.

## Acceptance

- [ ] `scanZellijEventsDir` reads the file as a Buffer and slices by byte
      offset (`buf.subarray(priorOffset).toString("utf8")`) so the watermark
      is consistent on both the read and write sides.
- [ ] A regression test feeds a pre-watermark line whose `tab_name` contains
      a multi-byte UTF-8 character (e.g. an emoji) followed by a second line
      and asserts both lines are parsed correctly after slicing.
- [ ] All existing `zellij-events-worker.test.ts` tests continue to pass.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Confirmed at daemon.ts:791 — priorOffset is byte-indexed (Buffer.byteLength+1) but text.slice() is UTF-16 code-unit indexed; diverge on any multi-byte tab_name character, silently corrupting subsequent scans. |
| F2     | culled | —    | Commit metadata mismatch — pure audit-trail observation, no user-visible impact, no code to change. |
| F3     | culled | —    | ZellijPaneEvent.tab_id null branch is dead against the real producer; no user impact, defensive typing acceptable as-is. |

## Out of scope

- Changing the watermark file format or moving to a streaming reader.
- Any other `scanZellijEventsDir` logic beyond the byte-offset slice.
