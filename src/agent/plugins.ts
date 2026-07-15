/**
 * Plugin discovery — builds the `--plugin-dir` argument list. Two sources:
 *
 *  1. The cwd `--plugin-dir .` detection: if any of commands/agents/skills/hooks
 *     is a directory in cwd, the repo itself is a plugin. STAYS in code.
 *  2. Config-driven entries from `~/.config/keeper/plugins.yaml`:
 *       - `plugin_dirs`      — each entry IS a plugin; a missing manifest is
 *                              FAIL-LOUD (hard dependency).
 *       - `plugin_scan_dirs` — each entry is a parent whose immediate children
 *                              are scanned; a missing parent is SKIPPED.
 *
 * Repo scans for plugins are config-driven only: they arrive as
 * `plugin_scan_dirs` entries — there are no in-code repo scans.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginSources } from "./config";

/** Raised for a fail-loud missing plugin manifest; main() prints + exit 1. */
export class PluginError extends Error {
  /** The full stderr message the Python launcher prints for this failure. */
  readonly stderrMessage: string;
  constructor(stderrMessage: string) {
    super(stderrMessage);
    this.stderrMessage = stderrMessage;
  }
}

export interface PluginDiscovery {
  /** `--plugin-dir` argument pairs flattened, e.g. ["--plugin-dir", "."]. */
  args: string[];
  /** Action-log lines describing what was added. */
  actions: string[];
}

export interface DiscoverPluginsOptions {
  /**
   * The worker plugin-isolation gate, ALREADY resolved by the caller (the
   * `agent/main.ts` seam combines the `worker_plugin_isolation` config knob with
   * the launch's worker-ness). When `true`, the `plugin_scan_dirs` RESULTS are
   * omitted entirely — the hard-listed `plugin_dirs` and the cwd `.` detection are
   * untouched. Default `false` = byte-identical to an ungated launch: the scan
   * loop runs exactly as before, so no OFF-path arg or action changes.
   */
  stripScanDirs?: boolean;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether plugin discovery will auto-add `cwd` as `--plugin-dir .`. Exported so
 * pre-launch collision checks inspect the exact same launcher input instead of
 * reimplementing (and drifting from) this predicate.
 */
export function discoversCwdPlugin(cwd: string): boolean {
  return ["commands", "agents", "skills", "hooks"].some((dir) =>
    isDir(join(cwd, dir)),
  );
}

function hasPluginManifest(dir: string): boolean {
  return isFile(join(dir, ".claude-plugin", "plugin.json"));
}

/**
 * Discover plugin dirs. `cwd` and the config `sources` are injected so this is
 * testable without touching the live config. `pluginConfigPathStr` is only used
 * to build the fail-loud message text (matching the Python wording).
 */
export function discoverPlugins(
  cwd: string,
  sources: PluginSources,
  pluginConfigPathStr: string,
  options: DiscoverPluginsOptions = {},
): PluginDiscovery {
  const args: string[] = [];
  const actions: string[] = [];

  // 1. cwd `--plugin-dir .` detection (stays in code).
  if (discoversCwdPlugin(cwd)) {
    args.push("--plugin-dir", ".");
    actions.push("Detected plugin directory, added --plugin-dir .");
  }

  // 2a. plugin_dirs — hard dependencies; a missing manifest is fail-loud.
  for (const pluginDir of sources.pluginDirs) {
    const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
    if (!isFile(manifest)) {
      throw new PluginError(
        `Error: configured plugin manifest missing at ${manifest}. ` +
          `It is listed under plugin_dirs in ${pluginConfigPathStr} and ` +
          "is a hard dependency of keeper agent — restore the checkout " +
          "or remove the entry before launching.",
      );
    }
    args.push("--plugin-dir", pluginDir);
    actions.push(`Added --plugin-dir for configured plugin: ${pluginDir}`);
  }

  // 2b. plugin_scan_dirs — best-effort; a missing parent is skipped. Skipped
  // WHOLESALE when the worker isolation gate is on: a keeper-automated worker
  // loads only the hard-listed plugin_dirs above (keeper + plan) plus its
  // additive per-cell --plugin-dir. Guarded so the OFF path is byte-identical
  // (no scan-loop arg or action changes when the gate is off).
  if (options.stripScanDirs) {
    if (sources.pluginScanDirs.length > 0) {
      actions.push(
        "Worker plugin isolation on — stripped plugin_scan_dirs results",
      );
    }
    return { args, actions };
  }
  for (const scanDir of sources.pluginScanDirs) {
    if (!isDir(scanDir)) {
      continue;
    }
    let scannedCount = 0;
    for (const name of readdirSorted(scanDir)) {
      const pluginPath = join(scanDir, name);
      if (isDir(pluginPath) && hasPluginManifest(pluginPath)) {
        args.push("--plugin-dir", pluginPath);
        scannedCount += 1;
      }
    }
    if (scannedCount) {
      actions.push(
        `Added --plugin-dir for ${scannedCount} plugins under ${scanDir}`,
      );
    }
  }

  return { args, actions };
}

function readdirSorted(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).sort();
}
