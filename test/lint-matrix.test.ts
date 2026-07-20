/**
 * Trigger-set and dispatch coverage for the three staged-path-conditional
 * drift gates in `src/commit-work/lint-matrix.ts` (vendor-corpus,
 * model-guidance — which also covers the cross-provider equivalence map and
 * its parser — import-boundary). The underlying checks are proven correct
 * elsewhere (`plugins/prompt/test/vendored-corpus.test.ts`,
 * `plugins/plan/test/consistency-model-selector.test.ts`,
 * `plugins/plan/test/consistency-provider-equivalence.test.ts`,
 * `test/reconcile-core-depgraph.test.ts`) — this file proves ONLY that
 * `runScopedLint` fires the right stage on the right staged-path set, fires
 * none of them on an unrelated set, and reports a failure through the
 * standard `LintFailure` aggregation. `runScopedLint`'s injectable
 * `deps.runTool` seam keeps every case in-process (no subprocess spawn).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isModelGuidancePath,
  isPlanBoundaryPath,
  isVendorCorpusPath,
  LintFailure,
  runScopedLint,
  type ToolRunner,
} from "../src/commit-work/lint-matrix";

const REPO_ROOT = join(import.meta.dir, "..");

interface FakeCall {
  cmd: string[];
  cwd: string;
}

interface FakeResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** Records every invocation and answers via `respond` (default: success),
 * so dispatch + aggregation are provable without a real subprocess. */
function fakeRunTool(
  respond: (cmd: string[], cwd: string) => FakeResult = () => ({ code: 0 }),
): { runTool: ToolRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const runTool: ToolRunner = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    const r = respond(cmd, cwd);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runTool, calls };
}

describe("trigger-set predicates", () => {
  test("isVendorCorpusPath matches the vendored corpus tree and the two BAKE-guard skills only", () => {
    expect(isVendorCorpusPath("plugins/prompt/corpus/vendor.lock")).toBe(true);
    expect(
      isVendorCorpusPath("plugins/prompt/corpus/claude/_partials/x.md"),
    ).toBe(true);
    expect(isVendorCorpusPath("plugins/plan/skills/hack/SKILL.md")).toBe(true);
    expect(isVendorCorpusPath("plugins/plan/skills/panel/SKILL.md")).toBe(true);
    expect(isVendorCorpusPath("plugins/plan/skills/other/SKILL.md")).toBe(
      false,
    );
    expect(isVendorCorpusPath("plugins/prompt/src/vendor.ts")).toBe(false);
    expect(isVendorCorpusPath("README.md")).toBe(false);
  });

  test("isModelGuidancePath matches exactly the model-selector config", () => {
    expect(isModelGuidancePath("plugins/plan/model-selector.yaml")).toBe(true);
    expect(isModelGuidancePath("plugins/plan/other.yaml")).toBe(false);
    expect(isModelGuidancePath("model-selector.yaml")).toBe(false);
  });

  test("isModelGuidancePath also matches the references research-cache tree", () => {
    expect(
      isModelGuidancePath(
        "plugins/plan/skills/model-guidance/references/opus.md",
      ),
    ).toBe(true);
    expect(
      isModelGuidancePath(
        "plugins/plan/skills/model-guidance/references/sonnet.md",
      ),
    ).toBe(true);
    expect(
      isModelGuidancePath("plugins/plan/skills/model-guidance/SKILL.md"),
    ).toBe(false);
  });

  test("isModelGuidancePath also matches the provider-equivalence map and its parser", () => {
    expect(isModelGuidancePath("plugins/plan/provider-equivalence.yaml")).toBe(
      true,
    );
    expect(
      isModelGuidancePath("plugins/plan/src/provider_equivalence.ts"),
    ).toBe(true);
    expect(isModelGuidancePath("plugins/plan/other-equivalence.yaml")).toBe(
      false,
    );
    expect(isModelGuidancePath("plugins/plan/src/host_matrix.ts")).toBe(false);
  });

  test("isPlanBoundaryPath matches anything under plugins/plan/src/ only", () => {
    expect(isPlanBoundaryPath("plugins/plan/src/cli.ts")).toBe(true);
    expect(isPlanBoundaryPath("plugins/plan/src/verbs/done.ts")).toBe(true);
    expect(isPlanBoundaryPath("plugins/plan/test/cli.test.ts")).toBe(false);
    expect(isPlanBoundaryPath("plugins/plan/model-selector.yaml")).toBe(false);
    expect(isPlanBoundaryPath("src/reconcile-core.ts")).toBe(false);
  });
});

