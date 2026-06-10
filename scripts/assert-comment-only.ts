#!/usr/bin/env bun
/**
 * Comment-only scrub verifier. For each file argument, prove the working-tree
 * version differs from its HEAD blob ONLY in comments/whitespace — never in
 * code. Three independent checks must all pass:
 *
 *   1. Token-sequence equality (TS scanner, skipTrivia) — comments and
 *      whitespace are trivia, so any token difference means code changed.
 *      Strings/regex-literals/templates are single tokens, so a `//` or
 *      `/* *​/` inside them can never be misread as a comment.
 *   2. Transpile-output equality — a second, independent witness that the
 *      emitted JS is byte-identical.
 *   3. Protected-pattern guard — occurrence counts of suppression/license
 *      directives must not decrease.
 *
 * Operates on RAW TEXT (no tsconfig), so plugin/ files — outside the lint
 * roots and commit-work's lint arms — are gated here too.
 *
 *   bun scripts/assert-comment-only.ts src/reducer.ts [more files...]
 *
 * Exits 0 with a per-file deleted-line/deleted-char scoreboard on success;
 * non-zero printing the file and the first differing token pair on failure.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Suppression/license directives whose count must never drop in a scrub. */
const PROTECTED_PATTERNS = [
  "biome-ignore",
  "@ts-ignore",
  "@ts-expect-error",
  "c8 ignore",
  "sourceMappingURL",
  "SPDX",
] as const;

const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
  removeComments: true,
  isolatedModules: true,
};

function isJsxPath(path: string): boolean {
  return path.endsWith(".tsx") || path.endsWith(".jsx");
}

/** Read a path's committed blob from HEAD; null if it does not exist there. */
function headBlob(path: string): string | null {
  const res = Bun.spawnSync(["git", "show", `HEAD:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) return null;
  return res.stdout.toString();
}

type Token = { kind: ts.SyntaxKind; text: string };

/** Scan `source` into its non-trivia token sequence (kind + verbatim text). */
function tokenize(source: string, jsx: boolean): Token[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  const tokens: Token[] = [];
  // The bare scanner has no parser to coordinate template substitutions: after
  // a `${`, a `}` must be re-scanned as a TemplateMiddle/TemplateTail or the
  // rest of the template (and everything after it) is swallowed into one token.
  // Track brace depth and mark the depth at each `${`; when a `}` closes back
  // to that depth, rescan it as a template continuation.
  const braceStack: ("template" | "block")[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.CloseBraceToken &&
      braceStack[braceStack.length - 1] === "template"
    ) {
      braceStack.pop();
      kind = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
    }
    tokens.push({ kind, text: scanner.getTokenText() });
    if (
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.TemplateMiddle
    ) {
      braceStack.push("template");
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      braceStack.push("block");
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      braceStack.pop();
    }
    kind = scanner.scan();
  }
  return tokens;
}

/**
 * First index where two token sequences differ, or -1 if one is a prefix of
 * the other (length mismatch handled by the caller).
 */
function firstTokenDiff(a: Token[], b: Token[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].kind !== b[i].kind || a[i].text !== b[i].text) return i;
  }
  return -1;
}

function describeToken(tok: Token | undefined): string {
  if (tok === undefined) return "<end of token stream>";
  return `${ts.SyntaxKind[tok.kind]} ${JSON.stringify(tok.text)}`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export type CheckResult =
  | { ok: true; deletedLines: number; deletedChars: number }
  | { ok: false; reason: string };

/**
 * Verify `working` differs from `head` in comments/whitespace only. Pure over
 * its two string inputs (no git, no fs) so the fixture tests drive it directly.
 */
export function checkCommentOnly(
  head: string,
  working: string,
  jsx: boolean,
): CheckResult {
  // (1) token-sequence equality
  const headTokens = tokenize(head, jsx);
  const workTokens = tokenize(working, jsx);
  const diffAt = firstTokenDiff(headTokens, workTokens);
  if (diffAt !== -1) {
    return {
      ok: false,
      reason:
        `token mismatch at #${diffAt}: ` +
        `HEAD ${describeToken(headTokens[diffAt])} vs ` +
        `working ${describeToken(workTokens[diffAt])}`,
    };
  }
  if (headTokens.length !== workTokens.length) {
    const longer =
      headTokens.length > workTokens.length ? headTokens : workTokens;
    const which =
      headTokens.length > workTokens.length
        ? "HEAD has extra"
        : "working has extra";
    return {
      ok: false,
      reason:
        `token count mismatch (HEAD ${headTokens.length}, ` +
        `working ${workTokens.length}); ${which} ` +
        describeToken(longer[Math.min(headTokens.length, workTokens.length)]),
    };
  }

  // (2) transpile-output equality
  const headJs = ts.transpileModule(head, {
    compilerOptions: TRANSPILE_OPTIONS,
  }).outputText;
  const workJs = ts.transpileModule(working, {
    compilerOptions: TRANSPILE_OPTIONS,
  }).outputText;
  if (headJs !== workJs) {
    return {
      ok: false,
      reason: "transpile output differs (code emit changed)",
    };
  }

  // (3) protected-pattern guard
  for (const pattern of PROTECTED_PATTERNS) {
    const before = countOccurrences(head, pattern);
    const after = countOccurrences(working, pattern);
    if (after < before) {
      return {
        ok: false,
        reason: `protected pattern "${pattern}" count dropped ${before} -> ${after}`,
      };
    }
  }

  const deletedLines = countLines(head) - countLines(working);
  const deletedChars = head.length - working.length;
  return { ok: true, deletedLines, deletedChars };
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

function main(argv: string[]): number {
  const files = argv.slice(2);
  if (files.length === 0) {
    console.error(
      "usage: bun scripts/assert-comment-only.ts <file> [<file>...]",
    );
    return 2;
  }

  let failed = false;
  for (const path of files) {
    const head = headBlob(path);
    if (head === null) {
      console.error(
        `[assert-comment-only] ${path}: no HEAD blob (new/untracked file)`,
      );
      failed = true;
      continue;
    }
    let workingText: string;
    try {
      workingText = readFileSync(path, "utf8");
    } catch {
      console.error(`[assert-comment-only] ${path}: cannot read working tree`);
      failed = true;
      continue;
    }

    const result = checkCommentOnly(head, workingText, isJsxPath(path));
    if (!result.ok) {
      console.error(`[assert-comment-only] ${path}: FAIL — ${result.reason}`);
      failed = true;
      continue;
    }
    console.log(
      `[assert-comment-only] ${path}: ok — ` +
        `-${result.deletedLines} lines, -${result.deletedChars} chars`,
    );
  }

  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(Bun.argv));
}
