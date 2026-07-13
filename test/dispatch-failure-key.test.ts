/**
 * The dispatch-failure classifier is a semantics-PRESERVING router: it must route
 * every minted `dispatch_failures` shape exactly as the three pre-refactor
 * predicates did (the recover reason scope, the finalize id scope, the
 * merge-escalation exact-token gate). These tests pin that identity over the full
 * minted catalog + fuzzed near-misses, the historical recover/finalize collision
 * shapes, and the assertNever exhaustiveness tripwire.
 */

import { describe, expect, test } from "bun:test";
import { isRetryableDispatchKey } from "../src/dispatch-command";
import {
  assertNever,
  CRASH_LOOP_DISTRESS_ID,
  CRASH_LOOP_DISTRESS_REASON,
  CRASH_LOOP_DISTRESS_VERB,
  DISPATCH_FAILURE_DISPLAY_RULES,
  type DispatchFailureIdentity,
  DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  DUP_EPIC_NUMBER_DISTRESS_VERB,
  isDupEpicNumberDistressKey,
  isLaneWedgeDistressKey,
  isMergeEscalationReason,
  isSharedDesyncDistressKey,
  isSharedDirtyDistressKey,
  isSharedWedgeDistressKey,
  isSlotOccupancyReason,
  isStaleBaseDistressKey,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  isWorktreeRecoverReason,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
  LANE_WEDGE_DISTRESS_VERB,
  leadingReasonToken,
  MERGE_ESCALATION_REASON_TOKEN,
  routeDispatchFailure,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_REASON,
  SHARED_DESYNC_DISTRESS_VERB,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_REASON,
  SHARED_DIRTY_DISTRESS_VERB,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_REASON,
  SHARED_WEDGE_DISTRESS_VERB,
  SLOT_OCCUPIED_REASON_PREFIX,
  SLOT_RECLAIMED_REASON_PREFIX,
  STALE_BASE_DISTRESS_ID_PREFIX,
  STALE_BASE_DISTRESS_REASON,
  STALE_BASE_DISTRESS_VERB,
  STUCK_SENTINEL_DISTRESS_ID_PREFIX,
  STUCK_SENTINEL_DISTRESS_REASON,
  STUCK_SENTINEL_DISTRESS_VERB,
  stuckSentinelJobId,
  WORKTREE_CLOSE_KEY_PREFIXES,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_FINALIZE_NON_FF_REASON,
  WORKTREE_LANE_PREMERGE_REASON_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
  WORKTREE_RECOVER_REASON_PREFIX,
} from "../src/dispatch-failure-key";
import { classifyDispatchFailure } from "../src/dispatch-failure-pill";

// ── Pre-refactor predicates, replicated with HARDCODED literals ─────────────
// Independent of production so `old === new` proves the router preserved behavior
// rather than tautologically agreeing with itself.

/** `loadReconcileSnapshot`'s recover-clear scope (autopilot-worker, pre-refactor). */
function legacyRecoverRow(r: DispatchFailureIdentity): boolean {
  return r.verb === "close" && r.reason.startsWith("worktree-recover");
}
/** `loadReconcileSnapshot`'s finalize-clear scope (autopilot-worker, pre-refactor). */
function legacyFinalizeRow(r: DispatchFailureIdentity): boolean {
  return r.verb === "close" && r.id.startsWith("worktree-finalize:");
}
/** `shouldEscalateMergeConflict`'s exact-token gate (daemon, pre-refactor). */
function legacyShouldEscalate(reason: string): boolean {
  const colon = reason.indexOf(":");
  if (colon < 0) return false;
  return reason.slice(0, colon).trim() === "worktree-merge-conflict";
}

// ── The minted reason catalog (grep-collected from the producers) ───────────

const FINALIZE_REASON_TOKENS = [
  "worktree-finalize-non-fast-forward",
  "worktree-finalize-off-branch",
  "worktree-finalize-dirty-checkout",
  "worktree-finalize-would-clobber",
  "worktree-finalize-push-not-turn-key",
  "worktree-finalize-push-timeout",
  "worktree-finalize-push-unconfirmed",
  "worktree-finalize-lock-timeout",
  "worktree-finalize-local-timeout",
  "worktree-finalize-conflict",
  "worktree-finalize-push-failed",
  "worktree-finalize-failed",
];

const RECOVER_REASON_TOKENS = [
  "worktree-recover-conflict",
  "worktree-recover-dirty-checkout",
  "worktree-recover-not-on-default",
  "worktree-recover-would-clobber",
  "worktree-recover-non-fast-forward",
  "worktree-recover-push-not-turn-key",
  "worktree-recover-push-timeout",
  "worktree-recover-push-failed",
  "worktree-recover-push-unconfirmed",
  "worktree-recover-lock-timeout",
  "worktree-recover-local-timeout",
  "worktree-recover-unhandled-merge-kind",
  "worktree-recover-failed",
  "worktree-recover-list-failed",
  "worktree-recover-abort-failed",
  "worktree-recover-default-branch-failed",
  "worktree-recover-base-list-failed",
  "worktree-recover-lane-list-failed",
  // The `worktree-recover-${laneKind}-…` teardown family.
  "worktree-recover-branch-off-branch",
  "worktree-recover-husk-push-unconfirmed",
  "worktree-recover-branch-teardown-dirty",
  "worktree-recover-husk-prune-failed",
];

const EPIC = "fn-1-foo";
const FINALIZE_ID = `${WORKTREE_FINALIZE_ID_PREFIX}${EPIC}-abc123`;
const RECOVER_EPIC_ID = `${WORKTREE_RECOVER_KEY_PREFIX}${EPIC}-abc123`;
const RECOVER_SLUG_ID = `${WORKTREE_RECOVER_KEY_PREFIX}-Users-mike-code-keeper`;

function row(
  verb: string,
  id: string,
  reason: string,
  dir = "/repo",
): DispatchFailureIdentity {
  return { verb, id, reason, dir };
}

