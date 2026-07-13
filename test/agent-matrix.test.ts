import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/agent/config";
import {
  capabilityOf,
  cellSet,
  driverFor,
  isValidMatrixAliasTarget,
  isValidMatrixToken,
  loadMatrix,
  loadMatrixV2,
  MatrixConfigError,
  matrixV2Cells,
  nativeIdFor,
  providerOrderFor,
  resolveModel,
} from "../src/agent/matrix";
import {
  enumerateTriples,
  enumerateTriplesV2,
  extractHostTriples,
  hostTripleRefs,
  parseTriple,
} from "../src/agent/triple";

let tmpDir: string;
let seq = 0;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-matrix-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function writeMatrix(body: string): string {
  const path = join(tmpDir, `matrix-${seq++}.yaml`);
  writeFileSync(path, body);
  return path;
}

const V1 = [
  "efforts:",
  "  - low",
  "  - high",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "  - name: pi",
  "    models:",
  "      - name: gpt-5.4",
  "        native: openai-codex/gpt-5.4",
  "subagents:",
  "  - work",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

const V2 = [
  "efforts:",
  "  - medium",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - opus",
  "  - gpt-5.4",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "  - name: pi",
  "    models:",
  "      - openai-codex/gpt-5.4",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

describe("matrix provider registry", () => {
  test("v1 accepts Claude and Pi and preserves Pi launch ids", () => {
    const matrix = loadMatrix(writeMatrix(V1));
    if (matrix === null) throw new Error("expected matrix");
    const m = matrix;
    expect(m.providers.map((provider) => provider.name)).toEqual([
      "claude",
      "pi",
    ]);
    expect(driverFor(m, "opus")).toBe("native");
    expect(driverFor(m, "gpt-5.4")).toBe("wrapped");
    expect(providerOrderFor(m, "gpt-5.4")).toEqual(["pi"]);
    expect(nativeIdFor(m, "pi", "gpt-5.4")).toBe("openai-codex/gpt-5.4");
    expect(resolveModel(m, "gpt-5.4").candidates).toEqual([
      {
        harness: "pi",
        model_id: "openai-codex/gpt-5.4",
        preset_name: "pi-gpt-5.4",
      },
    ]);
    expect(cellSet(m)).toEqual([
      { model: "opus", driver: "native" },
      { model: "gpt-5.4", driver: "wrapped" },
    ]);
  });

  test("v1 rejects a retired harness provider", () => {
    expect(() =>
      loadMatrix(writeMatrix(V1.replace("name: pi", "name: codex"))),
    ).toThrow(/claude\|pi\|hermes/);
  });

  test("v1 triple cube keeps the Pi-qualified model opaque", () => {
    const matrix = loadMatrix(writeMatrix(V1));
    if (matrix === null) throw new Error("expected matrix");
    const groups = enumerateTriples(matrix);
    const pi = groups.find((group) => group.harness === "pi");
    expect(pi?.triples.map((entry) => entry.triple)).toEqual([
      "pi::openai-codex/gpt-5.4::low",
      "pi::openai-codex/gpt-5.4::high",
    ]);
    expect(parseTriple("pi::openai-codex/gpt-5.4::high")).toEqual({
      ok: true,
      triple: {
        harness: "pi",
        model: "openai-codex/gpt-5.4",
        effort: "high",
      },
    });
  });

  test("v2 derives a Pi capability from an OpenAI-qualified launch id", () => {
    const matrix = loadMatrixV2(writeMatrix(V2));
    expect(capabilityOf("openai-codex/gpt-5.4")).toBe("gpt-5.4");
    expect(matrix.providers[1]?.name).toBe("pi");
    expect(matrix.providers[1]?.models.get("gpt-5.4")).toBe(
      "openai-codex/gpt-5.4",
    );
    expect(matrixV2Cells(matrix)).toEqual([
      { model: "opus", driver: "native" },
      { model: "gpt-5.4", driver: "wrapped" },
    ]);
    expect(enumerateTriplesV2(matrix)[1]?.triples[1]?.triple).toBe(
      "pi::openai-codex/gpt-5.4::high",
    );
  });

  test("v2 rejects a retired harness provider", () => {
    expect(() =>
      loadMatrixV2(writeMatrix(V2.replace("name: pi", "name: codex"))),
    ).toThrow(MatrixConfigError);
  });
});

describe("matrix token and host-triple helpers", () => {
  test("validates opaque launch ids without treating model family as harness", () => {
    expect(isValidMatrixToken("gpt-5.4")).toBe(true);
    expect(isValidMatrixAliasTarget("openai-codex/gpt-5.4")).toBe(true);
    expect(isValidMatrixAliasTarget("../gpt-5.4")).toBe(false);
  });

  test("host triple extraction follows the active harness roster", () => {
    const host = extractHostTriples(
      {
        claude_default: "claude::opus::high",
        codex_default: "codex::gpt-5.4::high",
        pi_default: "pi::openai-codex/gpt-5.4::high",
      },
      null,
    );
    expect(host.defaults).toEqual({
      claude: "claude::opus::high",
      pi: "pi::openai-codex/gpt-5.4::high",
    });
    expect(hostTripleRefs(host).map((ref) => ref.source)).toEqual([
      "claude_default",
      "pi_default",
    ]);
  });

  test("malformed and absent matrices fail loudly", () => {
    expect(loadMatrix(join(tmpDir, "absent.yaml"))).toBeNull();
    expect(() => loadMatrixV2(join(tmpDir, "absent-v2.yaml"))).toThrow(
      MatrixConfigError,
    );
    expect(() => loadMatrix(writeMatrix("providers: nope\n"))).toThrow(
      ConfigError,
    );
  });
});
