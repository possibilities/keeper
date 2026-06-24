## Description

**Size:** M
**Files:** src/collections.ts, src/readiness-client.ts, cli/jobs.ts, test/tmux-focus-collection.test.ts (new)

### Approach

- **Collection** (`src/collections.ts`): register `TMUX_CLIENT_FOCUS_DESCRIPTOR` in `REGISTRY`, modeled on
  `AUTOPILOT_STATE_DESCRIPTOR` — `pk: "id"`, `version: "last_event_id"`, unbounded page limit (singleton).
- **Subscribe** (`src/readiness-client.ts`): add a `makeState("tmux_client_focus", ...)` singleton subscription in
  `subscribeReadiness`, projected onto the snapshot as `snap.tmuxFocus = byId.get(order[0])` (mirror the
  `autopilot_state` multiplex). The singleton table exists from migration and its query returns `rows: []`
  immediately, so the all-collections first-paint gate clears even when no worker ever connects (no-tmux env).
- **Render** (`cli/jobs.ts`): render the focus pill `[focus <session>:<win> %<pane>]` (or `[focus: none]` when
  `status:"none"`/absent) via `liveShell.setStatus`, COMPOSED with the persistent `[dead-letter:N]` pill — extend
  `persistentBannerPill` rather than overwriting it. Stamp it BEFORE the body byte-compare short-circuit, and make
  the ~1.5s flash-restore timer rebuild BOTH pills.

### Investigation targets

**Required** (read before coding):
- src/collections.ts:528 — `AUTOPILOT_STATE_DESCRIPTOR`; :668 — the `REGISTRY` map.
- src/readiness-client.ts:1488 — the `autopilot_state` singleton `makeState` + snapshot projection to mirror; :1558 — the all-collections readiness gate (must stay cleared by `rows: []`).
- cli/jobs.ts:834 — `persistentBannerPill`; :642 / :724 — `setStatus` call sites; :52 — the persistent-pill + flash-restore docstring.

### Risks

- First-paint wedge: if the new collection joins the readiness gate it MUST emit `rows: []` when empty (it does — the table exists from migration).
- Banner clobber: focus and dead-letter pills must compose, and the flash timer must restore both.

### Test notes

Descriptor/projection round-trip test (singleton reaches `snap.tmuxFocus`). Banner-composition unit test:
focus present/absent × dead-letter present/absent. No real tmux needed (drive via a synthetic projection row).

## Acceptance

- [ ] `TMUX_CLIENT_FOCUS_DESCRIPTOR` is registered and the singleton reaches `snap.tmuxFocus` over the subscribe socket.
- [ ] An empty / never-populated singleton emits `rows: []` and does NOT wedge first-paint (no-tmux env still paints).
- [ ] `keeper jobs` renders `[focus <session>:<win> %<pane>]` / `[focus: none]` composed with `[dead-letter:N]`, stamped before the byte-compare short-circuit, and the flash-restore timer rebuilds both pills.

## Done summary

## Evidence
