/**
 * The ONE source of the `dispatch_failures` worktree VOCABULARY plus a typed,
 * semantics-PRESERVING router over a failure row's identity `(verb, id, reason,
 * dir)`. Dep-free leaf: imports NOTHING (no `bun:sqlite`, no node IO, no clock),
 * so `daemon.ts`, `autopilot-worker.ts`, `await-conditions.ts`, and
 * `dispatch-failure-pill.ts` each pull it in without dragging the reconcile core.
 *
 * It ROUTES, it never normalizes — each routing arm keeps its OWN exact match
 * semantic: the finalize decision stays on the ID prefix (not the reason), the
 * recover decision stays a reason prefix, and the merge-escalation decision stays
 * an exact leading-reason-token match (a `worktree-merge` prefix must never
 * escalate). The literal-kind union plus the {@link assertNever} tripwire make an
 * added variant break compilation of every unhandled consuming switch — the
 * substring-drift this module exists to kill.
 */

// ── Vocabulary — the single source every consumer shares ───────────────────

/**
 * The EXACT leading reason token a stuck worktree fan-in close mints (the
 * close-sink pre-merge content conflict — `worktree-merge-conflict: merging
 * <source> into <base> — <stderr>`). The escalation gate matches the leading
 * token (text up to the first `:`, trimmed) against this EXACTLY — never a
 * `worktree-merge` prefix — so `worktree-merge-lock-timeout` /
 * `worktree-merge-local-timeout` and the `worktree-finalize-*` / `worktree-recover*`
 * siblings never escalate.
 */
export const MERGE_ESCALATION_REASON_TOKEN = "worktree-merge-conflict";

/**
 * The EXACT leading reason token a WITHHELD close mints when the epic's latest close
 * receipt is a still-current `fatal_halt` audit verdict (`fatal-audit: <bounded finding
 * excerpt>`). The row lands on the TYPED SYNTHETIC id `close::fatal-audit:<epic>` (see
 * {@link FATAL_AUDIT_ID_PREFIX}) — never the bare `close::<epic>` key — so it can never
 * alias, overwrite, or be overwritten by an ordinary close failure (merge/finalize/launch)
 * on that PK. It routes {@link routeDispatchFailure} `close-plain` (a `fatal-audit`
 * leading token, distinct from every close arm). A PAGING operator jam (in {@link
 * isJamReason}): a fatal audit finding is operator-attention-worthy, so it surfaces
 * through needs-human and pages once.
 */
export const FATAL_AUDIT_REASON_TOKEN = "fatal-audit";

/**
 * The `dispatch_failures.id` PREFIX every fatal-audit row carries — `fatal-audit:<epic>`,
 * verb `close`. A TYPED synthetic id (the {@link WORKTREE_PRECLOSE_ID_PREFIX} /
 * `origin-containment-stuck:` precedent), so the family is REASON-DISJOINT by construction
 * from the bare `close::<epic>` key: mint / clear / page all target this distinct PK, and
 * the close WITHHOLD derives explicitly from the receipt/open-row state, never from a row's
 * existence on the natural close key. Board mapping strips it via {@link
 * WORKTREE_CLOSE_KEY_PREFIXES}. `retry_dispatch close::fatal-audit:<epic>` clears the row
 * (the id-half colon is an accepted dispatch-id token).
 */
export const FATAL_AUDIT_ID_PREFIX = "fatal-audit:";

/** Build the synthetic fatal-audit `dispatch_failures.id` for an epic. */
export function fatalAuditDispatchId(epicId: string): string {
  return `${FATAL_AUDIT_ID_PREFIX}${epicId}`;
}

/** The epic id behind a fatal-audit synthetic `dispatch_failures.id`, or null when the
 *  id does not carry the prefix. Inverse of {@link fatalAuditDispatchId}. */
export function epicIdFromFatalAuditId(id: string): string | null {
  return id.startsWith(FATAL_AUDIT_ID_PREFIX)
    ? id.slice(FATAL_AUDIT_ID_PREFIX.length)
    : null;
}

/**
 * Whether a `dispatch_failures.reason` is a withheld-close fatal-audit verdict — the
 * EXACT leading-token gate ({@link FATAL_AUDIT_REASON_TOKEN}). Scopes the reconciler's
 * positive-evidence level-clear + the needs-human / page surfaces to fatal-audit rows.
 * Pure; a null/colon-less/non-matching reason yields false.
 */
export function isFatalAuditReason(reason: string): boolean {
  return leadingReasonToken(reason) === FATAL_AUDIT_REASON_TOKEN;
}

/**
 * The `reason` a block incident carries on its `('block', task_id)`
 * `dispatch_failures` row — the collapsed home of the retired `block_escalations`
 * latch. A block incident is keyed off the `block` verb (never `work` / `close`),
 * so this reason is inert to {@link routeDispatchFailure} (its `unknown` arm) and
 * to the pill join ({@link resolveFailureTarget} drops a `block` row), and the
 * needs-human projector counts a `block` row under `blockEscalations`, never
 * `stuckDispatches`. The reason exists only to satisfy the NOT-NULL column and to
 * read distinctly in the incident brief. NOT a `blocked:` surface-and-stop
 * `work::` reason ({@link BLOCKED_WORK_REASON_PREFIX}) — a different row entirely.
 * The db migration seed hardcodes this literal (db.ts cannot import this leaf).
 */
export const BLOCK_INCIDENT_REASON = "block-incident";

/**
 * The `reason` prefix every `recoverWorktrees` failure carries
 * (`worktree-recover-conflict`, `-push-failed`, `-not-on-default`, …). The
 * level-triggered auto-clear keys on it to scope clearing to RECOVER-originated
 * `dispatch_failures` rows ONLY: a normal close-sink failure
 * (`finalizeEpic`'s `worktree-finalize-*`) can share the same `close::<epicId>`
 * key, and clearing that one would silently dismiss a legitimate block.
 */
export const WORKTREE_RECOVER_REASON_PREFIX = "worktree-recover";

/**
 * The `dispatch_failures.id` prefix every recover close-row KEY carries
 * (`worktree-recover:<epicId>-<repoHash>` epic-tied, or `worktree-recover:<slug>`
 * for the null-epic dir-slug form). Distinct from
 * {@link WORKTREE_RECOVER_REASON_PREFIX} (the reason marker, no colon).
 */
export const WORKTREE_RECOVER_KEY_PREFIX = "worktree-recover:";

/**
 * The `dispatch_failures.id` prefix every PER-REPO finalize close-row key carries
 * (`worktree-finalize:<epicId>-<repoHash>`). The finalize level-clear scopes the
 * OPEN finalize-failure set on it — matched on the ID, NOT the reason — so a
 * clear never dismisses a recover row or the epic-keyed provision fan-in conflict.
 */
export const WORKTREE_FINALIZE_ID_PREFIX = "worktree-finalize:";

/**
 * The `dispatch_failures.id` prefix every PER-REPO pre-close STRUCTURAL fence row
 * carries (`worktree-preclose:<epicId>-<repoHash>`). A pre-close structural failure
 * (a wrong-branch worktree, a failed `worktree add`, a non-content merge failure)
 * mints it as a DURABLE visible close-plain row DISTINCT from the merge-conflict
 * incident on the bare `close::<epic>` key. The pre-close level-clear scopes its OPEN
 * fence set on this ID prefix — cleared on the SAME (epic, repo)'s clean assembly (or
 * content conflict) this cycle, so a self-healed structural failure never strands a row
 * jamming the close's final drain; `retry_dispatch` also clears it.
 */
export const WORKTREE_PRECLOSE_ID_PREFIX = "worktree-preclose:";

