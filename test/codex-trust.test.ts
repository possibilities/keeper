/**
 * Unit tests for the dep-free `src/codex-trust.ts` leaf module: the codex
 * per-directory trust seeder `keeper pair` runs before launching the codex
 * partner as an interactive TUI.
 *
 * Pure + in-process: every test injects a tmpdir CODEX_HOME via `env`, so there
 * is NO real codex spawn and NO write to the real `~/.codex`. The cwd key is a
 * tmpdir we mkdir so `realpathSync` resolves (codex stores the canonical path).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCodexDirTrust, escapeTomlKey } from "../src/codex-trust";

let root: string;
let codexHome: string;
let cwd: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-trust-"));
  codexHome = join(root, "codexhome");
  mkdirSync(codexHome, { recursive: true });
  cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  configPath = join(codexHome, "config.toml");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The env shape the helper reads — explicit CODEX_HOME, no real fallback. */
function envFor(extra: Record<string, string | undefined> = {}) {
  return { CODEX_HOME: codexHome, ...extra };
}

/** The exact header line the helper writes for `cwd` (realpath-canonicalized). */
function expectedHeader(dir: string): string {
  return `[projects."${realpathSync(dir)}"]`;
}

test("seeds the exact trust snippet when the header is absent", () => {
  writeFileSync(configPath, '[some.other]\nkey = "val"\n');
  const status = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(status).toBe("seeded");
  const config = readFileSync(configPath, "utf8");
  expect(config).toContain(`${expectedHeader(cwd)}\ntrust_level = "trusted"\n`);
  // The pre-existing content is preserved (append, not rewrite).
  expect(config).toContain('[some.other]\nkey = "val"\n');
});

test("creates config.toml when CODEX_HOME has no config yet", () => {
  expect(existsSync(configPath)).toBe(false);
  const status = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(status).toBe("seeded");
  const config = readFileSync(configPath, "utf8");
  expect(config).toContain(expectedHeader(cwd));
  expect(config).toContain('trust_level = "trusted"');
});

test("skips when the exact header is already present (respects existing value)", () => {
  // A user-set non-`trusted` value — the exact-header check treats it as present
  // and leaves it untouched (we never override a user's explicit choice).
  const existing = `${expectedHeader(cwd)}\ntrust_level = "untrusted"\n`;
  writeFileSync(configPath, existing);
  const status = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(status).toBe("already-trusted");
  expect(readFileSync(configPath, "utf8")).toBe(existing);
});

test("idempotent — a second run no-ops after seeding", () => {
  const first = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(first).toBe("seeded");
  const afterFirst = readFileSync(configPath, "utf8");
  const second = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(second).toBe("already-trusted");
  // No duplicate table — the file is byte-identical after the no-op re-run.
  expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
});

test("a child of a trusted ancestor STILL gets seeded (trust is not inherited)", () => {
  // Seed the parent.
  const parentStatus = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(parentStatus).toBe("seeded");
  // A fresh child dir under the trusted parent must still be seeded — codex does
  // not inherit trust from an ancestor.
  const child = join(cwd, "nested");
  mkdirSync(child, { recursive: true });
  const childStatus = ensureCodexDirTrust({ cwd: child, env: envFor() });
  expect(childStatus).toBe("seeded");
  const config = readFileSync(configPath, "utf8");
  expect(config).toContain(expectedHeader(cwd));
  expect(config).toContain(expectedHeader(child));
});

test("uses substring-immune exact-line matching, not includes()", () => {
  // A header for a path that has our cwd's realpath as a PREFIX must not satisfy
  // the presence check for cwd — exact trimmed full-line equality, never a
  // substring `includes`.
  const sibling = join(cwd, "child");
  mkdirSync(sibling, { recursive: true });
  // Write only the longer (child) header.
  writeFileSync(
    configPath,
    `${expectedHeader(sibling)}\ntrust_level = "trusted"\n`,
  );
  // Seeding `cwd` must NOT see the child header as a match for cwd.
  const status = ensureCodexDirTrust({ cwd, env: envFor() });
  expect(status).toBe("seeded");
  const config = readFileSync(configPath, "utf8");
  expect(config).toContain(expectedHeader(cwd));
  expect(config).toContain(expectedHeader(sibling));
});

test("fail-open when CODEX_HOME points at an unwritable junk path", () => {
  // CODEX_HOME is a FILE, so the config-dir mkdir throws (ENOTDIR) — the helper
  // must return a status, never throw.
  const junk = join(root, "junkfile");
  writeFileSync(junk, "not a dir");
  let status: string | undefined;
  expect(() => {
    status = ensureCodexDirTrust({ cwd, env: { CODEX_HOME: junk } });
  }).not.toThrow();
  expect(status).toBe("error");
});

test("fail-open when cwd does not exist (realpath throws)", () => {
  const missing = join(root, "does-not-exist");
  let status: string | undefined;
  expect(() => {
    status = ensureCodexDirTrust({ cwd: missing, env: envFor() });
  }).not.toThrow();
  expect(status).toBe("error");
});

test("escapeTomlKey escapes backslash then quote (basic-string escapes)", () => {
  // The escaping is a pure function — a real dir with a quote/backslash is
  // unreliable across filesystems (macOS APFS mkdir-vs-lstat diverge), so the
  // load-bearing TOML-key correctness is asserted directly on the pure helper.
  // backslash MUST be doubled before the quote is escaped, else the `\"` backslash
  // would itself be doubled.
  expect(escapeTomlKey('/a/b"c')).toBe('/a/b\\"c');
  expect(escapeTomlKey("/a/b\\c")).toBe("/a/b\\\\c");
  expect(escapeTomlKey('/a/b"\\c')).toBe('/a/b\\"\\\\c');
  // A plain POSIX path is untouched.
  expect(escapeTomlKey("/Users/mike/code/keeper")).toBe(
    "/Users/mike/code/keeper",
  );
});

test("logs to KEEPER_CODEX_TRUST_LOG on seed when set", () => {
  const logPath = join(root, "trust.log");
  const status = ensureCodexDirTrust({
    cwd,
    env: envFor({ KEEPER_CODEX_TRUST_LOG: logPath }),
  });
  expect(status).toBe("seeded");
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf8")).toContain("seeded");
});
