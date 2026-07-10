// Regression-pin snapshot suite for the `keeper prompt` engine.
//
// The suite locks the current engine's output against recorded goldens
// (test/oracle/fixtures/), captured from `keeper prompt` itself over the live
// arthack corpus + plan-plugin templates. It is NOT a Python-parity gate — the
// promptctl port it once guarded is complete; these goldens now pin the engine
// against its own future drift. Re-record deliberately via `bun run
// capture-oracle` (see oracle/capture.ts) when the corpus or templates change,
// eyeballing the diff so a new bug is never frozen as golden.
//
// Two halves:
//   1. HARNESS INTEGRITY — asserts the recorded universe is captured non-empty
//      across every verb surface (render / check-generated / render-plugin-
//      templates) and that the sole canonicalizer (machine-root tokenization) is
//      the only transform the compare applies. Guards the capture infra so
//      coverage can't silently shrink.
//   2. REGRESSION PIN — runs each verb and asserts its output equals the
//      recorded golden. Expected values are read from disk, never recomputed by
//      the assert-time code path, so a genuine engine regression surfaces as a
//      byte diff rather than passing vacuously.
//
// Run: bun test plugins/prompt/test/parity.test.ts   (from keeper root)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  HostMatrixConfigError,
  hostMatrixV2EffortsFor,
  loadHostMatrixV2,
} from "../../plan/src/host_matrix.ts";
import { run as runCheckGenerated } from "../src/check_generated.ts";
import { run as runRender } from "../src/render.ts";
import { renderTemplate } from "../src/render_engine.ts";
import { runRenderPluginTemplates } from "../src/render_plugin_templates.ts";
import type {
  CheckGeneratedFixture,
  OracleManifest,
  PluginTemplatesFixture,
  RenderFixture,
} from "./oracle/fixture-types.ts";
import {
  type NormalizeRoots,
  normalize,
  tokenizeRoots,
} from "./oracle/normalize.ts";

const SIDECAR_SUFFIX = ".managed-file-dont-edit";
const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURES_DIR = join(HERE, "oracle", "fixtures");
const KEEPER_ROOT = resolve(HERE, "..", "..", "..");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as T;
}

const manifest = loadJson<OracleManifest>("manifest.json");
const renderFixtures = loadJson<RenderFixture[]>("render.json");
const checkFixtures = loadJson<CheckGeneratedFixture[]>("check-generated.json");
const pluginTemplates = loadJson<PluginTemplatesFixture>(
  "render-plugin-templates.json",
);

/** Live roots for re-tokenizing candidate output. arthack resolves through the
 *  manifest's capture root; the keeper root is this checkout. */
const roots: NormalizeRoots = {
  arthackRoot: manifest.arthack_root,
  keeperRoot: KEEPER_ROOT,
};

/** The committed claude-only v2 host matrix every in-process render resolves as
 *  its `KEEPER_CONFIG_DIR`, so no operator `~/.config/keeper/matrix.yaml` leaks
 *  into the golden compares. Its cell set — opus/sonnet × the five efforts, all
 *  native — is exactly what the render-plugin-templates golden tree pins. */
const SANDBOX_CONFIG_DIR = join(FIXTURES_DIR, "host-matrix");

interface CandidateRun {
  stdout: Buffer;
  code: number;
  stderr: string;
}

/** Run a prompt verb in-process with stdout/stderr captured. The parity suite is
 *  a renderer regression pin, not a process-spawn contract; the actual verb
 *  functions provide the candidate bytes for the golden comparison. */
function runCandidate(args: string[], cwd: string): CandidateRun {
  const [command, ...rest] = args;
  return captureCandidate(() => {
    switch (command) {
      case "render":
        return runRender(positional(rest), cwd, null);
      case "check-generated":
        return runCheckGenerated(positional(rest), option(rest, "--on"));
      case "render-plugin-templates":
        return runRenderPluginTemplates({
          projectRoot: option(rest, "--project-root") ?? cwd,
        });
      default:
        throw new Error(`unknown prompt candidate verb: ${command ?? ""}`);
    }
  });
}

