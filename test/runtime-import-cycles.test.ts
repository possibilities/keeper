import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildProductionRuntimeGraph,
  buildRuntimeGraphFromSources,
  type CycleExceptionManifest,
  cyclicEdgeSets,
  DependencyGraphError,
  parseCycleExceptionManifest,
  type RuntimeGraph,
  repoRoot,
  runtimeCycleDiagnostics,
} from "./helpers/depgraph.ts";

const MANIFEST_PATH = resolve(
  repoRoot,
  "scripts/runtime-cycle-exceptions.json",
);

function graph(edges: Array<[string, string]>): RuntimeGraph {
  return {
    files: [...new Set(edges.flat())].sort(),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

function manifest(edges: Array<[string, string]>[]): CycleExceptionManifest {
  return parseCycleExceptionManifest(
    JSON.stringify({
      version: 1,
      exceptions: edges.map((exceptionEdges) => ({ edges: exceptionEdges })),
    }),
  );
}

const emptyManifest: CycleExceptionManifest = { version: 1, exceptions: [] };

describe("production runtime import cycles", () => {
  const production = buildProductionRuntimeGraph();
  const exceptions = parseCycleExceptionManifest(
    readFileSync(MANIFEST_PATH, "utf8"),
  );

  test("the production src graph is non-vacuous and anchored", () => {
    expect(production.files.length).toBeGreaterThan(100);
    expect(production.edges.length).toBeGreaterThan(200);
    expect(production.files).toContain("src/server-worker.ts");
    expect(production.files).toContain("src/rpc-handlers.ts");
    expect(production.files).toContain("src/restore-worker.ts");
    expect(production.files).toContain("src/tabs-core.ts");
    expect(production.edges).toContainEqual({
      from: "src/agent/config.ts",
      to: "src/agent/triple.ts",
    });
  });

  test("only the exact reviewed Agent configuration SCC is accepted", () => {
    expect(cyclicEdgeSets(production)).toEqual([
      "src/agent/config.ts -> src/agent/triple.ts | " +
        "src/agent/matrix.ts -> src/agent/config.ts | " +
        "src/agent/triple.ts -> src/agent/matrix.ts",
    ]);
    expect(runtimeCycleDiagnostics(production, exceptions)).toEqual([]);
  });
});

describe("exact cycle topology enforcement (injected)", () => {
  const server = "src/server-worker.ts";
  const rpc = "src/rpc-handlers.ts";
  const restore = "src/restore-worker.ts";
  const tabs = "src/tabs-core.ts";

  test("direct recurrence of either removed cycle fails", () => {
    for (const recurrence of [
      graph([
        [server, rpc],
        [rpc, server],
      ]),
      graph([
        [restore, tabs],
        [tabs, restore],
      ]),
    ]) {
      expect(runtimeCycleDiagnostics(recurrence, emptyManifest)).toEqual([
        expect.stringContaining("unexpected runtime cycle:"),
      ]);
    }
  });

  test("indirect recurrence through an intermediate fails", () => {
    const indirect = graph([
      [server, "src/rpc-contract.ts"],
      ["src/rpc-contract.ts", rpc],
      [rpc, server],
    ]);
    expect(runtimeCycleDiagnostics(indirect, emptyManifest)[0]).toContain(
      "src/rpc-contract.ts -> src/rpc-handlers.ts",
    );
  });

  test("an unrelated new SCC fails", () => {
    const unrelated = graph([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ]);
    expect(runtimeCycleDiagnostics(unrelated, emptyManifest)).toEqual([
      "unexpected runtime cycle: src/a.ts -> src/b.ts | src/b.ts -> src/a.ts",
    ]);
  });

  test("same SCC members with changed cyclic edges do not match", () => {
    const allowedEdges: Array<[string, string]> = [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/a.ts"],
    ];
    const changed = graph([
      ["src/a.ts", "src/c.ts"],
      ["src/c.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ]);
    expect(runtimeCycleDiagnostics(changed, manifest([allowedEdges]))).toEqual([
      expect.stringContaining("stale runtime cycle exception:"),
      expect.stringContaining("unexpected runtime cycle:"),
    ]);
  });

  test("a disappeared exception is stale", () => {
    const allowedEdges: Array<[string, string]> = [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ];
    const acyclic: RuntimeGraph = {
      files: ["src/a.ts", "src/b.ts"],
      edges: [{ from: "src/a.ts", to: "src/b.ts" }],
    };
    expect(runtimeCycleDiagnostics(acyclic, manifest([allowedEdges]))).toEqual([
      "stale runtime cycle exception: src/a.ts -> src/b.ts | src/b.ts -> src/a.ts",
    ]);
  });
});

describe("graph and exception inputs fail closed", () => {
  test("duplicate exceptions and duplicate edges are rejected", () => {
    const edges = [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ];
    expect(() =>
      parseCycleExceptionManifest(
        JSON.stringify({
          version: 1,
          exceptions: [{ edges }, { edges }],
        }),
      ),
    ).toThrow("duplicate cycle exception");
    expect(() =>
      parseCycleExceptionManifest(
        JSON.stringify({
          version: 1,
          exceptions: [{ edges: [edges[0], edges[0]] }],
        }),
      ),
    ).toThrow("duplicate edge in cycle exception");
  });

  test("malformed JSON, shape, paths, and non-cycles are rejected", () => {
    for (const raw of [
      "{",
      JSON.stringify({ version: 2, exceptions: [] }),
      JSON.stringify({ version: 1, exceptions: [], extra: true }),
      JSON.stringify({
        version: 1,
        exceptions: [{ edges: [["src/a.ts", "../src/b.ts"]] }],
      }),
      JSON.stringify({
        version: 1,
        exceptions: [{ edges: [["src/a.ts", "src/b.ts"]] }],
      }),
      JSON.stringify({
        version: 1,
        exceptions: [
          {
            edges: [
              ["src/a.ts", "src/b.ts"],
              ["src/b.ts", "src/a.ts"],
              ["src/c.ts", "src/a.ts"],
            ],
          },
        ],
      }),
    ]) {
      expect(() => parseCycleExceptionManifest(raw)).toThrow(
        DependencyGraphError,
      );
    }
  });

  test("an unresolved local import is rejected with a canonical diagnostic", () => {
    expect(() =>
      buildRuntimeGraphFromSources({
        "src/a.ts": 'import { b } from "./missing";\n',
      }),
    ).toThrow(
      'runtime dependency graph: src/a.ts: unresolved local import "./missing"',
    );
  });

  test("mixed type/value imports are runtime edges; type-only imports are not", () => {
    const mixed = buildRuntimeGraphFromSources({
      "src/a.ts": 'import { type BType, b } from "./b";\nvoid b;',
      "src/b.ts": 'import { a } from "./a";\nvoid a;',
    });
    expect(runtimeCycleDiagnostics(mixed, emptyManifest)[0]).toContain(
      "unexpected runtime cycle:",
    );

    const typeOnly = buildRuntimeGraphFromSources({
      "src/a.ts": 'import type { BType } from "./b";\n',
      "src/b.ts": 'import { a } from "./a";\nvoid a;',
    });
    expect(typeOnly.edges).toEqual([{ from: "src/b.ts", to: "src/a.ts" }]);
  });

  test("unsupported local dynamic and CommonJS imports are rejected", () => {
    for (const source of [
      'const module = import("./b");',
      'const module = require("./b");',
      'import module = require("./b");',
      "const module = `" + "$" + '{import("./b")}`;',
    ]) {
      expect(() =>
        buildRuntimeGraphFromSources({
          "src/a.ts": source,
          "src/b.ts": "export const b = 1;",
        }),
      ).toThrow("unsupported local");
    }
    expect(
      buildRuntimeGraphFromSources({
        "src/a.ts": 'const documentation = `import("./b")`;',
        "src/b.ts": "export const b = 1;",
      }).edges,
    ).toEqual([]);
  });
});
