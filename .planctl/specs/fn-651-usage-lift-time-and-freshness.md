## Overview

Make keeper's per-profile usage surface tell the truth about *when a
rate-limited profile unblocks* and *whether its numbers are fresh*, and
let agentuse act on the unblock time. Today the usage TUI shows
"rate-limited 3h ago" (when the limit FIRED) and, when agentuse's data
silently goes stale, keeps rendering confident-but-frozen gauges.

This cross-repo epic (keeper + agentuse) does four things:
1. **agentuse** computes an effective **lift time** — when a rate-limited
   profile is actually unblocked = the soonest `resets_at` among windows
   at >=100% — and emits it as a new top-level `lift_at` field in the
   usage JSON envelope (`~/.local/state/agentuse/<id>.json`).
2. **agentuse** uses `lift_at` to temporarily drop a rate-limited profile
   from the balancing pool (`_eligible_profiles`) AND pause its scraping
   until the lift passes (reusing the existing idle-skip mechanism).
3. **keeper** ingests `lift_at` through the existing `UsageSnapshot` path
   (exactly like `session_resets_at`) into a new `usage` column, and
   renders "rate-limited for 1h 2m" (countdown) — or `n/a` when there is
   no value or it is already in the past.
4. **keeper** adds a real, time-based **freshness** signal: a
   `last_usage_fold_at` stamp (the event `ts` of the last *successful*
   usage fold — never bumped by a rate-limit fold or an idle/stale
   snapshot) and a staleness warning in the renderer, so a wedged
   ingestion path becomes visible instead of silently frozen.

A prerequisite bug is folded in: the `UsageSnapshot` event serializer in
`src/daemon.ts` (~ln 1218) currently DROPS the fn-645 fields
(`status` / `subscription_active` / `error_type` / `error_message` /
`error_at`), so those columns are NULL forever — `mc1` (no subscription)
never gets redacted and the status chip never renders. Our new `lift_at`
rides that same serializer, so we fix it first (task .1).

Data flow: agentuse scrape → usage JSON envelope (`lift_at`) →
keeper `usage-worker` → `UsageSnapshot` event (serialized in daemon.ts) →
reducer `parseUsageSnapshot` fold → `usage` projection columns →
`USAGE_DESCRIPTOR` wire → `cli/usage.ts` render.

## Quick commands

- `cd ../agentuse && uv run pytest tests/test_parse_claude_usage.py tests/test_picker.py` — agentuse lift-time + cooldown
- `bun test test/reducer.test.ts test/db.test.ts` — fold + migration + re-fold determinism
- `bun test test/usage.test.ts test/collections.test.ts` — render + wire-shape
- `bun cli/usage.ts` — eyeball: a rate-limited profile reads "rate-limited for Nh Mm"; mc1 (no sub) is redacted; a stale row shows a freshness warning

## Acceptance

- [ ] The `UsageSnapshot` serializer in `src/daemon.ts` forwards ALL worker-message fields (the fn-645 `status` / `subscription_active` / `error_*` set, `sonnet_week_resets_at`, AND the new `lift_at`); a fresh fold populates those `usage` columns (non-NULL), `mc1` is redacted, and the status chip renders.
- [ ] agentuse emits a top-level `lift_at` (ISO | null) in the usage JSON envelope = the soonest `resets_at` among windows at >=100% used; null when the profile is not over any limit. Carried through active/idle/stale envelope writes (preserved like `usage`).
- [ ] agentuse excludes a profile from `pick_profile()` selection while `lift_at` is in the future, and pauses/limits its scraping until then (fail-open: if all profiles are excluded, selection still returns a profile).
- [ ] keeper ingests `lift_at` into a new `usage.rate_limit_lifts_at TEXT` column via `parseUsageSnapshot` (mirrors `session_resets_at`), riding the v39 schema bump; from-scratch re-fold reproduces it byte-identically.
- [ ] keeper stamps `usage.last_usage_fold_at` from the event `ts` ONLY on a successful usage fold (status active / usage present) — never on a rate-limit fold, idle, or stale snapshot — and a from-scratch re-fold reproduces it.
- [ ] The usage TUI renders "rate-limited for <rel>" when the lift is known and future, and `n/a` when it is absent OR already in the past (never a "<rel> ago" countdown); codex stacks still omit the line.
- [ ] The usage TUI shows a staleness warning on a row whose `last_usage_fold_at` is older than a threshold; `usageRowsHashKey` includes the new columns so reset-only / freshness-only changes repaint.

