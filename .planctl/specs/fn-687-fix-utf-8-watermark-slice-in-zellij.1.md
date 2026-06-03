## Description

Finding F1 (audit of fn-684-zellij-event-bridge-plugin): `src/daemon.ts:791`
computes `const tail = text.slice(priorOffset)` where `text` is a JS string
(UTF-16) and `priorOffset` is a byte offset (advanced via
`Buffer.byteLength(line, "utf8") + 1` at line 817 and compared against
`st.size` which is also in bytes). For ASCII-only content the indices
coincide, but for any non-ASCII character (emoji, accented chars) in a
consumed line the byte count exceeds the UTF-16 code-unit count, causing
`text.slice(priorOffset)` to over-shoot and truncate the start of the next
line.

Fix: change the read site to `readFileSync(full)` (returns a `Buffer`),
then `const tail = buf.subarray(priorOffset).toString("utf8")`. The write
side (line 817 `Buffer.byteLength`) and the `st.size` comparison are already
byte-correct and must not change.

Add a regression test in `test/zellij-events-worker.test.ts` that places a
line with an emoji `tab_name` (e.g. `"😀main"`) at a non-zero watermark
offset, followed by a second normal line, and asserts both are parsed without
truncation. All existing golden-line and ASCII fixtures must continue to pass.

## Acceptance

- [ ] `readFileSync(full)` in `scanZellijEventsDir` returns a Buffer; tail
      is derived via `buf.subarray(priorOffset).toString("utf8")`.
- [ ] Regression test with a multi-byte pre-watermark line passes.
- [ ] Full `bun test` suite passes.

## Done summary
Switched scanZellijEventsDir to read the events file as a Buffer and slice via buf.subarray(priorOffset).toString('utf8'), keeping the watermark byte-consistent across read and write sides; added a regression test feeding an emoji tab_name before the watermark followed by an ASCII line.
## Evidence
