## Description

**Size:** M
**Files:** plugin/zellij-bridge/src/main.rs, plugin/zellij-bridge/keeper-zellij-bridge.wasm (regenerated), plugin/zellij-bridge/VERSION (regenerated)

### Approach

Today `build_lines` (main.rs:110-148) emits one line per non-plugin pane
across all tabs on every PaneUpdate AND TabUpdate, and `append_line`
(:330-346) does a fresh open()+BufWriter+write+flush+close PER LINE — O(N)
blocking WASI syscalls per event, O(N^2) per activity round across N panes.
Introduce a NEW pure fn (e.g. `diff_lines(prev: &BTreeMap<u32,(u64,String)>,
next: &[PaneLine]) -> Vec<PaneLine>`) returning only panes whose
`pane_id -> (tab_id, tab_name)` tuple changed vs `prev`. Add a Default-able
`last_emitted: BTreeMap<u32,(u64,String)>` field to the `Plugin` struct
(:159-188). Per event: build_lines (full manifest, unchanged) → diff against
`last_emitted` → if the diff is EMPTY, return WITHOUT opening the file at all
→ else open once (`append(true).create(true)`, preserving the #5177 O_APPEND
share), write the whole multi-line batch in ONE `write_all` of a single
concatenated buffer (O_APPEND atomicity is per-syscall — one syscall keeps a
double-loaded instance from interleaving), single `flush()` → ONLY AFTER a
successful flush, update `last_emitted` with the changed entries and prune
entries for panes no longer in the manifest (bounded memory across a long
session). `SEQ` advances by emitted-line count only (gaps are fine — consumer
dedups by byte-offset watermark — but it must stay monotonic). The
`plugin_start` sentinel path is unchanged (still written on grant); because
`last_emitted` starts empty (`Default`), the first post-grant flush re-emits
every pane, and an epoch change (plugin reload) is a fresh `Plugin::default()`
so the map resets automatically. Keep the diff fn pure (no plugin state, no
SEQ thread-local) so it unit-tests standalone. Stay within `std` +
`zellij-tile` — NO new deps (hand-rolled JSON discipline).

### Investigation targets

**Required** (read before coding):
- plugin/zellij-bridge/src/main.rs:110-148 — `build_lines` (the re-serialize)
- plugin/zellij-bridge/src/main.rs:330-346 — `append_line` (per-line open/flush/close)
- plugin/zellij-bridge/src/main.rs:159-188 — `Plugin` struct (`#[derive(Default)]`, holds `tab_map` + `last_panes`)
- plugin/zellij-bridge/src/main.rs:152-157 — `SEQ` thread-local Cell
- plugin/zellij-bridge/src/main.rs:244,253-271 — sentinel + update arms (PaneUpdate/TabUpdate re-emit)
- plugin/zellij-bridge/src/main.rs:366-539 — inline `#[cfg(test)]` tests + `manifest()`/`pane()` helpers
- src/zellij-events.ts:98-176 — consumer contract: empty-`tab_name` NEVER folded (clobber guard), `plugin_start` skipped, required fields seq/epoch/session/pane_id/tab_name/ts
- scripts/build-plugin.sh — rebuild + the committed `.wasm`/`VERSION` artifacts

**Optional**:
- test/plugin-version-skew.test.ts — VERSION-vs-zellij skew tripwire (zellij-tile pin stays =0.44.3)

### Risks

- Diff MUST key on `(tab_id, tab_name)`, not pane presence — a presence-only diff misses rename-only TabUpdates and regresses `rename_re_emit_changes_tab_name`.
- Update `last_emitted` ONLY after a successful flush — a pre-flush map update + failed write permanently false-suppresses those panes until their value changes again.
- Provisional `(0,"")` (missing-tab-map fallthrough, :125-128) then a real `(tab_id,name)`: the real value differs so it emits — but the consumer's empty-`tab_name` clobber-guard means a `(0,"")` line is never folded anyway; assert the real name reaches the consumer.
- One `write_all` for the whole concatenated batch (not a per-line loop) to keep #5177 double-load interleave-safe.
- Rebuild on a binaryen-present box (this box: wasm-opt 130, cargo 1.95, wasm32-wasip1 all present) so the committed `.wasm` is `-Oz` optimised, not the unoptimised fallback.

### Test notes

Extend the inline `#[cfg(test)]` mod: (a) an identical re-PaneUpdate emits ZERO lines; (b) a rename-only TabUpdate still emits the affected panes (keep `rename_re_emit_changes_tab_name` green); (c) first real `(tab_id,name)` after a provisional `(0,"")` emits; (d) a closed pane is pruned from `last_emitted`; (e) `diff_lines` purity (empty diff → no output). Run `cargo test` manually (no CI for cargo). Then `bun run build:plugin` and commit the regenerated `.wasm` + `VERSION`. Update the module `//!` doc (currently describes per-line open/flush/close), the CLAUDE.md fn-684 carve-out (add the diff-gate discipline sentence), and the README "ninth worker" prose.

## Acceptance

- [ ] New pure diff fn emits only panes whose `pane_id -> (tab_id, tab_name)` changed; unit-tested standalone
- [ ] Zero-delta event performs NO file open/write/flush
- [ ] Non-zero event = one open + one `write_all`(concatenated batch) + one flush; `last_emitted` updated only AFTER a successful flush
- [ ] Rename-only TabUpdate still emits affected panes (`rename_re_emit_changes_tab_name` green); first real `(tab_id,name)` after `(0,"")` reaches the consumer
- [ ] Closed panes pruned from `last_emitted` (bounded memory)
- [ ] `SEQ` stays monotonic, advances by emitted-line count only
- [ ] `append(true).create(true)` / O_APPEND #5177 contract preserved; `plugin_start` sentinel + epoch-reset behavior unchanged; no new crate deps
- [ ] `.wasm` + `VERSION` regenerated via `bun run build:plugin` on a binaryen-present box and committed; `test/plugin-version-skew.test.ts` passes
- [ ] Module `//!` doc, CLAUDE.md fn-684 carve-out, and README "ninth worker" prose updated to the diff-gate + batched-write contract

## Done summary

## Evidence
