/**
 * Config adapter pins: the preset catalog (`<harness>_default` pointers +
 * per-preset validation), panel selections, and plugin sources (missing file
 * fail-loud, ~-expansion). Fixture configs only — the live ~/.config is
 * arthack-owned stow state we must not touch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_PLUGINS_YAML,
  ensureDefaultPluginConfig,
  keeperConfigDir,
  loadPanelSelections,
  loadPluginSources,
  loadPresetCatalog,
  type PresetCatalog,
  panelConfigPath,
  pluginConfigEntryExists,
  presetsCatalogPath,
  resolvePreset,
} from "../src/agent/config";
import { loadMatrix, type Matrix } from "../src/agent/matrix";

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-config-"));
  // Pin the config dir at the (matrix-less) tmpDir so the default `loadMatrix()`
  // inside `loadPresetCatalog` never reaches the real ~/.config/keeper — test
  // isolation, and it keeps the un-augmented corpora byte-identical. Tests that
  // exercise augmentation pass a matrix explicitly.
  savedConfigDir = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = tmpDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.KEEPER_CONFIG_DIR;
  else process.env.KEEPER_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, body);
  return p;
}

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
    expect(() => loadPresetCatalog(join(tmpDir, "nope.yaml"))).toThrow(
      ConfigError,
    );
  });

  const EMPTY_CATALOG = {
    presets: {},
    claude_default: null,
    codex_default: null,
    pi_default: null,
    hermes_default: null,
  };

  test("an empty presets mapping is valid (worker tolerance)", () => {
    const p = writeYaml("presets.yaml", "presets: {}\n");
    expect(loadPresetCatalog(p)).toEqual(EMPTY_CATALOG);
  });

  test("a whitespace-only file parses to an empty catalog", () => {
    const p = writeYaml("presets.yaml", "\n");
    expect(loadPresetCatalog(p)).toEqual(EMPTY_CATALOG);
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
    expect(() => loadPresetCatalog(p)).toThrow(/\[a-z0-9\._-\]/);
  });

  test("a dotted preset name validates (widened charset)", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  gpt-5.5:\n    harness: codex\n",
    );
    expect(loadPresetCatalog(p, null).presets["gpt-5.5"]?.harness).toBe(
      "codex",
    );
  });

  test("a leading-dot preset name is rejected (never a hidden file)", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  .hidden:\n    harness: claude\n",
    );
    expect(() => loadPresetCatalog(p, null)).toThrow(/no leading dot/);
  });

  test("a missing-file error names the absent path", () => {
    let msg = "";
    try {
      loadPresetCatalog(join(tmpDir, "absent.yaml"));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("absent.yaml");
    expect(msg).toContain("missing");
  });

  test("no `<harness>_default` keys → all pointers null", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  a:\n    harness: claude\n",
    );
    const cat = loadPresetCatalog(p);
    expect(cat.claude_default).toBeNull();
    expect(cat.codex_default).toBeNull();
    expect(cat.pi_default).toBeNull();
  });

  test("valid `<harness>_default` pointers name matching presets", () => {
    const p = writeYaml(
      "presets.yaml",
      [
        "presets:",
        "  claude-opus:",
        "    harness: claude",
        "  codex-gpt:",
        "    harness: codex",
        "  pi-gpt:",
        "    harness: pi",
        "claude_default: claude-opus",
        "codex_default: codex-gpt",
        "pi_default: pi-gpt",
        "",
      ].join("\n"),
    );
    const cat = loadPresetCatalog(p);
    expect(cat.claude_default).toBe("claude-opus");
    expect(cat.codex_default).toBe("codex-gpt");
    expect(cat.pi_default).toBe("pi-gpt");
  });

  test("a `<harness>_default` naming no preset is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  a:\n    harness: claude\nclaude_default: ghost\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/claude_default 'ghost'/);
  });

  test("a `<harness>_default` whose preset harness mismatches is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  a:\n    harness: codex\nclaude_default: a\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(
      /claude_default 'a' pins harness codex, expected claude/,
    );
  });

  test("an empty-string `<harness>_default` is fail-loud", () => {
    const p = writeYaml(
      "presets.yaml",
      'presets:\n  a:\n    harness: claude\ncodex_default: ""\n',
    );
    expect(() => loadPresetCatalog(p)).toThrow(/codex_default must be/);
  });

  test("the `worker` preset name is unaffected by the pointers", () => {
    const p = writeYaml(
      "presets.yaml",
      [
        "presets:",
        "  worker:",
        "    harness: claude",
        "    model: sonnet",
        "  claude-opus:",
        "    harness: claude",
        "claude_default: claude-opus",
        "",
      ].join("\n"),
    );
    const cat = loadPresetCatalog(p);
    expect(cat.presets.worker?.model).toBe("sonnet");
    expect(cat.claude_default).toBe("claude-opus");
  });
});

describe("loadPresetCatalog host-matrix augmentation", () => {
  /**
   * A roster with a native claude pair, a wrapped codex model carrying a
   * native-id alias, and a wrapped pi model with no alias — every axis the
   * augmentation reads. Written under tmpDir and loaded so the test drives the
   * real matrix → catalog path.
   */
  function rosterMatrix(): Matrix {
    const body = [
      "efforts: [high]",
      "providers:",
      "  - name: claude",
      "    models: [opus]",
      "  - name: codex",
      "    models:",
      "      - gpt-5.5: gpt-5.5-codex",
      "  - name: pi",
      "    models: [gpt-5.5]",
      "subagents: [worker]",
      "wrapper_driver:",
      "  model: opus",
      "  effort: high",
      "",
    ].join("\n");
    const path = join(tmpDir, "matrix.yaml");
    writeFileSync(path, body);
    const matrix = loadMatrix(path);
    if (matrix === null) throw new Error("fixture matrix failed to load");
    return matrix;
  }

  test("exposes a resolvable preset for every roster pair", () => {
    const p = writeYaml("presets.yaml", "presets: {}\n");
    const cat = loadPresetCatalog(p, rosterMatrix());
    // Native claude pair.
    expect(resolvePreset(cat, "claude-opus")).toEqual({
      harness: "claude",
      model: "opus",
      effort: null,
      thinking: null,
      role: null,
    });
    // Wrapped codex model: the preset model is the provider-native alias target.
    expect(resolvePreset(cat, "codex-gpt-5.5").model).toBe("gpt-5.5-codex");
    expect(resolvePreset(cat, "codex-gpt-5.5").harness).toBe("codex");
    // Wrapped pi model, no alias: native id is the capability token itself.
    expect(resolvePreset(cat, "pi-gpt-5.5").model).toBe("gpt-5.5");
    expect(resolvePreset(cat, "pi-gpt-5.5").harness).toBe("pi");
  });

  test("auto-presets carry no second reasoning axis (effort/thinking null)", () => {
    const p = writeYaml("presets.yaml", "presets: {}\n");
    const cat = loadPresetCatalog(p, rosterMatrix());
    expect(cat.presets["codex-gpt-5.5"]?.effort).toBeNull();
    expect(cat.presets["pi-gpt-5.5"]?.thinking).toBeNull();
  });

  test("auto-presets are visible to panel validation", () => {
    const p = writeYaml("presets.yaml", "presets: {}\n");
    const cat = loadPresetCatalog(p, rosterMatrix());
    const panelPath = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude-opus\n    - codex-gpt-5.5\n",
    );
    expect(loadPanelSelections(cat, panelPath).panels.duo).toEqual([
      "claude-opus",
      "codex-gpt-5.5",
    ]);
  });

  test("a `<harness>_default` may point at an auto-generated preset", () => {
    const p = writeYaml("presets.yaml", "codex_default: codex-gpt-5.5\n");
    const cat = loadPresetCatalog(p, rosterMatrix());
    expect(cat.codex_default).toBe("codex-gpt-5.5");
  });

  test("a hand-authored preset colliding with an auto name fails loud", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  codex-gpt-5.5:\n    harness: codex\n",
    );
    expect(() => loadPresetCatalog(p, rosterMatrix())).toThrow(
      /collides with a hand-authored preset/,
    );
  });

  test("an absent matrix leaves the catalog byte-identical", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  worker:\n    harness: claude\n    model: sonnet\n",
    );
    expect(loadPresetCatalog(p, null)).toEqual(loadPresetCatalog(p, null));
    const cat = loadPresetCatalog(p, null);
    expect(Object.keys(cat.presets)).toEqual(["worker"]);
  });

  test("the default matrix arg augments from ~/.config/keeper (matrix-less tmpDir → no-op)", () => {
    // KEEPER_CONFIG_DIR is pinned at the matrix-less tmpDir, so the default
    // `loadMatrix()` finds nothing and the catalog stays hand-authored-only.
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  worker:\n    harness: claude\n",
    );
    expect(Object.keys(loadPresetCatalog(p).presets)).toEqual(["worker"]);
  });
});