/** Every distinct (verb, id, reason) shape a producer actually mints. */
const CATALOG: DispatchFailureIdentity[] = [
  // Per-repo finalize blocks — id carries the finalize prefix, reason is finalize-*.
  ...FINALIZE_REASON_TOKENS.map((t) =>
    row("close", FINALIZE_ID, `${t}: detail for ${t}`),
  ),
  // Recover failures — reason carries the recover prefix; epic-tied + null-epic slug keys.
  ...RECOVER_REASON_TOKENS.map((t) =>
    row("close", RECOVER_EPIC_ID, `${t}: detail for ${t}`),
  ),
  ...RECOVER_REASON_TOKENS.slice(0, 4).map((t) =>
    row("close", RECOVER_SLUG_ID, `${t}: detail`),
  ),
  // A pre-refactor recover row can carry a BARE epic id (the reason marker, not the
  // key, scopes the clear) — the shape test/autopilot-worker.test.ts inserts directly.
  row("close", EPIC, "worktree-recover-conflict: merging junk into main"),
  // The escalatable close-sink content conflict — bare epic key.
  row(
    "close",
    EPIC,
    "worktree-merge-conflict: merging keeper/epic/fn-1-foo into main — CONFLICT (content)",
  ),
  // Merge siblings that must NOT escalate.
  row("close", EPIC, "worktree-merge-lock-timeout: could not acquire the lock"),
  row("close", EPIC, "worktree-merge-local-timeout: a local git op timed out"),
  // Multi-repo reject + other bare close reasons.
  row("close", EPIC, "worktree-multi-repo: epic fn-1-foo spans 2 repos (a, b)"),
  row("close", EPIC, "worktree-repo-unresolved: no primary_repo"),
  row("close", EPIC, "cwd-missing: /gone"),
  row("close", EPIC, "work-plugin-shadowed: /path/plugin.json"),
  row("close", EPIC, "job-rejected: not eligible"),
  // Work-task rows.
  row("work", "fn-1-foo.2", "job-rejected: not eligible"),
  row("work", "fn-2-bar.1", "cwd-missing: /gone"),
  // Slot-occupancy rows on the NATURAL key (close epic id / work task id) — verb
  // distinguishes the board target; the reason (not the key/router) scopes the clear.
  row(
    "close",
    EPIC,
    "slot-reclaimed: reaped dead close session (pane %7 zsh, stopped 300s)",
  ),
  row(
    "close",
    EPIC,
    "slot-occupied: stopped close session holds the slot (pane %7 claude)",
  ),
  row(
    "work",
    "fn-1-foo.2",
    "slot-reclaimed: reaped dead work session (pane %3 bash, stopped 240s)",
  ),
  // Unknown verbs preserve raw strings.
  row("open", "whatever", "some-reason: x"),
];

describe("routeDispatchFailure: identity with the pre-refactor predicates", () => {
  test("recover-clear scope === legacy reason-prefix predicate over the catalog", () => {
    for (const r of CATALOG) {
      expect(routeDispatchFailure(r).kind === "worktree-recover").toBe(
        legacyRecoverRow(r),
      );
    }
  });

  test("finalize-clear scope === legacy id-prefix predicate over the catalog", () => {
    for (const r of CATALOG) {
      expect(routeDispatchFailure(r).kind === "worktree-finalize").toBe(
        legacyFinalizeRow(r),
      );
    }
  });

  test("merge-escalation gate === legacy exact-token predicate over the catalog", () => {
    for (const r of CATALOG) {
      expect(isMergeEscalationReason(r.reason)).toBe(
        legacyShouldEscalate(r.reason),
      );
    }
  });

  test("every catalog row routes to exactly one kind (a total function)", () => {
    for (const r of CATALOG) {
      const route = routeDispatchFailure(r);
      expect(route.kind).toBeString();
      // The raw identity is preserved verbatim on the variant.
      expect(route.verb).toBe(r.verb);
      expect(route.id).toBe(r.id);
      expect(route.reason).toBe(r.reason);
      expect(route.dir).toBe(r.dir);
    }
  });
});

