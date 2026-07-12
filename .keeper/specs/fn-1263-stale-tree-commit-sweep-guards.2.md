## Description

**Size:** M
**Files:** src/await-conditions.ts, src/daemon.ts, src/reducer.ts, src/dispatch-failure-key.ts, docs/adr/0049-shared-checkout-jam-promotion-and-repair-retry.md, CLAUDE.md, CONTEXT.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/keeper/skills/await/SKILL.md, plugins/keeper/skills/watch/SKILL.md, test/daemon.test.ts, test/await-conditions.test.ts, test/reducer-projections.test.ts

### Approach

The `shared-checkout-dirty` / `shared-checkout-desync` distress rows (synthetic `daemon` verb,
per-repo ids `shared-checkout-{dirty,desync}:<repoDirHash>`, minted by
`mintSharedCheckoutDistress` in src/daemon.ts after a sustained 5-minute grace, level-cleared
by their live producers) are today advisory: visible on the board but paging no one and
gating nothing. They sat ignorable for 3+ hours before a desynced-checkout commit mass-reverted
landed work. Promote them to operator jams in three moves:

1. **Jam classification.** Widen `isJamReason` (src/await-conditions.ts) to also match rows
whose reason STARTS WITH `SHARED_DIRTY_DISTRESS_REASON` or `SHARED_DESYNC_DISTRESS_REASON`
(constants exported by src/dispatch-failure-key.ts; the minted reasons are long sentences
beginning with those tokens — exact-match cannot work; mirror the existing merge-escalation
startsWith arm). This auto-surfaces the rows through src/needs-human.ts (isJam bit + jamCount)
and the await/watch alarm surfaces. AUDIT REQUIREMENT: the widening must only SURFACE — verify
and test that no escalation-cap accounting, readiness gate, or dispatch decision consumes
`isJamReason` in a way the promotion would perturb.

2. **Page-once sweep.** A NEW sweep in main (src/daemon.ts), riding the existing 60s
repair-escalation heartbeat and its gating (autopilot wanted, not paused): for each OPEN
dispatch_failures row with verb `daemon` and an id starting `shared-checkout-dirty:` or
`shared-checkout-desync:` where `human_notified_at IS NULL`, page via
`Bun.spawn(["botctl","send-message","--topic",KEEPER_TOPIC,<body>])` mirroring
`notifyHumanOfRepair`'s outcome contract: a successful send mints a NEW synthetic
distress-notified event (choose a name that reads truthfully in a permanent event log — do
NOT reuse the merge-notified event for a checkout-hygiene page); its fold arm mirrors the
verb-parameterized `foldMergeHumanNotified` (`SET human_notified_at = event.ts WHERE verb = ?
AND id = ? AND human_notified_at IS NULL`). A failed send is non-terminal — the row re-sweeps
next heartbeat. No schema change: `human_notified_at` already exists table-wide, and
`foldDispatchFailed`'s UPSERT preserves it across reason churn. Page on ROW PRESENCE past the
producer's mint grace — the desync-propagation risk exists whether or not an epic finalize is
currently starving. The producer's level-clear DELETEs the row, resetting the once-marker: a
re-minted row after a fresh 5-minute grace pages again — intended (new incident episode; the
sustained grace bounds flapping). Event-sourcing invariants: the stamp round-trips through the
synthetic event, never a direct projection write; the fold reads only the event's ts/payload.

