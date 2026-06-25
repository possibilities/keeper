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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  resolveAgentwrapPath,
  resolveConfig,
} from "../src/db";
import { resolveDisableAutoclose } from "../src/pair-command";

let dir: string;
let prevEnv: string | undefined;
let prevAgentwrapEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keeper-config-"));
  prevEnv = process.env.KEEPER_CONFIG;
  prevAgentwrapEnv = process.env.KEEPER_AGENTWRAP_PATH;
  delete process.env.KEEPER_AGENTWRAP_PATH;
});

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = prevEnv;
  }
  if (prevAgentwrapEnv === undefined) {
    delete process.env.KEEPER_AGENTWRAP_PATH;
  } else {
    process.env.KEEPER_AGENTWRAP_PATH = prevAgentwrapEnv;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  process.env.KEEPER_CONFIG = path;
}

test("a stale exec_backend: key boots clean (silently ignored, no field)", () => {
  // The `exec_backend` toggle is retired — agentwrap is keeper's sole, direct
  // launch transport. A stale key in a live config must parse cleanly into the
  // existing silent-ignore path: every kept key still resolves, and there is no
  // `execBackend` field on the result.
  writeConfig("exec_backend: agentwrap\nroots:\n  - ~/code\n");
  const cfg = resolveConfig();
  expect(cfg).not.toHaveProperty("execBackend");
  expect(cfg.roots).toEqual(["~/code"]);
});

// ---------------------------------------------------------------------------
// agentwrap_path / resolveAgentwrapPath — env override > config > default,
// tilde-expanded at resolve time.
// ---------------------------------------------------------------------------

test("agentwrap_path parses onto agentwrapPath (non-empty string only)", () => {
  writeConfig("agentwrap_path: /opt/bin/agentwrap\n");
  expect(resolveConfig().agentwrapPath).toBe("/opt/bin/agentwrap");
});

test("agentwrapPath is undefined when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().agentwrapPath).toBeUndefined();
});

test("resolveAgentwrapPath defaults to ~/.bun/bin/agentwrap (tilde-expanded)", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveAgentwrapPath()).toBe(
    join(homedir(), ".bun", "bin", "agentwrap"),
  );
});

test("resolveAgentwrapPath uses the config value over the default", () => {
  writeConfig("agentwrap_path: /opt/bin/agentwrap\n");
  expect(resolveAgentwrapPath()).toBe("/opt/bin/agentwrap");
});

test("resolveAgentwrapPath expands a leading ~/ in the config value", () => {
  writeConfig("agentwrap_path: ~/tools/agentwrap\n");
  expect(resolveAgentwrapPath()).toBe(join(homedir(), "tools", "agentwrap"));
});

test("KEEPER_AGENTWRAP_PATH env override wins over the config value", () => {
  writeConfig("agentwrap_path: /opt/bin/agentwrap\n");
  process.env.KEEPER_AGENTWRAP_PATH = "/usr/local/bin/agentwrap";
  expect(resolveAgentwrapPath()).toBe("/usr/local/bin/agentwrap");
});

test("KEEPER_AGENTWRAP_PATH env override expands a leading ~/", () => {
  process.env.KEEPER_AGENTWRAP_PATH = "~/env/agentwrap";
  expect(resolveAgentwrapPath()).toBe(join(homedir(), "env", "agentwrap"));
});

test("a non-string agentwrap_path leaves agentwrapPath undefined → default", () => {
  writeConfig("agentwrap_path: 42\n");
  expect(resolveConfig().agentwrapPath).toBeUndefined();
  expect(resolveAgentwrapPath()).toBe(
    join(homedir(), ".bun", "bin", "agentwrap"),
  );
});

// ---------------------------------------------------------------------------
// max_concurrent_jobs (fn-953) — config-file support is REMOVED. The cap is now
// RUNTIME-settable via `set_autopilot_config` and `resolveConfig` no longer
// surfaces it; `DEFAULT_MAX_CONCURRENT_JOBS` survives as the in-memory default.
// ---------------------------------------------------------------------------

test("DEFAULT_MAX_CONCURRENT_JOBS is null (unlimited) — the in-memory default", () => {
  expect(DEFAULT_MAX_CONCURRENT_JOBS).toBe(null);
});

test("KeeperConfig no longer carries maxConcurrentJobs (config-file support removed)", () => {
  // A config file SETTING `max_concurrent_jobs` is now silently IGNORED — the
  // resolved config object has no such key (the cap rides the runtime RPC), and
  // a sibling key still resolves independently from the same document.
  writeConfig("max_concurrent_jobs: 3\nagentwrap_path: /opt/bin/agentwrap\n");
  const cfg = resolveConfig();
  expect("maxConcurrentJobs" in cfg).toBe(false);
  expect(cfg.agentwrapPath).toBe("/opt/bin/agentwrap");
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

// ---------------------------------------------------------------------------
// dispatch_prompt_prefix (fn-861) — non-empty-string only, else undefined
// (mirrors buildbot_url's independent best-effort string-key pattern)
// ---------------------------------------------------------------------------

test("dispatchPromptPrefix defaults to undefined when the file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().dispatchPromptPrefix).toBeUndefined();
});

test("dispatchPromptPrefix defaults to undefined when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().dispatchPromptPrefix).toBeUndefined();
});

