## Description

**Size:** S
**Files:** src/restore-set.ts, test/restore-set.test.ts

### Approach

Reproduce first: confirm `deriveCurrentSet` (`src/restore-set.ts:1680+`) selects
`jobs` rows with `state IN ('working','stopped')` + a backend session id and does
NO pid/liveness check at all — so a job whose pid was recycled by a reboot (state
never transitioned) surfaces as "current" pointing at whatever now owns that pid
(the observed fn-816/fn-1164 → Apple-daemon rows). Contrast the sibling
post-terminal deriver (`:1609-1626`) which already does `pidAlive` + a
pane-ownership recycle guard.

Add `pid, start_time` to the SELECT (the `jobs.start_time` column already exists,
`reducer.ts`) and gate each row on a recycle-safe `(pid, start_time)` liveness
probe via an INJECTED start-time seam (epic References) — not a bare `pidAlive`,
and not a 6th duplicate. `deriveCurrentSet` is documented "never throws" and
serves BOTH `keeper tabs list` display AND the `--snapshot-current` revive script;
preserve never-throws and pick one null-start_time / probe-failure fail-direction
that satisfies both consumers (state the choice: a live row with no stored
start-time must not be silently dropped from the revive script, nor trusted as a
phantom in the list).

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- src/restore-set.ts:1680-1703 — `deriveCurrentSet` SELECT (lacks pid/start_time)
- src/restore-set.ts:1609-1626 — sibling deriver with `pidAlive` + pane-ownership recycle guard
- src/reducer.ts — `jobs.start_time` column already populated

**Optional:**
- src/seed-sweep.ts:99 — `readOsStartTime` (via injected seam)

### Risks

- `deriveCurrentSet` feeds the revive snapshot script; an over-aggressive drop omits a genuinely live session. Fail-direction must be reconciled across both consumers.
- Must preserve the never-throws contract (read-time guard, never inside a fold — re-fold determinism).

### Test notes

Extend `test/restore-set.test.ts` with an injected liveness dep: a recycled-pid row is excluded/flagged; a live `(pid, start_time)`-matched row is kept; a null-start_time row follows the documented fail-direction.

## Acceptance

- [ ] `deriveCurrentSet` keys current-set membership on a `(pid, start_time)` liveness probe, not projection state alone.
- [ ] A reboot-recycled pid no longer surfaces as a current session.
- [ ] The probe uses an injected seam; `deriveCurrentSet` still never throws.
- [ ] Null-start_time / probe-failure resolves to one documented fail-direction consistent for both `tabs list` and `--snapshot-current`.

## Done summary
deriveCurrentSet now gates current-set membership on an injected recycle-safe (pid, start_time) liveness probe (defaulting to the file-local pidAlive + seed-sweep's readOsStartTime), excluding a reboot-recycled pid while keeping a live-pid row with no stored start_time or a probe failure — the documented conservative fail-direction for both tabs list and --snapshot-current. Never throws, even on a throwing injected probe.
## Evidence
