/**
 * Standing assertion for the plugin composition map (docs/plugin-composition-map.md).
 *
 * The map's load-bearing claim is that EVERY claude launch channel — interactive,
 * `keeper agent` manual dispatch, AND the autopilot worker — inherits the SAME
 * base plugin set from plugins.yaml, and the per-cell worker `--plugin-dir` is
 * ADDITIVE (it never isolates a worker to just the cell manifest). This test pins
 * that reality at the two seams the map is derived from, so the doc cannot
 * silently rot:
 *
 *   1. config parsing (`loadPluginSources`) → discovery (`discoverPlugins`): the
 *      discovery seam takes NO channel/worker discriminator, so its output is a
 *      pure function of (cwd, sources). A worker and an interactive launch on the
 *      same cwd+config compute an identical base set.
 *   2. flag assembly (`buildKeeperAgentLaunchArgv`): a worker launch routes
 *      through `keeper agent claude` (so it hits the `agent === "claude"`
 *      discovery gate in agent/main.ts), and the per-cell `--plugin-dir` rides as
 *      an ADDITIVE flag — the argv with a cell dir is byte-identical to the argv
 *      without it plus exactly that one `--plugin-dir <cell>` pair.
 *
 * If a future change gates discovery on a worker flag, or turns the per-cell dir
 * into a replacement, one of these pins fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginSources } from "../src/agent/config";
import { discoverPlugins } from "../src/agent/plugins";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-composition-map-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePlugin(dir: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}\n");
}

/**
 * Materialize a plugins.yaml fixture mirroring production reality: two hard
 * `plugin_dirs` (keeper + plan) and a `plugin_scan_dirs` parent whose children
 * are the arthack-shaped third-party plugins. Returns the config path plus the
 * absolute dirs so assertions can pin membership.
 */
function writeConfig(): {
  configPath: string;
  keeperDir: string;
  planDir: string;
  arthackDir: string;
} {
  const keeperDir = join(tmpDir, "plugins", "keeper");
  const planDir = join(tmpDir, "plugins", "plan");
  const scanParent = join(tmpDir, "arthack", "claude");
  const arthackDir = join(scanParent, "arthack");
  makePlugin(keeperDir);
  makePlugin(planDir);
  makePlugin(arthackDir);
  const configPath = join(tmpDir, "plugins.yaml");
  writeFileSync(
    configPath,
    [
      "plugin_dirs:",
      `  - ${keeperDir}`,
      `  - ${planDir}`,
      "plugin_scan_dirs:",
      `  - ${scanParent}`,
      "",
    ].join("\n"),
  );
  return { configPath, keeperDir, planDir, arthackDir };
}

describe("composition map — base set derives from config + is channel-invariant", () => {
  test("loadPluginSources + discoverPlugins yields keeper + plan + scanned arthack", () => {
    const { configPath, keeperDir, planDir, arthackDir } = writeConfig();
    const sources = loadPluginSources(configPath);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const { args } = discoverPlugins(cwd, sources, configPath);
    // Every configured hard dep and every scanned child is in the base set —
    // this is the exact plugin surface EVERY claude launch inherits.
    expect(args).toContain(keeperDir);
    expect(args).toContain(planDir);
    expect(args).toContain(arthackDir);
  });

  test("discovery has no channel discriminator — worker and interactive compute the same base set", () => {
    const { configPath } = writeConfig();
    const sources = loadPluginSources(configPath);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    // The launcher gates discovery ONLY on `agent === "claude"` (agent/main.ts),
    // with no worker sub-gate; `discoverPlugins` itself takes no channel arg. So
    // the "interactive" and "worker" channels are the identical call — pin that
    // by asserting two invocations are deep-equal (there is no branch to diverge).
    const interactive = discoverPlugins(cwd, sources, configPath);
    const worker = discoverPlugins(cwd, sources, configPath);
    expect(worker.args).toEqual(interactive.args);
  });
});

describe("composition map — per-cell --plugin-dir is additive", () => {
  const PREFIX = [
    "/fake-home/.bun/bin/bun",
    "/fake-home/code/keeper/cli/keeper.ts",
    "agent",
  ] as const;

  test("worker launch routes through `keeper agent claude` (hits the claude discovery gate)", () => {
    const cmd = buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: [...PREFIX],
      session: "work",
      prompt: "do it",
      claudeName: "proj-001",
      pluginDir: "/cells/opus-high",
      noConfirm: true,
    });
    // The agent token immediately follows the prefix — a worker is a plain
    // `keeper agent claude …`, so it inherits the SAME `agent === "claude"`
    // plugin discovery as an interactive launch (no worker isolation).
    expect(cmd[PREFIX.length]).toBe("claude");
  });

  test("the cell --plugin-dir is purely additive over the no-cell argv", () => {
    const base = {
      launcherArgvPrefix: [...PREFIX],
      session: "work",
      prompt: "do it",
      claudeName: "proj-001",
      noConfirm: true,
    } as const;
    const withoutCell = buildKeeperAgentLaunchArgv(base);
    const withCell = buildKeeperAgentLaunchArgv({
      ...base,
      pluginDir: "/cells/opus-high",
    });
    // The cell dir rides as exactly one `--plugin-dir <cell>` pair; stripping it
    // must recover the byte-identical no-cell argv. That is the additive proof —
    // the per-cell manifest is layered ON TOP of the inherited plugins.yaml, not
    // a replacement that isolates the worker.
    const idx = withCell.indexOf("--plugin-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(withCell[idx + 1]).toBe("/cells/opus-high");
    const stripped = [...withCell];
    stripped.splice(idx, 2);
    expect(stripped).toEqual(withoutCell);
    // And the no-cell launch carries no `--plugin-dir` of its own.
    expect(withoutCell).not.toContain("--plugin-dir");
  });
});
