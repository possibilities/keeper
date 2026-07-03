/**
 * Standing assertion for the plugin composition map (docs/plugin-composition-map.md).
 *
 * The map's load-bearing claim is that BY DEFAULT every claude launch channel —
 * interactive, `keeper agent` manual dispatch, AND the autopilot worker —
 * inherits the SAME base plugin set from plugins.yaml, and the per-cell worker
 * `--plugin-dir` is ADDITIVE (it never isolates a worker to just the cell
 * manifest). This test pins that reality at the two seams the map is derived
 * from, so the doc cannot silently rot:
 *
 *   1. config parsing (`loadPluginSources`) → discovery (`discoverPlugins`): with
 *      the worker-isolation gate OFF (the default), discovery is a pure function
 *      of (cwd, sources) with no channel/worker branch, so a worker and an
 *      interactive launch on the same cwd+config compute an identical base set.
 *   2. flag assembly (`buildKeeperAgentLaunchArgv`): a worker launch routes
 *      through `keeper agent claude` (so it hits the `agent === "claude"`
 *      discovery gate in agent/main.ts), and the per-cell `--plugin-dir` rides as
 *      an ADDITIVE flag — the argv with a cell dir is byte-identical to the argv
 *      without it plus exactly that one `--plugin-dir <cell>` pair.
 *
 * The `worker_plugin_isolation` config knob (default OFF) adds a config-flagged
 * worker sub-gate at the discovery seam: when ON, a keeper-automated worker
 * launch (marked by `--dangerously-skip-permissions`) drops the
 * `plugin_scan_dirs` results but keeps the hard-listed `plugin_dirs`. The final
 * describe block pins BOTH gate states — OFF byte-identical to today, ON stripping
 * only the scanned third-party set — plus the argv marker the seam keys on.
 *
 * If a future change gates discovery on a worker flag WHEN THE KNOB IS OFF, turns
 * the per-cell dir into a replacement, or lets the gate strip a hard-listed
 * plugin_dir, one of these pins fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginSources } from "../src/agent/config";
import { main } from "../src/agent/main";
import { discoverPlugins } from "../src/agent/plugins";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

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

const PREFIX = [
  "/fake-home/.bun/bin/bun",
  "/fake-home/code/keeper/cli/keeper.ts",
  "agent",
] as const;

/**
 * Materialize a plugins.yaml fixture mirroring production reality: two hard
 * `plugin_dirs` (keeper + plan) and a `plugin_scan_dirs` parent whose children
 * are the arthack-shaped third-party plugins. Returns the config path plus the
 * absolute dirs so assertions can pin membership.
 */
function writeConfig(opts: { gated?: boolean } = {}): {
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
      ...(opts.gated ? ["worker_plugin_isolation: strip-scan-dirs"] : []),
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

  test("gate OFF (default) — worker and interactive compute the same base set", () => {
    const { configPath } = writeConfig();
    const sources = loadPluginSources(configPath);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    // With the worker-isolation knob OFF (the default), the launcher gates
    // discovery ONLY on `agent === "claude"` (agent/main.ts) with no worker
    // sub-gate. The "interactive" and "worker" channels are the identical call —
    // pin that by asserting an ungated (no options) and an explicit gate-OFF call
    // are deep-equal (there is no branch to diverge).
    const interactive = discoverPlugins(cwd, sources, configPath);
    const worker = discoverPlugins(cwd, sources, configPath, {
      stripScanDirs: false,
    });
    expect(worker.args).toEqual(interactive.args);
  });
});

