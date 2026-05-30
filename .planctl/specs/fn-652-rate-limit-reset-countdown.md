## Overview

The keeper usage TUI currently shows a rate-limited profile as
"rate-limited 3h ago" — the timestamp the limit *fired*
(`last_rate_limit_at`, the synthetic `ApiError` event's `ts`). That's
backward-looking and not the useful fact. The useful fact — *when the
limit lifts* — exists today only as human-readable prose inside Claude
Code's rate-limit message ("You've hit your session limit · resets
3:20am (America/New_York)"). The transcript worker explicitly leaves
that clock unparsed (`src/transcript-worker.ts` docstring ~ln 92-99:
"the worker doesn't parse the reset clock... the full string rides
as-is so a future renderer can surface it").

This epic extracts that lift time into structured data and projects it
end-to-end: parse the reset clock at producer time into an absolute
timestamp, carry it on the `ApiError` event payload, project a new
`last_rate_limit_resets_at` column riding the existing v35
jobs→profiles→usage rate-limit fan-out, wire it onto the usage/profiles
collection descriptors, and render "rate-limited for 1h 2m" (countdown
to reset) in `cli/usage.ts`. When there is no parsed value, the line
shows `n/a` — never the fired-time. End state: a glanceable "when am I
unblocked" countdown per rate-limited profile.

## Quick commands

- `bun test test/api-error-reset.test.ts` — the new parser's unit suite
- `bun test test/reducer.test.ts test/db.test.ts` — fan-out + migration + re-fold determinism
- `bun test test/usage.test.ts test/collections.test.ts` — render + wire-shape
- `bun cli/usage.ts` — eyeball the live frame (a rate-limited profile should read "rate-limited for Nh Mm")

## Acceptance

- [ ] A `rate_limit` `ApiError` whose message text carries a parseable reset clock projects an absolute `last_rate_limit_resets_at` (unix-seconds) onto the matching `profiles` and `usage` rows, both fan-out directions.
- [ ] The usage TUI renders the lift countdown ("rate-limited for 1h 2m") when the reset is known and still future; renders `n/a` whenever there is no parsed value. It never renders the fired-time.
- [ ] The reset clock is parsed once at producer time anchored on the event's own `ts` (never `Date.now()`); the reducer fold reads the stored payload field only and never re-parses, so a from-scratch re-fold reproduces byte-identical rows.
- [ ] No historical backfill: the new column is NULL on pre-migration rows and populates on the next rate-limit event.
- [ ] Parser is total (returns `number | null`, never throws): bad regex, invalid IANA zone, missing minutes, 12h edge cases, and DST boundaries are all handled.

## Early proof point

Task that proves the approach: `.1` (the reset-clock parser). If it
fails — e.g. `Intl.DateTimeFormat` with a `timeZone` option doesn't
behave correctly under the project's Bun/JSC version — the whole
feature is blocked, since there is no third-party date lib to fall back
on. Recovery: validate `Intl` behavior in isolation first; if
unusable, escalate the dependency question before building the rest.

## References

- `src/transcript-worker.ts` ~ln 92-99 — the docstring that says the worker "doesn't parse the reset clock"; this epic reverses it.
- Schema is currently **v38** (`src/db.ts:60`); this epic adds **v39**. The CLAUDE.md prose pin says v37 and is stale.
- `fn-646` (overlap) — keeper CLI OpenTUI port, task .3 is mid-cutover on `cli/usage.ts`, the same renderer file task .3 here edits. Serialize to avoid a merge conflict; if fn-646 relocates the file, follow it.
- `fn-648` (overlap) — git rm/mv deletion attribution: owns a concurrent `src/db.ts` `migrate()` schema bump and `src/reducer.ts` edits. Coordinate the schema-version number (claim the next free version at implementation time; rebase if taken).
- `fn-650` (overlap) — autopilot pluggable exec backends: a third writer to the same `migrate()` slot. Same schema-version coordination.

## Docs gaps

- **CLAUDE.md** (3 sites): the schema-version pin (v37→v39 after this lands), the rate-limit fan-out column-set prose (add `last_rate_limit_resets_at` everywhere the `last_rate_limit_at` pair is named), and the v35 carve-out list in `projectUsageRow`.
- **README.md** `## Architecture`: a new "As of schema v39" sentence + the `usage` collection description block.
- **cli/usage.ts**: file-header JSDoc + the `HELP` string (the rate-limit annotation now renders a lift countdown, not a fired-time).
- **src/transcript-worker.ts**: the `ApiErrorMessage` JSDoc (~ln 92-99) — the "doesn't parse the reset clock" note becomes false.
- **src/reducer.ts**: inline fan-out comments naming the written columns.

## Best practices

- **Parse in the daemon, not the hook** — the hook has a strict no-third-party-deps rule and a 1.5s timeout; the Intl-based parser is daemon-only.
- **Use `Intl.DateTimeFormat` with `hourCycle: 'h23'` (not `hour12: false`)** — the latter has a V8/JSC midnight=24 bug. Use the `en-CA` locale for unambiguous `formatToParts` ordering.
- **Two-pass inverse-Intl for wall-clock→epoch** — never snapshot a fixed UTC offset; the two-pass method lets ICU resolve DST correctly. For "next occurrence", increment the calendar day by 1 and recompute — never add 86_400_000 (wrong on DST-transition days).
- **Do NOT use Temporal** — Bun's JSC implementation is incomplete.
