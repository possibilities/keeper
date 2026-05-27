## Description

**Size:** M
**Files:** src/db.ts, src/types.ts, src/collections.ts, src/reducer.ts, scripts/board.ts, test/reducer.test.ts, test/db.test.ts, test/collections.test.ts, test/board.test.ts, README.md

### Approach

Land the whole server-side flip plus the board pill as one coherent change. The dep chain inside the task is db → types → descriptor → reducer → tests → board, but everything ships in one commit.

1. **Schema v29 (`src/db.ts`)**:
   - Bump `SCHEMA_VERSION` from 28 to 29 at `src/db.ts:56`.
   - Add a paired `// v28→v29: ...` block with two `addColumnIfMissing` calls: `created_by_closer_of TEXT` (nullable, no default) and `sort_path TEXT NOT NULL DEFAULT ''`.
   - Mirror both columns in the `CREATE_EPICS` literal at `src/db.ts:442-458` in matching column order.
   - Backfill via rewind-and-redrain — the v25→v26 spawn-name pattern at `src/db.ts:2139-2152`: `UPDATE reducer_state SET last_event_id=0; DELETE FROM jobs; DELETE FROM epics; DELETE FROM subagent_invocations;` inside the same migration transaction. Boot drain re-folds everything from scratch under the new fan-out, so re-fold determinism handles backfill for free.

