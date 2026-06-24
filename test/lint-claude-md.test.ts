/**
 * Fixture tests for the CLAUDE.md size + re-narration guard
 * (scripts/lint-claude-md.ts). Drives the PURE `scanText` export with synthetic
 * fixtures — no subprocess, no real git, fast tier — so each gate class is
 * pinned independently:
 *  - a clean stripped sample PASSES;
 *  - over-cap line count / byte count FAIL (SIZE);
 *  - an fn-id, a lowercase version number, an ISO date, and a past-tense
 *    provenance word each FAIL (CONTENT);
 *  - a `SCHEMA_VERSION` line and a "would otherwise" line PASS (no false
 *    positive — the version regex is lowercase + `\d{2,}`, the provenance set
 *    omits "would otherwise").
 */

import { expect, test } from "bun:test";
import { isWarnOnly, scanText } from "../scripts/lint-claude-md";

const CLEAN = [
  "keeper — event-sourced control-data daemon.",
  "",
  "## Rules",
  "",
  "- Always exit 0 from a hook.",
  "- Never open SQLite in a hook.",
  "- Scan the literal CLAUDE.md path, never a glob.",
  "",
].join("\n");

test("clean stripped sample passes with no findings", () => {
  expect(scanText(CLEAN)).toEqual([]);
});

test("over 120 lines FAILs with a SIZE finding", () => {
  const text = Array.from({ length: 130 }, (_, i) => `- rule ${i}`).join("\n");
  const findings = scanText(text);
  const size = findings.filter((f) => f.kind === "SIZE");
  expect(size.length).toBe(1);
  expect(size[0].message).toContain("exceeds the 120-line cap");
});

test("over 16384 bytes FAILs with a SIZE finding", () => {
  // A handful of long lines, comfortably under 120 lines but over 16 KiB.
  const big = "x".repeat(2000);
  const text = Array.from({ length: 10 }, () => `- ${big}`).join("\n");
  expect(text.split("\n").length).toBeLessThanOrEqual(120);
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(16384);
  const size = scanText(text).filter((f) => f.kind === "SIZE");
  expect(size.length).toBe(1);
  expect(size[0].message).toContain("exceeds the 16384-byte cap");
});

test("an fn-id FAILs as a CONTENT finding", () => {
  const findings = scanText("- the fn-123 fix made the fold incremental.");
  expect(findings.length).toBe(1);
  expect(findings[0].kind).toBe("CONTENT");
  expect(findings[0].message).toContain("[fn-id]");
});

test("a lowercase version number FAILs as a CONTENT finding", () => {
  const findings = scanText("- v74 seeded the retention shed class.");
  expect(findings.length).toBe(1);
  expect(findings[0].message).toContain("[version-number]");
});

test("an ISO date FAILs as a CONTENT finding", () => {
  const findings = scanText("- the 2026-06-23 unreachable-live-agent bug.");
  expect(findings.length).toBe(1);
  expect(findings[0].message).toContain("[iso-date]");
});

test("a past-tense provenance word FAILs as a CONTENT finding", () => {
  for (const word of [
    "formerly",
    "used to",
    "no longer",
    "previously",
    "retired",
    "replaced",
    "removed in",
  ]) {
    const findings = scanText(`- the relay ${word} spawned the worker.`);
    expect(findings.some((f) => f.message.includes("[provenance]"))).toBe(true);
  }
});

test("SCHEMA_VERSION is NOT a false positive (version regex is lowercase)", () => {
  const line =
    "- When you bump SCHEMA_VERSION, add it to SUPPORTED_SCHEMA_VERSIONS.";
  expect(scanText(line)).toEqual([]);
});

test('"would otherwise" is NOT a false positive (omitted from the provenance set)', () => {
  const line =
    "- CLAUDE.md gains a line only for a rule an agent would otherwise get wrong.";
  expect(scanText(line)).toEqual([]);
});

test("over 100 but at-or-under 120 lines is warn-only (no SIZE finding)", () => {
  const text = Array.from({ length: 110 }, (_, i) => `- rule ${i}`).join("\n");
  expect(isWarnOnly(text)).toBe(true);
  expect(scanText(text).filter((f) => f.kind === "SIZE")).toEqual([]);
});
