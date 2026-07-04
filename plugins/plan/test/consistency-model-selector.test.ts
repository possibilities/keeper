// Drift gate for the selector policy config (../model-selector.yaml), asserted
// in the fast tier as pure disk reads — no subprocess, daemon, or git. Pins the
// on-disk config against the subagents.yaml axes (both directions) and against
// the model-guidance skill's references/ cache (hash parity), then drives the
// four failure modes through the pure check core with hand-built inputs whose
// expected outcomes are independent of the config under test.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  checkModelGuidance,
  checkModelGuidanceFromDisk,
  type GuidanceCheckInput,
  loadModelSelectorConfig,
} from "../scripts/model-guidance-check.ts";
import { loadSubagentsMatrixFromDisk } from "../src/subagents_config.ts";

const PLAN_ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// on-disk config ↔ live axes + references cache
// ---------------------------------------------------------------------------

describe("on-disk selector config", () => {
  test("passes the drift gate (coverage both directions + hash parity)", () => {
    const result = checkModelGuidanceFromDisk(PLAN_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("is readable off disk with no compile step and carries selector + usage + a block per axis value", () => {
    const matrix = loadSubagentsMatrixFromDisk(
      join(PLAN_ROOT, "subagents.yaml"),
    );
    const config = loadModelSelectorConfig(
      join(PLAN_ROOT, "model-selector.yaml"),
    );
    expect(config.selector.harness.length).toBeGreaterThan(0);
    expect(config.selector.model.length).toBeGreaterThan(0);
    expect(config.usage.length).toBeGreaterThan(0);
    for (const effort of matrix.efforts) {
      expect((config.efforts[effort] ?? "").length).toBeGreaterThan(0);
    }
    for (const model of matrix.models) {
      expect((config.models[model] ?? "").length).toBeGreaterThan(0);
      expect(config.research[model]).toBeDefined();
    }
  });

  test("subagents.yaml header cross-references model-selector.yaml", () => {
    const text = readFileSync(join(PLAN_ROOT, "subagents.yaml"), "utf-8");
    expect(text).toContain("model-selector.yaml");
  });
});

// ---------------------------------------------------------------------------
// pure check core — failure modes driven by hand-built independent inputs
// ---------------------------------------------------------------------------

// Independent source of truth: a hand-authored 64-char hex hash and a fully
// covered config over the axes [medium, high, xhigh, max] × [opus]. Expectations
// below are asserted against these constants, never re-derived from the config.
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const REF = "skills/model-guidance/references/opus.md";

function baseInput(): GuidanceCheckInput {
  return {
    efforts: ["medium", "high", "xhigh", "max"],
    models: ["opus"],
    config: {
      selector: { harness: "claude", model: "opus" },
      usage: "weigh model then effort",
      efforts: { medium: "m", high: "h", xhigh: "x", max: "M" },
      models: { opus: "o" },
      research: { opus: { reference: REF, sha256: HASH } },
    },
    referenceHash: () => HASH,
  };
}

describe("model-guidance check core", () => {
  test("a fully-covered config with matching hashes passes", () => {
    expect(checkModelGuidance(baseInput())).toEqual({ ok: true, errors: [] });
  });

  test("a missing effort guidance block fails coverage", () => {
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        efforts: { medium: "m", high: "h", xhigh: "x" }, // no `max`
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("efforts") && e.includes("max")),
    ).toBe(true);
  });

  test("a guidance block for a non-axis value fails coverage", () => {
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        efforts: { ...input.config.efforts, ultra: "?" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ultra"))).toBe(true);
  });

  test("a configured model with no guidance block fails coverage", () => {
    const input = baseInput();
    const result = checkModelGuidance({ ...input, models: ["opus", "sonnet"] });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("models") && e.includes("sonnet")),
    ).toBe(true);
  });

  test("a configured model with no research entry fails", () => {
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: { ...input.config, research: {} },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("research") && e.includes("opus")),
    ).toBe(true);
  });

  test("a research entry whose recorded hash differs from the file fails", () => {
    const result = checkModelGuidance({
      ...baseInput(),
      referenceHash: () => OTHER_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match"))).toBe(true);
  });

  test("a research entry whose reference file is missing fails", () => {
    const result = checkModelGuidance({
      ...baseInput(),
      referenceHash: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("missing on disk"))).toBe(true);
  });

  test("a research entry for a non-model fails", () => {
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        research: {
          ...input.config.research,
          ghost: { reference: "x", sha256: HASH },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
  });
});
