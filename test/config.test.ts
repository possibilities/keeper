/**
 * Tests for `resolveConfig` in `src/db.ts` — focused on the
 * `autoclose_windows` key (the autopilot window-reap kill switch) and its
 * independence from the sibling keys.
 *
 * Each test points `KEEPER_CONFIG` at a temp YAML file (the resolver's
 * documented test seam) and restores the prior env in afterEach. No
 * daemon, no socket, no DB.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTOCLOSE_WINDOWS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  resolveConfig,
} from "../src/db";

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keeper-config-"));
  prevEnv = process.env.KEEPER_CONFIG;
});

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = prevEnv;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  process.env.KEEPER_CONFIG = path;
}

test("autocloseWindows defaults to true when the config file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().autocloseWindows).toBe(true);
  expect(DEFAULT_AUTOCLOSE_WINDOWS).toBe(true);
});

test("autocloseWindows defaults to true when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().autocloseWindows).toBe(true);
});

test("autoclose_windows: false disables the reap", () => {
  writeConfig("autoclose_windows: false\n");
  expect(resolveConfig().autocloseWindows).toBe(false);
});

test("autoclose_windows: true keeps the reap on", () => {
  writeConfig("autoclose_windows: true\n");
  expect(resolveConfig().autocloseWindows).toBe(true);
});

test("a non-boolean autoclose_windows falls back to the true default", () => {
  // String "false" is NOT a boolean — must not disable the reap.
  writeConfig('autoclose_windows: "false"\n');
  expect(resolveConfig().autocloseWindows).toBe(true);
});

test("autoclose_windows resolves independently of a malformed sibling key", () => {
  // A junk `roots` (non-array) must not disturb the autoclose resolution.
  writeConfig("roots: not-a-list\nautoclose_windows: false\n");
  const cfg = resolveConfig();
  expect(cfg.autocloseWindows).toBe(false);
  // roots fell back to its default (non-empty) — independence holds.
  expect(cfg.roots.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// max_concurrent_jobs (fn-725) — positive-int-only, else null (unlimited)
// ---------------------------------------------------------------------------

test("maxConcurrentJobs defaults to null (unlimited) when the file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
  expect(DEFAULT_MAX_CONCURRENT_JOBS).toBe(null);
});

test("maxConcurrentJobs defaults to null when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test("max_concurrent_jobs: 3 → 3 (a positive integer overrides)", () => {
  writeConfig("max_concurrent_jobs: 3\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(3);
});

test("max_concurrent_jobs: 0 → null (zero is not a positive cap)", () => {
  writeConfig("max_concurrent_jobs: 0\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test("max_concurrent_jobs: -1 → null (negative is rejected)", () => {
  writeConfig("max_concurrent_jobs: -1\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test("max_concurrent_jobs: 2.5 → null (fractional is rejected)", () => {
  writeConfig("max_concurrent_jobs: 2.5\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test('max_concurrent_jobs: "x" → null (a string is rejected)', () => {
  writeConfig('max_concurrent_jobs: "x"\n');
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test("max_concurrent_jobs: null → null (explicit null stays unlimited)", () => {
  writeConfig("max_concurrent_jobs: null\n");
  expect(resolveConfig().maxConcurrentJobs).toBe(null);
});

test("a malformed max_concurrent_jobs leaves a sibling key intact (independence)", () => {
  // A junk cap value must not strand `zellij_session` at its default —
  // the keys resolve independently from the same parsed document.
  writeConfig('max_concurrent_jobs: "nope"\nzellij_session: my-session\n');
  const cfg = resolveConfig();
  expect(cfg.maxConcurrentJobs).toBe(null);
  expect(cfg.zellijSession).toBe("my-session");
});
