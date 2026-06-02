## Description

**Size:** M
**Files:** plugin/zellij-bridge/ (new Rust crate: Cargo.toml, src/lib.rs)

### Approach

Create keeper's first Rust crate: a `cdylib` zellij plugin pinned to `zellij-tile = "=0.44.3"`. Implement the `ZellijPlugin` trait via `register_plugin!`: in `load()` call `subscribe(&[EventType::PaneUpdate, EventType::TabUpdate])` and `request_permission(&[PermissionType::ReadApplicationState])`, write a `{"seq":0,"event":"plugin_start","epoch":<load-nonce>}` sentinel, and resolve the session name from `get_session_environment_variables()` (`ZELLIJ_SESSION_NAME`). `render()` is an empty no-op; `update()` returns `false`. Hold the latest `TabUpdate` as a `position -> {tab_id, tab_name}` map. On each `PaneUpdate` AND on every `TabUpdate` (so a rename-only update re-emits affected panes — otherwise renames regress vs the 5s poller), walk `PaneManifest` (`HashMap<tab_position, Vec<PaneInfo>>`), skip `is_plugin` panes, join against the tab map, and append one NDJSON line per pane: `{seq, epoch, session, pane_id, tab_id, tab_name, ts}`. Open the file with `OpenOptions::append(true).create(true)` (survives the #5177 double-instantiation), `BufWriter` + `flush()` per line, mode `0600`. Emit metadata ONLY — never pane title/content. Release profile: `opt-level="z"`, lto, `codegen-units=1`, strip, `panic="abort"`.

**SPIKE (gates the whole epic):** determine what `/host` maps to for a keeper-launched session (`get_plugin_ids().initial_cwd`) and whether keeper can make that resolve to a stable, keeper-controlled dir it can also watch. If `/host` is not keeper-controllable, fall back to a per-user `/tmp/keeper-zellij/<session>.ndjson`. Record the chosen transport path + filename scheme as the contract that tasks 3 and 4 build against.

### Investigation targets

**Required** (read before coding):
- /Users/mike/src/zellij-org--zellij/zellij-tile/src/shim.rs — subscribe, request_permission, get_session_environment_variables, get_zellij_version, get_plugin_ids
- /Users/mike/src/zellij-org--zellij/zellij-utils/src/data.rs:2281 — PaneManifest; :2296 PaneInfo (id, is_plugin, NO tab_id); :2237 TabInfo (tab_id, position, name)

**Optional** (reference as needed):
- github.com/dj95/zjstatus and github.com/cfal/zellij-vertical-tabs — ZellijPlugin trait skeleton + TabUpdate subscription + permissions.kdl shape

### Risks

- `/host` may not be keeper-controllable — the spike gates this; `/tmp` per-user fallback exists.
- A rename-only `TabUpdate` must re-emit affected panes or tab renames stop flowing (silent regression).
- #5177 double-instantiation — mitigated by append-only open; the dedup design (task 3) tolerates duplicate lines.

### Test notes

Factor the PaneManifest+TabInfo -> NDJSON-lines join as a pure Rust fn and unit-test it (incl. is_plugin skip, rename re-emit, missing-tab-map ordering). Manual: load into a live keeper session, `tail` the file, rename a tab and open a new one, confirm correct lines appear.

## Acceptance

- [ ] Plugin builds to `wasm32-wasip1`, loads headless (no visible pane), stays resident, and emits no render output
- [ ] On pane/tab change it appends correct `{seq, epoch, session, pane_id, tab_id, tab_name, ts}` lines (metadata only), `is_plugin` panes excluded
- [ ] A tab rename re-emits the affected panes' lines
- [ ] Transport path + filename scheme decided and documented as the task-3/task-4 contract
- [ ] Pure join fn has unit tests

## Done summary

## Evidence