describe("routeDispatchFailure: representative variant kinds", () => {
  test("finalize id → worktree-finalize (decided on the ID, not the reason)", () => {
    // Even with a NON-finalize reason, a finalize KEY still routes to finalize.
    expect(routeDispatchFailure(row("close", FINALIZE_ID, "")).kind).toBe(
      "worktree-finalize",
    );
    expect(
      routeDispatchFailure(
        row("close", FINALIZE_ID, "worktree-finalize-non-fast-forward: x"),
      ).kind,
    ).toBe("worktree-finalize");
  });

  test("recover reason → worktree-recover (decided on the REASON, not the key)", () => {
    expect(
      routeDispatchFailure(row("close", EPIC, "worktree-recover-conflict: x"))
        .kind,
    ).toBe("worktree-recover");
    expect(
      routeDispatchFailure(
        row("close", RECOVER_SLUG_ID, "worktree-recover-list-failed: x"),
      ).kind,
    ).toBe("worktree-recover");
  });

  test("bare close + merge-conflict token → merge-escalation", () => {
    expect(
      routeDispatchFailure(
        row("close", EPIC, "worktree-merge-conflict: merging a into b — x"),
      ).kind,
    ).toBe("merge-escalation");
  });

  test("bare close, non-routed reason → close-plain", () => {
    expect(
      routeDispatchFailure(row("close", EPIC, "worktree-multi-repo: x")).kind,
    ).toBe("close-plain");
    expect(
      routeDispatchFailure(row("close", EPIC, "job-rejected: x")).kind,
    ).toBe("close-plain");
  });

  test("work verb → work-task; other verbs → unknown", () => {
    expect(routeDispatchFailure(row("work", "fn-1-foo.2", "x")).kind).toBe(
      "work-task",
    );
    expect(routeDispatchFailure(row("open", "z", "x")).kind).toBe("unknown");
  });

  test("work verb + merge-conflict token → work-merge-conflict (the fan-in divert)", () => {
    // A completed upstream lane that will not merge into a downstream task's base lane
    // mints a `work::<taskId>` `worktree-merge-conflict` row — diverted OUT of the dead
    // work-task arm into its own served escalation arm.
    expect(
      routeDispatchFailure(
        row(
          "work",
          "fn-1-foo.2",
          "worktree-merge-conflict: merging fn-1-foo.1 into keeper/epic/fn-1-foo — CONFLICT",
        ),
      ).kind,
    ).toBe("work-merge-conflict");
  });

  test("work verb + a worktree-merge PREFIX (not the exact token) still → work-task (exact-leading-token divert)", () => {
    // The divert is exact-leading-token only: a `worktree-merge-lock-timeout` /
    // `worktree-merge-local-timeout` work row (a `worktree-merge` PREFIX, NOT the token)
    // and a `worktree-lane-premerge-*` work row never divert — every non-conflict work
    // failure stays the retryable work-task, unchanged.
    for (const reason of [
      "worktree-merge-lock-timeout: could not acquire the lock",
      "worktree-merge-local-timeout: a local git op timed out",
      "worktree-lane-premerge-dirty-base: deferring the fan-in …",
      "launch_failed: worker never bound",
      "x",
    ]) {
      expect(routeDispatchFailure(row("work", "fn-1-foo.2", reason)).kind).toBe(
        "work-task",
      );
    }
    // A colon-less bare `worktree-merge-conflict` (no token boundary) is NOT the token
    // either — `leadingReasonToken` requires a colon, so it stays work-task.
    expect(
      routeDispatchFailure(row("work", "fn-1-foo.2", "worktree-merge-conflict"))
        .kind,
    ).toBe("work-task");
  });

  test("the merge-conflict token diverts ONLY the work verb — a CLOSE row still routes merge-escalation", () => {
    // The two paths are disjoint and independent: the same token on a close row is the
    // pre-existing merge-escalation arm (untouched); on a work row it is the new arm.
    const reason =
      "worktree-merge-conflict: merging fn-1-foo.1 into keeper/epic/fn-1-foo — CONFLICT";
    expect(routeDispatchFailure(row("work", "fn-1-foo.2", reason)).kind).toBe(
      "work-merge-conflict",
    );
    expect(routeDispatchFailure(row("close", EPIC, reason)).kind).toBe(
      "merge-escalation",
    );
    // `isMergeEscalationReason` (verb-forced close) is unchanged by the work divert.
    expect(isMergeEscalationReason(reason)).toBe(true);
  });

  test("crash-loop distress key → unknown (never collides with work/close failedKeys)", () => {
    // The synthetic distress verb is deliberately neither work nor close, so it
    // routes as `unknown` — it can never enter the reconciler's failedKeys
    // suppression against a real dispatch key, whatever the reason carries.
    expect(
      routeDispatchFailure(
        row(
          CRASH_LOOP_DISTRESS_VERB,
          CRASH_LOOP_DISTRESS_ID,
          `${CRASH_LOOP_DISTRESS_REASON}: 8 daemon boots in 30min`,
        ),
      ).kind,
    ).toBe("unknown");
  });

  test("shared-checkout-wedge distress key → unknown (never enters failedKeys)", () => {
    // Same synthetic-verb discipline as crash-loop, but per-repo: the id carries the
    // repo hash. It must route as `unknown` for EVERY repo hash so no wedge row ever
    // suppresses a real dispatch key.
    for (const hash of ["abc123", "0", "zzz999"]) {
      const id = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${hash}`;
      expect(
        routeDispatchFailure(
          row(
            SHARED_WEDGE_DISTRESS_VERB,
            id,
            `${SHARED_WEDGE_DISTRESS_REASON}: /repo has stayed mid-merge`,
          ),
        ).kind,
      ).toBe("unknown");
      expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, id)).toBe(
        true,
      );
    }
  });

  test("isSharedWedgeDistressKey rejects a real close/work row and the crash-loop key", () => {
    // A per-repo finalize/recover close row and a work row are NOT distress keys —
    // only the synthetic `daemon` verb plus the wedge id prefix qualifies. The
    // crash-loop id ("crash-loop") shares the verb but lacks the prefix.
    expect(
      isSharedWedgeDistressKey("close", `${WORKTREE_RECOVER_KEY_PREFIX}fn-1-x`),
    ).toBe(false);
    expect(isSharedWedgeDistressKey("work", "fn-1-x.2")).toBe(false);
    expect(
      isSharedWedgeDistressKey(
        CRASH_LOOP_DISTRESS_VERB,
        CRASH_LOOP_DISTRESS_ID,
      ),
    ).toBe(false);
    // The wedge shares the un-retryable synthetic verb with crash-loop by design.
    expect(SHARED_WEDGE_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    expect(SHARED_WEDGE_DISTRESS_VERB).not.toBe("work");
    expect(SHARED_WEDGE_DISTRESS_VERB).not.toBe("close");
  });

  test("shared-checkout-dirty distress key → unknown (never enters failedKeys)", () => {
    // The SIBLING plain-dirty distress: same synthetic-verb discipline as the wedge,
    // per-repo id carrying the DIRT prefix. It must route as `unknown` for every repo
    // hash so no dirt row ever suppresses a real dispatch key.
    for (const hash of ["abc123", "0", "zzz999"]) {
      const id = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}${hash}`;
      expect(
        routeDispatchFailure(
          row(
            SHARED_DIRTY_DISTRESS_VERB,
            id,
            `${SHARED_DIRTY_DISTRESS_REASON}: /repo has stayed dirty`,
          ),
        ).kind,
      ).toBe("unknown");
      expect(isSharedDirtyDistressKey(SHARED_DIRTY_DISTRESS_VERB, id)).toBe(
        true,
      );
    }
  });

  test("isSharedDirtyDistressKey is DISJOINT from the wedge + crash-loop keys", () => {
    // The two distress prefixes never mutually match, so a mid-merge wedge row and a
    // plain-dirt row for the same repo are two independent rows that never
    // cross-classify. A real close/work row and the crash-loop id are neither.
    const hash = "abc123";
    const dirtyId = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}${hash}`;
    const wedgeId = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${hash}`;
    // A dirt id is a dirt key but NOT a wedge key, and vice versa.
    expect(isSharedDirtyDistressKey(SHARED_DIRTY_DISTRESS_VERB, dirtyId)).toBe(
      true,
    );
    expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, dirtyId)).toBe(
      false,
    );
    expect(isSharedDirtyDistressKey(SHARED_DIRTY_DISTRESS_VERB, wedgeId)).toBe(
      false,
    );
    expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, wedgeId)).toBe(
      true,
    );
    // Not a dirt key: a real close/work row and the crash-loop key (shares the verb,
    // lacks the dirt prefix).
    expect(
      isSharedDirtyDistressKey("close", `${WORKTREE_RECOVER_KEY_PREFIX}fn-1-x`),
    ).toBe(false);
    expect(isSharedDirtyDistressKey("work", "fn-1-x.2")).toBe(false);
    expect(
      isSharedDirtyDistressKey(
        CRASH_LOOP_DISTRESS_VERB,
        CRASH_LOOP_DISTRESS_ID,
      ),
    ).toBe(false);
    // The dirt distress shares the un-retryable synthetic verb by design.
    expect(SHARED_DIRTY_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    expect(SHARED_DIRTY_DISTRESS_VERB).not.toBe("work");
    expect(SHARED_DIRTY_DISTRESS_VERB).not.toBe("close");
  });
});

describe("historical recover/finalize collision shapes stay DISJOINT", () => {
  test("a recover row and a per-repo finalize row route to different scopes", () => {
    // Mirrors test/autopilot-worker.test.ts fn-1034: repo A recover-originated
    // (bare epic key, recover reason) vs repo B per-repo finalize block.
    const recover = row("close", EPIC, "worktree-recover-conflict: merging …");
    const finalize = row(
      "close",
      `${WORKTREE_FINALIZE_ID_PREFIX}${EPIC}-def456`,
      "worktree-finalize-non-fast-forward: origin ahead",
    );
    expect(routeDispatchFailure(recover).kind).toBe("worktree-recover");
    expect(routeDispatchFailure(finalize).kind).toBe("worktree-finalize");
    // Neither leaks into the other's scope.
    expect(routeDispatchFailure(recover).kind).not.toBe("worktree-finalize");
    expect(routeDispatchFailure(finalize).kind).not.toBe("worktree-recover");
  });
});

describe("fuzzed near-misses (the boundary the substring routing must NOT cross)", () => {
  test("a token that merely STARTS WITH the merge-conflict token is not escalated", () => {
    const near = "worktree-merge-conflict-extra: nope";
    expect(isMergeEscalationReason(near)).toBe(legacyShouldEscalate(near));
    expect(isMergeEscalationReason(near)).toBe(false);
  });

  test("a colon-less / empty merge-conflict reason never escalates", () => {
    for (const r of ["worktree-merge-conflict", "", "   ", "no-colon-here"]) {
      expect(isMergeEscalationReason(r)).toBe(legacyShouldEscalate(r));
      expect(isMergeEscalationReason(r)).toBe(false);
    }
  });

  test("an id that starts with worktree-finalize but not the exact prefix is not finalize", () => {
    // "worktree-finalizer:" — the ':' guard means the prefix does not match.
    const r = row("close", "worktree-finalizer:fn-1-foo", "x");
    expect(routeDispatchFailure(r).kind === "worktree-finalize").toBe(
      legacyFinalizeRow(r),
    );
    expect(routeDispatchFailure(r).kind).not.toBe("worktree-finalize");
  });

  test("the recover prefix is a PREFIX match — the preserved over-match is identical old vs new", () => {
    // "worktree-recovery-…" starts with "worktree-recover"; the legacy predicate
    // over-matches it, and so does the router (behavior preserved, not fixed).
    const r = row("close", EPIC, "worktree-recovery-foo: bar");
    expect(routeDispatchFailure(r).kind === "worktree-recover").toBe(
      legacyRecoverRow(r),
    );
    expect(routeDispatchFailure(r).kind).toBe("worktree-recover");
  });
});