/**
 * The origin-ahead non-fast-forward finalize reason — an operator jam (origin
 * moved ahead; a push would be rejected non-fast-forward, and the reconciler
 * never fetch/rebase/force). Its close row keys on {@link
 * WORKTREE_FINALIZE_ID_PREFIX}.
 */
export const WORKTREE_FINALIZE_NON_FF_REASON =
  "worktree-finalize-non-fast-forward";

/**
 * The merge-suite-gate finalize reason — an operator jam minted when the fast
 * suite fails against the PROSPECTIVE lane→default merge result (a semantic merge
 * conflict git cannot see: two individually-green sides whose merged tree breaks
 * the suite). Local default never advanced and nothing pushed, so it is NOT a
 * transient environment skip: it needs an operator to reconcile the conflict, then
 * `retry_dispatch` to re-arm. Visible non-retry sticky, keyed on {@link
 * WORKTREE_FINALIZE_ID_PREFIX} exactly like the non-ff arm. Prefix-disjoint from
 * every existing family: `worktree-finalize-suite-red` shares the `worktree-finalize-`
 * stem with `-non-fast-forward` / `-conflict` but diverges at `-s`, so it is neither
 * a prefix of them nor they of it.
 */
export const WORKTREE_FINALIZE_SUITE_RED_REASON = "worktree-finalize-suite-red";

/**
 * Worktree-mode close keys prefix the epic (or a path slug) with one of these,
 * stripped by `resolveFailureTarget` before the epic-id join.
 */
export const WORKTREE_CLOSE_KEY_PREFIXES = [
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
  FATAL_AUDIT_ID_PREFIX,
] as const;

/**
 * The `reason` prefix the reconciler mints when it AUTO-RECLAIMS a slot held by a
 * provably-dead stopped session — one whose pane's foreground command is the bare
 * `exec $SHELL -l -i` tail AND whose grace age elapsed. It kills the dead pane and
 * mints this visible `DispatchFailed` on the wedged key `(verb, id)`, level-cleared
 * the cycle the occupant is gone. Verb-NEUTRAL: the row's `verb` (`work`/`close`)
 * carries the board target, so one prefix covers a reaped worker or closer alike.
 * The row lands on the NATURAL key, so the auto-clear is scoped by reason (never a
 * genuine `close::<epic>` conflict) — {@link isSlotOccupancyReason}.
 */
export const SLOT_RECLAIMED_REASON_PREFIX = "slot-reclaimed";

/**
 * The `reason` prefix the reconciler mints when a stopped-but-LIVE session holds a
 * slot it cannot PROVE dead — a possibly-resumable pane whose foreground is still
 * `claude`, or a bare shell still inside the grace window. Visibility ONLY, never a
 * kill ("when in doubt, surface, do not reclaim"). Level-cleared the cycle the
 * stopped-live occupant is gone (its pane died or it resumed to `working`).
 */
export const SLOT_OCCUPIED_REASON_PREFIX = "slot-occupied";

/**
 * The `dispatch_failures.reason` the instant-death circuit breaker mints when a
 * `(verb, id)` key's dispatched worker BINDS-then-dies within a sub-minute
 * lifetime {@link import("./reducer").INSTANT_DEATH_THRESHOLD} consecutive
 * times (the reducer-side sibling of the never-bound breaker — post-bind
 * lifetime is the cause-AGNOSTIC signal, no transcript parsing). The sticky
 * feeds the reconciler's `failedKeys` suppression exactly like every other
 * `dispatch_failures` row, pausing re-dispatch of that key until `retry_dispatch`
 * clears it. Cause-agnostic by design: a board-wide burst of these (multiple keys
 * tripping) is the likely session/quota-wall signal the board surfaces. Lands on
 * the NATURAL `(verb, id)` key, so the router short-circuits a `work` row to
 * `work-task` and a `close` row to its close family — no new route arm.
 * Collision-free: no existing reason is a prefix of it, nor it of them.
 */
export const INSTANT_DEATH_BREAKER_REASON = "instant-death-breaker";

/**
 * The natural-key sticky minted when a fired Dispatch attempt remains unbound
 * past the launch grace. The reason names the frozen tmux target and stays
 * cause-agnostic: the wrapper may be parked on an interactive gate or merely
 * slow. A late exact bind level-clears it; otherwise `retry_dispatch` is the
 * operator unstick. Natural `(verb, id)` keying makes the existing `failedKeys`
 * arm suppress another launch while the inspectable window stays open.
 */
export const PARKED_LAUNCH_REASON_PREFIX = "parked-launch";

export function isParkedLaunchReason(reason: string): boolean {
  return (
    reason === PARKED_LAUNCH_REASON_PREFIX ||
    reason.startsWith(`${PARKED_LAUNCH_REASON_PREFIX}:`)
  );
}

/**
 * The synthetic `(verb, id)` and `reason` prefix of the daemon CRASH-LOOP distress
 * signal — a self-restart storm made loud. Main appends each boot to a durable
 * restart ledger (a state-dir sidecar, NOT a fold) and, when the recent-boot rate
 * crosses the crash-loop threshold, mints ONE sticky `dispatch_failures` row on this
 * fixed key so the storm surfaces in `needs_human` instead of running invisible.
 *
 * The verb is DELIBERATELY neither `work` nor `close`: it routes as {@link
 * routeDispatchFailure}'s `unknown` arm, so it never enters the reconciler's
 * `failedKeys` suppression (no real dispatch key can collide with it) and is cleared
 * ONLY by main's level-triggered recovery (the boot whose rate falls back under
 * threshold), never a `retry_dispatch` — whose wire validator rejects the synthetic
 * verb, which is exactly why the boot un-retryable-orphan GC exempts this one key.
 * Idempotent by construction: the fold UPSERTs on `(verb, id)`, so a persistently-
 * looping daemon mints ONE row, not one per boot.
 */
export const CRASH_LOOP_DISTRESS_VERB = "daemon";
export const CRASH_LOOP_DISTRESS_ID = "crash-loop";
export const CRASH_LOOP_DISTRESS_REASON = "daemon-crash-loop";

export const REPEATED_NATIVE_CRASH_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const REPEATED_NATIVE_CRASH_DISTRESS_ID = "repeated-native-crash";
export const REPEATED_NATIVE_CRASH_DISTRESS_REASON = "repeated-native-crash";

export function isRepeatedNativeCrashDistressKey(
  verb: string,
  id: string,
): boolean {
  return (
    verb === REPEATED_NATIVE_CRASH_DISTRESS_VERB &&
    id === REPEATED_NATIVE_CRASH_DISTRESS_ID
  );
}

/**
 * The synthetic daemon distress signal that the agentbot paging channel itself is
 * unavailable. It is minted only for a spawn failure (not a non-zero agentbot
 * exit), then level-cleared by the next successful page. The fixed, un-retryable
 * key keeps the alarm visible without entering any real dispatch queue.
 */
export const PAGING_CHANNEL_DOWN_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const PAGING_CHANNEL_DOWN_DISTRESS_ID = "paging-channel-down";
export const PAGING_CHANNEL_DOWN_DISTRESS_REASON = "paging-channel-down";

/**
 * The fixed, producer-owned distress signal for an Agent Bus accept path that
 * stays dark while the critical READ server remains live. The serve-liveness
 * watchdog keeps the daemon up, mints this row once, and level-clears it only
 * after a later bus probe proves recovery. The synthetic daemon verb keeps it
 * outside dispatch suppression and the retry wire.
 */
export const BUS_DEGRADED_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const BUS_DEGRADED_DISTRESS_ID = "bus-degraded";
export const BUS_DEGRADED_DISTRESS_REASON = "bus-degraded";

export const EVENTS_INGEST_STALL_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const EVENTS_INGEST_STALL_DISTRESS_ID = "events-ingest-stalled";
export const EVENTS_INGEST_STALL_DISTRESS_REASON = "events-ingest-stalled";

