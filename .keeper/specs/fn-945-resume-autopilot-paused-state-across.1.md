## Description

**Size:** S
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/db.ts, test/daemon.test.ts (or test/autopilot-worker.test.ts), CLAUDE.md, README.md

### Approach

Two coordinated edits in `src/daemon.ts`, plus the stale-invariant doc/comment
sweep and a test.

1. **Remove the forced boot-pause re-arm.** Delete the unconditional
   `AutopilotPaused{paused:true}` synthetic-event INSERT block in
   `serveBootDrain()` (src/daemon.ts:1586-1631). LEAVE the `AutopilotCapSet`
   re-arm immediately after it (src/daemon.ts:1632-1682) exactly as-is — its
   fold's INSERT path (`VALUES (1, 1, …)`, src/reducer.ts:4021) is now the sole
   carrier of the fresh-DB `paused=1` default, and its ON CONFLICT branch
   preserves a durable `paused` on an existing row. Confirm the trailing
   `drainToCompletion` (src/daemon.ts:1683) still folds the CapSet re-arm before
   any worker spawns.
2. **Seed the worker boot flag from the durable column.** After
   `serveBootDrain()` returns (src/daemon.ts:2289, drain has reached head so
   `autopilot_state` is current) and before the autopilot worker spawn at
   src/daemon.ts:3331, read the singleton row and assign it to the in-memory
   `autopilotPaused` flag (initialized `true` at src/daemon.ts:1771). REUSE
   `projectAutopilotPaused` (cli/autopilot.ts:269-280) and honor its
   `null`-means-empty contract: `const p = projectAutopilotPaused(rows); if (p
   !== null) autopilotPaused = p;` — a bare assignment would coerce the
   empty-singleton `null` wrong and break the boots-paused default. Recommended
   placement: just after the `boot-complete` post (~src/daemon.ts:2298) or just
   before the `apConfig`/worker-spawn block (~src/daemon.ts:3311). Run the read
   unconditionally (cheap; keeps the flag honest for the `set_autopilot_paused`
   RPC null-guard path even when `want("autopilot")` is false).
3. **(Recommended, cheap)** emit one INFO log line when the seeded value is
   `false` (booting PLAYING from persisted state) — the new behavior most likely
   to surprise later. Keep it to one line; do not add config or counters.
4. **Correct the stale invariant** in the docs/comments enumerated in the epic
   `## Docs gaps` — forward-facing only (state the new behavior, no change
   history in comments/docs).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1582-1746 — `serveBootDrain()`: the `AutopilotPaused` block to remove (1586-1631), the `AutopilotCapSet` block to keep (1632-1682), the two `drainToCompletion` calls (1584, 1683).
- src/daemon.ts:2289-2298 — `serveBootDrain()` invocation + `boot-complete` gate (fn-897); the read must land after this.
- src/daemon.ts:1767-1771 — `let autopilotPaused = true;` (the seed target).
- src/daemon.ts:3331-3341 — autopilot worker spawn, `paused: autopilotPaused` at :3335.
- cli/autopilot.ts:269-280 — `projectAutopilotPaused` (reuse; null-on-empty).
- src/reducer.ts:4013-4031 — `foldAutopilotCapSet` INSERT `paused=1` + conflict-preserve (the re-fold determinism carrier); src/reducer.ts:3927-3953 — `foldAutopilotPaused` (unchanged, pure).
- src/autopilot-worker.ts:1793-1801 — `state.paused = data.paused ?? true` (paused is seeded ONCE here); ~1686-1699 — per-cycle projection-pull of mode/armed only (NOT paused); ~1055 — `if (state.paused)` gate. Confirms step 2 is necessary.

**Optional** (reference as needed):
- test/refold-equivalence.test.ts:139-141 — `AutopilotPaused`/`AutopilotCapSet` keep-set membership; extend the `autopilot_state` byte-identity guard.
- test/daemon.test.ts:91-350 — boot-drain test pattern (pre-seed `events`, drive `drainToCompletion`/`startDaemon`).
- src/db.ts:1184-1198 — `autopilot_state` schema + the stale doc comment.

### Risks

- **Re-fold determinism (central risk):** removing the boot-append changes the live event stream. `autopilot_state` is a deterministic-replayed projection — a from-scratch re-fold must stay byte-identical. It holds because real `AutopilotPaused` history folds the durable value and `foldAutopilotCapSet`'s INSERT `paused=1` carries the no-history default; verify `refold-equivalence` still passes. Do NOT add `autopilot_state` to any migration wipe list (no rewind needed).
- **Worker-paused is seeded once:** the gate reads in-memory `state.paused`, seeded only from `workerData.paused`. Step 2 is the ONLY path that delivers a resumed-playing state to the worker — omitting it silently fails the feature (and can desync the banner from the worker).
- **`created_at` provenance shift:** the singleton's `created_at` is now first seeded by the `AutopilotCapSet` re-arm rather than the `AutopilotPaused` one. No consumer reads it (the banner renders only the boolean), so this is cosmetic — but update the src/db.ts comment that claims otherwise.

### Test notes

- Assert BOTH legs and distinguish them by event provenance, not just the boolean: (a) a durable `AutopilotPaused{paused:false}` in pre-seeded history survives the boot drain and drives `workerData.paused=false` (boots PLAYING); (b) a fresh DB with no `AutopilotPaused` history boots PAUSED via the `AutopilotCapSet` INSERT default.
- Extend `test/refold-equivalence.test.ts` to confirm `autopilot_state` re-folds byte-identically with the boot-append removed.
- Update the `fn-778 boot-pause determinism` test comment (test/autopilot-worker.test.ts:607-624) — its claim about the daemon's unconditional boot re-arm is now false; the worker-side `?? true` assertion stays valid.
- This touches daemon/worker/db boot paths → `bun run test:full` is mandatory before landing.

## Acceptance

- [ ] The unconditional `AutopilotPaused{paused:true}` boot-append is removed from `serveBootDrain()`; the `AutopilotCapSet` re-arm is unchanged.
- [ ] After the boot drain and before the worker spawn, main seeds `autopilotPaused` from `autopilot_state.paused` via `projectAutopilotPaused`, treating `null` (empty singleton) as "keep the paused default".
- [ ] A pre-seeded durable `paused=0` boots the worker PLAYING; a fresh DB boots PAUSED — both asserted by a test distinguishing provenance.
- [ ] `test/refold-equivalence.test.ts` confirms `autopilot_state` re-folds byte-identically; `bun run test:full` passes.
- [ ] The boots-paused invariant is corrected (deliverable, not hygiene) in CLAUDE.md, README.md (`## Architecture`), src/db.ts:1184-1186, the src/autopilot-worker.ts JSDoc/comments, the src/daemon.ts comments, and the fn-778 test comment — forward-facing.

## Done summary

## Evidence
