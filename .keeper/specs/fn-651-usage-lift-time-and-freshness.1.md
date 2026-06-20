## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts (or the nearest UsageSnapshot serialization test)

### Approach

Standalone prerequisite bug fix (diagnosed in the
`debug-keeper-usage-percentages` session, never applied). The
worker→event serializer for `UsageSnapshot` in `src/daemon.ts` (~ln
1218) serializes only a subset of the worker-message fields and DROPS
the fn-645 additions, so those `usage` columns are NULL on every fold:
`mc1` (no subscription) is never redacted (the `subscription_active !=
0` filter in `cli/usage.ts` always passes) and the `status` chip never
renders.

Add the missing fields to the serialized event payload so it forwards
everything the worker message carries and the schema columns already
hold:

```
sonnet_week_resets_at, status, subscription_active,
error_type, error_message, error_at
```

Pure, deterministic, NO schema bump (all columns already exist as of
v38). Old events without these fields fold to NULL safely. After
landing, a daemon bounce + boot re-scan repopulates the columns.

This task deliberately does NOT add `lift_at` / `last_usage_fold_at`
(those land in task .4, which extends this same serializer) — keep this
a minimal, immediately-shippable correctness fix.

### Investigation targets

**Required** (verify line numbers against the live source):
- src/daemon.ts ~ln 1218 — the `UsageSnapshot` event serializer (the leak).
- src/reducer.ts ~ln 2031-2200 — `parseUsageSnapshot`, confirming the reducer already reads these fields (they only arrive NULL today).
- cli/usage.ts ~ln 275 — the `subscription_active !== 0` redaction filter that's currently always-true.

### Risks

- Confirm the worker message actually carries all six fields before forwarding (it does per fn-645) — forwarding a field the worker never sets would write NULL anyway (harmless, but verify).
- Pure serialization change; no migration, no fan-out. Low risk.

### Test notes

A `UsageSnapshot` worker message carrying the fn-645 fields produces an
event whose folded `usage` row has non-NULL `status` /
`subscription_active` / `error_*`; a no-subscription envelope folds to
`subscription_active = 0` (so the renderer redacts it).

## Acceptance

- [ ] `src/daemon.ts` forwards `sonnet_week_resets_at`, `status`, `subscription_active`, `error_type`, `error_message`, `error_at` in the `UsageSnapshot` event payload.
- [ ] After a fold, those `usage` columns are non-NULL; a no-subscription profile folds `subscription_active = 0` and is redacted by `cli/usage.ts`; the status chip renders.
- [ ] No schema bump; old events fold to NULL without error.

## Done summary
Extract UsageSnapshot serializer as exported serializeUsageSnapshot and forward the fn-645 freshness fields (status / subscription_active / error_type / error_message / error_at) plus sonnet_week_resets_at — the inline JSON.stringify previously dropped them, so those usage columns folded NULL forever. End-to-end fold + backwards-compat tests in test/daemon.test.ts pin the wire shape.
## Evidence