/** True iff `(verb, id)` is the producer-owned bus-degraded distress key. */
export function isBusDegradedDistressKey(verb: string, id: string): boolean {
  return verb === BUS_DEGRADED_DISTRESS_VERB && id === BUS_DEGRADED_DISTRESS_ID;
}

export function isEventsIngestStallDistressKey(
  verb: string,
  id: string,
): boolean {
  return (
    verb === EVENTS_INGEST_STALL_DISTRESS_VERB &&
    id === EVENTS_INGEST_STALL_DISTRESS_ID
  );
}

/** True iff `(verb, id)` is the producer-owned paging-channel distress key. */
export function isPagingChannelDownDistressKey(
  verb: string,
  id: string,
): boolean {
  return (
    verb === PAGING_CHANNEL_DOWN_DISTRESS_VERB &&
    id === PAGING_CHANNEL_DOWN_DISTRESS_ID
  );
}

/**
 * The synthetic PER-REPO distress signal for a shared MAIN checkout stuck mid-merge
 * (MERGE_HEAD + unresolved paths) past the recover grace watermark — the escalation
 * layer ON TOP of the immediate per-epic `worktree-recover-mid-merge` /
 * `-abort-failed` reasons. Mirrors the crash-loop idiom: the synthetic {@link
 * CRASH_LOOP_DISTRESS_VERB} shares the un-retryable `daemon` verb (routes as {@link
 * routeDispatchFailure}'s `unknown` arm — never in `failedKeys`, never
 * `retry_dispatch`-clearable), and the boot orphan-GC + the recover level-clear both
 * EXEMPT it — but the `id` is per-repo (`shared-checkout-wedge:<repoHash>`) so two
 * checkouts on a multi-repo board wedge independently, one distress row each. Its
 * ONLY legitimate clear is the recover pass's level-trigger observing the checkout
 * clean (NOT `retry_dispatch`, NOT the `worktree-recover*` auto-clear — the `reason`
 * deliberately lives OUTSIDE {@link WORKTREE_RECOVER_REASON_PREFIX}). In-memory grace
 * tracking, so a daemon restart re-emits at most once per still-present wedge.
 */
export const SHARED_WEDGE_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const SHARED_WEDGE_DISTRESS_ID_PREFIX = "shared-checkout-wedge:";
export const SHARED_WEDGE_DISTRESS_REASON = "shared-checkout-wedge";

/**
 * True iff `(verb, id)` is a shared-checkout-wedge distress key — the synthetic
 * `daemon` verb plus the {@link SHARED_WEDGE_DISTRESS_ID_PREFIX} per-repo id. The
 * boot orphan-GC exempts it (like the crash-loop key) since the operator surface
 * never clears it; pure, dep-free, NEVER throws.
 */
export function isSharedWedgeDistressKey(verb: string, id: string): boolean {
  return (
    verb === SHARED_WEDGE_DISTRESS_VERB &&
    id.startsWith(SHARED_WEDGE_DISTRESS_ID_PREFIX)
  );
}

/**
 * The PER-REPO distress signal for a shared MAIN checkout that stays DIRTY — a
 * non-clean working tree with NO MERGE_HEAD — past the grace watermark. UNLIKE its
 * mid-merge {@link SHARED_WEDGE_DISTRESS_VERB} sibling (a neutered false positive the
 * boot orphan sweep DRAINS — a dirty/mid-merge checkout no longer blocks the
 * working-tree-free base merge), this is a LIVE producer: the daemon's repair-escalation
 * sweep is the surface that genuinely still starves on the dirt (a write-capable
 * `repair::<repo>` session cannot launch into a dirty tree, so it DEFERS), and it feeds
 * the sustained-dirt tracker. Mirrors the wedge idiom on its own id/reason so the two
 * never cross-clear: the un-retryable synthetic `daemon` verb (routes as {@link
 * routeDispatchFailure}'s `unknown` arm, never in `failedKeys`, never
 * `retry_dispatch`-clearable) with a per-repo `id` (`shared-checkout-dirty:<repoHash>`)
 * so two checkouts on a multi-repo board stay independent. As a LIVE producer it IS boot
 * orphan-GC-EXEMPT (a level-trigger owns dropping it, UNLIKE the drained wedge row). Its
 * ONLY clear is the repair sweep's level-trigger observing the checkout clean (the
 * `reason` lives OUTSIDE {@link WORKTREE_RECOVER_REASON_PREFIX}). In-memory grace
 * tracking, so a daemon restart re-emits at most once per still-present dirt. This is a
 * PAGING operator jam: its minted reason startsWith {@link SHARED_DIRTY_DISTRESS_REASON},
 * so `isJamReason` surfaces it through needs-human, and the daemon page-once sweep pages
 * the operator EXACTLY once per row instance (the `human_notified_at` once-marker,
 * re-armed at NULL when the producer level-clear DELETEs the row). The `retry_dispatch`
 * wire STILL cannot clear it — the ONLY clear stays the producer level-trigger above.
 */
export const SHARED_DIRTY_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const SHARED_DIRTY_DISTRESS_ID_PREFIX = "shared-checkout-dirty:";
export const SHARED_DIRTY_DISTRESS_REASON = "shared-checkout-dirty";

/**
 * True iff `(verb, id)` is a shared-checkout-DIRTY distress key — the synthetic
 * `daemon` verb plus the {@link SHARED_DIRTY_DISTRESS_ID_PREFIX} per-repo id. The boot
 * orphan-GC EXEMPTS it (like the crash-loop / desync / lane-wedge keys, UNLIKE the
 * DRAINED mid-merge wedge row) since a live level-trigger — the repair sweep observing
 * the checkout clean — not the operator surface, clears it; pure, dep-free, NEVER
 * throws. Disjoint from {@link isSharedWedgeDistressKey}: the id prefixes
 * (`shared-checkout-dirty:` vs `shared-checkout-wedge:`) never mutually match, so the
 * two distress rows never cross-classify or cross-clear.
 */
export function isSharedDirtyDistressKey(verb: string, id: string): boolean {
  return (
    verb === SHARED_DIRTY_DISTRESS_VERB &&
    id.startsWith(SHARED_DIRTY_DISTRESS_ID_PREFIX)
  );
}

/**
 * The `dispatch_failures.reason` prefix a fan-in LANE pre-merge failure carries —
 * minted by `provision()` when a dependent task's base lane cannot be losslessly
 * cleaned before its fan-in merge (a persistent divergent-dirty base,
 * would-clobber-untracked, off-branch, or mid-merge). Lands on the NATURAL
 * `work::<taskId>` key, so {@link routeDispatchFailure} short-circuits it to
 * `work-task` — but the reconciler's verb-agnostic reason-scoped level-clear
 * collects it by THIS reason (not the router) and clears it once the base is ready,
 * so it is a SELF-CLEARING (non-sticky) row, never the dead no-clear `work-task`
 * dead end. Distinct from `worktree-recover-*`, `worktree-finalize-*`, and the
 * exact {@link MERGE_ESCALATION_REASON_TOKEN} close token, so it never collides with
 * the `close::<epic>` escalation semantics. A SUBSTRING of {@link
 * LANE_WEDGE_DISTRESS_REASON} it is NOT — the two prefixes are disjoint
 * (`worktree-lane-premerge` vs `worktree-lane-wedge`) so a distress row is never
 * mis-collected as a provision lane-failure and vice versa.
 */
export const WORKTREE_LANE_PREMERGE_REASON_PREFIX = "worktree-lane-premerge";

