## Description

**Size:** M
**Files:** src/restore-worker.ts, src/daemon.ts

Extend the restore-worker to wake on a ~1s timer, probe the WHOLE-server tmux topology,
hash-dedup, and post a worker→main message that main mints as ONE `TmuxTopologySnapshot` event
carrying the frozen `{generation_id, panes:[{pane_id, session_name, window_index}]}` map. The
producer probes the world; the fold (task 3) stays pure.

### Approach

Add a timer wake to the restore-worker's `watchLoop` so the topology probe fires ~1s even when
keeper's `data_version` is idle (coalesce with the existing data_version wake — one probe per
pulse, never two). Reuse `probeTmuxPanes` (restore-worker.ts:567) — it already yields
`(pane_id, window_index, session_name)` via `defaultSpawnSync` (locale-defaulted; LOAD-BEARING).
Capture the generation via the existing `probeServerGeneration` (restore-worker.ts:844) so the
snapshot is stamped with the server pid. Add a `lastTopologyHash` to `PulseState` (restore-worker.ts:475)
and hash the (pane_id, session_name, window_index) set (stable-sort then `Bun.hash`, copying
`hashPairs`/`hashWindowIndexCache`); post only on change. CRITICAL failure handling: distinguish
server-gone (exit non-zero + "no server running"/"failed to connect" stderr) from transient
(other non-zero / timeout / EPIPE) from empty-but-success (exit0, empty stdout = up with no panes).
On transient OR empty-success, do NOT post a wiping snapshot — keep last state (the fold also
preserves on absent, but the producer should not emit a spurious empty topology on a degraded probe).
In `src/daemon.ts`, add a new `else if (msg.kind === "tmux-topology-snapshot")` arm (~daemon.ts:3817)
that mints one event via `stmts.insertEvent.run` with a stable synthetic `session_id`
(e.g. "tmux-topology-snapshot") and `data = JSON.stringify({generation_id, panes})`.

Delimiter hardening: session NAMES can contain a tab; the current `probeTmuxPanes` format puts
session_name LAST and slices to end-of-line, which tolerates a trailing-tab name but an embedded
NEWLINE in a name still splits a row. Keep the existing tolerant parse; if a name-with-newline is
a concern, note it — full `\x01`-delimiter hardening is a Nice-to-Clarify, not required here.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:567 — `probeTmuxPanes` (reuse; produces the triple)
- src/restore-worker.ts:210 — `defaultSpawnSync` + `localeDefaultedEnv` + TMUX_PROBE_TIMEOUT_MS
- src/restore-worker.ts:844 — `probeServerGeneration`; :899 `maybePostBackendExecStart` (post-not-gated-on-live-job template)
- src/restore-worker.ts:475-521 — `PulseState` (add `lastTopologyHash`); :725-757 `hashPairs`/`hashWindowIndexCache`
- src/restore-worker.ts:1153-1163 — the worker→main `port.postMessage` closures; :1195 `watchLoop` wake
- src/daemon.ts:3817-3841 — `rw.onmessage` kind-discriminated synthetic-event minting

**Optional** (reference as needed):
- src/restore-worker.ts:1014-1054 — the existing per-pulse tmux poll arm

### Risks

- A timer wake that double-probes per pulse wastes a subprocess — coalesce the two wake sources.
- Emitting an empty topology on a transient probe failure would wipe live state downstream —
  the server-gone vs transient discrimination is load-bearing.
- Missing `defaultSpawnSync` (locale) silently drops every row under the LaunchAgent C locale.

### Test notes

Drive `probeTmuxPanes`/the post via an injected `spawnSync` (no real tmux): assert a changed
topology posts exactly one message; an unchanged topology (same hash) posts none; a non-zero
"no server running" vs a timeout produce the correct post/skip. Assert main mints exactly one
`TmuxTopologySnapshot` event with the expected payload shape.

## Acceptance

- [ ] The restore-worker probes whole-server topology ~1s, hash-dedups, and posts a
      `TmuxTopologySnapshot` (with generation_id) only on change.
- [ ] A transient probe failure / timeout / empty-but-success probe posts NO wiping snapshot.
- [ ] main mints exactly one `TmuxTopologySnapshot` event per posted change with payload
      `{generation_id, panes:[{pane_id, session_name, window_index}]}`.
- [ ] The probe goes through `defaultSpawnSync` (locale-defaulted, timeout-bounded).

## Done summary

## Evidence
