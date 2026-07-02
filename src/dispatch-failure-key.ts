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
 * The origin-ahead non-fast-forward finalize reason — an operator jam (origin
 * moved ahead; a push would be rejected non-fast-forward, and the reconciler
 * never fetch/rebase/force). Its close row keys on {@link
 * WORKTREE_FINALIZE_ID_PREFIX}.
 */
export const WORKTREE_FINALIZE_NON_FF_REASON =
  "worktree-finalize-non-fast-forward";

/**
 * Worktree-mode close keys prefix the epic (or a path slug) with one of these,
 * stripped by `resolveFailureTarget` before the epic-id join.
 */
export const WORKTREE_CLOSE_KEY_PREFIXES = [
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
] as const;

// ── Display collapse — the board pill KIND ─────────────────────────────────

/** The short scannable KIND a raw reason collapses to for the board pill. */
export type DispatchFailureDisplayKind =
  | "multi-repo"
  | "non-ff"
  | "merge-conflict"
  | "dirty-tree";

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
  { prefix: "worktree-finalize-conflict", kind: "merge-conflict" },
  { prefix: "worktree-recover-conflict", kind: "merge-conflict" },
  { prefix: "worktree-recover-dirty-checkout", kind: "dirty-tree" },
  { prefix: MERGE_ESCALATION_REASON_TOKEN, kind: "merge-conflict" },
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
 * Adding a variant here breaks compilation of every switch that omits it.
 */
export type DispatchFailureRoute =
  | ({ kind: "work-task" } & DispatchFailureIdentity)
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
 * Route a `dispatch_failures` row by its identity. `close`-row precedence, each
 * arm a distinct EXACT match semantic:
 *   1. `worktree-finalize` — the ID prefix ({@link WORKTREE_FINALIZE_ID_PREFIX},
 *      on the id, NOT the reason).
 *   2. `worktree-recover` — the reason prefix ({@link WORKTREE_RECOVER_REASON_PREFIX}).
 *   3. `merge-escalation` — the exact leading reason token ({@link
 *      MERGE_ESCALATION_REASON_TOKEN}).
 * The three arms are disjoint over every minted row (a finalize-keyed row never
 * carries a recover reason; a recover reason never has the merge-conflict token),
 * so the ordering routes each real row exactly as the three independent legacy
 * predicates did. NEVER throws.
 */
export function routeDispatchFailure(
  row: DispatchFailureIdentity,
): DispatchFailureRoute {
  if (row.verb === "work") {
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
    case "worktree-finalize":
    case "worktree-recover":
    case "close-plain":
    case "unknown":
      return false;
    default:
      return assertNever(route);
  }
}
