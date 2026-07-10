// Drift gate for the selector policy config (../model-selector.yaml), asserted
// in the fast tier as pure disk reads — no subprocess, daemon, or git. Pins the
// on-disk config against the required host matrix axes (both directions) and
// against the model-guidance skill's references/ cache (hash parity), then
// drives the coverage + research-hash failure modes through the pure check core
// with hand-built inputs whose expected outcomes are independent of the config
// under test.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  unionEfforts,
} from "../scripts/model-guidance-check.ts";
import { effectiveMatrix } from "../src/host_matrix.ts";

const PLAN_ROOT = resolve(import.meta.dir, "..");

// A committed claude-only v2 host matrix seeded into a scratch KEEPER_CONFIG_DIR so
// `--state` (which reads the required host matrix axes) resolves opus + sonnet
// without touching the live ~/.config/keeper.
const CLAUDE_ONLY_MATRIX = readFileSync(
  join(PLAN_ROOT, "test", "fixtures", "matrix-claude-only.yaml"),
  "utf-8",
);
const stateCfgDirs: string[] = [];
afterAll(() => {
  for (const d of stateCfgDirs) rmSync(d, { recursive: true, force: true });
});
function withClaudeOnlyMatrix<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "mgs-cfg-"));
  stateCfgDirs.push(dir);
  writeFileSync(join(dir, "matrix.yaml"), CLAUDE_ONLY_MATRIX);
  const prev = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KEEPER_CONFIG_DIR;
    else process.env.KEEPER_CONFIG_DIR = prev;
  }
}

// ---------------------------------------------------------------------------
// on-disk config ↔ live axes + references cache
// ---------------------------------------------------------------------------

