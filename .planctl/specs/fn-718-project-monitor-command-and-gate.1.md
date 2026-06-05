## Description

**Size:** M
**Files:** src/derivers.ts, src/reducer.ts, cli/jobs.ts, test/derivers.test.ts, test/reducer.test.ts, test/jobs.test.ts, README.md

### Approach

Carry the `command` and `description` fields — already present on every
Stop event's `background_tasks[]` entry alongside `id`/`type`/`status` —
through the monitor projection pipeline, then render the command on its
own indented line in `keeper jobs`.

1. Widen `extractBackgroundTasks` (src/derivers.ts:305) from `string[]` to `{id, command, description}[]`. Lift `command`/`description` as defensive string coerces (`typeof x === "string" ? x : ""`). Keep the `type === "shell"` allowlist, the stable sort (now sort-by-`id` on the objects), and the `BACKGROUND_TASKS_CAP = 50` slice-AFTER-sort. Never throws.
2. Grow `MonitorEntry` (src/derivers.ts:269) to `{id, kind, command?, description?}`.
3. In `computeMonitors` (src/reducer.ts:7487), build entries from the deriver's objects, merging the provenance `kind` by id. Keep the `id < currentEventId` events-scan gate untouched (re-fold determinism). The command/description ride from the Stop payload — the provenance SELECT does NOT widen, so the covering index is unaffected.
4. Rework `monitorLinesFor` (cli/jobs.ts:309): emit a PRIMARY line `${indent}${pill(kind)} <label>` where label is `description` (falling back to `id` when description is empty), then — ONLY when `command` is non-empty — a CONTINUATION line at `indent + "    "` carrying the first non-empty line of `command` (reuse the existing multi-line collapse at :340). Do NOT keep command as the primary label (avoid double-emit). Falls back to a single line when command is empty (today's id-only behavior).
5. Update JSDocs (drop the "no-ops today / restore recipe" framing on `monitorLinesFor`; revise `computeMonitors` + `extractBackgroundTasks` docs to the settled shape) and the README render spec (~664-676 ASCII art for the two-line shape; schema v51 callout ~1376 for the new fields).

Do NOT carry `status` — empirically always `"running"`; fn-708 dropped its render slot. NO `SCHEMA_VERSION` bump — `jobs.monitors` is opaque JSON-TEXT and keeper-py does not read it.

### Investigation targets

**Required** (read before coding):
- src/derivers.ts:305-337 (`extractBackgroundTasks`) + :269-272 (`MonitorEntry`) — the widen sites
- src/reducer.ts:7487-7539 (`computeMonitors`) — entry construction; ~:6643 monitors-only write call site; :6789/:6847 terminal-clear (read-only reference)
- cli/jobs.ts:309-357 (`monitorLinesFor`) — already reads command/description defensively; :293-299 (the dropped `status` slot precedent)
- test/derivers.test.ts:1444-1556 — the ~10 `.toEqual` assertions that flip from `string[]` to objects

**Optional** (reference as needed):
- test/reducer.test.ts:15856+ (`readMonitors` helper) — fold tests
- test/jobs.test.ts:851-913 (esp. :887-905 "future-enriched" test already exercising command/description — rewrite for two-line output)
- README.md:664-676, :1376

### Risks

- Return-type widen ripples to every `extractBackgroundTasks` assertion; the sort must stay a stable total-order sort-by-id so the cap bites deterministically (re-fold invariant).
- `monitorLinesFor` double-emit: command currently IS the label; the split must move it to the continuation line only.
- Pre-enrichment v51 monitors rows lack command/description → render must fall back to id gracefully (it does); confirm no throw.

### Test notes

Update `extractBackgroundTasks` tests for the object shape (preserve allowlist/sort/cap/determinism cases). Add a reducer fold test asserting command/description survive into `jobs.monitors` and that the terminal-clear (ended/killed) still yields `'[]'`. Rewrite the `monitorLinesFor` tests for the two-line shape (primary `[kind] <description>`, indented command continuation) + fallbacks (no command → one line; no description → id primary).

## Acceptance

- [ ] `extractBackgroundTasks` returns `{id, command, description}[]`, preserving the shell allowlist, stable sort-by-id, and cap-after-sort; all deriver tests updated and green
- [ ] `computeMonitors` serializes command/description into `jobs.monitors` without widening the provenance SELECT; a from-scratch re-fold reproduces byte-identical rows
- [ ] `keeper jobs` renders each monitor as `[kind] <description>` with the command/script on an indented continuation line; rows without a command fall back to a single line
- [ ] No `SCHEMA_VERSION` bump; `keeper/api.py` untouched; `test/schema-version.test.ts` still green
- [ ] JSDocs + README render spec / schema callout updated to the settled two-line / enriched shape

## Done summary
Carried command/description through the v51 monitors projection: extractBackgroundTasks returns {id,command,description}[] (sort-by-id + cap-after-sort preserved), computeMonitors threads them through without widening the provenance SELECT, and monitorLinesFor renders [kind] <description-or-id> with the command on an indented continuation line. No SCHEMA_VERSION bump. All deriver/reducer/jobs tests updated and green.
## Evidence
