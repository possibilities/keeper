## Description

**Size:** S
**Files:** src/readiness-client.ts, src/dash/app.ts, test/readiness-client.test.ts, README.md

The shipped dash (`fn-841-robot-job-card-dash` task `.2`) subscribes with
`jobsFilter: { state: { not_in: [] } }` (`src/dash/app.ts:685`) to widen to
all states for the `t` toggle. But `JOBS_PAGE_LIMIT = 0` is UNBOUNDED, so the
query returns the entire job history (~3,872 rows) which serializes to one
NDJSON line over the 1 MiB `MAX_LINE_LENGTH` (`src/protocol.ts:309`) → the
connection closes before the first snapshot → the dash shows `0 jobs`. Cap the
fetch with a bounded first page.

### Approach

- Add `jobsLimit?: number` to `SubscribeOptions` (`src/readiness-client.ts`
  ~1305-1325), mirroring the existing `jobsFilter` shape (`readonly` + JSDoc +
  the `...(opts.x === undefined ? {} : {...})` spread-conditional). Thread it
  into the jobs `makeState` query `limit` at line 1358:
  `limit: opts.jobsLimit ?? JOBS_PAGE_LIMIT`. Use `??`, NOT `||` — `0` is the
  valid "unbounded" sentinel the four other callers rely on.
- In `src/dash/app.ts:682-685`, DROP the `jobsFilter` widen and pass
  `jobsLimit: 50` (a named const, e.g. `DASH_JOBS_PAGE = 50`). The dash now
  uses the descriptor's live-only default scope (`src/collections.ts:127`,
  `state not_in [ended,killed]`), first page of 50 (`created_at DESC`).
- **Reword every stale "WIDENED to terminal states / `t` reveals ended/killed"
  comment** to state current behavior (live-only, capped page, toggle
  deferred): `app.ts:31`, `621-624`, `678-681`, and the `onToggleTerminal`
  JSDoc `106-107`; `readiness-client.ts` `jobsFilter` JSDoc (`1316-1323` — make
  it caller-AGNOSTIC: describe the server capability, not "the dash passes…")
  and the inline comment `1359-1360`; and the README dash section (`1043-1052`
  — the `t` keybind line + the "jobs subscription WIDENED to terminal states"
  data-source prose). Add the new `jobsLimit` JSDoc mirroring the "Only the
  `jobs` collection is affected" note.
- **Keep** `jobsFilter` (now caller-less but a real server capability),
  `onToggleTerminal`/`inputs.showTerminal`, and `buildDashModel`'s
  `showTerminal` param — all inert/deferred against a live-only feed, NOT
  removed. The `t` toggle is deferred until a future bounded terminal page
  lands; the README/comment edits must say so rather than claim it reveals
  ended/killed today.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:1305-1325 — `SubscribeOptions` (mirror the `jobsFilter` shape); :1354-1362 — jobs `makeState`, line 1358 thread point; :95-103 — `JOBS_PAGE_LIMIT = 0` (the `??` fallback)
- src/dash/app.ts:682-702 — the `subscribeReadiness` call (drop line 685, add `jobsLimit: 50`); :31, :106-107, :621-624, :678-681 — stale comments
- src/collections.ts:122,127 — jobs `defaultSort: created_at DESC` + `defaultFilter` live-only (the page semantics behind the >50 caveat)
- test/readiness-client.test.ts:103-165,244-258 — `makeMockConnect()` / `takeOutbound()` seam (the unit-test home)
- README.md:1043-1052 — dash keybind + data-source prose to correct

**Optional** (reference as needed):
- src/protocol.ts:309,339 — `MAX_LINE_LENGTH` failure mechanism (context); :127-130 — `limit` semantics (omitted/0 → unbounded, positive → clamped at `MAX_LIMIT` 500)
- src/dash/view-model.ts:395,403 — `showTerminal` gating + the `created_at ASC` band sort (why the page is newest-50 but displayed oldest-first)

### Risks

- **>50 live jobs (latent, deferred):** the feed pages `created_at DESC`, so the cap keeps the 50 NEWEST live jobs — an OLD stuck `error`/`awaiting` job (the needs-you band's reason to exist) can fall off on a busy host. Moot today (23 live jobs < 50). A priority-aware page + real pagination + the terminal toggle are one deferred future iteration; capture as a known limitation, do NOT solve here.
- **MAX_LINE_LENGTH margin:** 50 live rows is ~2× today's working 23-row payload — comfortably under 1 MiB, and well below `MAX_LIMIT` (500). 50 is a safe page size.
- **Default-preservation contract:** the four other `subscribeReadiness` callers — `cli/jobs.ts:930`, `cli/board.ts:625`, `cli/autopilot.ts:766`, `cli/await.ts:1617`/`:1660` — pass no `jobsLimit` and MUST stay unbounded (`?? JOBS_PAGE_LIMIT` = 0). A `||` would coerce a future explicit `0`; lock the default with a test.

### Test notes

In `test/readiness-client.test.ts` (FAST tier) via the `makeMockConnect`/`takeOutbound` seam: assert a dash-style subscription (`jobsLimit: 50`) emits a jobs query carrying `limit: 50` and NO `filter`; and assert that with NO `jobsLimit` the jobs query still carries `limit: 0` (the four CLI callers unaffected). `test/dash-shell.test.ts` (no-op `write()`, blind to the query) and `test/dash-app.test.ts` (toggle tests inject terminal jobs directly into the model, bypassing the feed) need NO change — confirm none asserts the widened `jobsFilter`. Run `bun run test:opentui` + `bun run test:full` before landing.

## Acceptance

- [ ] `SubscribeOptions` gains `jobsLimit?: number`, threaded into the jobs query `limit` via `?? JOBS_PAGE_LIMIT` (so the four other callers stay unbounded at `limit: 0`)
- [ ] The dash subscribes with `jobsLimit: 50` and NO `jobsFilter` → live-only default scope, first page of 50; `keeper dash` shows live jobs again (not `0 jobs`)
- [ ] Every stale "WIDENED to terminal states / `t` reveals ended/killed" comment + the README dash prose is reworded to current behavior (live-only, capped page, deferred toggle); the new `jobsLimit` carries a JSDoc
- [ ] `t` toggle / `showTerminal` / `jobsFilter` left in place but inert/caller-less (deferred), not removed
- [ ] `test/readiness-client.test.ts` asserts the dash query (`limit: 50`, no `filter`) AND default-unbounded (`limit: 0`) when `jobsLimit` is absent; `bun run test:full` green

## Done summary

## Evidence