describe("preserved predicate helpers", () => {
  test("isWorktreeRecoverReason is the exact recover prefix match", () => {
    expect(isWorktreeRecoverReason("worktree-recover-conflict: x")).toBe(true);
    expect(isWorktreeRecoverReason("worktree-finalize-conflict: x")).toBe(
      false,
    );
    expect(isWorktreeRecoverReason("worktree-merge-conflict: x")).toBe(false);
  });

  test("isMergeEscalationReason matches the daemon test's exact expectations", () => {
    expect(
      isMergeEscalationReason("worktree-merge-conflict: merging a into b — x"),
    ).toBe(true);
    expect(
      isMergeEscalationReason("worktree-merge-lock-timeout: could not acquire"),
    ).toBe(false);
    expect(
      isMergeEscalationReason(
        "worktree-finalize-non-fast-forward: origin ahead",
      ),
    ).toBe(false);
    expect(isMergeEscalationReason("worktree-merge-conflict-extra: nope")).toBe(
      false,
    );
    expect(isMergeEscalationReason("worktree-merge-conflict")).toBe(false);
    expect(isMergeEscalationReason("")).toBe(false);
  });

  test("isSlotOccupancyReason matches both slot prefixes and nothing else", () => {
    expect(
      isSlotOccupancyReason("slot-reclaimed: reaped dead close session"),
    ).toBe(true);
    expect(
      isSlotOccupancyReason("slot-occupied: stopped work session holds it"),
    ).toBe(true);
    // Not a slot reason: worktree families, bare close reasons, empty.
    expect(isSlotOccupancyReason("worktree-recover-conflict: x")).toBe(false);
    expect(isSlotOccupancyReason("worktree-finalize-non-fast-forward: x")).toBe(
      false,
    );
    expect(isSlotOccupancyReason("cwd-missing: /gone")).toBe(false);
    expect(isSlotOccupancyReason("")).toBe(false);
    // The two prefixes are collision-free — neither is a prefix of the other.
    expect(
      SLOT_RECLAIMED_REASON_PREFIX.startsWith(SLOT_OCCUPIED_REASON_PREFIX),
    ).toBe(false);
    expect(
      SLOT_OCCUPIED_REASON_PREFIX.startsWith(SLOT_RECLAIMED_REASON_PREFIX),
    ).toBe(false);
    expect(SLOT_RECLAIMED_REASON_PREFIX).toBe("slot-reclaimed");
    expect(SLOT_OCCUPIED_REASON_PREFIX).toBe("slot-occupied");
  });

  test("leadingReasonToken: text before the first colon, trimmed; '' without a colon", () => {
    expect(leadingReasonToken("worktree-merge-conflict: x")).toBe(
      "worktree-merge-conflict",
    );
    expect(leadingReasonToken("  worktree-merge-conflict : x")).toBe(
      "worktree-merge-conflict",
    );
    expect(leadingReasonToken("no-colon")).toBe("");
    expect(leadingReasonToken("")).toBe("");
  });

  test("crash-loop distress vocabulary: synthetic verb is neither work nor close", () => {
    expect(CRASH_LOOP_DISTRESS_REASON).toBe("daemon-crash-loop");
    expect(CRASH_LOOP_DISTRESS_VERB).not.toBe("work");
    expect(CRASH_LOOP_DISTRESS_VERB).not.toBe("close");
    // Collision-free against the other reason prefixes — no existing rule is a
    // prefix of it, nor it of them, so the pill classifies it to its own kind.
    for (const other of [
      MERGE_ESCALATION_REASON_TOKEN,
      WORKTREE_FINALIZE_NON_FF_REASON,
      SLOT_RECLAIMED_REASON_PREFIX,
      SLOT_OCCUPIED_REASON_PREFIX,
    ]) {
      expect(CRASH_LOOP_DISTRESS_REASON.startsWith(other)).toBe(false);
      expect(other.startsWith(CRASH_LOOP_DISTRESS_REASON)).toBe(false);
    }
  });

  test("shared-checkout-wedge distress reason is collision-free + display-mapped", () => {
    expect(SHARED_WEDGE_DISTRESS_REASON).toBe("shared-checkout-wedge");
    expect(SHARED_WEDGE_DISTRESS_ID_PREFIX).toBe("shared-checkout-wedge:");
    // No existing display-rule prefix is a prefix of the wedge reason, nor it of
    // them, so the pill classifies a wedge row to its own kind (never shadowed).
    for (const { prefix } of DISPATCH_FAILURE_DISPLAY_RULES) {
      if (prefix === SHARED_WEDGE_DISTRESS_REASON) continue;
      expect(SHARED_WEDGE_DISTRESS_REASON.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(SHARED_WEDGE_DISTRESS_REASON)).toBe(false);
    }
    // A wedge row's reason must NOT route as a recover reason (it lives OUTSIDE the
    // `worktree-recover*` auto-clear prefix — its only clear is the level-trigger).
    expect(isWorktreeRecoverReason(`${SHARED_WEDGE_DISTRESS_REASON}: x`)).toBe(
      false,
    );
    // The id prefix is itself a well-formed `shared-checkout-wedge` display match.
    expect(
      SHARED_WEDGE_DISTRESS_ID_PREFIX.startsWith(SHARED_WEDGE_DISTRESS_REASON),
    ).toBe(true);
  });

  test("shared-checkout-dirty distress reason is collision-free + display-mapped", () => {
    expect(SHARED_DIRTY_DISTRESS_REASON).toBe("shared-checkout-dirty");
    expect(SHARED_DIRTY_DISTRESS_ID_PREFIX).toBe("shared-checkout-dirty:");
    // No OTHER display-rule prefix is a prefix of the dirt reason, nor it of them, so
    // the pill classifies a dirt row to its OWN kind (never shadowed by the wedge
    // rule, which shares the `shared-checkout-` stem but is not a prefix of it).
    for (const { prefix } of DISPATCH_FAILURE_DISPLAY_RULES) {
      if (prefix === SHARED_DIRTY_DISTRESS_REASON) continue;
      expect(SHARED_DIRTY_DISTRESS_REASON.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(SHARED_DIRTY_DISTRESS_REASON)).toBe(false);
    }
    // A dirt row's reason must NOT route as a recover reason (it lives OUTSIDE the
    // `worktree-recover*` auto-clear prefix — its only clear is the level-trigger).
    expect(isWorktreeRecoverReason(`${SHARED_DIRTY_DISTRESS_REASON}: x`)).toBe(
      false,
    );
    // The id prefix is itself a well-formed `shared-checkout-dirty` display match.
    expect(
      SHARED_DIRTY_DISTRESS_ID_PREFIX.startsWith(SHARED_DIRTY_DISTRESS_REASON),
    ).toBe(true);
    // Disjoint from the wedge reason: the `shared-checkout-` stem is shared but
    // neither reason is a prefix of the other, so their pills never collide.
    expect(
      SHARED_DIRTY_DISTRESS_REASON.startsWith(SHARED_WEDGE_DISTRESS_REASON),
    ).toBe(false);
    expect(
      SHARED_WEDGE_DISTRESS_REASON.startsWith(SHARED_DIRTY_DISTRESS_REASON),
    ).toBe(false);
  });
});

