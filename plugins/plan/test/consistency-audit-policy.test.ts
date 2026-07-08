// Drift gate for the audit policy config (../audit-policy.yaml), asserted in the
// fast tier as pure disk reads — no subprocess, daemon, or git. Pins the on-disk
// config against the subagents.yaml efforts axis (both directions) and the fixed
// depth vocabulary, then drives the check core + coercion failure modes through
// hand-built inputs whose expected outcomes are independent of the config under
// test.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import {
  AUDIT_DEPTHS,
  type AuditPolicy,
  type AuditPolicyCheckInput,
  checkAuditPolicy,
  checkAuditPolicyFromDisk,
  coerceAuditPolicy,
  loadAuditPolicy,
} from "../scripts/audit-policy-check.ts";
import { loadSubagentsMatrixFromDisk } from "../src/subagents_config.ts";
import { DEPTH_BAND_THRESHOLD_KEYS } from "../src/verbs/close_preflight.ts";

const PLAN_ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// on-disk config ↔ live efforts axis
// ---------------------------------------------------------------------------

describe("on-disk audit policy", () => {
  test("passes the drift gate (tier coverage both directions + valid bands)", () => {
    const result = checkAuditPolicyFromDisk(PLAN_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("maps every configured effort tier and defines valid depth bands", () => {
    const matrix = loadSubagentsMatrixFromDisk(
      join(PLAN_ROOT, "subagents.yaml"),
    );
    const policy = loadAuditPolicy(join(PLAN_ROOT, "audit-policy.yaml"));
    for (const tier of matrix.efforts) {
      expect(typeof policy.tier_audit[tier]).toBe("boolean");
    }
    expect(policy.depth_bands.length).toBeGreaterThan(0);
    for (const band of policy.depth_bands) {
      expect(AUDIT_DEPTHS as readonly string[]).toContain(band.depth);
    }
  });

  test("ships conservative — max flagged, low unflagged", () => {
    // Independent source of truth: the epic's conservative-rollout contract
    // (only the ceiling flags initially), asserted against the committed config.
    const policy = loadAuditPolicy(join(PLAN_ROOT, "audit-policy.yaml"));
    expect(policy.tier_audit.max).toBe(true);
    expect(policy.tier_audit.low).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pure check core — failure modes driven by hand-built independent inputs
// ---------------------------------------------------------------------------

// Independent fixture: a fully-covered policy over the axis [low, high, max].
// Expectations below are asserted against these constants, never re-derived.
function baseInput(): AuditPolicyCheckInput {
  return {
    efforts: ["low", "high", "max"],
    policy: {
      tier_audit: { low: false, high: false, max: true },
      depth_bands: [
        {
          depth: "deep",
          min_task_count: 8,
          min_diff_loc: 2000,
          min_touched_repos: 2,
        },
        {
          depth: "lean",
          min_task_count: 0,
          min_diff_loc: 0,
          min_touched_repos: 0,
        },
      ],
    },
  };
}

describe("audit-policy check core", () => {
  test("a fully-covered policy with valid bands passes", () => {
    expect(checkAuditPolicy(baseInput())).toEqual({ ok: true, errors: [] });
  });

  test("an unmapped configured tier fails coverage", () => {
    const input = baseInput();
    const result = checkAuditPolicy({
      ...input,
      efforts: ["low", "high", "max", "xhigh"], // policy has no `xhigh`
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("tier_audit") && e.includes("xhigh"),
      ),
    ).toBe(true);
  });

  test("a tier_audit key beyond the axis fails coverage", () => {
    const input = baseInput();
    const result = checkAuditPolicy({
      ...input,
      policy: {
        ...input.policy,
        tier_audit: { ...input.policy.tier_audit, ultra: true },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ultra"))).toBe(true);
  });

  test("a band naming an unknown depth fails", () => {
    const input = baseInput();
    const result = checkAuditPolicy({
      ...input,
      policy: {
        ...input.policy,
        depth_bands: [
          {
            depth: "exhaustive",
            min_task_count: 0,
            min_diff_loc: 0,
            min_touched_repos: 0,
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("exhaustive"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// coercion — fail-loud structural guards driven by hand-built documents
// ---------------------------------------------------------------------------

/** A structurally complete policy document, spread-modified per test. */
function baseDoc(): Record<string, unknown> {
  return {
    tier_audit: { low: false, max: true },
    depth_bands: [
      {
        depth: "lean",
        min_task_count: 0,
        min_diff_loc: 0,
        min_touched_repos: 0,
      },
    ],
  };
}

describe("audit-policy coercion", () => {
  test("a valid document coerces to the typed policy", () => {
    const policy: AuditPolicy = coerceAuditPolicy(baseDoc());
    expect(policy.tier_audit.max).toBe(true);
    expect(policy.depth_bands[0]?.depth).toBe("lean");
  });

  test("a non-boolean tier value fails loud", () => {
    const doc = { ...baseDoc(), tier_audit: { low: false, max: "yes" } };
    expect(() => coerceAuditPolicy(doc)).toThrow("tier_audit.max");
  });

  test("a missing tier_audit section fails loud", () => {
    const doc = baseDoc();
    delete doc.tier_audit;
    expect(() => coerceAuditPolicy(doc)).toThrow("tier_audit");
  });

  test("an empty depth_bands list fails loud", () => {
    const doc = { ...baseDoc(), depth_bands: [] };
    expect(() => coerceAuditPolicy(doc)).toThrow("depth_bands");
  });

  test("a band with a non-string depth fails loud", () => {
    const doc = {
      ...baseDoc(),
      depth_bands: [
        { depth: 3, min_task_count: 0, min_diff_loc: 0, min_touched_repos: 0 },
      ],
    };
    expect(() => coerceAuditPolicy(doc)).toThrow("depth");
  });

  test("a band with a non-number threshold fails loud", () => {
    const doc = {
      ...baseDoc(),
      depth_bands: [
        {
          depth: "lean",
          min_task_count: "many",
          min_diff_loc: 0,
          min_touched_repos: 0,
        },
      ],
    };
    expect(() => coerceAuditPolicy(doc)).toThrow("min_task_count");
  });
});

// ---------------------------------------------------------------------------
// Runtime consumer / config key parity. Proves the coercion schema is
// DERIVED from close_preflight.ts's own DEPTH_BAND_THRESHOLD_KEYS rather than
// an independently hand-maintained copy, so the two cannot silently diverge
// again.
// ---------------------------------------------------------------------------

describe("audit-policy ↔ runtime consumer key parity", () => {
  test("a coerced depth_bands entry supplies exactly the runtime consumer's keys", () => {
    const policy = coerceAuditPolicy(baseDoc());
    const band = policy.depth_bands[0] as unknown as Record<string, unknown>;
    expect(new Set(Object.keys(band))).toEqual(
      new Set(["depth", ...DEPTH_BAND_THRESHOLD_KEYS]),
    );
  });

  test("a depth_bands entry missing a key the runtime consumer reads fails loud", () => {
    // Simulates the file drifting away from the consumer (or vice versa): drop
    // one of close_preflight.ts's own threshold keys from an otherwise-valid
    // entry and confirm coercion catches it rather than silently passing.
    const [firstKey] = DEPTH_BAND_THRESHOLD_KEYS;
    const doc = baseDoc();
    const band = { ...(doc.depth_bands as Record<string, unknown>[])[0] };
    delete band[firstKey];
    doc.depth_bands = [band];
    expect(() => coerceAuditPolicy(doc)).toThrow(firstKey);
  });
});
