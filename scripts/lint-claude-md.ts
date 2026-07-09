#!/usr/bin/env bun
/**
 * CLAUDE.md + README.md size/content guard. Both docs stay lean: CLAUDE.md is
 * the agent guardrail file (a short list of imperative rules, not a per-feature
 * architecture narration), and README.md is a lean front door, not the append
 * target for every feature's rationale. Two costs drove the CLAUDE.md cut —
 * Codex truncates the AGENTS.md symlink at a 32 KiB project-doc cap, and dense
 * how-it-works prose dilutes the handful of rules that change agent behavior.
 * When a rule or paragraph outgrows either file, tighten or delete it:
 * consolidate into an existing rule, move a local contract into a code comment,
 * or drop it — history and provenance live in `docs/adr/` and commit messages.
 * README is NOT a relocation target.
 *
 *   bun scripts/lint-claude-md.ts
 *
 * Exits 0 when clean, 1 listing each violation. Scans the LITERAL `CLAUDE.md`
 * and `README.md` paths only — never a glob (the `AGENTS.md` symlink would
 * double-hit) and never plugins/plan/CLAUDE.md (it legitimately carries fn-/
 * version history).
 *
 * Two gate classes (both files):
 *  - SIZE: CLAUDE.md FAILs above 120 lines OR 16384 bytes (warn-only, exit 0,
 *    above 100); README.md FAILs above 250 lines OR 24576 bytes (hard cap, no
 *    warn tier).
 *  - CONTENT: FAIL on a re-narration fingerprint per line — `fn-NNN`, a
 *    lowercase version number (`v74`, NOT the all-caps `SCHEMA_VERSION`), an
 *    ISO date, or a past-tense provenance word. The banned vocabulary lives
 *    HERE; never quote it in either doc's prose (a future rule that must show a
 *    date/version in an example will trip the scanner — acceptable, zero
 *    tolerance).
 */

import { existsSync, readFileSync } from "node:fs";

const MAX_LINES = 120;
const WARN_LINES = 100;
const MAX_BYTES = 16384;

// README.md is a lean front door — hard caps, no warn tier.
const README_MAX_LINES = 250;
const README_MAX_BYTES = 24576;

/** Per-line content fingerprints. A match on any FAILs the lint. */
const CONTENT_PATTERNS: { name: string; re: RegExp }[] = [
  // Plan ids — provenance that belongs in the commit/diff, not a guardrail.
  { name: "fn-id", re: /\bfn-\d+/ },
  // Lowercase schema/db version numbers (`v74`, `v86`). The `\d{2,}` lower
  // bound + the lowercase `v` keep the all-caps `SCHEMA_VERSION` symbol clean.
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

  const lineCount = text.split("\n").length;
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

  findings.push(...scanContent(text));
  return findings;
}

/**
 * Scan README.md for the front-door size caps + the same re-narration
 * fingerprints. Pure over its input (no fs), parallel to `scanText`. README
 * caps are HARD (strict `>`, no warn tier): a README over cap is a hard FAIL
 * so the front door can never re-monolithize. Boundary + line-counting
 * semantics match `scanText` exactly.
 */
export function scanReadme(text: string): Finding[] {
  const findings: Finding[] = [];

  const lineCount = text.split("\n").length;
  const byteCount = Buffer.byteLength(text, "utf8");

  if (lineCount > README_MAX_LINES) {
    findings.push({
      kind: "SIZE",
      line: 0,
      message: `${lineCount} lines exceeds the ${README_MAX_LINES}-line cap`,
    });
  }
  if (byteCount > README_MAX_BYTES) {
    findings.push({
      kind: "SIZE",
      line: 0,
      message: `${byteCount} bytes exceeds the ${README_MAX_BYTES}-byte cap`,
    });
  }

  findings.push(...scanContent(text));
  return findings;
}

/**
 * Per-line re-narration fingerprint scan shared by `scanText` and `scanReadme`
 * — one source of truth for the CONTENT patterns + false-positive guards.
 */
function scanContent(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
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
const README_PATH = `${REPO_ROOT}/README.md`;

function main(): number {
  const claudeText = readFileSync(CLAUDE_MD_PATH, "utf8");
  const findings: { file: string; finding: Finding }[] = scanText(
    claudeText,
  ).map((finding) => ({ file: "CLAUDE.md", finding }));

  if (isWarnOnly(claudeText)) {
    console.error(
      `[lint-claude-md] WARN: ${claudeText.split("\n").length} lines is over the ` +
        `${WARN_LINES}-line soft target (hard cap ${MAX_LINES}) — keep trimming.`,
    );
  }

  // README.md is scanned when present, so the gate is a strict no-op in a repo
  // without one (mirrors the lint-matrix existsSync guard).
  if (existsSync(README_PATH)) {
    const readmeText = readFileSync(README_PATH, "utf8");
    findings.push(
      ...scanReadme(readmeText).map((finding) => ({
        file: "README.md",
        finding,
      })),
    );
  }

  if (findings.length === 0) {
    console.log(
      "[lint-claude-md] ok — CLAUDE.md + README.md within size + content limits",
    );
    return 0;
  }

  console.error(`[lint-claude-md] ${findings.length} violation(s):`);
  for (const { file, finding } of findings) {
    const where = finding.line > 0 ? `:${finding.line}` : "";
    console.error(`  - ${file}${where} [${finding.kind}] ${finding.message}`);
  }
  console.error(
    "\nCLAUDE.md is the imperative-guardrail file and README.md is a lean front\n" +
      "door — neither is a change log or a relocation target. Tighten or delete:\n" +
      "consolidate into an existing rule, move a local contract into a code\n" +
      "comment, or drop it — history and provenance live in `docs/adr/` and\n" +
      "commit messages (don't quote dates/versions/fn-ids even in examples; the\n" +
      "scanner is zero-tolerance per line).",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