describe("single vocabulary source", () => {
  test("close-key prefixes are exactly the finalize + recover key prefixes", () => {
    expect([...WORKTREE_CLOSE_KEY_PREFIXES]).toEqual([
      WORKTREE_FINALIZE_ID_PREFIX,
      WORKTREE_RECOVER_KEY_PREFIX,
    ]);
    expect(WORKTREE_FINALIZE_ID_PREFIX).toBe("worktree-finalize:");
    expect(WORKTREE_RECOVER_KEY_PREFIX).toBe("worktree-recover:");
    expect(WORKTREE_RECOVER_REASON_PREFIX).toBe("worktree-recover");
    expect(MERGE_ESCALATION_REASON_TOKEN).toBe("worktree-merge-conflict");
    expect(WORKTREE_FINALIZE_NON_FF_REASON).toBe(
      "worktree-finalize-non-fast-forward",
    );
  });

  test("the display-rule vocabulary is the pill table, most-specific-first", () => {
    // No entry is a prefix of an earlier one — the collision-free ordering the
    // board pill relies on. Pinned so the pill + router never drift.
    expect(
      DISPATCH_FAILURE_DISPLAY_RULES.map((r) => [r.prefix, r.kind]),
    ).toEqual([
      ["worktree-multi-repo", "multi-repo"],
      ["worktree-finalize-non-fast-forward", "non-ff"],
      ["worktree-finalize-suite-red", "suite-red"],
      ["worktree-finalize-conflict", "merge-conflict"],
      ["worktree-recover-conflict", "merge-conflict"],
      ["worktree-recover-dirty-checkout", "dirty-tree"],
      ["worktree-merge-conflict", "merge-conflict"],
      ["slot-reclaimed", "slot-reclaimed"],
      ["slot-occupied", "slot-occupied"],
      ["instant-death-breaker", "instant-death"],
      ["daemon-crash-loop", "crash-loop"],
      ["shared-checkout-wedge", "shared-wedge"],
      ["shared-checkout-dirty", "shared-dirty"],
      ["shared-checkout-desync", "shared-desync"],
      ["worktree-lane-wedge", "lane-wedge"],
      ["worktree-lane-backup-failed", "lane-wedge"],
      ["worktree-lane-teardown", "lane-wedge"],
      ["worktree-lane-premerge", "lane-premerge"],
      ["stale-base-lane", "stale-base"],
      ["dup-epic-number", "dup-epic-number"],
      ["stuck-sentinel", "stuck-sentinel"],
    ]);
  });
});

// ── fn-1123.2 — fan-in LANE pre-merge vocabulary ────────────────────────────

