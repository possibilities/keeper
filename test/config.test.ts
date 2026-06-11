/**
 * Tests for `resolveConfig` in `src/db.ts` — focused on the `exec_backend`
 * key (autopilot backend selector) and its independence from the sibling
 * keys.
 *
 * Each test points `KEEPER_CONFIG` at a temp YAML file (the resolver's
 * documented test seam) and restores the prior env in afterEach. No
 * daemon, no socket, no DB.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_CONCURRENT_JOBS, resolveConfig } from "../src/db";

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

test("execBackend defaults to zellij when the config file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().execBackend).toBe("zellij");
});

test("execBackend defaults to zellij when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().execBackend).toBe("zellij");
});

test("exec_backend: tmux selects the tmux backend", () => {
  writeConfig("exec_backend: tmux\n");
  expect(resolveConfig().execBackend).toBe("tmux");
});

test("exec_backend: zellij is accepted verbatim", () => {
  writeConfig("exec_backend: zellij\n");
  expect(resolveConfig().execBackend).toBe("zellij");
});

test("an unknown exec_backend value warns and falls back to zellij", () => {
  // `ghostty` is not a recognized backend — fall back to the default
  // rather than threading an unhandled value into the worker.
  writeConfig("exec_backend: ghostty\n");
  expect(resolveConfig().execBackend).toBe("zellij");
});

test("a non-string exec_backend falls back to the zellij default", () => {
  writeConfig("exec_backend: 42\n");
  expect(resolveConfig().execBackend).toBe("zellij");
});

test("exec_backend resolves independently of a malformed sibling key", () => {
  // A junk `roots` (non-array) must not disturb the exec_backend resolution.
  writeConfig("roots: not-a-list\nexec_backend: tmux\n");
  const cfg = resolveConfig();
  expect(cfg.execBackend).toBe("tmux");
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
  // A junk cap value must not strand `exec_backend` at its default —
  // the keys resolve independently from the same parsed document.
  writeConfig('max_concurrent_jobs: "nope"\nexec_backend: tmux\n');
  const cfg = resolveConfig();
  expect(cfg.maxConcurrentJobs).toBe(null);
  expect(cfg.execBackend).toBe("tmux");
});

// ---------------------------------------------------------------------------
// account_aliases — cosmetic <profile-id>: <display> map for the usage TUI
// ---------------------------------------------------------------------------

test("accountAliases defaults to {} when the file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().accountAliases).toEqual({});
});

test("accountAliases defaults to {} when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().accountAliases).toEqual({});
});

test("account_aliases parses a <profile-id>: <display> map", () => {
  writeConfig(
    "account_aliases:\n" +
      "  default: claude-0\n" +
      "  multi-claude-1: claude-1\n" +
      "  multi-claude-2: claude-2\n",
  );
  expect(resolveConfig().accountAliases).toEqual({
    default: "claude-0",
    "multi-claude-1": "claude-1",
    "multi-claude-2": "claude-2",
  });
});

test("account_aliases drops non-string and empty-string entries", () => {
  // Only string→non-empty-string survives; null / number / "" are dropped.
  writeConfig(
    "account_aliases:\n" +
      "  default: claude-0\n" +
      "  multi-claude-1: 7\n" +
      "  multi-claude-2: null\n" +
      '  multi-claude-3: ""\n',
  );
  expect(resolveConfig().accountAliases).toEqual({ default: "claude-0" });
});

test("a non-object account_aliases falls back to {}", () => {
  writeConfig("account_aliases: not-a-map\n");
  expect(resolveConfig().accountAliases).toEqual({});
});

test("an array account_aliases falls back to {} (a map is required)", () => {
  writeConfig("account_aliases:\n  - claude-0\n  - claude-1\n");
  expect(resolveConfig().accountAliases).toEqual({});
});

test("account_aliases resolves independently of a malformed sibling key", () => {
  writeConfig("roots: not-a-list\naccount_aliases:\n  default: claude-0\n");
  const cfg = resolveConfig();
  expect(cfg.accountAliases).toEqual({ default: "claude-0" });
  expect(cfg.roots.length).toBeGreaterThan(0);
});