function captureCandidate(run: () => number): CandidateRun {
  const priorStdoutWrite = process.stdout.write;
  const priorStderrWrite = process.stderr.write;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  process.stdout.write = captureWrite(stdoutChunks);
  process.stderr.write = captureWrite(stderrChunks);
  const savedConfigDir = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = SANDBOX_CONFIG_DIR;
  try {
    const code = run();
    return {
      stdout: Buffer.concat(stdoutChunks),
      code,
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    };
  } finally {
    process.stdout.write = priorStdoutWrite;
    process.stderr.write = priorStderrWrite;
    if (savedConfigDir === undefined) {
      delete process.env.KEEPER_CONFIG_DIR;
    } else {
      process.env.KEEPER_CONFIG_DIR = savedConfigDir;
    }
  }
}

function captureWrite(chunks: Buffer[]): typeof process.stdout.write {
  return ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf-8"));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(String(chunk), "utf-8"));
    }
    const callback =
      typeof encodingOrCb === "function"
        ? encodingOrCb
        : typeof cb === "function"
          ? cb
          : null;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
}

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

function option(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) {
    return eq.slice(name.length + 1);
  }
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Render the plan plugin into a throwaway copy with a synthetic `.git` marker,
 *  mirroring oracle/capture.ts. Returns the temp root (caller cleans up). The
 *  `.git` makes check-generated resolve the copy as its project root, so the
 *  assertion is hermetic — independent of whether the launch-generated
 *  (gitignored) render tree is materialized in the live checkout. */
function renderPlanTree(): string {
  const work = mkdtempSync(join(tmpdir(), "prompt-parity-plan-"));
  copyPlanPluginSkeleton(work);
  const r = runCandidate(
    ["render-plugin-templates", "--project-root", work],
    work,
  );
  if (r.code !== 0) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `render-plugin-templates failed (exit ${r.code}): ${r.stderr}`,
    );
  }
  return work;
}

function copyPlanPluginSkeleton(work: string): void {
  const livePlanRoot = join(KEEPER_ROOT, "plugins", "plan");
  for (const entry of [".claude-plugin", "template", "subagents.yaml"]) {
    cpSync(join(livePlanRoot, entry), join(work, entry), { recursive: true });
  }
  writeFileSync(join(work, ".git"), ""); // synthetic project-root marker
}

// ===========================================================================
// 1. HARNESS INTEGRITY — pins the capture infra so coverage can't shrink
// ===========================================================================

describe("goldens captured non-empty across every verb surface", () => {
  test("manifest records both capture roots and the engine path", () => {
    expect(manifest.arthack_root).toBeTruthy();
    expect(manifest.keeper_root).toBeTruthy();
    expect(manifest.oracle_path).toBeTruthy();
  });

  test("render: every snippet + bundle + sketch ref captured", () => {
    expect(renderFixtures.length).toBeGreaterThan(0);
    // The live corpus is ~70 snippets + ~11 bundles + ~11 sketches; a capture
    // that silently sampled a handful would let untested templates diverge
    // later, so hold a floor comfortably above realistic corpus pruning.
    expect(renderFixtures.length).toBeGreaterThanOrEqual(80);
    const bundles = renderFixtures.filter((r) => r.ref.startsWith("bundle/"));
    const sketches = renderFixtures.filter((r) => r.ref.startsWith("sketch/"));
    const snippets = renderFixtures.filter((r) => !r.ref.includes("/"));
    expect(bundles.length).toBeGreaterThan(0);
    expect(sketches.length).toBeGreaterThan(0);
    expect(snippets.length).toBeGreaterThan(0);
    for (const r of renderFixtures) {
      // Every render exits clean — render is informational, never errors.
      expect(r.exit_code).toBe(0);
    }
    // Snippet + bundle bodies are never empty. A sketch CAN render empty (its
    // snippet_ids all skipped under the deletion-drift policy) — that empty
    // body is itself a golden the engine must reproduce, so it is captured, not
    // asserted non-empty here.
    for (const r of [...snippets, ...bundles]) {
      expect(Buffer.from(r.stdout_b64, "base64").length).toBeGreaterThan(0);
    }
  });

  test("check-generated: representative generated files in both modes", () => {
    expect(checkFixtures.length).toBeGreaterThan(0);
    const modes = new Set(checkFixtures.map((c) => c.on));
    expect(modes.has("read")).toBe(true);
    expect(modes.has("write")).toBe(true);
    // At least one genuinely marked file (the whole point of the verb).
    const marked = checkFixtures.filter((c) => c.envelope_raw.marked === true);
    expect(marked.length).toBeGreaterThan(0);
    for (const c of marked) {
      expect(typeof c.envelope_raw.regenerate_cmd).toBe("string");
      expect(typeof c.envelope_raw.message).toBe("string");
    }
  });

  test("render-plugin-templates: full plan-plugin tree + every sidecar", () => {
    expect(pluginTemplates.exit_code).toBe(0);
    expect(pluginTemplates.files.length).toBeGreaterThan(0);
    expect(pluginTemplates.stdout).toContain("✓ Rendered");
    const sidecars = pluginTemplates.files.filter((f) => f.is_sidecar);
    const primaries = pluginTemplates.files.filter((f) => !f.is_sidecar);
    expect(sidecars.length).toBeGreaterThan(0);
    expect(primaries.length).toBeGreaterThan(0);
    // Every rendered primary has its companion sidecar — the guard contract.
    for (const p of primaries) {
      const want = `${p.relative}${SIDECAR_SUFFIX}`;
      expect(sidecars.some((s) => s.relative === want)).toBe(true);
    }
  });
});