/**
 * Whether a `dispatch_failures.reason` is a fan-in LANE pre-merge failure (see
 * {@link WORKTREE_LANE_PREMERGE_REASON_PREFIX}) — the reason scope the reconciler's
 * verb-agnostic level-clear keys on to clear a `work::<taskId>` lane row WITHOUT
 * touching {@link routeDispatchFailure}. Pure; NEVER throws.
 */
export function isWorktreeLanePremergeReason(reason: string): boolean {
  return reason.startsWith(WORKTREE_LANE_PREMERGE_REASON_PREFIX);
}

/**
 * The synthetic PER-LANE distress signal for a fan-in base lane worktree that stays
 * not-losslessly-cleanable past the recover grace watermark (a persistent
 * divergent-dirty / off-branch / would-clobber base), or IMMEDIATELY for a hard
 * `abort-failed` mid-merge lane git could not even abort. The escalation layer ON
 * TOP of the per-cycle self-clearing `work::<taskId>` {@link
 * WORKTREE_LANE_PREMERGE_REASON_PREFIX} row. Mirrors the shared-checkout-wedge
 * idiom EXACTLY but on its OWN id/reason so the two NEVER cross-clear: it shares the
 * un-retryable synthetic `daemon` verb (routes as {@link routeDispatchFailure}'s
 * `unknown` arm — never in `failedKeys`, never `retry_dispatch`-clearable), the boot
 * orphan-GC exemption, and a recover-pass level-clear — but the `id` is per-LANE
 * (`worktree-lane-wedge:<laneHash>`), keyed to the lane worktree PATH, so it is a
 * DISTINCT surface from the default-branch shared-checkout dir set (which
 * deliberately excludes linked-lane paths). Its ONLY clear is the recover pass's
 * level-trigger observing the lane ready/gone (NOT `retry_dispatch`). In-memory
 * grace tracking, so a daemon restart re-emits at most once per still-present wedge.
 */
export const LANE_WEDGE_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const LANE_WEDGE_DISTRESS_ID_PREFIX = "worktree-lane-wedge:";
export const LANE_WEDGE_DISTRESS_REASON = "worktree-lane-wedge";

/**
 * True iff `(verb, id)` is a per-lane wedge distress key — the synthetic `daemon`
 * verb plus the {@link LANE_WEDGE_DISTRESS_ID_PREFIX} per-lane id. The boot
 * orphan-GC exempts it (like the shared-checkout-wedge / -dirty + crash-loop keys)
 * since the operator surface never clears it; pure, dep-free, NEVER throws. Disjoint
 * from {@link isSharedWedgeDistressKey} / {@link isSharedDirtyDistressKey}: the id
 * prefixes never mutually match, so the three distress rows never cross-classify or
 * cross-clear.
 */
export function isLaneWedgeDistressKey(verb: string, id: string): boolean {
  return (
    verb === LANE_WEDGE_DISTRESS_VERB &&
    id.startsWith(LANE_WEDGE_DISTRESS_ID_PREFIX)
  );
}

/** Recover-pass lane teardown signals, keyed per lane path and level-cleared on absence. */
export const LANE_TEARDOWN_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const LANE_TEARDOWN_DISTRESS_ID_PREFIX = "worktree-lane-teardown:";
export const LANE_BACKUP_DISTRESS_ID_PREFIX = "worktree-lane-backup-failed:";
export const LANE_TEARDOWN_DISTRESS_REASON = "worktree-lane-teardown";
export const LANE_BACKUP_DISTRESS_REASON = "worktree-lane-backup-failed";

export function isLaneTeardownDistressKey(verb: string, id: string): boolean {
  return (
    verb === LANE_TEARDOWN_DISTRESS_VERB &&
    (id.startsWith(LANE_TEARDOWN_DISTRESS_ID_PREFIX) ||
      id.startsWith(LANE_BACKUP_DISTRESS_ID_PREFIX))
  );
}

/**
 * The synthetic PER-(EPIC,REPO) distress signal for an already-cut worktree lane
 * whose base is STALE — a lane forked off its repo's default BEFORE a satisfied
 * same-resolved-repo upstream landed, so the base is missing that upstream's work and
 * the lane's workers hit DEPENDENCY_BLOCKED with nothing on the board naming the
 * cause. The merge-gate only DEFERS a cut; by construction it can never see a lane
 * ALREADY cut stale, so this producer probe surfaces it. DETECTION + LOUD SURFACING
 * ONLY — never auto-remediation, never touching the cut-deferral. Mirrors the
 * shared-checkout-wedge idiom EXACTLY but on its own id/reason so the surfaces never
 * cross-clear: it shares the un-retryable synthetic `daemon` verb (routes as {@link
 * routeDispatchFailure}'s `unknown` arm — never in `failedKeys`, never
 * `retry_dispatch`-clearable), the boot orphan-GC exemption, and a level-clear — but
 * the `id` is per-(epic,repo) (`stale-base-lane:<epicId>-<repoHash>`), so a lane cut
 * stale in two repos of one clustered epic surfaces independently. Its ONLY clear is
 * the probe's level-trigger observing the lane re-based past the upstream or torn down
 * (the `reason` lives OUTSIDE {@link WORKTREE_RECOVER_REASON_PREFIX}). In-memory grace
 * tracking, so a daemon restart re-emits at most once per still-present stale episode.
 * Prefix-disjoint from every existing family (recover/finalize/shared-wedge/shared-
 * dirty/slot/crash-loop/lane-premerge/lane-wedge).
 */
export const STALE_BASE_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const STALE_BASE_DISTRESS_ID_PREFIX = "stale-base-lane:";
export const STALE_BASE_DISTRESS_REASON = "stale-base-lane";

/**
 * True iff `(verb, id)` is a stale-base-lane distress key — the synthetic `daemon`
 * verb plus the {@link STALE_BASE_DISTRESS_ID_PREFIX} per-(epic,repo) id. The boot
 * orphan-GC exempts it (like the shared-checkout-wedge / -dirty / lane-wedge +
 * crash-loop keys) since the operator surface never clears it; pure, dep-free, NEVER
 * throws. Disjoint from {@link isSharedWedgeDistressKey} / {@link
 * isSharedDirtyDistressKey} / {@link isLaneWedgeDistressKey}: the id prefixes never
 * mutually match, so the four distress rows never cross-classify or cross-clear.
 */
export function isStaleBaseDistressKey(verb: string, id: string): boolean {
  return (
    verb === STALE_BASE_DISTRESS_VERB &&
    id.startsWith(STALE_BASE_DISTRESS_ID_PREFIX)
  );
}

/**
 * The synthetic PER-(PROJECT,NUMBER) distress signal for a landed DUPLICATE plan number —
 * two non-done epics in the SAME project sharing one `epic_number`. The mint guard refuses
 * a same-project duplicate up front, but a number that slips through anyway (a merge-window
 * race, a hand-authored file) must surface loudly rather than let a bare `fn-N` resolve to
 * a coin-flip. A once-per-reconcile producer probe (a pure O(open epics) read over the live
 * `epics` projection — NEVER a fold, NEVER per-event) flags each duplicate pair and mints
 * this sticky row. Mirrors the shared-checkout-wedge idiom EXACTLY but on its OWN id/reason
 * so the surfaces never cross-clear: it shares the un-retryable synthetic `daemon` verb
 * (routes as {@link routeDispatchFailure}'s `unknown` arm — never in `failedKeys`, never
 * `retry_dispatch`-clearable), the boot orphan-GC exemption, and a probe level-clear — but
 * the `id` is per-(project,number) (`dup-epic-number:<projectHash>-<number>`), so two
 * distinct duplicated numbers, or the same number in two projects, surface independently.
 * Its ONLY clear is the probe's level-trigger observing the duplicate no longer holds (a
 * conflicting epic renumbered, deleted, or gone done — a duplicate involving a DONE epic is
 * history, not a jam, so the probe scopes to non-done pairs). The `reason` lives OUTSIDE
 * {@link WORKTREE_RECOVER_REASON_PREFIX}. In-memory grace tracking, so a daemon restart
 * re-emits at most once per still-present duplicate. Prefix-disjoint from every existing
 * family (recover/finalize/shared-wedge/shared-dirty/slot/crash-loop/lane-premerge/lane-
 * wedge/stale-base/shared-desync).
 */
