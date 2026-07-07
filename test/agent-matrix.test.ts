/**
 * Host provider matrix (ADR 0010) — the dep-free loader + pure derivations and
 * the `keeper agent providers resolve|check` verbs. Fixture matrices under a
 * sandboxed config dir cover the valid roster (with aliases), the absent file,
 * and every fail-loud shape (unknown provider, claude overlap, dotted-leading
 * token, unknown key). Derivations and the CLI verbs assert against hand-computed
 * expected values, never a value re-derived by the code under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/agent/config";
import { main } from "../src/agent/main";
import {
  cellSet,
  driverFor,
  loadMatrix,
  type Matrix,
  nativeIdFor,
  providerCheckFindings,
  providerOrderFor,
  resolveModel,
} from "../src/agent/matrix";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-matrix-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeMatrix(body: string): string {
  const p = join(tmpDir, "matrix.yaml");
  writeFileSync(p, body);
  return p;
}

/** A valid roster: claude native (opus/sonnet), codex + pi both serving the
 *  wrapped gpt-5.5 (codex first = cheaper), codex aliasing it to a native id. */
const VALID_MATRIX = [
  "efforts:",
  "  - low",
  "  - high",
  "  - xhigh",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "  - name: codex",
  "    models:",
  "      - gpt-5.5: gpt-5.5-codex",
  "      - gpt-5-codex",
  "  - name: pi",
  "    models:",
  "      - gpt-5.5",
  "subagents:",
  "  - work",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "defaults:",
  "  stop_timeout_ms: 3600000",
  "  max_attempts: 5",
  "",
].join("\n");

/** Parse the shared fixture once per assertion group. */
function validMatrix(): Matrix {
  return loadMatrix(writeMatrix(VALID_MATRIX)) as Matrix;
}

describe("loadMatrix parsing", () => {
  test("an absent file returns null (fall back to embedded defaults)", () => {
    expect(loadMatrix(join(tmpDir, "nope.yaml"))).toBeNull();
  });

  test("an empty/whitespace file returns null", () => {
    expect(loadMatrix(writeMatrix("\n  \n"))).toBeNull();
  });

  test("a valid roster parses with aliases + defaults", () => {
    const m = validMatrix();
    expect(m.efforts).toEqual(["low", "high", "xhigh"]);
    expect(m.subagents).toEqual(["work"]);
    expect(m.wrapper_driver).toEqual({ model: "sonnet", effort: "high" });
    expect(m.defaults).toEqual({ stop_timeout_ms: 3600000, max_attempts: 5 });
    expect(m.providers.map((p) => p.name)).toEqual(["claude", "codex", "pi"]);
    // codex aliases gpt-5.5; gpt-5-codex is bare (native id === capability).
    const codex = m.providers.find((p) => p.name === "codex");
    expect(codex?.models.get("gpt-5.5")).toBe("gpt-5.5-codex");
    expect(codex?.models.get("gpt-5-codex")).toBe("gpt-5-codex");
    // pi serves gpt-5.5 with no alias.
    expect(
      m.providers.find((p) => p.name === "pi")?.models.get("gpt-5.5"),
    ).toBe("gpt-5.5");
  });

  test("absent defaults block applies the fixed fallbacks (7200000 / 2)", () => {
    const m = loadMatrix(
      writeMatrix(
        [
          "efforts:",
          "  - high",
          "providers:",
          "  - name: claude",
          "    models:",
          "      - opus",
          "subagents:",
          "  - work",
          "wrapper_driver:",
          "  model: sonnet",
          "  effort: high",
          "",
        ].join("\n"),
      ),
    ) as Matrix;
    expect(m.defaults).toEqual({ stop_timeout_ms: 7200000, max_attempts: 2 });
  });
});

