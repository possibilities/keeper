## Description

**Size:** M
**Files:** src/frames-emitter.ts, test/frames-emitter.test.ts

### Approach

Create the one module owning the frames wire contract, consumed later by both
`createViewShell` and usage's open-coded shell path. It exposes: an envelope
builder emitting ONE single-line JSON object per record —
`{schema_version, type, seq, ts, view, cursor, diff, diff_truncated,
frame_path, state_path, diff_path}` with `type` in
`baseline | frame | keepalive | trailer` (baseline carries `diff: null`); a
per-process contiguous `seq` counter; a size-bounded inline unified diff behind
an injectable `diffFn` seam (prod default shells `diff -u` exactly like the
view-shell sidecar site; tests inject a pure fake — the repo's no-subprocess
test rule leaves no alternative); a trailer builder carrying
`{resume_cursor, coverage, frames_emitted, reason}` where coverage is
`continuous` only when the run saw no reconnect and `seq` stayed contiguous,
else `gap_possible`; bound tracking for a duration bound and a max-frames
bound (emitted data frames count against max-frames; keepalives do not); a
keepalive record carrying the current `seq` (mirror the shape discipline of
`createDeltaEmitter` in cli/watch.ts); and an in-process sidecar ring that
retains the last N frame sidecar triples and prunes ONLY files this process
wrote — never a cross-pid sweep. The schema version is a NEW constant, never
shared with the frozen snapshot `keeper-meta:` schema. IO and clock are
injectable following the SnapshotIo precedent; `JSON.stringify` is the only
serializer (single-line output is the injection guard — frame text embeds
attacker-influenced slugs/reasons/titles). `cursor` is an opaque non-unique
checkpoint: wall-clock staleness repaints legally share a `rev`.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/view-shell.ts:651-696 — writeSidecars: the sidecar triple + `diff -u` subprocess site whose behavior the prod diffFn mirrors
- cli/watch.ts:468-565 — createDeltaEmitter: seq counter, envelope shape, injected setInterval keepalive — the wire-format sibling to mirror
- src/view-shell.ts:304-318 — SnapshotIo injectable IO/clock precedent
- src/snapshot.ts:42-45 — SNAPSHOT_SCHEMA_VERSION + KEEPER_META_PREFIX constants pattern (mint a separate frames constant beside them, do not reuse)

**Optional** (reference as needed):
- test/watch.test.ts:466-550 — driveEmitter fake-clock harness, the template for keepalive/seq tests
- test/view-shell.test.ts:700-780 — snapshotIo injection harness template
- docs/adr/0012-agent-frame-stream-wire-contract.md — the settled contract this module implements

### Risks

- The emitter's API is consumed by two structurally different shells (shared view-shell + usage's open-coded dual-stream path); a signature assuming single-stream state will force a rework — keep per-stream once-gating the CALLER's job, emit-time state minimal.
- Diff bounding must count bytes/lines BEFORE inlining; a truncated diff sets `diff_truncated: true` and the consumer falls back to `diff_path`/`frame_path`.

### Test notes

Pure tier only: injected diffFn, IO sinks, fake clock. Cover: baseline vs
frame typing, seq contiguity, truncation marker with counts, trailer on every
termination cause (max-frames, duration, injected interrupt), keepalive seq,
ring pruning own files only (fake fs paths), single-line output for frame text
containing newlines/quotes/ANSI.

## Acceptance

- [ ] Every emitted record is one independently-parseable single-line JSON object; frame text with embedded newlines/quotes cannot break framing
- [ ] Baseline records carry type "baseline" and null diff; data frames carry a unified diff or a truncation marker with byte/line counts plus valid sidecar pointers
- [ ] A trailer with resume cursor and coverage verdict is produced for every termination cause the harness can drive, and coverage reads gap_possible whenever a reconnect or non-contiguous seq occurred
- [ ] Max-frames counts data frames only; keepalives carry the current seq and never count
- [ ] The sidecar ring never deletes a path it did not itself write
- [ ] All of the above proven in the pure test tier with no subprocess

## Done summary
Added src/frames-emitter.ts owning the keeper frames NDJSON wire contract (single-line baseline/frame/keepalive/trailer envelopes, contiguous seq, injectable size-bounded diff seam, honest continuous/gap_possible coverage trailer, own-files-only sidecar ring) plus 22 pure-tier tests with no subprocess.
## Evidence