describe("fn-1123.2 worktree-lane pre-merge vocabulary", () => {
  test("isWorktreeLanePremergeReason matches the provision lane family only", () => {
    expect(
      isWorktreeLanePremergeReason("worktree-lane-premerge-dirty-base: …"),
    ).toBe(true);
    expect(
      isWorktreeLanePremergeReason("worktree-lane-premerge-not-ready: …"),
    ).toBe(true);
    expect(
      isWorktreeLanePremergeReason(WORKTREE_LANE_PREMERGE_REASON_PREFIX),
    ).toBe(true);
    // Disjoint from every sibling worktree reason scope — a lane row must never be
    // mis-collected as a recover row, a merge-escalation token, or the lane WEDGE
    // distress reason (a distinct `worktree-lane-wedge` prefix).
    expect(isWorktreeLanePremergeReason(LANE_WEDGE_DISTRESS_REASON)).toBe(
      false,
    );
    expect(
      isWorktreeLanePremergeReason("worktree-recover-dirty-checkout: …"),
    ).toBe(false);
    expect(isWorktreeLanePremergeReason("worktree-merge-conflict: …")).toBe(
      false,
    );
    expect(isWorktreeLanePremergeReason("worktree-finalize-conflict: …")).toBe(
      false,
    );
    expect(isWorktreeLanePremergeReason("")).toBe(false);
  });

  test("isLaneWedgeDistressKey is the synthetic daemon-verb per-lane surface only", () => {
    expect(
      isLaneWedgeDistressKey(
        LANE_WEDGE_DISTRESS_VERB,
        `${LANE_WEDGE_DISTRESS_ID_PREFIX}ab12`,
      ),
    ).toBe(true);
    // Wrong verb, wrong id prefix, and cross-distress ids all miss — the three
    // distress surfaces (lane / shared-wedge / shared-dirty) never cross-classify.
    expect(
      isLaneWedgeDistressKey("close", `${LANE_WEDGE_DISTRESS_ID_PREFIX}ab12`),
    ).toBe(false);
    expect(
      isLaneWedgeDistressKey("work", `${LANE_WEDGE_DISTRESS_ID_PREFIX}ab12`),
    ).toBe(false);
    expect(
      isLaneWedgeDistressKey(
        LANE_WEDGE_DISTRESS_VERB,
        `${SHARED_WEDGE_DISTRESS_ID_PREFIX}ab12`,
      ),
    ).toBe(false);
    expect(
      isLaneWedgeDistressKey(
        LANE_WEDGE_DISTRESS_VERB,
        `${SHARED_DIRTY_DISTRESS_ID_PREFIX}ab12`,
      ),
    ).toBe(false);
    // The lane distress rides the SAME un-retryable synthetic `daemon` verb as the
    // shared-checkout distress rows, so only a level-trigger clears it.
    expect(LANE_WEDGE_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    // A lane wedge distress key is NOT a shared-checkout distress key (disjoint).
    expect(
      isSharedWedgeDistressKey(
        LANE_WEDGE_DISTRESS_VERB,
        `${LANE_WEDGE_DISTRESS_ID_PREFIX}ab12`,
      ),
    ).toBe(false);
    expect(
      isSharedDirtyDistressKey(
        LANE_WEDGE_DISTRESS_VERB,
        `${LANE_WEDGE_DISTRESS_ID_PREFIX}ab12`,
      ),
    ).toBe(false);
  });

  test("the closed work:: routing asymmetry — a lane reason on a work row is NOT merge-escalation, but the close token still escalates", () => {
    // A `work::<taskId>` lane pre-merge row routes to the (dead) `work-task` arm by the
    // verb short-circuit — the router is UNCHANGED; the reason-scoped clear (not the
    // router) is what makes it self-clearing.
    const laneRow: DispatchFailureIdentity = {
      verb: "work",
      id: "fn-1-foo.2",
      reason: "worktree-lane-premerge-dirty-base: deferring the fan-in …",
      dir: "/wt/lane",
    };
    expect(routeDispatchFailure(laneRow).kind).toBe("work-task");
    expect(isMergeEscalationReason(laneRow.reason)).toBe(false);
    // The genuine close-sink conflict token STILL escalates (untouched) — the two
    // paths are provably disjoint: a lane reason never carries the escalation token.
    expect(
      isMergeEscalationReason("worktree-merge-conflict: merging … into …"),
    ).toBe(true);
    expect(leadingReasonToken(laneRow.reason)).not.toBe(
      MERGE_ESCALATION_REASON_TOKEN,
    );
  });
});

// ── fn-1127 — the stale-base lane distress family ───────────────────────────

describe("fn-1127 stale-base-lane distress vocabulary", () => {
  test("stale-base-lane distress key → unknown (never enters failedKeys)", () => {
    // Same synthetic-verb discipline as the shared-checkout / lane distress rows, but
    // per-(epic,repo): the id carries `<epicId>-<repoHash>`. It must route as `unknown`
    // for EVERY shape so no stale-base row ever suppresses a real dispatch key.
    for (const suffix of ["fn-1-foo-abc123", "fn-9-bar-0", "fn-2-baz-zzz999"]) {
      const id = `${STALE_BASE_DISTRESS_ID_PREFIX}${suffix}`;
      expect(
        routeDispatchFailure(
          row(
            STALE_BASE_DISTRESS_VERB,
            id,
            `${STALE_BASE_DISTRESS_REASON}: epic fn-1-foo's lane is stale`,
          ),
        ).kind,
      ).toBe("unknown");
      expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, id)).toBe(true);
    }
  });

  test("isStaleBaseDistressKey is the synthetic daemon-verb per-(epic,repo) surface only", () => {
    const id = `${STALE_BASE_DISTRESS_ID_PREFIX}fn-1-foo-abc123`;
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, id)).toBe(true);
    // Wrong verb, wrong id prefix, and a real close/work row all miss.
    expect(isStaleBaseDistressKey("close", id)).toBe(false);
    expect(isStaleBaseDistressKey("work", id)).toBe(false);
    expect(
      isStaleBaseDistressKey("close", `${WORKTREE_RECOVER_KEY_PREFIX}fn-1-x`),
    ).toBe(false);
    expect(isStaleBaseDistressKey("work", "fn-1-x.2")).toBe(false);
    // The crash-loop id shares the verb but lacks the prefix.
    expect(
      isStaleBaseDistressKey(CRASH_LOOP_DISTRESS_VERB, CRASH_LOOP_DISTRESS_ID),
    ).toBe(false);
    // Shares the un-retryable synthetic `daemon` verb with the sibling distress rows.
    expect(STALE_BASE_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    expect(STALE_BASE_DISTRESS_VERB).not.toBe("work");
    expect(STALE_BASE_DISTRESS_VERB).not.toBe("close");
  });

  test("stale-base-lane distress key is DISJOINT from the wedge / dirty / lane-wedge keys", () => {
    // The four distress prefixes never mutually match, so their rows never
    // cross-classify or cross-clear. A shared `<epicId>-<hash>` tail is deliberate.
    const tail = "fn-1-foo-abc123";
    const staleId = `${STALE_BASE_DISTRESS_ID_PREFIX}${tail}`;
    const wedgeId = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    const dirtyId = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}${tail}`;
    const laneId = `${LANE_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    // A stale id is a stale key but NONE of the others, and vice versa.
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, staleId)).toBe(
      true,
    );
    expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, staleId)).toBe(
      false,
    );
    expect(isSharedDirtyDistressKey(SHARED_DIRTY_DISTRESS_VERB, staleId)).toBe(
      false,
    );
    expect(isLaneWedgeDistressKey(LANE_WEDGE_DISTRESS_VERB, staleId)).toBe(
      false,
    );
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, wedgeId)).toBe(
      false,
    );
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, dirtyId)).toBe(
      false,
    );
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, laneId)).toBe(
      false,
    );
  });

  test("stale-base-lane distress reason is collision-free + display-mapped", () => {
    expect(STALE_BASE_DISTRESS_REASON).toBe("stale-base-lane");
    expect(STALE_BASE_DISTRESS_ID_PREFIX).toBe("stale-base-lane:");
    // No OTHER display-rule prefix is a prefix of the stale-base reason, nor it of
    // them, so the pill classifies a stale-base row to its OWN kind (never shadowed).
    for (const { prefix } of DISPATCH_FAILURE_DISPLAY_RULES) {
      if (prefix === STALE_BASE_DISTRESS_REASON) continue;
      expect(STALE_BASE_DISTRESS_REASON.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(STALE_BASE_DISTRESS_REASON)).toBe(false);
    }
    // A stale-base row's reason must NOT route as a recover reason (it lives OUTSIDE
    // the `worktree-recover*` auto-clear prefix — its only clear is the level-trigger).
    expect(isWorktreeRecoverReason(`${STALE_BASE_DISTRESS_REASON}: x`)).toBe(
      false,
    );
    // …nor as a lane pre-merge reason (a distinct `stale-base-lane` prefix).
    expect(
      isWorktreeLanePremergeReason(`${STALE_BASE_DISTRESS_REASON}: x`),
    ).toBe(false);
    // The id prefix is itself a well-formed `stale-base-lane` display match.
    expect(
      STALE_BASE_DISTRESS_ID_PREFIX.startsWith(STALE_BASE_DISTRESS_REASON),
    ).toBe(true);
  });
});

// ── fn-1193 — the duplicate-epic-number distress family ─────────────────────

