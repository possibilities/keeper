#!/usr/bin/env bun
/**
 * No-real-git regression guard (fn-904). The epic drove ZERO real git out of
 * the default test tiers — producers test against synthetic porcelain/snapshot
 * fixtures, commit/push surfaces against a faked git runner. This lint keeps it
 * that way: it scans every top-level `test/*.test.ts` for a real-git signature
 * and FAILS on a match unless the file is in scripts/test-real-git-allowlist.txt
 * (the slow/integration tier that legitimately keeps real git).
 *
 *   bun scripts/lint-no-real-git.ts
 *
 * Exits 0 when clean, 1 listing each offending file + the first matching line.
 *
 * Patterns (mirroring the epic quick-command grep): a `Bun.spawn`/`Bun.spawnSync`
 * on the `git` binary, an `initRepo`/`gitInit` import or call, and a
 * `mkdtemp`+`git init` pair. Comment and string false-positives are scoped out
 * by the allowlist + the hot-file glob — a non-allowlisted hot file simply must
 * not carry any of these tokens.
 */

import { readFileSync } from "node:fs";
import { Glob } from "bun";

/** Real-git signatures. Each is a per-line regex; a match outside the allowlist fails. */
const REAL_GIT_PATTERNS: { name: string; re: RegExp }[] = [
  // Spawning the `git` binary directly (sync or async), e.g.
  // `Bun.spawnSync(["git", ...])` or `Bun.spawn(["git", "-C", dir, ...])`.
  { name: "git spawn", re: /Bun\.spawn(?:Sync)?\(\s*\[\s*"git"/ },
  // Importing or calling the shared real-git fixture helpers.
  { name: "initRepo/gitInit", re: /\b(?:initRepo|gitInit)\b/ },
  // A bare `git init` plumbing string (an inline shell-form repo init). The
  // `["init"]` array element form is already covered by the git-spawn pattern
  // above; matching a lone `"init"` token would false-positive on a plan
  // `op: "init"` and is deliberately NOT a signature.
  { name: "git init", re: /\bgit init\b/ },
];

export type Finding = {
  file: string;
  line: number;
  pattern: string;
  text: string;
};

/**
 * Scan one file's text for a real-git signature. Returns the first finding, or
 * null when clean. Pure over its inputs (no fs/glob) so the fixture test drives
 * it directly.
 */
export function scanText(file: string, text: string): Finding | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const { name, re } of REAL_GIT_PATTERNS) {
      if (re.test(text)) {
        return { file, line: i + 1, pattern: name, text: text.trim() };
      }
    }
  }
  return null;
}

/** Parse the allowlist file into a Set of repo-relative paths (skip blanks/comments). */
export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ALLOWLIST_PATH = `${REPO_ROOT}/scripts/test-real-git-allowlist.txt`;

/** Repo-relative top-level test glob: `test/*.test.ts` (not `test/helpers/*`). */
function hotFiles(): string[] {
  const glob = new Glob("test/*.test.ts");
  return [...glob.scanSync({ cwd: REPO_ROOT })].sort();
}

function main(): number {
  const allow = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  const findings: Finding[] = [];

  for (const rel of hotFiles()) {
    if (allow.has(rel)) continue;
    const text = readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
    const hit = scanText(rel, text);
    if (hit !== null) findings.push(hit);
  }

  if (findings.length > 0) {
    console.error(
      `[lint-no-real-git] ${findings.length} non-allowlisted hot file(s) carry real-git signatures:`,
    );
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.pattern}] ${f.text}`);
    }
    console.error(
      "\nThe default test tiers must spawn NO real git. Test keeper's DECISIONS\n" +
        "at the git boundary with synthetic porcelain/snapshot fixtures or a faked\n" +
        'git runner (see CLAUDE.md "Test isolation"). If a test\'s contract genuinely\n' +
        "IS reading git's own execution, name it `*.slow.test.ts` and add it to\n" +
        "scripts/test-real-git-allowlist.txt.",
    );
    return 1;
  }

  // Catch a stale allowlist entry — a path listed but absent (renamed/deleted).
  // Slow-tier members carry `*.slow.test.ts`, which the `test/*.test.ts` hot
  // glob already matches, so the scanned set is the full universe.
  const present = new Set(hotFiles());
  for (const rel of allow) {
    if (!present.has(rel)) {
      console.error(
        `[lint-no-real-git] allowlist entry no longer exists: ${rel} (remove it)`,
      );
      return 1;
    }
  }

  console.log(
    `[lint-no-real-git] ok — ${hotFiles().length} hot file(s) scanned, ` +
      `${allow.size} allowlisted`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
