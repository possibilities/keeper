## Description

**Size:** S
**Files:** scripts/usage.ts, test/usage.test.ts, README.md

### Approach

Make `scripts/usage.ts` single-collection. Remove the `profiles` subscription
path entirely: `PROFILES_COLLECTION` const, the second `subscribeCollection`,
`emitProfiles`, `profileRowsHashKey`, `lastProfileRows`, `renderProfileLines`,
and `DEFAULT_PROFILE_LABEL`. In `renderRowLines` (L230-321), read
`last_rate_limit_at` off each usage row and append a colocated `rate-limited
<rel>` line per stack via the existing `relTimeFromUnixSec` helper. Suppress
the line when `last_rate_limit_at` is NULL (a tracked profile with no limit
shows nothing — not `—`) and for the codex stack (id `codex` / target `codex`
has no rate-limit concept). Untracked profiles never render (they have no
usage row — the "drop untracked" decision). Simplify `emitFrame` and the 30s
tick to compose only `usageLines` (drop the `profileLines` branch and the
blank-line separator). Update the JSON sidecar write to `{ usage }` only. Fix
the `relTime` unit-mismatch comment (both rate-limit values now ride the same
usage row in unix-seconds). Update the file-header + `HELP` string, and the
README `scripts/usage.ts` description (~L518-534) to the single-collection
colocated design. Also update the now-stale "INDEPENDENT in key space / not
joinable today" comments (~L340-345, ~L691-693).

### Investigation targets

**Required** (read before coding):
- scripts/usage.ts:230-321 — `renderRowLines` (where the colocated line is added)
- scripts/usage.ts:353-402 — `renderProfileLines` (delete) + DEFAULT_PROFILE_LABEL
- scripts/usage.ts:540-660 — `profileRowsHashKey`, `emitFrame`, `emitProfiles`, the tick, the two `subscribeCollection` calls
- test/usage.test.ts — pure-fn render tests with fixed clock + exact-string (padding) assertions

**Optional** (reference as needed):
- scripts/usage.ts:118-143 — `relTime` / `relTimeFromUnixSec` helpers
- scripts/usage.ts:54, ~503 — PROFILES_COLLECTION const, sidecar write shape

### Risks

- Exact-string test assertions (including padding) must be updated for the new per-stack line.
- codex suppression — don't render `rate-limited` (or `—`) for a profile with no rate-limit concept.
- Rate-limit line indentation must align under the stack like the existing body lines.

### Test notes

In test/usage.test.ts, drive `renderRowLines` with a fixed clock and hand-built
rows: assert the `rate-limited <rel>` line is present when `last_rate_limit_at`
is set, absent when NULL, and absent for the codex row. Remove the
`renderProfileLines` test block.

## Acceptance

- [ ] `usage.ts` subscribes only to the `usage` collection (no `profiles` subscription)
- [ ] each tracked stack shows a colocated `rate-limited <rel>` line when set; codex and no-limit stacks omit it
- [ ] untracked profiles do not render anywhere
- [ ] the JSON sidecar carries `{ usage }` only
- [ ] `bun test test/usage.test.ts` is green; README usage.ts description updated

## Done summary
scripts/usage.ts subscribes only to usage; tracked stacks render a colocated rate-limited <rel> body line when last_rate_limit_at is set; codex and never-limited stacks omit it; untracked profiles do not render; sidecar narrows to { usage }.
## Evidence
