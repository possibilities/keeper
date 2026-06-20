## Description

**Size:** M
**Files:** scripts/usage.ts, test/usage.test.ts, README.md

### Approach

Add a second `subscribeCollection({ collection: "profiles" })` to
`scripts/usage.ts` and render a "Rate limits by profile" block BELOW the
existing usage stacks. The current script is built around a single
collection's render state and one `liveShell` — this needs a deliberate
dual-stream composition, not a drop-in second subscribe.

**Combined-render contract:**
- Keep a parallel set of module-locals for the profiles stream (its own
  `lastProfileRows` + a `rowsHashKey`-style change-gate that EXCLUDES
  `last_event_id`/`updated_at`, mirroring the usage gate at ~:384), reset to
  null on `disconnected`.
- `emitFrame` composes ONE frame from the latest-of-each stream: usage block
  on top, then the "Rate limits by profile" block. Either subscription's
  `onRows` triggers a combined re-render (each `onRows` only knows its own
  block, so the shell must hold both latest blocks).
- The 30s live tick (~:439) must re-render BOTH blocks against the same
  `Date.now()` so relative times in either block stay fresh.
- The SIGINT teardown (~:480-493) must dispose BOTH subscription handles —
  don't leak the second subscription.

**Rendering details:**
- `profiles.last_rate_limit_at` is REAL unix-SECONDS (matching `jobs.last_api_error_at`),
  but the existing `relTime` humanizer (~:75-123) consumes an ISO string and
  does `Date.parse` — feeding raw seconds yields NaN. Add a thin numeric-input
  variant (or convert `new Date(sec*1000).toISOString()` at the call site);
  leave `relTime`'s existing ISO callers untouched.
- One row per profile: a profile chip + the last rate-limit relative time, or
  `—` when `last_rate_limit_at` is NULL.
- Label the `''` sentinel config_dir as `(default)` (the default `~/.claude`
  profile) rather than an empty chip.
- The two blocks are INDEPENDENT (usage `id` = agentuse profile id, profiles
  key = config_dir — disjoint key spaces, deferred). Present them as two stacked
  blocks; do NOT imply a row-to-row correlation that does not exist.

### Investigation targets

**Required** (read before coding):
- scripts/usage.ts:37,470-478 — `COLLECTION = "usage"` + the single `subscribeCollection` call
- scripts/usage.ts:75-123 — the minute-rounded `relTime` humanizer (ISO input; takes `nowMs`)
- scripts/usage.ts:176 — `renderRowLines(rows, nowMs)` render entry
- scripts/usage.ts:384-412 — `rowsHashKey` change-gate + `emitFrame`
- scripts/usage.ts:439-493 — the 30s tick + SIGINT dispose
- src/readiness-client.ts — `subscribeCollection` signature/handle/`dispose()` contract

**Optional** (reference as needed):
- test/usage.test.ts — render/humanizer test analog for the new block
- src/collections.ts `PROFILES_DESCRIPTOR` (from task 1) — the columns this block subscribes to

### Risks

- The single-stream render architecture (`lastRows`/`lastFrame`/`lastLiveLines`, copy/sidecar/history all assume one frame) is non-trivial to make dual-stream — design the composition before editing.
- Relative-time input-type mismatch (ISO vs unix-seconds) silently renders raw floats if not handled.
- Leaking the second subscription on SIGINT, or a tick that re-renders only one block.

### Test notes

- Model a render test on test/usage.test.ts: feed `profiles` rows (one with a `last_rate_limit_at`, one NULL, one `''` config_dir) and assert the block renders the `(default)` label, a relative time, and `—` for the NULL row at a fixed `nowMs`.

## Acceptance

- [ ] `scripts/usage.ts` opens a second `subscribeCollection({ collection: "profiles" })` and renders a "Rate limits by profile" block below the usage stacks
- [ ] Numeric (unix-seconds) relative-time rendering works (no raw-float leakage); `relTime`'s ISO callers untouched
- [ ] One row per profile with last rate-limit relative time or `—`; `''` sentinel labeled `(default)`
- [ ] Both blocks re-render on the 30s tick; both subscription handles disposed on SIGINT; independent change-gates
- [ ] README.md `usage.ts` example client entry updated to note the two subscriptions

## Done summary
Added a second subscribeCollection over 'profiles' to scripts/usage.ts; the script now composes one frame from two independent streams — usage stacks on top, a 'Rate limits by profile' block below (one row per profile, '(default)' for the '' sentinel, '—' for NULL last_rate_limit_at). Added a numeric-seconds relTime variant (relTimeFromUnixSec → shared relTimeFromMs body) so REAL unix-seconds inputs render as relative time with no raw-float leakage; existing ISO callers untouched. Both blocks re-render on the 30s tick against the same Date.now(); both subscription handles disposed on SIGINT; independent per-stream change-gates. README + HELP + module docstring + new tests cover the dual-stream surface (5 new tests; 18 total in test/usage.test.ts, all pass).
## Evidence