describe("the canonicalizer applies ONLY machine-root tokenization", () => {
  test("tokenizeRoots replaces both machine roots, longest-first", () => {
    const r: NormalizeRoots = {
      arthackRoot: "/home/u/code/arthack",
      keeperRoot: "/home/u/code/keeper",
    };
    expect(tokenizeRoots("/home/u/code/arthack/x", r)).toBe("<ARTHACK_ROOT>/x");
    expect(tokenizeRoots("/home/u/code/keeper/y", r)).toBe("<KEEPER_ROOT>/y");
  });

  test("normalize is the IDENTITY on already-canonical text", () => {
    // Output that carries no machine root must pass through untouched — proving
    // the compare adds no incidental transform beyond root tokenization.
    const canonical =
      "keeper prompt render-plugin-templates --project-root <KEEPER_ROOT>\n";
    expect(normalize(canonical, roots)).toBe(canonical);
  });

  test("normalize is exactly root tokenization (no other rewrite)", () => {
    const r: NormalizeRoots = {
      arthackRoot: "/a/arthack",
      keeperRoot: "/a/keeper",
    };
    const raw = "src /a/arthack/s and /a/keeper/t only\n";
    expect(normalize(raw, r)).toBe(tokenizeRoots(raw, r));
    expect(normalize(raw, r)).toBe(
      "src <ARTHACK_ROOT>/s and <KEEPER_ROOT>/t only\n",
    );
  });
});

// ===========================================================================
// 2. REGRESSION PIN — the engine's output vs its recorded goldens
// ===========================================================================

describe("render: byte-identical vs golden across the full ref universe", () => {
  for (const fx of renderFixtures) {
    test(`render ${fx.ref}`, () => {
      const want = normalize(
        Buffer.from(fx.stdout_b64, "base64").toString("utf-8"),
        roots,
      );
      const r = runCandidate(["render", fx.ref], manifest.arthack_root);
      expect(r.code).toBe(fx.exit_code);
      const got = normalize(r.stdout.toString("utf-8"), roots);
      expect(got).toBe(want);
    });
  }
});

describe("check-generated: byte-identical envelope vs golden, both modes", () => {
  let planTree: string | null = null;

  beforeAll(() => {
    planTree = renderPlanTree();
  });
  afterAll(() => {
    if (planTree) {
      rmSync(planTree, { recursive: true, force: true });
    }
  });

  for (const fx of checkFixtures) {
    test(`check-generated ${fx.target_relative} --on ${fx.on}`, () => {
      expect(planTree).not.toBeNull();
      const work = planTree as string;
      const target = join(work, fx.target_relative);
      const r = runCandidate(["check-generated", target, "--on", fx.on], work);
      expect(r.code).toBe(fx.exit_code);
      const workRoots: NormalizeRoots = {
        arthackRoot: manifest.arthack_root,
        keeperRoot: work,
      };
      const gotEnvelope = JSON.parse(
        tokenizeRoots(r.stdout.toString("utf-8"), workRoots),
      ) as Record<string, unknown>;
      expect(gotEnvelope).toEqual(fx.envelope_raw);
    });
  }
});

