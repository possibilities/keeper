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
  keeperConfigDir,
  loadClaudeStowDir,
  loadLauncherDefaults,
  loadPanelSelections,
  loadPiLauncherDefaults,
  loadPluginSources,
  loadPresetCatalog,
  type PresetCatalog,
  panelConfigPath,
  presetsCatalogPath,
  resolvePreset,
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

/** A catalog with claude (a), codex (b), and pi (z) presets for panel tests. */
function catalogFixture(): PresetCatalog {
  return {
    presets: {
      a: {
        harness: "claude",
        model: null,
        effort: null,
        thinking: null,
        role: null,
      },
      b: {
        harness: "codex",
        model: null,
        effort: null,
        thinking: null,
        role: null,
      },
      z: {
        harness: "pi",
        model: null,
        effort: null,
        thinking: null,
        role: null,
      },
    },
  };
}

describe("loadPresetCatalog", () => {
  test("a missing file is fail-loud (the required-catalog reversal)", () => {
    // No legacy file at the supplied (nonexistent) legacy path → no hint.
    expect(() =>
      loadPresetCatalog(
        join(tmpDir, "nope.yaml"),
        join(tmpDir, "no-legacy.yaml"),
      ),
    ).toThrow(ConfigError);
  });

  test("an empty presets mapping is valid (worker tolerance)", () => {
    const p = writeYaml("presets.yaml", "presets: {}\n");
    expect(loadPresetCatalog(p)).toEqual({ presets: {} });
  });

  test("a whitespace-only file parses to an empty catalog", () => {
    const p = writeYaml("presets.yaml", "\n");
    expect(loadPresetCatalog(p)).toEqual({ presets: {} });
  });

  test("an unknown top-level key is fail-loud (strict reject)", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  a:\n    harness: claude\npanels:\n  duo:\n    - a\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(
      /Unknown top-level key 'panels'/,
    );
  });

  test("malformed YAML is fail-loud", () => {
    const p = writeYaml("presets.yaml", "presets: [unterminated\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
  });

  test("a full preset (claude) is read", () => {
    const p = writeYaml(
      "presets.yaml",
      [
        "presets:",
        "  claude-opus-xhigh:",
        "    harness: claude",
        "    model: opus",
        "    effort: xhigh",
        "    role: reviewer",
        "",
      ].join("\n"),
    );
    const cat = loadPresetCatalog(p);
    expect(cat.presets["claude-opus-xhigh"]).toEqual({
      harness: "claude",
      model: "opus",
      effort: "xhigh",
      thinking: null,
      role: "reviewer",
    });
  });

  test("a partial preset leaves omitted fields null", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  m-only:\n    harness: claude\n    model: opus\n",
    );
    expect(loadPresetCatalog(p).presets["m-only"]).toEqual({
      harness: "claude",
      model: "opus",
      effort: null,
      thinking: null,
      role: null,
    });
  });

  test("invalid harness is fail-loud", () => {
    const p = writeYaml("presets.yaml", "presets:\n  bad:\n    harness: gpt\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
  });

  test("effort + thinking on the same preset is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  both:\n    harness: pi\n    effort: high\n    thinking: deep\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
  });

  test("thinking on a non-pi harness is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  t:\n    harness: claude\n    thinking: deep\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/pi-only/);
  });

  test("effort on a pi harness is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  e:\n    harness: pi\n    effort: high\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/claude\/codex-only/);
  });

  test("a reserved preset name is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  default:\n    harness: claude\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/reserved/);
  });

  test("a YAML-1.1-boolean-looking name is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  yes:\n    harness: claude\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/reserved/);
  });

  test("a non-matching name (uppercase) is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  Opus:\n    harness: claude\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/\[a-z0-9_-\]/);
  });

  test("a missing-file error names the leftover legacy path + new layout", () => {
    const legacy = writeYaml("legacy-presets.yaml", "presets: {}\n");
    let msg = "";
    try {
      loadPresetCatalog(join(tmpDir, "absent.yaml"), legacy);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(legacy);
    expect(msg).toContain("presets.yaml");
    expect(msg).toContain("panel.yaml");
  });
});