describe("composition map — the config-flagged worker isolation gate", () => {
  test("gate ON strips the scanned third-party set but keeps hard-listed plugin_dirs", () => {
    const { configPath, keeperDir, planDir, arthackDir } = writeConfig();
    const sources = loadPluginSources(configPath);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const { args } = discoverPlugins(cwd, sources, configPath, {
      stripScanDirs: true,
    });
    // A gated worker loads ONLY the explicitly hard-listed plugin_dirs (keeper +
    // plan). The scanned arthack child is stripped — the risk boundary: strip
    // SCAN results, never the plugin_dirs a machine hard-lists.
    expect(args).toContain(keeperDir);
    expect(args).toContain(planDir);
    expect(args).not.toContain(arthackDir);
  });

  test("gate OFF is byte-identical to today (scan set intact)", () => {
    const { configPath, arthackDir } = writeConfig();
    const sources = loadPluginSources(configPath);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    // Explicit OFF and the ungated (options-omitted) call are the same args, and
    // both still carry the scanned arthack child — the OFF path never diverges.
    const off = discoverPlugins(cwd, sources, configPath, {
      stripScanDirs: false,
    });
    const ungated = discoverPlugins(cwd, sources, configPath);
    expect(off.args).toEqual(ungated.args);
    expect(off.args).toContain(arthackDir);
  });

  test("the knob parses from plugins.yaml as the gate's ON source", () => {
    // `loadPluginSources` surfaces the resolved policy the seam ANDs with
    // worker-ness; the seam obeys the config knob, discovery obeys the resolved
    // decision. Pin that the knob maps to workerPluginIsolation.
    const { configPath } = writeConfig();
    expect(loadPluginSources(configPath).workerPluginIsolation).toBe(false);
    const gated = join(tmpDir, "gated.yaml");
    writeFileSync(gated, "worker_plugin_isolation: strip-scan-dirs\n");
    expect(loadPluginSources(gated).workerPluginIsolation).toBe(true);
  });

  test("the seam's worker marker rides every worker argv", () => {
    // The seam keys the gate on `--dangerously-skip-permissions`, keeper's
    // human-less worker permission posture. Pin that the worker argv builder
    // always emits it, so the marker the seam sniffs cannot silently drift off
    // the worker launch.
    const cmd = buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: [...PREFIX],
      session: "work",
      prompt: "do it",
      claudeName: "proj-001",
      noConfirm: true,
    });
    expect(cmd).toContain("--dangerously-skip-permissions");
  });
});

/**
 * End-to-end seam drive: the previous describe blocks call `discoverPlugins`
 * with an EXPLICIT `{stripScanDirs}` boolean, which never proves `main()` itself
 * reads `--dangerously-skip-permissions` back out of `remainingArgs` at the
 * `agent/main.ts` gate call site to COMPUTE that boolean. These tests drive the
 * real `main()` arg vector end-to-end (config knob ON) and assert the composed
 * native argv — so a regression where the flag is consumed upstream, moves past a
 * `--` separator, or the gate stops ANDing it in leaves a worker inheriting the
 * scanned set and turns one of these red.
 */
describe("composition map — the isolation gate reads the flag from the real main() argv", () => {
  function driveMain(argv: string[]): Promise<string[]> {
    const { configPath } = writeConfig({ gated: true });
    const h = makeHarness({ argv, rawArgv: true });
    // Point the launcher's config seams at the gated fixture; the harness cwd
    // (`/fake-home/code/proj`) has no commands/agents/skills/hooks dir on disk,
    // so no cwd `--plugin-dir .` is injected — the only scanned entry is arthack.
    h.deps.pluginConfigPath = configPath;
    h.deps.loadPluginSourcesFn = () => loadPluginSources(configPath);
    return runAndCapture(h, main);
  }

  test("worker argv (knob ON + flag present) strips the scanned set, keeps plugin_dirs", async () => {
    const { keeperDir, planDir, arthackDir } = writeConfig({ gated: true });
    const cmd = await driveMain([
      "claude",
      "hello",
      "--dangerously-skip-permissions",
    ]);
    // The gate observed the flag at the seam: hard-listed dirs ride, the scanned
    // arthack child is gone. The marker itself must still reach the seam.
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain(keeperDir);
    expect(cmd).toContain(planDir);
    expect(cmd).not.toContain(arthackDir);
  });

  test("interactive argv (knob ON, flag absent) retains the scanned set", async () => {
    const { arthackDir } = writeConfig({ gated: true });
    const cmd = await driveMain(["claude", "hello"]);
    // Same knob-ON config, but no worker marker → the AND-gate is false and the
    // scanned arthack child survives, exactly as an interactive human launch.
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).toContain(arthackDir);
  });
});

describe("composition map — per-cell --plugin-dir is additive", () => {
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