describe("runScopedLint — staged-path-conditional drift gates", () => {
  test("a corpus file staged fires only the vendor-corpus stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(["plugins/prompt/corpus/vendor.lock"], REPO_ROOT, {
      runTool,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "bun",
      join(REPO_ROOT, "scripts", "vendor-corpus.ts"),
      "--check",
    ]);
    expect(calls[0].cwd).toBe(REPO_ROOT);
  });

  test("a hack-skill BAKE-guard body staged also fires the vendor-corpus stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(["plugins/plan/skills/hack/SKILL.md"], REPO_ROOT, {
      runTool,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd[1]).toBe(
      join(REPO_ROOT, "scripts", "vendor-corpus.ts"),
    );
  });

  test("the model-selector config staged fires only the model-guidance stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(["plugins/plan/model-selector.yaml"], REPO_ROOT, {
      runTool,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "bun",
      join(REPO_ROOT, "plugins", "plan", "scripts", "model-guidance-check.ts"),
      "--check",
    ]);
  });

  test("a references-only staged edit fires only the model-guidance stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(
      ["plugins/plan/skills/model-guidance/references/opus.md"],
      REPO_ROOT,
      { runTool },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "bun",
      join(REPO_ROOT, "plugins", "plan", "scripts", "model-guidance-check.ts"),
      "--check",
    ]);
  });

  test("the provider-equivalence map staged fires only the model-guidance stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(["plugins/plan/provider-equivalence.yaml"], REPO_ROOT, {
      runTool,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "bun",
      join(REPO_ROOT, "plugins", "plan", "scripts", "model-guidance-check.ts"),
      "--check",
    ]);
  });

  test("the provider-equivalence parser staged also fires both the model-guidance and import-boundary drift gates (it sits under plugins/plan/src/)", async () => {
    // A real .ts path also fires the tsc/npm-lint arms (unrelated to the
    // staged-path-conditional drift gates this suite covers) — so this checks
    // the two drift-gate commands are AMONG the dispatched calls, not that
    // they are the only calls.
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(
      ["plugins/plan/src/provider_equivalence.ts"],
      REPO_ROOT,
      { runTool },
    );
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContainEqual([
      "bun",
      join(REPO_ROOT, "plugins", "plan", "scripts", "model-guidance-check.ts"),
      "--check",
    ]);
    expect(cmds).toContainEqual([
      "bun",
      "test",
      join(REPO_ROOT, "test", "reconcile-core-depgraph.test.ts"),
    ]);
  });

  test("a plan-package src file staged fires only the import-boundary stage", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(["plugins/plan/src/example.txt"], REPO_ROOT, {
      runTool,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([
      "bun",
      "test",
      join(REPO_ROOT, "test", "reconcile-core-depgraph.test.ts"),
    ]);
  });

  test("an unrelated staged set fires none of the three (zero added latency)", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(
      ["docs/notes.txt", "plugins/plan/skills/other/SKILL.md"],
      REPO_ROOT,
      { runTool },
    );
    expect(calls).toHaveLength(0);
  });

  test("a failing vendor-corpus check surfaces the standard LintFailure shape", async () => {
    const { runTool } = fakeRunTool(() => ({
      code: 1,
      stderr: "vendor-corpus: drifted\n",
    }));
    let caught: unknown;
    try {
      await runScopedLint(["plugins/prompt/corpus/vendor.lock"], REPO_ROOT, {
        runTool,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LintFailure);
    const failure = caught as LintFailure;
    expect(failure.linter).toBe("vendor-corpus");
    expect(failure.files).toEqual(["plugins/prompt/corpus/vendor.lock"]);
    expect(failure.stderr).toContain("vendor-corpus: drifted");
  });

  test("a failing import-boundary check surfaces the standard LintFailure shape", async () => {
    const { runTool } = fakeRunTool(() => ({
      code: 1,
      stderr: "reconcile-core.ts pure import boundary > fail\n",
    }));
    let caught: unknown;
    try {
      await runScopedLint(["plugins/plan/src/example.txt"], REPO_ROOT, {
        runTool,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LintFailure);
    const failure = caught as LintFailure;
    expect(failure.linter).toBe("import-boundary");
    expect(failure.files).toEqual(["plugins/plan/src/example.txt"]);
  });

  test("npm lint passes package-local relative file paths for root and nested packages", async () => {
    const { runTool, calls } = fakeRunTool();
    await runScopedLint(
      ["src/cli.ts", "plugins/plan/src/worker.ts"],
      REPO_ROOT,
      {
        runTool,
      },
    );

    const npmCalls = calls.filter((c) => c.cmd[0] === "npm");
    expect(npmCalls).toHaveLength(2);

    expect(npmCalls).toEqual([
      {
        cmd: ["npm", "run", "lint", "--", "src/cli.ts"],
        cwd: REPO_ROOT,
      },
      {
        cmd: ["npm", "run", "lint", "--", "src/worker.ts"],
        cwd: join(REPO_ROOT, "plugins", "plan"),
      },
    ]);

    expect(npmCalls[1].cmd).not.toContain("plugins/plan/src/worker.ts");
    expect(npmCalls[0].cmd).not.toContain("/plugins/plan/");
  });

  test('two simultaneous drift failures aggregate as linter="multiple" with labelled blocks', async () => {
    const { runTool } = fakeRunTool((cmd) => {
      if (cmd.some((c) => c.includes("vendor-corpus"))) {
        return { code: 1, stderr: "vendor-corpus: drifted\n" };
      }
      if (cmd.some((c) => c.includes("model-guidance-check"))) {
        return { code: 1, stderr: "model-guidance-check: drifted\n" };
      }
      return { code: 0 };
    });
    let caught: unknown;
    try {
      await runScopedLint(
        [
          "plugins/prompt/corpus/vendor.lock",
          "plugins/plan/model-selector.yaml",
        ],
        REPO_ROOT,
        { runTool },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LintFailure);
    const failure = caught as LintFailure;
    expect(failure.linter).toBe("multiple");
    expect(failure.stderr).toContain("--- vendor-corpus ---");
    expect(failure.stderr).toContain("--- model-guidance ---");
    expect(failure.files).toEqual([
      "plugins/prompt/corpus/vendor.lock",
      "plugins/plan/model-selector.yaml",
    ]);
  });

  test("KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES skips all three with a loud stderr warning", async () => {
    const prevEnv = process.env.KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES;
    const origWrite = process.stderr.write;
    const written: string[] = [];
    process.env.KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES = "1";
    process.stderr.write = ((s: string | Uint8Array) => {
      written.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runTool, calls } = fakeRunTool();
      await runScopedLint(
        [
          "plugins/prompt/corpus/vendor.lock",
          "plugins/plan/model-selector.yaml",
          "plugins/plan/src/example.txt",
        ],
        REPO_ROOT,
        { runTool },
      );
      expect(calls).toHaveLength(0);
      expect(written.join("")).toContain("KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES");
    } finally {
      process.stderr.write = origWrite;
      if (prevEnv === undefined) {
        delete process.env.KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES;
      } else {
        process.env.KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES = prevEnv;
      }
    }
  });
});