describe("fn-1193 duplicate-epic-number distress vocabulary", () => {
  test("dup-epic-number distress key → unknown (never enters failedKeys)", () => {
    // Same synthetic-verb discipline as the shared-checkout / lane / stale distress rows,
    // per-(project,number): the id carries `<projectHash>-<number>`. It must route as
    // `unknown` for EVERY shape so no dup row ever suppresses a real dispatch key.
    for (const suffix of ["abc123-7", "0-1", "zz9-1193"]) {
      const id = `${DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX}${suffix}`;
      expect(
        routeDispatchFailure(
          row(
            DUP_EPIC_NUMBER_DISTRESS_VERB,
            id,
            `${DUP_EPIC_NUMBER_DISTRESS_REASON}: plan number 7 is held by 2 live epics`,
          ),
        ).kind,
      ).toBe("unknown");
      expect(
        isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, id),
      ).toBe(true);
    }
  });

  test("isDupEpicNumberDistressKey is the synthetic daemon-verb per-(project,number) surface only", () => {
    const id = `${DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX}abc123-7`;
    expect(isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, id)).toBe(
      true,
    );
    // Wrong verb, wrong id prefix, and a real close/work row all miss.
    expect(isDupEpicNumberDistressKey("close", id)).toBe(false);
    expect(isDupEpicNumberDistressKey("work", id)).toBe(false);
    expect(isDupEpicNumberDistressKey("work", "fn-1-x.2")).toBe(false);
    // The crash-loop id shares the verb but lacks the prefix.
    expect(
      isDupEpicNumberDistressKey(
        CRASH_LOOP_DISTRESS_VERB,
        CRASH_LOOP_DISTRESS_ID,
      ),
    ).toBe(false);
    // Shares the un-retryable synthetic `daemon` verb with the sibling distress rows.
    expect(DUP_EPIC_NUMBER_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    expect(DUP_EPIC_NUMBER_DISTRESS_VERB).not.toBe("work");
    expect(DUP_EPIC_NUMBER_DISTRESS_VERB).not.toBe("close");
  });

  test("dup-epic-number distress key is DISJOINT from every sibling distress key", () => {
    // The prefixes never mutually match, so their rows never cross-classify/cross-clear.
    const tail = "abc123-7";
    const dupId = `${DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX}${tail}`;
    const staleId = `${STALE_BASE_DISTRESS_ID_PREFIX}${tail}`;
    const wedgeId = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    const desyncId = `${SHARED_DESYNC_DISTRESS_ID_PREFIX}${tail}`;
    const laneId = `${LANE_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    // The dup id is a dup key but NONE of the others.
    expect(
      isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, dupId),
    ).toBe(true);
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, dupId)).toBe(false);
    expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, dupId)).toBe(
      false,
    );
    expect(isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, dupId)).toBe(
      false,
    );
    expect(isLaneWedgeDistressKey(LANE_WEDGE_DISTRESS_VERB, dupId)).toBe(false);
    // …and a sibling id is never a dup key.
    expect(
      isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, staleId),
    ).toBe(false);
    expect(
      isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, wedgeId),
    ).toBe(false);
    expect(
      isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, desyncId),
    ).toBe(false);
    expect(
      isDupEpicNumberDistressKey(DUP_EPIC_NUMBER_DISTRESS_VERB, laneId),
    ).toBe(false);
  });

  test("dup-epic-number distress reason is collision-free + display-mapped", () => {
    expect(DUP_EPIC_NUMBER_DISTRESS_REASON).toBe("dup-epic-number");
    expect(DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX).toBe("dup-epic-number:");
    // A dup row's reason classifies to its OWN display kind (never shadowed by a sibling).
    expect(
      classifyDispatchFailure(
        `${DUP_EPIC_NUMBER_DISTRESS_REASON}: plan number 7 is held by 2 live epics`,
      ),
    ).toBe("dup-epic-number");
    // No OTHER display-rule prefix is a prefix of the dup reason, nor it of them.
    for (const { prefix } of DISPATCH_FAILURE_DISPLAY_RULES) {
      if (prefix === DUP_EPIC_NUMBER_DISTRESS_REASON) continue;
      expect(DUP_EPIC_NUMBER_DISTRESS_REASON.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(DUP_EPIC_NUMBER_DISTRESS_REASON)).toBe(false);
    }
    // The dup row lives OUTSIDE the `worktree-recover*` auto-clear + lane pre-merge scopes.
    expect(
      isWorktreeRecoverReason(`${DUP_EPIC_NUMBER_DISTRESS_REASON}: x`),
    ).toBe(false);
    expect(
      isWorktreeLanePremergeReason(`${DUP_EPIC_NUMBER_DISTRESS_REASON}: x`),
    ).toBe(false);
  });
});

// ── fn-1169 — the shared-checkout-desync distress family ────────────────────

describe("fn-1169 shared-checkout-desync distress vocabulary", () => {
  test("shared-checkout-desync distress key → unknown (never enters failedKeys)", () => {
    // Same synthetic-verb discipline as the wedge/dirty/lane distress rows, per-repo:
    // the id carries `<repoHash>`. It must route as `unknown` for EVERY shape so no
    // desync row ever suppresses a real dispatch key.
    for (const suffix of ["abc123", "0", "zzz999"]) {
      const id = `${SHARED_DESYNC_DISTRESS_ID_PREFIX}${suffix}`;
      expect(
        routeDispatchFailure(
          row(
            SHARED_DESYNC_DISTRESS_VERB,
            id,
            `${SHARED_DESYNC_DISTRESS_REASON}: /repo has stayed DESYNCED`,
          ),
        ).kind,
      ).toBe("unknown");
      expect(isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, id)).toBe(
        true,
      );
    }
  });

  test("isSharedDesyncDistressKey is the synthetic daemon-verb per-repo surface only", () => {
    const id = `${SHARED_DESYNC_DISTRESS_ID_PREFIX}abc123`;
    expect(isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, id)).toBe(
      true,
    );
    // Wrong verb, wrong id prefix, and a real close/work row all miss.
    expect(isSharedDesyncDistressKey("close", id)).toBe(false);
    expect(isSharedDesyncDistressKey("work", id)).toBe(false);
    expect(
      isSharedDesyncDistressKey(
        "close",
        `${WORKTREE_RECOVER_KEY_PREFIX}fn-1-x`,
      ),
    ).toBe(false);
    expect(isSharedDesyncDistressKey("work", "fn-1-x.2")).toBe(false);
    // The crash-loop id shares the verb but lacks the prefix.
    expect(
      isSharedDesyncDistressKey(
        CRASH_LOOP_DISTRESS_VERB,
        CRASH_LOOP_DISTRESS_ID,
      ),
    ).toBe(false);
    // Shares the un-retryable synthetic `daemon` verb with the sibling distress rows.
    expect(SHARED_DESYNC_DISTRESS_VERB).toBe(CRASH_LOOP_DISTRESS_VERB);
    expect(SHARED_DESYNC_DISTRESS_VERB).not.toBe("work");
    expect(SHARED_DESYNC_DISTRESS_VERB).not.toBe("close");
  });

  test("shared-checkout-desync distress key is DISJOINT from the wedge / dirty / lane-wedge / stale keys", () => {
    // The five distress prefixes never mutually match, so their rows never
    // cross-classify or cross-clear. A shared `<hash>` tail is deliberate.
    const tail = "abc123";
    const desyncId = `${SHARED_DESYNC_DISTRESS_ID_PREFIX}${tail}`;
    const wedgeId = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    const dirtyId = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}${tail}`;
    const laneId = `${LANE_WEDGE_DISTRESS_ID_PREFIX}${tail}`;
    const staleId = `${STALE_BASE_DISTRESS_ID_PREFIX}${tail}`;
    // A desync id is a desync key but NONE of the others, and vice versa.
    expect(
      isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, desyncId),
    ).toBe(true);
    expect(isSharedWedgeDistressKey(SHARED_WEDGE_DISTRESS_VERB, desyncId)).toBe(
      false,
    );
    expect(isSharedDirtyDistressKey(SHARED_DIRTY_DISTRESS_VERB, desyncId)).toBe(
      false,
    );
    expect(isLaneWedgeDistressKey(LANE_WEDGE_DISTRESS_VERB, desyncId)).toBe(
      false,
    );
    expect(isStaleBaseDistressKey(STALE_BASE_DISTRESS_VERB, desyncId)).toBe(
      false,
    );
    expect(
      isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, wedgeId),
    ).toBe(false);
    expect(
      isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, dirtyId),
    ).toBe(false);
    expect(isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, laneId)).toBe(
      false,
    );
    expect(
      isSharedDesyncDistressKey(SHARED_DESYNC_DISTRESS_VERB, staleId),
    ).toBe(false);
  });

  test("shared-checkout-desync distress reason is collision-free + display-mapped", () => {
    expect(SHARED_DESYNC_DISTRESS_REASON).toBe("shared-checkout-desync");
    expect(SHARED_DESYNC_DISTRESS_ID_PREFIX).toBe("shared-checkout-desync:");
    // No OTHER display-rule prefix is a prefix of the desync reason, nor it of them, so
    // the pill classifies a desync row to its OWN kind (never shadowed by the sibling
    // shared-checkout-wedge / -dirty rules, which share the `shared-checkout-` stem but
    // are not a prefix of it).
    for (const { prefix } of DISPATCH_FAILURE_DISPLAY_RULES) {
      if (prefix === SHARED_DESYNC_DISTRESS_REASON) continue;
      expect(SHARED_DESYNC_DISTRESS_REASON.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(SHARED_DESYNC_DISTRESS_REASON)).toBe(false);
    }
    // A desync row's reason must NOT route as a recover reason (it lives OUTSIDE the
    // `worktree-recover*` auto-clear prefix — its only clear is the level-trigger)…
    expect(isWorktreeRecoverReason(`${SHARED_DESYNC_DISTRESS_REASON}: x`)).toBe(
      false,
    );
    // …nor as a lane pre-merge reason (a distinct prefix).
    expect(
      isWorktreeLanePremergeReason(`${SHARED_DESYNC_DISTRESS_REASON}: x`),
    ).toBe(false);
    // The two shared-checkout sibling reasons are each disjoint from the desync reason.
    expect(
      SHARED_DESYNC_DISTRESS_REASON.startsWith(SHARED_WEDGE_DISTRESS_REASON),
    ).toBe(false);
    expect(
      SHARED_DESYNC_DISTRESS_REASON.startsWith(SHARED_DIRTY_DISTRESS_REASON),
    ).toBe(false);
    // The id prefix is itself a well-formed `shared-checkout-desync` display match.
    expect(
      SHARED_DESYNC_DISTRESS_ID_PREFIX.startsWith(
        SHARED_DESYNC_DISTRESS_REASON,
      ),
    ).toBe(true);
  });
});

