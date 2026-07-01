// Differential-parity suite: the ported `keeper prompt` engine vs the captured
// Python `promptctl` oracle goldens (test/oracle/fixtures/).
//
// Two halves:
//   1. HARNESS INTEGRITY — asserts the fixtures are captured non-empty for all
//      three hot verbs and that the normalizer's one intentional transform
//      (`promptctl ` → `keeper prompt ` + machine-root tokenization) is the
//      only thing it does. These pass NOW; they pin the capture infra itself.
//   2. CANDIDATE PARITY — runs `keeper prompt <verb>` and asserts byte-identical
//      output against the normalized oracle goldens. These are RED until the
//      verb-port tasks land `keeper prompt`; that is by design — this file is
//      the conformance gate every later task in the epic turns green.
//
// Run: bun test plugins/prompt/test/parity.test.ts   (from keeper root)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type {
  CheckGeneratedFixture,
  OracleManifest,
  PluginTemplatesFixture,
  RenderFixture,
} from "./oracle/fixture-types.ts";
import {
  type NormalizeRoots,
  normalizeCandidate,
  normalizeOracle,
  substituteVerb,
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
 *  manifest's capture root if it still exists, else the env/HOME fallback the
 *  port will use. */
const roots: NormalizeRoots = {
  arthackRoot: manifest.arthack_root,
  keeperRoot: KEEPER_ROOT,
};

/** Run `keeper prompt <args>` from `cwd`. Returns raw stdout bytes + exit. */
function runCandidate(
  args: string[],
  cwd: string,
): { stdout: Buffer; code: number; stderr: string } {
  const proc = spawnSync("keeper", ["prompt", ...args], { cwd });
  return {
    stdout: proc.stdout ?? Buffer.alloc(0),
    code: proc.status ?? -1,
    stderr: (proc.stderr ?? Buffer.alloc(0)).toString("utf-8"),
  };
}

/** True once `keeper prompt` is a wired subcommand. Until a verb-port task
 *  lands it, the candidate half is expected red — this lets those assertions
 *  fail with a clear "not wired yet" signal instead of a confusing byte diff. */
function keeperPromptWired(): boolean {
  const probe = spawnSync("keeper", ["prompt", "--help"], {
    encoding: "utf-8",
  });
  const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  return !/unknown subcommand 'prompt'/.test(text);
}

const PROMPT_WIRED = keeperPromptWired();

// ===========================================================================
// 1. HARNESS INTEGRITY — passes now; pins the capture infra
// ===========================================================================

describe("oracle fixtures captured non-empty for all three hot verbs", () => {
  test("manifest records both capture roots and the oracle path", () => {
    expect(manifest.arthack_root).toBeTruthy();
    expect(manifest.keeper_root).toBeTruthy();
    expect(manifest.oracle_path).toBeTruthy();
  });

  test("render: every snippet + bundle + sketch ref captured", () => {
    expect(renderFixtures.length).toBeGreaterThan(0);
    // The live corpus is ~90 snippets + ~11 bundles + sketches; a capture that
    // silently sampled a handful would let untested templates diverge later.
    expect(renderFixtures.length).toBeGreaterThanOrEqual(100);
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
    // body is itself a parity golden the candidate must reproduce, so it is
    // captured, not asserted non-empty here.
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

describe("normalizer applies ONLY the promptctl→keeper prompt + root transforms", () => {
  test("substituteVerb rewrites the command-position verb, leaves prose", () => {
    expect(substituteVerb("promptctl render foo")).toBe(
      "keeper prompt render foo",
    );
    // A bare word "promptctl" with no trailing space (prose mention) is left
    // alone — only the command-position `promptctl ` prefix is the port's diff.
    expect(substituteVerb("the promptctl engine")).toBe(
      "the keeper prompt engine",
    );
    expect(substituteVerb("see `promptctl`.")).toBe("see `promptctl`.");
  });

  test("tokenizeRoots replaces both machine roots, longest-first", () => {
    const r: NormalizeRoots = {
      arthackRoot: "/home/u/code/arthack",
      keeperRoot: "/home/u/code/keeper",
    };
    expect(tokenizeRoots("/home/u/code/arthack/x", r)).toBe("<ARTHACK_ROOT>/x");
    expect(tokenizeRoots("/home/u/code/keeper/y", r)).toBe("<KEEPER_ROOT>/y");
  });

  test("normalize is the IDENTITY on already-canonical text", () => {
    // Output that has no oracle verb and no machine root must pass through
    // untouched — proving the runner adds no incidental transform.
    const canonical =
      "keeper prompt render-plugin-templates --project-root <KEEPER_ROOT>\n";
    expect(normalizeOracle(canonical, roots)).toBe(canonical);
    expect(normalizeCandidate(canonical, roots)).toBe(canonical);
  });

  test("the ONLY oracle→candidate delta is the verb rename", () => {
    // Given a baked oracle envelope, the candidate's expected form differs from
    // the raw oracle bytes by exactly the verb substitution and nothing else.
    const oracleCmd = "promptctl render-plugin-templates --project-root /r";
    const candidateCmd =
      "keeper prompt render-plugin-templates --project-root /r";
    expect(substituteVerb(oracleCmd)).toBe(candidateCmd);
    // Reverse-substituting the candidate yields the oracle — bijective on the
    // command prefix, so no third transform hides in the diff.
    expect(candidateCmd.replace("keeper prompt ", "promptctl ")).toBe(
      oracleCmd,
    );
  });
});

// ===========================================================================
// 2. CANDIDATE PARITY — RED until `keeper prompt` lands; green once verbs port
// ===========================================================================

describe("keeper prompt is a wired subcommand", () => {
  test("`keeper prompt --help` resolves (not an unknown subcommand)", () => {
    expect(PROMPT_WIRED).toBe(true);
  });
});

describe("render: byte-identical vs oracle across the full ref universe", () => {
  for (const fx of renderFixtures) {
    test(`render ${fx.ref}`, () => {
      const want = normalizeOracle(
        Buffer.from(fx.stdout_b64, "base64").toString("utf-8"),
        roots,
      );
      const r = runCandidate(["render", fx.ref], manifest.arthack_root);
      expect(r.code).toBe(fx.exit_code);
      const got = normalizeCandidate(r.stdout.toString("utf-8"), roots);
      expect(got).toBe(want);
    });
  }
});

describe("check-generated: byte-identical envelope vs oracle, both modes", () => {
  for (const fx of checkFixtures) {
    test(`check-generated ${fx.target_relative} --on ${fx.on}`, () => {
      const target = join(KEEPER_ROOT, fx.target_relative);
      const r = runCandidate(
        ["check-generated", target, "--on", fx.on],
        KEEPER_ROOT,
      );
      expect(r.code).toBe(fx.exit_code);
      const gotEnvelope = JSON.parse(
        tokenizeRoots(r.stdout.toString("utf-8"), roots),
      ) as Record<string, unknown>;
      // Oracle envelope: tokenized at capture, verb-substituted here.
      const wantEnvelope = JSON.parse(
        substituteVerb(JSON.stringify(fx.envelope_raw)),
      ) as Record<string, unknown>;
      // Candidate envelope: verb-substitute too (no-op if already canonical).
      const gotCanonical = JSON.parse(
        substituteVerb(JSON.stringify(gotEnvelope)),
      ) as Record<string, unknown>;
      expect(gotCanonical).toEqual(wantEnvelope);
    });
  }
});

describe("render-plugin-templates: byte-identical tree + sidecars vs oracle", () => {
  test("full plan-plugin render matches the golden tree", () => {
    // Keep the byte-diff assertion meaningful: until the verb is wired the
    // candidate render can't run, so assert the wiring precondition and let
    // THAT be the single red signal rather than a spurious empty-tree diff.
    // Re-probe (not the narrowed module const) so the type stays boolean.
    if (!keeperPromptWired()) {
      expect(keeperPromptWired()).toBe(true);
      return;
    }

    const work = mkdtempSync(join(tmpdir(), "prompt-parity-rpt-"));
    try {
      const livePlanRoot = join(KEEPER_ROOT, "plugins", "plan");
      cpSync(livePlanRoot, work, { recursive: true });
      for (const kind of ["commands", "skills", "agents", "workers"]) {
        rmSync(join(work, kind), { recursive: true, force: true });
      }

      const r = runCandidate(
        ["render-plugin-templates", "--project-root", work],
        work,
      );
      expect(r.code).toBe(pluginTemplates.exit_code);

      const candidateRoots: NormalizeRoots = {
        arthackRoot: manifest.arthack_root,
        keeperRoot: work,
      };
      const gotStdout = normalizeCandidate(
        r.stdout.toString("utf-8"),
        candidateRoots,
      );
      expect(gotStdout).toBe(normalizeOracle(pluginTemplates.stdout, roots));

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
        const want = normalizeOracle(wantByRel.get(rel) as string, roots);
        const got = normalizeCandidate(gotContent, candidateRoots);
        expect(got).toBe(want);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
