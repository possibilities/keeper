## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/reducer.ts, src/daemon.ts, src/seed-sweep.ts, src/exec-backend.ts (probe helper if needed)

Add a producer-stamped `close_kind` column to `jobs` that records WHY a session died, so the restore derivation (T3) can tell a crash-kill from a deliberate window-close per-row — without any global crash boundary.

### Approach

Add a nullable `jobs.close_kind TEXT` column via `addColumnIfMissing` and bump `SCHEMA_VERSION` 69→70, adding `70` to `SUPPORTED_SCHEMA_VERSIONS` in keeper/api.py **in the same commit** (enforced by test/schema-version.test.ts). Extend `KilledPayload` + `extractKilledPayload` with `close_kind?: string | null` (defensive: any non-string → null), and append `close_kind = ?` to the Killed fold's `UPDATE jobs` write — a pure string copy, no liveness in the fold. Stamp `close_kind` at BOTH main-side producer sites by a tmux liveness probe: main's exit-watcher handler (`ew.onmessage`, daemon.ts:2263) and the boot-time `seedKilledSweep` (`insertKilledEvent`, seed-sweep.ts:144). Classification from the existing exec-backend primitives: `has-session` fails (no server) → `server_gone`; server alive AND the job's `backend_exec_pane_id` present in `list-panes -a` → `pid_died`; server alive AND pane absent → `window_gone_server_alive`; probe error/timeout → `unknown`. Use `tmuxLocaleEnv` so both sites classify identically.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:346 — `KilledPayload` interface (add `close_kind`)
- src/reducer.ts:370 — `extractKilledPayload` (parse defensively)
- src/reducer.ts:6472-6532 — the `case "Killed":` fold; write at :6520 (append `close_kind`)
- src/daemon.ts:2263-2330 — main's `ew.onmessage` Killed mint, payload at :2325 (probe site #1)
- src/seed-sweep.ts:144-173 — `insertKilledEvent` inline SQL, payload at :173 (probe site #2)
- src/exec-backend.ts:194 `buildTmuxHasSessionArgs`, :291 `buildTmuxListPanesArgs`, :301 `tmuxLocaleEnv`
- src/db.ts:50 `SCHEMA_VERSION`, :3389 `addColumnIfMissing` precedent
- keeper/api.py:259 `SUPPORTED_SCHEMA_VERSIONS`

**Optional**:
- test/schema-version.test.ts — the whitelist-membership enforcement
- test/reducer-lifecycle.test.ts — Killed-fold test patterns

### Risks

- The exit-watcher WORKER does not import exec-backend; keep the probe MAIN-SIDE (both producer sites run main-side) to avoid widening the worker's tmux dependency.
- A wrong default on probe failure flips a crash-kill into a never-restored user-close; `unknown` must be treated as crash-like-eligible by T3's backstop, not silently excluded.
- The two synthetic-mint column lists (raw db.run daemon.ts:1246, prepared insertEvent db.ts:3515) — close_kind rides the payload blob, so neither column list changes; verify.

### Test notes

Unit-test the probe→`close_kind` classifier with injected fake tmux output (server-gone, pane-present, pane-absent, error). Reducer test: a Killed event with each `close_kind` value folds onto the jobs row; a malformed payload folds to a safe default and still advances the cursor. Use `freshDb()` for in-process reducer tests; `sandboxEnv` for any subprocess test.

## Acceptance

- [ ] `jobs.close_kind` column added; `SCHEMA_VERSION`=70 and `70` in `SUPPORTED_SCHEMA_VERSIONS` (same commit).
- [ ] `close_kind` stamped at both `ew.onmessage` and `seedKilledSweep` by a main-side tmux probe with identical classification.
- [ ] Reducer folds `close_kind` as a pure string copy; malformed payload → safe default, cursor still advances, no throw.
- [ ] Classifier unit-tested for server_gone / pid_died / window_gone_server_alive / unknown.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
