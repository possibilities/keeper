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

describe("--x-preset precedence (codex + pi)", () => {
  test("codex triple model + effort feed the resolver default slot", async () => {
    const h = makeHarness({
      agent: "codex",
      argv: ["--x-no-confirm", "--x-preset", "codex::gpt-5.5::high", "hi"],
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5"]);
    expect(cmd).toContain('model_reasoning_effort="high"');
  });

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
  test("the harnessless form drives the harness from the triple (codex)", async () => {
    const h = makeHarness({
      argv: ["--x-preset", "codex::gpt-5.5::high", "--x-no-confirm", "hi"],
      rawArgv: true,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5"]);
  });

  test("a head agent disagreeing with the triple harness fails loud", async () => {
    const h = makeHarness({
      argv: [
        "codex",
        "--x-no-confirm",
        "--x-preset",
        "claude::opus::high",
        "hi",
      ],
      rawArgv: true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("pins harness claude");
    expect(h.spawned.length).toBe(0);
  });

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

  test("only the matching-harness default is resolved for the launch", async () => {
    // A catalog carrying every harness default resolves ONLY the claude one for
    // a claude launch — the codex/pi triples never touch it.
    const h = makeHarness({
      argv: ["--x-no-confirm", "hi"],
      presetCatalog: {
        presets: {},
        claude_default: { harness: "claude", model: "opus", effort: "xhigh" },
        codex_default: { harness: "codex", model: "gpt", effort: "high" },
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
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

  test("codex --profile is the both-explicit escape (launches)", async () => {
    const h = makeHarness({
      agent: "codex",
      argv: ["--x-no-confirm", "--profile", "native", "hi"],
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(cmd).toContain("native");
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
    [
      "codex::gpt-5.5::max",
      { harness: "codex", model: "gpt-5.5", effort: "max" },
    ],
    // pi carries a keeper effort (translated at launch) — na is only for axisless.
    [
      "pi::glm-4.6::xhigh",
      { harness: "pi", model: "glm-4.6", effort: "xhigh" },
    ],
    // A slashed provider-qualified native id in the model segment.
    [
      "pi::openai/gpt-5.5::low",
      { harness: "pi", model: "openai/gpt-5.5", effort: "low" },
    ],
    // hermes is axisless — na required.
    [
      "hermes::gpt-5.5::na",
      { harness: "hermes", model: "gpt-5.5", effort: "na" },
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
    ["claude::opus::na", "forbidden"], // na on an axisful harness
    ["hermes::gpt-5.5::high", "must be 'na'"], // non-na on hermes
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

  test("an axisless (hermes na) triple echoes with na", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "hermes::gpt-5.5::na"],
      rawArgv: true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).effort).toBe("na");
  });

  test("a panel name derefs to its ordered member triples", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "duo"],
      rawArgv: true,
      hostTriples: {
        defaults: {},
        worker: null,
        escalation: null,
        panels: { duo: ["claude::opus::high", "codex::gpt-5.5::high"] },
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "panel",
      name: "duo",
      members: ["claude::opus::high", "codex::gpt-5.5::high"],
    });
  });

  test("the reserved name 'default' derefs the configured default panel by its real name", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "default"],
      rawArgv: true,
      hostTriples: {
        defaults: {},
        worker: null,
        escalation: null,
        panels: { reviewers: ["claude::opus::high"] },
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
        worker: null,
        escalation: null,
        panels: { reviewers: ["claude::opus::high"] },
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
        worker: null,
        escalation: null,
        panels: { duo: ["claude::opus::high"] },
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

  test("--json emits the virtual cube, the four defaults, and panels", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      hostTriples: {
        defaults: {
          claude: "claude::opus::high",
          codex: "codex::gpt-5.5::high",
        },
        worker: null,
        escalation: null,
        panels: { duo: ["claude::opus::high", "pi::pi/spark::low"] },
        panelDefault: "duo",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "presets-list",
      harnesses: [
        {
          harness: "claude",
          triples: [
            {
              triple: "claude::opus::low",
              capability: "opus",
              native_id: "opus",
              effort: "low",
              cell: true,
            },
            {
              triple: "claude::opus::high",
              capability: "opus",
              native_id: "opus",
              effort: "high",
              cell: true,
            },
          ],
        },
        {
          harness: "pi",
          triples: [
            {
              triple: "pi::pi/spark::low",
              capability: "spark",
              native_id: "pi/spark",
              effort: "low",
              cell: false,
            },
            {
              triple: "pi::pi/spark::high",
              capability: "spark",
              native_id: "pi/spark",
              effort: "high",
              cell: false,
            },
          ],
        },
      ],
      defaults: {
        claude: "claude::opus::high",
        codex: "codex::gpt-5.5::high",
        pi: null,
        hermes: null,
      },
      panels: [
        { name: "duo", members: ["claude::opus::high", "pi::pi/spark::low"] },
      ],
      default: "duo",
    });
  });

  test("human-readable lists cube triples, defaults, and panels", async () => {
    const h = makeHarness({
      argv: ["presets", "list"],
      rawArgv: true,
      matrix: writeAndLoad(LIST_MATRIX_BODY),
      hostTriples: {
        defaults: { claude: "claude::opus::high" },
        worker: null,
        escalation: null,
        panels: { duo: ["claude::opus::high"] },
        panelDefault: null,
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("claude::opus::low");
    expect(text).toContain("pi::pi/spark::low (launch-only)");
    expect(text).toContain("claude_default  claude::opus::high");
    expect(text).toContain("codex_default  (unset)");
    expect(text).toContain("duo");
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

  test("loads the committed v2 example matrix without a v1 unknown-key error (F1/F4)", async () => {
    // The regression this task fixes: the three verbs used to parse the
    // mandated v2 matrix.yaml with the v1 loader, which hard-rejects
    // `subagent_templates`/`subagent_models`. Loading the committed example
    // through `presets list` must now succeed.
    const EXAMPLE_PATH = join(
      import.meta.dir,
      "..",
      "docs",
      "examples",
      "matrix.example.yaml",
    );
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: loadMatrixV2(EXAMPLE_PATH),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join(""));
    const harnessNames = parsed.harnesses.map(
      (g: { harness: string }) => g.harness,
    );
    expect(harnessNames).toEqual(["claude", "codex", "pi"]);
    const codex = parsed.harnesses.find(
      (g: { harness: string }) => g.harness === "codex",
    );
    expect(
      codex.triples.map((t: { triple: string; cell: boolean }) => [
        t.triple,
        t.cell,
      ]),
    ).toEqual([
      ["codex::gpt-5.3-codex-spark::high", true],
      ["codex::gpt-5.3-codex-spark::xhigh", true],
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
