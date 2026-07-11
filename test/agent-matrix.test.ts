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
  capabilityOf,
  cellSet,
  driverFor,
  effortsFor,
  isValidMatrixAliasTarget,
  isValidMatrixToken,
  isValidTemplatePath,
  loadMatrix,
  loadMatrixV2,
  type Matrix,
  MatrixConfigError,
  type MatrixV2,
  matrixV2Cells,
  matrixV2EffortsFor,
  nativeIdFor,
  providerCheckFindings,
  providerOrderFor,
  resolveModel,
} from "../src/agent/matrix";
import {
  enumerateTripleStrings,
  enumerateTriples,
  type HostTriples,
  hostTripleRefs,
  lintHostTriples,
} from "../src/agent/triple";
import * as fx from "./fixtures/matrix-v2";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-matrix-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let matrixSeq = 0;
function writeMatrix(body: string): string {
  // A UNIQUE filename per call so a test that writes several fixtures in one
  // expression gets distinct paths (never one file the last write clobbers).
  const p = join(tmpDir, `matrix-${matrixSeq++}.yaml`);
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
  "      - name: gpt-5.5",
  "        native: gpt-5.5-codex",
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

/** An enumeration roster exercising every cube axis: claude native (top-level
 *  efforts [low, high]); codex routed with a provider effort override [high,
 *  xhigh], an aliased model, and a per-model override [low]; pi launch-only
 *  (route: false) with a slashed native id; hermes launch-only + axisless (na). */
const CUBE_MATRIX = [
  "efforts:",
  "  - low",
  "  - high",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "  - name: codex",
  "    efforts:",
  "      - high",
  "      - xhigh",
  "    models:",
  "      - name: gpt-5.5",
  "        native: gpt-5.5-codex",
  "      - name: gpt-fast",
  "        efforts:",
  "          - low",
  "  - name: pi",
  "    route: false",
  "    models:",
  "      - name: spark",
  "        native: pi/spark-preview",
  "  - name: hermes",
  "    route: false",
  "    models:",
  "      - hermes-m",
  "subagents:",
  "  - work",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

function cubeMatrix(): Matrix {
  return loadMatrix(writeMatrix(CUBE_MATRIX)) as Matrix;
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

describe("model long form + legacy alias retirement", () => {
  function withCodexModels(...modelLines: string[]): string {
    return [
      "efforts:",
      "  - low",
      "  - high",
      "providers:",
      "  - name: claude",
      "    models:",
      "      - opus",
      "  - name: codex",
      "    models:",
      ...modelLines,
      "subagents:",
      "  - work",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: high",
      "",
    ].join("\n");
  }

  test("the long form {name} with no native aliases native id === capability", () => {
    const m = loadMatrix(
      writeMatrix(withCodexModels("      - name: gpt-5.5")),
    ) as Matrix;
    expect(nativeIdFor(m, "codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(driverFor(m, "gpt-5.5")).toBe("wrapped");
  });

  test("the long form {name, native} carries the native id", () => {
    const m = loadMatrix(
      writeMatrix(
        withCodexModels(
          "      - name: gpt-5.5",
          "        native: gpt-5.5-codex",
        ),
      ),
    ) as Matrix;
    expect(nativeIdFor(m, "codex", "gpt-5.5")).toBe("gpt-5.5-codex");
  });

  test("the retired one-pair alias map is fail-loud, naming the long form", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(withCodexModels("      - gpt-5.5: gpt-5.5-codex")),
      ),
    ).toThrow(/alias map is retired/);
  });

  test("a long-form entry with an unknown key is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          withCodexModels(
            "      - name: gpt-5.5",
            "        alias: gpt-5.5-codex",
          ),
        ),
      ),
    ).toThrow(/unknown key 'alias'/);
  });

  test("a non-string long-form name is fail-loud (YAML coercion)", () => {
    // `name: true` parses as a boolean scalar — fails the string guard.
    expect(() =>
      loadMatrix(writeMatrix(withCodexModels("      - name: true"))),
    ).toThrow(/model 'name' must be a string/);
  });
});

