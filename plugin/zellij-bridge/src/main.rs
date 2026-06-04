//! keeper-zellij-bridge — a headless zellij plugin that emits pane/tab deltas as NDJSON.
//!
//! Built as a BINARY crate (`[[bin]]`, `src/main.rs`), NOT a `cdylib`:
//! zellij looks up the `_start` export (`register_plugin!` injects the
//! `fn main` that becomes it) and fails the whole load with "could not find
//! exported function" otherwise — a cdylib produces a reactor with no entry
//! point and never instantiates.
//!
//! Subscribes to `PaneUpdate`, `TabUpdate`, and `PermissionRequestResult`,
//! and requests `ReadApplicationState` + `ReadSessionEnvironmentVariables`.
//! Permission grants resolve ASYNCHRONOUSLY — they are NOT active during the
//! synchronous `load()` call — so the session name (and therefore the first
//! emit) is deferred to the `PermissionRequestResult(Granted)` arm in
//! `update()`. On each pane/tab event thereafter it joins the manifest
//! against the latest tab map to build the FULL pane manifest, then diffs it
//! against `last_emitted` (per-pane `(tab_id, tab_name)`) and emits ONLY the
//! changed panes. A zero-delta event (the overwhelmingly common case — zellij
//! delivers a full PaneManifest snapshot on every `GetPaneRunningCommand`
//! poll) does NO file I/O at all. The lines that DID change are written in one
//! open + one batched `write_all` of the concatenated buffer + one flush; a
//! single `write_all` keeps a #5177 double-loaded instance from interleaving
//! its bytes mid-batch (O_APPEND atomicity is per-syscall). Output lands at
//! `/host/<session>.ndjson`. `/host` is pinned by the dotfiles
//! `load_plugins { "file:..." { cwd "<events dir>" } }` block (see
//! `fn-684.4`); the plugin never resolves a host path itself — the WASI
//! sandbox forbids writing outside `/host` / `/data` / sandbox `/tmp`.
//!
//! `last_emitted` is updated ONLY after a successful flush (a pre-flush
//! update + failed write would permanently false-suppress those panes), and
//! panes no longer in the manifest are pruned from it so memory stays bounded
//! across a long session. It starts empty (`Plugin::default()`), so the first
//! post-grant flush re-emits every pane, and a plugin reload (fresh `Plugin`,
//! new epoch) resets it automatically.
//!
//! The fold in keeper's `zellij-events-worker` is idempotent, so the
//! `OpenOptions::append(true)` open survives zellij#5177 (double
//! instantiation): duplicate lines re-apply to the same value.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use zellij_tile::prelude::*;

/// One NDJSON line per pane: metadata only — never pane title/content
/// (titles can echo secrets per the epic's "Security" best-practice).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneLine {
    pub seq: u64,
    pub epoch: u64,
    pub session: String,
    pub pane_id: u32,
    pub tab_id: u64,
    pub tab_name: String,
    /// Stringified UNIX-millis timestamp — formatting is the caller's job
    /// (the pure join fn takes it as input so tests are deterministic).
    pub ts_ms: u64,
}

impl PaneLine {
    /// Serialise as a single NDJSON line (no trailing newline).
    pub fn to_json(&self) -> String {
        // Hand-rolled to keep the dep graph at zellij-tile only — adding
        // serde_json would double the wasm size for one struct.
        format!(
            "{{\"seq\":{},\"epoch\":{},\"session\":{},\"pane_id\":{},\"tab_id\":{},\"tab_name\":{},\"ts\":{}}}",
            self.seq,
            self.epoch,
            json_string(&self.session),
            self.pane_id,
            self.tab_id,
            json_string(&self.tab_name),
            self.ts_ms,
        )
    }
}

