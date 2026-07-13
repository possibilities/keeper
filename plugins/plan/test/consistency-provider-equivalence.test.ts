// Drift gate for the cross-provider equivalence map (../provider-equivalence.yaml,
// ADR 0047), asserted in the fast tier as pure disk reads — no subprocess,
// daemon, or git. Mirrors consistency-model-selector.test.ts's structure:
// on-disk config smoke tests, then the pure check/state cores driven with
// hand-built inputs whose expected outcomes are authored independently of the
// map under test, then the break-it-first fixture proof.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Driver, EffectiveMatrix } from "../src/host_matrix.ts";
import {
  checkProviderEquivalence,
  checkProviderEquivalenceFromDisk,
  classifyProviderEquivalence,
  classifyProviderEquivalenceFromDisk,
  coerceProviderEquivalenceConfig,
  type EquivalenceEntry,
  loadProviderEquivalenceConfig,
  type ProviderEquivalenceConfig,
  ProviderEquivalenceConfigError,
} from "../src/provider_equivalence.ts";
import { parseYamlInput } from "../src/yaml_input.ts";

const PLAN_ROOT = resolve(import.meta.dir, "..");
const FIXTURES_DIR = join(PLAN_ROOT, "test", "fixtures");
const VALID_FIXTURE_PATH = join(
  FIXTURES_DIR,
  "provider-equivalence-valid.yaml",
);
const INVALID_FIXTURE_PATH = join(
  FIXTURES_DIR,
  "provider-equivalence-invalid.yaml",
);
const CLAUDE_AND_CODEX_MATRIX = readFileSync(
  join(FIXTURES_DIR, "matrix-claude-and-pi.yaml"),
  "utf-8",
);

const stateCfgDirs: string[] = [];
function withClaudeAndCodexMatrix<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "peq-cfg-"));
  stateCfgDirs.push(dir);
  writeFileSync(join(dir, "matrix.yaml"), CLAUDE_AND_CODEX_MATRIX);
  const prev = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KEEPER_CONFIG_DIR;
    else process.env.KEEPER_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// on-disk map ↔ host matrix
// ---------------------------------------------------------------------------

