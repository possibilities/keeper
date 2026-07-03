/**
 * The dispatch-failure classifier is a semantics-PRESERVING router: it must route
 * every minted `dispatch_failures` shape exactly as the three pre-refactor
 * predicates did (the recover reason scope, the finalize id scope, the
 * merge-escalation exact-token gate). These tests pin that identity over the full
 * minted catalog + fuzzed near-misses, the historical recover/finalize collision
 * shapes, and the assertNever exhaustiveness tripwire.
 */

import { describe, expect, test } from "bun:test";
import {
  assertNever,
  DISPATCH_FAILURE_DISPLAY_RULES,
  type DispatchFailureIdentity,
  isMergeEscalationReason,
  isSlotOccupancyReason,
  isWorktreeRecoverReason,
  leadingReasonToken,
  MERGE_ESCALATION_REASON_TOKEN,
  routeDispatchFailure,
  SLOT_OCCUPIED_REASON_PREFIX,
  SLOT_RECLAIMED_REASON_PREFIX,
  WORKTREE_CLOSE_KEY_PREFIXES,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_FINALIZE_NON_FF_REASON,
  WORKTREE_RECOVER_KEY_PREFIX,
  WORKTREE_RECOVER_REASON_PREFIX,
} from "../src/dispatch-failure-key";

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
      ["worktree-finalize-conflict", "merge-conflict"],
      ["worktree-recover-conflict", "merge-conflict"],
      ["worktree-recover-dirty-checkout", "dirty-tree"],
      ["worktree-merge-conflict", "merge-conflict"],
      ["slot-reclaimed", "slot-reclaimed"],
      ["slot-occupied", "slot-occupied"],
      ["instant-death-breaker", "instant-death"],
    ]);
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