/// Minimal RFC-8259 string escape: `"`, `\`, control chars (U+0000..U+001F),
/// and `DEL` (U+007F). Other bytes pass through verbatim — a tab name may
/// legitimately contain unicode.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            },
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build the ordered list of NDJSON lines for one update.
///
/// Pure function — no I/O, no clock, no env reads — so the unit tests can
/// drive it with synthetic manifests / tab maps. The caller supplies the
/// monotonic `seq` (incremented across the whole plugin lifetime), the
/// per-load `epoch`, the resolved `session`, and `ts_ms` (UNIX millis).
///
/// **Ordering:** we walk tabs in `position` order (sorted ascending), and
/// within each tab walk panes in `pane_id` order. Stable ordering makes
/// the NDJSON stream replay-deterministic for testing.
///
/// **`is_plugin` skip:** plugin panes are not user terminals and never
/// carry a job — skip them entirely.
///
/// **Missing tab map:** a `PaneUpdate` may arrive before any `TabUpdate`
/// has resolved tab metadata for the position the pane lives in. In that
/// case we still emit a line — `tab_id=0`, `tab_name=""` — because the
/// consumer's idempotent fold will overwrite once the matching `TabUpdate`
/// re-emits (the rename-re-emit path).
pub fn build_lines(
    panes: &PaneManifest,
    tab_map: &BTreeMap<usize, (u64, String)>,
    session: &str,
    epoch: u64,
    seq_start: u64,
    ts_ms: u64,
) -> Vec<PaneLine> {
    let mut out = Vec::new();
    let mut seq = seq_start;
    // Sort tabs by position so the line stream is deterministic.
    let mut tab_positions: Vec<&usize> = panes.panes.keys().collect();
    tab_positions.sort();
    for pos in tab_positions {
        let pane_list = panes.panes.get(pos).expect("position from keys()");
        let (tab_id, tab_name) = tab_map
            .get(pos)
            .map(|(t, n)| (*t, n.clone()))
            .unwrap_or((0, String::new()));
        let mut sorted_panes: Vec<&PaneInfo> = pane_list.iter().collect();
        sorted_panes.sort_by_key(|p| p.id);
        for pane in sorted_panes {
            if pane.is_plugin {
                continue;
            }
            out.push(PaneLine {
                seq,
                epoch,
                session: session.to_string(),
                pane_id: pane.id,
                tab_id,
                tab_name: tab_name.clone(),
                ts_ms,
            });
            seq = seq.wrapping_add(1);
        }
    }
    out
}

/// Filter a full manifest down to the panes whose `(tab_id, tab_name)`
/// changed since the last emit, and renumber their `seq` densely from
/// `seq_start`.
///
/// Pure function — no plugin state, no `SEQ` thread-local, no I/O — so it
/// unit-tests standalone. `prev` is the per-pane snapshot of the LAST emitted
/// `(tab_id, tab_name)` keyed by `pane_id`; `next` is the freshly built full
/// manifest from `build_lines`. We keep a `next` line when its pane is absent
/// from `prev` (new pane) OR its `(tab_id, tab_name)` tuple differs (moved /
/// renamed tab). A pane present in both with an identical tuple is dropped —
/// re-emitting it would be a no-op fold on the consumer and pure churn on the
/// single-threaded zellij server.
///
/// We KEY on `(tab_id, tab_name)`, NOT pane presence: a rename-only
/// `TabUpdate` leaves the pane set unchanged but flips `tab_name`, and the
/// consumer's rename re-emit depends on the new name reaching it. A
/// presence-only diff would silently swallow renames.
///
/// `seq` is renumbered densely from `seq_start` over the SURVIVING lines so
/// the caller advances `SEQ` by exactly the emitted-line count (gaps from
/// suppressed panes never reach the stream — the consumer's byte-offset
/// watermark tolerates gaps, but dense numbering keeps the count honest).
/// The input `next` lines' `seq` values (assigned over the full manifest)
/// are discarded.
pub fn diff_lines(
    prev: &BTreeMap<u32, (u64, String)>,
    next: &[PaneLine],
    seq_start: u64,
) -> Vec<PaneLine> {
    let mut out = Vec::new();
    let mut seq = seq_start;
    for line in next {
        let changed = match prev.get(&line.pane_id) {
            Some((tab_id, tab_name)) => *tab_id != line.tab_id || *tab_name != line.tab_name,
            None => true,
        };
        if !changed {
            continue;
        }
        let mut emitted = line.clone();
        emitted.seq = seq;
        out.push(emitted);
        seq = seq.wrapping_add(1);
    }
    out
}

