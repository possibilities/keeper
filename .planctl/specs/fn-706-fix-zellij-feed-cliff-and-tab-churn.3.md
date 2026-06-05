## Description

**Size:** S
**Files:** ~/code/zellij-tab-namer/src/main.rs (impl + #[cfg(test)] tests), rebuilt tab_namer.wasm

### Approach

Add a per-tab debounce so a candidate `[process]` label must persist
`DEBOUNCE_TICKS` (= 2) consecutive reconcile ticks (~2 s at the 1 s
`POLL_SECS`) before any rename is issued. This kills transient flaps
(`[starship]` prompt renders, sub-second subprocesses) that today generate a
real `rename_tab_with_id` → real `TabUpdate` → a keeper feed line on every
flap. Track per `tab_id` a `(candidate_label, consecutive_count)`: when a
reconcile computes the desired label, if it differs from the stored
candidate reset count to 1, else increment; only when `count >= DEBOUNCE_TICKS`
pass the label through to the existing `decide()` / `apply_rename()`. Gate
ALL renames (first-adoption AND same-tab process-change convergence) — the
churn IS post-adoption flapping, so gating only adoption would not reduce it;
the cost is a genuine sustained process switch lagging ~2 s, which is
accepted. Leave the `decide`/ownership/`disowned`/`managed` model entirely
intact — the debounce is a PRE-FILTER in front of `decide`, not a change to
it. Key the debounce by `tab_id` (the rename target), tracking the focused
pane's process; a focus change naturally changes the candidate and resets the
count. Thread the debounce state through the `reconcile_with` seam so the
fake-fetcher unit tests stay meaningful. Add `DEBOUNCE_TICKS` as a const.
Rebuild: `cargo build --release --target wasm32-wasip1`, redeploy the `.wasm`
that `~/code/dotfiles/zellij/.config/zellij/config.kdl:101` points at.

This repo is a producer of zellij renames only; it writes nothing to keeper's
event log, so no keeper invariants apply — purely local plugin logic.

### Investigation targets

**Required**:
- ~/code/zellij-tab-namer/src/main.rs:296-331 — `reconcile_with` (the unit-tested seam; thread debounce state here)
- ~/code/zellij-tab-namer/src/main.rs:218-247 — `decide` (leave intact; debounce sits in front)
- ~/code/zellij-tab-namer/src/main.rs:277-290, 369 — `Plugin` state (add the debounce map), `POLL_SECS`/timer
- ~/code/zellij-tab-namer/src/main.rs test module — `reconcile_adopts_default_tab_then_tracks_process`, `reconcile_survives_lagging_tab_name`, `reconcile_disowns_human_renamed_tab_permanently` (must still pass)

### Risks

- Must not break the `reconcile_survives_lagging_tab_name` self-disown regression test — the debounce changes WHEN a rename fires, not the ownership inference.
- Keyed by `tab_id` not `pane_id` (pane_id would break a multi-pane tab); candidate resets on focus change by construction.
- A sustained legit process switch lags ~`DEBOUNCE_TICKS` ticks — accepted tradeoff.

### Test notes

Extend the `#[cfg(test)]` tests with the fake fetcher: a flap sequence
(`zsh`, `starship`, `zsh`) within `< DEBOUNCE_TICKS` issues NO rename; a
process stable for `>= DEBOUNCE_TICKS` ticks issues exactly one rename; the
adopt / lagging / disown tests still pass. `cargo test` on the host target.
Rebuild the wasm and confirm it loads (no permission/instantiation change).

## Acceptance

- [ ] A candidate `[process]` label must persist `DEBOUNCE_TICKS` (=2) consecutive ticks before any rename is issued; counter resets when the candidate changes.
- [ ] Transient flaps (`[starship]`/sub-second) are suppressed; a stable process still names the tab.
- [ ] `decide`/`disowned`/`managed` ownership model unchanged; debounce is a pre-filter threaded through `reconcile_with`.
- [ ] Existing adopt/lagging/disown tests pass; debounce tests added and green.
- [ ] `tab_namer.wasm` rebuilt; loads cleanly in a zellij session.

## Done summary
Added a per-tab debounce (DEBOUNCE_TICKS=2) as a pre-filter in front of decide() in reconcile_with: a candidate [process] label must persist 2 consecutive reconcile ticks before any rename fires, killing transient flaps. Ownership/disown model unchanged; existing tests updated to tick across the window plus new flap/stable-window tests; wasm rebuilt in place at the config.kdl path.
## Evidence
