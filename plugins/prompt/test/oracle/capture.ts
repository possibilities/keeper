#!/usr/bin/env bun
// Golden-fixture capture against the production `keeper prompt` engine — the
// recorded snapshots the regression-pin suite (parity.test.ts) asserts against.
//
// Re-run deliberately, when the arthack corpus or the plan-plugin templates
// change, to refresh the goldens (a diff is expected — eyeball it before
// committing so a new bug is never frozen as golden):
//
//     bun run capture-oracle           # from plugins/prompt/
//     bun test/oracle/capture.ts
//
// It samples the FULL ref universe (every snippet id + every bundle/sketch ref
// from the live index) and the full plan-plugin render tree — never a subset,
// so no template can silently diverge later. Output lands under
// test/oracle/fixtures/ as JSON the test reads back.
//
// The plan-plugin verbs (check-generated, render-plugin-templates) are captured
// hermetically: the plan plugin is rendered into a throwaway copy carrying a
// synthetic `.git` marker, so the recorded envelopes never depend on whether the
// launch-generated (gitignored) render tree happens to be materialized on the
// capture host.
//
// Resolution: the arthack corpus root comes from --arthack-root / $ARTHACK_ROOT
// with a ~/code/arthack fallback; the keeper root is this checkout (three dirs
// up from here). `keeper` must be on PATH and expose the `prompt` subcommand.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type {
  CheckGeneratedFixture,
  OracleManifest,
  PluginTemplateFile,
  PluginTemplatesFixture,
  RenderFixture,
} from "./fixture-types.ts";
import { tokenizeRoots } from "./normalize.ts";

const SIDECAR_SUFFIX = ".managed-file-dont-edit";

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURES_DIR = join(HERE, "fixtures");
const KEEPER_ROOT = resolve(HERE, "..", "..", "..", "..");

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

/** Resolve the arthack corpus root: flag, then env, then ~/code/arthack. */
function resolveArthackRoot(): string {
  const explicit = flagValue("arthack-root") ?? process.env.ARTHACK_ROOT;
  const candidate = explicit
    ? resolve(explicit)
    : join(homedir(), "code", "arthack");
  if (!existsSync(join(candidate, ".git"))) {
    throw new Error(
      `arthack corpus root not found at ${candidate} ` +
        "(pass --arthack-root=<path> or set $ARTHACK_ROOT)",
    );
  }
  return candidate;
}

