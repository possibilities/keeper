/**
 * Named-preset launch-config wiring (task 1): the `--x-preset` flag and
 * `presets resolve` verb drive harness/model/effort through main()'s resolver
 * default slots at `explicit > env > preset > yaml > native` per field, the
 * harnessless form drives the harness from the preset, a head agent disagreeing
 * with the preset's harness fails loud, and `presets resolve` emits the pinned
 * JSON contract. A cold-start guard proves the launcher import graph never
 * reaches src/db.ts (bun:sqlite).
 */

import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  type PanelSelections,
  type Preset,
  type PresetCatalog,
} from "../src/agent/config";
import { main } from "../src/agent/main";
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

function selections(
  panels: Record<string, string[]>,
  def: string | null = null,
): PanelSelections {
  return { panels, default: def };
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

describe("presets resolve JSON contract", () => {
  test("a single preset emits the pinned object", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "p"],
      rawArgv: true,
      presetCatalog: catalog({
        p: preset({
          harness: "claude",
          model: "opus",
          effort: "xhigh",
          role: "reviewer",
        }),
      }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "preset",
      name: "p",
      harness: "claude",
      model: "opus",
      effort: "xhigh",
      thinking: null,
      role: "reviewer",
    });
  });

  test("a panel emits an ordered members array (catalog + panel selections)", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "duo"],
      rawArgv: true,
      presetCatalog: catalog({
        a: preset({ harness: "claude", model: "opus" }),
        b: preset({ harness: "codex", model: "gpt-5.5" }),
      }),
      panelSelections: selections({ duo: ["a", "b"] }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "panel",
      name: "duo",
      members: [
        { name: "a", harness: "claude" },
        { name: "b", harness: "codex" },
      ],
    });
  });

  test("the reserved name 'default' resolves the configured default panel by its real name", async () => {
    // The default pointer names `reviewers`; the envelope must report that real
    // name (pointer dereference), never the literal `default`.
    const h = makeHarness({
      argv: ["presets", "resolve", "default"],
      rawArgv: true,
      presetCatalog: catalog({
        a: preset({ harness: "claude", model: "opus" }),
        b: preset({ harness: "codex", model: "gpt-5.5" }),
      }),
      panelSelections: selections({ reviewers: ["a", "b"] }, "reviewers"),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "panel",
      name: "reviewers",
      members: [
        { name: "a", harness: "claude" },
        { name: "b", harness: "codex" },
      ],
    });
  });

  test("'default' with no configured default fails loud naming 'default'", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "default"],
      rawArgv: true,
      presetCatalog: catalog({ a: preset({ harness: "claude" }) }),
      panelSelections: selections({ reviewers: ["a"] }, null),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("default");
    expect(h.err.join("")).toContain("panel.yaml");
  });

  test("a catalog preset resolves without consulting panel.yaml", async () => {
    // A catalog-preset name wins before panel resolution — the empty default
    // panel selections (which would fail-loud a panel lookup) is never reached.
    const h = makeHarness({
      argv: ["presets", "resolve", "solo"],
      rawArgv: true,
      presetCatalog: catalog({ solo: preset({ harness: "claude" }) }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("")).kind).toBe("preset");
  });

  test("an unknown name fails loud naming presets and panels", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "ghost"],
      rawArgv: true,
      presetCatalog: catalog({ p: preset({ harness: "claude" }) }),
      panelSelections: selections({ duo: ["p"] }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
    expect(h.err.join("")).toContain("duo");
  });
});

describe("presets list discovery surface", () => {
  test("--json emits catalog presets + panels for machine use", async () => {
    const h = makeHarness({
      argv: ["presets", "list", "--json"],
      rawArgv: true,
      presetCatalog: {
        ...catalog({
          a: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
          b: preset({ harness: "codex", model: "gpt-5.5", effort: "high" }),
        }),
        claude_default: "a",
        codex_default: "b",
      },
      panelSelections: selections({ duo: ["a", "b"] }, "duo"),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "presets-list",
      presets: [
        {
          name: "a",
          harness: "claude",
          model: "opus",
          effort: "xhigh",
          thinking: null,
          role: null,
        },
        {
          name: "b",
          harness: "codex",
          model: "gpt-5.5",
          effort: "high",
          thinking: null,
          role: null,
        },
      ],
      panels: [
        {
          name: "duo",
          members: [
            { name: "a", harness: "claude" },
            { name: "b", harness: "codex" },
          ],
        },
      ],
      default: "duo",
      defaults: { claude: "a", codex: "b", pi: null, hermes: null },
    });
  });

  test("human-readable default lists names + harnesses", async () => {
    const h = makeHarness({
      argv: ["presets", "list"],
      rawArgv: true,
      presetCatalog: {
        ...catalog({
          a: preset({ harness: "claude", model: "opus" }),
        }),
        claude_default: "a",
      },
      panelSelections: selections({ duo: ["a"] }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("a");
    expect(text).toContain("claude");
    expect(text).toContain("model=opus");
    expect(text).toContain("duo");
    expect(text).toContain("claude_default  a");
    expect(text).toContain("pi_default  (unset)");
  });

  test("a missing catalog yields the discovery error (exit 2), not a crash", async () => {
    const h = makeHarness({ argv: ["presets", "list"], rawArgv: true });
    h.deps.loadPresetCatalogFn = () => {
      throw new ConfigError("Preset catalog missing at /x/presets.yaml.");
    };
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("Preset catalog missing");
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

  test("marker sanity: src/db.ts bundle DOES reference bun:sqlite", async () => {
    expect(await bundledText("./src/db.ts")).toContain("bun:sqlite");
  });
});