describe("loadMatrix fail-loud shapes", () => {
  test("malformed YAML is fail-loud", () => {
    expect(() => loadMatrix(writeMatrix("providers: [unterminated\n"))).toThrow(
      ConfigError,
    );
  });

  test("an unknown top-level key is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: claude",
            "    models:",
            "      - opus",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "surprise: 1",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/Unknown top-level key 'surprise'/);
  });

  test("a provider name not in the harness registry is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: gemini",
            "    models:",
            "      - flash",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/provider name must be one of/);
  });

  test("a model under claude AND another provider is fail-loud (ambiguous driver)", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: claude",
            "    models:",
            "      - opus",
            "  - name: codex",
            "    models:",
            "      - opus",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/served by both claude and codex/);
  });

  test("a dotted-leading model token is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: codex",
            "    models:",
            "      - .hidden",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/no leading dot/);
  });

  test("a provider listed twice is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: codex",
            "    models:",
            "      - gpt-5.5",
            "  - name: codex",
            "    models:",
            "      - gpt-5-codex",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/listed more than once/);
  });

  test("two NON-claude providers sharing a model is allowed (pecking order)", () => {
    // codex + pi both serve gpt-5.5 in the valid fixture — no throw.
    expect(() => validMatrix()).not.toThrow();
  });
});

describe("pure derivations", () => {
  test("driverFor: claude membership is native, else wrapped", () => {
    const m = validMatrix();
    expect(driverFor(m, "opus")).toBe("native");
    expect(driverFor(m, "sonnet")).toBe("native");
    expect(driverFor(m, "gpt-5.5")).toBe("wrapped");
    // An unlisted model is wrapped (and unroutable).
    expect(driverFor(m, "never-heard-of-it")).toBe("wrapped");
  });

  test("providerOrderFor: roster order, claude excluded", () => {
    const m = validMatrix();
    // codex precedes pi in the roster → cost-ascending order.
    expect(providerOrderFor(m, "gpt-5.5")).toEqual(["codex", "pi"]);
    // gpt-5-codex is codex-only.
    expect(providerOrderFor(m, "gpt-5-codex")).toEqual(["codex"]);
    // A native model has no wrapped providers.
    expect(providerOrderFor(m, "opus")).toEqual([]);
    // An unlisted model routes nowhere.
    expect(providerOrderFor(m, "ghost")).toEqual([]);
  });

  test("nativeIdFor: alias target, else the capability token", () => {
    const m = validMatrix();
    expect(nativeIdFor(m, "codex", "gpt-5.5")).toBe("gpt-5.5-codex");
    expect(nativeIdFor(m, "pi", "gpt-5.5")).toBe("gpt-5.5");
    expect(nativeIdFor(m, "claude", "opus")).toBe("opus");
    // A provider that does not serve the model → null.
    expect(nativeIdFor(m, "codex", "opus")).toBeNull();
  });

  test("cellSet: distinct models in pecking-order first appearance, driver-tagged", () => {
    expect(cellSet(validMatrix())).toEqual([
      { model: "opus", driver: "native" },
      { model: "sonnet", driver: "native" },
      { model: "gpt-5.5", driver: "wrapped" },
      { model: "gpt-5-codex", driver: "wrapped" },
    ]);
  });

  test("resolveModel: wrapped model yields cost-ordered foreign candidates", () => {
    expect(resolveModel(validMatrix(), "gpt-5.5")).toEqual({
      driver: "wrapped",
      candidates: [
        {
          harness: "codex",
          model_id: "gpt-5.5-codex",
          preset_name: "codex-gpt-5.5",
        },
        { harness: "pi", model_id: "gpt-5.5", preset_name: "pi-gpt-5.5" },
      ],
    });
  });

  test("resolveModel: native model yields the single claude candidate", () => {
    expect(resolveModel(validMatrix(), "opus")).toEqual({
      driver: "native",
      candidates: [
        { harness: "claude", model_id: "opus", preset_name: "claude-opus" },
      ],
    });
  });

  test("resolveModel: an unlisted model is wrapped with no candidates (no_route)", () => {
    expect(resolveModel(validMatrix(), "ghost")).toEqual({
      driver: "wrapped",
      candidates: [],
    });
  });
});