describe("render-plugin-templates: byte-identical tree + sidecars vs golden", () => {
  test("full plan-plugin render matches the golden tree", () => {
    const work = mkdtempSync(join(tmpdir(), "prompt-parity-rpt-"));
    try {
      copyPlanPluginSkeleton(work);
      const r = runCandidate(
        ["render-plugin-templates", "--project-root", work],
        work,
      );
      expect(r.code).toBe(pluginTemplates.exit_code);

      const candidateRoots: NormalizeRoots = {
        arthackRoot: manifest.arthack_root,
        keeperRoot: work,
      };
      const gotStdout = normalize(r.stdout.toString("utf-8"), candidateRoots);
      expect(gotStdout).toBe(normalize(pluginTemplates.stdout, roots));

      // Compare the rendered tree file-by-file.
      const gotFiles = collectTree(work);
      const wantByRel = new Map(
        pluginTemplates.files.map((f) => [
          f.relative,
          Buffer.from(f.content_b64, "base64").toString("utf-8"),
        ]),
      );
      expect(new Set(gotFiles.keys())).toEqual(new Set(wantByRel.keys()));
      for (const [rel, gotContent] of gotFiles) {
        const want = normalize(wantByRel.get(rel) as string, roots);
        const got = normalize(gotContent, candidateRoots);
        expect(got).toBe(want);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 3. WORKER CELLS — the REQUIRED v2 host worker matrix (ADR 0036)
//
// These run the worktree renderer in-process under a pinned KEEPER_CONFIG_DIR.
// The matrix is required: an absent/unparseable/schema-invalid/empty matrix
// aborts the render with a typed four-state error and writes no partial tree; a
// present matrix's `subagent_models × effortsFor(capability)` is the cell set.
// ===========================================================================

describe("worker cells: the required v2 host worker matrix", () => {
  // The pinned committed claude-only matrix (opus/sonnet × five efforts, all
  // native), byte-for-byte the fixture the golden tree was captured under.
  const CLAUDE_ONLY_MATRIX = [
    "efforts: [low, medium, high, xhigh, max]",
    "subagent_templates: [template/agents/worker.md.tmpl]",
    "subagent_models: [opus, sonnet]",
    "providers:",
    "  - name: claude",
    "    models: [opus, sonnet]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");

  // claude serves opus (native); codex serves the wrapped capability
  // gpt-5.5 (cost-ascending first among wrapped providers, so it wins); pi's
  // gpt-5.5 entry is shadowed cross-provider (first provider wins, logged).
  const MULTI_PROVIDER_MATRIX = [
    "efforts: [medium, high]",
    "subagent_templates: [template/agents/worker.md.tmpl]",
    "subagent_models: [opus, gpt-5.5]",
    "providers:",
    "  - name: claude",
    "    models: [opus]",
    "  - name: codex",
    "    models: [gpt-5.5]",
    "  - name: pi",
    "    models: [gpt-5.5]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: xhigh",
    "",
  ].join("\n");

  // A ragged roster: opus renders only [high], gpt-5.5 renders only [medium], so
  // the {model × effort} cube is non-rectangular. Each capability's own effort
  // list drives its fan-out.
  const RAGGED_MATRIX = [
    "efforts: [medium, high]",
    "subagent_templates: [template/agents/worker.md.tmpl]",
    "subagent_models: [opus, gpt-5.5]",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - id: opus",
    "        efforts: [high]",
    "  - name: codex",
    "    models:",
    "      - id: gpt-5.5",
    "        efforts: [medium]",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: xhigh",
    "",
  ].join("\n");

  const trackedCfgDirs: string[] = [];
  afterAll(() => {
    for (const d of trackedCfgDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** A tracked temp config dir, optionally carrying a `matrix.yaml`. Absent
   *  `matrixYaml` yields an EMPTY dir — the absent-matrix state. */
  function tmpConfig(matrixYaml?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "prompt-cell-cfg-"));
    trackedCfgDirs.push(dir);
    if (matrixYaml !== undefined) {
      writeFileSync(join(dir, "matrix.yaml"), matrixYaml);
    }
    return dir;
  }

  /** `loadHostMatrixV2` resolved under `configDir` as KEEPER_CONFIG_DIR. */
  function matrixUnder(configDir: string) {
    const saved = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = configDir;
    try {
      return loadHostMatrixV2();
    } finally {
      if (saved === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = saved;
      }
    }
  }

  /** Render the live plan plugin in-process under `configDir`. Returns the temp
   *  render root + exit code; caller cleans up `work`. */
  function renderPlanInProcess(configDir: string): {
    work: string;
    rc: number;
  } {
    const work = mkdtempSync(join(tmpdir(), "prompt-cell-plan-"));
    copyPlanPluginSkeleton(work);
    const saved = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = configDir;
    try {
      return { work, rc: runRenderPluginTemplates({ projectRoot: work }) };
    } finally {
      if (saved === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = saved;
      }
    }
  }

  /** Sorted `workers/<model>-<effort>` cell directory names in a rendered tree. */
  function workerCellDirs(work: string): string[] {
    const dir = join(work, "workers");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .sort();
  }

  /** True when a render aborted BEFORE writing any output shape into `work`. */
  function noPartialTree(work: string): boolean {
    return ["commands", "skills", "agents", "workers"].every(
      (shape) => !existsSync(join(work, shape)),
    );
  }

  test("a claude-only matrix: all-native axes, the wrapper driver from the host", () => {
    const m = matrixUnder(tmpConfig(CLAUDE_ONLY_MATRIX));
    expect([...m.models].sort()).toEqual(["opus", "sonnet"]);
    expect([...m.efforts]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Every model shares the flat axis — the cube stays rectangular.
    for (const model of m.models) {
      expect(hostMatrixV2EffortsFor(m, model)).toEqual([...m.efforts]);
    }
    expect(m.driverByModel.get("opus")).toBe("native");
    expect(m.driverByModel.get("sonnet")).toBe("native");
    expect(m.wrapper_driver).toEqual({ model: "sonnet", effort: "high" });
  });

  test("a multi-provider matrix: wrapped model + driver + wrapper + shadow log from the host", () => {
    const m = matrixUnder(tmpConfig(MULTI_PROVIDER_MATRIX));
    expect([...m.models].sort()).toEqual(["gpt-5.5", "opus"]);
    expect([...m.efforts]).toEqual(["medium", "high"]);
    // claude membership → native; a capability served only by codex/pi → wrapped.
    expect(m.driverByModel.get("opus")).toBe("native");
    expect(m.driverByModel.get("gpt-5.5")).toBe("wrapped");
    expect(m.wrapper_driver).toEqual({ model: "sonnet", effort: "xhigh" });
    // pi's gpt-5.5 is shadowed by codex (first provider wins).
    expect(m.shadowed).toEqual([
      {
        provider: "pi",
        capability: "gpt-5.5",
        launchId: "gpt-5.5",
        winner: "codex",
      },
    ]);
  });

  test("an absent matrix throws the typed four-state 'absent' error (no silent fallback)", () => {
    let caught: unknown;
    try {
      matrixUnder(tmpConfig());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostMatrixConfigError);
    expect((caught as HostMatrixConfigError).state).toBe("absent");
  });

  test("a schema-invalid matrix throws loud, never a silent fall-back to defaults", () => {
    // providers must be a non-empty list — a mapping is malformed.
    const cfg = tmpConfig(
      "efforts: [high]\nsubagent_templates: [template/agents/worker.md.tmpl]\nsubagent_models: [opus]\nproviders: {}\nwrapper_driver:\n  model: sonnet\n  effort: high\n",
    );
    let caught: unknown;
    try {
      matrixUnder(cfg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostMatrixConfigError);
    expect((caught as HostMatrixConfigError).state).toBe("schema-invalid");
  });

  test("an escaping subagent_templates entry is rejected upstream at load time", () => {
    const cfg = tmpConfig(
      [
        "efforts: [high]",
        "subagent_templates: ['../escape.md.tmpl']",
        "subagent_models: [opus]",
        "providers:",
        "  - name: claude",
        "    models: [opus]",
        "wrapper_driver:",
        "  model: sonnet",
        "  effort: high",
        "",
      ].join("\n"),
    );
    let caught: unknown;
    try {
      matrixUnder(cfg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostMatrixConfigError);
    expect((caught as HostMatrixConfigError).state).toBe("schema-invalid");
  });

  test("acceptance 1 — a claude-only matrix renders byte-identical to the golden tree (in-process)", () => {
    const { work, rc } = renderPlanInProcess(tmpConfig(CLAUDE_ONLY_MATRIX));
    try {
      expect(rc).toBe(0);
      const gotFiles = collectTree(work);
      const wantByRel = new Map(
        pluginTemplates.files.map((f) => [
          f.relative,
          Buffer.from(f.content_b64, "base64").toString("utf-8"),
        ]),
      );
      const candidateRoots: NormalizeRoots = {
        arthackRoot: manifest.arthack_root,
        keeperRoot: work,
      };
      expect(new Set(gotFiles.keys())).toEqual(new Set(wantByRel.keys()));
      for (const [rel, gotContent] of gotFiles) {
        const want = normalize(wantByRel.get(rel) as string, roots);
        expect(normalize(gotContent, candidateRoots)).toBe(want);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("acceptance 2 — a multi-provider matrix fans out one cell per capability × effort", () => {
    const { work, rc } = renderPlanInProcess(tmpConfig(MULTI_PROVIDER_MATRIX));
    try {
      expect(rc).toBe(0);
      // cell axis {opus, gpt-5.5} × efforts {medium, high} — one cell each.
      expect(workerCellDirs(work)).toEqual([
        "gpt-5.5-high",
        "gpt-5.5-medium",
        "opus-high",
        "opus-medium",
      ]);
      // the wrapped cell's frontmatter bakes the WRAPPER driver (claude sonnet at
      // xhigh, maxTurns 160) — the capability model runs via its provider, not here.
      const wrapped = readFileSync(
        join(work, "workers", "gpt-5.5-high", "agents", "worker.md"),
        "utf-8",
      );
      expect(wrapped).toContain("model: sonnet");
      expect(wrapped).toContain('effort: "xhigh"');
      expect(wrapped).toContain("maxTurns: 160");
      // the body bakes the capability model + keeper effort it delegates for.
      expect(wrapped).toContain("model `gpt-5.5`, keeper effort `high`");
      expect(wrapped).toContain("keeper agent providers resolve gpt-5.5 high");
      expect(
        existsSync(
          join(
            work,
            "workers",
            "gpt-5.5-high",
            ".claude-plugin",
            "plugin.json",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("acceptance 2 (ragged) — per-model effort overrides fan out a non-rectangular cell set", () => {
    // effortsFor(opus)=[high], effortsFor(gpt-5.5)=[medium] — the matrix exposes
    // the ragged lists.
    const m = matrixUnder(tmpConfig(RAGGED_MATRIX));
    expect(hostMatrixV2EffortsFor(m, "opus")).toEqual(["high"]);
    expect(hostMatrixV2EffortsFor(m, "gpt-5.5")).toEqual(["medium"]);

    const { work, rc } = renderPlanInProcess(tmpConfig(RAGGED_MATRIX));
    try {
      expect(rc).toBe(0);
      // Ragged product: opus-high + gpt-5.5-medium ONLY — never the rectangular
      // opus-medium / gpt-5.5-high the flat cartesian would have emitted.
      expect(workerCellDirs(work)).toEqual(["gpt-5.5-medium", "opus-high"]);
      expect(existsSync(join(work, "workers", "opus-medium"))).toBe(false);
      expect(existsSync(join(work, "workers", "gpt-5.5-high"))).toBe(false);
      // The rendered cells still bake their own driver: native opus keeps its model
      // + effort, the wrapped gpt-5.5 cell bakes the wrapper driver.
      const native = readFileSync(
        join(work, "workers", "opus-high", "agents", "worker.md"),
        "utf-8",
      );
      expect(native).toContain("model: opus");
      expect(native).toContain('effort: "high"');
      const wrapped = readFileSync(
        join(work, "workers", "gpt-5.5-medium", "agents", "worker.md"),
        "utf-8",
      );
      expect(wrapped).toContain("model: sonnet");
      expect(wrapped).toContain("model `gpt-5.5`, keeper effort `medium`");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("acceptance 2 — an absent matrix aborts the render (rc 1) and writes no partial tree", () => {
    const { work, rc } = renderPlanInProcess(tmpConfig());
    try {
      expect(rc).toBe(1);
      expect(noPartialTree(work)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("acceptance 2 — a schema-invalid matrix aborts the render (rc 1) and writes no partial tree", () => {
    const { work, rc } = renderPlanInProcess(
      tmpConfig(
        "efforts: [high]\nsubagent_templates: [template/agents/worker.md.tmpl]\nsubagent_models: [opus]\nproviders: {}\nwrapper_driver:\n  model: sonnet\n  effort: high\n",
      ),
    );
    try {
      expect(rc).toBe(1);
      expect(noPartialTree(work)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("acceptance 5 — an inventory-listed template missing manifest_description errors, writing no cell manifest", () => {
    const work = mkdtempSync(join(tmpdir(), "prompt-cell-nomanifest-"));
    const cfg = tmpConfig(CLAUDE_ONLY_MATRIX);
    const saved = process.env.KEEPER_CONFIG_DIR;
    try {
      copyPlanPluginSkeleton(work);
      // Strip the manifest_description: line from the (copied) cell template so
      // the listed inventory template lacks the required field.
      const tmpl = join(work, "template", "agents", "worker.md.tmpl");
      writeFileSync(
        tmpl,
        readFileSync(tmpl, "utf-8").replace(/^manifest_description:.*\n/m, ""),
      );
      process.env.KEEPER_CONFIG_DIR = cfg;
      const rc = runRenderPluginTemplates({ projectRoot: work });
      expect(rc).toBe(1);
      // No per-cell plugin.json is emitted for a cell whose template lacked the field.
      expect(
        existsSync(
          join(work, "workers", "opus-high", ".claude-plugin", "plugin.json"),
        ),
      ).toBe(false);
    } finally {
      if (saved === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = saved;
      }
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the composed shell branches the frontmatter on the driver — native keeps the model/effort/maxTurns, wrapped bakes the wrapper driver", () => {
    const { work, rc } = renderPlanInProcess(tmpConfig(MULTI_PROVIDER_MATRIX));
    try {
      expect(rc).toBe(0);
      // A native cell (claude serves opus) keeps its own model + effort at the
      // full task-worker maxTurns budget.
      const native = readFileSync(
        join(work, "workers", "opus-high", "agents", "worker.md"),
        "utf-8",
      );
      expect(native).toContain("model: opus");
      expect(native).toContain('effort: "high"');
      expect(native).toContain("maxTurns: 300");
      expect(native).not.toContain("model: sonnet");
      // A wrapped cell (gpt-5.5 served by codex/pi) runs as the wrapper driver at
      // the shorter wrapper budget, never the capability model in the frontmatter.
      const wrapped = readFileSync(
        join(work, "workers", "gpt-5.5-high", "agents", "worker.md"),
        "utf-8",
      );
      expect(wrapped).toContain("model: sonnet");
      expect(wrapped).toContain('effort: "xhigh"');
      expect(wrapped).toContain("maxTurns: 160");
      // The shared spine (Phase 5/6, escalation taxonomy) is single-sourced, so
      // both kinds carry it byte-for-byte; only the implement/commit middle differs.
      for (const body of [native, wrapped]) {
        expect(body).toContain("## Phase 5 — Mark done");
        expect(body).toContain("## Phase 6 — Verify completion criteria");
        expect(body).toContain("BLOCKED: <CATEGORY>");
      }
      // The divergent middle: native carries today's implement phase verbatim; the
      // wrapped body carries the delegate phase instead, never the native one.
      expect(native).toContain("## Phase 2 — Implement");
      expect(native).not.toContain("## Phase 2 — Delegate implementation");
      expect(wrapped).toContain(
        "## Phase 2 — Delegate implementation to the provider",
      );
      expect(wrapped).not.toContain("## Phase 2 — Implement");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a wrapped cell body carries the full delegate → adjudicate → normalize → commit contract", () => {
    const { work, rc } = renderPlanInProcess(tmpConfig(MULTI_PROVIDER_MATRIX));
    try {
      expect(rc).toBe(0);
      const wrapped = readFileSync(
        join(work, "workers", "gpt-5.5-medium", "agents", "worker.md"),
        "utf-8",
      );
      // Delegate: resolve providers for the BAKED capability + effort, then launch
      // the first candidate DETACHED (never one blocking call) with chunked waits.
      expect(wrapped).toContain(
        "keeper agent providers resolve gpt-5.5 medium",
      );
      expect(wrapped).toContain("wrapped::<task-id>");
      expect(wrapped).toContain("nohup");
      expect(wrapped).toContain("keeper agent wait");
      // Failure map: launch-fail falls through the pecking order, timeout retries
      // to max_attempts then blocks, no_route / bad args are typed blocks.
      expect(wrapped).toContain("Failure map");
      expect(wrapped).toContain("no_route");
      expect(wrapped).toContain("max_attempts");
      expect(wrapped).toContain("BLOCKED: EXTERNAL_BLOCKED");
      // Adjudicate: the return is attacker-influenced, re-run the authoritative pass.
      expect(wrapped).toContain("attacker-influenced");
      expect(wrapped).toContain("re-run the authoritative test pass");
      // Normalize + commit: soft-reset a foreign commit, stage the git-derived set,
      // land ONE commit with the wrapper's own Task line + Job-Id via commit-work.
      expect(wrapped).toContain("git reset --soft");
      expect(wrapped).toContain("forbidden-trailer gate");
      expect(wrapped).toContain("Task: $TASK_ID");
      expect(wrapped).toContain("Job-Id:");
      expect(wrapped).toContain("keeper commit-work");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a cell rendered without driver bindings fails the render loudly (strictVariables), never a partial agent", () => {
    const workerTmpl = join(
      KEEPER_ROOT,
      "plugins",
      "plan",
      "template",
      "agents",
      "worker.md.tmpl",
    );
    // No driver binding at all → the frontmatter branch raises rather than
    // silently emitting a partial (unbranched) agent.
    expect(() =>
      renderTemplate(workerTmpl, {
        current_model: "opus",
        current_effort: "high",
        wrapper_model: "sonnet",
        wrapper_effort: "xhigh",
      }),
    ).toThrow(/current_driver/);
    // A wrapped driver missing its wrapper bindings also raises loudly.
    expect(() =>
      renderTemplate(workerTmpl, {
        current_model: "gpt-5.5",
        current_effort: "high",
        current_driver: "wrapped",
        wrapper_effort: "xhigh",
      }),
    ).toThrow(/wrapper_model/);
    // The full native binding set renders cleanly (no throw, real body).
    const ok = renderTemplate(workerTmpl, {
      current_model: "opus",
      current_effort: "high",
      current_driver: "native",
      wrapper_model: "sonnet",
      wrapper_effort: "xhigh",
    });
    expect(ok.text).toContain("model: opus");
    expect(ok.text).toContain("maxTurns: 300");
    expect(ok.text).toContain("## Phase 2 — Implement");
  });
});

/** Read a rendered plugin tree into {relative → utf8 content}, scoped to the
 *  dirs the verb writes (mirrors the capture's collection discipline). */
function collectTree(pluginRoot: string): Map<string, string> {
  const out = new Map<string, string>();
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
      out.set(relative(pluginRoot, full), readFileSync(full, "utf-8"));
    }
  };
  walk(join(pluginRoot, "commands"));
  walk(join(pluginRoot, "skills"));
  walk(join(pluginRoot, "agents"));
  walk(join(pluginRoot, "workers"));
  return out;
}
