## Description

**Size:** M
**Files:** src/types.ts, src/db.ts, src/reducer.ts, src/board-render.ts, cli/board.ts, keeper/api.py, test/reducer.test.ts, test/board.test.ts, test/db.test.ts

Clone the schema-v25 `last_input_request_*` / `[awaiting:ask_user_question]` machinery to surface a "blocked on a permission/elicitation dialog" state. The one structural divergence from the InputRequest clone: `permission_prompt` and `elicitation_dialog` are REAL `Notification` hook events discriminated by `events.event_type` (already written by `plugin/hooks/events-writer.ts:581-582`), NOT synthetic events — so the fold logic goes in a new `case "Notification"` that branches on `event.event_type`, never a new synthetic switch case and no `src/daemon.ts` mint. No hook change is needed.

### Approach

Add a new paired projection field `(last_permission_prompt_at REAL, last_permission_prompt_kind TEXT)` on `jobs`, paired-NULL invariant (both move together, both NULL by default). The `kind` is DERIVED from `notification_type`: `permission_prompt → "permission"`, `elicitation_dialog → "elicitation"` — a 2-member allow-list cloned from `INPUT_REQUEST_KINDS` + `validate/extract` helpers (`src/reducer.ts:280-315`), so the pill renders `[awaiting:permission]` / `[awaiting:elicitation]`. STRICTLY gate the stamp: only those two `event_type` values stamp; `idle_prompt` / `auth_success` / empty / unknown subtypes are no-ops.

