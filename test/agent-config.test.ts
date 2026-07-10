/**
 * Config adapter pins: the launch-config catalog (`<harness>_default` +
 * `worker`/`escalation` launch triples, ADR 0033), panel selections, and plugin
 * sources (missing file fail-loud, ~-expansion). Fixture configs only — the live
 * ~/.config is arthack-owned stow state we must not touch.
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

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-config-"));
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
    worker: null,
    escalation: null,
  };

  test("an empty file is valid (every key null, presets empty)", () => {
    const p = writeYaml("presets.yaml", "\n");
    expect(loadPresetCatalog(p)).toEqual(EMPTY_CATALOG);
  });

  test("a whitespace-only file parses to an empty catalog", () => {
    const p = writeYaml("presets.yaml", "  \n");
    expect(loadPresetCatalog(p)).toEqual(EMPTY_CATALOG);
  });

  test("a leftover `presets:` block is fail-loud with a migration hint", () => {
    const p = writeYaml(
      "presets.yaml",
      "presets:\n  a:\n    harness: claude\n",
    );
    expect(() => loadPresetCatalog(p)).toThrow(/retired \(ADR 0033\)/);
    expect(() => loadPresetCatalog(p)).toThrow(/<harness>::<model>::<effort>/);
  });

  test("an unknown top-level key is fail-loud (strict reject)", () => {
    const p = writeYaml("presets.yaml", "panels:\n  duo:\n    - a\n");
    expect(() => loadPresetCatalog(p)).toThrow(
      /Unknown top-level key 'panels'/,
    );
  });

  test("malformed YAML is fail-loud", () => {
    const p = writeYaml("presets.yaml", "claude_default: [unterminated\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
  });

  test("valid `<harness>_default` triples parse per harness", () => {
    const p = writeYaml(
      "presets.yaml",
      [
        "claude_default: claude::opus::xhigh",
        "codex_default: codex::gpt-5.5::high",
        "pi_default: pi::glm::high",
        "hermes_default: hermes::gpt-5.5::na",
        "",
      ].join("\n"),
    );
    const cat = loadPresetCatalog(p);
    expect(cat.claude_default).toEqual({
      harness: "claude",
      model: "opus",
      effort: "xhigh",
    });
    expect(cat.codex_default).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(cat.pi_default).toEqual({
      harness: "pi",
      model: "glm",
      effort: "high",
    });
    expect(cat.hermes_default).toEqual({
      harness: "hermes",
      model: "gpt-5.5",
      effort: "na",
    });
  });

  test("no `<harness>_default` keys → all triples null", () => {
    const p = writeYaml("presets.yaml", "worker: claude::sonnet::max\n");
    const cat = loadPresetCatalog(p);
    expect(cat.claude_default).toBeNull();
    expect(cat.codex_default).toBeNull();
    expect(cat.pi_default).toBeNull();
    expect(cat.hermes_default).toBeNull();
  });

  test("a malformed `<harness>_default` triple is fail-loud naming the segment", () => {
    const p = writeYaml("presets.yaml", "claude_default: claude::opus\n");
    expect(() => loadPresetCatalog(p)).toThrow(/claude_default/);
    expect(() => loadPresetCatalog(p)).toThrow(/three/);
  });

  test("a `<harness>_default` whose harness mismatches its key is fail-loud", () => {
    const p = writeYaml("presets.yaml", "claude_default: codex::gpt::high\n");
    expect(() => loadPresetCatalog(p)).toThrow(
      /claude_default 'codex::gpt::high' pins harness codex, expected claude/,
    );
  });

  test("an empty-string `<harness>_default` is fail-loud", () => {
    const p = writeYaml("presets.yaml", 'codex_default: ""\n');
    expect(() => loadPresetCatalog(p)).toThrow(/codex_default must be/);
  });

  test("worker + escalation triples parse (any harness, harness unchecked)", () => {
    const p = writeYaml(
      "presets.yaml",
      "worker: claude::sonnet::max\nescalation: claude::haiku::high\n",
    );
    const cat = loadPresetCatalog(p);
    expect(cat.worker).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "max",
    });
    expect(cat.escalation).toEqual({
      harness: "claude",
      model: "haiku",
      effort: "high",
    });
  });

  test("a non-claude worker triple parses (the resolver warns-and-ignores)", () => {
    const p = writeYaml("presets.yaml", "worker: codex::gpt::high\n");
    expect(loadPresetCatalog(p).worker).toEqual({
      harness: "codex",
      model: "gpt",
      effort: "high",
    });
  });

  test("a malformed worker triple is fail-loud (the resolver swallows the throw)", () => {
    const p = writeYaml("presets.yaml", "worker: not-a-triple\n");
    expect(() => loadPresetCatalog(p)).toThrow(/worker/);
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
