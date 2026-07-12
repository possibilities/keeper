/**
 * The launcher-island provider-equivalence loader (`src/provider-equivalence.ts`,
 * ADR 0047) + the pure `applyProviderConstraint` translation in `reconcile-core`.
 * Covered as pure in-process reads: the strict parser, the fail-closed loader, the
 * reduced-map builder, every translation verdict (unchanged / translated / each of
 * the three rejects), and the cross-island parity contract (this parser vs the plan
 * island's must reduce the committed map identically). Expected values are authored
 * INDEPENDENTLY of the code under test — hand-built cells + a hand-built matrix.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { loadProviderEquivalenceConfig as loadPlanIslandConfig } from "../plugins/plan/src/provider_equivalence.ts";
import {
  buildProviderEquivalenceMap,
  coerceProviderEquivalenceConfig,
  loadProviderEquivalenceConfig,
  loadProviderEquivalenceSnapshot,
  type ProviderEquivalenceConfig,
  ProviderEquivalenceConfigError,
} from "../src/provider-equivalence";
import type { HostMatrixAxes } from "../src/reconcile-core";
import { applyProviderConstraint } from "../src/reconcile-core";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMMITTED_MAP = join(
  REPO_ROOT,
  "plugins",
  "plan",
  "provider-equivalence.yaml",
);

/** A small hand-authored map: opus/sonnet (claude family) ↔ gpt-5.6-sol/
 *  gpt-5.6-terra (codex family), each at `high` only, so `opus/low` is a
 *  deliberate no-map-entry gap. */
const CONFIG: ProviderEquivalenceConfig = {
  schema_version: 1,
  mappings: {
    claude_to_codex: [
      {
        source: { model: "opus", effort: "high" },
        target: { model: "gpt-5.6-sol", effort: "high" },
      },
      {
        source: { model: "sonnet", effort: "high" },
        target: { model: "gpt-5.6-terra", effort: "high" },
      },
    ],
    codex_to_claude: [
      {
        source: { model: "gpt-5.6-sol", effort: "high" },
        target: { model: "opus", effort: "high" },
      },
      {
        source: { model: "gpt-5.6-terra", effort: "high" },
        target: { model: "sonnet", effort: "high" },
      },
    ],
  },
};

/** A host matrix carrying all four models at the five canonical efforts. */
const FULL_AXES: HostMatrixAxes = {
  models: ["opus", "sonnet", "gpt-5.6-sol", "gpt-5.6-terra"],
  effortsByModel: new Map(),
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

const OK_MAP = { ok: true as const, map: buildProviderEquivalenceMap(CONFIG) };

describe("provider-equivalence strict parser", () => {
  test("accepts a well-formed config unchanged", () => {
    expect(coerceProviderEquivalenceConfig(CONFIG)).toEqual(CONFIG);
  });

  test("rejects an unknown top-level key", () => {
    expect(() =>
      coerceProviderEquivalenceConfig({ ...CONFIG, bogus: 1 }),
    ).toThrow(ProviderEquivalenceConfigError);
  });

  test("rejects a non-canonical effort", () => {
    expect(() =>
      coerceProviderEquivalenceConfig({
        schema_version: 1,
        mappings: {
          claude_to_codex: [
            {
              source: { model: "opus", effort: "turbo" },
              target: { model: "gpt-5.6-sol", effort: "high" },
            },
          ],
          codex_to_claude: [],
        },
      }),
    ).toThrow(/canonical effort vocabulary/);
  });

  test("rejects a wrong schema_version", () => {
    expect(() =>
      coerceProviderEquivalenceConfig({ ...CONFIG, schema_version: 2 }),
    ).toThrow(/schema_version/);
  });

  test("rejects a direction that is not a list", () => {
    expect(() =>
      coerceProviderEquivalenceConfig({
        schema_version: 1,
        mappings: { claude_to_codex: {}, codex_to_claude: [] },
      }),
    ).toThrow(/must be a list/);
  });
});

describe("loadProviderEquivalenceSnapshot fail-closed", () => {
  test("a present, valid committed map loads ok", () => {
    const snap = loadProviderEquivalenceSnapshot(COMMITTED_MAP);
    expect(snap.ok).toBe(true);
  });

  test("a missing map fails closed (never throws)", () => {
    const snap = loadProviderEquivalenceSnapshot(
      join(REPO_ROOT, "does-not-exist.yaml"),
    );
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.detail).toContain("does-not-exist.yaml");
  });
});