The stamp does **NOT** flip `state` (diverges from InputRequest, which flips to `stopped`) — the pill layers on top of the live `[working]` state, which is the whole point (the parked worker still IS mid-turn from keeper's POV; no Stop fired). Consequently the clear arms only zero the pair, no state restore.

Clear arms (clone the InputRequest gated-clear shape, `WHERE ... last_permission_prompt_at IS NOT NULL`): `UserPromptSubmit` (`:6184-6198`), `SessionStart` resume UPSERT (`:6022-6038`), `PreToolUse`/`PostToolUse` (`:6704-6715`), PLUS a new `Stop` clear as the session-level backstop. `PermissionDenied` is deliberately excluded (no existing arm; unverified it fires on human denials).

Denormalize the pair onto ALL FIVE JSON/row shapes or the rewind produces drifted JSON and breaks byte-identical re-fold: jobs columns (`src/db.ts:679-682`), `enrichJobLink` SELECT + zero-row default (`:4521-4554`), `EmbeddedJobElement` iface + `buildEmbeddedJob` copy (`:3983-3995` / `:4127-4149`), `syncIfPlanRef` SELECT (`:4395-4418`), and the `src/types.ts` `Job` (`:483-492`), `JobLinkEntry` (`:144-150`), `EmbeddedJob` (`:811-817`) interfaces.

Render: clone `inputRequestPillSeg` (`src/board-render.ts:135-141`) as `permissionPromptPillSeg(at, kind) → ' [awaiting:<kind>]'`. The `awaiting:* → warn` colorizer bucket already exists (`:277-279`), so the pills color yellow with NO `colorizePillsInLine` change. Add the second pill-seg call + continuation-line push at both `cli/board.ts` call sites (`renderJobLinkLines:507-519`, `renderJobLines:570-584`), on their own indented line like the existing awaiting pill.

Schema: bump `SCHEMA_VERSION` 51→52 (`src/db.ts:61`); add columns to the `CREATE TABLE jobs` literal AND a new v51→v52 ALTER slot via `addColumnIfMissing` after `:4949`, cloning the v24→v25 rewind-and-redrain (`UPDATE reducer_state SET last_event_id=0` + `DELETE FROM` projections) because this widens the embedded-job AND job_links JSON shapes. Add `52` to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` (`:170-172`) in THIS change.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6622-6677 — `case "InputRequest"` compound stamp (the stamp template; note it flips state — we do NOT)
- src/reducer.ts:6718-6736 — the `default:` arm where `Notification` currently no-ops; lift `Notification` into its own case while preserving the post-switch planctl fan-out + title precedence that fires OUTSIDE the switch (warned at :6731)
- src/reducer.ts:6450-6479 — `RateLimited`/`ApiError` shows branching on `event_type` inside a fold arm + strict gating
- src/reducer.ts:6184-6198, :6022-6038, :6704-6715 — the three clear arms to clone (UserPromptSubmit / SessionStart resume / Pre+PostToolUse gated)
- src/reducer.ts:6203 (Stop arm) — add the new Stop clear here; confirm it does not fight the (no-state-flip) stamp
- src/reducer.ts:280-315 — `INPUT_REQUEST_KINDS` + `validateInputRequestKind` + `extractInputRequestKind` (clone for the 2-member permission/elicitation allow-list; safe-parse, never throw in-fold)
- src/reducer.ts:4521-4554, :3983-3995, :4127-4149, :4395-4418 — the five denorm shapes
- src/db.ts:61, :679-682, :3455-3513 (v24→v25 ALTER slot + the :3499 "zero historical events" comment that does NOT hold here), :4949 (insert new slot after), :5016 (meta stamp)
- src/types.ts:85, :144-150, :483-492, :811-817 — the kind union + the three interfaces
- src/board-render.ts:135-141 (clone target), :255-291 (awaiting:* bucket already present — no change, just a test)
- cli/board.ts:507-519, :570-584 — the two pill call sites
- keeper/api.py:170-172 — `SUPPORTED_SCHEMA_VERSIONS`
- plugin/hooks/events-writer.ts:576-588 — confirm `event_type = notification_type` lands `permission_prompt`/`elicitation_dialog` (no change needed)

**Optional** (reference as needed):
- test/reducer.test.ts:11970-12189 — `InputRequest fold` block (stamp, terminal guard, kind fallback, 3 clear arms) + `getInputRequestState` helper
- test/board.test.ts:632-799 — awaiting pill + stacking + colorizer assertions
- test/db.test.ts:4897-5054 — v24→v25 migration tests

### Risks

- **Re-fold over historical `permission_prompt` rows is NOT a no-op.** Unlike v25 (zero historical `InputRequest` events → cols read NULL), the live log ALREADY contains real `permission_prompt` Notification rows. The cursor=0 rewind WILL fold them and stamp `last_permission_prompt_at` on whatever sessions were parked. This is intended, but the stamp MUST be a pure function of `event.ts` (never `Date.now()`/env/fs) so the rewind is deterministic — and the migration test must assert REAL stamps from a seed log containing `permission_prompt` rows, NOT the NULL-everywhere assertion the v25 test uses.
- **Paired-NULL across five shapes.** Miss any one of the five denorm shapes and the rewind produces drifted JSON arrays → byte-identical re-fold breaks. Add the pair to every shape in lockstep.
- **`elicitation_dialog` is less-exercised than `permission_prompt`** in the live log — confirm `events-writer` writes its `event_type` identically (it does, via the generic `notification_type` passthrough) and add a reducer test for it even if no historical rows exist.
- **fn-684 schema-slot overlap** — if fn-684 lands a schema bump first, rebase 52→53 (and the keeper-py whitelist entry) per its stated contract.

### Test notes

- Reducer: clone the InputRequest fold block — stamp (permission AND elicitation), strict-gate (`idle_prompt`/`auth_success`/empty `event_type` do NOT stamp), kind validate/fallback, all five clear arms (UserPromptSubmit / SessionStart / PreToolUse / PostToolUse / Stop), terminal-row no-row guard, and re-set on a second prompt. Confirm the stamp does NOT change `state`.
- Board: clone the `renderJobLinkLines` / `renderJobLines` awaiting assertions for `[awaiting:permission]` and `[awaiting:elicitation]` on their own continuation lines; a stacking case (api-error + input-request + permission all non-null); colorizer asserts both new pills route to `warn`.
- Migration: clone test/db.test.ts:4897 but seed a log WITH `permission_prompt` + `elicitation_dialog` Notification rows and assert real stamps after redrain; assert a fresh-DB CREATE and a migrated DB converge byte-identically.
- `test/schema-version.test.ts` auto-passes once both the SCHEMA_VERSION bump and the keeper-py whitelist entry land.

## Acceptance

- [ ] `permission_prompt` Notification stamps `(last_permission_prompt_at, kind='permission')`; `elicitation_dialog` stamps `kind='elicitation'`; both render `[awaiting:<kind>]` on their own continuation line at both board call sites, layered on the `[working]` state.
- [ ] `idle_prompt`, `auth_success`, empty, and unknown `notification_type` values do NOT stamp (strict gate, reducer test proves it).
- [ ] The pair clears on `UserPromptSubmit` / `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop`; the stamp does NOT flip `state` (reducer test proves both).
- [ ] The pair is denormalized onto all five shapes (jobs cols, enrichJobLink, EmbeddedJobElement/buildEmbeddedJob, syncIfPlanRef, the three types.ts interfaces) with the paired-NULL invariant.
- [ ] `SCHEMA_VERSION=52`, `52` in `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`, v51→v52 ALTER slot clones the v24→v25 rewind-and-redrain; `test/schema-version.test.ts` passes.
- [ ] Migration test seeds a log WITH `permission_prompt`/`elicitation_dialog` rows and asserts real stamps after redrain; a cursor=0 re-fold reproduces byte-identical projections; fresh-DB and migrated-DB converge.
- [ ] `bun test` passes; the colorizer routes `[awaiting:permission]` and `[awaiting:elicitation]` to the warn bucket.

## Done summary
Schema v52 lands the paired (last_permission_prompt_at, last_permission_prompt_kind) projection: Notification:permission_prompt / elicitation_dialog stamp the pair without flipping state, five clear arms (UPS/SessionStart/Pre+PostToolUse/Stop) zero it, and the board renders [awaiting:permission]/[awaiting:elicitation] on its own continuation line layered on [working].
## Evidence
