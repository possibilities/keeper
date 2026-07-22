/**
 * Unit tests for the pure `src/dispatch-failure-pill.ts` leaf module: the
 * `classifyDispatchFailure` reason→short-KIND map (ordered prefix rules +
 * never-empty fallback) and the `resolveFailureTarget` key→board-target join
 * (work=verbatim; bare + worktree-mode close keys; boundary-checked longest
 * match; path-keyed null-epic + zero-match → null). No socket / clock / DB.
 */

import { describe, expect, test } from "bun:test";
import {
  CRASH_LOOP_DISTRESS_REASON,
  CRASH_LOOP_DISTRESS_VERB,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_REASON,
  SHARED_DESYNC_DISTRESS_VERB,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_REASON,
  SHARED_WEDGE_DISTRESS_VERB,
} from "../src/dispatch-failure-key";
import {
  classifyDispatchFailure,
  resolveFailureTarget,
} from "../src/dispatch-failure-pill";

describe("classifyDispatchFailure", () => {
  test("maps the known worktree reasons to the short display vocab", () => {
    expect(classifyDispatchFailure("worktree-multi-repo")).toBe("multi-repo");
    expect(classifyDispatchFailure("worktree-finalize-conflict")).toBe(
      "merge-conflict",
    );
    expect(classifyDispatchFailure("worktree-recover-conflict")).toBe(
      "merge-conflict",
    );
    expect(classifyDispatchFailure("worktree-merge-conflict")).toBe(
      "merge-conflict",
    );
    expect(classifyDispatchFailure("worktree-recover-dirty-checkout")).toBe(
      "dirty-tree",
    );
    expect(classifyDispatchFailure("worktree-finalize-non-fast-forward")).toBe(
      "non-ff",
    );
  });

  test("classifies by prefix, ignoring a trailing multi-line detail dump", () => {
    const reason =
      "worktree-merge-conflict: merging keeper/epic/fn-1-a into main\nCONFLICT (content): README.md";
    expect(classifyDispatchFailure(reason)).toBe("merge-conflict");
  });

  test("maps the slot-occupancy reasons to their distinct display kinds", () => {
    expect(
      classifyDispatchFailure(
        "slot-reclaimed: reaping stopped close session (pane %7 zsh)",
      ),
    ).toBe("slot-reclaimed");
    expect(
      classifyDispatchFailure(
        "slot-occupied: stopped close session holds the slot (pane %7 claude)",
      ),
    ).toBe("slot-occupied");
    // Distinct kinds — selected for bounded reaping reads differently from occupied
    // (visibility-only), and neither collapses into a worktree kind.
    expect(classifyDispatchFailure("slot-reclaimed: x")).not.toBe(
      classifyDispatchFailure("slot-occupied: x"),
    );
  });

  test("keeps distinct operator actions distinct (no over-collapse)", () => {
    const kinds = new Set([
      classifyDispatchFailure("worktree-multi-repo"),
      classifyDispatchFailure("worktree-recover-dirty-checkout"),
      classifyDispatchFailure("worktree-finalize-non-fast-forward"),
      classifyDispatchFailure("worktree-merge-conflict"),
    ]);
    expect(kinds).toEqual(
      new Set(["multi-repo", "dirty-tree", "non-ff", "merge-conflict"]),
    );
  });

  test("maps the instant-death breaker reason to its own display kind (fn-1086)", () => {
    // Collision-free: the new reason is not a prefix of any existing rule, nor is
    // any existing prefix a prefix of it, so it classifies to its own kind.
    expect(classifyDispatchFailure("instant-death-breaker")).toBe(
      "instant-death",
    );
    expect(classifyDispatchFailure("instant-death-breaker")).not.toBe(
      classifyDispatchFailure("slot-reclaimed: x"),
    );
  });

  test("maps the crash-loop distress reason to its own display kind", () => {
    // The full minted reason carries a trailing detail dump; the prefix rule
    // classifies it to the crash-loop pill, distinct from every other kind.
    expect(
      classifyDispatchFailure(
        `${CRASH_LOOP_DISTRESS_REASON}: 8 daemon boots in 30min — restart-looping`,
      ),
    ).toBe("crash-loop");
    expect(classifyDispatchFailure(CRASH_LOOP_DISTRESS_REASON)).toBe(
      "crash-loop",
    );
    expect(classifyDispatchFailure(CRASH_LOOP_DISTRESS_REASON)).not.toBe(
      classifyDispatchFailure("instant-death-breaker"),
    );
  });

  test("the crash-loop distress row resolves to no board target (a global signal, not per-epic/task)", () => {
    // Its synthetic verb is neither work nor close, so it decorates no board row —
    // it surfaces purely as a needs_human count, never as a mis-attributed pill.
    expect(
      resolveFailureTarget(
        { verb: CRASH_LOOP_DISTRESS_VERB, id: "crash-loop", dir: "" },
        ["fn-1-a"],
      ),
    ).toBeNull();
  });

  test("a fatal-audit synthetic close row maps to its epic and its own pill kind", () => {
    // The typed synthetic id `close::fatal-audit:<epic>` strips to the epic (board target),
    // reason-disjoint from an ordinary `close::<epic>` failure, and reads its own pill.
    expect(
      resolveFailureTarget(
        { verb: "close", id: "fatal-audit:fn-7-a", dir: "" },
        ["fn-7-a"],
      ),
    ).toEqual({ kind: "epic", epicId: "fn-7-a" });
    expect(
      classifyDispatchFailure("fatal-audit: data loss in the migration"),
    ).toBe("fatal-audit");
  });

  test("maps the shared-checkout-wedge distress reason to its own display kind", () => {
    // The full minted reason carries a trailing recover-verdict dump; the prefix
    // rule classifies it to the shared-wedge pill, distinct from every other kind.
    expect(
      classifyDispatchFailure(
        `${SHARED_WEDGE_DISTRESS_REASON}: /repo has stayed mid-merge past the 5min recovery grace — Last recover verdict: worktree-recover-abort-failed: …`,
      ),
    ).toBe("shared-wedge");
    expect(classifyDispatchFailure(SHARED_WEDGE_DISTRESS_REASON)).toBe(
      "shared-wedge",
    );
    // Distinct from the sibling distress + the recover kinds (a different operator
    // response: hand-resolve the shared checkout, not retry a lane).
    for (const other of [
      CRASH_LOOP_DISTRESS_REASON,
      "worktree-recover-dirty-checkout",
      "worktree-recover-conflict",
    ]) {
      expect(classifyDispatchFailure(SHARED_WEDGE_DISTRESS_REASON)).not.toBe(
        classifyDispatchFailure(other),
      );
    }
  });

  test("a per-repo shared-checkout-wedge distress row resolves to no board target", () => {
    // Per-repo, but still a synthetic `daemon`-verb row — it surfaces as a
    // needs_human count, never a mis-attributed per-epic pill.
    expect(
      resolveFailureTarget(
        {
          verb: SHARED_WEDGE_DISTRESS_VERB,
          id: `${SHARED_WEDGE_DISTRESS_ID_PREFIX}abc123`,
          dir: "/repo",
        },
        ["fn-1-a"],
      ),
    ).toBeNull();
  });

  test("maps the shared-checkout-desync distress reason to its own display kind", () => {
    // The full minted reason carries a trailing blocker dump; the prefix rule classifies
    // it to the shared-desync pill, distinct from every other kind (a different operator
    // response: return the checkout to default so it carries the landed tip).
    expect(
      classifyDispatchFailure(
        `${SHARED_DESYNC_DISTRESS_REASON}: /repo has stayed DESYNCED past the 5min grace — Blocker: content-trailing (index/worktree differ from the default tip)`,
      ),
    ).toBe("shared-desync");
    expect(classifyDispatchFailure(SHARED_DESYNC_DISTRESS_REASON)).toBe(
      "shared-desync",
    );
    // Distinct from the sibling shared-checkout distress kinds + the recover kinds — the
    // shared-checkout-* rules share a stem but never shadow one another.
    for (const other of [
      SHARED_WEDGE_DISTRESS_REASON,
      "shared-checkout-dirty",
      CRASH_LOOP_DISTRESS_REASON,
      "worktree-recover-dirty-checkout",
    ]) {
      expect(classifyDispatchFailure(SHARED_DESYNC_DISTRESS_REASON)).not.toBe(
        classifyDispatchFailure(other),
      );
    }
  });

  test("a per-repo shared-checkout-desync distress row resolves to no board target", () => {
    // Per-repo synthetic `daemon`-verb row — surfaces as a needs_human count, never a
    // mis-attributed per-epic/task pill.
    expect(
      resolveFailureTarget(
        {
          verb: SHARED_DESYNC_DISTRESS_VERB,
          id: `${SHARED_DESYNC_DISTRESS_ID_PREFIX}abc123`,
          dir: "/repo",
        },
        ["fn-1-a"],
      ),
    ).toBeNull();
  });

  test("falls back to the leading token before the first : or whitespace", () => {
    expect(classifyDispatchFailure("some-novel-reason: detail")).toBe(
      "some-novel-reason",
    );
    expect(classifyDispatchFailure("bare-token")).toBe("bare-token");
    expect(classifyDispatchFailure("lead more words")).toBe("lead");
  });

  test("never returns an empty string — a degenerate reason yields `unknown`", () => {
    expect(classifyDispatchFailure("")).toBe("unknown");
    expect(classifyDispatchFailure(":leading-colon")).toBe("unknown");
    expect(classifyDispatchFailure(" leading-space")).toBe("unknown");
  });
});

