// Unit tests for src/subagents_config.ts — the shared {model × effort} matrix
// loader. Proves the two access modes parse identically (runtime string → Buffer
// → parseYamlInput vs disk path → parseYamlInput), that the real embedded
// snapshot carries today's axes, and that a malformed/absent config fails loud
// with a typed SubagentsConfigError rather than a soft default.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMatrix } from "../../../src/agent/matrix.ts";
import { loadHostMatrix } from "../src/host_matrix.ts";
import {
  configuredEfforts,
  configuredModels,
  workerAgentFor,
} from "../src/models.ts";
import {
  loadSubagentsMatrixFromDisk,
  parseSubagentsMatrix,
  SubagentsConfigError,
  subagentsMatrix,
  WORKERS_BASE,
  workerCellDir,
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
    expect(matrix.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(matrix.models).toEqual(["opus", "sonnet"]);
    expect(matrix.subagents.length).toBeGreaterThan(0);
  });

  // configuredEfforts/configuredModels read the composed EFFECTIVE matrix (host
  // matrix when present, embedded snapshot otherwise), so this pins against an
  // empty config dir (no matrix.yaml) — host-independent, regardless of the
  // developer's own ~/.config/keeper. See "configured-axes effective seam" below
  // for the host-present composition coverage.
  test("configuredEfforts/configuredModels source the axes; workerAgentFor composes exactly them", () => {
    const dir = tmp();
    const prevConfigDir = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = dir;
    try {
      const efforts = configuredEfforts();
      expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      const models = configuredModels();
      expect(models).toEqual(["opus", "sonnet"]);
      for (const model of models) {
        for (const effort of efforts) {
          expect(workerAgentFor(effort, model)).toBe(
            `plan:worker-${model}-${effort}`,
          );
        }
      }
      // A null on EITHER axis returns null (the /plan:work null-stop signal).
      expect(workerAgentFor(null, models[0] as string)).toBeNull();
      expect(workerAgentFor(efforts[0] as string, null)).toBeNull();
      expect(workerAgentFor(null, null)).toBeNull();
      // A non-null value outside the configured sets throws (corrupt-on-disk guard).
      expect(() => workerAgentFor("turbo", models[0] as string)).toThrow();
      expect(() => workerAgentFor(efforts[0] as string, "gpt")).toThrow();
    } finally {
      if (prevConfigDir === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = prevConfigDir;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("workerCellDir composes the shared workers/<model>-<effort> cell path for every matrix cell", () => {
    const { models, efforts } = subagentsMatrix();
    for (const model of models) {
      for (const effort of efforts) {
        // Mirrors the template's `render_to: workers/{{model}}-{{effort}}` so the
        // renderer and the launcher resolve the same cell dir.
        expect(workerCellDir(model, effort)).toBe(
          `${WORKERS_BASE}/${model}-${effort}`,
        );
      }
    }
    expect(WORKERS_BASE).toBe("workers");
    expect(workerCellDir("opus", "high")).toBe("workers/opus-high");
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

// Cross-island parity: `loadHostMatrix` (plan island, this file) and `loadMatrix`
// (src/agent/matrix.ts, the launcher island) are two hand-written parsers of the
// same matrix.yaml shape; this pins them so drift is caught mechanically.
describe("loadHostMatrix / loadMatrix cross-island parity", () => {
  // A minimal roster both islands accept: claude native (opus), codex wrapped
  // (gpt-5.5), a valid harness name recognized by the launcher's registry.
  const ACCEPTED_ROSTER = [
    "efforts: [medium, high]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models: [gpt-5.5]",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  // An empty `efforts` list — both parsers require a non-empty token list.
  const REJECTED_ROSTER = [
    "efforts: []",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  test("both parsers accept the same valid fixture roster", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, ACCEPTED_ROSTER);
      const host = loadHostMatrix(path);
      const launcher = loadMatrix(path);
      expect(host).not.toBeNull();
      expect(launcher).not.toBeNull();
      expect(host?.efforts).toEqual(launcher?.efforts);
      // The model axis: distinct capability tokens in pecking-order first
      // appearance — both parsers derive it the same way from the provider list.
      expect(host?.models).toEqual(["opus", "gpt-5.5"]);
      expect(launcher?.providers.flatMap((p) => [...p.models.keys()])).toEqual([
        "opus",
        "gpt-5.5",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both parsers reject the same invalid fixture roster (empty efforts)", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, REJECTED_ROSTER);
      expect(() => loadHostMatrix(path)).toThrow(SubagentsConfigError);
      expect(() => loadMatrix(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent file returns null in both islands (fall back to embedded defaults)", () => {
    const dir = tmp();
    try {
      const path = join(dir, "nope.yaml");
      expect(loadHostMatrix(path)).toBeNull();
      expect(loadMatrix(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a present-but-unreadable matrix.yaml fails loud (typed) in the plan island, matching the launcher island", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, ACCEPTED_ROSTER);
      chmodSync(path, 0o000);
      try {
        expect(() => loadHostMatrix(path)).toThrow(SubagentsConfigError);
        expect(() => loadMatrix(path)).toThrow();
      } finally {
        chmodSync(path, 0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── slashed-alias-target parity corpus ──────────────────────────────────────
  // The alias TARGET (native id a capability resolves to) admits `/` so a
  // provider-qualified id like `openai/gpt-5.5` is expressible; alias KEYS and axis
  // tokens stay strict. Both islands must accept/reject the identical corpus.

  const SLASHED_TARGET_ROSTER = [
    "efforts: [high]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models:",
    "      - gpt-5.5: openai/gpt-5.5",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  const SLASHED_KEY_ROSTER = [
    "efforts: [high]",
    "providers:",
    "  - name: codex",
    "    models:",
    "      - openai/gpt-5.5: gpt-5.5-codex",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  const SLASHED_AXIS_ROSTER = [
    "efforts: [hi/gh]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  test("both islands accept a slashed alias TARGET (launcher carries it, plan validates-then-discards)", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, SLASHED_TARGET_ROSTER);
      const host = loadHostMatrix(path);
      const launcher = loadMatrix(path);
      expect(host).not.toBeNull();
      expect(launcher).not.toBeNull();
      // Plan island: the model axis is the capability tokens; the native id is discarded.
      expect(host?.models).toEqual(["opus", "gpt-5.5"]);
      // Launcher island: the native id is carried through verbatim as the alias target.
      expect(
        launcher?.providers
          .find((p) => p.name === "codex")
          ?.models.get("gpt-5.5"),
      ).toBe("openai/gpt-5.5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both islands reject a slashed alias KEY (capability stays strict)", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, SLASHED_KEY_ROSTER);
      expect(() => loadHostMatrix(path)).toThrow(SubagentsConfigError);
      expect(() => loadMatrix(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both islands reject a slashed axis token (efforts stays strict)", () => {
    const dir = tmp();
    try {
      const path = join(dir, "matrix.yaml");
      writeFileSync(path, SLASHED_AXIS_ROSTER);
      expect(() => loadHostMatrix(path)).toThrow(SubagentsConfigError);
      expect(() => loadMatrix(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The configured-axes seam (configuredEfforts/configuredModels/workerAgentFor)
// reads the composed EFFECTIVE matrix: the host provider matrix when present, the
// embedded snapshot (byte-identical) when absent. A host matrix fixture is injected
// via KEEPER_CONFIG_DIR (os.homedir ignores $HOME on macOS) — never the real host
// file — and the no-matrix pins point at an empty config dir so they hold
// regardless of the developer's own ~/.config/keeper.
describe("configured-axes effective seam", () => {
  function withConfigDir<T>(dir: string, fn: () => T): T {
    const prev = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = dir;
    try {
      return fn();
    } finally {
      if (prev === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = prev;
      }
    }
  }

  // A host roster growing the model axis with the wrapped capability gpt-5.5 and
  // narrowing the effort axis to [medium, high] — deliberately unlike the embedded
  // defaults so a fall-through to the snapshot would be visible.
  const HOST_ROSTER = [
    "efforts: [medium, high]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models:",
    "      - gpt-5.5: openai/gpt-5.5",
    "subagents: [work]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  test("a present host matrix drives the axes; a host-roster cell composes + validates", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "matrix.yaml"), HOST_ROSTER);
      withConfigDir(dir, () => {
        expect(configuredEfforts()).toEqual(["medium", "high"]);
        expect(configuredModels()).toEqual(["opus", "gpt-5.5"]);
        // The host-roster wrapped model composes its agent instead of throwing.
        expect(workerAgentFor("high", "gpt-5.5")).toBe(
          "plan:worker-gpt-5.5-high",
        );
        expect(workerAgentFor("medium", "opus")).toBe(
          "plan:worker-opus-medium",
        );
        // The effective axes REPLACE the embedded ones — a snapshot-only model/effort
        // is now out-of-axis and throws (the corrupt-state backstop).
        expect(() => workerAgentFor("high", "sonnet")).toThrow(/unknown model/);
        expect(() => workerAgentFor("xhigh", "gpt-5.5")).toThrow(
          /unknown tier/,
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent host matrix falls back to the embedded axes byte-identically", () => {
    // An empty config dir (no matrix.yaml) → the embedded snapshot, host-independent.
    const dir = tmp();
    try {
      withConfigDir(dir, () => {
        expect(configuredEfforts()).toEqual([
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
        expect(configuredModels()).toEqual(["opus", "sonnet"]);
        expect(workerAgentFor("medium", "opus")).toBe(
          "plan:worker-opus-medium",
        );
        // A host-only capability is out-of-axis with no matrix present.
        expect(() => workerAgentFor("high", "gpt-5.5")).toThrow(
          /unknown model/,
        );
        // A null on either axis is still the /plan:work null-stop signal.
        expect(workerAgentFor(null, "opus")).toBeNull();
        expect(workerAgentFor("medium", null)).toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