// ===== Plugin state =====================================================

thread_local! {
    /// Monotonic per-plugin-instance sequence number. Lives in a thread-
    /// local Cell so it's reachable from both `load()` (sentinel) and
    /// `update()` (pane/tab lines) without threading through `&mut self`.
    static SEQ: Cell<u64> = const { Cell::new(0) };
}

#[derive(Default)]
pub struct Plugin {
    /// Per-load nonce stamped on every emitted line. Re-derived in
    /// `load()` from `(epoch_ms ^ plugin_id)`; the consumer treats it as
    /// opaque — only the change-of-epoch is meaningful (it signals a
    /// fresh instantiation, e.g. after the #5177 double-load race).
    epoch: u64,
    /// Resolved session name from `ZELLIJ_SESSION_NAME`. Set once on the
    /// `PermissionRequestResult(Granted)` event (NOT in `load()` — see the
    /// `update()` doc). Empty if the env var was absent — we still write to
    /// `/host/.ndjson` in that case so the file is greppable for the
    /// bug rather than silently dropped.
    session: String,
    /// Set true once `PermissionRequestResult(Granted)` has fired and we've
    /// resolved the session name + written the `plugin_start` sentinel.
    /// `emit_lines()` is gated on this so a `PaneUpdate`/`TabUpdate` that
    /// races ahead of the grant is held (in `last_panes`/`tab_map`) and
    /// flushed once initialization completes — never emitted against an
    /// unknown session.
    initialized: bool,
    /// Last seen tab snapshot — position -> (tab_id, tab_name).
    /// A rename-only `TabUpdate` mutates the name here and triggers a
    /// re-emit of every pane in the affected position(s); without that
    /// rename re-emit, tab-name changes regress vs the legacy 5s poller.
    tab_map: BTreeMap<usize, (u64, String)>,
    /// Last seen pane manifest — held so a `TabUpdate` (rename) can
    /// re-emit the affected panes without waiting for the next
    /// `PaneUpdate`.
    last_panes: Option<PaneManifest>,
    /// Per-pane snapshot of the LAST EMITTED `(tab_id, tab_name)`, keyed by
    /// `pane_id`. The diff gate (`diff_lines`) compares each freshly built
    /// manifest line against this map and emits ONLY the panes whose tuple
    /// changed — so a no-change event does zero file I/O. Updated ONLY after
    /// a successful flush (a pre-flush update + failed write would
    /// permanently false-suppress those panes until their value next
    /// changes), and pruned of panes no longer in the manifest so memory
    /// stays bounded. Starts empty (`Default`) so the first post-grant flush
    /// re-emits every pane; a plugin reload is a fresh `Plugin` and resets it.
    last_emitted: BTreeMap<u32, (u64, String)>,
}

