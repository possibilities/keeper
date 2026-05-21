## Description
Filter non-`.jsonl` and directory events out of the transcript worker's
`@parcel/watcher` change handling so the per-file tail only ever sees real
transcript files.

## Originating finding

Auditor finding **F1** (tier-1) on `fn-548-live-transcript-title-source`:
"Watcher callback fires on non-jsonl paths causing stderr noise and wasted I/O."

Evidence path (verified in audit):
- `src/transcript-worker.ts:477-488` — the subscribe callback calls
  `stream.onChange(ev.path)` for every non-`delete` event; the
  `ignore: ["**/*.!(jsonl)"]` glob (line 488) does not exclude directory
  events / non-`.jsonl` paths, so they fall through.
- `src/transcript-worker.ts:211-273` — `onChange` runs `statSync` (225),
  `openSync` (251), then `readSync` (268). On a **directory** path `openSync`
  succeeds and `readSync` throws `EISDIR`, caught and logged to stderr at
  :270-272. Result: an EISDIR stderr line + wasted syscalls per directory
  change event in a live `~/.claude/projects` tree, on every active session.
- The comment at `:480` ("the ignore glob filters non-jsonl") is incorrect.

## What to change

1. In the subscribe callback (`src/transcript-worker.ts`, ~line 477), before
   `stream.onChange(ev.path)`, skip any path that is not a `.jsonl` file:
   `if (!ev.path.endsWith(".jsonl")) continue;` (still handle `delete` /
   `unregister` as today — a `.jsonl` delete must still drop tracking).
2. In `TranscriptLineStream.onChange`, add a defensive guard so a directory
   path that somehow reaches it does not hit `openSync`/`readSync`
   (e.g. `if (!statSync(path).isFile()) return;` near the top, folded into the
   existing stat try/catch so a stat failure path stays intact).
3. Fix the stale `:480` comment to state that the in-callback `.jsonl` check
   (not the ignore glob alone) guarantees `.jsonl`-only processing; keep the
   `ignore` glob as belt-and-suspenders.

## Folded tier-0 (opportunistic)

Closes tier-0 `test-gap-non-jsonl-filter` from the source verdict: add a unit
test driving the pure `TranscriptLineStream` / the callback path that asserts a
non-`.jsonl` path and a directory path produce no read and no `custom-title`
emit. Use the existing exported pure core (`TranscriptLineStream` + no Worker)
per the worker's testability contract.
## Acceptance
- [ ] Non-`.jsonl` change events and directory events do not call
      `stream.onChange` (no `statSync`/`openSync`/`readSync` for them).
- [ ] No `EISDIR` (or any read/open failure) stderr line is emitted for a
      directory change event in the watch tree.
- [ ] `.jsonl` `create`/`update` events still tail and emit `custom-title`
      titles exactly as before (no regression in the priority-3 path).
- [ ] `.jsonl` `delete` events still `unregister` the path.
- [ ] `TranscriptLineStream.onChange` returns early on a non-file (directory)
      path without throwing or logging a read failure.
- [ ] The `:480` comment is corrected.
- [ ] A test asserts a non-`.jsonl` path and a directory path are ignored
      (no read, no emit), driven through the exported pure core.
- [ ] `bun test --isolate` passes.
## Done summary

## Evidence
