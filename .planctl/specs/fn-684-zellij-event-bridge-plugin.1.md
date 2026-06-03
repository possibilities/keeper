## Description

**Size:** M
**Files:** plugin/zellij-bridge/ (new Rust crate: Cargo.toml, src/lib.rs)

### Approach

Create keeper's first Rust crate: a `cdylib` zellij plugin pinned to `zellij-tile = "=0.44.3"`. Implement the `ZellijPlugin` trait via `register_plugin!`: in `load()` call `subscribe(&[EventType::PaneUpdate, EventType::TabUpdate])` and `request_permission(&[PermissionType::ReadApplicationState])`, write a `{"seq":0,"event":"plugin_start","epoch":<load-nonce>}` sentinel, and resolve the session name from `get_session_environment_variables()` (`ZELLIJ_SESSION_NAME`). `render()` is an empty no-op; `update()` returns `false`. Hold the latest `TabUpdate` as a `position -> {tab_id, tab_name}` map. On each `PaneUpdate` AND on every `TabUpdate` (so a rename-only update re-emits affected panes — otherwise renames regress vs the 5s poller), walk `PaneManifest` (`HashMap<tab_position, Vec<PaneInfo>>`), skip `is_plugin` panes, join against the tab map, and append one NDJSON line per pane: `{seq, epoch, session, pane_id, tab_id, tab_name, ts}`.

**Transport — settled, no spike.** The plugin writes to its WASI `/host` mount, opening `/host/<session>.ndjson`. It NEVER resolves a host path itself — the WASI sandbox forbids writing outside `/host` / `/data` / sandbox `/tmp`. `/host` is pinned to keeper's events dir by the dotfiles `load_plugins { "file:..." { cwd "<events dir>" } }` block (task `.4` documents the contract; keeper pre-creates the dir on boot so the `cwd` always resolves). Verified: zellij maps `/host` to the plugin's `initial_cwd` (`zellij-utils/src/kdl/mod.rs:5068` `load_plugins_from_kdl` -> `with_initial_cwd`; `zellij-server/src/plugins/plugin_loader.rs:432` `host_dir`). Open the file with `OpenOptions::append(true).create(true)` (survives the #5177 double-instantiation), `BufWriter` + `flush()` per line, mode `0600`. Emit metadata ONLY — never pane title/content. Release profile: `opt-level="z"`, lto, `codegen-units=1`, strip, `panic="abort"`.

The filename scheme — `/host/<session>.ndjson`, fields `{seq, epoch, session, pane_id, tab_id, tab_name, ts}` — is the contract tasks `.3` (consumer) and `.4` (dir + dotfiles wiring) build against.

### Investigation targets

**Required** (read before coding):
- /Users/mike/src/zellij-org--zellij/zellij-tile/src/shim.rs — subscribe, request_permission, get_session_environment_variables, get_zellij_version, get_plugin_ids
- /Users/mike/src/zellij-org--zellij/zellij-utils/src/data.rs:2281 — PaneManifest; :2296 PaneInfo (id, is_plugin, NO tab_id); :2237 TabInfo (tab_id, position, name)

**Optional** (reference as needed):
- github.com/dj95/zjstatus and github.com/cfal/zellij-vertical-tabs — ZellijPlugin trait skeleton + TabUpdate subscription + permissions.kdl shape

### Risks

- A rename-only `TabUpdate` must re-emit affected panes or tab renames stop flowing (silent regression).
- #5177 double-instantiation — mitigated by append-only open; the dedup design (task 3) tolerates duplicate lines.
- The plugin loads in EVERY session (dotfiles global load), so it must stay cheap and never block the screen thread — write only on pane/tab deltas, stay idle otherwise.

### Test notes

Factor the PaneManifest+TabInfo -> NDJSON-lines join as a pure Rust fn and unit-test it (incl. is_plugin skip, rename re-emit, missing-tab-map ordering). Manual: load into a live session via the dotfiles `load_plugins` block, `tail` `/host/<session>.ndjson`, rename a tab and open a new one, confirm correct lines appear.

## Acceptance

- [ ] Plugin builds to `wasm32-wasip1`, loads headless (no visible pane), stays resident, and emits no render output
- [ ] On pane/tab change it appends correct `{seq, epoch, session, pane_id, tab_id, tab_name, ts}` lines (metadata only) to `/host/<session>.ndjson`, `is_plugin` panes excluded
- [ ] A tab rename re-emits the affected panes' lines
- [ ] The plugin writes ONLY to `/host` (WASI sandbox) — no host-path resolution inside the plugin; `/host/<session>.ndjson` is the documented task-3/task-4 contract
- [ ] Pure join fn has unit tests

## Done summary

## Evidence
