## Description

**Size:** M
**Files:** src/db.ts, src/usage-worker.ts, src/reducer.ts, src/collections.ts, scripts/usage.ts, test/usage-worker.test.ts

### Approach

Project three new agentuse envelope axes onto the `usage` row and surface
them in the usage TUI, mirroring the existing `sonnet_week` additive-column
pattern end-to-end. New nullable columns: `status TEXT`,
`subscription_active INTEGER` (1/0/NULL), `error_type TEXT`,
`error_message TEXT`, `error_at TEXT` (ISO-8601). The freshness field
`last_failed_fetch_at` joins the existing read-and-discard exclusion set —
never projected.

Pipeline:
- **db.ts** — add the five columns to the `CREATE_USAGE` literal AND via
  `addColumnIfMissing` in a NEW v37→v38 migrate slot (placed after the v37
  `dead_letters` comment block, before the `schema_version` stamp INSERT);
  bump `SCHEMA_VERSION` 37→38. No data backfill — columns are NULL on
  pre-v38 rows and repopulated by the next `UsageSnapshot` fold (cite this
  in the slot comment, like the v35 rate-limit columns did).
- **usage-worker.ts** — extend `UsageSnapshotMessage`, `buildUsageMessage`
  (PRESERVE slot order — the change-gate compares serialized output), and
  `seedFromDb`'s reconstruction. `subscription_active` carried as
  `boolean | null` in the message. Parse `error` sub-object's
  `type`/`message`/`at` into `error_type`/`error_message`/`error_at`.
- **reducer.ts** — extend `UsageSnapshotPayload`, `extractUsageSnapshot`
  (coerce subscription_active boolean→1/0/null), and `projectUsageRow`'s
  INSERT + `ON CONFLICT DO UPDATE` clause. Do NOT touch the v35 rate-limit
  reverse-fan-out carve-out below the UPSERT.
- **collections.ts** — add the five columns to `USAGE_DESCRIPTOR.columns`
  (the wire shape) and update the freshness-excluded docstring.
- **scripts/usage.ts** — renderer treatment (below).

Renderer treatment in `renderRowLines`:
- **subscription_active gates visibility:** filter rows where the value is
  `0`/`false` OUT of the render; keep `1`/`true` and `null` (codex).
- **status:** trailing token on the existing header/chip line, e.g.
  `(multi-claude-3) [claude 20x]  stale`. Shown for all three values.
- **error:** a NEW indented body line, rendered only when `error_type` is
  present (implies stale). Mirror the `renderRateLimit` idiom. Content
  `<type>: <message…>` truncated/padded to the bar+pct column width
  (`BAR_WIDTH + 2 + 1 + wPct`) so the relative-time tail lands in the SAME
  column as the reset stamps. `error_at` rendered via `relTime(iso, nowMs)`
  — the ISO variant, identical technique to the reset stamps, ticking on
  the 30s clock. Add `error` to the label pool when any visible row will
  render it.
- **usageRowsHashKey:** add `status`, `subscription_active`, `error_type`,
  `error_message`, `error_at`.

**error_at change-gate exclusion (the one novel wrinkle).** `error.at`
advances on every failed scrape (~90s during an outage); including it in
the worker change-gate would churn a synthetic `UsageSnapshot` every cycle
— exactly what the freshness-exclusion discipline forbids. So `error_at` is
the FIRST field that is PROJECTED but EXCLUDED from the worker change-gate.
Introduce a `usageGateKey(msg)` helper that serializes the message MINUS
`error_at`; both `UsageScanner.onChange` and `seedFromDb` use it for the
gate value, while `onSnapshot` still posts the FULL message (with
error_at). Net semantics: "stale since <first occurrence of this error>" —
the stamp holds while status/type/message are unchanged, and re-stamps on a
status flip or a different error. Recovery (stale→active) clears the
error_* columns because `status` IS in the gate. The renderer-side
`usageRowsHashKey` may include error_at safely (it only moves when the
gated fields move).

### Investigation targets

**Required** (read before coding):
- `scripts/usage.ts:250-368` — `renderRowLines`; header at 351-357,
  `renderBody`/`renderRateLimit` at 332-348, label pool at 326-329,
  `wPct`/`indent` at 308-331.
- `scripts/usage.ts:585-600` — `usageRowsHashKey` (the worker-stream gate).
- `src/usage-worker.ts:91-122` — `UsageSnapshotMessage`; `:243-289`
  `buildUsageMessage` (slot order load-bearing); `:516-550` `seedFromDb`;
  `:417-423` the `onChange` change-gate (replace `JSON.stringify(msg)` with
  `usageGateKey`).
- `src/reducer.ts:1978-2036` — `UsageSnapshotPayload` + `extractUsageSnapshot`;
  `:2063-2102` `projectUsageRow` INSERT/ON CONFLICT (rate-limit carve-out at
  2103+ stays untouched).
- `src/db.ts:603-617` — `CREATE_USAGE` literal; `:3621-3648` the v37
  `dead_letters` slot (insert v37→v38 slot after it, before the ~3649
  schema_version stamp); `:60` `SCHEMA_VERSION = 37`.
- `src/collections.ts:387-414` — `USAGE_DESCRIPTOR` columns + freshness docstring.
- `test/usage-worker.test.ts:60-81` — `envelopeBody` fixture; `:194-252`
  freshness tripwire; seed-roundtrip test ~507.
- `../agentuse/README.md` — the client-facing data-format contract
  (status/subscription_active/error shapes + the decision matrix).

## Acceptance

- [ ] schema v38 adds status/subscription_active/error_type/error_message/error_at to `usage`; CREATE_USAGE literal + addColumnIfMissing slot in lockstep; SCHEMA_VERSION=38; no data backfill
- [ ] usage-worker carries the five fields through buildUsageMessage + seedFromDb; error_at excluded from the gate via usageGateKey; last_failed_fetch_at never projected
- [ ] reducer extractUsageSnapshot + projectUsageRow fold the five columns; v35 rate-limit reverse fan-out carve-out unchanged
- [ ] USAGE_DESCRIPTOR.columns exposes the five columns on the wire
- [ ] scripts/usage.ts: subscription_active=false rows hidden; status token on header; stale error line with error_at via relTime in the reset column; usageRowsHashKey includes the new fields
- [ ] tests: new fields carried; error_at gate-exclusion (two envelopes differing only in error.at → ONE emit); last_failed_fetch_at excluded; seed roundtrip suppresses re-emit; renderer hides no-sub rows + shows status + stale error line
- [ ] turbo lint + typecheck + bun test green

## Done summary

## Evidence