describe("providerCheckFindings", () => {
  test("an unreachable provider binary is one finding", () => {
    const m = validMatrix();
    const findings = providerCheckFindings(
      m,
      new Set(),
      (harness) => harness !== "pi",
    );
    expect(findings).toEqual([
      { kind: "binary-unreachable", provider: "pi", binary: "pi" },
    ]);
  });

  test("a colliding hand-authored preset is one finding", () => {
    const m = validMatrix();
    const findings = providerCheckFindings(
      m,
      new Set(["codex-gpt-5.5"]),
      () => true,
    );
    expect(findings).toEqual([
      {
        kind: "preset-collision",
        preset: "codex-gpt-5.5",
        provider: "codex",
        model: "gpt-5.5",
      },
    ]);
  });

  test("a consistent roster has no findings", () => {
    expect(providerCheckFindings(validMatrix(), new Set(), () => true)).toEqual(
      [],
    );
  });
});

describe("providers resolve verb", () => {
  test("a wrapped model emits the cost-ordered candidate envelope (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
      matrix: validMatrix(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      model: "gpt-5.5",
      effort: "high",
      driver: "wrapped",
      candidates: [
        {
          harness: "codex",
          model_id: "gpt-5.5-codex",
          preset_name: "codex-gpt-5.5",
        },
        { harness: "pi", model_id: "gpt-5.5", preset_name: "pi-gpt-5.5" },
      ],
      defaults: { stop_timeout_ms: 3600000, max_attempts: 5 },
    });
  });

  test("a native model resolves to the claude candidate (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "opus", "xhigh"],
      rawArgv: true,
      matrix: validMatrix(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const env = JSON.parse(h.out.join(""));
    expect(env.driver).toBe("native");
    expect(env.candidates).toEqual([
      { harness: "claude", model_id: "opus", preset_name: "claude-opus" },
    ]);
  });

  test("an unroutable wrapped model exits with the no_route code (3)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "ghost", "high"],
      rawArgv: true,
      matrix: validMatrix(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(3);
    expect(JSON.parse(h.out.join("")).error).toBe("no_route");
    expect(h.err.join("")).toContain("no_route");
  });

  test("a bad model token exits 2", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "GPT_5", "high"],
      rawArgv: true,
      matrix: validMatrix(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("not a valid token");
  });

  test("a malformed matrix (ConfigError) exits 2", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
    });
    h.deps.loadMatrixFn = () => {
      throw new ConfigError("Unknown top-level key 'x' in /m.yaml");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("Unknown top-level key");
  });

  test("an absent matrix resolves every model native (byte-identical to today)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "anything-goes", "high"],
      rawArgv: true,
      matrix: null,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const env = JSON.parse(h.out.join(""));
    expect(env.driver).toBe("native");
    expect(env.candidates).toEqual([
      {
        harness: "claude",
        model_id: "anything-goes",
        preset_name: "claude-anything-goes",
      },
    ]);
    // The fixed default block rides an absent matrix.
    expect(env.defaults).toEqual({ stop_timeout_ms: 7200000, max_attempts: 2 });
  });
});

describe("providers check verb", () => {
  test("a consistent roster is clean (exit 0, no findings)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: validMatrix(),
      presetCatalog: { presets: {} },
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).findings).toEqual([]);
  });

  test("drift findings exit 9 with one line each", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: validMatrix(),
      presetCatalog: {
        presets: {
          "codex-gpt-5.5": {
            harness: "codex",
            model: null,
            effort: null,
            thinking: null,
            role: null,
          },
        },
      },
      providerReachable: (harness) => harness !== "pi",
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const kinds = JSON.parse(h.out.join("")).findings.map(
      (f: { kind: string }) => f.kind,
    );
    expect(kinds).toEqual(["binary-unreachable", "preset-collision"]);
  });

  test("an absent matrix is clean (exit 0, matrix_present false)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: null,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).matrix_present).toBe(false);
  });

  test("a malformed matrix is a tool error (exit 1)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
    });
    h.deps.loadMatrixFn = () => {
      throw new ConfigError("bad matrix");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(1);
    expect(h.err.join("")).toContain("bad matrix");
  });
});
