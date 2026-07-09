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
import { readFileSync } from "node:fs";
import { isWarnOnly, scanReadme, scanText } from "../scripts/lint-claude-md";

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
  const line = "- SCHEMA_VERSION derives from the migration ladder.";
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

// --- scanReadme: the README front-door hard-cap + content gate ---

const README_CLEAN = [
  "# keeper",
  "",
  "An event-sourced control-data daemon.",
  "",
  "## What it is",
  "",
  "- A local daemon that folds Claude Code events into a projection.",
  "",
  "## Install",
  "",
  "- `bun install && keeper up`.",
  "",
].join("\n");

test("clean README front door passes scanReadme with no findings", () => {
  expect(scanReadme(README_CLEAN)).toEqual([]);
});

test("over 250 lines FAILs scanReadme with a SIZE finding", () => {
  const text = Array.from({ length: 260 }, (_, i) => `- line ${i}`).join("\n");
  const size = scanReadme(text).filter((f) => f.kind === "SIZE");
  expect(size.length).toBe(1);
  expect(size[0].message).toContain("exceeds the 250-line cap");
});

test("over 24576 bytes FAILs scanReadme (multibyte so bytes ≠ chars)", () => {
  // Multibyte content: each `€` is 3 UTF-8 bytes, so byte count outruns both
  // char and line count — the byte cap trips well under 250 lines.
  const big = "€".repeat(2000);
  const text = Array.from({ length: 20 }, () => `- ${big}`).join("\n");
  expect(text.split("\n").length).toBeLessThanOrEqual(250);
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(24576);
  const size = scanReadme(text).filter((f) => f.kind === "SIZE");
  expect(size.length).toBe(1);
  expect(size[0].message).toContain("exceeds the 24576-byte cap");
});

test("scanReadme has no warn tier — exactly at 250 lines passes", () => {
  const text = Array.from({ length: 250 }, (_, i) => `- line ${i}`).join("\n");
  expect(text.split("\n").length).toBe(250);
  expect(scanReadme(text).filter((f) => f.kind === "SIZE")).toEqual([]);
});

test("scanReadme flags each re-narration fingerprint class", () => {
  for (const [line, tag] of [
    ["- the fn-123 fix made the fold incremental.", "[fn-id]"],
    ["- v74 seeded the retention shed class.", "[version-number]"],
    ["- the 2026-06-23 unreachable-live-agent bug.", "[iso-date]"],
    ["- the relay previously spawned the worker.", "[provenance]"],
  ] as const) {
    const findings = scanReadme(line);
    expect(findings.some((f) => f.message.includes(tag))).toBe(true);
  }
});

test("scanReadme carries the CLAUDE.md false-positive guards", () => {
  const line = "- SCHEMA_VERSION derives from the migration ladder.";
  expect(scanReadme(line)).toEqual([]);
});

test("lint script epilogue points to tighten/delete, never README relocation", () => {
  const src = readFileSync(
    new URL("../scripts/lint-claude-md.ts", import.meta.url),
    "utf8",
  );
  // The reversed funnel: guidance is tighten/delete, README is NOT a target.
  expect(src).toContain("Tighten or delete");
  expect(src).toContain("README is NOT a relocation target.");
  // The old funnel wording must not survive anywhere in the script.
  expect(src).not.toContain("Relocate the offending lines");
  expect(src).not.toContain("belong in README `## Architecture`");
  // History/provenance is re-pointed at the typed decision home + commit
  // messages; the prior `.keeper/` specs-archive wording must not survive.
  expect(src).toContain("docs/adr/");
  expect(src).not.toContain("specs archive all provenance");
});