describe("per-provider / per-model effort overrides", () => {
  function matrixWith(providerBlock: string[]): Matrix {
    return loadMatrix(
      writeMatrix(
        [
          "efforts:",
          "  - low",
          "  - medium",
          "  - high",
          "  - xhigh",
          "providers:",
          "  - name: claude",
          "    models:",
          "      - opus",
          ...providerBlock,
          "subagents:",
          "  - work",
          "wrapper_driver:",
          "  model: sonnet",
          "  effort: high",
          "",
        ].join("\n"),
      ),
    ) as Matrix;
  }

  test("the top-level efforts axis normalizes to canonical ascending order", () => {
    // Declared out of canonical order → normalized to KEEPER_EFFORTS order.
    const m = loadMatrix(
      writeMatrix(
        [
          "efforts:",
          "  - high",
          "  - low",
          "  - medium",
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
    expect(m.efforts).toEqual(["low", "medium", "high"]);
  });

  test("a model with no override inherits the top-level axis", () => {
    const m = matrixWith(["  - name: codex", "    models:", "      - gpt-5.5"]);
    expect(effortsFor(m, "gpt-5.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // An unlisted model also inherits the top-level axis.
    expect(effortsFor(m, "ghost")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("a provider-level override clobbers the top-level axis and normalizes", () => {
    const m = matrixWith([
      "  - name: codex",
      "    efforts:",
      "      - high",
      "      - low",
      "    models:",
      "      - gpt-5.5",
    ]);
    // Declared [high, low] → canonical [low, high].
    expect(effortsFor(m, "gpt-5.5")).toEqual(["low", "high"]);
  });

  test("a model-level override beats the provider-level override", () => {
    const m = matrixWith([
      "  - name: codex",
      "    efforts:",
      "      - low",
      "      - high",
      "    models:",
      "      - name: gpt-5.5",
      "        efforts:",
      "          - xhigh",
      "      - gpt-5-codex",
    ]);
    // gpt-5.5 has a model-level override; gpt-5-codex falls to the provider level.
    expect(effortsFor(m, "gpt-5.5")).toEqual(["xhigh"]);
    expect(effortsFor(m, "gpt-5-codex")).toEqual(["low", "high"]);
  });

  test("a present-but-empty override is fail-loud", () => {
    expect(() =>
      matrixWith([
        "  - name: codex",
        "    efforts: []",
        "    models:",
        "      - gpt-5.5",
      ]),
    ).toThrow(/must be a non-empty list/);
  });

  test("an out-of-subset override token is fail-loud", () => {
    expect(() =>
      matrixWith([
        "  - name: codex",
        "    models:",
        "      - name: gpt-5.5",
        "        efforts:",
        "          - turbo",
      ]),
    ).toThrow(/not in the canonical effort vocabulary/);
  });

  test("a non-string effort scalar is fail-loud (YAML coercion)", () => {
    // `true` parses as a boolean scalar — fails the string guard before the
    // subset check.
    expect(() =>
      matrixWith([
        "  - name: codex",
        "    efforts:",
        "      - true",
        "    models:",
        "      - gpt-5.5",
      ]),
    ).toThrow(/must be strings/);
  });
});

describe("route flag (launch-only providers)", () => {
  function rosterWithPiRoute(route: string): Matrix {
    return loadMatrix(
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
          "      - gpt-5.5",
          "  - name: pi",
          `    route: ${route}`,
          "    models:",
          "      - gpt-5.3-spark",
          "subagents:",
          "  - work",
          "wrapper_driver:",
          "  model: sonnet",
          "  effort: high",
          "",
        ].join("\n"),
      ),
    ) as Matrix;
  }

  test("route:false excludes a provider's models from the pecking order and cell set", () => {
    const m = rosterWithPiRoute("false");
    // pi's spark is launch-only: it routes nowhere and forms no cell.
    expect(providerOrderFor(m, "gpt-5.3-spark")).toEqual([]);
    expect(cellSet(m).map((c) => c.model)).toEqual(["opus", "gpt-5.5"]);
    // But the provider (and its model) stays present in the parsed matrix for
    // enumeration.
    const pi = m.providers.find((p) => p.name === "pi");
    expect(pi?.route).toBe(false);
    expect(pi?.models.has("gpt-5.3-spark")).toBe(true);
  });

  test("route:true (the default) keeps the provider routing", () => {
    const m = rosterWithPiRoute("true");
    expect(providerOrderFor(m, "gpt-5.3-spark")).toEqual(["pi"]);
    expect(cellSet(m).map((c) => c.model)).toEqual([
      "opus",
      "gpt-5.5",
      "gpt-5.3-spark",
    ]);
  });

  test("a route:false model still resolves an effort list (enumeration)", () => {
    const m = rosterWithPiRoute("false");
    expect(effortsFor(m, "gpt-5.3-spark")).toEqual(["high"]);
  });

  test("route:false on the claude provider is a load error", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: claude",
            "    route: false",
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
    ).toThrow(/claude.*cannot set route: false/);
  });

  test("a non-boolean route is fail-loud", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: codex",
            "    route: sometimes",
            "    models:",
            "      - gpt-5.5",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/route must be a boolean/);
  });

  test("a route:false provider overlapping claude is allowed (overlap check is routed-only)", () => {
    // pi (route:false) also serves opus (a claude-native model) — no ambiguous-driver
    // error, because the XOR check applies to routed providers only.
    const m = loadMatrix(
      writeMatrix(
        [
          "efforts:",
          "  - high",
          "providers:",
          "  - name: claude",
          "    models:",
          "      - opus",
          "  - name: pi",
          "    route: false",
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
    expect(driverFor(m, "opus")).toBe("native");
    expect(cellSet(m).map((c) => c.model)).toEqual(["opus"]);
  });
});

describe("alias-target charset (slashed native id)", () => {
  // codex aliases the wrapped capability gpt-5.5 to a provider-qualified slashed
  // native id — the shape pi rejects the bare capability for at startup.
  const SLASHED_TARGET = [
    "efforts:",
    "  - high",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - opus",
    "  - name: codex",
    "    models:",
    "      - name: gpt-5.5",
    "        native: openai/gpt-5.5",
    "subagents:",
    "  - work",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  test("isValidMatrixAliasTarget: slash-joined strict segments, else reject; strict token stays slash-free", () => {
    // Accept: a single strict token AND provider-qualified slash forms.
    expect(isValidMatrixAliasTarget("gpt-5.5")).toBe(true);
    expect(isValidMatrixAliasTarget("openai/gpt-5.5")).toBe(true);
    expect(isValidMatrixAliasTarget("a/b/c")).toBe(true);
    // Reject: empty, leading/trailing/double slash, path escape, leading dot, upper.
    expect(isValidMatrixAliasTarget("")).toBe(false);
    expect(isValidMatrixAliasTarget("/gpt")).toBe(false);
    expect(isValidMatrixAliasTarget("gpt/")).toBe(false);
    expect(isValidMatrixAliasTarget("a//b")).toBe(false);
    expect(isValidMatrixAliasTarget("../x")).toBe(false);
    expect(isValidMatrixAliasTarget("openai/.hidden")).toBe(false);
    expect(isValidMatrixAliasTarget("UP/case")).toBe(false);
    // The strict token charset (keys + axis tokens) never admits a slash.
    expect(isValidMatrixToken("openai/gpt-5.5")).toBe(false);
    expect(isValidMatrixToken("gpt-5.5")).toBe(true);
  });

  test("a provider-qualified slashed native id parses as an alias target", () => {
    const m = loadMatrix(writeMatrix(SLASHED_TARGET)) as Matrix;
    expect(nativeIdFor(m, "codex", "gpt-5.5")).toBe("openai/gpt-5.5");
  });

  test("resolveModel carries the slashed native id to model_id; preset name stays slash-free", () => {
    const m = loadMatrix(writeMatrix(SLASHED_TARGET)) as Matrix;
    expect(resolveModel(m, "gpt-5.5")).toEqual({
      driver: "wrapped",
      candidates: [
        {
          harness: "codex",
          model_id: "openai/gpt-5.5",
          preset_name: "codex-gpt-5.5",
        },
      ],
    });
  });

  test("a slashed alias KEY (long-form name) is fail-loud — the strict/relaxed split", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - high",
            "providers:",
            "  - name: codex",
            "    models:",
            "      - name: openai/gpt-5.5",
            "        native: gpt-5.5-codex",
            "subagents:",
            "  - work",
            "wrapper_driver:",
            "  model: sonnet",
            "  effort: high",
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow(/model token .* must match/);
  });

  test("a slashed effort axis token is fail-loud (out of canonical vocabulary)", () => {
    expect(() =>
      loadMatrix(
        writeMatrix(
          [
            "efforts:",
            "  - hi/gh",
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
      ),
    ).toThrow(/not in the canonical effort vocabulary/);
  });

  test("providers resolve carries the slashed model_id through to the launch flag (pass-through)", async () => {
    // v2 equivalent of SLASHED_TARGET: codex derives capability gpt-5.5 from the
    // provider-qualified launch id openai/gpt-5.5 (basename after the last slash).
    const SLASHED_TARGET_V2 = [
      "efforts:",
      "  - high",
      "subagent_templates:",
      "  - template/agents/worker.md.tmpl",
      "subagent_models:",
      "  - opus",
      "  - gpt-5.5",
      "providers:",
      "  - name: claude",
      "    models:",
      "      - opus",
      "  - name: codex",
      "    models:",
      "      - openai/gpt-5.5",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: high",
      "",
    ].join("\n");
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
      matrix: loadMatrixV2(writeMatrix(SLASHED_TARGET_V2)),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const env = JSON.parse(h.out.join(""));
    expect(env.candidates).toEqual([
      {
        harness: "codex",
        model_id: "openai/gpt-5.5",
        preset_name: "codex-gpt-5.5",
      },
    ]);
  });
});

// ── v2 loader (ADR 0036) ─────────────────────────────────────────────────────

/** The normalized cross-island projection — what both v2 loaders must reduce a
 *  fixture to. Hand-comparable; the parity suite asserts launcher === plan. */
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
  };
}

describe("v2 loader — capability derivation + parse", () => {
  test("capabilityOf: basename after the last slash, whole id when slash-free", () => {
    expect(capabilityOf("opus")).toBe("opus");
    expect(capabilityOf("openai-codex/gpt-5.3-codex-spark")).toBe(
      "gpt-5.3-codex-spark",
    );
    expect(capabilityOf("a/b/c")).toBe("c");
  });

  test("isValidTemplatePath: relative, no `..`, no NUL, no leading slash", () => {
    expect(isValidTemplatePath("template/agents/worker.md.tmpl")).toBe(true);
    expect(isValidTemplatePath("")).toBe(false);
    expect(isValidTemplatePath("/etc/passwd")).toBe(false);
    expect(isValidTemplatePath("../x")).toBe(false);
    expect(isValidTemplatePath("a/../b")).toBe(false);
    expect(isValidTemplatePath("a\0b")).toBe(false);
    expect(isValidTemplatePath(42)).toBe(false);
  });

  test("a valid multi-provider roster reduces to the hand-computed projection", () => {
    const m = loadMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    const exp = fx.MULTI_PROVIDER_EXPECTED;
    expect(m.efforts).toEqual(exp.efforts);
    expect(m.subagentTemplates).toEqual(exp.subagentTemplates);
    expect(m.subagentModels).toEqual(exp.subagentModels);
    expect(projectLauncher(m).drivers).toEqual(exp.drivers);
    expect(projectLauncher(m).effortsByModel).toEqual(exp.effortsByModel);
    // The shared fixture types provider/winner as `string`; the launcher narrows
    // them to HarnessName — same runtime shape, cast for the structural compare.
    expect(m.shadowed).toEqual(exp.shadowed as typeof m.shadowed);
    // The bare launch-id keeps its verbatim string; the provider-qualified one too.
    expect(
      m.providers
        .find((p) => p.name === "codex")
        ?.models.get("gpt-5.3-codex-spark"),
    ).toBe("gpt-5.3-codex-spark");
    expect(
      m.providers
        .find((p) => p.name === "pi")
        ?.models.get("gpt-5.3-codex-spark"),
    ).toBe("openai-codex/gpt-5.3-codex-spark");
  });

  test("matrixV2Cells: subagent_models in declared order, driver-tagged", () => {
    const m = loadMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    expect(matrixV2Cells(m)).toEqual([
      { model: "opus", driver: "native" },
      { model: "sonnet", driver: "native" },
      { model: "gpt-5.3-codex-spark", driver: "wrapped" },
    ]);
  });

  test("matrixV2EffortsFor: per-capability list, else the top-level axis", () => {
    const m = loadMatrixV2(writeMatrix(fx.MULTI_PROVIDER));
    // spark inherits codex's provider override; opus the top-level axis; an
    // unserved capability falls to the top-level axis.
    expect(matrixV2EffortsFor(m, "gpt-5.3-codex-spark")).toEqual([
      "high",
      "xhigh",
    ]);
    expect(matrixV2EffortsFor(m, "opus")).toEqual(["medium", "high"]);
    expect(matrixV2EffortsFor(m, "never-served")).toEqual(["medium", "high"]);
  });
});

describe("v2 loader — retired keys (each rejection names the key)", () => {
  test.each(fx.RETIRED_KEY_FIXTURES)(
    "rejects the retired '$key' key naming it",
    ({ key, body }) => {
      let caught: unknown;
      try {
        loadMatrixV2(writeMatrix(body));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MatrixConfigError);
      expect((caught as MatrixConfigError).state).toBe("schema-invalid");
      expect((caught as Error).message).toContain(`'${key}:'`);
    },
  );
});

describe("v2 loader — four-state failure taxonomy", () => {
  test("absent → typed error naming the path + the copy-the-example fix", () => {
    const missing = join(tmpDir, "nope.yaml");
    let caught: unknown;
    try {
      loadMatrixV2(missing);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MatrixConfigError);
    const err = caught as MatrixConfigError;
    expect(err.state).toBe("absent");
    expect(err.configPath).toBe(missing);
    expect(err.message).toContain(missing);
    expect(err.message).toContain("docs/examples/matrix.example.yaml");
  });

  test("unparseable → typed error", () => {
    expect(() => loadMatrixV2(writeMatrix(fx.UNPARSEABLE))).toThrow(
      MatrixConfigError,
    );
    try {
      loadMatrixV2(writeMatrix(fx.UNPARSEABLE));
    } catch (e) {
      expect((e as MatrixConfigError).state).toBe("unparseable");
    }
  });

  test("valid-but-empty → typed error distinct from absent", () => {
    try {
      loadMatrixV2(writeMatrix(fx.VALID_BUT_EMPTY));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MatrixConfigError);
      expect((e as MatrixConfigError).state).toBe("valid-but-empty");
    }
  });

  test("schema-invalid → typed error naming the fix", () => {
    try {
      loadMatrixV2(writeMatrix(fx.SCHEMA_INVALID));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MatrixConfigError);
      expect((e as MatrixConfigError).state).toBe("schema-invalid");
      expect((e as Error).message).toContain(
        "docs/examples/matrix.example.yaml",
      );
    }
  });

  test("the four states are four DISTINCT discriminants", () => {
    const states = new Set<string>();
    for (const [path] of [
      [join(tmpDir, "gone.yaml")],
      [writeMatrix(fx.UNPARSEABLE)],
      [writeMatrix(fx.VALID_BUT_EMPTY)],
      [writeMatrix(fx.SCHEMA_INVALID)],
    ] as const) {
      try {
        loadMatrixV2(path);
      } catch (e) {
        states.add((e as MatrixConfigError).state);
      }
    }
    expect(states).toEqual(
      new Set(["absent", "unparseable", "valid-but-empty", "schema-invalid"]),
    );
  });
});

describe("v2 loader — dedup, shadow, and launch-only enumeration", () => {
  test("a same-provider basename collision errors at load", () => {
    expect(() => loadMatrixV2(writeMatrix(fx.SAME_PROVIDER_COLLISION))).toThrow(
      /same-provider duplicate/,
    );
  });

  test("a cross-provider duplicate resolves to the first provider; the loser is shadowed", () => {
    const m = loadMatrixV2(writeMatrix(fx.CROSS_PROVIDER_DEDUP));
    // codex (roster-first) owns gpt-5.5's effort list; pi's slashed entry shadows.
    expect(m.effortsByModel.get("gpt-5.5")).toEqual(["high"]);
    expect(m.shadowed).toEqual([
      {
        provider: "pi",
        capability: "gpt-5.5",
        launchId: "openai/gpt-5.5",
        winner: "codex",
      },
    ]);
  });

  test("a subagent_models entry no provider serves errors at load", () => {
    expect(() => loadMatrixV2(writeMatrix(fx.SUBAGENT_MODEL_UNSERVED))).toThrow(
      /served by no provider/,
    );
  });

  test("a provider model absent from subagent_models loads as launch-only enumeration", () => {
    const m = loadMatrixV2(writeMatrix(fx.LAUNCH_ONLY));
    // gpt-5.5 is a cell; gpt-5.5-preview enumerates (resolves an effort list) but
    // never forms a cell.
    expect(m.subagentModels).toEqual(["gpt-5.5"]);
    expect(m.effortsByModel.has("gpt-5.5-preview")).toBe(true);
    expect(matrixV2Cells(m).map((c) => c.model)).toEqual(["gpt-5.5"]);
    expect(
      m.providers
        .find((p) => p.name === "codex")
        ?.models.get("gpt-5.5-preview"),
    ).toBe("gpt-5.5-preview");
  });
});

describe("committed example matrix (anti-rot, v2)", () => {
  // The example lives at docs/examples/matrix.example.yaml — outside every
  // discovered config path — and is loaded here by explicit path through the SAME
  // real v2 loaders a host `~/.config/keeper/matrix.yaml` would, so a
  // behavior-changing edit to the example fails this test loud.
  const EXAMPLE_PATH = join(
    import.meta.dir,
    "..",
    "docs",
    "examples",
    "matrix.example.yaml",
  );

  test("the launcher loader parses the example: bare, {id, efforts}, and provider-qualified forms", () => {
    const m = loadMatrixV2(EXAMPLE_PATH);
    // bare launch-id (codex) → capability = the whole id
    expect(
      m.providers
        .find((p) => p.name === "codex")
        ?.models.get("gpt-5.3-codex-spark"),
    ).toBe("gpt-5.3-codex-spark");
    // provider-qualified launch-id (pi) → capability = basename (shadowed by codex)
    expect(
      m.providers
        .find((p) => p.name === "pi")
        ?.models.get("gpt-5.3-codex-spark"),
    ).toBe("openai-codex/gpt-5.3-codex-spark");
    // {id, efforts} band (pi) → launch-only capability with its own effort list
    expect(m.effortsByModel.get("gpt-5.3-spark-preview")).toEqual(["medium"]);
    // driver-tagged cell axis
    expect(matrixV2Cells(m)).toEqual([
      { model: "opus", driver: "native" },
      { model: "sonnet", driver: "native" },
      { model: "gpt-5.3-codex-spark", driver: "wrapped" },
    ]);
    expect(matrixV2EffortsFor(m, "gpt-5.3-codex-spark")).toEqual([
      "high",
      "xhigh",
    ]);
    expect(m.shadowed).toEqual([
      {
        provider: "pi",
        capability: "gpt-5.3-codex-spark",
        launchId: "openai-codex/gpt-5.3-codex-spark",
        winner: "codex",
      },
    ]);
  });
});

describe("enumerateTriples (virtual launch cube)", () => {
  test("fans every provider over native ids and effective efforts", () => {
    const cube = enumerateTriples(cubeMatrix());
    // Provider declaration order, each with its route flag.
    expect(cube.map((g) => [g.harness, g.route])).toEqual([
      ["claude", true],
      ["codex", true],
      ["pi", false],
      ["hermes", false],
    ]);
    const bh = (name: string) =>
      cube.find((g) => g.harness === name)?.triples.map((t) => t.triple) ?? [];
    // claude inherits the top-level axis [low, high].
    expect(bh("claude")).toEqual([
      "claude::opus::low",
      "claude::opus::high",
      "claude::sonnet::low",
      "claude::sonnet::high",
    ]);
    // codex: gpt-5.5 uses the provider override [high, xhigh] against its native
    // id; gpt-fast uses its own per-model override [low].
    expect(bh("codex")).toEqual([
      "codex::gpt-5.5-codex::high",
      "codex::gpt-5.5-codex::xhigh",
      "codex::gpt-fast::low",
    ]);
    // A launch-only provider still enumerates, carrying the slashed native id.
    expect(bh("pi")).toEqual([
      "pi::pi/spark-preview::low",
      "pi::pi/spark-preview::high",
    ]);
    // An axisless harness emits a single `na` triple per model.
    expect(bh("hermes")).toEqual(["hermes::hermes-m::na"]);
  });

  test("a triple entry carries the capability + native id + effort", () => {
    const cube = enumerateTriples(cubeMatrix());
    const codex = cube.find((g) => g.harness === "codex");
    expect(codex?.triples[0]).toEqual({
      triple: "codex::gpt-5.5-codex::high",
      capability: "gpt-5.5",
      native_id: "gpt-5.5-codex",
      effort: "high",
    });
  });

  test("route:false models are enumerable here but absent from the pecking order", () => {
    const m = cubeMatrix();
    const strings = enumerateTripleStrings(m);
    // pi's spark enumerates for launch...
    expect(strings.has("pi::pi/spark-preview::low")).toBe(true);
    // ...but forms no capability cell and routes nowhere.
    expect(cellSet(m).map((c) => c.model)).toEqual([
      "opus",
      "sonnet",
      "gpt-5.5",
      "gpt-fast",
    ]);
    expect(providerOrderFor(m, "spark")).toEqual([]);
  });
});

describe("lintHostTriples (host-triple drift + fault)", () => {
  const hostRefs = (host: Partial<HostTriples>): HostTriples => ({
    defaults: {},
    dispatch: {},
    panels: {},
    panelDefault: null,
    ...host,
  });

  test("a well-formed triple absent from the cube is off-cube drift", () => {
    const findings = lintHostTriples(
      cubeMatrix(),
      // opus only enumerates at low/high — xhigh is off-cube.
      hostTripleRefs(hostRefs({ defaults: { claude: "claude::opus::xhigh" } })),
    );
    expect(findings).toEqual([
      {
        kind: "off-cube-triple",
        source: "claude_default",
        triple: "claude::opus::xhigh",
      },
    ]);
  });

  test("a malformed triple is a fault carrying the grammar error + source", () => {
    const findings = lintHostTriples(
      cubeMatrix(),
      hostTripleRefs(hostRefs({ dispatch: { work: "claude::opus::banana" } })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("malformed-triple");
    expect(findings[0]?.source).toBe("dispatch.work");
    expect((findings[0] as { error: string }).error).toContain("banana");
  });

  test("an in-cube triple (incl. a panel member + na) is clean", () => {
    const findings = lintHostTriples(
      cubeMatrix(),
      hostTripleRefs(
        hostRefs({
          defaults: { codex: "codex::gpt-5.5-codex::high" },
          panels: { duo: ["claude::opus::low", "hermes::hermes-m::na"] },
        }),
      ),
    );
    expect(findings).toEqual([]);
  });
});

describe("providerCheckFindings", () => {
  test("an unreachable provider binary is one finding", () => {
    const m = validMatrix();
    const findings = providerCheckFindings(m, (harness) => harness !== "pi");
    expect(findings).toEqual([
      { kind: "binary-unreachable", provider: "pi", binary: "pi" },
    ]);
  });

  test("a consistent roster has no findings", () => {
    expect(providerCheckFindings(validMatrix(), () => true)).toEqual([]);
  });
});

/** A valid v2 roster for the resolve verb: claude native (opus/sonnet); codex
 *  (roster-first) and pi both deriving the wrapped capability gpt-5.5 — codex
 *  wins, pi is shadowed (a single candidate, not v1's multi-candidate chain). */
const V2_VALID_MATRIX = [
  "efforts:",
  "  - low",
  "  - high",
  "  - xhigh",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - opus",
  "  - sonnet",
  "  - gpt-5.5",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "  - name: codex",
  "    models:",
  "      - gpt-5.5",
  "  - name: pi",
  "    models:",
  "      - openai/gpt-5.5",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "defaults:",
  "  stop_timeout_ms: 3600000",
  "  max_attempts: 5",
  "",
].join("\n");

function validMatrixV2(): MatrixV2 {
  return loadMatrixV2(writeMatrix(V2_VALID_MATRIX));
}

describe("providers resolve verb", () => {
  test("a wrapped model emits the pecking-order-winning candidate envelope (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
      matrix: validMatrixV2(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      model: "gpt-5.5",
      effort: "high",
      driver: "wrapped",
      // codex is roster-first, so it wins gpt-5.5; pi's entry is shadowed
      // (ADR 0036/0010) and never a resolve candidate.
      candidates: [
        {
          harness: "codex",
          model_id: "gpt-5.5",
          preset_name: "codex-gpt-5.5",
        },
      ],
      defaults: { stop_timeout_ms: 3600000, max_attempts: 5 },
    });
  });

  test("a native model resolves to the claude candidate (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "opus", "xhigh"],
      rawArgv: true,
      matrix: validMatrixV2(),
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
      matrix: validMatrixV2(),
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
      matrix: validMatrixV2(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("not a valid token");
  });

  test("a malformed matrix (MatrixConfigError) exits 2", async () => {
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
    });
    h.deps.loadMatrixFn = () => {
      throw new MatrixConfigError(
        "schema-invalid",
        "/m.yaml",
        "Unknown top-level key 'x'",
      );
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("Unknown top-level key");
  });

  test("an absent matrix is a typed loud failure (exit 2), never a claude-native fallback", async () => {
    // v2 (ADR 0036): the host matrix is REQUIRED. An absent matrix exits 2 with the
    // typed four-state error NAMING the absent state + the copy-the-example fix, and
    // emits no candidate on stdout — never the pre-v2 silent claude-native fallback.
    const h = makeHarness({
      argv: ["providers", "resolve", "anything-goes", "high"],
      rawArgv: true,
      matrix: null,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("no matrix.yaml found");
    expect(h.err.join("")).toContain("matrix.example.yaml");
    expect(h.out.join("")).toBe("");
  });

  test("loads the committed v2 example matrix without a v1 unknown-key error (F1/F4)", async () => {
    // The regression this task fixes: `providers resolve` used to parse the
    // mandated v2 matrix.yaml with the v1 loader, which hard-rejects
    // `subagent_templates`/`subagent_models`.
    const EXAMPLE_PATH = join(
      import.meta.dir,
      "..",
      "docs",
      "examples",
      "matrix.example.yaml",
    );
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.3-codex-spark", "high"],
      rawArgv: true,
      matrix: loadMatrixV2(EXAMPLE_PATH),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const env = JSON.parse(h.out.join(""));
    expect(env.driver).toBe("wrapped");
    // codex is roster-first for gpt-5.3-codex-spark; pi's entry is shadowed.
    expect(env.candidates).toEqual([
      {
        harness: "codex",
        model_id: "gpt-5.3-codex-spark",
        preset_name: "codex-gpt-5.3-codex-spark",
      },
    ]);
  });
});

/** A v2 roster exercising the check-verb axes: claude native (top-level efforts
 *  [low, high]); codex with a provider effort override [high, xhigh]; pi
 *  launch-only (its capability absent from subagent_models) with a slashed
 *  launch id; hermes axisless. */
const V2_CUBE_MATRIX = [
  "efforts:",
  "  - low",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - opus",
  "  - sonnet",
  "  - gpt-5.5-codex",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "  - name: codex",
  "    efforts:",
  "      - high",
  "      - xhigh",
  "    models:",
  "      - gpt-5.5-codex",
  "  - name: pi",
  "    models:",
  "      - id: pi/spark-preview",
  "  - name: hermes",
  "    models:",
  "      - hermes-m",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

function cubeMatrixV2(): MatrixV2 {
  return loadMatrixV2(writeMatrix(V2_CUBE_MATRIX));
}

describe("providers check verb", () => {
  test("a consistent roster with in-cube host triples is clean (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrixV2(),
      hostTriples: {
        defaults: { claude: "claude::opus::low" },
        dispatch: { work: "claude::sonnet::high" },
        panels: { duo: ["codex::gpt-5.5-codex::high", "hermes::hermes-m::na"] },
        panelDefault: "duo",
      },
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).findings).toEqual([]);
  });

  test("an unreachable binary + an off-cube host triple are drift (exit 9)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrixV2(),
      // opus enumerates only at low/high — xhigh is a well-formed off-cube triple.
      hostTriples: {
        defaults: { claude: "claude::opus::xhigh" },
        dispatch: {},
        panels: {},
        panelDefault: null,
      },
      providerReachable: (harness) => harness !== "pi",
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const kinds = JSON.parse(h.out.join("")).findings.map(
      (f: { kind: string }) => f.kind,
    );
    expect(kinds).toEqual(["binary-unreachable", "off-cube-triple"]);
  });

  test("a malformed host triple is a tool fault (exit 1), still enveloped", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrixV2(),
      hostTriples: {
        defaults: {},
        // Two segments — the grammar rejects it (fault, not drift).
        dispatch: { unblock: "claude::opus" },
        panels: {},
        panelDefault: null,
      },
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(1);
    const findings = JSON.parse(h.out.join("")).findings;
    expect(findings.map((f: { kind: string }) => f.kind)).toEqual([
      "malformed-triple",
    ]);
    expect(findings[0].source).toBe("dispatch.unblock");
  });

  test("a well-formed off-cube dispatch triple is drift naming the verb key (exit 9)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrixV2(),
      // sonnet only enumerates at low/high — xhigh is off-cube.
      hostTriples: {
        defaults: {},
        dispatch: { unblock: "claude::sonnet::xhigh" },
        panels: {},
        panelDefault: null,
      },
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const findings = JSON.parse(h.out.join("")).findings;
    expect(findings).toEqual([
      {
        kind: "off-cube-triple",
        source: "dispatch.unblock",
        triple: "claude::sonnet::xhigh",
        line: expect.stringContaining("dispatch.unblock"),
      },
    ]);
  });

  test("no auto-preset collision finding exists anywhere", async () => {
    // The retired collision axis: a matrix whose auto `<provider>-<model>` name
    // would once have collided with a hand-authored preset now produces nothing.
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrixV2(),
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const kinds: string[] = JSON.parse(h.out.join("")).findings.map(
      (f: { kind: string }) => f.kind,
    );
    expect(kinds).not.toContain("preset-collision");
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
      throw new MatrixConfigError("schema-invalid", "/m.yaml", "bad matrix");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(1);
    expect(h.err.join("")).toContain("bad matrix");
  });

  test("loads the committed v2 example matrix without a v1 unknown-key error (F1/F4)", async () => {
    // The regression this task fixes: `providers check` used to parse the
    // mandated v2 matrix.yaml with the v1 loader, which hard-rejects
    // `subagent_templates`/`subagent_models`.
    const EXAMPLE_PATH = join(
      import.meta.dir,
      "..",
      "docs",
      "examples",
      "matrix.example.yaml",
    );
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: loadMatrixV2(EXAMPLE_PATH),
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join(""));
    expect(parsed.matrix_present).toBe(true);
    expect(parsed.findings).toEqual([]);
  });

  test("dispatch table against the committed v2 example matrix: in-cube clean, off-cube drift", async () => {
    const EXAMPLE_PATH = join(
      import.meta.dir,
      "..",
      "docs",
      "examples",
      "matrix.example.yaml",
    );
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: loadMatrixV2(EXAMPLE_PATH),
      hostTriples: {
        defaults: {},
        dispatch: {
          // in-cube: claude/sonnet enumerates at the top-level [medium, high].
          work: "claude::sonnet::medium",
          // off-cube: opus never enumerates at low (only medium/high).
          repair: "claude::opus::low",
        },
        panels: {},
        panelDefault: null,
      },
      providerReachable: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const findings = JSON.parse(h.out.join("")).findings;
    expect(findings).toEqual([
      {
        kind: "off-cube-triple",
        source: "dispatch.repair",
        triple: "claude::opus::low",
        line: expect.stringContaining("dispatch.repair"),
      },
    ]);
  });
});
