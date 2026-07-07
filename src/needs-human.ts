/**
 * The ONE pure projector every needs-human surface derives from — `keeper
 * status` today, `keeper watch` deltas and `keeper await` conditions next. Given
 * the sticky `dispatch_failures` rows plus the readiness-snapshot members (dead
 * letters, block escalations, epics carrying a parked closer question), it yields
 * the whole needs-human classification in one place so status / watch / await can
 * never drift on what "stuck" or "jammed" means (ADR 0011).
 *
 * Dep-light leaf: reads NOTHING (no socket, no clock, no DB) and draws EVERY
 * reason literal from the `dispatch-failure-key` vocabulary — never a re-hardcoded
 * string. The operator-jam predicate is IMPORTED from `await-conditions`
 * ({@link isJamReason}), never re-derived here, so the jam class this projector
 * exposes is byte-for-byte the same set `await drained --fail-on-stuck` escalates
 * on. Close-row keys resolve to their board target via {@link resolveFailureTarget}
 * (the hashed-worktree-prefix-aware join), never naive epic-id string matching.
 */

import { isJamReason } from "./await-conditions";
import {
  INSTANT_DEATH_BREAKER_REASON,
  WORKTREE_FINALIZE_NON_FF_REASON,
} from "./dispatch-failure-key";
import {
  type FailureTarget,
  resolveFailureTarget,
} from "./dispatch-failure-pill";

/**
 * Board-wide quota-wall threshold: at or above this many distinct
 * instant-death-breaker stickies (each a distinct `(verb, id)` key that tripped
 * the per-key breaker), the wall verdict reads as the likely SESSION/QUOTA-WALL
 * signal — repeated instant worker deaths across MULTIPLE keys in a window, not
 * one flaky task. Signal only (the per-key breakers already stop each key's
 * burn); a single sticky (below this) is one breaker doing its job.
 */
export const INSTANT_DEATH_WALL_KEYS = 2;

/**
 * The `dispatch_failures.reason` prefix a surface-and-stop `work::` block mints
 * (`daemon.ts`'s `suppressRedispatch` on a non-escalatable blocked category —
 * TOOLING_FAILURE / absent / unparseable — that never dispatches an unblock
 * session and never pages). Distinct from the board's `[blocked:*]` TASK PILL
 * vocabulary (a verdict rendering, not a dispatch-failure reason). Shared with
 * `cli/board.ts` so the top-of-board promotion and this projector's subset
 * count never drift on what counts as a blocked-work row.
 */
export const BLOCKED_WORK_REASON_PREFIX = "blocked:";

/**
 * The most-specific class of ONE sticky `dispatch_failures` row, each row landing
 * in exactly one bucket:
 *   - `finalize-non-ff`         — the origin-ahead non-fast-forward finalize jam.
 *   - `instant-death-breaker`   — a per-key instant-death breaker sticky (the
 *                                 wall subset).
 *   - `other`                   — every other sticky (merge-conflict, recover,
 *                                 multi-repo, slot, …).
 * `finalize-non-ff` and `instant-death-breaker` are the two SUBSETS the umbrella
 * total counts once via `stuck_dispatches` and never double-adds; `other` is the
 * remainder. Orthogonal to the jam axis ({@link isJamReason}): a `finalize-non-ff`
 * row is a jam, a `instant-death-breaker` row is not, and an `other` row may be
 * either.
 */
export type NeedsHumanRowClass =
  | "finalize-non-ff"
  | "instant-death-breaker"
  | "other";

/**
 * Classify one row's reason into its most-specific needs-human bucket. Exact
 * equality on the two subset reasons (mirroring the byte-identical status math),
 * else `other`. Pure; NEVER throws.
 */
export function classifyNeedsHumanRow(reason: string): NeedsHumanRowClass {
  if (reason === WORKTREE_FINALIZE_NON_FF_REASON) {
    return "finalize-non-ff";
  }
  if (reason === INSTANT_DEATH_BREAKER_REASON) {
    return "instant-death-breaker";
  }
  return "other";
}

/** A sticky `dispatch_failures` row as this projector reads it — wire columns,
 *  each coerced defensively (the collection carries `Record<string, unknown>`). */
export interface NeedsHumanRow {
  verb?: unknown;
  id?: unknown;
  reason?: unknown;
  dir?: unknown;
}

/** One sticky row after classification, carrying its resolved board target. */
export interface ClassifiedNeedsHumanRow {
  verb: string;
  id: string;
  reason: string;
  /** Most-specific bucket ({@link classifyNeedsHumanRow}). */
  cls: NeedsHumanRowClass;
  /** True iff the reason is an operator jam that cannot self-clear
   *  ({@link isJamReason}) — the alarm-relevant class. */
  isJam: boolean;
  /** The board row this sticky decorates (a task, an epic close row), or `null`
   *  for a path-keyed null-epic / zero-match row. Resolved via the
   *  hashed-worktree-prefix-aware join, never epic-id string matching. */
  target: FailureTarget | null;
}

/** Everything the projector needs — the sticky rows plus the three non-dispatch
 *  needs-human families as the snapshot exposes them. */
export interface NeedsHumanInputs {
  /** The live sticky `dispatch_failures` rows. */
  dispatchFailures: readonly NeedsHumanRow[];
  /** Count of parked dead letters. */
  deadLetters: number;
  /** Count of open block escalations. */
  blockEscalations: number;
  /** The epic ids carrying a non-null parked closer question. */
  parkedQuestionEpicIds: readonly string[];
  /** All known epic ids — the join set for {@link resolveFailureTarget}. */
  epicIds: readonly string[];
}