export const DUP_EPIC_NUMBER_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX = "dup-epic-number:";
export const DUP_EPIC_NUMBER_DISTRESS_REASON = "dup-epic-number";

/**
 * True iff `(verb, id)` is a duplicate-epic-number distress key — the synthetic `daemon`
 * verb plus the {@link DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX} per-(project,number) id. The boot
 * orphan-GC exempts it (like the lane-wedge / stale-base / shared-desync + crash-loop keys)
 * since a live level-trigger — not the operator surface — clears it; pure, dep-free, NEVER
 * throws. Disjoint from every other distress predicate: the `dup-epic-number:` id prefix
 * never matches another family's prefix, so the rows never cross-classify or cross-clear.
 */
export function isDupEpicNumberDistressKey(verb: string, id: string): boolean {
  return (
    verb === DUP_EPIC_NUMBER_DISTRESS_VERB &&
    id.startsWith(DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX)
  );
}

/**
 * The synthetic PER-REPO distress signal for a shared MAIN checkout left DESYNCED by a
 * plumbing base→default merge whose post-merge resync was SKIPPED or ABORTED — the ref
 * advanced (`refs/heads/<default>` moved to the merged commit) but the working tree did
 * NOT catch up, so everything served off the checkout (selector policy, skills, worker
 * templates, daemon source at next boot) silently trails landed history. UNLIKE the
 * neutered shared-checkout-wedge / -dirty family (a dead false positive the boot orphan
 * sweep DRAINS), this is a LIVE producer, so it mirrors the per-LANE / stale-base
 * lifecycle instead: the mint is EVENT-SEEDED (the skip/abort happens inside the merge
 * call, which still returns `merged` — otherwise invisible) and the clear is a per-cycle
 * CONTENT-LEVEL probe over the OPEN rows' dirs, so the row survives epic teardown +
 * daemon restarts (the open-row dir set re-seeds the in-memory latch). Mirrors the
 * shared-checkout-wedge idiom on its OWN id/reason so the surfaces never cross-clear: the
 * un-retryable synthetic `daemon` verb (routes as {@link routeDispatchFailure}'s
 * `unknown` arm — never in `failedKeys`, never `retry_dispatch`-clearable) with a
 * per-repo `id` (`shared-checkout-desync:<repoHash>`) so two checkouts on a multi-repo
 * board desync independently. Its ONLY clear is the per-cycle probe observing the
 * on-default checkout content-carry the default tip (index AND worktree both match HEAD —
 * NEVER a single index-vs-HEAD orientation); the `reason` lives OUTSIDE {@link
 * WORKTREE_RECOVER_REASON_PREFIX}. UNLIKE the drained wedge/dirty family it IS boot
 * orphan-GC-EXEMPT (a live level-trigger owns dropping it). Prefix-disjoint from every
 * existing family (recover/finalize/shared-wedge/shared-dirty/slot/crash-loop/lane-
 * premerge/lane-wedge/stale-base). Like its shared-dirty sibling it is a PAGING operator
 * jam: its minted reason startsWith {@link SHARED_DESYNC_DISTRESS_REASON}, so
 * `isJamReason` surfaces it through needs-human, and the daemon page-once sweep pages the
 * operator EXACTLY once per row instance (`human_notified_at`, re-armed at NULL by the
 * producer level-clear). The `retry_dispatch` wire STILL cannot clear it — the ONLY clear
 * stays the per-cycle content probe above.
 */
export const SHARED_DESYNC_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const SHARED_DESYNC_DISTRESS_ID_PREFIX = "shared-checkout-desync:";
export const SHARED_DESYNC_DISTRESS_REASON = "shared-checkout-desync";

/**
 * True iff `(verb, id)` is a shared-checkout-DESYNC distress key — the synthetic `daemon`
 * verb plus the {@link SHARED_DESYNC_DISTRESS_ID_PREFIX} per-repo id. The boot orphan-GC
 * EXEMPTS it (like the lane-wedge / stale-base + crash-loop keys, UNLIKE the drained
 * wedge/dirty rows) since a live level-trigger — not the operator surface — clears it;
 * pure, dep-free, NEVER throws. Disjoint from {@link isSharedWedgeDistressKey} / {@link
 * isSharedDirtyDistressKey} / {@link isLaneWedgeDistressKey} / {@link
 * isStaleBaseDistressKey}: the id prefixes never mutually match, so the five distress
 * rows never cross-classify or cross-clear.
 */
export function isSharedDesyncDistressKey(verb: string, id: string): boolean {
  return (
    verb === SHARED_DESYNC_DISTRESS_VERB &&
    id.startsWith(SHARED_DESYNC_DISTRESS_ID_PREFIX)
  );
}

/**
 * The PER-REPO origin-containment fallback distress family. The periodic origin-containment
 * reconcile re-pushes local default to origin when a finalize push never landed; when NO
 * owner (finalize/recover) remains to re-trigger it, this is the ONLY surface that can page
 * a repo whose origin is silently falling behind — a repeated push timeout/failure while
 * local leads, or a TRUE divergence keeper cannot reconcile (no fetch/rebase/force). Mints
 * on its OWN id/reason so it never cross-clears the finalize/recover push-stuck rows or the
 * shared-checkout families: the un-retryable synthetic `daemon` verb (routes as {@link
 * routeDispatchFailure}'s `unknown` arm — never in `failedKeys`, never
 * `retry_dispatch`-clearable) with a per-repo `id` (`origin-containment-stuck:<repoHash>`)
 * so two checkouts on a multi-repo board escalate independently. Its ONLY clear is the
 * per-cycle probe observing origin CONTAIN local (pushed / already-contained / remote-ahead
 * — POSITIVE evidence); the `reason` lives OUTSIDE {@link WORKTREE_RECOVER_REASON_PREFIX}.
 * Like its shared-checkout siblings it IS boot orphan-GC-EXEMPT (a live level-trigger owns
 * dropping it) and a PAGING operator jam: its minted reason startsWith {@link
 * ORIGIN_CONTAINMENT_DISTRESS_REASON}, so `isJamReason` surfaces it through needs-human and
 * the daemon page-once sweep pages the operator EXACTLY once per row instance
 * (`human_notified_at`, re-armed at NULL by the producer level-clear). Prefix-disjoint from
 * every existing family.
 */
export const ORIGIN_CONTAINMENT_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX =
  "origin-containment-stuck:";
export const ORIGIN_CONTAINMENT_DISTRESS_REASON = "origin-containment-stuck";

/**
 * True iff `(verb, id)` is an origin-containment-stuck distress key — the synthetic
 * `daemon` verb plus the {@link ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX} per-repo id. The
 * boot orphan-GC EXEMPTS it (like the shared-checkout / lane-wedge / stale-base + crash-loop
 * keys) since a live level-trigger — not the operator surface — clears it; pure, dep-free,
 * NEVER throws. Disjoint from every sibling distress family: the id prefixes never mutually
 * match, so the rows never cross-classify or cross-clear.
 */
export function isOriginContainmentDistressKey(
  verb: string,
  id: string,
): boolean {
  return (
    verb === ORIGIN_CONTAINMENT_DISTRESS_VERB &&
    id.startsWith(ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX)
  );
}

