#!/usr/bin/env bun
/**
 * Clean-machine proof: keeper's full fresh-machine launch path runs with NO
 * arthack checkout on the resolution path. A manual/CI tool (NOT the fast test
 * tier) that exercises the REAL production surfaces a fresh clone would hit —
 * the installer plugin-config bridge, the `keeper prompt render` CLI, the
 * launcher's config parse + plugin discovery, and the worker argv builder — and
 * asserts every one resolves keeper-owned sources, never an arthack checkout.
 *
 * "No arthack reachable" is proven by construction, not by hiding the checkout:
 * the default config carries no arthack scan dirs, prompt renders resolve to the
 * in-repo vendored corpus, and a gated worker launch strips every scanned
 * third-party plugin. Each stage names the arthack-free resolution it observed.
 *
 * Re-runnable and side-effect-free outside its per-run scratch dir: config writes
 * land under a scratch KEEPER_CONFIG_DIR, discovery + argv assembly run in-process
 * over pure builders (no claude, no daemon), and the render subprocess only reads.
 * It never touches the real ~/.config/keeper.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginSources } from "../src/agent/config";
import { discoverPlugins } from "../src/agent/plugins";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_CLI = join(REPO_ROOT, "cli", "prompt.ts");
const INSTALLER_BRIDGE = join(REPO_ROOT, "scripts", "ensure-plugin-config.ts");
const VENDORED_CORPUS = join(REPO_ROOT, "plugins", "prompt", "corpus");

// Worker/skill-reachable render cites (the four byte-verbatim BAKE snippets the
// hack skill embeds) — a representative subset of what the exhaustive
// vendored-corpus test enumerates. Each must render from the vendored subset
// with no arthack checkout on the resolution path.
const REACHABLE_CITES = [
  "engineering/keeper-history-forensics",
  "engineering/escalate-inline-or-plan",
  "engineering/commit-via-keeper-default",
  "source-dirs/docs-dir-and-gist-open",
];

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  const line = ok ? `  PASS  ${label}` : `  FAIL  ${label}`;
  process.stdout.write(detail ? `${line}\n        ${detail}\n` : `${line}\n`);
  if (!ok) {
    failures.push(label);
  }
}

/** True when `dir` is a plugin dir under an external arthack checkout (the wire
 *  dissolution severs) — NOT the in-repo vendored corpus subtree under REPO_ROOT. */
function isArthackCheckout(dir: string): boolean {
  return dir.includes("arthack") && !dir.startsWith(REPO_ROOT);
}

/** Materialize a plugin dir (its `.claude-plugin/plugin.json` marker). */
function makePlugin(dir: string): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}\n");
  return dir;
}

