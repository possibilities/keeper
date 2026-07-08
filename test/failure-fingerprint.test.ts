import { describe, expect, test } from "bun:test";

import {
  fingerprintFailure,
  MAX_FINGERPRINT_INPUT,
  normalizeFailureEvidence,
} from "../src/failure-fingerprint";

// ---------------------------------------------------------------------------
// normalizeFailureEvidence — the masking (expected strings hand-computed, never
// re-derived through the function under test).
// ---------------------------------------------------------------------------

describe("normalizeFailureEvidence", () => {
  test("masks a sha, path, line number, and pid to their placeholders", () => {
    const got = normalizeFailureEvidence(
      "base sha a1b2c3d4 broke `bun test` at /Users/mike/repo/src/foo.ts:42 (pid 12345)",
    );
    // Hand-computed: sha→hex, path→path, `:42`→n, `12345`→n; backticks/parens/colon
    // collapse to spaces; whitespace collapses.
    expect(got).toBe("base sha hex broke bun test at path n pid n");
  });

  test("masks an ISO-8601 timestamp and a hex address", () => {
    const got = normalizeFailureEvidence(
      "crash 0xDEADBEEF at 2026-07-07T12:00:00.500Z",
    );
    expect(got).toBe("crash addr at ts");
  });

  test("preserves underscores (so category/token words survive)", () => {
    expect(normalizeFailureEvidence("SHARED_BASE_BROKEN: boom")).toBe(
      "shared_base_broken boom",
    );
  });

  test("is idempotent-ish under repeated whitespace / punctuation", () => {
    expect(normalizeFailureEvidence("a   ::   b,,,c")).toBe("a b c");
  });

  test("bounds pathological input (no throw, capped length)", () => {
    const huge = "x".repeat(MAX_FINGERPRINT_INPUT * 4);
    const got = normalizeFailureEvidence(huge);
    expect(got.length).toBeLessThanOrEqual(MAX_FINGERPRINT_INPUT);
  });
});

// ---------------------------------------------------------------------------
// fingerprintFailure — the collapse / non-collapse contract.
// ---------------------------------------------------------------------------

describe("fingerprintFailure", () => {
  test("identical defects differing only in path/line/pid/sha COLLAPSE to one fingerprint", () => {
    const a = fingerprintFailure(
      "base sha deadbeef1 test `bun test` failed at /a/b/foo.ts:42 pid 111",
    );
    const b = fingerprintFailure(
      "base sha cafef00d2 test `bun test` failed at /c/d/bar.ts:99 pid 222",
    );
    expect(a).toBe(b);
  });

  test("identical defects differing only in a timestamp COLLAPSE", () => {
    const a = fingerprintFailure("suite red at 2026-07-07T12:00:00Z");
    const b = fingerprintFailure("suite red at 2026-01-01T00:00:00Z");
    expect(a).toBe(b);
  });

  test("distinct failing commands do NOT collapse", () => {
    const bun = fingerprintFailure(
      "base sha deadbeef1 test `bun test` failed at /a/b/foo.ts:42",
    );
    const cargo = fingerprintFailure(
      "base sha deadbeef1 test `cargo build` failed at /a/b/foo.rs:42",
    );
    expect(bun).not.toBe(cargo);
  });

  test("distinct assertion text does NOT collapse", () => {
    const x = fingerprintFailure("expected the widget to render");
    const y = fingerprintFailure("expected the gadget to render");
    expect(x).not.toBe(y);
  });

  test("is deterministic — same input, same token, across calls", () => {
    const reason =
      "SHARED_BASE_BROKEN: `bun run test:full` red at base sha abc1234";
    expect(fingerprintFailure(reason)).toBe(fingerprintFailure(reason));
  });

  test("output is a non-empty whitespace-free token (matches the reason \\S+ slot)", () => {
    const fp = fingerprintFailure(
      "anything at all with spaces / and : punctuation",
    );
    expect(fp.length).toBeGreaterThan(0);
    expect(fp).toMatch(/^\S+$/);
    // The escalation-brief REPAIR_REASON_RE contract: `shared-base-broken:<\S+>`.
    expect(`shared-base-broken:${fp}`).toMatch(/^shared-base-broken:\s*(\S+)/);
  });
});