describe("on-disk provider-equivalence map", () => {
  test("the committed map coerces and passes the host-blind check", () => {
    const result = checkProviderEquivalenceFromDisk(PLAN_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("state mode classifies the committed map as total against the full dispatchable roster, with no dangling target", () => {
    const state = withClaudeAndCodexMatrix(() =>
      classifyProviderEquivalenceFromDisk(PLAN_ROOT),
    );
    expect(state.gaps).toEqual([]);
    expect(state.dangling_targets).toEqual([]);
    expect(state.total).toBe(true);
  });

  test("a small well-formed fixture coerces and passes the check", () => {
    const config = loadProviderEquivalenceConfig(VALID_FIXTURE_PATH);
    expect(checkProviderEquivalence(config)).toEqual({ ok: true, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// break-it-first proof — the deliberately-invalid fixture
// ---------------------------------------------------------------------------

describe("break-it-first: the deliberately-invalid fixture", () => {
  test("fails to coerce, naming the unknown top-level key", () => {
    expect(() => loadProviderEquivalenceConfig(INVALID_FIXTURE_PATH)).toThrow(
      "unknown key 'extra_top_level_key'",
    );
  });

  test("its bundled semantic defects (same-family target, missing effort) would independently fail checkProviderEquivalence, were the structural rejection loosened", () => {
    // Prove the fixture's OTHER two defects are real (not just the unknown
    // key) by parsing it with the unknown key stripped — coercion then
    // succeeds, and the pure check core catches both remaining problems.
    const raw = readFileSync(INVALID_FIXTURE_PATH, "utf-8");
    const stripped = raw
      .split("\n")
      .filter((line) => !line.includes("extra_top_level_key"))
      .join("\n");
    const doc = parseYamlInput(
      Buffer.from(stripped, "utf-8"),
      "stripped-fixture",
    );
    const config = coerceProviderEquivalenceConfig(doc);
    const result = checkProviderEquivalence(config);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("same-family") && e.includes("gpt-5.6-sol"),
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (e) => e.includes("missing effort") && e.includes("high"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pure coercion — structural rejection, hand-built documents
// ---------------------------------------------------------------------------

describe("coerceProviderEquivalenceConfig", () => {
  function validDoc(): Record<string, unknown> {
    return {
      schema_version: 1,
      mappings: {
        claude_to_gpt: [
          {
            source: { model: "opus", effort: "low" },
            target: { model: "gpt-5.6-sol", effort: "low" },
          },
        ],
        gpt_to_claude: [
          {
            source: { model: "gpt-5.6-sol", effort: "low" },
            target: { model: "opus", effort: "low" },
          },
        ],
      },
    };
  }

  test("a well-formed minimal document coerces", () => {
    const config = coerceProviderEquivalenceConfig(validDoc());
    expect(config.schema_version).toBe(1);
    expect(config.mappings.claude_to_gpt).toHaveLength(1);
    expect(config.mappings.gpt_to_claude).toHaveLength(1);
  });

  test("an unknown top-level key rejects", () => {
    const doc = { ...validDoc(), bogus: true };
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "unknown key 'bogus'",
    );
  });

  test("schema_version must be exactly 1", () => {
    const doc = { ...validDoc(), schema_version: 2 };
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "schema_version",
    );
  });

  test("an unknown mappings key rejects", () => {
    const doc = validDoc();
    (doc.mappings as Record<string, unknown>).codex_to_gemini = [];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "unknown key 'codex_to_gemini'",
    );
  });

  test("a direction that is not a list rejects", () => {
    const doc = validDoc();
    (doc.mappings as Record<string, unknown>).claude_to_gpt = {
      opus: "low",
    };
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "must be a list",
    );
  });

  test("an entry with an unknown key rejects", () => {
    const doc = validDoc();
    (doc.mappings as { claude_to_gpt: unknown[] }).claude_to_gpt = [
      {
        source: { model: "opus", effort: "low" },
        target: { model: "gpt-5.6-sol", effort: "low" },
        note: "not allowed",
      },
    ];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "unknown key 'note'",
    );
  });

  test("an entry missing target rejects", () => {
    const doc = validDoc();
    (doc.mappings as { claude_to_gpt: unknown[] }).claude_to_gpt = [
      { source: { model: "opus", effort: "low" } },
    ];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      ".target is required",
    );
  });

  test("a cell with an unknown key rejects", () => {
    const doc = validDoc();
    (doc.mappings as { claude_to_gpt: unknown[] }).claude_to_gpt = [
      {
        source: { model: "opus", effort: "low", extra: 1 },
        target: { model: "gpt-5.6-sol", effort: "low" },
      },
    ];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "unknown key 'extra'",
    );
  });

  test("a non-canonical effort rejects, naming the vocabulary", () => {
    const doc = validDoc();
    (doc.mappings as { claude_to_gpt: unknown[] }).claude_to_gpt = [
      {
        source: { model: "opus", effort: "ultra" },
        target: { model: "gpt-5.6-sol", effort: "low" },
      },
    ];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      "not in the canonical effort vocabulary",
    );
  });

  test("a malformed model token rejects", () => {
    const doc = validDoc();
    (doc.mappings as { claude_to_gpt: unknown[] }).claude_to_gpt = [
      {
        source: { model: "Opus!", effort: "low" },
        target: { model: "gpt-5.6-sol", effort: "low" },
      },
    ];
    expect(() => coerceProviderEquivalenceConfig(doc)).toThrow(
      ".model must be a valid token",
    );
  });

  test("errors are typed ProviderEquivalenceConfigError instances", () => {
    let caught: unknown;
    try {
      coerceProviderEquivalenceConfig({ ...validDoc(), bogus: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderEquivalenceConfigError);
  });
});

// ---------------------------------------------------------------------------
// pure check core — one hand-built independent input per violation category
// ---------------------------------------------------------------------------

/** Build a minimal, otherwise-total two-model config (one source per
 * direction, full five-effort coverage) so a single test can override just
 * the entries under scrutiny. */
function totalConfig(): ProviderEquivalenceConfig {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const claudeToGpt: EquivalenceEntry[] = efforts.map((effort) => ({
    source: { model: "opus", effort },
    target: { model: "gpt-5.6-sol", effort },
  }));
  const gptToClaude: EquivalenceEntry[] = efforts.map((effort) => ({
    source: { model: "gpt-5.6-sol", effort },
    target: { model: "opus", effort },
  }));
  return {
    schema_version: 1,
    mappings: {
      claude_to_gpt: claudeToGpt,
      gpt_to_claude: gptToClaude,
    },
  };
}

describe("checkProviderEquivalence", () => {
  test("a total, well-formed two-model map passes", () => {
    expect(checkProviderEquivalence(totalConfig())).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("a same-family target fails, naming the direction and target model", () => {
    const config = totalConfig();
    const bad: EquivalenceEntry[] = [
      ...config.mappings.claude_to_gpt.slice(0, 4),
      // opus's `max` entry targets a model that is ALSO a claude_to_gpt
      // source model (opus itself) — same-family.
      {
        source: { model: "opus", effort: "max" },
        target: { model: "opus", effort: "max" },
      },
    ];
    const result = checkProviderEquivalence({
      ...config,
      mappings: { ...config.mappings, claude_to_gpt: bad },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("claude_to_gpt") &&
          e.includes("same-family") &&
          e.includes("opus"),
      ),
    ).toBe(true);
  });

  test("a dangling cross-direction target fails, naming the opposite direction", () => {
    const config = totalConfig();
    const bad: EquivalenceEntry[] = [
      ...config.mappings.claude_to_gpt.slice(0, 4),
      // gpt-9000 is never a gpt_to_claude source model — dangling.
      {
        source: { model: "opus", effort: "max" },
        target: { model: "gpt-9000", effort: "max" },
      },
    ];
    const result = checkProviderEquivalence({
      ...config,
      mappings: { ...config.mappings, claude_to_gpt: bad },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("claude_to_gpt") &&
          e.includes("dangling cross-direction target") &&
          e.includes("gpt-9000") &&
          e.includes("gpt_to_claude"),
      ),
    ).toBe(true);
  });

  test("a duplicate source cell fails, naming the model and effort", () => {
    const config = totalConfig();
    const bad: EquivalenceEntry[] = [
      ...config.mappings.claude_to_gpt,
      // A second entry for the same {opus, low} source cell.
      {
        source: { model: "opus", effort: "low" },
        target: { model: "gpt-5.6-sol", effort: "medium" },
      },
    ];
    const result = checkProviderEquivalence({
      ...config,
      mappings: { ...config.mappings, claude_to_gpt: bad },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("claude_to_gpt") &&
          e.includes("duplicate source cell") &&
          e.includes("opus") &&
          e.includes("low"),
      ),
    ).toBe(true);
  });

  test("a model missing a canonical effort fails, naming the model and the missing effort", () => {
    const config = totalConfig();
    const bad = config.mappings.claude_to_gpt.filter(
      (e) => e.source.effort !== "xhigh",
    );
    const result = checkProviderEquivalence({
      ...config,
      mappings: { ...config.mappings, claude_to_gpt: bad },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("claude_to_gpt") &&
          e.includes("missing effort") &&
          e.includes("opus") &&
          e.includes("xhigh"),
      ),
    ).toBe(true);
  });

  test("multiple violations accumulate rather than short-circuiting", () => {
    const config = totalConfig();
    const bad: EquivalenceEntry[] = [
      ...config.mappings.claude_to_gpt.filter((e) => e.source.effort !== "max"),
      {
        source: { model: "opus", effort: "low" },
        target: { model: "opus", effort: "low" },
      },
    ];
    const result = checkProviderEquivalence({
      ...config,
      mappings: { ...config.mappings, claude_to_gpt: bad },
    });
    expect(result.ok).toBe(false);
    // Same-family (target "opus"), duplicate ({opus, low} now appears twice),
    // and missing-effort ("max" never appears) all present at once.
    expect(result.errors.some((e) => e.includes("same-family"))).toBe(true);
    expect(result.errors.some((e) => e.includes("duplicate source cell"))).toBe(
      true,
    );
    expect(
      result.errors.some(
        (e) => e.includes("missing effort") && e.includes("max"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pure state classifier — totality + target validity against a hand-built
// live matrix mock (never the real host, never re-derived from the map).
// ---------------------------------------------------------------------------

function fakeMatrix(opts: {
  models: string[];
  native: Set<string>;
  efforts?: string[];
  effortsByModel?: Record<string, string[]>;
}): EffectiveMatrix {
  const efforts = opts.efforts ?? ["low", "medium", "high", "xhigh", "max"];
  return {
    efforts,
    models: opts.models,
    subagents: ["template/agents/worker.md.tmpl"],
    wrapper_driver: { model: "sonnet", effort: "high" },
    driverFor: (model: string): Driver =>
      opts.native.has(model) ? "native" : "wrapped",
    effortsFor: (model: string): readonly string[] =>
      opts.effortsByModel?.[model] ?? efforts,
  };
}

describe("classifyProviderEquivalence", () => {
  test("a total map against a matrix matching its own roster reports no gap and no dangling target", () => {
    const config = totalConfig();
    const matrix = fakeMatrix({
      models: ["opus", "gpt-5.6-sol"],
      native: new Set(["opus"]),
    });
    const state = classifyProviderEquivalence(config, matrix);
    expect(state).toEqual({ total: true, gaps: [], dangling_targets: [] });
  });

  test("a new gpt-family model absent from the map is a gap in the gpt_to_claude direction", () => {
    const config = totalConfig();
    const matrix = fakeMatrix({
      models: ["opus", "gpt-5.6-sol", "gpt-9000"],
      native: new Set(["opus"]),
    });
    const state = classifyProviderEquivalence(config, matrix);
    expect(state.total).toBe(false);
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(state.gaps).toContainEqual({
        direction: "gpt_to_claude",
        model: "gpt-9000",
        effort,
      });
    }
    // opus and gpt-5.6-sol are still fully covered — no gap for them.
    expect(state.gaps.some((g) => g.model === "opus")).toBe(false);
    expect(state.gaps.some((g) => g.model === "gpt-5.6-sol")).toBe(false);
  });

  test("a new claude-family (native) model absent from the map is a gap in the claude_to_gpt direction", () => {
    const config = totalConfig();
    const matrix = fakeMatrix({
      models: ["opus", "sonnet", "gpt-5.6-sol"],
      native: new Set(["opus", "sonnet"]),
    });
    const state = classifyProviderEquivalence(config, matrix);
    expect(state.total).toBe(false);
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(state.gaps).toContainEqual({
        direction: "claude_to_gpt",
        model: "sonnet",
        effort,
      });
    }
  });

  test("a mapping target whose model is absent from the live matrix is a dangling target (target-not-on-host)", () => {
    const config = totalConfig();
    // gpt-5.6-sol (the map's target) is missing from the live roster.
    const matrix = fakeMatrix({
      models: ["opus"],
      native: new Set(["opus"]),
    });
    const state = classifyProviderEquivalence(config, matrix);
    expect(state.total).toBe(false);
    expect(
      state.dangling_targets.some(
        (d) =>
          d.reason === "target-not-on-host" && d.target.model === "gpt-5.6-sol",
      ),
    ).toBe(true);
  });

  test("a mapping target whose effort is absent from the live matrix's per-model efforts is a dangling target (target-effort-not-on-host)", () => {
    const config = totalConfig();
    const matrix = fakeMatrix({
      models: ["opus", "gpt-5.6-sol"],
      native: new Set(["opus"]),
      effortsByModel: {
        opus: ["low", "medium", "high", "xhigh", "max"],
        // gpt-5.6-sol's live roster narrows to a single effort.
        "gpt-5.6-sol": ["low"],
      },
    });
    const state = classifyProviderEquivalence(config, matrix);
    expect(state.total).toBe(false);
    const dangling = state.dangling_targets.filter(
      (d) => d.reason === "target-effort-not-on-host",
    );
    expect(dangling.length).toBe(4); // medium/high/xhigh/max targets dangle
    expect(dangling.every((d) => d.target.model === "gpt-5.6-sol")).toBe(true);
  });

  test("an empty map against an empty matrix is trivially total", () => {
    const config: ProviderEquivalenceConfig = {
      schema_version: 1,
      mappings: { claude_to_gpt: [], gpt_to_claude: [] },
    };
    const matrix = fakeMatrix({ models: [], native: new Set() });
    expect(classifyProviderEquivalence(config, matrix)).toEqual({
      total: true,
      gaps: [],
      dangling_targets: [],
    });
  });
});