/** The scalar needs-human counts every surface displays. `finalizeNonFf` and
 *  `instantDeathWall` are SUBSETS of `stuckDispatches`, surfaced separately but
 *  never double-added into `total`. */
export interface NeedsHumanCounts {
  deadLetters: number;
  blockEscalations: number;
  /** Broad count: every sticky `dispatch_failures` row. */
  stuckDispatches: number;
  /** Subset of `stuckDispatches`: origin-ahead non-ff finalize jams. */
  finalizeNonFf: number;
  /** Subset of `stuckDispatches`: per-key instant-death-breaker stickies. */
  instantDeathWall: number;
  /** Subset of `stuckDispatches`: homed `work::` surface-and-stop rows whose
   *  reason carries the {@link BLOCKED_WORK_REASON_PREFIX} prefix — mirrors the
   *  `finalizeNonFf` never-double-count pattern, not `deadLetters`'s
   *  independent adder. */
  blockedWork: number;
  parkedQuestions: number;
  /** Umbrella total honoring the subset non-double-count rule. */
  total: number;
}

/** The complete needs-human projection. */
export interface NeedsHumanProjection {
  counts: NeedsHumanCounts;
  /** The narrow operator-jam class: sticky rows whose reason cannot self-clear.
   *  Alarm surfaces (watch deltas, await conditions) fire on this, not the broad
   *  `stuckDispatches` count (ADR 0011). */
  jamCount: number;
  /** True iff `instantDeathWall >= INSTANT_DEATH_WALL_KEYS` — the board-wide
   *  session/quota-wall verdict. */
  instantDeathWallTripped: boolean;
  /** Every sticky row, classified and target-resolved. Input order preserved. */
  rows: readonly ClassifiedNeedsHumanRow[];
  /** A stable hash over the sorted keyed signal set — the anchor the await
   *  `since:` mechanism consumes. Invariant under row reordering; changes on any
   *  signal add/clear or per-row reclassification. */
  signature: string;
}

const asStr = (x: unknown): string =>
  typeof x === "string" ? x : String(x ?? "");

/**
 * Project the full needs-human classification from the sticky rows and the three
 * non-dispatch families. PURE — no socket, no clock — so a fixture snapshot pins
 * every count, the jam class, the wall verdict, and the signature.
 */
export function projectNeedsHuman(
  inputs: NeedsHumanInputs,
): NeedsHumanProjection {
  const rows: ClassifiedNeedsHumanRow[] = inputs.dispatchFailures.map((r) => {
    const verb = asStr(r.verb);
    const id = asStr(r.id);
    const reason = asStr(r.reason);
    const dir = asStr(r.dir);
    return {
      verb,
      id,
      reason,
      cls: classifyNeedsHumanRow(reason),
      isJam: isJamReason(reason),
      target: resolveFailureTarget({ verb, id, dir }, inputs.epicIds),
    };
  });

  const stuckDispatches = rows.length;
  const finalizeNonFf = rows.filter((r) => r.cls === "finalize-non-ff").length;
  const instantDeathWall = rows.filter(
    (r) => r.cls === "instant-death-breaker",
  ).length;
  // Homed `work::` surface-and-stop rows — verb-scoped (never a `close` row) so
  // this never collides with a coincidentally `blocked:`-prefixed close reason.
  const blockedWork = rows.filter(
    (r) => r.verb === "work" && r.reason.startsWith(BLOCKED_WORK_REASON_PREFIX),
  ).length;
  const jamCount = rows.filter((r) => r.isJam).length;
  const parkedQuestions = inputs.parkedQuestionEpicIds.length;

  // `finalizeNonFf`, `instantDeathWall`, and `blockedWork` are SUBSETS of
  // `stuckDispatches` — surfaced separately, never double-counted into the
  // umbrella total.
  const total =
    inputs.deadLetters +
    inputs.blockEscalations +
    stuckDispatches +
    parkedQuestions;

  const counts: NeedsHumanCounts = {
    deadLetters: inputs.deadLetters,
    blockEscalations: inputs.blockEscalations,
    stuckDispatches,
    finalizeNonFf,
    instantDeathWall,
    blockedWork,
    parkedQuestions,
    total,
  };

  return {
    counts,
    jamCount,
    instantDeathWallTripped: instantDeathWall >= INSTANT_DEATH_WALL_KEYS,
    rows,
    signature: needsHumanSignature(rows, inputs),
  };
}

/**
 * Stable content hash over the sorted keyed needs-human signal set. Each sticky
 * row keys on its `(verb, id)` PK plus its class and jam bit, so a NEW row, a
 * cleared row, or a per-row reclassification all move the signature; sorting
 * makes it invariant under row-iteration-order churn (a reconnect re-paint of an
 * unchanged board hashes identically). Parked questions key on their epic id; the
 * dead-letter and block-escalation families fold in as counts (the snapshot
 * carries no stable per-item identity for them).
 */
function needsHumanSignature(
  rows: readonly ClassifiedNeedsHumanRow[],
  inputs: NeedsHumanInputs,
): string {
  // NUL — no keeper verb / id / class token contains it, so two distinct
  // signals can never collide into one key.
  const SEP = "\u0000";
  const df = rows
    .map(
      (r) => `${r.verb}${SEP}${r.id}${SEP}${r.cls}${SEP}${r.isJam ? "J" : "-"}`,
    )
    .sort();
  const pq = [...inputs.parkedQuestionEpicIds].sort();
  return JSON.stringify({
    df,
    pq,
    dl: inputs.deadLetters,
    be: inputs.blockEscalations,
  });
}
