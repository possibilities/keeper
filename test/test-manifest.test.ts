import { describe, expect, test } from "bun:test";
import {
  auditTestManifest,
  buildTimingReport,
  classifyTestFile,
  discoverTests,
  emitTimingArtifacts,
  ManifestError,
  renderTimingJunit,
  TEST_BUDGETS,
  TEST_MANIFEST,
  type TestManifest,
  timingBudgetFailure,
} from "../scripts/test-manifest";

const FILES = [
  "test/a.test.ts",
  "test/ansi-to-styled.test.ts",
  "test/live-shell.test.ts",
  "test/dash-app.test.ts",
  "test/dash-shell.test.ts",
  "plugins/plan/test/a.test.ts",
  "plugins/prompt/test/a.test.ts",
];

describe("test manifest classification", () => {
  test("maps every discovered file to one required phase", () => {
    const audit = auditTestManifest(FILES, TEST_MANIFEST, () => true);
    expect(audit.files.root).toEqual(["test/a.test.ts"]);
    expect(audit.files.opentui).toHaveLength(4);
    expect(audit.files.plan).toEqual(["plugins/plan/test/a.test.ts"]);
    expect(audit.files.prompt).toEqual(["plugins/prompt/test/a.test.ts"]);
  });

  test("fails closed on zero discovery, omission, missing required file, and zero phase", () => {
    expect(() => auditTestManifest([], TEST_MANIFEST)).toThrow(ManifestError);
    expect(() =>
      auditTestManifest(
        [...FILES, "other/a.test.ts"],
        TEST_MANIFEST,
        () => true,
      ),
    ).toThrow("unclassified");
    expect(() =>
      auditTestManifest(
        FILES,
        TEST_MANIFEST,
        (path) => path !== "test/live-shell.test.ts",
      ),
    ).toThrow("required OpenTUI file is missing");
    expect(() =>
      auditTestManifest(
        FILES.filter((path) => !path.startsWith("plugins/prompt/")),
        TEST_MANIFEST,
        () => true,
      ),
    ).toThrow("zero files: prompt");
  });

  test("fails closed on overlapping package classifiers", () => {
    const overlap: TestManifest = {
      ...TEST_MANIFEST,
      packages: [
        ...TEST_MANIFEST.packages,
        {
          phase: "plan",
          name: "duplicate",
          cwd: ".",
          testDir: "test",
          packageJson: "package.json",
        },
      ],
    };
    expect(classifyTestFile("test/a.test.ts", overlap)).toEqual([
      "root",
      "plan",
    ]);
    expect(() => auditTestManifest(FILES, overlap, () => true)).toThrow(
      "overlapping classifications",
    );
  });

  test("fails before discovery when a required package is absent", () => {
    expect(() => discoverTests("/definitely-not-a-keeper-checkout")).toThrow(
      "required package is missing",
    );
  });
});

describe("timing contract", () => {
  const qualification = { qualified: true, reasons: [] };
  const report = (endedMs: number, enforceBudget: boolean) =>
    buildTimingReport({
      gate: "gate",
      startedMs: 1_000,
      endedMs,
      stages: [
        { name: "root", startedMs: 1_000, endedMs, ok: true, reason: "passed" },
      ],
      enforceBudget,
      qualification,
    });

  test("pins objectives, hard ceilings, and distinct hang deadlines", () => {
    expect(TEST_BUDGETS).toEqual({
      gate: {
        objectiveMs: 10_000,
        hardCeilingMs: 15_000,
        hangDeadlineMs: 120_000,
      },
      default: {
        objectiveMs: 12_000,
        hardCeilingMs: 18_000,
        hangDeadlineMs: 180_000,
      },
      full: {
        objectiveMs: 20_000,
        hardCeilingMs: 30_000,
        hangDeadlineMs: 300_000,
      },
    });
  });

  test("hard-ceiling boundary is inclusive and one millisecond over fails only when enforced", () => {
    expect(timingBudgetFailure(report(16_000, true))).toBeNull();
    expect(timingBudgetFailure(report(16_001, false))).toBeNull();
    expect(timingBudgetFailure(report(16_001, true))).toContain("hard ceiling");
  });

  test("emits bounded machine-readable JSON and JUnit records", () => {
    const current = report(2_000, false);
    const chunks: string[] = [];
    emitTimingArtifacts(
      current,
      {
        write: (chunk) => {
          chunks.push(String(chunk));
          return true;
        },
      },
      undefined,
    );
    expect(
      JSON.parse(chunks[0].replace("[test-timing-json] ", "")).schema,
    ).toBe("keeper.test-timing.v1");
    expect(renderTimingJunit(current)).toContain(
      '<testsuite name="keeper-gate"',
    );
    expect(chunks.join("")).toContain("[test-timing-junit] <?xml");
  });

  test("an unsupported reference environment fails explicitly", () => {
    const unsupported = buildTimingReport({
      gate: "full",
      startedMs: 0,
      endedMs: 1,
      stages: [],
      enforceBudget: true,
      qualification: { qualified: false, reasons: ["platform=linux"] },
    });
    expect(unsupported.enforcement).toBe("unsupported-reference");
    expect(timingBudgetFailure(unsupported)).toContain(
      "qualified reference host",
    );
  });

  test("rejects non-monotonic stage and total boundaries", () => {
    expect(() =>
      buildTimingReport({
        gate: "gate",
        startedMs: 2,
        endedMs: 1,
        stages: [],
        enforceBudget: false,
        qualification,
      }),
    ).toThrow("non-monotonic total");
    expect(() =>
      buildTimingReport({
        gate: "gate",
        startedMs: 0,
        endedMs: 10,
        stages: [
          { name: "a", startedMs: 0, endedMs: 7, ok: true, reason: "passed" },
          { name: "b", startedMs: 6, endedMs: 9, ok: true, reason: "passed" },
        ],
        enforceBudget: false,
        qualification,
      }),
    ).toThrow("non-monotonic stage");
  });
});