describe("applyProviderConstraint", () => {
  test("pins to codex: a claude-family cell TRANSLATES to its mapped codex cell", () => {
    const r = applyProviderConstraint(
      { model: "opus", effort: "high" },
      "codex",
      OK_MAP,
      FULL_AXES,
    );
    expect(r).toEqual({
      kind: "translated",
      cell: { model: "gpt-5.6-sol", effort: "high" },
    });
  });

  test("pins to claude: a codex-family cell TRANSLATES to its mapped claude cell", () => {
    const r = applyProviderConstraint(
      { model: "gpt-5.6-terra", effort: "high" },
      "claude",
      OK_MAP,
      FULL_AXES,
    );
    expect(r).toEqual({
      kind: "translated",
      cell: { model: "sonnet", effort: "high" },
    });
  });

  test("a cell ALREADY in the pinned family is UNCHANGED (byte-identical)", () => {
    expect(
      applyProviderConstraint(
        { model: "gpt-5.6-sol", effort: "high" },
        "codex",
        OK_MAP,
        FULL_AXES,
      ),
    ).toEqual({ kind: "unchanged" });
    expect(
      applyProviderConstraint(
        { model: "sonnet", effort: "high" },
        "claude",
        OK_MAP,
        FULL_AXES,
      ),
    ).toEqual({ kind: "unchanged" });
  });

  test("no-map-entry: a cross-family cell with no mapping refuses (names cells + direction)", () => {
    const r = applyProviderConstraint(
      { model: "opus", effort: "low" },
      "codex",
      OK_MAP,
      FULL_AXES,
    );
    expect(r).toEqual({
      kind: "reject",
      reason: "no-map-entry",
      provider: "codex",
      direction: "claude_to_codex",
      assigned: { model: "opus", effort: "low" },
      target: null,
    });
  });

  test("target-not-on-host: a mapped target absent from the live matrix refuses", () => {
    // A matrix MISSING gpt-5.6-terra — so translating sonnet/high (claude→codex)
    // resolves a target that is not a dispatchable cell.
    const axesNoTerra: HostMatrixAxes = {
      models: ["opus", "sonnet", "gpt-5.6-sol"],
      effortsByModel: new Map(),
      efforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const r = applyProviderConstraint(
      { model: "sonnet", effort: "high" },
      "codex",
      OK_MAP,
      axesNoTerra,
    );
    expect(r).toEqual({
      kind: "reject",
      reason: "target-not-on-host",
      provider: "codex",
      direction: "claude_to_codex",
      assigned: { model: "sonnet", effort: "high" },
      target: { model: "gpt-5.6-terra", effort: "high" },
    });
  });

  test("target-not-on-host: a mapped target EFFORT absent from the live matrix refuses", () => {
    // gpt-5.6-sol present but its effort list narrowed to exclude `high`.
    const axesNarrow: HostMatrixAxes = {
      models: ["opus", "sonnet", "gpt-5.6-sol", "gpt-5.6-terra"],
      effortsByModel: new Map([["gpt-5.6-sol", ["low", "medium"]]]),
      efforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const r = applyProviderConstraint(
      { model: "opus", effort: "high" },
      "codex",
      OK_MAP,
      axesNarrow,
    );
    expect(r.kind).toBe("reject");
    if (r.kind === "reject") expect(r.reason).toBe("target-not-on-host");
  });

  test("map-malformed: a failed-to-load snapshot refuses per-cell (never a fallback)", () => {
    const r = applyProviderConstraint(
      { model: "opus", effort: "high" },
      "codex",
      { ok: false, detail: "boom" },
      FULL_AXES,
    );
    expect(r).toEqual({
      kind: "reject",
      reason: "map-malformed",
      provider: "codex",
      direction: "claude_to_codex",
      assigned: { model: "opus", effort: "high" },
      target: null,
      detail: "boom",
    });
  });
});

describe("cross-island parser parity", () => {
  test("the launcher island and the plan island reduce the committed map identically", () => {
    const launcher = loadProviderEquivalenceConfig(COMMITTED_MAP);
    const plan = loadPlanIslandConfig(COMMITTED_MAP);
    expect(launcher).toEqual(plan);
  });
});
