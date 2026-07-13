import { expect, test } from "bun:test";
import {
  buildConflictClassificationReport,
  classifyConflictIncident,
  type DispatchFailedIncident,
  decodeDispatchFailedPayload,
} from "../scripts/conflict-classification-report";

test("classifies literal producer conflict reasons and excludes non-conflicts", () => {
  // These are hand-written literal instances of the producer's three reason
  // shapes. Expected buckets are ground truth, not derived from the regex.
  expect(
    classifyConflictIncident(
      "worktree-finalize-conflict: merging keeper/epic/fn-77 into main — CONFLICT (content): Merge conflict in src/db.ts",
    ),
  ).toBe("base-drift");
  expect(
    classifyConflictIncident(
      "worktree-merge-conflict: merging main into keeper/epic/fn-77 — CONFLICT (content): Merge conflict in src/reducer.ts",
    ),
  ).toBe("base-drift");
  expect(
    classifyConflictIncident(
      "worktree-merge-conflict: merging keeper/epic/fn-77--fn-77.2 into keeper/epic/fn-77--fn-77.3 — CONFLICT (content): Merge conflict in src/worktree-plan.ts",
    ),
  ).toBe("file-overlap");
  expect(
    classifyConflictIncident(
      "worktree-merge-conflict: merge output unavailable",
    ),
  ).toBe("other");
  expect(
    classifyConflictIncident("worktree-finalize-non-fast-forward: main"),
  ).toBe("not-a-conflict");
  expect(classifyConflictIncident("cwd-missing")).toBe("not-a-conflict");
});

test("reports the historical split, refresh-conflict proxy, and cutover counts", () => {
  const incidents: DispatchFailedIncident[] = [
    {
      id: "close::fn-77",
      verb: "close",
      reason:
        "worktree-finalize-conflict: merging keeper/epic/fn-77 into main — CONFLICT (content): Merge conflict in src/db.ts",
      dir: "/repo",
      conflictedFiles: ["src/db.ts"],
      ts: 1_000,
    },
    {
      id: "work::fn-77.2",
      verb: "work",
      reason:
        "worktree-merge-conflict: merging main into keeper/epic/fn-77 — CONFLICT (content): Merge conflict in src/reducer.ts",
      dir: "/repo",
      conflictedFiles: ["src/reducer.ts", "test/reducer.test.ts"],
      ts: 2_000,
    },
    {
      id: "work::fn-77.3",
      verb: "work",
      reason:
        "worktree-merge-conflict: merging keeper/epic/fn-77--fn-77.2 into keeper/epic/fn-77--fn-77.3 — CONFLICT (content): Merge conflict in src/worktree-plan.ts",
      dir: "/repo",
      conflictedFiles: null,
      ts: 3_000,
    },
    {
      id: "work::fn-77.4",
      verb: "work",
      reason: "worktree-merge-conflict: merge output unavailable",
      dir: "/repo",
      conflictedFiles: [],
      ts: 4_000,
    },
    {
      id: "work::fn-77.5",
      verb: "work",
      reason: "cwd-missing",
      dir: "/repo",
      conflictedFiles: ["not-counted.ts"],
      ts: 5_000,
    },
  ];

  const report = buildConflictClassificationReport(incidents, {
    gateEnabled: true,
    sinceMs: 2_500_000,
  });

  // Four conflict-shaped incidents: 2 base drift, 1 fan-in file overlap, and
  // 1 known-prefix-but-unparseable future shape. cwd-missing is excluded.
  expect(report.totalConflictIncidents).toBe(4);
  expect(report.baseDrift).toEqual({ count: 2, percentage: 50 });
  expect(report.fileOverlap).toEqual({ count: 1, percentage: 25 });
  expect(report.other).toEqual({ count: 1, percentage: 25 });
  // Structured payload observations exclude cwd-missing and include the empty
  // structured list for the unclassified conflict.
  expect(report.incidentsWithConflictedFiles).toBe(3);
  expect(report.conflictedFilePaths).toBe(3);
  // Only the default-branch-to-base merge is a failed refresh attempt.
  expect(report.refreshConflictCount).toBe(1);
  expect(report.beforeAfterBaseDrift).toEqual({
    sinceMs: 2_500_000,
    beforeCount: 2,
    afterCount: 0,
  });
});

test("does not claim gate-only proxies when the gate is disabled", () => {
  const report = buildConflictClassificationReport(
    [
      {
        id: "work::fn-88.1",
        verb: "work",
        reason:
          "worktree-merge-conflict: merging main into keeper/epic/fn-88 — CONFLICT (content): Merge conflict in src/index.ts",
        dir: null,
        conflictedFiles: ["src/index.ts"],
        ts: 9_000,
      },
    ],
    { gateEnabled: false, sinceMs: 5_000 },
  );

  expect(report.baseDrift).toEqual({ count: 1, percentage: 100 });
  expect(report.refreshConflictCount).toBeNull();
  expect(report.beforeAfterBaseDrift).toBeNull();
});

test("defensively decodes structured historical payloads and skips malformed data", () => {
  expect(
    decodeDispatchFailedPayload(
      JSON.stringify({
        id: "work::fn-90.1",
        verb: "work",
        reason:
          "worktree-merge-conflict: merging main into keeper/epic/fn-90 — conflict",
        dir: "",
        conflictedFiles: ["src/a.ts", 7, "src/b.ts"],
        ts: 12_345,
      }),
    ),
  ).toEqual({
    id: "work::fn-90.1",
    verb: "work",
    reason:
      "worktree-merge-conflict: merging main into keeper/epic/fn-90 — conflict",
    dir: null,
    conflictedFiles: ["src/a.ts", "src/b.ts"],
    ts: 12_345,
  });
  expect(decodeDispatchFailedPayload("{not-json")).toBeNull();
  expect(
    decodeDispatchFailedPayload(
      JSON.stringify({ id: "missing-fields", reason: "cwd-missing", ts: 1 }),
    ),
  ).toBeNull();
});
