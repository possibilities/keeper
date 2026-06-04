## Description

**Size:** M
**Files:** plugin/zellij-bridge/src/main.rs, plugin/zellij-bridge/keeper-zellij-bridge.wasm (rebuilt), src/daemon.ts, src/zellij-events.ts, test/zellij-events-worker.test.ts

### Approach

Bound the live feed so it never approaches the cap, with a producer-side
rotation the consumer detects robustly. The plugin is the SOLE writer of the
`.ndjson` (invariant — keeperd must never truncate it), so rotation is
plugin-side.

### Detailed phases

**Producer (`plugin/zellij-bridge/src/main.rs`):** after a successful
`append_batch`, read the on-disk size via `file.metadata().len()` (NOT a
running byte counter — under #5177 double-load two instances each count only
their own writes and would never agree). If size exceeds a new
`ROTATION_THRESHOLD` (~4 MiB const, well under the 16 MiB consumer cap),
rotate: (1) truncate to 0 AND force the write position to 0 — re-open with
`.write(true).truncate(true)` or `set_len(0)` followed by an explicit
`seek(SeekFrom::Start(0))`, to dodge the WASI `O_APPEND`-after-truncate
sparse-zeros-hole gotcha; (2) bump `self.epoch` to a FRESH nonce derived
from `now_ms()` (distinct from the `plugin_id`-derived load epoch; the
consumer treats epoch as opaque); (3) clear `self.last_emitted` so the next
emit re-emits the FULL manifest (the re-snapshot — a naive truncate would
lose quiescent panes the diff gate won't re-emit); (4) write a
`plugin_start`-style epoch-header line + the full current manifest in ONE
`write_all` (per-syscall O_APPEND atomicity keeps a double-loaded instance
from interleaving the header). Clear `last_emitted` only AFTER the write
succeeds (mirror the existing post-flush fold discipline). Keep `SEQ`
monotonic-or-reset — the consumer keys on byte offset, so a reset is
harmless; pick one and note it.

**Consumer (`src/daemon.ts` `scanZellijEventsDir` + a tiny `zellij-events.ts`
helper):** each scan, cheaply peek the FIRST line of the file and read its
`epoch` field (a small helper that JSON-parses just `epoch`, tolerating the
sentinel shape — `parseZellijEventLine` returns null for `plugin_start`, so
do not route the peek through it). If the first-line epoch differs from the
persisted watermark epoch, treat it as a rotation: reset offset to 0 and
re-read from byte 0 (consuming the header + snapshot). This is robust even
when the re-snapshot already grew the file past `priorOffset` (the
behind-consumer hole the `size < priorOffset` shrink guard misses). Keep the
shrink guard as a secondary signal. This rides on top of task .1's tail-read.

**Build/deploy:** `bun run build:plugin` (cargo `--release --target
wasm32-wasip1`), commit the regenerated `plugin/zellij-bridge/keeper-zellij-bridge.wasm`.
Do NOT bump the `VERSION` zellij-tile pin or change the `[[bin]]` crate type.

### Investigation targets

**Required**:
- plugin/zellij-bridge/src/main.rs:355-413 — `emit_lines` (rotation hooks here, post-append)
- plugin/zellij-bridge/src/main.rs:443-463 — `append_batch` (O_APPEND open; holds the `File` for `metadata().len()`)
- plugin/zellij-bridge/src/main.rs:289-290, 310-316, 477-483 — epoch source, `plugin_start` sentinel write, `now_ms`
- src/daemon.ts:862-894, 815-816 — consumer epoch handling + shrink guard
- src/zellij-events.ts:98-176 — `parseZellijEventLine` + sentinel skip (add the epoch-peek helper near here)
- test/zellij-events-worker.test.ts:258-316 — epoch-reset test (the rotation-consumer template; note it concatenates epochs, which rotation breaks)
- scripts/build-plugin.sh — wasm rebuild

### Risks

- WASI `O_APPEND`+`ftruncate`: verify empirically the first post-truncate write lands at byte 0; if uncertain, the explicit seek / re-open is mandatory (a zeros-hole feed is unparseable).
- #5177 double-load double-rotation: benign (consumer resets per epoch change, idempotent) but measure size via `metadata().len()`, not a per-instance counter.
- Rotation write partial-fail (truncate ok, header/snapshot write fails): file empty, no header; the next emit's re-snapshot recovers — acceptable, but do not clear `last_emitted` before the write succeeds.
- Epoch nonce same-millisecond collision: implausible at a 4 MiB threshold; if cheap, add a small counter component to the nonce.
- The epoch-header must be peekable by the consumer without `parseZellijEventLine` (which nulls the sentinel) — the dedicated peek helper is load-bearing.

### Test notes

Rust pure-fn test for a `should_rotate(size)` helper (host target, no I/O).
Consumer test: write epoch-A lines, then simulate rotation (truncate, write
epoch-B header + snapshot at byte 0 with total size > priorOffset) → assert
the consumer detects the epoch change via the first-line peek, resets offset
to 0, and re-mints every live pane. Extend the existing epoch-reset test.
Rebuild + commit the `.wasm`.

## Acceptance

- [ ] Bridge rotates at `ROTATION_THRESHOLD` (~4 MiB): truncate + force-position-0 + fresh-nonce epoch bump + cleared `last_emitted` + header & full manifest in one `write_all`.
- [ ] `last_emitted` cleared only after the rotation write succeeds; size measured via `metadata().len()`.
- [ ] Consumer peeks the first-line epoch each scan and resets offset→0 on epoch change, even when `size >= priorOffset`; shrink guard retained as secondary.
- [ ] WASI cursor forced to 0 after truncate (explicit seek / `.truncate(true)`).
- [ ] `.wasm` rebuilt + committed; `VERSION` and `[[bin]]` unchanged; no schema bump.
- [ ] Rust `should_rotate` test + consumer rotation test green; existing epoch-reset test still green.
- [ ] CLAUDE.md carve-out + fn-704.1 block + README ninth-worker updated (append-only-within-epoch, rotation as 2nd-layer churn defense, single-writer preserved).

## Done summary

## Evidence
