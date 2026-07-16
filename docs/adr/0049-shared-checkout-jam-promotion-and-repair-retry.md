# 0049 — Shared-checkout hygiene jam promotion and repair-row retry recoverability

## Status

Accepted (number PROVISIONAL until landed; fan-in renumber per ADR 0020/0022). Partially
supersedes [ADR 0017](0017-trunk-repair-escalation-and-role-keyed-guard.md): its
`repair::<repo>` escalation ended at a single human page on decline, leaving the sticky
`dispatch_failures` row stranded until a manual DB edit — this decision makes that row
operator-recoverable over the `retry_dispatch` wire. The rest of ADR 0017 stands. Builds on
[ADR 0011](0011-gated-dispatch-failures-snapshot-fold.md) (the operator-jam class the
needs-human surfaces alarm on) and [ADR 0016](0016-stale-aware-shared-checkout-catchup.md)
(the board-visible shared-checkout-desync signal this promotes). The fan-in re-arm precedent
is [ADR 0039](0039-work-verb-merge-conflict-escalation.md).

## Context

A commit made from a shared MAIN checkout whose index/worktree trailed landed history swept
~96 paths (~12.9k lines) of landed work back to stale content alongside its one intended
file; green suites could not catch it because the tests reverted in the same sweep. Two
per-repo distress rows (the `daemon` verb, ids `shared-checkout-{dirty,desync}:<repoDirHash>`,
minted after grace and level-cleared exclusively by their live producers once the checkout is
observed clean) would have named the hazard but were live for 3+ hours first:

- **`shared-checkout-dirty`** — a shared checkout stays dirty past grace, the surface a
  write-capable `repair::<repo>` session defers on because it cannot launch into a dirty tree.
- **`shared-checkout-desync`** — the ref advanced (a plumbing base→default merge landed) but
  the working tree never caught up, so everything served off it (selector policy, skills,
  worker templates, daemon source at next boot) silently trails landed history.

Both were **advisory**: rendered on the board but paging nobody and gating nothing — a latent
incident, since a desynced checkout is exactly what makes a mass-reversion commit possible.
Separately, a dead `repair::<repo-token>` session left its sticky row stranded: the
`retry_dispatch` wire accepted only `work|close|approve`, so an operator who fixed the base by
hand had no board verb to clear the row and re-arm the route.

## Decision

- **Promote the two families to operator jams.** `isJamReason` (the single jam vocabulary
  behind the needs-human `isJam`/`jamCount` and `await drained --fail-on-stuck`) also matches a
  reason that STARTS WITH the `shared-checkout-dirty` / `shared-checkout-desync` token (the
  minted reasons are long sentences). The promotion **only surfaces** — no escalation-cap,
  readiness, or dispatch consumer reads the jam class (verified by audit + test); the
  `worktree-recover*` exclusion is untouched and prefix-disjoint.
- **Page once per row instance.** A page-once sweep rides the 60s repair-escalation heartbeat
  and its gating (autopilot wanted, not paused): each OPEN row with `human_notified_at IS NULL`
  gets ONE agentbot page, then the once-marker is stamped through a new
  `SharedCheckoutHumanNotified` event whose fold mirrors the verb-parameterized human-notify
  latch (stamp on terminal `notified`, gated `IS NULL`; a `notify_failed` re-sweeps). The stamp
  round-trips through the event and the fold reads only payload + `event.ts`, so re-fold
  reproduces it. Pages on ROW PRESENCE past grace — the desync-propagation risk exists whether
  or not a finalize is currently starving.
- **The dirty/desync clear stays EXCLUSIVELY the producer level-trigger — never
  `retry_dispatch`.** The producer DELETEs the row on observed-clean, re-arming the marker at
  NULL: a re-minted row after a fresh grace pages again (a new incident episode). The world,
  not an ack, decides whether the checkout is reconciled.
- **The repair row becomes retry-recoverable.** `repair` joins the `retry_dispatch` verb set,
  so `keeper autopilot retry repair::<repo-token>` clears a stranded `SHARED_BASE_BROKEN` row
  and re-arms the route after an operator fixes the base. The deliberate asymmetry: a repair row
  records a DISPATCH that declined/died (an ack re-arms it), a dirty/desync row records a WORLD
  STATE (only observing the world clean clears it).

## Consequences

- A desynced or dirty shared checkout can no longer sit ignorable for hours before a
  mass-reversion commit lands; both now count toward the needs-human jam total and page once.
- `CONTEXT.md`'s operator-jam definition widens: the class covers rows whose clear is a producer
  level-trigger on the repaired world, not only `retry_dispatch`-cleared rows — the unifying
  property is "cannot self-clear without operator action".
- No schema change: `human_notified_at` already exists table-wide and the `DispatchFailed`
  UPSERT preserves it across reason churn; the new fold arm adds only a deterministic-replay
  event type, no `SCHEMA_STEPS` entry.
- One consistent recovery story across root `CLAUDE.md`, the `dispatch-failure-key` comments,
  `CONTEXT.md`, and the autopilot/await/watch skill enumerations: dirty/desync
  page-and-wait-for-clean, repair page-and-retry. The epic's `docs/problem-codes.md` catalog
  (owned by sibling tasks) carries the same two recoveries.
