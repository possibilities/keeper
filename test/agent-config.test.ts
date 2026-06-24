/**
 * Config adapter pins: launcher model/effort defaults (absent file/key → null,
 * malformed → fail-loud) and plugin sources (missing file fail-loud,
 * ~-expansion). Fixture configs only — the live ~/.config is arthack-owned stow
 * state we must not touch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadClaudeStowDir,
  loadLauncherDefaults,
  loadPiLauncherDefaults,
  loadPluginSources,
} from "../src/agent/config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentwrap-config-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, body);
  return p;
}

describe("loadLauncherDefaults", () => {
  test("missing file → all defaults (null/null)", () => {
    expect(loadLauncherDefaults(join(tmpDir, "nope.yaml"))).toEqual({
      model: null,
      effort: null,
    });
  });
  test("present keys are read and trimmed", () => {
    const p = writeYaml("claude.yaml", "model: opus\neffort: high\n");
    expect(loadLauncherDefaults(p)).toEqual({
      model: "opus",
      effort: "high",
    });
  });
  test("absent key → null for that field", () => {
    const p = writeYaml("claude.yaml", "model: opus\n");
    expect(loadLauncherDefaults(p)).toEqual({
      model: "opus",
      effort: null,
    });
  });
  test("empty-string value is fail-loud", () => {
    const p = writeYaml("claude.yaml", 'model: ""\n');
    expect(() => loadLauncherDefaults(p)).toThrow(ConfigError);
  });
  test("non-mapping document is fail-loud", () => {
    const p = writeYaml("claude.yaml", "- a\n- b\n");
    expect(() => loadLauncherDefaults(p)).toThrow(ConfigError);
  });
});

describe("loadPiLauncherDefaults", () => {
  test("missing file → all defaults (null/null)", () => {
    expect(loadPiLauncherDefaults(join(tmpDir, "nope.yaml"))).toEqual({
      model: null,
      thinking: null,
    });
  });
  test("present keys are read and trimmed", () => {
    const p = writeYaml("pi.yaml", "model: opus\nthinking: high\n");
    expect(loadPiLauncherDefaults(p)).toEqual({
      model: "opus",
      thinking: "high",
    });
  });
  test("absent key → null for that field", () => {
    const p = writeYaml("pi.yaml", "model: opus\n");
    expect(loadPiLauncherDefaults(p)).toEqual({
      model: "opus",
      thinking: null,
    });
  });
  test("empty-string value is fail-loud", () => {
    const p = writeYaml("pi.yaml", 'thinking: ""\n');
    expect(() => loadPiLauncherDefaults(p)).toThrow(ConfigError);
  });
});

describe("loadClaudeStowDir", () => {
  test("missing file → null (fail-open)", () => {
    expect(loadClaudeStowDir(join(tmpDir, "nope.yaml"))).toBeNull();
  });
  test("absent key → null (fail-open)", () => {
    const p = writeYaml("claude.yaml", "model: opus\n");
    expect(loadClaudeStowDir(p)).toBeNull();
  });
  test("~ is expanded and the path is absolutized", () => {
    const p = writeYaml(
      "claude.yaml",
      "claude_stow_dir: ~/code/arthack/system/claude/.claude\n",
    );
    expect(loadClaudeStowDir(p)).toBe(
      join(homedir(), "code/arthack/system/claude/.claude"),
    );
  });
  test("an already-absolute path is preserved", () => {
    const p = writeYaml("claude.yaml", "claude_stow_dir: /opt/stow/.claude\n");
    expect(loadClaudeStowDir(p)).toBe("/opt/stow/.claude");
  });
  test("empty-string value is fail-loud", () => {
    const p = writeYaml("claude.yaml", 'claude_stow_dir: ""\n');
    expect(() => loadClaudeStowDir(p)).toThrow(ConfigError);
  });
  test("non-string value is fail-loud", () => {
    const p = writeYaml("claude.yaml", "claude_stow_dir:\n  - a\n");
    expect(() => loadClaudeStowDir(p)).toThrow(ConfigError);
  });
});

describe("loadPluginSources", () => {
  test("missing config file is fail-loud", () => {
    expect(() => loadPluginSources(join(tmpDir, "nope.yaml"))).toThrow(
      ConfigError,
    );
  });
  test("empty config → empty lists", () => {
    const p = writeYaml("plugins.yaml", "{}\n");
    expect(loadPluginSources(p)).toEqual({
      pluginDirs: [],
      pluginScanDirs: [],
    });
  });
  test("entries are read into both lists", () => {
    const a = join(tmpDir, "a");
    const b = join(tmpDir, "scan");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const p = writeYaml(
      "plugins.yaml",
      `plugin_dirs:\n  - ${a}\nplugin_scan_dirs:\n  - ${b}\n`,
    );
    expect(loadPluginSources(p)).toEqual({
      pluginDirs: [a],
      pluginScanDirs: [b],
    });
  });
  test("a non-list value is fail-loud", () => {
    const p = writeYaml("plugins.yaml", "plugin_dirs: notalist\n");
    expect(() => loadPluginSources(p)).toThrow(/list/);
  });
  test("an empty-string entry is fail-loud", () => {
    const p = writeYaml("plugins.yaml", 'plugin_dirs:\n  - ""\n');
    expect(() => loadPluginSources(p)).toThrow(/non-empty/);
  });
});