impl ZellijPlugin for Plugin {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // Subscribe to the pane/tab deltas AND to the permission-grant result.
        // `request_permission` resolves ASYNCHRONOUSLY: zellij applies the
        // grant (from the pre-seeded permissions cache, or after an
        // interactive prompt) and then delivers `PermissionRequestResult` —
        // it is NOT active during this synchronous `load()` call. So we must
        // NOT call any permissioned host API here:
        //   - `ReadApplicationState` gates delivery of PaneUpdate/TabUpdate.
        //   - `ReadSessionEnvironmentVariables` gates
        //     `get_session_environment_variables()`.
        // Calling the latter in `load()` is denied → the shim unwraps an empty
        // response → the wasm traps → the WHOLE plugin fails to instantiate
        // (the bug that silently killed tab resolution). Defer all of it to
        // the `PermissionRequestResult(Granted)` arm in `update()`.
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::PermissionRequestResult,
        ]);
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ReadSessionEnvironmentVariables,
        ]);

        // `get_plugin_ids()` is permission-free, so the per-load epoch nonce
        // (used to detect a fresh instantiation, e.g. the #5177 double-load
        // race) is safe to derive here. The consumer treats it as opaque.
        let ids = get_plugin_ids();
        self.epoch = ids.plugin_id as u64;
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            // The grant landed. NOW the permissioned APIs are live, so this is
            // the earliest point we can read the session name and start
            // emitting. Initialize exactly once; a `Denied` result (or a
            // second `Granted`) is a no-op. Any pane/tab snapshot that raced
            // ahead of the grant was held in `last_panes`/`tab_map` and is
            // flushed here.
            Event::PermissionRequestResult(status) => {
                if matches!(status, PermissionStatus::Granted) && !self.initialized {
                    let env = get_session_environment_variables();
                    self.session = env
                        .get("ZELLIJ_SESSION_NAME")
                        .cloned()
                        .unwrap_or_default();
                    self.initialized = true;

                    let sentinel = format!(
                        "{{\"seq\":0,\"event\":\"plugin_start\",\"epoch\":{},\"session\":{}}}",
                        self.epoch,
                        json_string(&self.session),
                    );
                    append_line(&self.session, &sentinel);
                    SEQ.with(|s| s.set(1));

                    // Flush whatever we captured before the grant.
                    if self.last_panes.is_some() {
                        self.emit_lines();
                    }
                }
            },
            Event::PaneUpdate(panes) => {
                self.last_panes = Some(panes);
                // Hold until initialized (session known); flush on the grant.
                if self.initialized {
                    self.emit_lines();
                }
            },
            Event::TabUpdate(tabs) => {
                let mut new_map = BTreeMap::new();
                for tab in tabs {
                    new_map.insert(tab.position, (tab.tab_id as u64, tab.name));
                }
                self.tab_map = new_map;
                // Re-emit on every TabUpdate (incl. rename-only) so tab
                // renames propagate — see the build_lines doc-comment.
                if self.initialized && self.last_panes.is_some() {
                    self.emit_lines();
                }
            },
            _ => {},
        }
        // Headless — never request a render.
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Intentionally empty — the plugin is invisible.
    }
}

impl Plugin {
    fn emit_lines(&mut self) {
        let Some(panes) = self.last_panes.as_ref() else {
            return;
        };
        let seq_start = SEQ.with(|s| s.get());
        let ts_ms = now_ms();
        // Build the FULL manifest (unchanged), then diff it down to the panes
        // whose `(tab_id, tab_name)` actually changed. The full manifest is
        // also the basis for the prune set below.
        let full = build_lines(
            panes,
            &self.tab_map,
            &self.session,
            self.epoch,
            seq_start,
            ts_ms,
        );
        let changed = diff_lines(&self.last_emitted, &full, seq_start);

        // Zero-delta event: do NOT open the file at all. This is the hot path
        // — zellij delivers a full PaneManifest snapshot on every pane poll,
        // and a quiescent-but-busy session re-emits an identical manifest
        // dozens of times a second.
        if changed.is_empty() {
            return;
        }

        // One open + one batched `write_all` of the concatenated buffer + one
        // flush. A single syscall keeps a #5177 double-loaded instance from
        // interleaving its bytes mid-batch (O_APPEND atomicity is per-syscall).
        let mut batch = String::new();
        for line in &changed {
            batch.push_str(&line.to_json());
            batch.push('\n');
        }
        if !append_batch(&self.session, &batch) {
            // Write failed — do NOT advance SEQ and do NOT update
            // `last_emitted`. Leaving the map untouched means these panes are
            // re-attempted (still "changed") on the next event rather than
            // false-suppressed forever.
            return;
        }

        // Only AFTER a successful flush: advance SEQ by the emitted-line count
        // and fold the changed tuples into `last_emitted`.
        let new_seq = seq_start.wrapping_add(changed.len() as u64);
        SEQ.with(|s| s.set(new_seq));
        for line in &changed {
            self.last_emitted
                .insert(line.pane_id, (line.tab_id, line.tab_name.clone()));
        }

        // Prune panes no longer in the current manifest so memory stays
        // bounded across a long session. `full` is the complete current pane
        // set (post `is_plugin` skip); any `last_emitted` key absent from it
        // is a closed pane.
        let live: std::collections::BTreeSet<u32> = full.iter().map(|l| l.pane_id).collect();
        self.last_emitted.retain(|pane_id, _| live.contains(pane_id));
    }
}