describe("on-disk selector config", () => {
  test("passes the host-blind integrity gate (structural + research-hash parity)", () => {
    // No axis read — the gate is green with no host matrix present.
    const result = checkModelGuidanceFromDisk(PLAN_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("is readable off disk with no compile step and carries selector + usage + a block per axis value", () => {
    const matrix = effectiveMatrix();
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

  test("state mode classifies every model fresh and every effort present", () => {
    // --state reads its axes from the required v2 host matrix; pin a claude-only
    // roster so the classification is deterministic.
    const state = withClaudeOnlyMatrix(() =>
      classifyModelGuidanceFromDisk(PLAN_ROOT),
    );
    // The committed tree is all-fresh INCLUDING card parity: each axis model has a
    // present, hash-matching vendor card, so reasons is empty.
    for (const model of ["opus", "sonnet"]) {
      expect(state.models[model].state).toBe("fresh");
      expect(state.models[model].hash_parity).toBe(true);
      expect(state.models[model].card_present).toBe(true);
      expect(state.models[model].card_hash_parity).toBe(true);
      expect(state.models[model].reasons).toEqual([]);
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
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
// A distinct card path for the opus notes entry (a research entry's optional
// vendor system-card cache, hashed like the notes reference).
const CARD_REF = "skills/model-guidance/references/cards/opus.md";
// A distinct reference path for a tolerated host-roster extra (a research entry
// whose key is not a configured axis model).
const EXTRA_REF = "skills/model-guidance/references/gpt-5.5.md";

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

  test("effort coverage is checked over the union of scopes (no scope's token slips past)", () => {
    // The guidance gate's effort axis is the UNION across the config's effort
    // scopes. Feed a multi-scope union and a config missing one scope's token: the
    // missing token is flagged even though another scope carries it.
    const input = baseInput();
    const efforts = unionEfforts([
      ["medium", "high"],
      ["high", "xhigh"],
      ["max"],
    ]);
    // First-appearance order, deduped across scopes.
    expect(efforts).toEqual(["medium", "high", "xhigh", "max"]);
    const result = checkModelGuidance({
      ...input,
      efforts,
      config: {
        ...input.config,
        // A block for every union token EXCEPT `xhigh`.
        efforts: { medium: "m", high: "h", max: "M" },
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("efforts") && e.includes("xhigh")),
    ).toBe(true);
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

  test("a tolerated research entry for a non-configured model with a matching hash passes", () => {
    // Host-roster extra: a research entry keyed on a capability model absent from
    // the embedded axis is tolerated (mirroring the extra-guidance-block
    // tolerance) as long as its reference exists and hash-matches — the gate stays
    // host-blind, so a matrix that adds gpt-5.5 does not fail the fast suite.
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        research: {
          ...input.config.research,
          "gpt-5.5": { reference: EXTRA_REF, sha256: HASH },
        },
      },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("a tolerated research entry whose recorded hash diverges from its file fails", () => {
    // The tolerance is only for the non-configured KEY; every entry's reference
    // must still hash-match, so a divergent extra fails loud rather than passing.
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        research: {
          ...input.config.research,
          "gpt-5.5": { reference: EXTRA_REF, sha256: OTHER_HASH },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("gpt-5.5") && e.includes("does not match"),
      ),
    ).toBe(true);
  });

  test("a tolerated research entry whose reference file is missing fails", () => {
    // A typo'd or dangling extra entry self-reveals as a missing reference file
    // rather than silently passing — the skip-continue is gone. The opus entry
    // still hash-matches (only the extra ref resolves to null).
    const input = baseInput();
    const result = checkModelGuidance({
      ...input,
      config: {
        ...input.config,
        research: {
          ...input.config.research,
          "gpt-5.5": { reference: EXTRA_REF, sha256: HASH },
        },
      },
      referenceHash: (ref) => (ref === REF ? HASH : null),
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("gpt-5.5") && e.includes("missing on disk"),
      ),
    ).toBe(true);
  });

  // A research entry carrying a declared `card` sub-mapping — the card is hashed
  // exactly like the notes reference. Independent hashes authored above.
  function withCard(sha256: string): GuidanceCheckInput {
    const input = baseInput();
    return {
      ...input,
      config: {
        ...input.config,
        research: {
          opus: {
            reference: REF,
            sha256: HASH,
            card: { reference: CARD_REF, sha256 },
          },
        },
      },
    };
  }

  test("a research entry with no card key skips card hashing (cards optional)", () => {
    // baseInput declares no card — only the notes reference is hashed.
    expect(checkModelGuidance(baseInput())).toEqual({ ok: true, errors: [] });
  });

  test("a declared card present with a matching hash passes", () => {
    // Both notes and card resolve to HASH; the card pin equals HASH too.
    expect(checkModelGuidance(withCard(HASH))).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("a declared card whose file is missing fails --check", () => {
    const result = checkModelGuidance({
      ...withCard(HASH),
      referenceHash: (ref) => (ref === REF ? HASH : null),
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("opus") &&
          e.includes("card") &&
          e.includes("missing on disk"),
      ),
    ).toBe(true);
  });

  test("a declared card whose recorded hash diverges from its file fails --check", () => {
    // Notes hash-match (HASH) but the card pin is OTHER_HASH while the file hashes
    // to HASH — the card mismatch is flagged, the notes are not.
    const result = checkModelGuidance(withCard(OTHER_HASH));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("opus") &&
          e.includes("card") &&
          e.includes("does not match"),
      ),
    ).toBe(true);
    // The notes reference (matching) produces no error.
    expect(
      result.errors.some(
        (e) => e.includes("does not match") && !e.includes("card"),
      ),
    ).toBe(false);
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
// The opus notes entry's vendor card: a distinct path, an independent hash, and a
// plain markdown body (the gate never parses card headers, so any body works).
const STATE_CARD_REF = "skills/model-guidance/references/cards/opus.md";
const STATE_CARD_HASH = "e".repeat(64);
const STATE_CARD_OTHER_HASH = "f".repeat(64);
const STATE_CARD_TEXT = "# Model card — `opus`\n\nCard body, never parsed.\n";

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
      research: {
        opus: {
          reference: STATE_REF,
          sha256: STATE_HASH,
          card: { reference: STATE_CARD_REF, sha256: STATE_CARD_HASH },
        },
      },
      efforts_provenance: { status: "researched", last_reviewed: "2026-07-06" },
    },
    // Path-dispatching resolvers: the notes and card carry independent text and
    // hashes so a lattice case can drift one without the other.
    referenceText: (ref) =>
      ref === STATE_REF
        ? RESEARCHED_REF
        : ref === STATE_CARD_REF
          ? STATE_CARD_TEXT
          : null,
    referenceHash: (ref) =>
      ref === STATE_REF
        ? STATE_HASH
        : ref === STATE_CARD_REF
          ? STATE_CARD_HASH
          : null,
  };
}

describe("model-guidance state core", () => {
  test("researched notes with both hash parities and a present card is fresh, emitting the parsed facts and empty reasons", () => {
    const result = classifyModelGuidance(baseStateInput());
    expect(result.models.opus).toEqual({
      state: "fresh",
      hash_parity: true,
      card_present: true,
      card_hash_parity: true,
      reasons: [],
      status: "researched",
      researched: "2026-07-04",
      resolves_to: "claude-opus-4-8",
    });
  });

  test("researched notes with a drifted notes hash is stale, never fresh, reasons [notes-hash-drift]", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      // Only the notes hash drifts; the card path still resolves + matches.
      referenceHash: (ref) =>
        ref === STATE_CARD_REF ? STATE_CARD_HASH : STATE_OTHER_HASH,
    });
    expect(result.models.opus.state).toBe("stale");
    expect(result.models.opus.hash_parity).toBe(false);
    expect(result.models.opus.reasons).toEqual(["notes-hash-drift"]);
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
      research: {
        opus: {
          reference: STATE_REF,
          sha256: STATE_HASH,
          card: { reference: STATE_CARD_REF, sha256: STATE_HASH },
        },
      },
    };
    const result = classifyModelGuidance({
      efforts: ["medium", "high"],
      models: ["opus"],
      config,
      referenceText: () => RESEARCHED_REF,
      // A uniform resolver: notes and card both hash to STATE_HASH, matching both
      // pins, so opus is fresh while the efforts provenance defaults to stub.
      referenceHash: () => STATE_HASH,
    });
    expect(result.efforts_provenance).toEqual({
      status: "stub",
      last_reviewed: null,
    });
    expect(result.models.opus.state).toBe("fresh");
    expect(result.efforts.medium.state).toBe("present");
  });

  test("researched notes with parity but NO card declared is missing (backfill), reasons [no-card]", () => {
    const input = baseStateInput();
    const result = classifyModelGuidance({
      ...input,
      config: {
        ...input.config,
        research: { opus: { reference: STATE_REF, sha256: STATE_HASH } }, // no card key
      },
    });
    expect(result.models.opus.state).toBe("missing");
    expect(result.models.opus.card_present).toBe(false);
    expect(result.models.opus.card_hash_parity).toBeNull();
    expect(result.models.opus.reasons).toEqual(["no-card"]);
    // The notes themselves are fresh — the card is the only gap.
    expect(result.models.opus.hash_parity).toBe(true);
    expect(result.models.opus.status).toBe("researched");
  });

  test("researched notes with parity but a declared card whose file is absent is missing, reasons [no-card]", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      // The card path resolves to null (file missing); the notes still match.
      referenceHash: (ref) => (ref === STATE_REF ? STATE_HASH : null),
    });
    expect(result.models.opus.state).toBe("missing");
    expect(result.models.opus.card_present).toBe(false);
    expect(result.models.opus.card_hash_parity).toBeNull();
    expect(result.models.opus.reasons).toEqual(["no-card"]);
  });

  test("researched notes with parity but a drifted card hash is stale, reasons [card-hash-drift]", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      // The card file is present but hashes to a value the pin does not match.
      referenceHash: (ref) =>
        ref === STATE_REF ? STATE_HASH : STATE_CARD_OTHER_HASH,
    });
    expect(result.models.opus.state).toBe("stale");
    expect(result.models.opus.card_present).toBe(true);
    expect(result.models.opus.card_hash_parity).toBe(false);
    expect(result.models.opus.reasons).toEqual(["card-hash-drift"]);
  });

  test("a never-researched model stays stub regardless of a present, matching card", () => {
    const result = classifyModelGuidance({
      ...baseStateInput(),
      referenceText: (ref) => (ref === STATE_REF ? STUB_REF : STATE_CARD_TEXT),
    });
    expect(result.models.opus.state).toBe("stub");
    // Card irrelevant: it is present and matches, but contributes no reason.
    expect(result.models.opus.reasons).toEqual(["notes-not-researched"]);
  });

  test("a model absent from both the blocks and the research map lists every structural reason", () => {
    const input = baseStateInput();
    const result = classifyModelGuidance({
      ...input,
      config: { ...input.config, models: {}, research: {} },
    });
    expect(result.models.opus.state).toBe("missing");
    expect(result.models.opus.reasons).toEqual([
      "no-block",
      "no-research-entry",
    ]);
    expect(result.models.opus.card_present).toBe(false);
    expect(result.models.opus.card_hash_parity).toBeNull();
  });

  test("every entry carries card_present, card_hash_parity, and reasons — reasons empty iff fresh — and no fixture throws", () => {
    // Drive one input per lattice row through the classifier and assert the
    // envelope shape holds and reasons is empty exactly when fresh. Expected
    // freshness is authored here, independent of the classifier.
    const base = baseStateInput();
    const noCardResearch = {
      opus: { reference: STATE_REF, sha256: STATE_HASH },
    };
    const cases: Array<{ input: GuidanceStateInput; fresh: boolean }> = [
      { input: base, fresh: true },
      { input: { ...base, referenceText: () => STUB_REF }, fresh: false },
      {
        input: {
          ...base,
          referenceHash: (ref: string) =>
            ref === STATE_CARD_REF ? STATE_CARD_HASH : STATE_OTHER_HASH,
        },
        fresh: false,
      },
      {
        input: {
          ...base,
          config: { ...base.config, research: noCardResearch },
        },
        fresh: false,
      },
      {
        input: {
          ...base,
          referenceHash: (ref: string) =>
            ref === STATE_REF ? STATE_HASH : STATE_CARD_OTHER_HASH,
        },
        fresh: false,
      },
      {
        input: {
          ...base,
          config: { ...base.config, models: {}, research: {} },
        },
        fresh: false,
      },
      { input: { ...base, referenceText: () => null }, fresh: false },
    ];
    for (const { input, fresh } of cases) {
      const entry = classifyModelGuidance(input).models.opus;
      expect(typeof entry.card_present).toBe("boolean");
      expect(
        entry.card_hash_parity === null ||
          typeof entry.card_hash_parity === "boolean",
      ).toBe(true);
      expect(Array.isArray(entry.reasons)).toBe(true);
      expect(entry.reasons.length === 0).toBe(fresh);
      expect(entry.state === "fresh").toBe(fresh);
    }
  });
});

// ---------------------------------------------------------------------------
// card coercion — the optional research.<model>.card sub-mapping. A hand-built
// document (independent of the on-disk config) drives each coercion outcome.
// ---------------------------------------------------------------------------

const NOTES_PATH = "skills/model-guidance/references/opus.md";
const CARD_PATH = "skills/model-guidance/references/cards/opus.md";
function docWithResearch(
  researchOpus: Record<string, unknown>,
): Record<string, unknown> {
  return {
    selector: { harness: "claude", model: "opus" },
    usage: "u",
    hand_tuned: "burden of proof on opus; sonnet by default",
    efforts: { low: "l" },
    models: { opus: "o" },
    research: { opus: researchOpus },
  };
}

describe("research card coercion", () => {
  test("a research entry with no card key loads with card undefined", () => {
    const config = coerceModelSelectorConfig(
      docWithResearch({ reference: NOTES_PATH, sha256: "a".repeat(64) }),
    );
    expect(config.research.opus.card).toBeUndefined();
  });

  test("a full card mapping loads verbatim", () => {
    const config = coerceModelSelectorConfig(
      docWithResearch({
        reference: NOTES_PATH,
        sha256: "a".repeat(64),
        card: { reference: CARD_PATH, sha256: "b".repeat(64) },
      }),
    );
    expect(config.research.opus.card).toEqual({
      reference: CARD_PATH,
      sha256: "b".repeat(64),
    });
  });

  test("a partial card mapping (missing sha256) fails loud naming the model", () => {
    expect(() =>
      coerceModelSelectorConfig(
        docWithResearch({
          reference: NOTES_PATH,
          sha256: "a".repeat(64),
          card: { reference: CARD_PATH },
        }),
      ),
    ).toThrow("research.opus.card.sha256");
  });

  test("a non-mapping card fails loud naming the model", () => {
    expect(() =>
      coerceModelSelectorConfig(
        docWithResearch({
          reference: NOTES_PATH,
          sha256: "a".repeat(64),
          card: "not a mapping",
        }),
      ),
    ).toThrow("research.opus.card");
  });

  test("a card reference equal to the notes reference is rejected loud (copy-paste guard)", () => {
    expect(() =>
      coerceModelSelectorConfig(
        docWithResearch({
          reference: NOTES_PATH,
          sha256: "a".repeat(64),
          card: { reference: NOTES_PATH, sha256: "b".repeat(64) },
        }),
      ),
    ).toThrow("copy-paste guard");
  });
});