function assertOracleOnPath(): string {
  const probe = spawnSync("keeper", ["prompt", "--help"], {
    encoding: "utf-8",
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      "`keeper prompt` is not on PATH (or errored) — capture requires the " +
        "production prompt engine to source the render goldens",
    );
  }
  const which = spawnSync("which", ["keeper"], { encoding: "utf-8" });
  return (which.stdout ?? "keeper").trim();
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** The committed claude-only v2 host matrix the plan-tree capture renders under,
 *  so the goldens stay host-blind — the render never reads the operator's live
 *  `~/.config/keeper/matrix.yaml`. */
const HOST_MATRIX_FIXTURE_DIR = join(FIXTURES_DIR, "host-matrix");

/** Run `keeper prompt <args>` with a fixed cwd, returning raw stdout bytes +
 *  exit code. `envOverride` is merged over the inherited env (the plan render
 *  pins KEEPER_CONFIG_DIR at the committed fixture). */
function runOracle(
  args: string[],
  cwd: string,
  envOverride?: Record<string, string>,
): RunResult {
  const proc = spawnSync("keeper", ["prompt", ...args], {
    cwd,
    env: envOverride ? { ...process.env, ...envOverride } : process.env,
  });
  return {
    stdout: proc.stdout ?? Buffer.alloc(0),
    stderr: (proc.stderr ?? Buffer.alloc(0)).toString("utf-8"),
    code: proc.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Ref universe — every snippet id + every bundle/sketch ref, live from the index
// ---------------------------------------------------------------------------

/** Parse bare snippet names out of the YAML index without a YAML dep — the
 *  index is `build-snippets`-generated as a `snippets:` sequence, one
 *  `- name: <id>` entry per snippet (indented under the top-level key). */
function snippetRefs(arthackRoot: string): string[] {
  const indexPath = join(
    arthackRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "snippets",
    "_index.yaml",
  );
  const text = readFileSync(indexPath, "utf-8");
  const refs: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*- name:\s*(\S+)\s*$/);
    if (m?.[1]) {
      refs.push(m[1]);
    }
  }
  if (refs.length === 0) {
    throw new Error(`no snippet ids parsed from ${indexPath}`);
  }
  return refs;
}

/** Bundle + sketch refs straight from `list-bundles` JSON. */
function bundleRefs(arthackRoot: string): string[] {
  const r = runOracle(["list-bundles"], arthackRoot);
  if (r.code !== 0) {
    throw new Error(`list-bundles failed (exit ${r.code}): ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout.toString("utf-8")) as Array<{
    ref?: string;
  }>;
  const refs = parsed.map((e) => e.ref).filter((x): x is string => Boolean(x));
  if (refs.length === 0) {
    throw new Error("no bundle/sketch refs returned by list-bundles");
  }
  return refs;
}

function captureRender(arthackRoot: string): RenderFixture[] {
  const refs = [...snippetRefs(arthackRoot), ...bundleRefs(arthackRoot)];
  const out: RenderFixture[] = [];
  for (const ref of refs) {
    const r = runOracle(["render", ref], arthackRoot);
    out.push({
      ref,
      stdout_b64: r.stdout.toString("base64"),
      exit_code: r.code,
    });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));
  return out;
}

// ---------------------------------------------------------------------------
// Hermetic plan-plugin render tree — the shared substrate for both the
// check-generated and render-plugin-templates fixtures
// ---------------------------------------------------------------------------

/** A throwaway plan-plugin render tree: a copy of `plugins/plan` with every
 *  template freshly rendered and a synthetic `.git` marker at its root. */
interface RenderedPlanTree {
  /** Temp dir root — a copy of `plugins/plan` (its own project root). */
  work: string;
  /** render-plugin-templates stdout, machine roots already tokenized. */
  stdout: string;
  exitCode: number;
}

/** Render the plan plugin's templates into a throwaway copy so the live tree is
 *  never mutated and EVERY template re-renders from scratch (an already-rendered
 *  tree is a silent no-op). A synthetic `.git` file at the copy root makes
 *  `check-generated` resolve the copy as the project root, so its envelopes are
 *  hermetic — they never depend on the launch-generated tree being materialized
 *  in the live checkout. Caller owns cleanup of `.work`. */
function renderPlanTree(
  keeperRoot: string,
  arthackRoot: string,
): RenderedPlanTree {
  const livePlanRoot = join(keeperRoot, "plugins", "plan");
  const work = join(
    tmpdir(),
    `prompt-oracle-plan-${process.pid}-${Date.now()}`,
  );
  rmSync(work, { recursive: true, force: true });
  cpSync(livePlanRoot, work, { recursive: true });
  writeFileSync(join(work, ".git"), ""); // synthetic project-root marker
  for (const kind of ["commands", "skills", "agents", "workers"]) {
    rmSync(join(work, kind), { recursive: true, force: true });
  }

  const r = runOracle(
    ["render-plugin-templates", "--project-root", work],
    work,
    { KEEPER_CONFIG_DIR: HOST_MATRIX_FIXTURE_DIR },
  );
  if (r.code !== 0) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `render-plugin-templates failed (exit ${r.code}): ${r.stderr}`,
    );
  }

  const roots = { arthackRoot, keeperRoot: work };
  return {
    work,
    stdout: tokenizeRoots(r.stdout.toString("utf-8"), roots),
    exitCode: r.code,
  };
}

// ---------------------------------------------------------------------------
// check-generated — every generated file in the rendered tree, both modes
// ---------------------------------------------------------------------------

/** Discover every generated primary file (a file with a sibling sidecar) plus
 *  every sidecar itself under the rendered tree — the full marked-file universe. */
function generatedTargets(planRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(SIDECAR_SUFFIX)) {
        found.push(full); // the sidecar itself (marked-by-name)
        found.push(full.slice(0, -SIDECAR_SUFFIX.length)); // its primary
      }
    }
  };
  walk(planRoot);
  return [...new Set(found)].sort();
}

function captureCheckGenerated(
  tree: RenderedPlanTree,
  arthackRoot: string,
): CheckGeneratedFixture[] {
  const targets = generatedTargets(tree.work);
  const roots = { arthackRoot, keeperRoot: tree.work };
  const out: CheckGeneratedFixture[] = [];
  for (const target of targets) {
    for (const on of ["write", "read"] as const) {
      const r = runOracle(["check-generated", target, "--on", on], tree.work);
      const tokenized = tokenizeRoots(r.stdout.toString("utf-8"), roots);
      const envelope = JSON.parse(tokenized) as Record<string, unknown>;
      out.push({
        target_relative: relative(tree.work, target),
        on,
        envelope_raw: envelope,
        exit_code: r.code,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.target_relative.localeCompare(b.target_relative) ||
      a.on.localeCompare(b.on),
  );
  return out;
}

// ---------------------------------------------------------------------------
// render-plugin-templates — full plan-plugin output tree + sidecars
// ---------------------------------------------------------------------------

/** Collect every output file the verb produces under the rendered plugin, in
 *  sorted order, base64'd for byte fidelity. Limited to the dirs the verb
 *  writes (commands/, skills/, agents/, and the render_to `workers/` cell tree)
 *  so static hand-authored siblings that carry no `.tmpl` source are never
 *  folded into the golden. */
function collectRenderedTree(pluginRoot: string): PluginTemplateFile[] {
  const files: PluginTemplateFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) {
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      files.push({
        relative: relative(pluginRoot, full),
        content_b64: readFileSync(full).toString("base64"),
        is_sidecar: name.endsWith(SIDECAR_SUFFIX),
      });
    }
  };
  // The verb writes these kinds; capturing only the files it produces keeps the
  // golden free of static, no-template siblings. `workers/` holds the render_to
  // per-cell `work` plugin dirs (each a `.claude-plugin/plugin.json` + an
  // `agents/worker.md`), fanned out from template/agents/worker.md.tmpl.
  walk(join(pluginRoot, "commands"));
  walk(join(pluginRoot, "skills"));
  walk(join(pluginRoot, "agents"));
  walk(join(pluginRoot, "workers"));
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function captureRenderPluginTemplates(
  tree: RenderedPlanTree,
): PluginTemplatesFixture {
  const fixture: PluginTemplatesFixture = {
    plugin_root_relative: join("plugins", "plan"),
    stdout: tree.stdout,
    exit_code: tree.exitCode,
    files: collectRenderedTree(tree.work),
  };
  if (fixture.files.length === 0) {
    throw new Error("render-plugin-templates produced no output files");
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function writeJson(name: string, data: unknown): void {
  writeFileSync(
    join(FIXTURES_DIR, name),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf-8",
  );
}

function main(): void {
  const arthackRoot = resolveArthackRoot();
  const oraclePath = assertOracleOnPath();
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const render = captureRender(arthackRoot);
  const tree = renderPlanTree(KEEPER_ROOT, arthackRoot);
  let checkGenerated: CheckGeneratedFixture[];
  let pluginTemplates: PluginTemplatesFixture;
  try {
    checkGenerated = captureCheckGenerated(tree, arthackRoot);
    pluginTemplates = captureRenderPluginTemplates(tree);
  } finally {
    rmSync(tree.work, { recursive: true, force: true });
  }

  const manifest: OracleManifest = {
    arthack_root: arthackRoot,
    keeper_root: KEEPER_ROOT,
    oracle_path: oraclePath,
    captured_at: new Date().toISOString(),
  };

  writeJson("manifest.json", manifest);
  writeJson("render.json", render);
  writeJson("check-generated.json", checkGenerated);
  writeJson("render-plugin-templates.json", pluginTemplates);

  process.stdout.write(
    `captured oracle fixtures:\n` +
      `  render: ${render.length} refs\n` +
      `  check-generated: ${checkGenerated.length} (file × mode) envelopes\n` +
      `  render-plugin-templates: ${pluginTemplates.files.length} files, ` +
      `exit ${pluginTemplates.exit_code}\n` +
      `  → ${FIXTURES_DIR}\n`,
  );
}

main();