// ===== I/O helpers ======================================================

/// Plugin output path under WASI `/host` (= the dotfiles-pinned events dir).
/// We NEVER resolve a host path — the WASI sandbox forbids writing outside
/// `/host` / `/data` / sandbox `/tmp`, and pinning `/host` via the
/// `load_plugins` `cwd` is the documented contract with tasks `.3` / `.4`.
fn ndjson_path(session: &str) -> PathBuf {
    // Defang path-traversal in a hostile session name: a `/` would let a
    // crafted name escape the per-session file (e.g. `../foo`). Replace
    // any os-sep char so the filename stays single-segment.
    let safe: String = session
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
        .collect();
    PathBuf::from(format!("/host/{}.ndjson", safe))
}

/// Append a pre-concatenated batch (already newline-terminated per line) in
/// ONE `write_all` + one `flush`. Opens with `append(true).create(true)` so a
/// #5177 double-load shares one O_APPEND stream rather than corrupting it; the
/// single `write_all` keeps a double-loaded instance from interleaving its
/// bytes mid-batch (O_APPEND atomicity is per-syscall). Returns `true` only
/// when open + write + flush all succeed — the caller updates `last_emitted`
/// ONLY on `true` so a failed write is re-attempted on the next event rather
/// than false-suppressed. Errors are otherwise swallowed: the plugin runs in
/// every zellij session (dotfiles global load) and must never panic on a
/// wedged FS.
fn append_batch(session: &str, batch: &str) -> bool {
    let path = ndjson_path(session);
    let open_res = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path);
    let Ok(file) = open_res else {
        return false;
    };
    let mut w = BufWriter::new(file);
    if w.write_all(batch.as_bytes()).is_err() {
        return false;
    }
    if w.flush().is_err() {
        return false;
    }
    true
    // NOTE: file mode 0600 is enforced by the dotfiles-managed events dir
    // (created by keeper's boot with restrictive perms, task .4). Setting
    // perms inside a WASI plugin is non-portable — leave it to the dir.
}

/// Append one line + newline (the `plugin_start` sentinel path). Delegates to
/// `append_batch` so the open/write/flush discipline lives in one place.
fn append_line(session: &str, line: &str) {
    let mut buf = String::with_capacity(line.len() + 1);
    buf.push_str(line);
    buf.push('\n');
    let _ = append_batch(session, &buf);
}

/// Current UNIX time in milliseconds. WASI preview1 exposes the host clock
/// via `SystemTime::now()`; on a host without a real clock we fall back to
/// 0 so the stream still flows.
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===== Plugin registration =============================================
//
// `register_plugin!` injects `fn main`, `fn load`, `fn update`, `fn pipe`,
// `fn render`, and `fn plugin_version`. The macro relies on the
// `zellij_tile` prelude `use` above for `report_panic`, `subscribe`, etc.
register_plugin!(Plugin);

