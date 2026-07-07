## Description

**Size:** M
**Files:** src/collections.ts, src/readiness-client.ts, test/collections.test.ts, test/readiness-client.test.ts

### Approach

Serve pinned epics as a new narrow collection and merge them into the readiness
input so downstream consumers get real verdicts with zero bespoke render logic.
Contract: (1) a `CollectionDescriptor` over the epics table — mirror the epics
descriptor's columns/pk/version/sortable/jsonColumns — whose `defaultClause` is a
correlated EXISTS over dispatch_failures restricted to `verb IN ('close','work')`,
matching the bare epic-id close key, the `worktree-finalize:<epic>-` and
`worktree-recover:<epic>-` prefixed close forms, and `<epic>.<n>` work task keys.
The clause is a STRICT SUPERSET of the true pinned set (SQL over-selects; the
TypeScript failure-key vocabulary decides), total (no NULL-id blowup), with NO page
limit and NO recencyBound — a pin nags until cleared and the set is bounded by the
dispatch_failures table. A `daemon`-verb row embedding an epic id (stale-base-lane)
must NOT match. (2) An opt-in flag on SubscribeOptions (suggested
`includePinnedEpics`) following the gated recipe: null-guarded state, first-paint
gate joined only when opted in, spread-when-present snapshot member carrying the
pinned rows. (3) An open-wins merge of pinned rows into the typed epics set that
feeds computeReadiness — same shape as the recent-done overlay merge — so a pinned
closed epic flows through the ordinary verdict path; the snapshot member remains the
pinned-identity signal for consumers. Un-opted behavior is byte-identical.

### Investigation targets

*Verify before relying — these refs were planner-verified but fn-1172.3 is actively
editing these files; re-read before editing.*

**Required** (read before coding):
- src/collections.ts:354-384 — the narrow-collection descriptor template (columns
  mirroring, defaultClause not inheriting default_visible, no-LIMIT rationale); note
  fn-1172 may have removed it — recover the shape from git history if gone, and
  model the gating on the SURVIVING dispatch_failures opt-in instead
- src/collections.ts:984-989 — REGISTRY map (add the new descriptor)
- src/readiness-client.ts:1520-1534, 1761-1806, 1848-1851, 2035-2078 — the full
  gated opt-in recipe: SubscribeOptions flag, null-guarded makeState, first-paint
  gate clause, snapshot projection + spread-when-present member
- src/readiness-client.ts:1860-1874 — the recent-done open-wins merge into the
  typed epics set (the merge to mirror for readiness input)
- src/dispatch-failure-key.ts — the key vocabulary the SQL superset must cover
  (WORKTREE_CLOSE_KEY_PREFIXES, stale-base-lane id shape to EXCLUDE)
- src/server-worker.ts:1151-1223 — resolveFilter: how defaultClause.sql is spliced
  (single-table FROM; correlated subquery is expressible)

**Optional** (reference as needed):
- docs/adr/0018-pinned-epic-board-collection.md — the decision record
- docs/adr/0011-gated-dispatch-failures-snapshot-fold.md — the gated recipe ADR

### Risks

- computeReadiness over closed epics: the status path already merges recent-done
  epics through it, but verify no arm assumes open status; if it misbehaves, stop
  and surface (the epic's Early proof point names the fallback)
- Over-selection breadth: a LIKE-based clause that under-selects breaks the strict-
  superset invariant (client cannot add epics SQL missed) — test each key form
- fn-1172.3 edits the same two src files — rebase carefully; line refs will drift

### Test notes

Clone the existing patterns: descriptor-resolution + defaultClause assertions in
test/collections.test.ts (each membership form: bare close, worktree-finalize:,
worktree-recover:, work task key; the daemon-verb exclusion; NULL-id totality);
the OFF/ON opt-in contract pair in test/readiness-client.test.ts (OFF: no
subscription, member absent, frames byte-identical; ON: gated first paint, rows
carried, open-wins dedup — an epic both open and pinned appears once).

## Acceptance

- [ ] The new collection resolves by name and serves every epic keyed by a live
      close/work failure row in any status: bare close key, worktree-finalize and
      worktree-recover prefixed keys, and work task keys all pin their epic; a
      daemon-verb row pins nothing
- [ ] Opted-in readiness snapshots carry the pinned rows as a distinct member AND
      include pinned epics in the typed epics set with real readiness verdicts;
      an epic both open and pinned appears exactly once (open wins)
- [ ] Un-opted subscriptions are byte-identical to before (no subscription opened,
      no snapshot member, first-paint gate unchanged)
- [ ] Full fast suite green (bun test)

## Done summary

## Evidence
