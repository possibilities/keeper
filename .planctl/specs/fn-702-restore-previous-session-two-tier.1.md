## Description

**Size:** M
**Files:** src/restore-worker.ts, scripts/restore-agents.ts, test/restore-worker.test.ts, test/restore-agents.test.ts, README.md, CLAUDE.md

### Approach

Convert the single-map `restore.json` into a two-tier side-file —
`{ schema_version: 2, last_session: Tier | null, current: Tier | null }`
where `Tier = { captured_at, sessions }` — and split the write semantics:
`current` is the continuous live mirror (may be empty), `last_session` is
the frozen restore source written ONLY at boot-promote and the `>0→0`
collapse edge. **Land all of it in one commit** — the schema bump makes the
old reader treat a v2 file as "future" and refuse, so worker-writes-v2 and
reader-reads-v2 are atomically coupled; and retiring the empty-skip floor
without boot-promote + collapse-freeze in place would reintroduce the
fn-689 bug.

Sub-steps:
1. **Shape.** Reshape `RestoreDescriptor` (`:144-148`) into the two-tier
   on-disk shape; keep a `Tier`/sessions type the reader can resolve to a
   single `sessions` map so `planRestore` stays unchanged.
2. **Boot-disk-read helper.** Add a synchronous reader mirroring
   `parseZellijWatermarks` (`src/zellij-events.ts:212`) + the boot read at
   `src/daemon.ts:676-689`: `existsSync` → `readFileSync` → `JSON.parse` in
   try/catch → coerce each tier to `{}` on garbage / non-object / wrong
   shape. The worker currently never reads the file (`:365`).
3. **State.** Extend `PulseState` (`:253-257`) with `epochHighWater`
   (the full descriptor of the peak since the set was last empty — a
   snapshot, NOT a count), `lastSession` (the frozen tier), and
   `bootPromoted` (once-flag).
4. **`restorePulse` rewrite** (`:268-346`):
   - First pulse (`!bootPromoted`): read the persisted file; seed
     `lastSession` = `persisted.current` if populated, else
     `persisted.last_session` if populated, else legacy top-level
     `sessions`, else `{}`; set `bootPromoted`.
   - Build `current` from live jobs (unchanged builder).
   - Update `epochHighWater` = the larger (by agent count) of itself and a
     populated `current`.
   - If `current` is empty AND `epochHighWater` is populated → **freeze**:
     `lastSession = epochHighWater`; reset `epochHighWater = null`. If the
     freeze write throws, do NOT reset `epochHighWater` — retry on the next
     empty pulse.
   - Always assemble `{ schema_version: 2, last_session, current }` and
     `atomicWriteFile`; hash-gate over the whole-file shape minus per-tier
     `captured_at` (a freeze flips `last_session`, so the file hash changes
     and forces the write). **Remove the empty-skip return at `:304-306`.**
5. **Bump** `RESTORE_SCHEMA_VERSION` `:98` 1 → 2.
6. **Reader.** `scripts/restore-agents.ts` `loadRestoreFile` (`:558-606`):
   parse v2 `{ last_session, current }`, pick the restore source
   `last_session ‖ current ‖` (v1) legacy top-level `sessions`, and resolve
   to one `sessions` map before `planRestore` (`:365-389`) runs.
   `classifySchemaVersion` (`:331-334`) auto-follows the bumped const.
7. **Tests + docs** per the Test notes and the epic Docs gaps.

Reuse verbatim — do NOT reimplement: `atomicWriteFile` (`src/db.ts:5596`),
`serializePlanctlJson` (`:5529`), `sortObjectKeys` (`:5540`),
`resolveRestorePath` (`:104`).

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:144-148 — `RestoreDescriptor` (the shape to split)
- src/restore-worker.ts:253-346 — `PulseState` + `restorePulse` (empty-skip `:304-306`, hash gate `:313-315`)
- src/restore-worker.ts:353-433 — `main` (initial pulse `:388-389`, where boot-promote sequences); `:98` `RESTORE_SCHEMA_VERSION`
- scripts/restore-agents.ts:558-606 — `loadRestoreFile`; `:331-334` `classifySchemaVersion`; `:365-389` `planRestore` (reads `descriptor.sessions`)
- src/zellij-events.ts:212-262 — `parseZellijWatermarks` / `serializeZellijWatermarks`, the safe boot-disk-read to mirror
- src/db.ts:104,5529,5540,5596 — `resolveRestorePath`, `serializePlanctlJson`, `sortObjectKeys`, `atomicWriteFile` (reuse)
- test/restore-worker.test.ts:340-420 — floor-encoding tests to REVISE; `:262` schema literal `toBe(1)`
- test/restore-agents.test.ts:50-65 — `classifySchemaVersion` literals to revise

