## Description

**Size:** S
**Files:** src/server-worker.ts, test/collections.test.ts

### Approach

Make subscribe page ordering total and stable: the page query tie-break hardcodes `descriptor.pk` as the final `ORDER BY` key, so two rows sharing `(sort-column value, wire pk)` can shuffle between refetches — for composite-PK collections and for `dispatch_failures` today. Replace the bare `descriptor.pk` tie-break with the descriptor's composite live-key SQL expression (`liveKeyExpr(descriptor)`, already a trusted SQL-identifier constant) so the order is total and deterministic. This alters the `ORDER BY` for the already-working `dispatch_failures` collection too, so re-check and update any order-sensitive snapshot/assertion tests on the affected collections. Display-order only — no dropped-update semantics — which is why it is isolated from task 1.

### Investigation targets

*Verify before relying.*

**Required**:
- src/server-worker.ts:1459 — the page `ORDER BY` tie-break hardcoding `descriptor.pk`.
- src/collections.ts:1020 — `liveKeyExpr`: the trusted composite-key SQL expression to use as the tie-break (interpolate it directly; it is already a trusted identifier, not routed through the `sortable` allowlist).

**Optional**:
- test/collections.test.ts and any server/board snapshot tests asserting `dispatch_failures` / subagent row order.

### Risks

- Changing `dispatch_failures`' `ORDER BY` can break an order-sensitive snapshot on a currently-green collection. Grep for order-dependent assertions on these collections and update expectations to the new deterministic order.

### Test notes

Add a test asserting stable page order across two refetches for two rows sharing `(sortCol, pk)`. Fast tier.

## Acceptance

- [ ] The subscribe page query orders rows by a total, stable key (composite live-key tie-break), so two rows sharing sort-column value and wire `pk` have deterministic order across refetches.
- [ ] Page order for `dispatch_failures` and the three fixed collections is verified stable by a test; any pre-existing order-sensitive test is updated to the new deterministic order.
- [ ] `bun test` (fast tier) is green.

## Done summary
Replaced the subscribe page ORDER BY tie-break's bare descriptor.pk with liveKeyExpr(descriptor), giving a total stable order for composite-PK collections and dispatch_failures; added coverage across all four collections for stable tied-order across refetches.
## Evidence