describe("loadPanelSelections", () => {
  test("a missing file is fail-loud (the required-panel reversal)", () => {
    expect(() =>
      loadPanelSelections(catalogFixture(), join(tmpDir, "nope.yaml")),
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

  test("a pi member is accepted at load (panel eligibility is the capturable capability)", () => {
    // Panel eligibility reads a descriptor capability (`capturable`), never a
    // claude|codex name list — pi is capturable, so a pi panel member is valid.
    const p = writeYaml("panel.yaml", "panels:\n  mixed:\n    - a\n    - z\n");
    expect(loadPanelSelections(catalogFixture(), p).panels.mixed).toEqual([
      "a",
      "z",
    ]);
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
  test("empty config → empty lists, gate off", () => {
    const p = writeYaml("plugins.yaml", "{}\n");
    expect(loadPluginSources(p)).toEqual({
      pluginDirs: [],
      pluginScanDirs: [],
      workerPluginIsolation: false,
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
      workerPluginIsolation: false,
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
  test("worker_plugin_isolation: strip-scan-dirs → gate on", () => {
    const p = writeYaml(
      "plugins.yaml",
      "worker_plugin_isolation: strip-scan-dirs\n",
    );
    expect(loadPluginSources(p).workerPluginIsolation).toBe(true);
  });
  test("worker_plugin_isolation: off → gate off", () => {
    const p = writeYaml("plugins.yaml", "worker_plugin_isolation: off\n");
    expect(loadPluginSources(p).workerPluginIsolation).toBe(false);
  });
  test("an unknown worker_plugin_isolation mode is fail-loud", () => {
    const p = writeYaml(
      "plugins.yaml",
      "worker_plugin_isolation: yes-please\n",
    );
    expect(() => loadPluginSources(p)).toThrow(/not a valid mode/);
  });
  test("a non-string worker_plugin_isolation is fail-loud", () => {
    const p = writeYaml("plugins.yaml", "worker_plugin_isolation:\n  - a\n");
    expect(() => loadPluginSources(p)).toThrow(/must be a string/);
  });
});

describe("ensureDefaultPluginConfig (the install.sh write seam)", () => {
  test("the shipped default is keeper's two plugins and no scan dirs", () => {
    const p = writeYaml("plugins.yaml", DEFAULT_PLUGINS_YAML);
    const sources = loadPluginSources(p);
    expect(sources.pluginScanDirs).toEqual([]);
    expect(sources.pluginDirs).toHaveLength(2);
    expect(sources.pluginDirs[0]?.endsWith("/plugins/keeper")).toBe(true);
    expect(sources.pluginDirs[1]?.endsWith("/plugins/plan")).toBe(true);
    // The default declares no scan dirs — a fresh machine needs no arthack tree.
    expect(DEFAULT_PLUGINS_YAML).not.toContain("plugin_scan_dirs");
  });

  test("absent → writes the default and creates the parent dir", () => {
    const p = join(tmpDir, "nested", "keeper", "plugins.yaml");
    expect(pluginConfigEntryExists(p)).toBe(false);
    expect(ensureDefaultPluginConfig(p)).toBe("written");
    expect(readFileSync(p, "utf8")).toBe(DEFAULT_PLUGINS_YAML);
  });

  test("an existing file is left byte-untouched", () => {
    const sentinel = "plugin_dirs:\n  - ~/mine\n";
    const p = writeYaml("plugins.yaml", sentinel);
    expect(pluginConfigEntryExists(p)).toBe(true);
    expect(ensureDefaultPluginConfig(p)).toBe("exists");
    expect(readFileSync(p, "utf8")).toBe(sentinel);
  });

  test("a dangling symlink counts as present and is never clobbered", () => {
    const link = join(tmpDir, "plugins.yaml");
    const target = join(tmpDir, "gone.yaml");
    symlinkSync(target, link);
    // lstat-based presence: the target does not exist, yet the pointer does.
    expect(existsSync(target)).toBe(false);
    expect(pluginConfigEntryExists(link)).toBe(true);
    expect(ensureDefaultPluginConfig(link)).toBe("exists");
    // The symlink is intact and no file was written through it.
    expect(readlinkSync(link)).toBe(target);
    expect(existsSync(target)).toBe(false);
  });
});
