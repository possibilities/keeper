#!/usr/bin/env bun
/**
 * CLAUDE.md size + re-narration guard. The root CLAUDE.md is the agent
 * guardrail file: it must stay a short list of imperative rules, not a
 * per-feature architecture narration. Two costs drove the cut — Codex
 * truncates the AGENTS.md symlink at a 32 KiB project-doc cap, and dense
 * how-it-works prose dilutes the handful of rules that change agent behavior.
 * Architecture/rationale prose lives in README `## Architecture` instead.
 *
 *   bun scripts/lint-claude-md.ts
 *
 * Exits 0 when clean, 1 listing each violation. Scans the LITERAL `CLAUDE.md`
 * path only — never a glob (the `AGENTS.md` symlink would double-hit) and never
 * README / plugins/plan/CLAUDE.md (those legitimately carry fn-/version
 * history).
 *
 * Two gate classes:
 *  - SIZE: FAIL above 120 lines OR 16384 bytes; warn-only (exit 0) above 100.
 *  - CONTENT: FAIL on a re-narration fingerprint per line — `fn-NNN`, a
 *    lowercase version number (`v74`, NOT the all-caps `SCHEMA_VERSION`), an
 *    ISO date, or a past-tense provenance word. The banned vocabulary lives
 *    HERE; never quote it in CLAUDE.md prose (a future rule that must show a
 *    date/version in an example will trip the scanner — acceptable, zero
 *    tolerance).
 */

import { readFileSync } from "node:fs";

const MAX_LINES = 120;
const WARN_LINES = 100;
const MAX_BYTES = 16384;

/** Per-line content fingerprints. A match on any FAILs the lint. */
const CONTENT_PATTERNS: { name: string; re: RegExp }[] = [
  // Plan ids — provenance that belongs in the commit/diff, not a guardrail.
  { name: "fn-id", re: /\bfn-\d+/ },
  // Lowercase schema/db version numbers (`v74`, `v86`). The `\d{2,}` lower
  // bound + the lowercase `v` keep the all-caps `SCHEMA_VERSION` /
  // `SUPPORTED_SCHEMA_VERSIONS` symbols clean.
  { name: "version-number", re: /\bv\d{2,}\b/ },
  // ISO dates — incident timestamps are change history, not a rule.
  { name: "iso-date", re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  // Past-tense provenance: narrates how the code USED to be. "would otherwise"
  // is deliberately absent — it states a current hypothetical, not history.
  {
    name: "provenance",
    re: /\b(formerly|used to|no longer|previously|retired|replaced|removed in)\b/i,
  },
];

export type Finding = {
  /** "SIZE" or "CONTENT". */
  kind: "SIZE" | "CONTENT";
  /** 1-based line number for a CONTENT finding; 0 for a whole-file SIZE one. */
  line: number;
  /** Human-readable failure message. */
  message: string;
};

/**
 * Scan CLAUDE.md text for size + content violations. Pure over its input (no
 * fs) so the fixture test drives it directly. Returns every FAIL finding;
 * over-100-line WARN is surfaced by `main` to stderr, NOT a finding (exit
 * stays 0 for a warn-only file).
 */
export function scanText(text: string): Finding[] {
  const findings: Finding[] = [];

  const lines = text.split("\n");
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(text, "utf8");

  if (lineCount > MAX_LINES) {
    findings.push({
      kind: "SIZE",
      line: 0,
      message: `${lineCount} lines exceeds the ${MAX_LINES}-line cap`,
    });
  }
  if (byteCount > MAX_BYTES) {
    findings.push({
      kind: "SIZE",
      line: 0,
      message: `${byteCount} bytes exceeds the ${MAX_BYTES}-byte cap`,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, re } of CONTENT_PATTERNS) {
      if (re.test(line)) {
        findings.push({
          kind: "CONTENT",
          line: i + 1,
          message: `re-narration fingerprint [${name}]: ${line.trim()}`,
        });
      }
    }
  }

  return findings;
}

/** True when the text trips the warn-only line threshold but not the hard cap. */
export function isWarnOnly(text: string): boolean {
  const lineCount = text.split("\n").length;
  return lineCount > WARN_LINES && lineCount <= MAX_LINES;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLAUDE_MD_PATH = `${REPO_ROOT}/CLAUDE.md`;

function main(): number {
  const text = readFileSync(CLAUDE_MD_PATH, "utf8");
  const findings = scanText(text);

  if (isWarnOnly(text)) {
    console.error(
      `[lint-claude-md] WARN: ${text.split("\n").length} lines is over the ` +
        `${WARN_LINES}-line soft target (hard cap ${MAX_LINES}) — keep trimming.`,
    );
  }

  if (findings.length === 0) {
    console.log("[lint-claude-md] ok — CLAUDE.md within size + content limits");
    return 0;
  }

  console.error(
    `[lint-claude-md] ${findings.length} violation(s) in CLAUDE.md:`,
  );
  for (const f of findings) {
    const where = f.line > 0 ? `:${f.line}` : "";
    console.error(`  - CLAUDE.md${where} [${f.kind}] ${f.message}`);
  }
  console.error(
    "\nCLAUDE.md is the imperative-guardrail file, not a change log. Architecture\n" +
      "and rationale prose — the how-it-works and the per-feature history —\n" +
      "belong in README `## Architecture`. Relocate the offending lines there\n" +
      "and keep CLAUDE.md to short, current rules (don't quote dates/versions/\n" +
      "fn-ids even in examples; the scanner is zero-tolerance per line).",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