/**
 * A stopped, pid-alive worker-monitor occupant that has kept its dispatch root
 * reserved with canonical `resource-evidence-stale` activity past the producer's
 * paging horizon. This is a PAGING operator jam, never a release signal: the
 * synthetic daemon row does not enter `failedKeys`, and no age-based path kills
 * the session or frees its mutex. The id is per occupant
 * (`monitor-slot-wedge:<jobId>`), while `dir` carries the affected root.
 *
 * Its producer level-clears only on positive settle/exit/fact-clear evidence.
 * The daemon page-once sweep stamps `human_notified_at`; clearing and later
 * re-minting the row re-arms that marker for a fresh episode.
 */
export const MONITOR_SLOT_WEDGE_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX = "monitor-slot-wedge:";
export const MONITOR_SLOT_WEDGE_DISTRESS_REASON = "monitor-slot-wedge";

export function isMonitorSlotWedgeDistressKey(
  verb: string,
  id: string,
): boolean {
  return (
    verb === MONITOR_SLOT_WEDGE_DISTRESS_VERB &&
    id.startsWith(MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX)
  );
}

export function monitorSlotWedgeJobId(id: string): string | null {
  return id.startsWith(MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX)
    ? id.slice(MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX.length)
    : null;
}

/**
 * A stopped, done-stamped plan worker that remained pid-alive with canonical
 * resource evidence stale past the reaper horizon, but could not be safely
 * signalled. The synthetic per-session row is producer-owned and level-clears
 * only after positive settle/exit evidence. It never enters dispatch suppression
 * or the retry wire.
 */
export const ZOMBIE_SESSION_DISTRESS_VERB = CRASH_LOOP_DISTRESS_VERB;
export const ZOMBIE_SESSION_DISTRESS_ID_PREFIX = "zombie-session:";
export const ZOMBIE_SESSION_DISTRESS_REASON = "zombie-session";

export function isZombieSessionDistressKey(verb: string, id: string): boolean {
  return (
    verb === ZOMBIE_SESSION_DISTRESS_VERB &&
    id.startsWith(ZOMBIE_SESSION_DISTRESS_ID_PREFIX)
  );
}

export function zombieSessionJobId(id: string): string | null {
  return id.startsWith(ZOMBIE_SESSION_DISTRESS_ID_PREFIX)
    ? id.slice(ZOMBIE_SESSION_DISTRESS_ID_PREFIX.length)
    : null;
}

/**
 * The stuck-state-sentinel anomaly distress signal (ADR 0013 layer 3) — the
 * PER-SESSION sticky the producer mints when the board says `working` but the
 * session is demonstrably idle (a worker-done-but-working contradiction, or a
 * very-stale live-pid session). UNLIKE the `daemon`-verb distress family above,
 * this diverges from the glossary's LEVEL-cleared distress row: it mirrors the
 * `worktree-merge-conflict` sticky's `retry_dispatch`-ONLY clear — every firing
 * is evidence of a layer-1 fold gap, and a silently self-tidying corrector is how
 * this class stayed invisible for weeks, so the OPERATOR acks it, never a
 * level-trigger. To be `retry_dispatch`-clearable the verb MUST be a retryable one
 * ({@link import("./dispatch-command").RetryDispatchVerb} = work|close|approve|repair);
 * `close` mirrors the merge-conflict precedent. The `id` is a DEDICATED synthetic
 * namespace (`stuck-sentinel:<jobId>`) that never collides with a real epic
 * (`fn-…`), so it routes as a `close-plain` dead-end (no escalation sweep fires on
 * it), the reconciler's post-clear re-attempt finds no such epic and no-ops, and
 * — being retryable — the boot orphan-GC leaves it alone by construction (that
 * sweep only reaps UN-retryable keys). The `reason` is CLASS-stable (never carries
 * a live age) so the producer's change-gate does not re-fire every poll tick; a
 * newly-observed clock skew flips the reason and re-surfaces once.
 */
export const STUCK_SENTINEL_DISTRESS_VERB = "close";
export const STUCK_SENTINEL_DISTRESS_ID_PREFIX = "stuck-sentinel:";
export const STUCK_SENTINEL_DISTRESS_REASON = "stuck-sentinel";

/**
 * True iff `(verb, id)` is a stuck-state-sentinel anomaly distress key — the
 * retryable `close` verb plus the {@link STUCK_SENTINEL_DISTRESS_ID_PREFIX}
 * per-session id. Pure, dep-free, NEVER throws. Disjoint from every `daemon`-verb
 * distress predicate (different verb) and from a real `close::<epic>` row (the
 * `stuck-sentinel:` id prefix never matches an `fn-…` epic).
 */
export function isStuckSentinelDistressKey(verb: string, id: string): boolean {
  return (
    verb === STUCK_SENTINEL_DISTRESS_VERB &&
    id.startsWith(STUCK_SENTINEL_DISTRESS_ID_PREFIX)
  );
}

/**
 * Extract the job id a stuck-sentinel distress `id` carries — the substring
 * after {@link STUCK_SENTINEL_DISTRESS_ID_PREFIX} — or `null` when `id` does not
 * carry the prefix. Pure string slice, verb-agnostic (a caller needing the full
 * key predicate combines it with {@link isStuckSentinelDistressKey}). This is the
 * correlation key the ADR-0013 orphan reconciliation joins against the LIVE
 * `jobs` table: a sentinel row whose extracted job id no longer resolves there
 * has lost its evidentiary value (nothing left to inspect).
 */
export function stuckSentinelJobId(id: string): string | null {
  return id.startsWith(STUCK_SENTINEL_DISTRESS_ID_PREFIX)
    ? id.slice(STUCK_SENTINEL_DISTRESS_ID_PREFIX.length)
    : null;
}

// ── Display collapse — the board pill KIND ─────────────────────────────────

/** The short scannable KIND a raw reason collapses to for the board pill. */
export type DispatchFailureDisplayKind =
  | "multi-repo"
  | "non-ff"
  | "suite-red"
  | "merge-conflict"
  | "dirty-tree"
  | "slot-reclaimed"
  | "slot-occupied"
  | "instant-death"
  | "parked-launch"
  | "crash-loop"
  | "native-crash"
  | "events-ingest-stalled"
  | "shared-wedge"
  | "shared-dirty"
  | "shared-desync"
  | "monitor-slot-wedge"
  | "zombie-session"
  | "lane-premerge"
  | "lane-wedge"
  | "stale-base"
  | "dup-epic-number"
  | "stuck-sentinel"
  | "fatal-audit";

/**
 * The reason→display-KIND map, MOST-SPECIFIC-FIRST. Prefix-matched (not
 * substring-contains) so a longer literal is tested before any shorter sibling
 * could shadow it; no entry is a prefix of another, so the ordering is also
 * collision-free by construction. The board pill's `classifyDispatchFailure`
 * iterates this — the SAME table the router's vocabulary is drawn from, so the
 * two never drift.
 */
