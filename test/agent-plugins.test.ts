/**
 * Plugin discovery pins: the cwd `--plugin-dir .` detection, plugin_dirs
 * fail-loud on a missing manifest, plugin_scan_dirs best-effort skip of a
 * missing parent and discovery of manifest-bearing children. Proves the
 * fail-loud/best-effort asymmetry is preserved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverPlugins, PluginError } from "../src/agent/plugins";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-plugins-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePlugin(dir: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}\n");
}

const NO_SOURCES = { pluginDirs: [], pluginScanDirs: [] };

describe("cwd --plugin-dir . detection", () => {
  test("a cwd with commands/ adds --plugin-dir .", () => {
    const cwd = join(tmpDir, "repo");
    mkdirSync(join(cwd, "skills"), { recursive: true });
    const d = discoverPlugins(cwd, NO_SOURCES, "plugins.yaml");
    expect(d.args).toEqual(["--plugin-dir", "."]);
  });
  test("a cwd without any plugin subdir adds nothing", () => {
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    expect(discoverPlugins(cwd, NO_SOURCES, "plugins.yaml").args).toEqual([]);
  });
});

describe("plugin_dirs (fail-loud)", () => {
  test("a manifest-bearing dir is added", () => {
    const p = join(tmpDir, "keeper");
    makePlugin(p);
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const d = discoverPlugins(
      cwd,
      { pluginDirs: [p], pluginScanDirs: [] },
      "plugins.yaml",
    );
    expect(d.args).toEqual(["--plugin-dir", p]);
  });
  test("the Keeper plugin remains discoverable with its rename skill", () => {
    const keeperPlugin = resolve(import.meta.dir, "../plugins/keeper");
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const d = discoverPlugins(
      cwd,
      { pluginDirs: [keeperPlugin], pluginScanDirs: [] },
      "plugins.yaml",
    );
    expect(d.args).toEqual(["--plugin-dir", keeperPlugin]);
    expect(
      readFileSync(join(keeperPlugin, "skills/rename/SKILL.md"), "utf8"),
    ).toContain("\nname: rename\n");
  });
  test("a missing manifest throws PluginError", () => {
    const p = join(tmpDir, "broken");
    mkdirSync(p, { recursive: true });
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    expect(() =>
      discoverPlugins(
        cwd,
        { pluginDirs: [p], pluginScanDirs: [] },
        "plugins.yaml",
      ),
    ).toThrow(PluginError);
  });
});

describe("plugin_scan_dirs (best-effort)", () => {
  test("a missing parent is skipped, not fatal", () => {
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const d = discoverPlugins(
      cwd,
      { pluginDirs: [], pluginScanDirs: [join(tmpDir, "absent")] },
      "plugins.yaml",
    );
    expect(d.args).toEqual([]);
  });
  test("manifest-bearing children of a parent are discovered, sorted", () => {
    const scan = join(tmpDir, "scan");
    makePlugin(join(scan, "b-plugin"));
    makePlugin(join(scan, "a-plugin"));
    mkdirSync(join(scan, "not-a-plugin"), { recursive: true });
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const d = discoverPlugins(
      cwd,
      { pluginDirs: [], pluginScanDirs: [scan] },
      "plugins.yaml",
    );
    expect(d.args).toEqual([
      "--plugin-dir",
      join(scan, "a-plugin"),
      "--plugin-dir",
      join(scan, "b-plugin"),
    ]);
  });
});

describe("worker isolation gate (stripScanDirs)", () => {
  test("stripScanDirs drops scan results but keeps plugin_dirs and cwd `.`", () => {
    const hardDir = join(tmpDir, "keeper");
    makePlugin(hardDir);
    const scan = join(tmpDir, "scan");
    makePlugin(join(scan, "arthack"));
    const cwd = join(tmpDir, "repo");
    mkdirSync(join(cwd, "skills"), { recursive: true });
    const d = discoverPlugins(
      cwd,
      { pluginDirs: [hardDir], pluginScanDirs: [scan] },
      "plugins.yaml",
      { stripScanDirs: true },
    );
    // cwd `.` + the hard-listed plugin_dir survive; the scanned child is gone.
    expect(d.args).toEqual(["--plugin-dir", ".", "--plugin-dir", hardDir]);
    expect(d.args).not.toContain(join(scan, "arthack"));
  });
  test("stripScanDirs false is byte-identical to the default (scan intact)", () => {
    const scan = join(tmpDir, "scan");
    makePlugin(join(scan, "arthack"));
    const cwd = join(tmpDir, "bare");
    mkdirSync(cwd, { recursive: true });
    const sources = { pluginDirs: [], pluginScanDirs: [scan] };
    const off = discoverPlugins(cwd, sources, "plugins.yaml", {
      stripScanDirs: false,
    });
    const ungated = discoverPlugins(cwd, sources, "plugins.yaml");
    expect(off.args).toEqual(ungated.args);
    expect(off.args).toContain(join(scan, "arthack"));
  });
});
