/**
 * Config adapter pins: the launch-config catalog (`<harness>_default` triples +
 * the per-verb `dispatch:` table, ADR 0033 / ADR 0040), panel selections, and
 * plugin sources (missing file fail-loud, ~-expansion). Fixture configs only — the
 * live ~/.config is arthack-owned stow state we must not touch.
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

describe("loadPresetCatalog", () => {
  test("a missing file is fail-loud (the required-catalog reversal)", () => {
    expect(() => loadPresetCatalog(join(tmpDir, "nope.yaml"))).toThrow(
      ConfigError,
    );
  });

  const EMPTY_DISPATCH = {
    work: null,
    close: null,
    resolve: null,
    unblock: null,
    deconflict: null,
    repair: null,
    handoff: null,
  };

  const EMPTY_CATALOG = {
    presets: {},
    claude_default: null,
    codex_default: null,
    pi_default: null,
    hermes_default: null,
    dispatch: EMPTY_DISPATCH,
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

  test("a leftover `worker:` key is fail-loud with a migration hint naming dispatch", () => {
    const p = writeYaml("presets.yaml", "worker: claude::sonnet::max\n");
    expect(() => loadPresetCatalog(p)).toThrow(
      /'worker:' launch key is retired/,
    );
    expect(() => loadPresetCatalog(p)).toThrow(/ADR 0040/);
    expect(() => loadPresetCatalog(p)).toThrow(/dispatch\.work/);
  });

  test("a leftover `escalation:` key is fail-loud with a migration hint naming dispatch", () => {
    const p = writeYaml("presets.yaml", "escalation: claude::sonnet::high\n");
    expect(() => loadPresetCatalog(p)).toThrow(
      /'escalation:' launch key is retired/,
    );
    expect(() => loadPresetCatalog(p)).toThrow(/dispatch\.unblock/);
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
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  work: claude::sonnet::max\n",
    );
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

  describe("dispatch: block (ADR 0040)", () => {
    test("no `dispatch` key → every verb null", () => {
      const p = writeYaml(
        "presets.yaml",
        "claude_default: claude::sonnet::max\n",
      );
      expect(loadPresetCatalog(p).dispatch).toEqual(EMPTY_DISPATCH);
    });

    test("a valid dispatch table parses every verb", () => {
      const p = writeYaml(
        "presets.yaml",
        [
          "dispatch:",
          "  work: claude::sonnet::max",
          "  close: claude::sonnet::max",
          "  resolve: claude::sonnet::max",
          "  unblock: claude::sonnet::high",
          "  deconflict: claude::sonnet::high",
          "  repair: claude::sonnet::high",
          "  handoff: codex::gpt::high",
          "",
        ].join("\n"),
      );
      const cat = loadPresetCatalog(p);
      expect(cat.dispatch).toEqual({
        work: { harness: "claude", model: "sonnet", effort: "max" },
        close: { harness: "claude", model: "sonnet", effort: "max" },
        resolve: { harness: "claude", model: "sonnet", effort: "max" },
        unblock: { harness: "claude", model: "sonnet", effort: "high" },
        deconflict: { harness: "claude", model: "sonnet", effort: "high" },
        repair: { harness: "claude", model: "sonnet", effort: "high" },
        handoff: { harness: "codex", model: "gpt", effort: "high" },
      });
    });

    test("a partial dispatch table leaves unset verbs null", () => {
      const p = writeYaml(
        "presets.yaml",
        "dispatch:\n  work: claude::opus::high\n",
      );
      const cat = loadPresetCatalog(p);
      expect(cat.dispatch).toEqual({
        ...EMPTY_DISPATCH,
        work: { harness: "claude", model: "opus", effort: "high" },
      });
    });

    test("an unknown dispatch verb key is fail-loud naming the verb", () => {
      const p = writeYaml(
        "presets.yaml",
        "dispatch:\n  unknown_verb: claude::sonnet::max\n",
      );
      expect(() => loadPresetCatalog(p)).toThrow(
        /Unknown dispatch verb 'unknown_verb'/,
      );
    });

    test("a non-mapping dispatch value is fail-loud", () => {
      const p = writeYaml("presets.yaml", "dispatch: not-a-mapping\n");
      expect(() => loadPresetCatalog(p)).toThrow(/dispatch must be a mapping/);
    });

    test("a malformed dispatch triple is fail-loud naming the verb", () => {
      const p = writeYaml("presets.yaml", "dispatch:\n  work: not-a-triple\n");
      expect(() => loadPresetCatalog(p)).toThrow(/work/);
    });

    test("a non-claude dispatch triple parses (the resolver warns-and-ignores)", () => {
      const p = writeYaml(
        "presets.yaml",
        "dispatch:\n  work: codex::gpt::high\n",
      );
      expect(loadPresetCatalog(p).dispatch?.work).toEqual({
        harness: "codex",
        model: "gpt",
        effort: "high",
      });
    });
  });
});

describe("loadPanelSelections", () => {
  test("a missing file is fail-loud (the required-panel reversal)", () => {
    expect(() => loadPanelSelections(join(tmpDir, "nope.yaml"))).toThrow(
      ConfigError,
    );
  });

  test("a panel of triple members is read in declaration order", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - codex::gpt-5.3::high\n",
    );
    expect(loadPanelSelections(p).panels.duo).toEqual([
      "claude::opus::high",
      "codex::gpt-5.3::high",
    ]);
  });

  test("a malformed member triple is fail-loud naming the member", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - not-a-triple\n",
    );
    expect(() => loadPanelSelections(p)).toThrow(/not-a-triple/);
    expect(() => loadPanelSelections(p)).toThrow(/not a valid launch triple/);
  });

  test("a pi member is accepted (panel eligibility = capturable + a reasoning axis)", () => {
    // pi is capturable AND carries a thinking axis, so a pi panel member is valid.
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  mixed:\n    - claude::opus::high\n    - pi::glm::high\n",
    );
    expect(loadPanelSelections(p).panels.mixed).toEqual([
      "claude::opus::high",
      "pi::glm::high",
    ]);
  });

  test("an axisless harness member is fail-loud (not panel-eligible)", () => {
    // hermes is capturable but exposes no reasoning axis (na) — panels compare an
    // axis, so it is rejected AT LOAD with the member named.
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - hermes::hermes-m::na\n",
    );
    expect(() => loadPanelSelections(p)).toThrow(/hermes::hermes-m::na/);
    expect(() => loadPanelSelections(p)).toThrow(/not panel-eligible/);
  });

  test("duplicate identical triples are legal at load (kept in order)", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  dup:\n    - claude::opus::high\n    - claude::opus::high\n",
    );
    expect(loadPanelSelections(p).panels.dup).toEqual([
      "claude::opus::high",
      "claude::opus::high",
    ]);
  });

  test("an empty panel list is fail-loud", () => {
    const p = writeYaml("panel.yaml", "panels:\n  empty: []\n");
    expect(() => loadPanelSelections(p)).toThrow(/non-empty list/);
  });

  test("an unknown top-level key is fail-loud (strict reject)", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\npresets:\n  x: y\n",
    );
    expect(() => loadPanelSelections(p)).toThrow(
      /Unknown top-level key 'presets'/,
    );
  });

  test("the default key names a defined panel", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - codex::gpt-5.3::high\ndefault: duo\n",
    );
    expect(loadPanelSelections(p).default).toBe("duo");
  });

  test("no default key leaves default null", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - codex::gpt-5.3::high\n",
    );
    expect(loadPanelSelections(p).default).toBeNull();
  });

  test("a default naming an undefined panel is fail-loud", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  duo:\n    - claude::opus::high\n    - codex::gpt-5.3::high\ndefault: ghost\n",
    );
    expect(() => loadPanelSelections(p)).toThrow(/default panel 'ghost'/);
  });

  test("two same-harness-different-model panelists are expressible", () => {
    const p = writeYaml(
      "panel.yaml",
      "panels:\n  claude-duo:\n    - claude::opus::high\n    - claude::sonnet::high\n",
    );
    expect(loadPanelSelections(p).panels["claude-duo"]).toEqual([
      "claude::opus::high",
      "claude::sonnet::high",
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
