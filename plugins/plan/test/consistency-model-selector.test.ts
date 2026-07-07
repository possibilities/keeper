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
  classifyModelGuidance,
  classifyModelGuidanceFromDisk,
  coerceModelSelectorConfig,
  type GuidanceCheckInput,
  type GuidanceStateInput,
  loadModelSelectorConfig,
  type ModelSelectorConfig,
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

  test("no guidance prose carries cost or provider language (capability-shaped only)", () => {
    const config = loadModelSelectorConfig(
      join(PLAN_ROOT, "model-selector.yaml"),
    );
    // Content-blind selector guidance must stay capability-shaped: cost and
    // provider ordering live in the host matrix, never in the usage rule, the
    // hand_tuned policy, or any efforts/models guidance block.
    const forbidden = [
      "cost",
      "cheap",
      "expensive",
      "price",
      "provider",
      "codex",
      "claude",
      "harness",
      "subscription",
      "pecking",
    ];
    const blocks = [
      config.usage,
      config.hand_tuned,
      ...Object.values(config.efforts),
      ...Object.values(config.models),
    ];
    for (const block of blocks) {
      expect(block.length).toBeGreaterThan(0);
      const lower = block.toLowerCase();
      for (const word of forbidden) {
        expect(lower).not.toContain(word);
      }
    }
  });

  test("carries a hand_tuned section retained verbatim through coercion", () => {
    const config = loadModelSelectorConfig(
      join(PLAN_ROOT, "model-selector.yaml"),
    );
    expect(config.hand_tuned.length).toBeGreaterThan(0);
    const lower = config.hand_tuned.toLowerCase();
    expect(lower).toContain("burden of proof");
    expect(lower).toContain("sonnet");
    expect(lower).toContain("opus");
    expect(lower).toContain("anti-anchor");
  });

  test("no route-up / keep-opus default phrasing remains, and both config and agent prompt carry the sonnet-first burden-of-proof + anti-anchor rule", () => {
    const config = loadModelSelectorConfig(
      join(PLAN_ROOT, "model-selector.yaml"),
    );
    const agentPrompt = readFileSync(
      join(PLAN_ROOT, "agents/model-selector.md"),
      "utf-8",
    );
    // Grep-level: the inverted policy leaves no default-up escape hatch in either
    // the config guidance prose or the selector agent prompt.
    const forbiddenPhrases = [
      "pick up",
      "keep opus",
      "route up",
      "when in doubt",
    ];
    const configProse = [
      config.usage,
      config.hand_tuned,
      ...Object.values(config.efforts),
      ...Object.values(config.models),
    ]
      .join("\n")
      .toLowerCase();
    const agentLower = agentPrompt.toLowerCase();
    for (const phrase of forbiddenPhrases) {
      expect(configProse).not.toContain(phrase);
      expect(agentLower).not.toContain(phrase);
    }
    // Positive: both surfaces state the sonnet-first burden-of-proof rule and the
    // anti-anchor clause (spec length/adjectives are not difficulty).
    expect(config.hand_tuned.toLowerCase()).toContain("burden of proof");
    expect(agentLower).toContain("burden of proof");
    expect(agentLower).toContain("intelligence-bound");
    expect(agentLower).toContain("not difficulty");
  });

  test("subagents.yaml header cross-references model-selector.yaml", () => {
    const text = readFileSync(join(PLAN_ROOT, "subagents.yaml"), "utf-8");
    expect(text).toContain("model-selector.yaml");
  });

  test("state mode classifies every model fresh and every effort present", () => {
    const matrix = loadSubagentsMatrixFromDisk(
      join(PLAN_ROOT, "subagents.yaml"),
    );
    const state = classifyModelGuidanceFromDisk(PLAN_ROOT);
    expect(state.models.opus.state).toBe("fresh");
    expect(state.models.opus.hash_parity).toBe(true);
    expect(state.models.sonnet.state).toBe("fresh");
    expect(state.models.sonnet.hash_parity).toBe(true);
    for (const effort of matrix.efforts) {
      expect(state.efforts[effort].state).toBe("present");
    }
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
      hand_tuned: "burden of proof on opus; sonnet by default",
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

  test("coercion requires hand_tuned — a dropped section fails loud, never silently passes", () => {
    // Independent fixture: a structurally complete config document minus the
    // hand_tuned key. The silent-drop failure mode is exactly a config that
    // parses and passes the gate without carrying the binding policy.
    const doc = {
      selector: { harness: "claude", model: "opus" },
      usage: "u",
      efforts: { low: "l" },
      models: { opus: "o" },
      research: { opus: { reference: "x", sha256: "y" } },
    };
    expect(() => coerceModelSelectorConfig(doc)).toThrow("hand_tuned");
    expect(
      coerceModelSelectorConfig({ ...doc, hand_tuned: "policy text" })
        .hand_tuned,
    ).toBe("policy text");
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

  test("an extra model guidance block beyond the axis is tolerated", () => {
    // A host-provisioned block for a capability model absent from the embedded
    // axis (and without a research entry) must NOT fail the host-blind gate — the
    // runtime selection-brief seam owns effective-matrix coverage.
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        models: { ...input.config.models, "gpt-5.5": "wrapped block" },
      },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("an extra effort guidance block still fails coverage (efforts stay strict)", () => {
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        efforts: { ...input.config.efforts, ultra: "?" },
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("efforts") && e.includes("ultra")),
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

// ---------------------------------------------------------------------------
// state classifier core — fail-closed lattice driven by hand-built independent
// inputs (reference text + hash + expected state all authored here, never
// re-derived from the config or reference file under test).
// ---------------------------------------------------------------------------

const STATE_HASH = "c".repeat(64);
const STATE_OTHER_HASH = "d".repeat(64);
const STATE_REF = "skills/model-guidance/references/opus.md";

// A reference file with the given provenance body inside its first comment
// block. The H1 precedes the block (the parser is not byte-0-anchored) and the
// prose body deliberately contains `status:` / `resolves_to:` bait to prove only
// the first comment block is read, never body text.
function refWith(provenanceBody: string): string {
  return [
    "# Research cache — `opus`",
    "",
    "<!--",
    "provenance:",
    provenanceBody,
    "-->",
    "",
    "This prose body mentions status: researched and resolves_to: wrong as bait",
    "— only the first comment block is trusted, never the body.",
    "",
  ].join("\n");
}

// `researched: 2026-07-04` is a YAML 1.1 timestamp (parses to a Date), so this
// fixture also exercises the Date-typed date field.
const RESEARCHED_REF = refWith(
  "  resolves_to: claude-opus-4-8\n  researched: 2026-07-04\n  status: researched",
);
const STUB_REF = refWith(
  "  resolves_to: claude-opus-4-8\n  researched: 2026-07-04\n  status: stub",
);
// `status: no` is the Norway problem — YAML 1.1 coerces it to a boolean.
const COERCED_STATUS_REF = refWith("  researched: 2026-07-04\n  status: no");
const NO_HEADER_REF =
  "# Research cache — `opus`\n\nNo provenance comment block at all, only prose.\n";
const HEADER_NOT_FIRST_REF = [
  "# Research cache — `opus`",
  "",
  "<!-- editorial note, not provenance -->",
  "",
  "<!--",
  "provenance:",
  "  status: researched",
  "-->",
  "",
].join("\n");

function baseStateInput(): GuidanceStateInput {
  return {
    efforts: ["medium", "high"],
    models: ["opus"],
    config: {
      selector: { harness: "claude", model: "opus" },
      usage: "weigh model then effort",
      hand_tuned: "burden of proof on opus; sonnet by default",
      efforts: { medium: "m", high: "h" },
      models: { opus: "o" },
      research: { opus: { reference: STATE_REF, sha256: STATE_HASH } },
      efforts_provenance: { status: "researched", last_reviewed: "2026-07-06" },
    },
    referenceText: () => RESEARCHED_REF,
    referenceHash: () => STATE_HASH,
  };
}

describe("model-guidance state core", () => {
  test("researched status with hash parity is fresh, emitting the parsed facts", () => {
    const result = classifyModelGuidance(baseStateInput());
    expect(result.models.opus).toEqual({
      state: "fresh",
      hash_parity: true,
      status: "researched",
      researched: "2026-07-04",
      resolves_to: "claude-opus-4-8",
    });
  });

  test("researched status with a drifted hash is stale, never fresh", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceHash: () => STATE_OTHER_HASH,
    });
    expect(result.models.opus.state).toBe("stale");
    expect(result.models.opus.hash_parity).toBe(false);
  });

  test("an explicit stub status is stub even with hash parity", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: () => STUB_REF,
    });
    expect(result.models.opus.state).toBe("stub");
    expect(result.models.opus.status).toBe("stub");
  });

  test("a coerced (non-string) status classifies as stub with a null status fact", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: () => COERCED_STATUS_REF,
    });
    expect(result.models.opus.state).toBe("stub");
    expect(result.models.opus.status).toBeNull();
  });

  test("a reference with no comment block is stub with all-null facts", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: () => NO_HEADER_REF,
    });
    expect(result.models.opus.state).toBe("stub");
    expect(result.models.opus.status).toBeNull();
    expect(result.models.opus.researched).toBeNull();
    expect(result.models.opus.resolves_to).toBeNull();
  });

  test("provenance in a later comment block is ignored — only the first is read", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: () => HEADER_NOT_FIRST_REF,
    });
    expect(result.models.opus.state).toBe("stub");
    expect(result.models.opus.status).toBeNull();
  });

  test("a model with no guidance block is missing", () => {
    const input = baseStateInput();
    const result = classifyModelGuidance({
      ...input,
      config: { ...input.config, models: {} },
    });
    expect(result.models.opus.state).toBe("missing");
  });

  test("a model with no research entry is missing", () => {
    const input = baseStateInput();
    const result = classifyModelGuidance({
      ...input,
      config: { ...input.config, research: {} },
    });
    expect(result.models.opus.state).toBe("missing");
  });

  test("a model whose reference file is absent on disk is missing", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: () => null,
    });
    expect(result.models.opus.state).toBe("missing");
    expect(result.models.opus.hash_parity).toBeNull();
  });

  test("effort values are present when a block exists, missing otherwise", () => {
    const input = baseStateInput();
    const result = classifyModelGuidance({
      ...input,
      efforts: ["medium", "high", "max"], // config has no `max` block
    });
    expect(result.efforts.medium.state).toBe("present");
    expect(result.efforts.high.state).toBe("present");
    expect(result.efforts.max.state).toBe("missing");
  });

  test("the config's efforts provenance stamp passes through", () => {
    const result = classifyModelGuidance(baseStateInput());
    expect(result.efforts_provenance).toEqual({
      status: "researched",
      last_reviewed: "2026-07-06",
    });
  });

  test("a config lacking the efforts provenance key classifies totally, defaulting to stub", () => {
    const config: ModelSelectorConfig = {
      selector: { harness: "claude", model: "opus" },
      usage: "u",
      hand_tuned: "burden of proof on opus; sonnet by default",
      efforts: { medium: "m", high: "h" },
      models: { opus: "o" },
      research: { opus: { reference: STATE_REF, sha256: STATE_HASH } },
    };
    const result = classifyModelGuidance({
      efforts: ["medium", "high"],
      models: ["opus"],
      config,
      referenceText: () => RESEARCHED_REF,
      referenceHash: () => STATE_HASH,
    });
    expect(result.efforts_provenance).toEqual({
      status: "stub",
      last_reviewed: null,
    });
    expect(result.models.opus.state).toBe("fresh");
    expect(result.efforts.medium.state).toBe("present");
  });
});