export const DISPATCH_FAILURE_DISPLAY_RULES: ReadonlyArray<{
  prefix: string;
  kind: DispatchFailureDisplayKind;
}> = [
  { prefix: "worktree-multi-repo", kind: "multi-repo" },
  { prefix: WORKTREE_FINALIZE_NON_FF_REASON, kind: "non-ff" },
  { prefix: WORKTREE_FINALIZE_SUITE_RED_REASON, kind: "suite-red" },
  { prefix: "worktree-finalize-conflict", kind: "merge-conflict" },
  { prefix: "worktree-recover-conflict", kind: "merge-conflict" },
  { prefix: "worktree-recover-dirty-checkout", kind: "dirty-tree" },
  { prefix: MERGE_ESCALATION_REASON_TOKEN, kind: "merge-conflict" },
  { prefix: SLOT_RECLAIMED_REASON_PREFIX, kind: "slot-reclaimed" },
  { prefix: SLOT_OCCUPIED_REASON_PREFIX, kind: "slot-occupied" },
  { prefix: INSTANT_DEATH_BREAKER_REASON, kind: "instant-death" },
  { prefix: PARKED_LAUNCH_REASON_PREFIX, kind: "parked-launch" },
  { prefix: CRASH_LOOP_DISTRESS_REASON, kind: "crash-loop" },
  { prefix: REPEATED_NATIVE_CRASH_DISTRESS_REASON, kind: "native-crash" },
  {
    prefix: EVENTS_INGEST_STALL_DISTRESS_REASON,
    kind: "events-ingest-stalled",
  },
  { prefix: SHARED_WEDGE_DISTRESS_REASON, kind: "shared-wedge" },
  { prefix: SHARED_DIRTY_DISTRESS_REASON, kind: "shared-dirty" },
  // Prefix-disjoint from the wedge/dirty siblings (`shared-checkout-desync` diverges at
  // `-de` vs `-di`/`-w`, neither a prefix of the other), so ordering is not load-bearing;
  // grouped with the shared-checkout family for readability.
  { prefix: SHARED_DESYNC_DISTRESS_REASON, kind: "shared-desync" },
  { prefix: MONITOR_SLOT_WEDGE_DISTRESS_REASON, kind: "monitor-slot-wedge" },
  { prefix: ZOMBIE_SESSION_DISTRESS_REASON, kind: "zombie-session" },
  // MOST-SPECIFIC-FIRST: the lane WEDGE distress prefix (`worktree-lane-wedge`)
  // must precede the lane PREMERGE prefix (`worktree-lane-premerge`) — neither is a
  // prefix of the other, but ordering keeps the table's stated invariant true even
  // if a future rename shortens one.
  { prefix: LANE_WEDGE_DISTRESS_REASON, kind: "lane-wedge" },
  { prefix: LANE_BACKUP_DISTRESS_REASON, kind: "lane-wedge" },
  { prefix: LANE_TEARDOWN_DISTRESS_REASON, kind: "lane-wedge" },
  { prefix: WORKTREE_LANE_PREMERGE_REASON_PREFIX, kind: "lane-premerge" },
  // Prefix-disjoint from every rule above (`stale-base-lane` shares no stem), so
  // ordering is not load-bearing here — appended last, its own kind.
  { prefix: STALE_BASE_DISTRESS_REASON, kind: "stale-base" },
  // Prefix-disjoint from every rule above (`dup-epic-number` shares no stem), so
  // ordering is not load-bearing here — its own kind.
  { prefix: DUP_EPIC_NUMBER_DISTRESS_REASON, kind: "dup-epic-number" },
  // The stuck-state-sentinel anomaly (`stuck-sentinel`) — prefix-disjoint from
  // every rule above, so ordering is not load-bearing; appended last, own kind.
  { prefix: STUCK_SENTINEL_DISTRESS_REASON, kind: "stuck-sentinel" },
  // The withheld-close fatal-audit verdict (`fatal-audit`) — prefix-disjoint from
  // every rule above, so ordering is not load-bearing; its own kind so the board
  // pill reads a fatal audit distinctly from a merge conflict.
  { prefix: FATAL_AUDIT_REASON_TOKEN, kind: "fatal-audit" },
];

// ── Exhaustiveness tripwire ────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness guard for a switch over a literal-kind union: the
 * `never` parameter fails to type-check the moment an unhandled variant reaches
 * it, so adding a route kind breaks compilation of every switch that forgot it.
 * Throws if ever reached at runtime (an unhandled kind surfaces loudly rather
 * than vanishing).
 */
export function assertNever(x: never): never {
  throw new Error(
    `unhandled dispatch-failure variant: ${JSON.stringify(x as unknown)}`,
  );
}

// ── The typed router ───────────────────────────────────────────────────────

/** A `dispatch_failures` row's wire identity (verb pk + id/reason/dir columns). */
export interface DispatchFailureIdentity {
  verb: string;
  id: string;
  reason: string;
  dir: string;
}

/**
 * The routing class of a `dispatch_failures` row — a literal-kind discriminated
 * union carrying the raw identity so consumers read whatever field they need.
 * Each `close` arm preserves ONE exact match semantic (see {@link
 * routeDispatchFailure}); `unknown` preserves the raw strings for any other verb.
 * A `work` row splits on the merge-conflict leading token: a fan-in conflict is
 * `work-merge-conflict` (its own served escalation arm), every OTHER work failure
 * is the retryable `work-task`. Adding a variant here breaks compilation of every
 * switch that omits it.
 */
export type DispatchFailureRoute =
  | ({ kind: "work-task" } & DispatchFailureIdentity)
  | ({ kind: "work-merge-conflict" } & DispatchFailureIdentity)
  | ({ kind: "worktree-finalize" } & DispatchFailureIdentity)
  | ({ kind: "worktree-recover" } & DispatchFailureIdentity)
  | ({ kind: "merge-escalation" } & DispatchFailureIdentity)
  | ({ kind: "close-plain" } & DispatchFailureIdentity)
  | ({ kind: "unknown" } & DispatchFailureIdentity);

/**
 * Leading reason token: the text before the FIRST `:`, trimmed; `""` when there
 * is no colon. Reproduces the merge-escalation gate's exact semantic — a
 * colon-less reason never matches a token (`shouldEscalateMergeConflict`
 * returns false without a `:`).
 */
export function leadingReasonToken(reason: string): string {
  const colon = reason.indexOf(":");
  return colon < 0 ? "" : reason.slice(0, colon).trim();
}

/**
 * Route a `dispatch_failures` row by its identity. A `work` row splits on the
 * merge-conflict leading token: a fan-in conflict (exact {@link
 * MERGE_ESCALATION_REASON_TOKEN}) diverts to its own served `work-merge-conflict`
 * arm — the resolve::/deconflict::/page pipeline — while every OTHER work failure
 * stays the retryable `work-task`. The divert is exact-leading-token only, so a
 * `worktree-lane-premerge-*` / `worktree-merge-lock-timeout` work row (a
 * `worktree-merge` PREFIX, not the token) never diverts. `close`-row precedence,
 * each arm a distinct EXACT match semantic:
 *   1. `worktree-finalize` — the ID prefix ({@link WORKTREE_FINALIZE_ID_PREFIX},
 *      on the id, NOT the reason).
 *   2. `worktree-recover` — the reason prefix ({@link WORKTREE_RECOVER_REASON_PREFIX}).
 *   3. `merge-escalation` — the exact leading reason token ({@link
 *      MERGE_ESCALATION_REASON_TOKEN}).
 * The three close arms are disjoint over every minted row (a finalize-keyed row never
 * carries a recover reason; a recover reason never has the merge-conflict token),
 * so the ordering routes each real row exactly as the three independent legacy
 * predicates did. NEVER throws.
 */
export function routeDispatchFailure(
  row: DispatchFailureIdentity,
): DispatchFailureRoute {
  if (row.verb === "work") {
    if (leadingReasonToken(row.reason) === MERGE_ESCALATION_REASON_TOKEN) {
      return { kind: "work-merge-conflict", ...row };
    }
    return { kind: "work-task", ...row };
  }
  if (row.verb !== "close") {
    return { kind: "unknown", ...row };
  }
  if (row.id.startsWith(WORKTREE_FINALIZE_ID_PREFIX)) {
    return { kind: "worktree-finalize", ...row };
  }
  if (row.reason.startsWith(WORKTREE_RECOVER_REASON_PREFIX)) {
    return { kind: "worktree-recover", ...row };
  }
  if (leadingReasonToken(row.reason) === MERGE_ESCALATION_REASON_TOKEN) {
    return { kind: "merge-escalation", ...row };
  }
  return { kind: "close-plain", ...row };
}

