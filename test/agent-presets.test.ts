/**
 * Launcher config surface: the `--x-preset` flag still drives an in-session
 * launch's harness/model/effort through main()'s resolver default slots at
 * `explicit > env > preset > yaml > native` per field (the named-preset launch
 * path, retired in a later task); the launch-triple grammar (`parseTriple` /
 * `slugifyTriple`) validates `harness::model::effort` by construction; and the
 * reshaped `presets resolve` / `presets list` verbs emit the triple + virtual-cube
 * contracts. A cold-start guard proves the launcher import graph never reaches
 * src/db.ts (bun:sqlite).
 */

import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  type Preset,
  type PresetCatalog,
} from "../src/agent/config";
import { main } from "../src/agent/main";
import type { Matrix } from "../src/agent/matrix";
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

function preset(
  over: Partial<Preset> & { harness: Preset["harness"] },
): Preset {
  return {
    model: null,
    effort: null,
    thinking: null,
    role: null,
    ...over,
  };
}

function catalog(presets: Record<string, Preset>): PresetCatalog {
  return { presets };
}

describe("--x-preset precedence (claude)", () => {
  test("preset model + effort feed the default slot", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "p", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: catalog({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });

  test("explicit --model wins over the preset; preset effort still applies", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "p", "--model", "sonnet", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: catalog({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    // Explicit --model is forwarded verbatim; the wrapper adds no second --model.
    expect(flagValues(cmd, "--model")).toEqual(["sonnet"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });

  test("CLAUDE_CODE_EFFORT_LEVEL env beats the preset effort", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "p", "hi"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "low" },
      listProfiles: () => ["default"],
      presetCatalog: catalog({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    // Env wins → the wrapper adds NO --effort; model still from the preset.
    expect(flagValues(cmd, "--effort")).toEqual([]);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });

  test("a model-only preset with no effort is fail-loud on a fresh launch", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--x-preset", "p", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: catalog({
        p: preset({ harness: "claude", model: "opus" }),
      }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("--effort");
    expect(h.spawned.length).toBe(0);
  });
});

describe("--x-preset precedence (codex + pi)", () => {
  test("codex preset model + effort feed the resolver default slot", async () => {
    const h = makeHarness({
      agent: "codex",
      argv: ["--x-no-confirm", "--x-preset", "c", "hi"],
      presetCatalog: catalog({
        c: preset({ harness: "codex", model: "gpt-5.5", effort: "high" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5"]);
    expect(cmd).toContain('model_reasoning_effort="high"');
  });

  test("pi preset model + thinking feed the resolver default slot", async () => {
    const h = makeHarness({
      agent: "pi",
      argv: ["--x-no-confirm", "--x-preset", "pp", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: catalog({
        pp: preset({ harness: "pi", model: "pi-pro", thinking: "deep" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["pi-pro"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["deep"]);
  });
});

describe("harnessless run-preset + harness agreement", () => {
  test("the harnessless form drives the harness from the preset (codex)", async () => {
    const h = makeHarness({
      argv: ["--x-preset", "c", "--x-no-confirm", "hi"],
      rawArgv: true,
      presetCatalog: catalog({
        c: preset({ harness: "codex", model: "gpt-5.5", effort: "high" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5"]);
  });

  test("a head agent disagreeing with the preset harness fails loud", async () => {
    const h = makeHarness({
      argv: ["codex", "--x-no-confirm", "--x-preset", "p", "hi"],
      rawArgv: true,
      presetCatalog: catalog({
        p: preset({ harness: "claude", model: "opus" }),
      }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("pins harness claude");
    expect(h.spawned.length).toBe(0);
  });

  test("a missing preset name fails loud", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-no-confirm", "--x-preset", "ghost"],
      rawArgv: true,
      presetCatalog: catalog({
        p: preset({ harness: "claude" }),
      }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
    expect(h.spawned.length).toBe(0);
  });
});

describe("no --x-preset → harness default pointer", () => {
  test("a fresh launch resolves the catalog claude_default", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: {
        presets: {
          d: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
        },
        claude_default: "d",
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });

  test("only the matching-harness default is resolved for the launch", async () => {
    // A catalog carrying every harness default resolves ONLY the claude one for
    // a claude launch — the codex/pi pointers never touch it.
    const h = makeHarness({
      argv: ["--x-no-confirm", "hi"],
      listProfiles: () => ["default"],
      presetCatalog: {
        presets: {
          cd: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
          xd: preset({ harness: "codex", model: "gpt", effort: "high" }),
        },
        claude_default: "cd",
        codex_default: "xd",
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
      listProfiles: () => ["default"],
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
      listProfiles: () => ["default"],
      presetCatalog: EMPTY,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.spawned.length).toBe(0);
  });

  test("both --model and --effort explicit launches (the both-explicit escape)", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "--model", "opus", "--effort", "xhigh", "hi"],
      listProfiles: () => ["default"],
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
      listProfiles: () => ["default"],
      presetCatalog: EMPTY,
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });

  test("--continue (resume) with no default does NOT fail-loud", async () => {
    const h = makeHarness({
      argv: ["--continue"],
      listProfiles: () => ["default"],
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
      listProfiles: () => ["default"],
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
  const listMatrix: Matrix = {
    efforts: ["low", "high"],
    providers: [
      {
        name: "claude",
        route: true,
        models: new Map([["opus", "opus"]]),
        modelEfforts: new Map(),
      },
      {
        name: "pi",
        route: false,
        models: new Map([["spark", "pi/spark"]]),
        modelEfforts: new Map(),
      },
    ],
    subagents: ["work"],
    wrapper_driver: { model: "sonnet", effort: "high" },
    defaults: { stop_timeout_ms: 7200000, max_attempts: 2 },
  };

  test("--json emits the virtual cube, the four defaults, and panels", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      matrix: listMatrix,
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
          route: true,
          triples: [
            {
              triple: "claude::opus::low",
              capability: "opus",
              native_id: "opus",
              effort: "low",
            },
            {
              triple: "claude::opus::high",
              capability: "opus",
              native_id: "opus",
              effort: "high",
            },
          ],
        },
        {
          harness: "pi",
          route: false,
          triples: [
            {
              triple: "pi::pi/spark::low",
              capability: "spark",
              native_id: "pi/spark",
              effort: "low",
            },
            {
              triple: "pi::pi/spark::high",
              capability: "spark",
              native_id: "pi/spark",
              effort: "high",
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
      matrix: listMatrix,
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
    expect(text).toContain("pi (launch-only)");
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
      throw new ConfigError("Unknown top-level key 'x' in /x/matrix.yaml.");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("Unknown top-level key");
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
