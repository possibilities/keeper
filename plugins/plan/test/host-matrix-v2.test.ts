/**
 * Plan-island v2 host-matrix coverage (ADR 0036) — the `loadHostMatrixV2` loader
 * plus the fs/os-free `worker_cells.ts` leaf. Cross-island parity (this loader vs
 * the launcher island's `loadMatrixV2`) lives in the root `test/agent-matrix.test.ts`;
 * this file pins the plan island's own parse behavior + the leaf's boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilityOf as launcherCapabilityOf,
  loadMatrixV2,
  type MatrixConfigError,
  type MatrixV2,
  matrixV2EffortsFor,
} from "../../../src/agent/matrix.ts";
import * as fx from "../../../test/fixtures/matrix-v2";
import {
  capabilityOf,
  HostMatrixConfigError,
  type HostMatrixV2,
  hostMatrixV2EffortsFor,
  hostMatrixV2ProviderRoute,
  isValidTemplatePath,
  loadHostMatrixV2,
} from "../src/host_matrix.ts";
import {
  composeWorkerAgent,
  WORKERS_BASE,
  workerCellDir,
} from "../src/worker_cells.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-host-matrix-v2-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let matrixSeq = 0;
function writeMatrix(body: string): string {
  // A UNIQUE filename per call so a test writing several fixtures in one
  // expression gets distinct paths (never one file the last write clobbers).
  const p = join(tmpDir, `matrix-${matrixSeq++}.yaml`);
  writeFileSync(p, body);
  return p;
}

describe("loadHostMatrixV2 — valid parse", () => {
  test("a multi-provider roster reduces to the hand-computed projection", () => {
    const h = loadHostMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    const exp = fx.MULTI_PROVIDER_EXPECTED;
    expect(h.efforts).toEqual(exp.efforts);
    expect(h.subagentTemplates).toEqual(exp.subagentTemplates);
    expect(h.models).toEqual(exp.subagentModels);
    expect(Object.fromEntries(h.driverByModel)).toEqual(exp.drivers);
    expect(Object.fromEntries(h.effortsByModel)).toEqual(exp.effortsByModel);
    expect(h.shadowed).toEqual(exp.shadowed);
  });

  test("capabilityOf derives the basename; isValidTemplatePath guards traversal", () => {
    expect(capabilityOf("openai-codex/gpt-5.3-codex-spark")).toBe(
      "gpt-5.3-codex-spark",
    );
    expect(capabilityOf("opus")).toBe("opus");
    expect(isValidTemplatePath("template/agents/worker.md.tmpl")).toBe(true);
    expect(isValidTemplatePath("../x")).toBe(false);
    expect(isValidTemplatePath("/abs")).toBe(false);
  });

  test("named provider routes retain exact launch ids and allowed efforts, including shadows", () => {
    const h = loadHostMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    expect(hostMatrixV2ProviderRoute(h, "pi", "gpt-5.3-codex-spark")).toEqual({
      provider: "pi",
      capability: "gpt-5.3-codex-spark",
      launchId: "openai-codex/gpt-5.3-codex-spark",
      efforts: ["high", "xhigh"],
    });
    expect(hostMatrixV2ProviderRoute(h, "pi", "gpt-5.3-spark-preview")).toEqual(
      {
        provider: "pi",
        capability: "gpt-5.3-spark-preview",
        launchId: "gpt-5.3-spark-preview",
        efforts: ["medium"],
      },
    );
    expect(hostMatrixV2ProviderRoute(h, "pi", "opus")).toBeUndefined();
  });

  test("hostMatrixV2EffortsFor: per-capability list, else the top-level axis", () => {
    const h = loadHostMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    expect(hostMatrixV2EffortsFor(h, "gpt-5.3-codex-spark")).toEqual([
      "high",
      "xhigh",
    ]);
    expect(hostMatrixV2EffortsFor(h, "opus")).toEqual(["medium", "high"]);
    expect(hostMatrixV2EffortsFor(h, "unserved")).toEqual(["medium", "high"]);
  });
});

describe("loadHostMatrixV2 — retired keys + failure states", () => {
  test.each(fx.RETIRED_KEY_FIXTURES)(
    "rejects the retired '$key' key naming it",
    ({ key, body }) => {
      let caught: unknown;
      try {
        loadHostMatrixV2(writeMatrix(body));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HostMatrixConfigError);
      expect((caught as HostMatrixConfigError).state).toBe("schema-invalid");
      expect((caught as Error).message).toContain(`'${key}:'`);
    },
  );

  test("the four failure states are four distinct discriminants naming the fix", () => {
    const states = new Map<string, string>();
    const cases: [string, string][] = [
      [join(tmpDir, "gone.yaml"), "absent"],
      [writeMatrix(fx.UNPARSEABLE), "unparseable"],
      [writeMatrix(fx.VALID_BUT_EMPTY), "valid-but-empty"],
      [writeMatrix(fx.SCHEMA_INVALID), "schema-invalid"],
    ];
    for (const [path, expected] of cases) {
      try {
        loadHostMatrixV2(path);
      } catch (e) {
        const err = e as HostMatrixConfigError;
        expect(err).toBeInstanceOf(HostMatrixConfigError);
        expect(err.state).toBe(expected);
        expect(err.message).toContain("docs/examples/matrix.example.yaml");
        states.set(err.state, path);
      }
    }
    expect([...states.keys()].sort()).toEqual([
      "absent",
      "schema-invalid",
      "unparseable",
      "valid-but-empty",
    ]);
  });
});

describe("loadHostMatrixV2 — dedup + launch-only", () => {
  test("a same-provider basename collision errors at load", () => {
    expect(() =>
      loadHostMatrixV2(writeMatrix(fx.SAME_PROVIDER_COLLISION)),
    ).toThrow(/same-provider duplicate/);
  });

  test("a subagent_models entry no provider serves errors at load", () => {
    expect(() =>
      loadHostMatrixV2(writeMatrix(fx.SUBAGENT_MODEL_UNSERVED)),
    ).toThrow(/served by no provider/);
  });

  test("a provider model absent from subagent_models is launch-only, not a cell", () => {
    const h = loadHostMatrixV2(writeMatrix(fx.LAUNCH_ONLY));
    expect(h.models).toEqual(["gpt-5.5"]);
    expect(h.effortsByModel.has("gpt-5.5-preview")).toBe(true);
    expect(h.driverByModel.has("gpt-5.5-preview")).toBe(false);
  });
});

describe("worker_cells leaf module", () => {
  test("exports the cell-path helpers with the fixed convention", () => {
    expect(WORKERS_BASE).toBe("workers");
    expect(workerCellDir("opus", "max")).toBe("workers/opus-max");
  });

  test("composeWorkerAgent is a pure {model, effort} → agent compose over explicit axes", () => {
    const effortsFor = () => ["low", "high"] as const;
    const models = ["opus"];
    expect(composeWorkerAgent(effortsFor, models, null, "opus")).toBeNull();
    expect(composeWorkerAgent(effortsFor, models, "high", null)).toBeNull();
    expect(composeWorkerAgent(effortsFor, models, "high", "opus")).toBe(
      "plan:worker-opus-high",
    );
    expect(() =>
      composeWorkerAgent(effortsFor, models, "turbo", "opus"),
    ).toThrow(/unknown tier/);
    expect(() =>
      composeWorkerAgent(effortsFor, models, "high", "ghost"),
    ).toThrow(/unknown model/);
  });

  test("imports no node:fs or node:os (adoptable by the reconcile-core closure)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "worker_cells.ts"),
      "utf8",
    );
    // Comment-strip the line-oriented mentions before the import scan so the
    // header prose ("imports NO node:fs / node:os") is not a false positive.
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/from\s+["']node:fs["']/);
    expect(code).not.toMatch(/from\s+["']node:os["']/);
    expect(code).not.toMatch(/require\(\s*["']node:(fs|os)["']/);
  });
});

// ── cross-island parity (plan host_matrix.ts vs launcher matrix.ts) ──────────
//
// The parity CONTRACT: the plan island (this file, eemeli YAML 1.1) and the
// launcher island (`src/agent/matrix.ts`, Bun.YAML 1.2) must reduce every fixture
// to the same projection. This test can reach BOTH islands (the launcher island
// has no external package deps); the root `test/agent-matrix.test.ts` cannot reach
// the plan island (its `yaml` dep lives in the plan package), so the parity lives
// here.

/** The normalized projection both islands must agree on. */
function projectLauncher(m: MatrixV2) {
  return {
    efforts: m.efforts,
    subagentTemplates: m.subagentTemplates,
    subagentModels: m.subagentModels,
    drivers: Object.fromEntries(
      m.subagentModels.map((c) => [c, m.driverByModel.get(c)]),
    ),
    effortsByModel: Object.fromEntries(m.effortsByModel),
    shadowed: m.shadowed.map((s) => ({
      provider: s.provider,
      capability: s.capability,
      launchId: s.launchId,
      winner: s.winner,
    })),
    providerRoutes: m.providers.flatMap((provider) =>
      [...provider.models].map(([capability, launchId]) => ({
        provider: provider.name,
        capability,
        launchId,
        efforts:
          provider.modelEfforts.get(capability) ??
          provider.efforts ??
          m.efforts,
      })),
    ),
    agentPins: Object.fromEntries(m.agentPins),
  };
}