describe("resolveFailureTarget", () => {
  const epicIds = ["fn-1-a", "fn-106", "fn-1061-foo", "fn-9-x"];

  test("a work row resolves to its task verbatim (epicIds unused)", () => {
    expect(
      resolveFailureTarget({ verb: "work", id: "fn-9-x.2", dir: "" }, []),
    ).toEqual({ kind: "task", taskId: "fn-9-x.2" });
  });

  test("an empty work id resolves to null", () => {
    expect(
      resolveFailureTarget({ verb: "work", id: "", dir: "" }, epicIds),
    ).toBeNull();
  });

  test("a bare close::<epic> resolves to that epic directly", () => {
    expect(
      resolveFailureTarget({ verb: "close", id: "fn-9-x", dir: "" }, epicIds),
    ).toEqual({ kind: "epic", epicId: "fn-9-x" });
  });

  test("a worktree-finalize close key resolves to its epic", () => {
    expect(
      resolveFailureTarget(
        { verb: "close", id: "worktree-finalize:fn-9-x-abc123", dir: "" },
        epicIds,
      ),
    ).toEqual({ kind: "epic", epicId: "fn-9-x" });
  });

  test("boundary-checked longest-match: fn-106 never claims an fn-1061 key", () => {
    // The fn-1061 key must resolve to fn-1061-foo (longest match), NOT fn-106.
    expect(
      resolveFailureTarget(
        { verb: "close", id: "worktree-finalize:fn-1061-foo-hash", dir: "" },
        epicIds,
      ),
    ).toEqual({ kind: "epic", epicId: "fn-1061-foo" });
    // A bare fn-106 key resolves to fn-106 (end-of-string boundary), not fn-1061.
    expect(
      resolveFailureTarget({ verb: "close", id: "fn-106", dir: "" }, epicIds),
    ).toEqual({ kind: "epic", epicId: "fn-106" });
  });

  test("a path-keyed recover row (/-leading remainder) → null", () => {
    expect(
      resolveFailureTarget(
        {
          verb: "close",
          id: "worktree-recover:/Users/mike/code/arthack",
          dir: "",
        },
        epicIds,
      ),
    ).toBeNull();
  });

  test("a slugged recover key that matches no epic → null (zero-match)", () => {
    expect(
      resolveFailureTarget(
        {
          verb: "close",
          id: "worktree-recover:Users-mike-code-arthack",
          dir: "",
        },
        epicIds,
      ),
    ).toBeNull();
  });

  test("a close key for an unknown epic → null", () => {
    expect(
      resolveFailureTarget(
        { verb: "close", id: "fn-404-ghost", dir: "" },
        epicIds,
      ),
    ).toBeNull();
  });

  test("an unknown verb → null", () => {
    expect(
      resolveFailureTarget({ verb: "plan", id: "fn-9-x", dir: "" }, epicIds),
    ).toBeNull();
  });
});
