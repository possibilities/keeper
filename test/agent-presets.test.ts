/**
 * Launcher config surface: the `--x-preset` flag drives an in-session launch's
 * harness/model/effort by parsing its value as a launch triple
 * (`harness::model::effort`) through main()'s resolver default slots at `explicit >
 * env > triple > native` per field; the `<harness>_default` catalog keys are triples
 * too; the launch-triple grammar (`parseTriple` / `slugifyTriple`) validates by
 * construction; and the reshaped `presets resolve` / `presets list` verbs emit the
 * triple + virtual-cube contracts. A cold-start guard proves the launcher import
 * graph never reaches src/db.ts (bun:sqlite).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetCatalog } from "../src/agent/config";
import { main } from "../src/agent/main";
import {
  loadMatrixV2,
  MatrixConfigError,
  type MatrixV2,
} from "../src/agent/matrix";
import {
  formatTriple,
  parseTriple,
  slugifyTriple,
  TRIPLE_SEGMENT_MAX_LEN,
  tripleHash,
} from "../src/agent/triple";
import {
  expectExit,
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

describe("--x-preset precedence (claude)", () => {
  test("triple model + effort feed the default slot", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "claude::opus::xhigh", "hi"],
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });
  test("explicit --model wins over the triple; triple effort still applies", async () => {
    const h = makeHarness({
      argv: [
        "--x-no-confirm",
        "--x-preset",
        "claude::opus::xhigh",
        "--model",
        "sonnet",
        "hi",
      ],
    });
    const cmd = await runAndCapture(h, main);
    // Explicit --model is forwarded verbatim; the wrapper adds no second --model.
    expect(flagValues(cmd, "--model")).toEqual(["sonnet"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });
  test("CLAUDE_CODE_EFFORT_LEVEL env beats the triple effort", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "claude::opus::xhigh", "hi"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "low" },
    });
    const cmd = await runAndCapture(h, main);
    // Env wins → the wrapper adds NO --effort; model still from the triple.
    expect(flagValues(cmd, "--effort")).toEqual([]);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });
  test("a malformed --x-preset triple is fail-loud (exit 2), naming the segment", async () => {
    const h = makeHarness({
      // Two segments — the grammar rejects it, naming the offending shape.
      argv: ["--x-no-confirm", "--x-preset", "claude::opus", "hi"],
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("three");
    expect(h.spawned.length).toBe(0);
  });
});
describe("--x-preset precedence (pi)", () => {
  test("pi triple model + effort feed the thinking slot", async () => {
    const h = makeHarness({
      agent: "pi",
      argv: ["--x-no-confirm", "--x-preset", "pi::pi-pro::xhigh", "hi"],
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["pi-pro"]);
    // The triple's keeper effort maps onto pi's thinking band (xhigh → xhigh).
    expect(flagValues(cmd, "--thinking")).toEqual(["xhigh"]);
  });
});
describe("harnessless run-preset + harness agreement", () => {
  test("a malformed harnessless triple fails loud naming the segment", async () => {
    const h = makeHarness({
      argv: ["--x-preset", "ghost::opus::high", "--x-no-confirm", "hi"],
      rawArgv: true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
    expect(h.spawned.length).toBe(0);
  });
});
describe("no --x-preset → harness default triple", () => {
  test("a fresh launch resolves the catalog claude_default triple", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "hi"],
      presetCatalog: {
        presets: {},
        claude_default: { harness: "claude", model: "opus", effort: "xhigh" },
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });
});
describe("fresh-launch fail-loud", () => {
  const EMPTY: PresetCatalog = { presets: {} };
  test("a bare fresh launch with no default is fail-loud (exit 2)", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "hi"],
      presetCatalog: EMPTY,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("claude_default");
    expect(h.spawned.length).toBe(0);
  });
  test("a lone --model (no effort, no default) is fail-loud (exit 2)", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--model", "opus", "hi"],
      presetCatalog: EMPTY,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.spawned.length).toBe(0);
  });
  test("both --model and --effort explicit launches (the both-explicit escape)", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--model", "opus", "--effort", "xhigh", "hi"],
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });
  test("--model + CLAUDE_CODE_EFFORT_LEVEL env is both-explicit (launches)", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--model", "opus", "hi"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });
  test("--continue (resume) with no default does NOT fail-loud", async () => {
    const h = makeHarness({
      argv: ["--continue"],
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--effort");
  });
  test("pi --model id:xhigh is thinking-supplied (launches, no --thinking added)", async () => {
    const h = makeHarness({
      agent: "pi",
      argv: ["--x-no-confirm", "--model", "gpt-5.5:xhigh", "hi"],
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    // The colon shorthand carries thinking, so keeper adds no conflicting flag.
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5:xhigh"]);
    expect(cmd).not.toContain("--thinking");
  });
});
describe("launch-triple grammar (parseTriple)", () => {
  test.each([
    [
      "claude::opus::high",
      { harness: "claude", model: "opus", effort: "high" },
    ],
    // Pi carries a keeper effort translated at launch.
    [
      "pi::glm-4.6::xhigh",
      { harness: "pi", model: "glm-4.6", effort: "xhigh" },
    ],
    // A slashed provider-qualified native id in the model segment.
    [
      "pi::openai/gpt-5.5::low",
      { harness: "pi", model: "openai/gpt-5.5", effort: "low" },
    ],
  ] as const)("parses %s", (raw, triple) => {
    const result = parseTriple(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.triple).toEqual(triple);
      // format round-trips the identity.
      expect(formatTriple(result.triple)).toBe(raw);
    }
  });
  test.each([
    ["claude::opus", "got 2"], // too few segments
    ["claude::opus::high::extra", "got 4"], // too many segments
    ["claude::op:us::high", "model segment"], // bare colon inside a segment
    ["ghost::opus::high", "harness segment"], // unknown harness
    ["claude::OPUS::high", "model segment"], // uppercase off the charset
    ["claude::opus::na", "not a canonical effort"],
    ["claude::opus::turbo", "not a canonical effort"], // bad effort token
  ] as const)("rejects %s naming the offending segment", (raw, needle) => {
    const result = parseTriple(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(needle);
    }
  });
  test("an over-length segment is rejected", () => {
    const long = "a".repeat(TRIPLE_SEGMENT_MAX_LEN + 1);
    const result = parseTriple(`claude::${long}::high`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("model segment");
      expect(result.error).toContain("cap");
    }
  });
});
describe("slugifyTriple (display/file form)", () => {
  test("collapses the identity to a [a-z0-9-] slug", () => {
    expect(
      slugifyTriple({ harness: "pi", model: "openai/gpt-5.5", effort: "high" }),
    ).toBe("pi-openai-gpt-5-5-high");
  });
  test("disambiguate appends a stable hash suffix; the raw triple is the identity", () => {
    const t = { harness: "claude" as const, model: "opus", effort: "high" };
    const plain = slugifyTriple(t);
    const disambiguated = slugifyTriple(t, { disambiguate: true });
    expect(disambiguated).toBe(`${plain}-${tripleHash(t)}`);
    // Deterministic + stable across calls.
    expect(slugifyTriple(t, { disambiguate: true })).toBe(disambiguated);
  });
});
describe("presets resolve JSON contract", () => {
  test("a launch triple echoes its parse", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "claude::opus::xhigh"],
      rawArgv: true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "triple",
      triple: "claude::opus::xhigh",
      harness: "claude",
      model: "opus",
      effort: "xhigh",
    });
  });
  test("the reserved name 'default' derefs the configured default panel by its real name", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "default"],
      rawArgv: true,
      hostTriples: {
        defaults: {},
        dispatch: {},
        panels: { reviewers: ["claude::opus::high"] },
        panelMeta: {},
        panelDefault: "reviewers",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "panel",
      name: "reviewers",
      members: ["claude::opus::high"],
    });
  });
  test("'default' with no configured default fails loud naming 'default'", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "default"],
      rawArgv: true,
      hostTriples: {
        defaults: {},
        dispatch: {},
        panels: { reviewers: ["claude::opus::high"] },
        panelMeta: {},
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("default");
    expect(h.err.join("")).toContain("panel.yaml");
  });
  test("a name that is neither a triple nor a panel fails loud naming the grammar + panels", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "ghost"],
      rawArgv: true,
      hostTriples: {
        defaults: {},
        dispatch: {},
        panels: { duo: ["claude::opus::high"] },
        panelMeta: {},
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
    expect(h.err.join("")).toContain("harness::model::effort");
    expect(h.err.join("")).toContain("duo");
  });
});
describe("presets list discovery surface", () => {
  // A minimal v2 roster: claude native opus (a cell); pi launch-only "spark"
  // (aliased to pi/spark, absent from subagent_models — enumerable, no cell).
  let tmpDir: string;
  function writeAndLoad(body: string): MatrixV2 {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-presets-"));
    const p = join(tmpDir, "matrix.yaml");
    writeFileSync(p, body);
    try {
      return loadMatrixV2(p);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  const LIST_MATRIX_BODY = [
    "efforts:",
    "  - low",
    "  - high",
    "subagent_templates:",
    "  - template/agents/worker.md.tmpl",
    "subagent_models:",
    "  - opus",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - opus",
    "  - name: pi",
    "    models:",
    "      - id: pi/spark",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");
  test("--json orders panels weak→strong by band then name, unbanded last", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      hostTriples: {
        defaults: {},
        dispatch: {},
        panels: {
          zeta: ["claude::opus::high"],
          maxer: ["claude::opus::high"],
          alpha: ["claude::opus::high"],
          weaker: ["claude::opus::high"],
          unbanded: ["claude::opus::high"],
        },
        panelMeta: {
          zeta: { strength: "weak", description: "z." },
          maxer: { strength: "max", description: "m." },
          alpha: { strength: "weak", description: "a." },
          weaker: { strength: "light", description: "w." },
          // `unbanded` carries no panelMeta entry at all — the same shape a
          // legacy list-form panel harvests to (empty strings), sorting last.
        },
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const names = JSON.parse(h.out.join("")).panels.map(
      (p: { name: string }) => p.name,
    );
    // weak (alpha, zeta — name tiebreak) < light (weaker) < max (maxer) < unbanded last.
    expect(names).toEqual(["alpha", "zeta", "weaker", "maxer", "unbanded"]);
  });
  test("--json marks a configured dispatch verb unfloored, mixed with floored rows", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      presetCatalog: {
        presets: {},
        dispatch: {
          work: { harness: "claude", model: "opus", effort: "low" },
          close: null,
          resolve: null,
          unblock: null,
          deconflict: null,
          repair: null,
          handoff: null,
        },
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const dispatch = JSON.parse(h.out.join("")).dispatch;
    expect(dispatch).toEqual([
      { verb: "work", triple: "claude::opus::low", floored: false },
      { verb: "close", triple: "claude::sonnet::max", floored: true },
      { verb: "resolve", triple: "claude::sonnet::max", floored: true },
      { verb: "unblock", triple: "claude::sonnet::high", floored: true },
      { verb: "deconflict", triple: "claude::sonnet::high", floored: true },
      { verb: "repair", triple: "claude::sonnet::high", floored: true },
      { verb: "handoff", triple: null, floored: true },
    ]);
  });
  test("human-readable marks a floored dispatch row and leaves a configured one bare", async () => {
    const h = makeHarness({
      argv: ["presets", "list"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      presetCatalog: {
        presets: {},
        dispatch: {
          work: { harness: "claude", model: "opus", effort: "low" },
          close: null,
          resolve: null,
          unblock: null,
          deconflict: null,
          repair: null,
          handoff: null,
        },
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("work  claude::opus::low");
    expect(text).not.toContain("work  claude::opus::low (floored)");
    expect(text).toContain("close  claude::sonnet::max (floored)");
    expect(text).toContain("handoff  (none) (floored)");
  });
  test("human-readable lists cube triples, defaults, and panels", async () => {
    const h = makeHarness({
      argv: ["presets", "list"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      hostTriples: {
        defaults: { claude: "claude::opus::high" },
        dispatch: {},
        panels: { duo: ["claude::opus::high"] },
        panelMeta: { duo: { strength: "standard", description: "a duo." } },
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("claude::opus::low");
    expect(text).toContain("pi::pi/spark::low (launch-only)");
    expect(text).toContain("claude_default  claude::opus::high");
    expect(text).toContain("duo [standard]");
    expect(text).toContain("a duo.");
  });
  test("human-readable marks the default panel and falls back for an unbanded panel", async () => {
    const h = makeHarness({
      argv: ["presets", "list"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      hostTriples: {
        defaults: {},
        dispatch: {},
        panels: { duo: ["claude::opus::high"] },
        panelMeta: {},
        panelDefault: "duo",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("duo [(no strength)] (default)");
  });
  test("an absent matrix is the claude-only world: empty cube, exit 0", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: null,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).harnesses).toEqual([]);
  });
  test("a malformed matrix is fail-loud (exit 2), not a crash", async () => {
    const h = makeHarness({ argv: ["presets", "list"], rawArgv: true });
    h.deps.loadMatrixFn = () => {
      throw new MatrixConfigError(
        "schema-invalid",
        "/x/matrix.yaml",
        "Unknown top-level key 'x'",
      );
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("Unknown top-level key");
  });
  test("dispatch table against an active v2 matrix: configured + floored rows", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      presetCatalog: {
        presets: {},
        dispatch: {
          work: { harness: "claude", model: "sonnet", effort: "medium" },
          close: null,
          resolve: null,
          unblock: null,
          deconflict: null,
          repair: null,
          handoff: null,
        },
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const dispatch = JSON.parse(h.out.join("")).dispatch;
    expect(dispatch).toEqual([
      { verb: "work", triple: "claude::sonnet::medium", floored: false },
      { verb: "close", triple: "claude::sonnet::max", floored: true },
      { verb: "resolve", triple: "claude::sonnet::max", floored: true },
      { verb: "unblock", triple: "claude::sonnet::high", floored: true },
      { verb: "deconflict", triple: "claude::sonnet::high", floored: true },
      { verb: "repair", triple: "claude::sonnet::high", floored: true },
      { verb: "handoff", triple: null, floored: true },
    ]);
  });
});
describe("cold-start import-graph guard", () => {
  // The launcher entry MUST NOT transitively pull src/db.ts (the bun:sqlite
  // module) onto the cold-start path. db.ts is the only `bun:sqlite` importer, so
  // a bundle of the entry that contains no `bun:sqlite` reference proves the
  // import graph never reaches it. (Sanity-checked against src/db.ts, which DOES
  // surface the marker when bundled.)
  async function bundledText(entrypoint: string): Promise<string> {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
    });
    expect(result.success).toBe(true);
    let text = "";
    for (const out of result.outputs) {
      text += await out.text();
    }
    return text;
  }
  test("cli/agent.ts bundle never references bun:sqlite", async () => {
    expect(await bundledText("./cli/agent.ts")).not.toContain("bun:sqlite");
  });
  test("src/agent/config.ts bundle never references bun:sqlite", async () => {
    expect(await bundledText("./src/agent/config.ts")).not.toContain(
      "bun:sqlite",
    );
  });
  test("src/agent/triple.ts bundle never references bun:sqlite", async () => {
    expect(await bundledText("./src/agent/triple.ts")).not.toContain(
      "bun:sqlite",
    );
  });
  test("marker sanity: src/db.ts bundle DOES reference bun:sqlite", async () => {
    expect(await bundledText("./src/db.ts")).toContain("bun:sqlite");
  });
});