function projectPlan(h: HostMatrixV2) {
  return {
    efforts: h.efforts,
    subagentTemplates: h.subagentTemplates,
    subagentModels: h.models,
    drivers: Object.fromEntries(
      h.models.map((c) => [c, h.driverByModel.get(c)]),
    ),
    effortsByModel: Object.fromEntries(h.effortsByModel),
    shadowed: h.shadowed.map((s) => ({
      provider: s.provider,
      capability: s.capability,
      launchId: s.launchId,
      winner: s.winner,
    })),
    providerRoutes: [...h.providerRoutes.values()].flatMap((routes) =>
      [...routes.values()].map((route) => ({
        provider: route.provider,
        capability: route.capability,
        launchId: route.launchId,
        efforts: route.efforts,
      })),
    ),
    agentPins: Object.fromEntries(h.agentPins),
  };
}

describe("cross-island parity (launcher matrix.ts vs plan host_matrix.ts)", () => {
  test("both islands derive identical capabilities by basename", () => {
    for (const id of ["opus", "openai-codex/gpt-5.3-codex-spark", "a/b/c"]) {
      expect(capabilityOf(id)).toBe(launcherCapabilityOf(id));
    }
  });

  test.each(fx.VALID_FIXTURES)(
    "$name: both islands parse to the same projection",
    ({ body }) => {
      const path = writeMatrix(body);
      expect(projectPlan(loadHostMatrixV2(path))).toEqual(
        projectLauncher(loadMatrixV2(path)),
      );
    },
  );

  test.each(fx.SCHEMA_INVALID_FIXTURES)(
    "$name: both islands reject with the schema-invalid state",
    ({ body }) => {
      const path = writeMatrix(body);
      let launcherErr: unknown;
      let planErr: unknown;
      try {
        loadMatrixV2(path);
      } catch (e) {
        launcherErr = e;
      }
      try {
        loadHostMatrixV2(path);
      } catch (e) {
        planErr = e;
      }
      expect((launcherErr as MatrixConfigError).state).toBe("schema-invalid");
      expect((planErr as HostMatrixConfigError).state).toBe("schema-invalid");
    },
  );

  test("both islands agree on the four failure states", () => {
    const cases: [string, string][] = [
      [join(tmpDir, "gone-parity.yaml"), "absent"],
      [writeMatrix(fx.UNPARSEABLE), "unparseable"],
      [writeMatrix(fx.VALID_BUT_EMPTY), "valid-but-empty"],
      [writeMatrix(fx.SCHEMA_INVALID), "schema-invalid"],
    ];
    for (const [path, expected] of cases) {
      let launcherState: string | undefined;
      let planState: string | undefined;
      try {
        loadMatrixV2(path);
      } catch (e) {
        launcherState = (e as MatrixConfigError).state;
      }
      try {
        loadHostMatrixV2(path);
      } catch (e) {
        planState = (e as HostMatrixConfigError).state;
      }
      expect(launcherState).toBe(expected);
      expect(planState).toBe(expected);
    }
  });

  test("both islands resolve the same per-capability effort list", () => {
    const path = writeMatrix(fx.MULTI_PROVIDER);
    const m = loadMatrixV2(path);
    const h = loadHostMatrixV2(path);
    for (const cap of [
      "opus",
      "gpt-5.3-codex-spark",
      "gpt-5.3-spark-preview",
    ]) {
      expect(matrixV2EffortsFor(m, cap)).toEqual(
        hostMatrixV2EffortsFor(h, cap),
      );
    }
  });

  test("both islands accept the committed Claude/Pi example", () => {
    const examplePath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "docs",
      "examples",
      "matrix.example.yaml",
    );
    const host = loadHostMatrixV2(examplePath);
    const launcher = loadMatrixV2(examplePath);
    expect(host.models).toEqual(["opus", "sonnet", "gpt-5.3-codex-spark"]);
    expect(host.shadowed).toEqual([]);
    expect(launcher.providers.map((provider) => provider.name)).toEqual([
      "claude",
      "pi",
    ]);
  });
});
