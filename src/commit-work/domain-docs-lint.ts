/**
 * Domain-docs lint arm for `keeper commit-work` — the deterministic gate that
 * keeps the typed knowledge layer clean: a root `CONTEXT.md` / `CONTEXT-MAP.md`
 * ubiquitous-language glossary, and `docs/adr/` decision records.
 *
 * The scanner mirrors the `scripts/lint-claude-md.ts` shape: pure scan functions
 * over text drive a fixture corpus, and an impure arm (`runDomainDocsLint`) reads
 * the staged files, runs the scanners, appends a forensic pain-ledger record per
 * finding, and returns a matrix-shaped failure. The arm gates ONLY on staged
 * paths — it travels in the binary and fires in ANY repo, never gated on a
 * repo-local script.
 *
 * CONTEXT.md discipline (all hard-blocking):
 *  - a line cap, so the always-loaded glossary can never re-monolithize;
 *  - a per-definition sentence cap (glossary entries are 1-2 sentences);
 *  - every term carries a non-empty `Avoid:` synonym line;
 *  - re-narration fingerprints (fn-ids, versions, ISO dates, provenance words)
 *    and implementation-detail fingerprints (file paths, call signatures, code
 *    fences past a single signature line) — the glossary holds concepts, not code.
 *
 * Fingerprints run on PROSE only: the markdown is parsed structurally so fenced
 * blocks, inline code, and link destinations are skipped — a definition that
 * names a CLI command or a slash-term in prose passes untouched. The fingerprint
 * set deliberately UNDER-captures (a bare `foo.ts` with no path segment, a
 * single-arg call) so a false positive never becomes the adoption killer; the
 * read tier is the second net and the inline `keeper-lint off/on` escape hatch is
 * the relief valve. The escape hatch suppresses fingerprints for its region but
 * NEVER the structural caps.
 *
 * ADRs are the sanctioned history home: `docs/adr/` files get structural checks
 * only (NNNN-slug.md naming, a per-file line cap, no duplicate numbers) — the
 * history/impl fingerprints are DISABLED there.
 *
 * Dep-free leaf: `node:*` plus the state-dir helper only. A scanner crash fails
 * CLOSED (blocks the commit with a clear message) rather than leaking an
 * unhandled rejection out of the matrix's `Promise.all`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { keeperStateDir } from "../keeper-state-dir";

/** CONTEXT.md line cap — the always-loaded glossary stays lean. */
const CONTEXT_MAX_LINES = 140;
/** Per-definition sentence cap — glossary entries are 1-2 sentences. */
const MAX_DEF_SENTENCES = 2;
/** Per-ADR line cap — a decision record is a page, not an essay. */
const ADR_MAX_LINES = 80;

/** A NNNN-slug.md ADR filename: zero-padded 4-digit number + kebab slug. */
const ADR_NAME_RE = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** Directory-index files under docs/adr — not ADRs, exempt from naming. */
const ADR_INDEX_NAMES = new Set(["README.md", "index.md"]);

/**
 * Fingerprint set run on glossary PROSE. Every match hard-blocks. The
 * re-narration patterns mirror `scripts/lint-claude-md.ts`; the impl-detail
 * patterns under-capture by design (see file header).
 */
const FINGERPRINTS: { rule: string; re: RegExp }[] = [
  // Re-narration — provenance that belongs in the commit/diff or an ADR.
  { rule: "fn-id", re: /\bfn-\d+/ },
  { rule: "version-number", re: /\bv\d{2,}\b/ },
  { rule: "iso-date", re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  {
    rule: "provenance",
    re: /\b(?:formerly|used to|no longer|previously|retired|replaced|removed in)\b/i,
  },
  // Implementation-detail — a file path needs >=2 segments AND a known
  // extension (a bare `foo.ts` with no slash does NOT match).
  {
    rule: "impl-path",
    re: /(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|md|json|zig|sh|lua|toml|ya?ml|sql|rs|go|css|html)\b/,
  },
  // A call signature — an identifier glued to parens whose body is empty or
  // carries a comma / type-annotation colon (a bare single-arg call and the
  // `worktree(s)` plural are deliberately NOT matched).
  {
    rule: "impl-signature",
    re: /\b[A-Za-z_][\w.]*\((?:\)|[^)]*[,:][^)]*\))/,
  },
];

/** One rule violation: its rule id, 1-based line (0 = whole-file), and message. */
export type DomainDocFinding = {
  rule: string;
  line: number;
  message: string;
};