test("dispatch_prompt_prefix: /hack → /hack (a non-empty string overrides)", () => {
  writeConfig("dispatch_prompt_prefix: /hack\n");
  expect(resolveConfig().dispatchPromptPrefix).toBe("/hack");
});

test('dispatch_prompt_prefix: "" → undefined (empty is rejected)', () => {
  writeConfig('dispatch_prompt_prefix: ""\n');
  expect(resolveConfig().dispatchPromptPrefix).toBeUndefined();
});

test("a non-string dispatch_prompt_prefix falls back to undefined", () => {
  writeConfig("dispatch_prompt_prefix: 42\n");
  expect(resolveConfig().dispatchPromptPrefix).toBeUndefined();
});

test("dispatch_prompt_prefix resolves independently of a malformed sibling key", () => {
  writeConfig("roots: not-a-list\ndispatch_prompt_prefix: /hack\n");
  const cfg = resolveConfig();
  expect(cfg.dispatchPromptPrefix).toBe("/hack");
  expect(cfg.roots.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// handoff_prompt_prefix (fn-946) — non-empty-string only, else undefined
// (mirrors dispatch_prompt_prefix's independent best-effort string-key pattern)
// ---------------------------------------------------------------------------

test("handoffPromptPrefix defaults to undefined when the file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().handoffPromptPrefix).toBeUndefined();
});

test("handoffPromptPrefix defaults to undefined when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().handoffPromptPrefix).toBeUndefined();
});

test("handoff_prompt_prefix: /hack → /hack (a non-empty string overrides)", () => {
  writeConfig("handoff_prompt_prefix: /hack\n");
  expect(resolveConfig().handoffPromptPrefix).toBe("/hack");
});

test('handoff_prompt_prefix: "" → undefined (empty is rejected)', () => {
  writeConfig('handoff_prompt_prefix: ""\n');
  expect(resolveConfig().handoffPromptPrefix).toBeUndefined();
});

test("a non-string handoff_prompt_prefix falls back to undefined", () => {
  writeConfig("handoff_prompt_prefix: 42\n");
  expect(resolveConfig().handoffPromptPrefix).toBeUndefined();
});

test("handoff_prompt_prefix resolves independently of a malformed sibling key", () => {
  writeConfig("roots: not-a-list\nhandoff_prompt_prefix: /hack\n");
  const cfg = resolveConfig();
  expect(cfg.handoffPromptPrefix).toBe("/hack");
  expect(cfg.roots.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// disable_autoclose (fn-920) — the reaper managed-session opt-out; default
// empty (every managed session autocloses), best-effort string list.
// ---------------------------------------------------------------------------

test("disableAutoclose defaults to [] when the file is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().disableAutoclose).toEqual([]);
});

test("disableAutoclose defaults to [] when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().disableAutoclose).toEqual([]);
});

test("disable_autoclose parses a session-name list", () => {
  writeConfig("disable_autoclose:\n  - pair\n  - panels\n");
  expect(resolveConfig().disableAutoclose).toEqual(["pair", "panels"]);
});

test("disable_autoclose trims and drops empty / non-string entries", () => {
  writeConfig(
    "disable_autoclose:\n" +
      '  - "  pair  "\n' +
      '  - ""\n' +
      "  - 7\n" +
      "  - null\n" +
      "  - panels\n",
  );
  expect(resolveConfig().disableAutoclose).toEqual(["pair", "panels"]);
});

test("a non-array disable_autoclose falls back to [] (a list is required)", () => {
  writeConfig("disable_autoclose: pair\n");
  expect(resolveConfig().disableAutoclose).toEqual([]);
});

test("disable_autoclose resolves independently of a malformed sibling key", () => {
  writeConfig("roots: not-a-list\ndisable_autoclose:\n  - pair\n");
  const cfg = resolveConfig();
  expect(cfg.disableAutoclose).toEqual(["pair"]);
  expect(cfg.roots.length).toBeGreaterThan(0);
});

test("a disable_autoclose glob pattern parses and resolves through the matcher", () => {
  writeConfig("disable_autoclose:\n  - 'panels:*'\n  - pair\n");
  const isDisabled = resolveDisableAutoclose(resolveConfig().disableAutoclose);
  // The glob arm matches any `panels:<id>` session; the bare arm matches exactly.
  expect(isDisabled("panels:fn-1")).toBe(true);
  expect(isDisabled("pair")).toBe(true);
  expect(isDisabled("autopilot")).toBe(false);
});
