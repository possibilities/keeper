## Description

**Size:** M
**Files:** cli/keeper-watch.ts, test/keeper-watch.test.ts, package.json

Build the read-only deterministic scanner: the `Finding[]`-producing detection
core plus the default human-readable table and `--json` output modes. This is
the keystone — it defines the `Finding` contract every later task consumes and
proves the failure classes are detectable cleanly before any escalation exists.
`--tick` is OUT OF SCOPE here (task .2).

### Approach

Mirror the repo CLI entry shape (`cli/session-state.ts`): `#!/usr/bin/env bun`
shebang, top doc-comment contract, `HELP` literal, hand-rolled `parseArgs`,
exported `main(argv)`, `import.meta.main` guard. Factor detection into pure,
exported functions `(rows) => Finding[]` so they unit-test without a live DB
(the `DispatchDeps` injectable pattern in `cli/keeper.ts` is the testability
model). Open the DB via `openDb(resolveDbPath(), { readonly: true, prepareStmts: false })`
— `prepareStmts:false` is MANDATORY (the default builds an insert stmt naming
every events column and throws on a schema-skewed live DB before `openDb`
returns). Bound `events` scans to a recent window (default ~1h by `events.ts`).

A `Finding` = `{ key, fingerprint, severity, category, title, detail, evidence }`.
`key` = stable per-condition id (e.g. `dup-approve:fn-728-….2`); `fingerprint`
= hash of (category, stable-resource-id, version) — NO timestamps/pids/free-text.

Detection checks (deterministic; thresholds are defaults, refinable):
- **dup-approve**: `events` `planctl_op='approve'`, same `planctl_target` across
  ≥2 distinct `session_id` within ~15 min. (Provable against the fn-728 fixture.)
- **dup-dispatch**: `hook_event='Dispatched'`, `data` JSON `{verb,id,…}`, same
  `verb::id` repeated within a window.
- **dispatch-failure**: rows in `dispatch_failures`.
- **daemon-down**: UDS connect to `resolveSockPath()` refused/absent AND keeperd
  process absent. Do NOT use `reducer_state.updated_at` (it's `event.ts`, frozen
  when idle on a healthy daemon).
- **reducer-wedge**: `MAX(events.id) - reducer_state.last_event_id` over a
  threshold (held-across-ticks logic lands in .2 via seen-state; here emit the
  magnitude finding).
- **dead-letter-growth**: count files under `resolveDeadLetterDir()` (delta logic
  in .2; here expose the current count as evidence).
- **autopilot-stall**: `autopilot_state.paused=0` AND ready work exists AND no
  recent `Dispatched`. Do NOT flag `paused=1` alone (boots paused by design).
- **stuck-job**: `jobs` non-terminal `state` (working/stopped) + dead `pid`,
  corroborated by job age to dodge launch races. (pid-liveness probe is fine —
  the scanner is an external observer, not a fold.)
- **approval-review**: each `approve` op surfaced as an info-severity item for the
  agent's merit judgment (the unmerited-approval class — scanner does not judge).

Default mode prints a readable table; `--json` prints `{ success:true, findings:[…] }`
(JSON-envelope convention). The scanner MUST NOT write `keeper.db`.

### Investigation targets

**Required** (read before coding):
- cli/session-state.ts:1 — CLI entry-shape + JSON-envelope + degrade-don't-throw template
- cli/keeper.ts:26 — injectable `DispatchDeps` testability pattern
- src/db.ts:6022 — `openDb` signature; :6044 — why `prepareStmts:false` is mandatory
- src/db.ts:69 — `resolveDbPath`; :84 — `resolveSockPath`; :384 — `resolveDeadLetterDir`
- src/db.ts:423 — `events` columns; :724 — `jobs`; :1189 — `dispatch_failures`; :1509 — `autopilot_state`; :1661 — `reducer_state`

**Optional** (reference as needed):
- src/reducer.ts:8032 — proof `reducer_state.updated_at = event.ts` (why daemon-down can't use it)
- src/daemon.ts:938 — boot AutopilotPaused (why paused=1 alone isn't a wedge)
- src/readiness.ts — computeReadiness (autopilot-idle-is-legit reference for the stall check)

### Risks

- Over-eager dup-approve on legitimate re-approval — the ~15 min same-target,
  multi-session window is the guard; calibrate against the fn-728 fixture.
- Schema skew vs live DB — `prepareStmts:false` + intersect-known-columns posture.
- A slow full scan degrades keeperd's checkpoint — bound scans to a recent window, keep <100ms.

### Test notes

Seed a sandbox DB in a tmpdir (`mkdtempSync`, `openDb` writer + raw INSERTs),
point `KEEPER_DB` at it, assert `Finding[]` from the pure detectors. Sandbox ALL
FIVE `KEEPER_*` paths — never spread `process.env` (pollutes the real feed).
Include the fn-728 dup-approve fixture as a named test. Add `test/keeper-watch.test.ts`
to the `test:fast` set in `package.json`.

## Acceptance

- [ ] `keeper-watch --json` emits `{success:true, findings:[…]}` with stable `key`+`fingerprint` per finding
- [ ] All nine detection checks implemented as pure exported functions
- [ ] fn-728 dup-approve signature (3 sessions / one target / ~2 min) is detected in a unit test
- [ ] Fingerprints contain no timestamps, pids, or free-text
- [ ] DB opened `{readonly:true, prepareStmts:false}`; a write attempt would fail at the SQLite layer
- [ ] Tests sandbox all five `KEEPER_*` paths; `test/keeper-watch.test.ts` is in `test:fast`
- [ ] `bun run lint`, `bun run typecheck`, `bun run test:fast` pass

## Done summary
Built cli/keeper-watch.ts read-only detection core: 9 pure (input)=>Finding[] detectors wired over a bounded readonly scan ({readonly:true,prepareStmts:false}), stable key+fingerprint (no timestamps/pids/free-text), default table + --json output. Detects the live fn-728 dup-approve signature. 30 unit tests in test/keeper-watch.test.ts (in test:fast).
## Evidence
