## Description

**Size:** S
**Files:** scripts/epics.ts (delete), scripts/jobs.ts (delete), scripts/board.ts (file header + HELP), README.md, scripts/approve.ts, src/protocol.ts, src/server-worker.ts

### Approach

Mechanical cleanup pass. The pill is live from task .1; this task makes the surrounding documentation reflect that and removes the now-redundant single-collection example clients.

1. **Delete the siblings** — `git rm scripts/epics.ts scripts/jobs.ts`. Verify no other file imports from them (none do today — both are standalone CLI scripts).
2. **scripts/board.ts file header + HELP** — rewrite to stand alone. Today the docstring (lines 4-5, 13, 15, 67, 86-88) leans on "fuses scripts/epics.ts and scripts/jobs.ts into a single stream"; the HELP (lines 106, 119, 121, 147) cross-refers "see scripts/epics.ts for the epic-block format" / "use the sibling scripts/epics.ts and scripts/jobs.ts"; in-function comments (lines 162, 271, 277, 344) say "mirrors scripts/epics.ts:renderEpicBlock". Inline the rationale (epics fetches the full default scope because the set is tiny; jobs pages 10 because that's the chosen page size) and drop every dead reference. Update the HELP's epic-header format example to include the new `[validated|unvalidated]` pill from task .1.
3. **README.md** — four edits, all driven by docs-gap-scout:
   - Line 78 (`Three example clients ship in scripts/`) and line 232 (`Two example clients ship in scripts/`): collapse to "Two example clients ship in `scripts/`" (the surviving pair: `board.ts` for read, `approve.ts` for the approval RPC).
   - Lines 234-287 `## Example clients`: rewrite around `board.ts` as **the** subscribe client (combined epics + jobs view, server-default filters, `--clear` live-panel mode, sidecars). Drop the `jobs.ts` / `epics.ts` bullets and code blocks. Match the existing bullet + code-block shape.
   - Line 347 `## Architecture` schema-version anchor: update "As of schema v11…" → "As of schema v14, the `epics` projection adds `last_validated_at` (TEXT, nullable) — the validation timestamp planctl writes via `planctl validate --epic <id>` and the board client renders as a `[validated|unvalidated]` pill." One sentence, no changelog.
   - Line 410 `## Inspect` example `epics` query: include `last_validated_at` in the SELECT list so a reader can confirm the field is populated.
4. **scripts/approve.ts** — repoint the two cross-refs:
   - Line 8 (`Unlike the example scripts/epics.ts / scripts/jobs.ts clients…`) → reference `board.ts` as the subscribe-client example.
   - Line 155 (`The task-id regex mirrors taskNumFromId in scripts/epics.ts and…`) → reference `scripts/board.ts:184` where the identical helper lives.
5. **src/protocol.ts:130** — comment example "(e.g. `scripts/epics.ts`)" → "(e.g. `scripts/board.ts`)".
6. **src/server-worker.ts:133** — `[epics-ts]` instrumentation TODO. OPEN: verify this comment names a real trace prefix used somewhere live (grep `[epics-ts]` across the tree) before rewriting/dropping. If it's purely a historical breadcrumb tied to the now-deleted `scripts/epics.ts`, drop the line cleanly. If it names a real trace prefix `board.ts` also emits, repoint at `[board]` or similar; if only the deleted script emitted it, the prefix dies with the script.

### Investigation targets

**Required** (read before coding):

- scripts/board.ts:1-72 — file docstring that cross-references the deleted siblings (full rewrite target).
- scripts/board.ts:86-91 — page-size-constants comment ("same as scripts/jobs.ts") — inline the actual rationale.
- scripts/board.ts:104-148 — HELP constant — full rewrite target.
- scripts/board.ts:160-162, :271-279, :344 — in-function "mirrors scripts/epics.ts" / "mirrors scripts/jobs.ts" comments.
- README.md:78, :232, :234-287, :347, :410 — five edit sites.
- scripts/approve.ts:8, :155 — comment cross-refs.
- src/protocol.ts:130 — example comment.
- src/server-worker.ts:133 — `[epics-ts]` TODO (verify before rewriting).

**Optional** (reference as needed):

- Task .1's live pill output (run `bun scripts/board.ts` after task .1 lands; useful when writing the HELP format example).

### Risks

- **`[epics-ts]` TODO origin** — the comment at src/server-worker.ts:133 may name a live instrumentation prefix. Mitigation: grep `[epics-ts]` across the tree before rewriting; only drop or repoint after confirming it's purely a historical cross-ref.
- **External shellouts to the deleted scripts** — anyone outside this repo who shells out to `bun scripts/epics.ts` or `bun scripts/jobs.ts` will break silently. Not a blocker for this task (out of scope to grep external repos).

### Test notes

No new tests. The two test additions live in task .1. Smoke test: `bun scripts/board.ts` shows clean output with the updated header and HELP and the new pill on every epic header.

## Acceptance

- [ ] `scripts/epics.ts` and `scripts/jobs.ts` are deleted; `git status` confirms.
- [ ] No file in the repo references `scripts/epics.ts` or `scripts/jobs.ts` (verified via `rg`).
- [ ] `bun scripts/board.ts --help` shows updated HELP with the new `[validated|unvalidated]` pill in the epic-header format example and no references to the deleted siblings.
- [ ] `README.md` line 78 and line 232 say "Two example clients" (or equivalent revised text — not "Three"); `## Example clients` features `board.ts` as the example; `## Architecture` schema-version anchor names v14 + `last_validated_at`; `## Inspect` example `epics` query includes the new column.
- [ ] `scripts/approve.ts` lines 8 and 155 reference `scripts/board.ts`, not the deleted siblings.
- [ ] `src/protocol.ts:130` references `scripts/board.ts`.
- [ ] `src/server-worker.ts:133` either repoints the `[epics-ts]` TODO at a live trace prefix or drops the line — decision and rationale captured in the commit message.

## Done summary
Deleted scripts/epics.ts + scripts/jobs.ts, rewrote scripts/board.ts header + HELP (with new [validated|unvalidated] pill in epic-header format example), and repointed all cross-references (README.md intro counts + Example clients + Architecture v14 anchor + Inspect query, scripts/approve.ts, scripts/autopilot.ts, src/protocol.ts) at board.ts. Dropped the [epics-ts] TODO cross-ref from src/server-worker.ts since the prefix only emitted from the deleted script.
## Evidence
