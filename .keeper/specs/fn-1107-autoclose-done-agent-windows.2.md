## Description

**Size:** M
**Files:** src/exec-backend.ts, src/db.ts, src/autopilot-worker.ts, src/readiness-inputs.ts, test/config.test.ts, test/renamer-worker.test.ts

### Approach

Four shared seams the autoclose worker consumes, each extended in place:

1. **Pane sweep identity fields.** Extend the tmux list-panes format + PaneInfo with
`pane_start_time`, `pane_dead`, and `session_name`. Keep `window_name` as the LAST
format field (it is free text and may contain the separator); insert the new fields
before it and update the parse. Every existing consumer (renamer worker, reconcile
snapshot liveness, slot occupancy) must parse green unchanged in behavior. These fields
give the kill path its per-pane discriminator (`pane_start_time` survives same-server
pane-id reuse; the stored generation id is only the tmux server pid) and a LIVE
session-membership check (a window moved out of the managed session is skipped).

2. **Config keys.** KeeperConfig gains `autocloseEnabled` (default TRUE) and
`autocloseGraceSeconds` (default 30), parsed from snake_case `autoclose_enabled` /
`autoclose_grace_seconds`. These are the FIRST boolean-ish and numeric keys in a
string-only config corpus — no parse pattern exists to copy. Disable semantics must be
generous (this is the off-switch for a window-killing feature): boolean false OR the
strings "false"/"off"/"no"/"0" (trimmed, case-insensitive) disable; absent or any other
value -> enabled. Grace: a positive finite number overrides; anything else -> 30.
Document the exact disable set in the doc comment.

3. **KillReason vocabulary.** Add `'autoclosed'` to the KillReason union (collision-free
addition; the union doc anticipates this).

4. **Neutral readiness-input loader.** Factor the readiness input-loading (the argument
set computeReadiness consumes: epics, jobs, subagent invocations, git status by dir,
pending dispatches, eligible epic ids, unseeded roots, per-root cap, lane keys) out of
the autopilot worker's snapshot loader into a new dep-light module (src/readiness-inputs.ts)
that owns no connection — callers pass their own read-only db handle. The autopilot
worker MUST consume the new module (move, not copy — divergence between the reconciler's
and autoclose's notion of done is the failure mode this task exists to prevent). Keep
alignment with the sole PendingDispatch builder used by the readiness client.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/exec-backend.ts:664-708 — buildTmuxListPanesArgs + listPanes parse; PaneInfo at :134-139
- src/exec-backend.ts:477-481 — the KillReason union
- src/db.ts:128-215 — KeeperConfig + resolveConfig (independent best-effort per-key parses; garbage -> default)
- src/autopilot-worker.ts:3751 — loadReconcileSnapshot, the readiness-input loading to factor out (NOTE: this file contains NUL bytes — use rg, not grep)
- src/readiness.ts:452 — the computeReadiness signature the loader must satisfy
- src/renamer-worker.ts — consumer of the pane sweep; its parse and tests must stay green

**Optional** (reference as needed):
- src/readiness-client.ts:1488 — subscribeReadiness, the second existing readiness consumer; projectPendingDispatches lives here (sole PendingDispatch builder — do not fork it)
- src/exec-backend.ts:375-386 — generation id = tmux server pid (why the per-pane discriminator is needed)
- src/db.ts:175 — why autopilot caps deliberately live in autopilot_state, not file config (context for the new keys' doc comments)

### Risks

- The list-panes format change touches a parse shared by the renamer and the reconcile liveness probe — a field-order mistake breaks window naming or slot occupancy silently. window_name stays last; test both consumers.
- Loader factoring that COPIES instead of MOVES leaves two loaders that drift; the reconciler must import the new module.
- An over-strict disable parse (only boolean false) leaves a mistyped off-switch silently killing windows.

### Test notes

Config: table-driven parse tests (absent/true/false/"false"/"off"/"no"/"0"/garbage;
grace 0/negative/NaN/string/positive). Pane sweep: parse tests with tab-separated fixtures
including a window_name containing the separator; renamer tests green. Loader: a test
asserting the autopilot worker path and a direct module call produce identical
computeReadiness inputs over the same seeded db (freshMemDb).

## Acceptance

- [ ] The pane sweep exposes per-pane start time, dead flag, and session name; the renamer and reconcile consumers behave identically to before.
- [ ] Config parsing: every documented disable form disables, absent/garbage yields enabled + 30s; values are re-read on each resolveConfig call.
- [ ] The KillReason vocabulary includes 'autoclosed'.
- [ ] The reconciler consumes the new readiness-input module (no duplicate loader remains) and reconcile behavior is unchanged.
- [ ] `bun test` green.

## Done summary
Shared autoclose seams: pane sweep + PaneInfo gain pane_start_time/pane_dead/session_name (window_name last, tab-safe six-field parse); autoclose_enabled (default on) + autoclose_grace_seconds (default 30) config keys re-read each resolve; KillReason gains 'autoclosed'; readiness-input loading MOVED into src/readiness-inputs.ts and consumed by the reconciler so its notion of done can't drift.
## Evidence