## Early proof point

Task that proves the approach: `.1` (the serializer-leak fix). It is a
small, standalone fix that immediately resolves a live complaint (`mc1`
not redacted, no status chip) and proves the worker→event→column path
our new fields depend on. If it fails or the columns stay NULL after a
bounce, the ingestion path is more broken than diagnosed — stop and
re-investigate the worker/serializer before building the rest.

## References

- Diagnosis source: the `debug-keeper-usage-percentages` session (`ef3b339d-2b66-4efa-925f-ab2f2d20932b`). The reported "wrong percentages" were stale data from a silently-wedged `@parcel/watcher` on `~/.local/state/agentuse/`; bouncing keeperd recovered it. The serializer leak + freshness-stamp + agentuse pause came out of that session.
- **Deferred follow-up (NOT in this epic):** a `usage-worker` watcher-liveness backstop (force a re-scan when no usage fold has landed in N minutes despite envelope mtimes advancing). It addresses the stall *itself* rather than its visibility, and brushes the "no in-process self-heal" contract — plan separately via `/plan:defer` if wanted. The freshness stamp added here is the column that would power it.
- Schema is **v38** (`src/db.ts:60`, fn-645 commit eb7cac6); this epic adds **v39**. The CLAUDE.md prose pin says v37 and is stale.
- `fn-646` (overlap) — keeper CLI OpenTUI port, task .3 mid-cutover on `cli/usage.ts` (task .5 here). Serialize to avoid a merge conflict; follow if it relocates the file.
- `fn-648` (overlap) — owns a concurrent `src/db.ts` `migrate()` bump and `src/reducer.ts` edits; coordinate the schema-version number (claim next free at impl time; rebase if taken).
- `fn-650` (overlap) — third writer to the same `migrate()` slot; same coordination.
- agentuse map: envelope built in `daemon.py` `_build_envelope()` / `ENVELOPE_KEYS` (~ln 382-428); reset parsing `parse_claude_usage.py` `RESETS_RE` (ln 58), per-window `{percent_used, resets_at}` (~ln 170-173); balancing `agentuse/api.py` `_eligible_profiles` (~ln 131-146) + `_choose` (~ln 149); idle-skip template `daemon.py` (~ln 498-545).

## Docs gaps

- **agentuse `README.md`**: the envelope contract — document the new top-level `lift_at` field.
- **keeper `CLAUDE.md`**: schema-version pin (v37→v39); the usage-projection column set (add `rate_limit_lifts_at` + `last_usage_fold_at`); note the freshness stamp is bumped only by a successful usage fold (determinism: event `ts`, not wall clock).
- **keeper `README.md`** `## Architecture`: an "As of schema v39" sentence + the `usage` collection block.
- **`cli/usage.ts`** header JSDoc + `HELP`: the rate-limit line now renders a lift countdown / `n/a`, plus the staleness warning.

## Best practices

- **Rate-limited != stale != idle.** Keep the three distinct in rendering. A rate-limit fold must NOT make a row look stale, and an idle profile is not stale.
- **Freshness is time-based, not status-based.** agentuse's own `status=="stale"` flag tracks *its* scrape failures, not keeper's ingestion health — the real incident had agentuse `active` throughout while keeper's worker was wedged. Drive the warning off `last_usage_fold_at` age, never off `updated_at` (rate-limit folds bump it) and never off agentuse `status`.
- **Determinism:** the freshness stamp is the event's own `ts`, set inside the fold — never `Date.now()` in a fold. The renderer compares it against the live clock (render-time wall clock is fine).
- **Binding limit = soonest reset among >=100% windows** (agentuse). Null when no window is over.
- **Fail-open balancing:** never let the cooldown filter return an empty eligible set — fall back to returning a profile (current `pick_profile` fail-open behavior).
- **Past-reset guard:** a lift/reset time `<= now` renders as `n/a`/expired, not a confident relative time.