3. **The decision record and its doc surface.** New ADR
docs/adr/0049-shared-checkout-jam-promotion-and-repair-retry.md (verify 0049 is still the free
tail at authoring time; status Accepted, number PROVISIONAL until landed per the fan-in
renumber convention) recording the operator-recoverability contract for both sticky families:
(a) dirty/desync advisory-to-jam with page-once, their clear remaining EXCLUSIVELY the
producer level-trigger — never `retry_dispatch`; (b) the repair retry-widening (implemented by
the sibling task this task depends on), partially superseding ADR 0017's repair-exclusion
in-text (idiom: ADR 0048's supersession preamble). Cross-reference ADRs 0011/0016/0017/0039.
Doc edits, all forward-facing: the root CLAUDE.md autopilot line describing these stickies
(advisory framing becomes paging jam; keep `bun scripts/lint-claude-md.ts` green; AGENTS.md is
a symlink — edit CLAUDE.md itself); the src/dispatch-failure-key.ts comment blocks for both
families (the advisory framing flips, but "never retry_dispatch-clearable" REMAINS TRUE for
dirty/desync — keep that clause); the jam/needs-human enumerations in
plugins/keeper/skills/{autopilot,await,watch}/SKILL.md; and CONTEXT.md's "Operator jam" entry,
whose current "cannot self-clear" wording contradicts a row that level-clears once an operator
repairs the world — refine the definition to cover operator-action-required rows whose clear
is level-triggered on the repaired state.

### Investigation targets

*Verify before relying — cited by file + symbol; the repo moves, so re-locate with search.*

**Required (read before coding):**
- src/await-conditions.ts — `isJamReason` (the exclude-recover-then-OR shape to extend) and
  its `--fail-on-stuck` consumer.
- src/dispatch-failure-key.ts — `SHARED_DIRTY_DISTRESS_*` / `SHARED_DESYNC_DISTRESS_*`
  constant families and their comment blocks.
- src/daemon.ts — `mintSharedCheckoutDistress`, the repair-escalation heartbeat
  (`runRepairEscalationSweepTick` area), `notifyHumanOfRepair` (the page template), and the
  dirty tracker wiring (`buildSharedDirtyObservation`).
- src/reducer.ts — `foldMergeHumanNotified` (the verb-parameterized stamp to mirror) and
  `foldDispatchFailed`'s human_notified_at preservation.
- test/daemon.test.ts — `fakeRepairSweepDeps` / `runRepairEscalationSweep` fixtures (the
  sweep-test template) and `buildSharedDirtyObservation` fixtures.
- src/needs-human.ts — how isJamReason feeds isJam/jamCount (consumer audit).

**Optional:**
- docs/adr/0048-file-backed-agent-bus-messages.md — the partial-supersession preamble idiom.
- docs/adr/0011*, 0016*, 0017*, 0039* — the cross-referenced decisions.
- src/autopilot-worker.ts — the desync producer and content-probe clear (context only; no
  edits there).

### Risks

- The sweep must not page while autopilot is paused or during boot catch-up — inherit the
  heartbeat's existing gating rather than adding new conditions.
- A new fold arm joins the deterministic-replay class: no wall-clock, no env, no liveness
  reads inside the fold; schema defaults must match the zero-event projection (no schema
  change expected).
- fn-1252.6 (paused epic) also writes src/reducer.ts with a schema step; this task adds ONLY
  a fold arm and no `SCHEMA_STEPS` entry, so no ladder collision — keep it that way.

### Test notes

Sweep tests via the fake-sweep-deps template: one page per row identity; notify_failed
re-sweeps and pages again; a cleared-then-reminted row pages anew; no page while paused.
isJamReason widening in test/await-conditions.test.ts (both families, startsWith on the long
minted sentence, recover-prefix exclusion untouched). Fold arm determinism + idempotence in
test/reducer-projections.test.ts (stamp once, second event no-ops, reason churn preserves the
marker). retryUntil for anything async; sandboxEnv; no real daemon/botctl (inject/record the
spawn seam).

## Acceptance

- [ ] A shared-checkout-dirty or -desync row registers as an operator jam and needs-human
  signal, and the human is paged exactly once per row instance via botctl; a failed notify
  re-attempts on the next sweep; a cleared-then-reminted row pages again.
- [ ] The notified stamp round-trips through a new synthetic event folded deterministically
  and idempotently; no direct projection write; no schema change; re-fold reproduces the
  stamp.
- [ ] The jam widening only surfaces: an audit (recorded in the ADR or task evidence) plus
  tests confirm no escalation-cap, readiness, or dispatch behavior changes from the
  promotion.
- [ ] ADR 0049 records both the promotion (dirty/desync clear stays producer-level-trigger
  only) and the repair retry-widening with the ADR 0017 partial supersession; CLAUDE.md, the
  dispatch-failure-key comments, the three keeper skill enumerations, and CONTEXT.md's
  Operator-jam entry tell that one consistent story; `bun scripts/lint-claude-md.ts` passes.
- [ ] Fast suite green.

## Done summary

## Evidence
