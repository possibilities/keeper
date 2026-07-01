// Unit tests for src/subagents_config.ts — the shared {model × effort} matrix
// loader. Proves the two access modes parse identically (runtime string → Buffer
// → parseYamlInput vs disk path → parseYamlInput), that the real embedded
// snapshot carries today's axes, and that a malformed/absent config fails loud
// with a typed SubagentsConfigError rather than a soft default.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configuredEfforts, workerAgentForTier } from "../src/models.ts";
import {
  loadSubagentsMatrixFromDisk,
  parseSubagentsMatrix,
  SubagentsConfigError,
  subagentsMatrix,
} from "../src/subagents_config.ts";
import { YamlInputError } from "../src/yaml_input.ts";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "subagents-cfg-")));
}

const GOOD = `efforts: [medium, high, xhigh, max]
models: [opus]
subagents: [template/agents/worker.md.tmpl]
`;

describe("subagents matrix loader", () => {
  test("disk and runtime access modes parse to the same matrix", () => {
    const dir = tmp();
    try {
      const path = join(dir, "subagents.yaml");
      writeFileSync(path, GOOD);
      const fromDisk = loadSubagentsMatrixFromDisk(path);
      const fromRuntime = parseSubagentsMatrix(
        Buffer.from(GOOD),
        "runtime-embed",
      );
      expect(fromRuntime).toEqual(fromDisk);
      expect(fromDisk.efforts).toEqual(["medium", "high", "xhigh", "max"]);
      expect(fromDisk.models).toEqual(["opus"]);
      expect(fromDisk.subagents).toEqual(["template/agents/worker.md.tmpl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the embedded snapshot carries today's axes (proves the compile-time embed)", () => {
    const matrix = subagentsMatrix();
    expect(matrix.efforts).toEqual(["medium", "high", "xhigh", "max"]);
    expect(matrix.models).toEqual(["opus"]);
    expect(matrix.subagents.length).toBeGreaterThan(0);
  });

  test("configuredEfforts is sourced from the config; tier validation accepts exactly it", () => {
    const efforts = configuredEfforts();
    expect(efforts).toEqual(["medium", "high", "xhigh", "max"]);
    const model = subagentsMatrix().models[0];
    for (const effort of efforts) {
      expect(workerAgentForTier(effort)).toBe(`plan:worker-${model}-${effort}`);
    }
    expect(workerAgentForTier(null)).toBeNull();
    expect(() => workerAgentForTier("turbo")).toThrow();
  });

  test("a non-mapping document fails loud with a typed error", () => {
    expect(() =>
      parseSubagentsMatrix(Buffer.from("- a\n- b\n"), "bad"),
    ).toThrow(SubagentsConfigError);
  });

  test("a missing axis fails loud with a typed error", () => {
    const missing = "efforts: [medium]\nmodels: [opus]\n";
    expect(() => parseSubagentsMatrix(Buffer.from(missing), "bad")).toThrow(
      SubagentsConfigError,
    );
  });

  test("an empty axis fails loud", () => {
    const empty = "efforts: []\nmodels: [opus]\nsubagents: [x]\n";
    expect(() => parseSubagentsMatrix(Buffer.from(empty), "bad")).toThrow(
      SubagentsConfigError,
    );
  });

  test("a non-string axis entry fails loud (guards YAML 1.1 scalar coercions)", () => {
    // `off` coerces to boolean false under YAML 1.1 — must fail the string guard.
    const coerced = "efforts: [off]\nmodels: [opus]\nsubagents: [x]\n";
    expect(() => parseSubagentsMatrix(Buffer.from(coerced), "bad")).toThrow(
      SubagentsConfigError,
    );
  });

  test("a non-list axis fails loud", () => {
    const scalar = "efforts: medium\nmodels: [opus]\nsubagents: [x]\n";
    expect(() => parseSubagentsMatrix(Buffer.from(scalar), "bad")).toThrow(
      SubagentsConfigError,
    );
  });

  test("malformed YAML surfaces the parser's typed error", () => {
    expect(() =>
      parseSubagentsMatrix(Buffer.from("efforts: [a, b\n"), "bad"),
    ).toThrow(YamlInputError);
  });

  test("a missing disk file fails loud, not soft-default", () => {
    expect(() =>
      loadSubagentsMatrixFromDisk(join(tmp(), "does-not-exist.yaml")),
    ).toThrow(YamlInputError);
  });
});