// ===== Unit tests =======================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn pane(id: u32, is_plugin: bool) -> PaneInfo {
        PaneInfo {
            id,
            is_plugin,
            ..Default::default()
        }
    }

    fn manifest(by_pos: &[(usize, Vec<PaneInfo>)]) -> PaneManifest {
        let mut panes: HashMap<usize, Vec<PaneInfo>> = HashMap::new();
        for (pos, list) in by_pos {
            panes.insert(*pos, list.clone());
        }
        PaneManifest { panes }
    }

    #[test]
    fn skips_plugin_panes() {
        let pm = manifest(&[(
            0,
            vec![pane(1, false), pane(2, true), pane(3, false)],
        )]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (10_u64, "main".to_string()));

        let lines = build_lines(&pm, &tabs, "sess", 42, 100, 1_700_000_000_000);

        assert_eq!(lines.len(), 2, "the plugin pane (id=2) is dropped");
        assert_eq!(lines[0].pane_id, 1);
        assert_eq!(lines[1].pane_id, 3);
        assert_eq!(lines[0].seq, 100);
        assert_eq!(lines[1].seq, 101);
        assert!(lines.iter().all(|l| l.tab_id == 10 && l.tab_name == "main"));
        assert!(lines.iter().all(|l| l.epoch == 42 && l.session == "sess"));
    }

    #[test]
    fn rename_re_emit_changes_tab_name() {
        let pm = manifest(&[(0, vec![pane(7, false)])]);

        let mut tabs_a = BTreeMap::new();
        tabs_a.insert(0_usize, (5_u64, "old".to_string()));
        let lines_a = build_lines(&pm, &tabs_a, "s", 1, 0, 1);

        let mut tabs_b = BTreeMap::new();
        tabs_b.insert(0_usize, (5_u64, "new".to_string()));
        let lines_b = build_lines(&pm, &tabs_b, "s", 1, 5, 2);

        assert_eq!(lines_a.len(), 1);
        assert_eq!(lines_a[0].tab_name, "old");
        assert_eq!(lines_b.len(), 1);
        assert_eq!(lines_b[0].tab_name, "new");
        assert_eq!(lines_b[0].pane_id, 7);
        // seq starts where the caller asked, not from the prior batch.
        assert_eq!(lines_b[0].seq, 5);
    }

    #[test]
    fn missing_tab_map_falls_through_with_zero_id_and_empty_name() {
        // Pane on position 0, but tab_map only knows position 1 —
        // we still emit (the consumer overwrites on the next TabUpdate).
        let pm = manifest(&[(0, vec![pane(99, false)])]);
        let mut tabs = BTreeMap::new();
        tabs.insert(1_usize, (50_u64, "other".to_string()));

        let lines = build_lines(&pm, &tabs, "s", 0, 0, 0);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].pane_id, 99);
        assert_eq!(lines[0].tab_id, 0);
        assert_eq!(lines[0].tab_name, "");
    }

    #[test]
    fn deterministic_ordering_across_tabs_and_panes() {
        // Two tabs, panes inserted out of order — the output is sorted
        // by (tab_position, pane_id) so the stream is replay-deterministic.
        let pm = manifest(&[
            (1, vec![pane(20, false), pane(10, false)]),
            (0, vec![pane(5, false), pane(2, false)]),
        ]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (100_u64, "a".to_string()));
        tabs.insert(1_usize, (200_u64, "b".to_string()));

        let lines = build_lines(&pm, &tabs, "s", 0, 0, 0);
        let ordered: Vec<(u32, u64)> = lines.iter().map(|l| (l.pane_id, l.tab_id)).collect();
        assert_eq!(
            ordered,
            vec![(2, 100), (5, 100), (10, 200), (20, 200)],
            "lines must be ordered by (tab_position, pane_id)"
        );
        // Sequence numbers are dense and monotonic.
        for (i, l) in lines.iter().enumerate() {
            assert_eq!(l.seq, i as u64);
        }
    }

    #[test]
    fn empty_manifest_emits_no_lines() {
        let pm = manifest(&[]);
        let tabs = BTreeMap::new();
        let lines = build_lines(&pm, &tabs, "s", 0, 7, 0);
        assert!(lines.is_empty());
    }

    #[test]
    fn all_plugin_panes_emits_no_lines() {
        let pm = manifest(&[(0, vec![pane(1, true), pane(2, true)])]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (1_u64, "t".to_string()));
        let lines = build_lines(&pm, &tabs, "s", 0, 0, 0);
        assert!(lines.is_empty());
    }

    // ----- diff_lines gate ---------------------------------------------

    /// Build a `last_emitted`-shaped map from a batch of emitted lines, the
    /// way `emit_lines` folds the survivors after a successful flush.
    fn fold_emitted(lines: &[PaneLine]) -> BTreeMap<u32, (u64, String)> {
        let mut m = BTreeMap::new();
        for l in lines {
            m.insert(l.pane_id, (l.tab_id, l.tab_name.clone()));
        }
        m
    }

    #[test]
    fn diff_identical_manifest_emits_zero_lines() {
        // First emit: empty prev → every pane is "changed".
        let pm = manifest(&[(0, vec![pane(1, false), pane(2, false)])]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (10_u64, "main".to_string()));
        let full = build_lines(&pm, &tabs, "s", 1, 0, 100);

        let prev = BTreeMap::new();
        let first = diff_lines(&prev, &full, 0);
        assert_eq!(first.len(), 2, "first emit re-emits every pane");

        // Fold the survivors, then diff the SAME manifest again.
        let emitted = fold_emitted(&first);
        let full2 = build_lines(&pm, &tabs, "s", 1, first.len() as u64, 200);
        let second = diff_lines(&emitted, &full2, first.len() as u64);
        assert!(
            second.is_empty(),
            "an identical re-PaneUpdate emits ZERO lines"
        );
    }

    #[test]
    fn diff_rename_only_tab_update_emits_affected_panes() {
        // Pane set unchanged, but the tab NAME flips — the diff MUST emit it
        // (keys on (tab_id, tab_name), not pane presence).
        let pm = manifest(&[(0, vec![pane(7, false)])]);

        let mut tabs_a = BTreeMap::new();
        tabs_a.insert(0_usize, (5_u64, "old".to_string()));
        let full_a = build_lines(&pm, &tabs_a, "s", 1, 0, 1);
        let first = diff_lines(&BTreeMap::new(), &full_a, 0);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].tab_name, "old");
        let emitted = fold_emitted(&first);

        let mut tabs_b = BTreeMap::new();
        tabs_b.insert(0_usize, (5_u64, "new".to_string()));
        let full_b = build_lines(&pm, &tabs_b, "s", 1, 1, 2);
        let renamed = diff_lines(&emitted, &full_b, 1);
        assert_eq!(renamed.len(), 1, "rename-only TabUpdate still emits the pane");
        assert_eq!(renamed[0].pane_id, 7);
        assert_eq!(renamed[0].tab_name, "new");
        // seq is renumbered densely from the supplied seq_start.
        assert_eq!(renamed[0].seq, 1);
    }

    #[test]
    fn diff_real_tab_name_after_provisional_zero_reaches_output() {
        // A PaneUpdate raced ahead of the TabUpdate → provisional (0, "").
        let pm = manifest(&[(0, vec![pane(3, false)])]);
        let empty_tabs = BTreeMap::new();
        let full_prov = build_lines(&pm, &empty_tabs, "s", 1, 0, 1);
        assert_eq!(full_prov[0].tab_id, 0);
        assert_eq!(full_prov[0].tab_name, "");
        let prov = diff_lines(&BTreeMap::new(), &full_prov, 0);
        assert_eq!(prov.len(), 1, "provisional (0,\"\") still emits once");
        let emitted = fold_emitted(&prov);

        // The real TabUpdate lands → (tab_id, name) differs → emits, and the
        // real name reaches the output (the consumer's empty-name clobber
        // guard drops the provisional line, so this real one is load-bearing).
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (42_u64, "real".to_string()));
        let full_real = build_lines(&pm, &tabs, "s", 1, 1, 2);
        let real = diff_lines(&emitted, &full_real, 1);
        assert_eq!(real.len(), 1);
        assert_eq!(real[0].pane_id, 3);
        assert_eq!(real[0].tab_id, 42);
        assert_eq!(real[0].tab_name, "real");
    }

    #[test]
    fn diff_closed_pane_pruned_from_last_emitted() {
        // Emit two panes, then a manifest with one pane closed. The prune
        // logic (mirrored from emit_lines) drops the closed pane's key so
        // memory is bounded.
        let pm_two = manifest(&[(0, vec![pane(1, false), pane(2, false)])]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (1_u64, "t".to_string()));
        let full_two = build_lines(&pm_two, &tabs, "s", 1, 0, 1);
        let first = diff_lines(&BTreeMap::new(), &full_two, 0);
        let mut last_emitted = fold_emitted(&first);
        assert_eq!(last_emitted.len(), 2);

        // Pane 2 closed.
        let pm_one = manifest(&[(0, vec![pane(1, false)])]);
        let full_one = build_lines(&pm_one, &tabs, "s", 1, 2, 3);
        // No tuple changed for the surviving pane → diff is empty …
        let diff = diff_lines(&last_emitted, &full_one, 2);
        assert!(diff.is_empty(), "surviving pane unchanged → no emit");
        // … but the prune still fires off the full current manifest.
        let live: std::collections::BTreeSet<u32> = full_one.iter().map(|l| l.pane_id).collect();
        last_emitted.retain(|pane_id, _| live.contains(pane_id));
        assert_eq!(last_emitted.len(), 1, "closed pane (id=2) pruned");
        assert!(last_emitted.contains_key(&1));
        assert!(!last_emitted.contains_key(&2));
    }

    #[test]
    fn diff_lines_is_pure_empty_diff_no_output() {
        // Same map content fed as prev and as the source of `next` → no
        // surviving lines, no mutation of inputs (pure function).
        let pm = manifest(&[(0, vec![pane(8, false), pane(9, false)])]);
        let mut tabs = BTreeMap::new();
        tabs.insert(0_usize, (3_u64, "z".to_string()));
        let full = build_lines(&pm, &tabs, "s", 1, 0, 1);
        let prev = fold_emitted(&full);
        let prev_snapshot = prev.clone();

        let out = diff_lines(&prev, &full, 99);
        assert!(out.is_empty(), "no tuple changed → empty diff");
        // `prev` is untouched — the fn reads it, never writes it.
        assert_eq!(prev, prev_snapshot);
    }

    #[test]
    fn json_serialisation_round_trips_metadata_only() {
        let l = PaneLine {
            seq: 42,
            epoch: 7,
            session: "my-sess".to_string(),
            pane_id: 13,
            tab_id: 99,
            tab_name: "tab \"quoted\" / with\\slash".to_string(),
            ts_ms: 1_700_000_000_000,
        };
        let s = l.to_json();
        // Required fields present, no leaked secret-y fields.
        assert!(s.contains("\"seq\":42"));
        assert!(s.contains("\"epoch\":7"));
        assert!(s.contains("\"pane_id\":13"));
        assert!(s.contains("\"tab_id\":99"));
        assert!(s.contains("\"ts\":1700000000000"));
        assert!(s.contains("\"session\":\"my-sess\""));
        // Quote + backslash escaped per RFC-8259.
        assert!(s.contains("tab \\\"quoted\\\" / with\\\\slash"));
        // No pane title / content / fg / bg sneaks in.
        for forbidden in ["title", "default_fg", "default_bg", "terminal_command"] {
            assert!(!s.contains(forbidden), "field `{}` must not appear", forbidden);
        }
    }

    #[test]
    fn json_escapes_control_chars() {
        let l = PaneLine {
            seq: 0,
            epoch: 0,
            session: "s".to_string(),
            pane_id: 0,
            tab_id: 0,
            tab_name: "\n\r\t\x01".to_string(),
            ts_ms: 0,
        };
        let s = l.to_json();
        assert!(s.contains("\\n\\r\\t\\u0001"));
    }

    #[test]
    fn ndjson_path_defangs_path_traversal_in_session() {
        let p = ndjson_path("../etc/passwd");
        assert_eq!(p, PathBuf::from("/host/..-etc-passwd.ndjson".replace('-', "_")));
        let p2 = ndjson_path("a/b\\c");
        assert_eq!(p2, PathBuf::from("/host/a_b_c.ndjson"));
        // Sanity: a normal session name passes through.
        let p3 = ndjson_path("my-sess_42");
        assert_eq!(p3, PathBuf::from("/host/my-sess_42.ndjson"));
    }
}