describe("assertNever exhaustiveness tripwire", () => {
  test("throws on an unhandled variant reached at runtime", () => {
    // A future route kind that slips past a switch surfaces loudly here rather than
    // vanishing. (The compile-time guard is that adding a kind breaks every switch
    // that omits it — enforced by tsc, not runtime.)
    const bogus = {
      kind: "totally-new-kind",
      verb: "close",
      id: "x",
      reason: "y",
      dir: "",
    } as unknown as never;
    expect(() => assertNever(bogus)).toThrow(
      /unhandled dispatch-failure variant/,
    );
  });
});

// ── fn-1164.3 — stuck-state-sentinel anomaly vocabulary (ADR 0013 layer 3) ──

describe("fn-1164.3 stuck-state-sentinel distress vocabulary", () => {
  const jobId = "01234567-89ab-cdef-0123-456789abcdef";
  const distressId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}${jobId}`;

  test("the vocabulary constants are the retryable close-keyed synthetic namespace", () => {
    // UNLIKE the daemon-verb distress family, the sentinel uses a RETRYABLE verb so
    // `retry_dispatch` (operator ack) is its only clear — mirroring the
    // worktree-merge-conflict sticky rather than the level-cleared crash-loop row.
    expect(STUCK_SENTINEL_DISTRESS_VERB).toBe("close");
    expect(STUCK_SENTINEL_DISTRESS_ID_PREFIX).toBe("stuck-sentinel:");
    expect(STUCK_SENTINEL_DISTRESS_REASON).toBe("stuck-sentinel");
    // Distinct from the un-retryable synthetic `daemon` verb the other distress
    // rows share — that difference is exactly what makes this one operator-clearable.
    expect(STUCK_SENTINEL_DISTRESS_VERB).not.toBe(CRASH_LOOP_DISTRESS_VERB);
  });

  test("isStuckSentinelDistressKey matches the close::stuck-sentinel: namespace only", () => {
    expect(
      isStuckSentinelDistressKey(STUCK_SENTINEL_DISTRESS_VERB, distressId),
    ).toBe(true);
    // Wrong verb and a real close/work row all miss.
    expect(isStuckSentinelDistressKey("work", distressId)).toBe(false);
    expect(isStuckSentinelDistressKey("daemon", distressId)).toBe(false);
    expect(isStuckSentinelDistressKey("close", "fn-1-x")).toBe(false);
    // Disjoint from the daemon-verb distress surfaces (different verb).
    expect(
      isStuckSentinelDistressKey(CRASH_LOOP_DISTRESS_VERB, distressId),
    ).toBe(false);
  });

  test("the key is retryable — so retry_dispatch clears it AND the orphan-GC leaves it alone", () => {
    // Retryable ⇒ the boot orphan-GC (which only reaps UN-retryable keys) never
    // sweeps it, so nothing tidies it silently; the operator ack is the sole clear.
    expect(
      isRetryableDispatchKey(STUCK_SENTINEL_DISTRESS_VERB, distressId),
    ).toBe(true);
    // The synthetic id never collides with a real epic id (`fn-…`), so no real close
    // is suppressed and the reconciler's post-clear re-attempt finds nothing to do.
    expect(distressId.startsWith("fn-")).toBe(false);
  });

  test("the reason collapses to its own board pill kind", () => {
    expect(
      classifyDispatchFailure("stuck-sentinel: worker-done-while-working"),
    ).toBe("stuck-sentinel");
    expect(
      classifyDispatchFailure("stuck-sentinel: stale-working (clock-skew)"),
    ).toBe("stuck-sentinel");
    // The detect-only cwd-missing reason (ADR 0031) composes with the same
    // prefix rule — no display change needed for the new class.
    expect(classifyDispatchFailure("stuck-sentinel: cwd-missing")).toBe(
      "stuck-sentinel",
    );
    // Prefix-disjoint from every other display rule — no sibling shadows it.
    expect(classifyDispatchFailure("stale-base-lane: x")).toBe("stale-base");
  });

  test("the cwd-missing reason composes with the reason-agnostic sentinel key predicates", () => {
    // The cwd-missing row shares the close::stuck-sentinel:<jobId> key with every
    // other sentinel reason, so the key predicates and job-id extraction that key
    // off the id prefix (never the reason) cover it unchanged.
    const cwdMissingKey = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}sess-zombie`;
    expect(
      isStuckSentinelDistressKey(STUCK_SENTINEL_DISTRESS_VERB, cwdMissingKey),
    ).toBe(true);
    expect(stuckSentinelJobId(cwdMissingKey)).toBe("sess-zombie");
    expect(
      isRetryableDispatchKey(STUCK_SENTINEL_DISTRESS_VERB, cwdMissingKey),
    ).toBe(true);
  });
});