/** The matrix-shaped failure this arm returns (structurally a RecordedFailure). */
export type DomainDocsLintResult = {
  linter: string;
  files: string[];
  stderr: string;
};

/** True when `path` is a glossary doc (CONTEXT.md / CONTEXT-MAP.md, any dir). */
export function isContextDocPath(path: string): boolean {
  const name = basename(path);
  return name === "CONTEXT.md" || name === "CONTEXT-MAP.md";
}

/** True when `path` is a flat `docs/adr/<file>.md` decision record. */
export function isAdrPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return /(?:^|\/)docs\/adr\/[^/]+\.md$/.test(norm);
}

/**
 * Strip a prose line down to fingerprint-scannable text: drop inline-code
 * spans, keep link TEXT while dropping destinations, drop autolinks and bare
 * URLs. Leaves the concept prose the fingerprints judge.
 */
function toProse(line: string): string {
  let s = line;
  s = s.replace(/`[^`]*`/g, " "); // inline code spans
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // [text](url) -> text
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1"); // [text][ref] -> text
  s = s.replace(/<[^>]+>/g, " "); // autolinks / raw tags
  s = s.replace(/https?:\/\/\S+/g, " "); // bare URLs
  return s;
}

/** Count sentences in a definition, neutralizing dots that don't end one. */
function countSentences(text: string): number {
  let s = text.trim();
  if (s === "") return 0;
  s = s.replace(/\.\.\./g, "…"); // ellipsis
  s = s.replace(/\b\d+\.\d+/g, (m) => m.replace(/\./g, "·")); // decimals
  s = s.replace(
    /\b(?:e\.g|i\.e|etc|vs|cf|approx|Dr|Mr|Ms|Mrs|Inc|Ltd|Co)\./gi,
    (m) => m.replace(/\./g, "·"),
  );
  return s
    .split(/[.!?]+(?:\s+|$)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length;
}

type ContextParse = {
  rawLines: string[];
  /** Non-fence lines, stripped to prose, tagged with escape-region state. */
  proseLines: { line: number; text: string; suppressed: boolean }[];
  /** Fenced blocks with their non-blank content line count + escape state. */
  fences: { line: number; contentCount: number; suppressed: boolean }[];
  /** Per-raw-line flag: true when the line sits inside a fenced code block. */
  inFence: boolean[];
};

/** Single structural pass: fences, escape regions, and prose extraction. */
function parseContext(text: string): ContextParse {
  const rawLines = text.split("\n");
  const proseLines: ContextParse["proseLines"] = [];
  const fences: ContextParse["fences"] = [];
  const inFence: boolean[] = new Array(rawLines.length).fill(false);

  let fenceOpen = false;
  let fenceStartLine = 0;
  let fenceContent = 0;
  let fenceSuppressed = false;
  let suppressed = false;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;

    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence[i] = true;
      if (!fenceOpen) {
        fenceOpen = true;
        fenceStartLine = lineNo;
        fenceContent = 0;
        fenceSuppressed = suppressed;
      } else {
        fenceOpen = false;
        fences.push({
          line: fenceStartLine,
          contentCount: fenceContent,
          suppressed: fenceSuppressed,
        });
      }
      continue;
    }
    if (fenceOpen) {
      inFence[i] = true;
      if (trimmed.length > 0) fenceContent++;
      continue;
    }

    if (/<!--\s*keeper-lint\s+off\s*-->/.test(trimmed)) {
      suppressed = true;
      continue;
    }
    if (/<!--\s*keeper-lint\s+on\s*-->/.test(trimmed)) {
      suppressed = false;
      continue;
    }

    proseLines.push({ line: lineNo, text: toProse(raw), suppressed });
  }

  if (fenceOpen) {
    fences.push({
      line: fenceStartLine,
      contentCount: fenceContent,
      suppressed: fenceSuppressed,
    });
  }

  return { rawLines, proseLines, fences, inFence };
}

/** A term start: optional list marker, then `**Term**:` and inline remainder. */
const TERM_RE = /^\s*(?:[-*+]\s+)?\*\*([^*]+)\*\*\s*:\s*(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

type TermBlock = {
  term: string;
  startLine: number;
  def: string;
  /** null when no `Avoid:` marker exists; "" when it exists but is empty. */
  avoidText: string | null;
};

/** Parse `**Term**:` glossary blocks over non-fence lines. */
function parseTerms(rawLines: string[], inFence: boolean[]): TermBlock[] {
  const blocks: TermBlock[] = [];
  let i = 0;
  while (i < rawLines.length) {
    if (inFence[i]) {
      i++;
      continue;
    }
    const m = rawLines[i].match(TERM_RE);
    if (!m) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const parts: string[] = [m[2]];
    let j = i + 1;
    while (j < rawLines.length && !inFence[j]) {
      const line = rawLines[j];
      if (line.trim() === "") break;
      if (TERM_RE.test(line)) break;
      if (HEADING_RE.test(line)) break;
      parts.push(line);
      j++;
    }
    const blockText = parts.join(" ");
    const avoidMatch = blockText.match(/\bAvoid\s*:/);
    let def = blockText;
    let avoidText: string | null = null;
    if (avoidMatch && avoidMatch.index !== undefined) {
      def = blockText.slice(0, avoidMatch.index);
      avoidText = blockText
        .slice(avoidMatch.index + avoidMatch[0].length)
        .trim();
    }
    blocks.push({ term: m[1].trim(), startLine, def, avoidText });
    i = j;
  }
  return blocks;
}

function sortFindings(findings: DomainDocFinding[]): DomainDocFinding[] {
  return [...findings].sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

/**
 * Scan a CONTEXT.md / CONTEXT-MAP.md glossary. Pure over its input (no fs) so
 * the fixture corpus drives it directly. Returns every hard-block finding.
 */
export function scanContextDoc(text: string): DomainDocFinding[] {
  const findings: DomainDocFinding[] = [];
  const { rawLines, proseLines, fences, inFence } = parseContext(text);

  // Structural — size cap (never suppressed by the escape hatch).
  if (rawLines.length > CONTEXT_MAX_LINES) {
    findings.push({
      rule: "context-size",
      line: 0,
      message: `${rawLines.length} lines exceeds the ${CONTEXT_MAX_LINES}-line cap`,
    });
  }

  // Structural — per-term sentence cap + mandatory Avoid line.
  for (const b of parseTerms(rawLines, inFence)) {
    const sentences = countSentences(b.def);
    if (sentences > MAX_DEF_SENTENCES) {
      findings.push({
        rule: "definition-sentences",
        line: b.startLine,
        message: `"${b.term}" definition has ${sentences} sentences (max ${MAX_DEF_SENTENCES})`,
      });
    }
    if (b.avoidText === null || b.avoidText === "") {
      findings.push({
        rule: "missing-avoid",
        line: b.startLine,
        message: `"${b.term}" has no non-empty Avoid line`,
      });
    }
  }

  // Fingerprints — prose only, suppressed inside a keeper-lint off region.
  for (const p of proseLines) {
    if (p.suppressed) continue;
    for (const { rule, re } of FINGERPRINTS) {
      if (re.test(p.text)) {
        findings.push({
          rule,
          line: p.line,
          message: `${rule} in prose: ${p.text.trim().slice(0, 120)}`,
        });
      }
    }
  }

  // Impl-detail — a code fence past a single signature line (suppressible).
  for (const f of fences) {
    if (f.suppressed) continue;
    if (f.contentCount > 1) {
      findings.push({
        rule: "code-fence",
        line: f.line,
        message: `code fence has ${f.contentCount} content lines; only a single signature line is allowed`,
      });
    }
  }

  return sortFindings(findings);
}

/**
 * Scan one ADR file — structural checks only (naming + size). History and
 * implementation detail are ALLOWED here (ADRs are the sanctioned decision home)
 * so no fingerprints run. Pure over its inputs.
 */
export function scanAdrFile(path: string, text: string): DomainDocFinding[] {
  const findings: DomainDocFinding[] = [];
  const name = basename(path);

  if (!ADR_INDEX_NAMES.has(name) && !ADR_NAME_RE.test(name)) {
    findings.push({
      rule: "adr-naming",
      line: 0,
      message: `"${name}" is not a NNNN-slug.md ADR filename`,
    });
  }

  const lineCount = text.split("\n").length;
  if (lineCount > ADR_MAX_LINES) {
    findings.push({
      rule: "adr-size",
      line: 0,
      message: `${lineCount} lines exceeds the ${ADR_MAX_LINES}-line cap`,
    });
  }

  return findings;
}

/**
 * Cross-file ADR check over a staged set: two ADRs sharing a 4-digit number is
 * a hard block. Pure over the filenames. Index files carry no number and are
 * skipped. Returns findings tagged with their file.
 */
export function scanAdrSet(
  paths: string[],
): { file: string; finding: DomainDocFinding }[] {
  const byNum = new Map<string, string[]>();
  for (const p of paths) {
    const m = basename(p).match(/^(\d{4})-/);
    if (!m) continue;
    const arr = byNum.get(m[1]) ?? [];
    arr.push(p);
    byNum.set(m[1], arr);
  }
  const out: { file: string; finding: DomainDocFinding }[] = [];
  for (const [num, ps] of byNum) {
    if (ps.length <= 1) continue;
    for (const p of [...ps].sort()) {
      out.push({
        file: p,
        finding: {
          rule: "adr-duplicate-number",
          line: 0,
          message: `ADR number ${num} is used by ${ps.length} staged files`,
        },
      });
    }
  }
  return out;
}

/**
 * `KEEPER_DOMAIN_DOCS_LEDGER` env wins; else
 * `<keeperStateDir()>/domain-docs-pain.ndjson`. Forensic-only append target:
 * never read by the reducer, never feeds a projection. Pure — does no I/O.
 */
export function resolveDomainDocsLedgerPath(): string {
  const override = process.env.KEEPER_DOMAIN_DOCS_LEDGER;
  if (override && override.length > 0) return override;
  return join(keeperStateDir(), "domain-docs-pain.ndjson");
}

/** Append one NDJSON pain record per finding. Best-effort — never blocks. */
function appendPainLedger(
  tagged: { file: string; finding: DomainDocFinding }[],
  repo: string,
): void {
  try {
    const path = resolveDomainDocsLedgerPath();
    mkdirSync(dirname(path), { recursive: true });
    const ts = new Date().toISOString();
    const blob = tagged
      .map(
        ({ file, finding }) =>
          `${JSON.stringify({
            ts,
            repo,
            file,
            rule: finding.rule,
            line: finding.line,
          })}\n`,
      )
      .join("");
    appendFileSync(path, blob);
  } catch {
    // The ledger is forensic-only; a write failure must never change the verdict.
  }
}

/** Build the verbatim stderr blob carried in the lint_failed envelope. */
function formatStderr(
  tagged: { file: string; finding: DomainDocFinding }[],
): string {
  const lines = tagged.map(({ file, finding }) => {
    const where = finding.line > 0 ? `:${finding.line}` : "";
    return `  ${file}${where} [${finding.rule}] ${finding.message}`;
  });
  return (
    `domain-docs: ${tagged.length} finding(s)\n` +
    `${lines.join("\n")}\n\n` +
    "CONTEXT.md holds concepts (1-2 sentences + an Avoid line), never code or\n" +
    "history; docs/adr/ is the home for decisions and dates. Tighten the prose,\n" +
    "move a signature into a single-line code fence, or record history in an ADR.\n" +
    "An intentional exception can be wrapped in `<!-- keeper-lint off -->` /\n" +
    "`<!-- keeper-lint on -->` (suppresses fingerprints, never the structural caps)."
  );
}

/**
 * The impure lint arm: filter the staged files to glossary + ADR paths, run the
 * pure scanners, append one pain-ledger record per finding, and return a
 * matrix-shaped failure (or null when clean / no domain docs staged). Fails
 * CLOSED on any internal error rather than rejecting out of `Promise.all`.
 */
export async function runDomainDocsLint(
  stagedFiles: string[],
  cwd: string,
): Promise<DomainDocsLintResult | null> {
  const domainFiles = stagedFiles.filter(
    (f) => isContextDocPath(f) || isAdrPath(f),
  );
  try {
    const contextDocs = stagedFiles.filter(isContextDocPath);
    const adrFiles = stagedFiles.filter(isAdrPath);
    if (contextDocs.length === 0 && adrFiles.length === 0) return null;

    const tagged: { file: string; finding: DomainDocFinding }[] = [];
    for (const f of contextDocs) {
      const text = readFileSync(join(cwd, f), "utf8");
      for (const finding of scanContextDoc(text))
        tagged.push({ file: f, finding });
    }
    for (const f of adrFiles) {
      const text = readFileSync(join(cwd, f), "utf8");
      for (const finding of scanAdrFile(f, text))
        tagged.push({ file: f, finding });
    }
    tagged.push(...scanAdrSet(adrFiles));

    if (tagged.length === 0) return null;

    tagged.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.finding.line - b.finding.line ||
        a.finding.rule.localeCompare(b.finding.rule),
    );

    appendPainLedger(tagged, cwd);

    return {
      linter: "domain-docs",
      files: [...new Set(tagged.map((t) => t.file))],
      stderr: formatStderr(tagged),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      linter: "domain-docs",
      files: domainFiles,
      stderr:
        `domain-docs lint crashed and is failing closed: ${message}\n` +
        "Inspect the staged CONTEXT.md / docs/adr files, then re-run.",
    };
  }
}