**Optional** (reference as needed):
- src/daemon.ts:1233-1234 — `seedKilledSweep` ordering (WHY boot-promote must read the file, not the projection)
- src/daemon.ts:2872-2886 — restore-worker spawn (no change expected; confirm spawn-after-sweep is harmless)

### Risks

- **Interdependency:** retiring the empty-skip on `current` WITHOUT boot-promote + collapse-freeze both in place reintroduces fn-689 — a window where `current` zeroes with no `last_session` fallback. All land in one commit.
- **Schema-bump coupling:** the moment the worker writes `schema_version: 2`, the OLD reader's `classifySchemaVersion` treats it as "future" and refuses — reader-reads-v2 MUST ship in the same commit.
- **Freeze-write failure:** if the `>0→0` edge write throws, the set stays empty so the edge won't re-fire; retry the freeze on subsequent empty pulses (don't reset `epochHighWater` until the write succeeds).
- **Partial collapse** (current shrinks to N>0, never reaches 0): freezes nothing by design; relies on the next boot-promote capturing the survivors. Accepted, matches Chrome's Last-Session semantics — document it, don't "fix" it.
- **Hash scope:** the gate must cover the whole two-tier file (sans per-tier `captured_at`) so a `last_session` freeze forces a write even when `current` is byte-stable.

### Test notes

Worker tests (seed a writer DB, drive `restorePulse` directly with an
injected `now()` + hand-built `PulseState`):
- boot-promote from a populated **v1** file (legacy top-level `sessions` → `last_session`)
- boot-promote from a populated **v2** file (current populated)
- boot-promote prefers `current` over a populated `last_session`
- boot-promote keeps `last_session` when persisted `current` is empty
- collapse-freeze across multi-pulse staggered death (8 → … → 0 across pulses freezes the high-water 8, not the last survivor)
- reseed-doesn't-clobber-`last_session` (`last_session`=8 survives while `current`=2)
- partial collapse (8 → 2, never 0) freezes nothing
- first-ever boot (no file) degrades to empty `last_session`

Reader tests: v2 read picks `last_session`; falls back to `current` when
`last_session` empty; v1 legacy file read with `sessions` as the
`last_session` source; a future (v3) file still refused.

Revise the hardcoded schema literals (worker `:262` → `toBe(2)`, agent
`:50-65`) and the floor-encoding tests (`:340-420`) to the new semantics.
Honor the `KEEPER_RESTORE_FILE` sandbox in `beforeEach`/`afterEach`; any
spawn test overrides all four state paths
(`KEEPER_DB`/`KEEPER_DEAD_LETTER_DIR`/`KEEPER_DROP_LOG`/`KEEPER_RESTORE_FILE`).

## Acceptance

- [ ] `restore.json` is written as `{ schema_version: 2, last_session, current }`; `current` is a faithful live mirror (may be empty); `last_session` is written ONLY at boot-promote and the `>0→0` collapse edge.
- [ ] On daemon restart, boot-promote seeds `last_session` from the persisted FILE (`current` if populated, else `last_session`, else legacy top-level `sessions`) — not the seed-swept jobs table; today's 8→2 reboot incident yields `last_session` = 8.
- [ ] In-daemon mass death folding across multiple pulses freezes the high-water set (full pre-collapse count) into `last_session` on the `>0→0` edge, not the last survivor.
- [ ] A smaller reseeded `current` never clobbers a populated `last_session`.
- [ ] The fn-689 empty-skip floor is removed from `current`; an empty live set writes an empty `current` without losing `last_session`.
- [ ] `scripts/restore-agents.ts` restores from `last_session`, falling back to `current` then legacy v1 top-level `sessions`; a v1 file on disk reads its `sessions` as the `last_session` source; a future (v3) file is still refused.
- [ ] `RESTORE_SCHEMA_VERSION` = 2; no DB `SCHEMA_VERSION` bump and no `keeper/api.py` change.
- [ ] README.md (tenth-worker paragraph + env-var summary) and CLAUDE.md (sole-writer restore paragraph, edited in place — AGENTS.md symlink untouched) describe the two-tier model, boot-promote, collapse-freeze, retired floor, and schema v2.
- [ ] `bun test` green (revised floor tests + new boot-promote / collapse / high-water / v1-compat cases); lint clean.

## Done summary
Reshaped restore.json into a two-tier descriptor {schema_version:2, last_session, current}: current is the continuous live mirror (fn-689 empty-skip floor retired), last_session is the frozen restore source written only at boot-promote (reads the persisted FILE, precedence current||last_session||v1-legacy sessions) and the >0->0 collapse edge (freezes the high-water peak, not the last survivor). Reader resolves last_session||current||v1-legacy and refuses a v3 file. RESTORE_SCHEMA_VERSION 1->2, no DB schema or keeper-py change. Docs (README tenth-worker + env-var, CLAUDE.md sole-writer) updated; 62 restore tests green.
## Evidence