// ── Preserved reason predicates (drawn from the ONE vocabulary) ─────────────

/**
 * Whether a `dispatch_failures.reason` originated in `recoverWorktrees` — the
 * exact prefix match that scopes the recover level-clear to recover-only rows.
 */
export function isWorktreeRecoverReason(reason: string): boolean {
  return reason.startsWith(WORKTREE_RECOVER_REASON_PREFIX);
}

/**
 * Whether a `dispatch_failures.reason` is a slot-occupancy signal — a reclaimed
 * dead slot ({@link SLOT_RECLAIMED_REASON_PREFIX}) OR an occupied-but-not-killed
 * one ({@link SLOT_OCCUPIED_REASON_PREFIX}). The prefix gate that scopes the
 * reconciler's level-triggered slot auto-clear to slot rows ONLY, so a genuine
 * `close::<epic>` conflict sharing the natural key is NEVER auto-dismissed — the
 * same reason-scope discipline {@link isWorktreeRecoverReason} enforces for
 * recover. Pure; NEVER throws.
 */
export function isSlotOccupancyReason(reason: string): boolean {
  return (
    reason.startsWith(SLOT_RECLAIMED_REASON_PREFIX) ||
    reason.startsWith(SLOT_OCCUPIED_REASON_PREFIX)
  );
}

/**
 * Whether a `dispatch_failures.reason` is a worktree-merge-conflict INCIDENT —
 * a standing fan-in merge-integration obligation on the row, VERB-AGNOSTIC (a
 * `close`-sink epic fan-in OR a `work`-lane task fan-in) and covering BOTH the
 * pre-minted `pending owner integration` fast-forward request and a genuine
 * content conflict. The EXACT leading-token gate ({@link
 * MERGE_ESCALATION_REASON_TOKEN}), so a `worktree-merge` PREFIX
 * (`worktree-merge-lock-timeout`, `worktree-lane-premerge-*`) never matches.
 * The fold's reason-precedence guard reads this to protect an open obligation
 * from a lower-priority overwrite. Pure; NEVER throws.
 */
export function isMergeConflictIncidentReason(reason: string): boolean {
  return leadingReasonToken(reason) === MERGE_ESCALATION_REASON_TOKEN;
}

/**
 * Whether a `dispatch_failures.reason` is a LOWER-PRIORITY dispatch-plumbing
 * failure — a slot-occupancy signal ({@link isSlotOccupancyReason}: reclaimed
 * or occupied), the instant-death breaker ({@link INSTANT_DEATH_BREAKER_REASON}),
 * or a parked launch ({@link isParkedLaunchReason}). Each describes the launch /
 * slot PLUMBING for a `(verb, id)` key, never a semantic merge-integration
 * obligation. The fold's reason-precedence guard uses this so one of these can
 * never REPLACE a standing {@link isMergeConflictIncidentReason} row on the same
 * key (nor can its own later reason-scoped self-clear then erase that obligation):
 * a merge incident clears ONLY on positive ancestry-plus-clean-target evidence.
 * Pure; NEVER throws.
 */
export function isLowerPriorityDispatchPlumbingReason(reason: string): boolean {
  return (
    isSlotOccupancyReason(reason) ||
    reason.startsWith(INSTANT_DEATH_BREAKER_REASON) ||
    isParkedLaunchReason(reason)
  );
}

/**
 * Whether a `dispatch_failures.reason` is an escalatable close-sink merge
 * conflict — the EXACT leading-token gate ({@link MERGE_ESCALATION_REASON_TOKEN};
 * a `worktree-merge` prefix must NOT match). Routes through {@link
 * routeDispatchFailure} so the escalation gate and the row router can never
 * diverge. Pure; a null/colon-less/non-matching reason yields false.
 */
export function isMergeEscalationReason(reason: string): boolean {
  const route = routeDispatchFailure({
    verb: "close",
    id: "",
    reason,
    dir: "",
  });
  switch (route.kind) {
    case "merge-escalation":
      return true;
    case "work-task":
    case "work-merge-conflict":
    case "worktree-finalize":
    case "worktree-recover":
    case "close-plain":
    case "unknown":
      return false;
    default:
      return assertNever(route);
  }
}

/**
 * Split a `worktree-merge-conflict: merging <source> into <base> — <tail>` reason
 * into its source/base branches + trailing text (a git stderr for a genuine
 * conflict, or `pending owner integration` for the pre-minted fan-in class). Splits
 * on the FIRST em-dash so a tail containing one can't poison the branch parse.
 * Returns null on a structural miss. The single reused inverse of the fan-in reason
 * builder — the escalation brief's source/target derivation AND the autopilot
 * merge-incident resolution probe both read branches through THIS parser, so the two
 * can never diverge. Pure; NEVER throws.
 */
export function parseMergeConflictReason(
  reason: string,
): { source: string; base: string; stderr: string | null } | null {
  const dash = reason.indexOf(" — ");
  const head = dash >= 0 ? reason.slice(0, dash) : reason;
  const stderr = dash >= 0 ? reason.slice(dash + 3) : null;
  const m = head.match(
    /^\s*worktree-merge-conflict:\s*merging\s+(\S.*?)\s+into\s+(\S.*?)\s*$/,
  );
  if (m == null) {
    return null;
  }
  const source = m[1];
  const base = m[2];
  if (source === undefined || base === undefined) {
    return null;
  }
  return { source, base, stderr };
}

/**
 * The em-dash tail every pre-minted fan-in `worktree-merge-conflict` incident
 * carries (the class {@link parseMergeConflictReason} returns as `stderr`),
 * distinguishing the requested clean integration from a genuine content
 * conflict (whose tail is a git stderr). A DURABLE HEAD FENCE rides this tail as
 * the ` [expected src=<sha> base=<sha>]` suffix {@link
 * buildPendingIntegrationTail} appends and {@link parsePendingIntegrationHeads}
 * reads back: the producer pins BOTH branch-tip SHAs at incident mint so the
 * resolver can tell the requested exact fast-forward (source strictly containing
 * base, both heads still at their pins) from a moved head, and never mistakes the
 * former for `stale_base`.
 */
export const PENDING_OWNER_INTEGRATION_TAIL = "pending owner integration";

/**
 * Build the pinned pending-integration tail: {@link
 * PENDING_OWNER_INTEGRATION_TAIL} plus the `[expected src=<sha> base=<sha>]`
 * durable head fence. The producer probes both branch-tip SHAs at mint and
 * passes them here; the fold writes the resulting reason verbatim (it never
 * probes), so the fence is re-fold-deterministic. Inverse of {@link
 * parsePendingIntegrationHeads}. Pure.
 */
export function buildPendingIntegrationTail(
  sourceHead: string,
  baseHead: string,
): string {
  return `${PENDING_OWNER_INTEGRATION_TAIL} [expected src=${sourceHead} base=${baseHead}]`;
}

/**
 * Extract the durable head fence a pinned pending-integration incident carries —
 * the `[expected src=<sha> base=<sha>]` suffix {@link buildPendingIntegrationTail}
 * appended. Returns null when the reason carries no fence (a genuine content
 * conflict, or an unpinned legacy pending row), so a caller degrades to its
 * non-fenced path rather than fabricating heads. Reads the whole reason so it is
 * indifferent to how {@link parseMergeConflictReason} splits it. Pure; NEVER
 * throws.
 */
export function parsePendingIntegrationHeads(
  reason: string,
): { sourceHead: string; baseHead: string } | null {
  const m = /\[expected src=([0-9a-f]{7,40}) base=([0-9a-f]{7,40})\]/.exec(
    reason,
  );
  if (m == null || m[1] === undefined || m[2] === undefined) {
    return null;
  }
  return { sourceHead: m[1], baseHead: m[2] };
}
