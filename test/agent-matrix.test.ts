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
  effortsFor,
  isValidMatrixAliasTarget,
  isValidMatrixToken,
  loadMatrix,
  type Matrix,
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
    const h = makeHarness({
      argv: ["providers", "resolve", "gpt-5.5", "high"],
      rawArgv: true,
      matrix: loadMatrix(writeMatrix(SLASHED_TARGET)) as Matrix,
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

describe("committed example matrix (anti-rot)", () => {
  // The example lives at docs/examples/matrix.example.yaml — outside every
  // discovered config path — and is loaded here by explicit path only, through
  // the SAME real loadMatrix a host `~/.config/keeper/matrix.yaml` would go
  // through, so a behavior-changing edit to the example fails this test loud.
  const EXAMPLE_PATH = join(
    import.meta.dir,
    "..",
    "docs",
    "examples",
    "matrix.example.yaml",
  );

  test("parses with the real loader and resolves the codex/spark activation", () => {
    const m = loadMatrix(EXAMPLE_PATH) as Matrix;
    expect(m).not.toBeNull();
    expect(driverFor(m, "gpt-5.3-codex-spark")).toBe("wrapped");
    expect(resolveModel(m, "gpt-5.3-codex-spark")).toEqual({
      driver: "wrapped",
      candidates: [
        {
          harness: "codex",
          model_id: "gpt-5.3-codex-spark",
          preset_name: "codex-gpt-5.3-codex-spark",
        },
      ],
    });
  });

  test("claude models stay native", () => {
    const m = loadMatrix(EXAMPLE_PATH) as Matrix;
    expect(driverFor(m, "opus")).toBe("native");
    expect(driverFor(m, "sonnet")).toBe("native");
  });

  test("the codex provider-level effort override drives the spark effort list", () => {
    const m = loadMatrix(EXAMPLE_PATH) as Matrix;
    // spark inherits codex's provider-level override [high, xhigh], not the
    // top-level axis [medium, high]; opus (claude) inherits the top-level axis.
    expect(effortsFor(m, "gpt-5.3-codex-spark")).toEqual(["high", "xhigh"]);
    expect(effortsFor(m, "opus")).toEqual(["medium", "high"]);
  });

  test("the route:false pi provider is launch-only: enumerable, but no cell and no route", () => {
    const m = loadMatrix(EXAMPLE_PATH) as Matrix;
    const preview = "gpt-5.3-spark-preview";
    // Present in the parsed matrix for enumeration...
    const pi = m.providers.find((p) => p.name === "pi");
    expect(pi?.route).toBe(false);
    expect(pi?.models.get(preview)).toBe("pi/gpt-5.3-spark-preview");
    // ...but excluded from the capability cell set and the pecking order.
    expect(cellSet(m).map((c) => c.model)).toEqual([
      "opus",
      "sonnet",
      "gpt-5.3-codex-spark",
    ]);
    expect(providerOrderFor(m, preview)).toEqual([]);
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
    worker: null,
    escalation: null,
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
      hostTripleRefs(hostRefs({ worker: "claude::opus::banana" })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("malformed-triple");
    expect(findings[0]?.source).toBe("worker");
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
  test("a consistent roster with in-cube host triples is clean (exit 0)", async () => {
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrix(),
      hostTriples: {
        defaults: { claude: "claude::opus::low" },
        worker: "claude::sonnet::high",
        escalation: null,
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
      matrix: cubeMatrix(),
      // opus enumerates only at low/high — xhigh is a well-formed off-cube triple.
      hostTriples: {
        defaults: { claude: "claude::opus::xhigh" },
        worker: null,
        escalation: null,
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
      matrix: cubeMatrix(),
      hostTriples: {
        defaults: {},
        // Two segments — the grammar rejects it (fault, not drift).
        worker: "claude::opus",
        escalation: null,
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
    expect(findings[0].source).toBe("worker");
  });

  test("no auto-preset collision finding exists anywhere", async () => {
    // The retired collision axis: a matrix whose auto `<provider>-<model>` name
    // would once have collided with a hand-authored preset now produces nothing.
    const h = makeHarness({
      argv: ["providers", "check"],
      rawArgv: true,
      matrix: cubeMatrix(),
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
      throw new ConfigError("bad matrix");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(1);
    expect(h.err.join("")).toContain("bad matrix");
  });
});
