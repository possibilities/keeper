// Drift gate for the committed panel roster (../panel-selector.yaml), asserted
// in the fast tier as a pure disk read — no subprocess, daemon, or git. Pins the
// on-disk roster against the structural gate, then drives every enumerated
// policy-violation class through the pure check core with hand-built inputs
// whose expected outcomes are independent of the roster under test.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  checkPanelSelector,
  checkPanelSelectorFromDisk,
  PLAN_ROOT,
} from "../scripts/panel-guidance-check.ts";
import { loadYamlInput } from "../src/yaml_input.ts";

describe("on-disk panel roster", () => {
  test("passes the host-blind structural gate", () => {
    const result = checkPanelSelectorFromDisk(PLAN_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("carries exactly ten panels and a default naming a defined panel", () => {
    const doc = loadYamlInput(join(PLAN_ROOT, "panel-selector.yaml")) as {
      panels: Record<string, unknown>;
      default: string;
    };
    expect(Object.keys(doc.panels)).toHaveLength(10);
    expect(doc.panels[doc.default]).toBeDefined();
    expect(doc.default).toBe("workhorse");
  });

  test("no panel member names haiku, and every effort is high, xhigh, or max", () => {
    const doc = loadYamlInput(join(PLAN_ROOT, "panel-selector.yaml")) as {
      panels: Record<string, { members: string[] }>;
    };
    const allowedEfforts = new Set(["high", "xhigh", "max"]);
    for (const [name, panel] of Object.entries(doc.panels)) {
      for (const member of panel.members) {
        expect(member.toLowerCase()).not.toContain("haiku");
        const segments = member.split("::");
        expect(segments).toHaveLength(3);
        const effort = segments[2];
        expect(allowedEfforts.has(effort)).toBe(true);
      }
      void name;
    }
  });
});

// ---------------------------------------------------------------------------
// pure check core — failure modes driven by hand-built independent inputs
// ---------------------------------------------------------------------------

// Independent source of truth: a hand-authored, fully-covered minimal roster
// carrying exactly 10 panels (one weak, one max, rest standard), each with
// legal members and a 150-900 char description. Expectations below are
// asserted against these constants, never re-derived from the committed file.
const VALID_MEMBER_A = "claude::sonnet::high";
const VALID_MEMBER_B = "codex::gpt-5.6-terra::high";
const VALID_MEMBER_C = "pi::openai-codex/gpt-5.4::xhigh";
// A description sized in-band (150-900 chars) by repetition, independent of
// any prose authored in the committed roster.
const VALID_DESCRIPTION = "x".repeat(200);

function panel(
  strength: string,
  members: unknown = [VALID_MEMBER_A, VALID_MEMBER_B],
  description: unknown = VALID_DESCRIPTION,
): Record<string, unknown> {
  return { strength, members, description };
}

function baseDoc(): Record<string, unknown> {
  const panels: Record<string, unknown> = {
    p1: panel("weak"),
    p2: panel("light"),
    p3: panel("standard"),
    p4: panel("standard"),
    p5: panel("standard"),
    p6: panel("strong"),
    p7: panel("strong"),
    p8: panel("strong"),
    p9: panel("strong"),
    p10: panel("max"),
  };
  return { default: "p1", panels };
}

describe("panel-selector check core", () => {
  test("a fully-covered, policy-satisfying roster passes", () => {
    expect(checkPanelSelector(baseDoc())).toEqual({ ok: true, errors: [] });
  });

  test("a non-mapping document fails loud", () => {
    const result = checkPanelSelector(["not", "a", "mapping"]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["panel-selector config must be a mapping"]);
  });

  test("an extra top-level key fails", () => {
    const doc = { ...baseDoc(), extra: "nope" };
    const result = checkPanelSelector(doc);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("top-level keys must be exactly")),
    ).toBe(true);
  });

  test("a missing top-level key (no default) fails", () => {
    const doc = baseDoc() as { panels: unknown };
    const result = checkPanelSelector({ panels: doc.panels });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("top-level keys must be exactly")),
    ).toBe(true);
  });

  test("panel count off ten fails (9 panels)", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const { p10, ...rest } = doc.panels;
    void p10;
    const result = checkPanelSelector({ default: "p1", panels: rest });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("exactly 10 entries"))).toBe(
      true,
    );
  });

  test("panel count off ten fails (11 panels)", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p11: panel("standard") },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("exactly 10 entries"))).toBe(
      true,
    );
  });

  test("an unknown per-panel key fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: { ...panel("weak"), extra: "x" } },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          "panels.p1 keys must be exactly {strength, members, description}",
        ),
      ),
    ).toBe(true);
  });

  test("a missing per-panel key fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const { strength: _s, ...rest } = panel("weak");
    void _s;
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: rest },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("panels.p1 keys must be exactly")),
    ).toBe(true);
  });

  test("an out-of-enum strength fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: panel("medium") },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("panels.p1.strength") && e.includes("medium"),
      ),
    ).toBe(true);
  });

  test("no weak panel fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: panel("standard") },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('strength "weak"'))).toBe(true);
  });

  test("no max panel fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p10: panel("standard") },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('strength "max"'))).toBe(true);
  });

  test("fewer than 2 members fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: panel("weak", [VALID_MEMBER_A]) },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("panels.p1.members must have 2-3 entries"),
      ),
    ).toBe(true);
  });

  test("more than 3 members fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", [
          VALID_MEMBER_A,
          VALID_MEMBER_B,
          VALID_MEMBER_C,
          VALID_MEMBER_A,
        ]),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("panels.p1.members must have 2-3 entries"),
      ),
    ).toBe(true);
  });

  test("a member with the wrong segment count fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", ["claude::sonnet", VALID_MEMBER_B]),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("three non-empty"))).toBe(true);
  });

  test("a member with an empty segment fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", ["claude::::high", VALID_MEMBER_B]),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("three non-empty"))).toBe(true);
  });

  test("a member with an out-of-enum harness fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", ["gemini::sonnet::high", VALID_MEMBER_B]),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("harness") && e.includes("gemini")),
    ).toBe(true);
  });

  test("a member with an out-of-enum effort fails (haiku-tier low effort rejected)", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", ["claude::haiku::low", VALID_MEMBER_B]),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("effort") && e.includes("low")),
    ).toBe(true);
  });

  test("a duplicate member within a panel fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: {
        ...doc.panels,
        p1: panel("weak", [VALID_MEMBER_A, VALID_MEMBER_A]),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate member"))).toBe(
      true,
    );
  });

  test("a too-short description fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: panel("weak", undefined, "short") },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("description length"))).toBe(
      true,
    );
  });

  test("a too-long description fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({
      default: "p1",
      panels: { ...doc.panels, p1: panel("weak", undefined, "x".repeat(901)) },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("description length"))).toBe(
      true,
    );
  });

  test("a missing default fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({ panels: doc.panels, default: "" });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("default must be a non-empty string"),
      ),
    ).toBe(true);
  });

  test("a default naming an undefined panel fails", () => {
    const doc = baseDoc() as { panels: Record<string, unknown> };
    const result = checkPanelSelector({ panels: doc.panels, default: "ghost" });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("default") && e.includes("must name a defined panel"),
      ),
    ).toBe(true);
  });

  test("every enumerated violation class accumulates into one error list", () => {
    // A single maximally-broken fixture drives every failure class at once,
    // proving the core reports all drift rather than stopping at the first.
    const result = checkPanelSelector({
      panels: {
        p1: {
          strength: "medium",
          members: [VALID_MEMBER_A],
          description: "short",
        },
      },
      default: "missing-panel",
      extra: "unexpected",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(4);
  });
});