describe("loadPanelSelections", () => {
  test("a missing file is fail-loud (the required-panel reversal)", () => {
    expect(() =>
      loadPanelSelections(
        catalogFixture(),
        join(tmpDir, "nope.yaml"),
        join(tmpDir, "no-legacy.yaml"),
      ),
    ).toThrow(ConfigError);
  });

  test("a panel of existing presets is read in order", () => {
    const p = writeYaml("panel.yaml", "panels:\n  duo:\n    - a\n    - b\n");
    expect(loadPanelSelections(catalogFixture(), p).panels.duo).toEqual([
      "a",
      "b",
    ]);
  });

  test("a member referencing no catalog preset is fail-loud", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - a\n    - ghost\n",
    );
    expect(() => loadPanelSelections(catalogFixture(), p)).toThrow(
      /undefined preset 'ghost'/,
    );
  });

  test("a pi member is rejected at load (claude|codex only)", () => {
    const p = writeYaml("panel.yaml", "panels:\n  mixed:\n    - a\n    - z\n");
    expect(() => loadPanelSelections(catalogFixture(), p)).toThrow(
      /not panel-launchable/,
    );
  });

  test("an empty panel list is fail-loud", () => {
    const p = writeYaml("panel.yaml", "panels:\n  empty: []\n");
    expect(() => loadPanelSelections(catalogFixture(), p)).toThrow(
      /non-empty list/,
    );
  });

  test("an unknown top-level key is fail-loud (strict reject)", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - a\npresets:\n  x:\n    harness: claude\n",
    );
    expect(() => loadPanelSelections(catalogFixture(), p)).toThrow(
      /Unknown top-level key 'presets'/,
    );
  });

  test("the default key names a defined panel", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - a\n    - b\ndefault: duo\n",
    );
    const sel = loadPanelSelections(catalogFixture(), p);
    expect(sel.default).toBe("duo");
  });

  test("no default key leaves default null", () => {
    const p = writeYaml("panel.yaml", "panels:\n  duo:\n    - a\n    - b\n");
    expect(loadPanelSelections(catalogFixture(), p).default).toBeNull();
  });

  test("a default naming an undefined panel is fail-loud", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - a\n    - b\ndefault: ghost\n",
    );
    expect(() => loadPanelSelections(catalogFixture(), p)).toThrow(
      /default panel 'ghost'/,
    );
  });

  test("two same-harness-different-model panelists are expressible", () => {
    const catalog: PresetCatalog = {
      presets: {
        opus: {
          harness: "claude",
          model: "opus",
          effort: null,
          thinking: null,
          role: null,
        },
        sonnet: {
          harness: "claude",
          model: "sonnet",
          effort: null,
          thinking: null,
          role: null,
        },
      },
    };
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  claude-duo:\n    - opus\n    - sonnet\n",
    );
    expect(loadPanelSelections(catalog, p).panels["claude-duo"]).toEqual([
      "opus",
      "sonnet",
    ]);
  });
});

describe("KEEPER_CONFIG_DIR single seam", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.KEEPER_CONFIG_DIR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.KEEPER_CONFIG_DIR;
    else process.env.KEEPER_CONFIG_DIR = saved;
  });

  test("derives both file paths from one env var", () => {
    process.env.KEEPER_CONFIG_DIR = "/cfg/keeper";
    expect(keeperConfigDir()).toBe("/cfg/keeper");
    expect(presetsCatalogPath()).toBe("/cfg/keeper/presets.yaml");
    expect(panelConfigPath()).toBe("/cfg/keeper/panel.yaml");
  });
});

describe("resolvePreset", () => {
  const cat: PresetCatalog = {
    presets: {
      a: {
        harness: "claude",
        model: null,
        effort: null,
        thinking: null,
        role: null,
      },
    },
  };

  test("resolves an existing preset", () => {
    expect(resolvePreset(cat, "a").harness).toBe("claude");
  });

  test("a missing name is fail-loud listing the available names + path", () => {
    let msg = "";
    try {
      resolvePreset(cat, "nope", "/cfg/presets.yaml");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("nope");
    expect(msg).toContain("/cfg/presets.yaml");
    expect(msg).toContain("a");
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