2. **Types (`src/types.ts:611-666`)**:
   - Add `created_by_closer_of: string | null` and `sort_path: string` to the `Epic` interface.
   - JSDoc each: source (schema v29, reducer-derived inside `syncPlanctlLinks`), fold semantics (`sort_path` is the lexicographic key driving the descriptor's default sort; `created_by_closer_of` is the raw closer→child link). Mirror `last_validated_at` and `job_links` docstring style.

3. **Descriptor (`src/collections.ts:167-236`)**:
   - Add both columns to `EPICS_DESCRIPTOR.columns`.
   - Add `sort_path` to `sortable` (the trust boundary for ORDER BY interpolation at `src/server-worker.ts:486`).
   - Flip `defaultSort` from `{column: "epic_number", dir: "asc"}` to `{column: "sort_path", dir: "asc"}`.
   - Rewrite the docstring at `src/collections.ts:148-165` to explain the new sort key, the prefix-sort invariant, and that closer-completion does reorder the page (intended behavior, distinct from the old "epic_number never reorders" rationale).

4. **Reducer fan-out (`src/reducer.ts:2196-2399`, `syncPlanctlLinks`)**:
   - Inline `const zeroPad6 = (n: number): string => String(n).padStart(6, "0")` near the function (single call site; don't extract to a util module).
   - After the existing `touchedEpics` loop computes `job_links` and runs the UPDATE at `:2382-2385`, add a new derivation block per touched epic:
     - **`created_by_closer_of`**: read the just-computed `creator` link entries; SELECT `plan_verb, plan_ref` from `jobs` for every creator's `job_id`. Filter to `plan_verb='close' AND plan_ref IS NOT NULL`. Tie-break: lowest `job_id` ASC. If none match → NULL.
     - **`sort_path`**: if `created_by_closer_of` is NULL → `zeroPad6(epic_number)`. Else SELECT parent's `sort_path` from `epics` by `epic_id = created_by_closer_of`. If parent row missing or parent `sort_path` is `''` → fallback to `zeroPad6(epic_number)` (parent-missing safe-fold). Else `parent.sort_path + '.' + zeroPad6(epic_number)`.
     - **Overflow guard**: if `epic_number >= 1_000_000` → `sort_path = ''` and `noteLine` to the existing lifecycle/log mechanism (never throw inside the open tx).
     - **UPDATE epics**: extend the existing UPDATE to also set `created_by_closer_of` and `sort_path` (same row, same statement).
   - **Full transitive cascade**: after each touched epic's `sort_path` UPDATE, SELECT every epic row with `created_by_closer_of = <this epic_id>`, recompute their `sort_path` using the new parent value, UPDATE them. Recurse to fixed point inside the same `BEGIN IMMEDIATE`. Cycle guard: track a `visited: Set<string>` and cap at depth 50; bail with a `noteLine` on overrun (never throw). By construction cycles can't form (one closer-creator per epic, immutable), so the guard is defense-in-depth.
   - **Shell-INSERT branches** at `src/reducer.ts:2138-2144` and `:2390-2396`: extend the column list with both new columns. `created_by_closer_of` defaults to NULL; `sort_path` to `''` (shell rows are transient — the next EpicSnapshot fold computes the real values via the derivation above).

5. **EpicSnapshot ON CONFLICT carve-out (`src/reducer.ts:549-597`)**:
   - Update the carve-out comment block at `:550-560` to call out both new columns alongside `tasks` / `jobs` / `job_links`.
   - Omit `created_by_closer_of` and `sort_path` from the `ON CONFLICT(epic_id) DO UPDATE SET` clause at `:564-573` so an approval RPC → file write → file-watcher → `EpicSnapshot` round-trip preserves them.
   - The shell-INSERT branch at `:561-563`: write `NULL` for `created_by_closer_of` and `''` for `sort_path` to honor the zero-event reading; the very next `syncPlanctlLinks` call computes the real values.

6. **Board pill (`scripts/board.ts`)**:
   - Add `"slotted-after-closer": "active"` to the `PILL_COLORS` map at `:345-362`.
   - In `renderEpicBlock` at `:577-580`, after the `[validated|unvalidated]` pill and before `formatPill(epicVerdict)`, append ` [slotted-after-closer]` only when `row.created_by_closer_of != null`. Use a small ternary; mirror the existing `epicDepsSeg` conditional shape.
   - Update the `HELP` constant docstring near the top to mention the new pill in the epic header description.

7. **README.md** — three small inline updates (locations called out in epic spec's Docs gaps section).

### Investigation targets

**Required** (read before coding):

- `src/db.ts:56` — `SCHEMA_VERSION = 28` (bump to 29).
- `src/db.ts:442-458` — `CREATE_EPICS` literal (lockstep with ALTER).
- `src/db.ts:2139-2152` — v25→v26 spawn-name widening with rewind-and-redrain precedent.
- `src/db.ts:2166-2217` — v27→v28 NOT NULL DEFAULT precedent (different type — integer — but same migration shape).
- `src/reducer.ts:549-597` — `projectPlanRow` EpicSnapshot fold + ON CONFLICT carve-out comment.
- `src/reducer.ts:1858` — example SELECT shape pulling `plan_verb, plan_ref` from `jobs`.
- `src/reducer.ts:2196-2399` — `syncPlanctlLinks` body. UPDATE at `:2382-2385` and shell-INSERT at `:2390-2396` are the insertion points.
- `src/reducer.ts:2056-2147` — `syncJobLinksOnJobWrite` parallel fan-out; **does not** need changes (closer session state flips don't change downstream `sort_path`), but read it to understand why it's distinct.
- `src/reducer.ts:2929` — `syncPlanctlLinks(db, jobId, event.id, ts)` call site (no change needed).
- `src/collections.ts:148-236` — `EPICS_DESCRIPTOR` + docstring that needs rewriting.
- `src/types.ts:611-666` — `Epic` interface.
- `scripts/board.ts:345-362` — `PILL_COLORS`.
- `scripts/board.ts:577-580` — epic header line; `scripts/board.ts:553-611` for full `renderEpicBlock` context.
- `test/reducer.test.ts:3506+` — `syncPlanctlLinks` test suite + helpers `planPlanOpener`, `planctlEvent`, `getEpicLinks`, `getJobLinks`.
- `test/reducer.test.ts:1883+` — rewind-and-redrain re-fold idempotence pattern (template for the byte-identical-re-fold test).

**Optional** (reference as needed):

- `src/plan-classifier.ts:1-100` — `deriveEpicLinks` shape; confirms creator-link's `job_id` is the closer-session's own job (plan_verb is per-spawn, not per-window).
- `src/server-worker.ts:486` — generic ORDER BY interpolation (no change; just understanding the sort boundary).
- `test/db.test.ts` — `addColumnIfMissing` idempotence + schema-equality patterns.
- `test/board.test.ts` — pill rendering + `colorizePillsInLine` test patterns.
- `test/collections.test.ts` — `defaultSort` assertions (will need updates).

### Risks

- **Full transitive cascade inside one BEGIN IMMEDIATE** in theory grows the transaction at deep chains. Real-world chain depth in this codebase is 2-3; cap-at-50 guard is defense-in-depth, not a real bound.
- **Empty-string `sort_path` floats to top** for shell rows during the transient window between shell-INSERT and the next EpicSnapshot fold. Board's default WHERE (`status='open' AND approval != 'approved'`) filters most shells out anyway; document the behavior in the schema-v29 callout.
- **Same-file merge risk with fn-620** (in_progress, touches `src/reducer.ts`/`src/types.ts`/`scripts/board.ts` in different fields/functions). Phase 6 auto-wire handles via `epic add-deps`.
- **`epic_number ≥ 10^6` ceiling**: silent sort-order corruption if hit; safe-fold (`sort_path = ''` + stderr note) prevents reducer wedge but does compromise ordering at boundary. Document in README schema callout.
- **The cascade re-stamp converges only if `created_by_closer_of` is immutable** (which it is by construction — one closer-creator per epic, set once on creation). Defensive cycle guard backs this up.

### Test notes

- **New `test/reducer.test.ts` scenarios** under `syncPlanctlLinks:` suite (use existing `planPlanOpener` / `planctlEvent` / `getEpicLinks` / `getJobLinks` helpers + a new `getEpicSortFields(epicId)` helper that SELECTs `(created_by_closer_of, sort_path)`):
  - **plain epic, no closer ancestry** → `created_by_closer_of = NULL`, `sort_path = zeroPad6(epic_number)`.
  - **closer-created epic, single level**: closer session with `plan_verb='close', plan_ref='fn-3-foo'` runs `/plan:plan` + `epic-create` for `fn-7-bar` → `created_by_closer_of='fn-3-foo'`, `sort_path='000003.000007'`.
  - **chain depth 2**: fn-3 → fn-7 (via fn-3 closer) → fn-11 (via fn-7 closer) → fn-11.sort_path = `'000003.000007.000011'`.
  - **chain depth 3**: extend the above one more level; assert no truncation.
  - **parent-missing event ordering**: child folds before parent → child.sort_path = `zeroPad6(child.epic_number)` (placeholder); later parent's EpicSnapshot folds → cascade re-stamps child to canonical `parent.sort_path + '.' + zeroPad6(child.epic_number)`. Assert both intermediate and final state.
  - **creator tie-break**: two `plan_verb='close'` creator entries → lowest `job_id` ASC wins.
  - **approval RPC carve-out**: trigger an EpicSnapshot fold against an existing epic with non-null `created_by_closer_of` and non-trivial `sort_path` → both preserved.
  - **rewind-and-redrain re-fold determinism**: build state via stream A, capture full epic row JSON; rewind+DELETE+drain stream A; capture again; assert byte-identical (`JSON.stringify` equality, key order included).
  - **`epic_number >= 10^6` safe-fold**: synthetic event with epic_number=1_000_000 → `sort_path=''` + lifecycle note; reducer doesn't throw; cursor advances.
  - **cascade depth-50 guard**: synthetic 60-deep chain → bails at 50 with note; reducer doesn't throw.

- **New `test/db.test.ts` cases**:
  - `addColumnIfMissing` idempotent re-runs for both new columns.
  - Schema-equality: fresh-v29 DB schema (CREATE_EPICS) == v28 DB after migration to v29.

- **New `test/collections.test.ts` cases**:
  - `EPICS_DESCRIPTOR.defaultSort` == `{column: "sort_path", dir: "asc"}`.
  - `EPICS_DESCRIPTOR.sortable` contains `sort_path`.
  - Both columns in `EPICS_DESCRIPTOR.columns`.

- **New `test/board.test.ts` cases**:
  - `renderEpicBlock` renders `[slotted-after-closer]` when `created_by_closer_of != null`; omits when null.
  - `colorizePillsInLine` colors `[slotted-after-closer]` in the `active` (cyan) bucket.

## Acceptance

- [ ] Schema bumps to v29 with both columns added via `addColumnIfMissing`; `CREATE_EPICS` literal matches the ALTERs.
- [ ] Migration triggers rewind-and-redrain so existing event history re-folds with the new derivation.
- [ ] `syncPlanctlLinks` computes both columns + full transitive cascade inside the open tx; defensive cycle guard caps depth at 50.
- [ ] Reducer never throws — every defensive read folds to a safe value; `epic_number >= 10^6` overflows to `sort_path = ''` + stderr note.
- [ ] EpicSnapshot ON CONFLICT carve-out preserves both new columns alongside existing carve-outs.
- [ ] `EPICS_DESCRIPTOR` adds columns, adds sort_path to sortable, flips defaultSort to sort_path ASC; docstring rewritten.
- [ ] `Epic` interface gains both fields with proper JSDoc.
- [ ] `scripts/board.ts` renders `[slotted-after-closer]` pill in `active` color bucket when applicable.
- [ ] `scripts/autopilot.ts` requires zero changes (verify by reading after the descriptor flip).
- [ ] README.md updates for schema callout + pill list + SQL examples land.
- [ ] All new reducer/db/collections/board tests pass.
- [ ] Existing `bun test` suite continues to pass.

## Done summary

## Evidence
