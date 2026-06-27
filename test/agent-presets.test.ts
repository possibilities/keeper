/**
 * Named-preset launch-config wiring (task 1): the `--agentwrap-preset` flag and
 * `presets resolve` verb drive harness/model/effort through main()'s resolver
 * default slots at `explicit > env > preset > yaml > native` per field, the
 * harnessless form drives the harness from the preset, a head agent disagreeing
 * with the preset's harness fails loud, and `presets resolve` emits the pinned
 * JSON contract. A cold-start guard proves the launcher import graph never
 * reaches src/db.ts (bun:sqlite).
 */

import { describe, expect, test } from "bun:test";
import type { Preset, PresetRegistry } from "../src/agent/config";
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

function registry(
  presets: Record<string, Preset>,
  panels: Record<string, string[]> = {},
): PresetRegistry {
  return { presets, panels };
}

describe("--agentwrap-preset precedence (claude)", () => {
  test("preset model + effort feed the default slot", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "p", "hi"],
      listProfiles: () => ["default"],
      presetRegistry: registry({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["xhigh"]);
  });

  test("explicit --model wins over the preset; preset effort still applies", async () => {
    const h = makeHarness({
      argv: [
        "--agentwrap-no-confirm",
        "--agentwrap-preset",
        "p",
        "--model",
        "sonnet",
        "hi",
      ],
      listProfiles: () => ["default"],
      presetRegistry: registry({
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
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "p", "hi"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "low" },
      listProfiles: () => ["default"],
      presetRegistry: registry({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    // Env wins → the wrapper adds NO --effort; model still from the preset.
    expect(flagValues(cmd, "--effort")).toEqual([]);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });

  test("a model-only preset leaves effort falling through to yaml", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "p", "hi"],
      listProfiles: () => ["default"],
      launcherEffort: "high",
      presetRegistry: registry({
        p: preset({ harness: "claude", model: "opus" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
    expect(flagValues(cmd, "--effort")).toEqual(["high"]);
  });

  test("the preset model layers over yaml when both are set", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "p", "hi"],
      listProfiles: () => ["default"],
      launcherModel: "sonnet",
      presetRegistry: registry({
        p: preset({ harness: "claude", model: "opus" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["opus"]);
  });
});

describe("--agentwrap-preset precedence (codex + pi)", () => {
  test("codex preset model + effort feed the resolver default slot", async () => {
    const h = makeHarness({
      agent: "codex",
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "c", "hi"],
      presetRegistry: registry({
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
      argv: ["--agentwrap-no-confirm", "--agentwrap-preset", "pp", "hi"],
      listProfiles: () => ["default"],
      presetRegistry: registry({
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
      argv: ["--agentwrap-preset", "c", "--agentwrap-no-confirm", "hi"],
      rawArgv: true,
      presetRegistry: registry({
        c: preset({ harness: "codex", model: "gpt-5.5" }),
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(flagValues(cmd, "--model")).toEqual(["gpt-5.5"]);
  });

  test("a head agent disagreeing with the preset harness fails loud", async () => {
    const h = makeHarness({
      argv: [
        "codex",
        "--agentwrap-no-confirm",
        "--agentwrap-preset",
        "p",
        "hi",
      ],
      rawArgv: true,
      presetRegistry: registry({
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
      argv: ["claude", "--agentwrap-no-confirm", "--agentwrap-preset", "ghost"],
      rawArgv: true,
      presetRegistry: registry({
        p: preset({ harness: "claude" }),
      }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
    expect(h.spawned.length).toBe(0);
  });
});

describe("no preset → byte-identical to today", () => {
  test("no --agentwrap-preset leaves the spawned argv unchanged", async () => {
    const base = makeHarness({
      argv: ["--agentwrap-no-confirm", "hi"],
      listProfiles: () => ["default"],
    });
    const baseCmd = await runAndCapture(base, main);
    const withRegistry = makeHarness({
      argv: ["--agentwrap-no-confirm", "hi"],
      listProfiles: () => ["default"],
      presetRegistry: registry({
        p: preset({ harness: "claude", model: "opus", effort: "xhigh" }),
      }),
    });
    const cmd2 = await runAndCapture(withRegistry, main);
    // A populated registry that no flag references must not touch the launch.
    expect(cmd2).toEqual(baseCmd);
    expect(flagValues(cmd2, "--model")).toEqual([]);
  });
});

describe("presets resolve JSON contract", () => {
  test("a single preset emits the pinned object", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "p"],
      rawArgv: true,
      presetRegistry: registry({
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

  test("a panel emits an ordered members array", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "duo"],
      rawArgv: true,
      presetRegistry: registry(
        {
          a: preset({ harness: "claude", model: "opus" }),
          b: preset({ harness: "codex", model: "gpt-5.5" }),
        },
        { duo: ["a", "b"] },
      ),
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

  test("a panel with a pi member is accepted (pi is pair-launchable)", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "mixed"],
      rawArgv: true,
      presetRegistry: registry(
        {
          a: preset({ harness: "claude" }),
          z: preset({ harness: "pi" }),
        },
        { mixed: ["a", "z"] },
      ),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      kind: "panel",
      name: "mixed",
      members: [
        { name: "a", harness: "claude" },
        { name: "z", harness: "pi" },
      ],
    });
  });

  test("an unknown name fails loud", async () => {
    const h = makeHarness({
      argv: ["presets", "resolve", "ghost"],
      rawArgv: true,
      presetRegistry: registry({ p: preset({ harness: "claude" }) }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ghost");
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