function run(scratch: string): void {
  const bareCwd = join(scratch, "bare");
  mkdirSync(bareCwd, { recursive: true });

  // ── Stage 1 — installer writes a keeper-only plugins.yaml (arthack-free) ──
  process.stdout.write("\nStage 1 — installer plugin-config bridge\n");
  const freshConfigDir = join(scratch, "fresh-config");
  const freshEnv = { ...process.env, KEEPER_CONFIG_DIR: freshConfigDir };
  const write1 = Bun.spawnSync({
    cmd: ["bun", INSTALLER_BRIDGE],
    cwd: REPO_ROOT,
    env: freshEnv,
  });
  const wroteConfig = join(freshConfigDir, "plugins.yaml");
  check(
    "installer bridge exits 0 on a fresh (empty) config dir",
    write1.success,
    write1.stderr.toString().trim(),
  );
  const defaultYaml = existsSync(wroteConfig)
    ? readFileSync(wroteConfig, "utf8")
    : "";
  check("it wrote plugins.yaml", defaultYaml.length > 0);
  check(
    "the written default carries keeper's two plugin_dirs",
    defaultYaml.includes("plugins/keeper") &&
      defaultYaml.includes("plugins/plan"),
  );
  check(
    "the written default has NO scan dirs (keeper-only; arthack only ever arrived via a scan dir)",
    !defaultYaml.includes("plugin_scan_dirs:") &&
      loadPluginSources(wroteConfig).pluginScanDirs.length === 0,
  );
  const write2 = Bun.spawnSync({
    cmd: ["bun", INSTALLER_BRIDGE],
    cwd: REPO_ROOT,
    env: freshEnv,
  });
  check(
    "re-run is never-clobber (leaves the existing file untouched)",
    write2.success && write2.stdout.toString().includes("left untouched"),
  );

  // ── Stage 2 — prompt renders resolve from the vendored subset ──
  process.stdout.write("\nStage 2 — prompt renders resolve arthack-free\n");
  check(
    "the vendored corpus subset ships in-repo (vendor.lock present)",
    existsSync(join(VENDORED_CORPUS, "vendor.lock")),
  );
  // Render from a scratch cwd (no .git, no corpus) with KEEPER_PROMPT_CORPUS_ROOT
  // unset → resolution falls to keeper's in-repo vendored corpus, never an
  // external arthack checkout.
  const renderEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "KEEPER_PROMPT_CORPUS_ROOT") {
      renderEnv[k] = v;
    }
  }
  for (const ref of REACHABLE_CITES) {
    const r = Bun.spawnSync({
      cmd: ["bun", PROMPT_CLI, "render", ref],
      cwd: bareCwd,
      env: renderEnv,
    });
    check(
      `render ${ref} resolves from the vendored subset (exit 0, non-empty)`,
      r.success && r.stdout.toString().trim().length > 0,
      r.success ? "" : r.stderr.toString().trim(),
    );
  }

  // ── Stage 3 — worker argv carries keeper-owned permission posture ──
  process.stdout.write("\nStage 3 — worker permission posture\n");
  const workerArgv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: ["bun", join(REPO_ROOT, "cli", "keeper.ts"), "agent"],
    session: "work::clean-machine-check",
    prompt: "do it",
    claudeName: "clean-machine-001",
    noConfirm: true,
  });
  const permIdx = workerArgv.indexOf("--permission-mode");
  check(
    "worker argv sets --permission-mode acceptEdits",
    permIdx !== -1 && workerArgv[permIdx + 1] === "acceptEdits",
  );
  check(
    "worker argv sets --dangerously-skip-permissions (no arthack auto-approve)",
    workerArgv.includes("--dangerously-skip-permissions"),
  );

  // ── Stage 4 — gate ON isolates a worker; interactive is unaffected ──
  // Mirrors the launcher's discovery seam (src/agent/main.ts): a launch is a
  // keeper-automated worker when its argv carries --dangerously-skip-permissions
  // (the posture built in Stage 3); the seam strips scan-dir results only when the
  // config knob is ON AND the launch is such a worker. Proven here against the real
  // config parse + real discovery; both gate states are unit-pinned by
  // test/plugin-composition-map.test.ts.
  process.stdout.write("\nStage 4 — worker plugin-isolation gate (ON)\n");
  const keeperDir = makePlugin(join(scratch, "plugins", "keeper"));
  const planDir = makePlugin(join(scratch, "plugins", "plan"));
  const scanParent = join(scratch, "arthack-checkout", "claude");
  const arthackChild = makePlugin(join(scanParent, "arthack"));
  const gateOnConfig = join(scratch, "gate-on.yaml");
  writeFileSync(
    gateOnConfig,
    [
      "worker_plugin_isolation: strip-scan-dirs",
      "plugin_dirs:",
      `  - ${keeperDir}`,
      `  - ${planDir}`,
      "plugin_scan_dirs:",
      `  - ${scanParent}`,
      "",
    ].join("\n"),
  );
  const sources = loadPluginSources(gateOnConfig);
  check(
    "config parses the gate knob ON (worker_plugin_isolation: strip-scan-dirs)",
    sources.workerPluginIsolation === true,
  );
  const workerIsAutomated = workerArgv.includes(
    "--dangerously-skip-permissions",
  );
  const stripScanDirs =
    (sources.workerPluginIsolation ?? false) && workerIsAutomated;
  const workerDirs = discoverPlugins(bareCwd, sources, gateOnConfig, {
    stripScanDirs,
  }).args;
  check(
    "gated worker keeps the hard-listed plugin_dirs (keeper + plan)",
    workerDirs.includes(keeperDir) && workerDirs.includes(planDir),
  );
  check(
    "gated worker strips the scanned arthack plugin",
    !workerDirs.includes(arthackChild),
  );
  check(
    "gated worker resolves NO external arthack checkout path",
    !workerDirs.some(isArthackCheckout),
    `resolved: ${JSON.stringify(workerDirs)}`,
  );
  const interactiveDirs = discoverPlugins(bareCwd, sources, gateOnConfig, {
    stripScanDirs: false,
  }).args;
  check(
    "interactive launch is UNAFFECTED — still inherits the scanned arthack plugin",
    interactiveDirs.includes(arthackChild),
  );
}

const scratch = mkdtempSync(join(tmpdir(), "keeper-clean-machine-"));
process.stdout.write(
  `clean-machine-check — scratch root ${scratch}\n` +
    `repo under test: ${REPO_ROOT}\n`,
);
try {
  run(scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? "\nclean-machine-check: PASS — the fresh-machine launch path is arthack-free\n"
    : `\nclean-machine-check: FAIL — ${failures.length} check(s) failed\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
