/**
 * Pure-shaping tests for the shared needs-human projector (`src/needs-human.ts`).
 * The module reads no socket / clock / DB, so hand-written `dispatch_failures`
 * row literals pin every count, the operator-jam class, the most-specific per-row
 * classification, the wall-threshold verdict, and the signature's
 * stability/change behavior — each expected value hand-computed from the reason
 * literal, never re-derived by the code under test.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyNeedsHumanRow,
  INSTANT_DEATH_WALL_KEYS,
  type NeedsHumanInputs,
  type NeedsHumanRow,
  projectNeedsHuman,
} from "../src/needs-human";

// ---------------------------------------------------------------------------
// Fixture helpers — plain Row-shaped literals (the status.test.ts convention).
// ---------------------------------------------------------------------------

function row(verb: string, id: string, reason: string): NeedsHumanRow {
  return { verb, id, reason };
}

function inputs(o: Partial<NeedsHumanInputs> = {}): NeedsHumanInputs {
  return {
    dispatchFailures: o.dispatchFailures ?? [],
    deadLetters: o.deadLetters ?? 0,
    blockEscalations: o.blockEscalations ?? 0,
    parkedQuestionEpicIds: o.parkedQuestionEpicIds ?? [],
    epicIds: o.epicIds ?? [],
  };
}

// The reason literals under test (byte-for-byte the vocabulary strings).
const R_FINALIZE_NON_FF = "worktree-finalize-non-fast-forward";
const R_BREAKER = "instant-death-breaker";
const R_MERGE_CONFLICT = "worktree-merge-conflict: merging X into Y — boom";
const R_RECOVER = "worktree-recover-conflict";
const R_MULTI_REPO = "worktree-multi-repo";

// ---------------------------------------------------------------------------
// Per-row classification — each row lands in exactly one bucket.
// ---------------------------------------------------------------------------

describe("classifyNeedsHumanRow", () => {
  test("finalize-non-ff reason classifies as finalize-non-ff", () => {
    expect(classifyNeedsHumanRow(R_FINALIZE_NON_FF)).toBe("finalize-non-ff");
  });

  test("instant-death-breaker reason classifies as instant-death-breaker", () => {
    expect(classifyNeedsHumanRow(R_BREAKER)).toBe("instant-death-breaker");
  });

  test("every other reason classifies as other", () => {
    expect(classifyNeedsHumanRow(R_MERGE_CONFLICT)).toBe("other");
    expect(classifyNeedsHumanRow(R_RECOVER)).toBe("other");
    expect(classifyNeedsHumanRow(R_MULTI_REPO)).toBe("other");
    expect(classifyNeedsHumanRow("")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Broad count vs the narrow operator-jam class.
// ---------------------------------------------------------------------------

describe("broad stuck count vs operator-jam class", () => {
  test("stuckDispatches is every row; jamCount is only the non-self-clearing ones", () => {
    // 4 sticky rows. Jams (cannot self-clear): finalize-non-ff + merge-conflict.
    // NOT jams: the breaker (a per-key breaker doing its job) and recover* (self-
    // clears level-triggered). Hand-computed jamCount = 2.
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("close", "fn-1-a", R_FINALIZE_NON_FF),
          row("close", "fn-2-b", R_MERGE_CONFLICT),
          row("work", "fn-3-c.1", R_BREAKER),
          row("close", "fn-4-d", R_RECOVER),
        ],
      }),
    );
    expect(p.counts.stuckDispatches).toBe(4);
    expect(p.jamCount).toBe(2);
    // The per-row jam bit itself, row by row.
    expect(p.rows.map((r) => r.isJam)).toEqual([true, true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// Most-specific single classification per row — counts partition the rows.
// ---------------------------------------------------------------------------

describe("most-specific per-row classification", () => {
  test("each row classifies exactly once; the three buckets partition stuckDispatches", () => {
    const rows = [
      row("close", "fn-1-a", R_FINALIZE_NON_FF), // finalize-non-ff
      row("work", "fn-2-b.1", R_BREAKER), // instant-death-breaker
      row("work", "fn-2-b.2", R_BREAKER), // instant-death-breaker
      row("close", "fn-3-c", R_MERGE_CONFLICT), // other
      row("close", "fn-4-d", R_RECOVER), // other
    ];
    const p = projectNeedsHuman(inputs({ dispatchFailures: rows }));
    expect(p.rows.map((r) => r.cls)).toEqual([
      "finalize-non-ff",
      "instant-death-breaker",
      "instant-death-breaker",
      "other",
      "other",
    ]);
    // Hand-computed: 1 finalize + 2 breaker + 2 other = 5 = stuckDispatches.
    expect(p.counts.finalizeNonFf).toBe(1);
    expect(p.counts.instantDeathWall).toBe(2);
    const others = p.rows.filter((r) => r.cls === "other").length;
    expect(p.counts.finalizeNonFf + p.counts.instantDeathWall + others).toBe(
      p.counts.stuckDispatches,
    );
  });
});

// ---------------------------------------------------------------------------
// Subset non-double-count — finalize-non-ff and the wall are subsets of stuck.
// ---------------------------------------------------------------------------

describe("umbrella total honors the subset non-double-count rule", () => {
  test("finalize-non-ff is not added on top of stuck_dispatches", () => {
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("close", "fn-1-a", R_FINALIZE_NON_FF),
          row("close", "fn-2-b", R_MERGE_CONFLICT),
        ],
      }),
    );
    // 2 stuck rows, one a finalize-non-ff subset → total is 2, NOT 3.
    expect(p.counts.stuckDispatches).toBe(2);
    expect(p.counts.finalizeNonFf).toBe(1);
    expect(p.counts.total).toBe(2);
  });

  test("instant-death-breaker rows are not added on top of stuck_dispatches", () => {
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("work", "fn-1-a.1", R_BREAKER),
          row("work", "fn-2-b.3", R_BREAKER),
          row("close", "fn-3-c", R_MERGE_CONFLICT),
        ],
      }),
    );
    // 3 stuck rows, two a breaker subset → total is 3, NOT 5.
    expect(p.counts.stuckDispatches).toBe(3);
    expect(p.counts.instantDeathWall).toBe(2);
    expect(p.counts.total).toBe(3);
  });

  test("the non-dispatch families each add exactly once", () => {
    // deadLetters(2) + blockEscalations(1) + stuck(0) + parked(1) = 4.
    const p = projectNeedsHuman(
      inputs({
        deadLetters: 2,
        blockEscalations: 1,
        parkedQuestionEpicIds: ["fn-9-x"],
      }),
    );
    expect(p.counts.total).toBe(4);
    expect(p.counts.parkedQuestions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wall-threshold verdict at the boundary (1 vs 2 breaker keys).
// ---------------------------------------------------------------------------

describe("instant-death-wall threshold verdict", () => {
  test("the threshold constant is 2", () => {
    expect(INSTANT_DEATH_WALL_KEYS).toBe(2);
  });

  test("one breaker key is below the wall (a single breaker doing its job)", () => {
    const p = projectNeedsHuman(
      inputs({ dispatchFailures: [row("work", "fn-1-a.1", R_BREAKER)] }),
    );
    expect(p.counts.instantDeathWall).toBe(1);
    expect(p.instantDeathWallTripped).toBe(false);
  });

  test("two breaker keys trip the board-wide wall", () => {
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("work", "fn-1-a.1", R_BREAKER),
          row("work", "fn-2-b.3", R_BREAKER),
        ],
      }),
    );
    expect(p.counts.instantDeathWall).toBe(2);
    expect(p.instantDeathWallTripped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signature — stable under reordering, changes on any add / clear.
// ---------------------------------------------------------------------------

describe("needs-human signature", () => {
  const base: NeedsHumanRow[] = [
    row("close", "fn-1-a", R_FINALIZE_NON_FF),
    row("work", "fn-2-b.1", R_BREAKER),
    row("close", "fn-3-c", R_MERGE_CONFLICT),
  ];

  test("is invariant under row reordering", () => {
    const a = projectNeedsHuman(inputs({ dispatchFailures: base })).signature;
    const reordered = [base[2], base[0], base[1]] as NeedsHumanRow[];
    const b = projectNeedsHuman(
      inputs({ dispatchFailures: reordered }),
    ).signature;
    expect(b).toBe(a);
  });

  test("changes when a row is added", () => {
    const a = projectNeedsHuman(inputs({ dispatchFailures: base })).signature;
    const b = projectNeedsHuman(
      inputs({
        dispatchFailures: [...base, row("close", "fn-4-d", R_RECOVER)],
      }),
    ).signature;
    expect(b).not.toBe(a);
  });

  test("changes when a row is cleared", () => {
    const a = projectNeedsHuman(inputs({ dispatchFailures: base })).signature;
    const b = projectNeedsHuman(
      inputs({ dispatchFailures: base.slice(0, 2) }),
    ).signature;
    expect(b).not.toBe(a);
  });

  test("changes when a parked question is added", () => {
    const a = projectNeedsHuman(inputs({ dispatchFailures: base })).signature;
    const b = projectNeedsHuman(
      inputs({ dispatchFailures: base, parkedQuestionEpicIds: ["fn-9-x"] }),
    ).signature;
    expect(b).not.toBe(a);
  });

  test("changes when a dead-letter or block-escalation count moves", () => {
    const a = projectNeedsHuman(inputs({ dispatchFailures: base })).signature;
    const dl = projectNeedsHuman(
      inputs({ dispatchFailures: base, deadLetters: 1 }),
    ).signature;
    const be = projectNeedsHuman(
      inputs({ dispatchFailures: base, blockEscalations: 1 }),
    ).signature;
    expect(dl).not.toBe(a);
    expect(be).not.toBe(a);
  });

  test("a same-key reason reclassification moves the signature", () => {
    // Same (verb, id), reason flips other → finalize-non-ff: the row's class
    // changes, so the signature must move even though the key set is identical.
    const a = projectNeedsHuman(
      inputs({ dispatchFailures: [row("close", "fn-1-a", R_MERGE_CONFLICT)] }),
    ).signature;
    const b = projectNeedsHuman(
      inputs({ dispatchFailures: [row("close", "fn-1-a", R_FINALIZE_NON_FF)] }),
    ).signature;
    expect(b).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Target resolution — hashed worktree close keys resolve to their epic (Gap A);
// never naive epic-id string matching.
// ---------------------------------------------------------------------------

describe("per-row target resolution (via resolveFailureTarget)", () => {
  test("a work row resolves to its task", () => {
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [row("work", "fn-9-x.1", R_MULTI_REPO)],
        epicIds: ["fn-9-x"],
      }),
    );
    expect(p.rows[0]?.target).toEqual({ kind: "task", taskId: "fn-9-x.1" });
  });

  test("a hashed worktree-finalize close key resolves to its epic (Gap A)", () => {
    // The close key is `worktree-finalize:fn-9-x-h1` — a naive `.get(epicId)`
    // would miss the hashed suffix; resolveFailureTarget strips the prefix and
    // boundary-matches the epic.
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("close", "worktree-finalize:fn-9-x-h1", R_FINALIZE_NON_FF),
        ],
        epicIds: ["fn-9-x"],
      }),
    );
    expect(p.rows[0]?.target).toEqual({ kind: "epic", epicId: "fn-9-x" });
  });

  test("a path-keyed null-epic recover row resolves to null (dropped, not thrown)", () => {
    const p = projectNeedsHuman(
      inputs({
        dispatchFailures: [
          row("close", "worktree-recover:/Users/mike/code/other", R_RECOVER),
        ],
        epicIds: ["fn-9-x"],
      }),
    );
    expect(p.rows[0]?.target).toBeNull();
    // Still counted in the broad stuck total — target null only drops the pill.
    expect(p.counts.stuckDispatches).toBe(1);
  });
});
