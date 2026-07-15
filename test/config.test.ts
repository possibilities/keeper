/**
 * Tests for `resolveConfig` in `src/db.ts` — each key resolves independently
 * and a retired key (`exec_backend`, `max_concurrent_jobs`) is silently ignored
 * without disturbing the siblings.
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
  DEFAULT_MAX_CONCURRENT_JOBS,
  resolveAutocloseEnabled,
  resolveAutocloseGraceSeconds,
  resolveConfig,
  resolveTabIcons,
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

test("a stale exec_backend: key boots clean (silently ignored, no field)", () => {
  // The `exec_backend` toggle is retired — keeper agent is keeper's sole, direct
  // launch transport. A stale key in a live config must parse cleanly into the
  // existing silent-ignore path: every kept key still resolves, and there is no
  // `execBackend` field on the result.
  writeConfig("exec_backend: direct\nroots:\n  - ~/code\n");
  const cfg = resolveConfig();
  expect(cfg).not.toHaveProperty("execBackend");
  expect(cfg.roots).toEqual(["~/code"]);
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
  writeConfig(
    "max_concurrent_jobs: 3\nkeeper_agent_path: /opt/bin/keeper.ts\n",
  );
  const cfg = resolveConfig();
  expect("maxConcurrentJobs" in cfg).toBe(false);
  expect(cfg.keeperAgentPath).toBe("/opt/bin/keeper.ts");
});

test("retired quota registry keys are silently ignored", () => {
  writeConfig(
    "account_aliases:\n" +
      "  default: claude-0\n" +
      "usage_models:\n" +
      "  default: claude-real\n" +
      "agentusage_root: ~/.local/state/agentusage\n" +
      "roots:\n" +
      "  - ~/code\n",
  );
  const cfg = resolveConfig();
  expect(cfg).not.toHaveProperty("accountAliases");
  expect(cfg).not.toHaveProperty("usageModels");
  expect(cfg).not.toHaveProperty("agentusageRoot");
  expect(cfg.roots).toEqual(["~/code"]);
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
// tab_icons — optional harness → icon prefixes for the tmux renamer
// ---------------------------------------------------------------------------

test("tabIcons defaults to an empty map when the file or key is absent", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  expect(resolveConfig().tabIcons).toEqual({});
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveConfig().tabIcons).toEqual({});
});

test("tab_icons resolves valid harness mappings and trims their values", () => {
  writeConfig('tab_icons:\n  pi: " 󰏿 "\n  claude: "󰛄"\n');
  expect(resolveConfig().tabIcons).toEqual({ pi: "󰏿", claude: "󰛄" });
});

test("tab_icons skips malformed entries without disturbing valid siblings", () => {
  writeConfig('tab_icons:\n  pi: "󰏿"\n  claude: 42\n  empty: "   "\n');
  expect(resolveConfig().tabIcons).toEqual({ pi: "󰏿" });
});

test("resolveTabIcons rejects a malformed whole value to the empty default", () => {
  expect(resolveTabIcons(["pi", "󰏿"])).toEqual({});
  expect(resolveTabIcons("pi=󰏿")).toEqual({});
  expect(resolveTabIcons(null)).toEqual({});
});

// ---------------------------------------------------------------------------
// autoclose_enabled / autoclose_grace_seconds (fn-1107) — the FIRST boolean-ish
// and numeric keys in the config corpus. The off-switch is deliberately
// generous; the pure resolvers carry the parse contract and are unit-tested
// directly for the values YAML can't cleanly express (NaN / Infinity).
// ---------------------------------------------------------------------------

test("autoclose defaults: absent file → enabled + 30s grace", () => {
  process.env.KEEPER_CONFIG = join(dir, "does-not-exist.yaml");
  const cfg = resolveConfig();
  expect(cfg.autocloseEnabled).toBe(true);
  expect(cfg.autocloseGraceSeconds).toBe(30);
});

test("autoclose defaults: absent keys → enabled + 30s grace", () => {
  writeConfig("roots:\n  - ~/code\n");
  const cfg = resolveConfig();
  expect(cfg.autocloseEnabled).toBe(true);
  expect(cfg.autocloseGraceSeconds).toBe(30);
});

test("autoclose_enabled: boolean false disables", () => {
  writeConfig("autoclose_enabled: false\n");
  expect(resolveConfig().autocloseEnabled).toBe(false);
});

test("autoclose_enabled: boolean true stays enabled", () => {
  writeConfig("autoclose_enabled: true\n");
  expect(resolveConfig().autocloseEnabled).toBe(true);
});

for (const form of ["false", "off", "no", "0", "OFF", "  No  "]) {
  test(`autoclose_enabled: string ${JSON.stringify(form)} disables (trimmed, case-insensitive)`, () => {
    writeConfig(`autoclose_enabled: ${JSON.stringify(form)}\n`);
    expect(resolveConfig().autocloseEnabled).toBe(false);
  });
}

test("autoclose_enabled: an unrelated string stays enabled (any other value → on)", () => {
  writeConfig('autoclose_enabled: "maybe"\n');
  expect(resolveConfig().autocloseEnabled).toBe(true);
});

test("autoclose_enabled is re-read on each resolveConfig call (no restart to flip)", () => {
  writeConfig("autoclose_enabled: false\n");
  expect(resolveConfig().autocloseEnabled).toBe(false);
  // Flip the file back on and re-resolve — the new value lands with no restart.
  writeConfig("autoclose_enabled: true\n");
  expect(resolveConfig().autocloseEnabled).toBe(true);
});

test("autoclose keys resolve independently of a malformed sibling key", () => {
  writeConfig("roots: not-a-list\nautoclose_enabled: false\n");
  const cfg = resolveConfig();
  expect(cfg.autocloseEnabled).toBe(false);
  expect(cfg.roots.length).toBeGreaterThan(0);
});

test("autoclose_grace_seconds: a positive number overrides", () => {
  writeConfig("autoclose_grace_seconds: 45\n");
  expect(resolveConfig().autocloseGraceSeconds).toBe(45);
});

for (const [label, yaml] of [
  ["zero", "autoclose_grace_seconds: 0\n"],
  ["negative", "autoclose_grace_seconds: -5\n"],
  ["a string", 'autoclose_grace_seconds: "soon"\n'],
] as const) {
  test(`autoclose_grace_seconds: ${label} falls back to 30`, () => {
    writeConfig(yaml);
    expect(resolveConfig().autocloseGraceSeconds).toBe(30);
  });
}

// The pure resolvers carry the whole parse contract — unit-tested directly for
// the boolean / numeric edge values a YAML round-trip can't reliably express.
test("resolveAutocloseEnabled: boolean false + every disable string → false; else true", () => {
  expect(resolveAutocloseEnabled(false)).toBe(false);
  for (const s of ["false", "off", "no", "0", "OFF", " Off "]) {
    expect(resolveAutocloseEnabled(s)).toBe(false);
  }
  // Absent, boolean true, numeric 0 (NOT the string "0"), and any other string
  // are all enabled per the documented contract.
  expect(resolveAutocloseEnabled(undefined)).toBe(true);
  expect(resolveAutocloseEnabled(true)).toBe(true);
  expect(resolveAutocloseEnabled(0)).toBe(true);
  expect(resolveAutocloseEnabled("yes")).toBe(true);
});

test("resolveAutocloseGraceSeconds: positive finite wins; NaN / Infinity / <=0 / non-number → 30", () => {
  expect(resolveAutocloseGraceSeconds(45)).toBe(45);
  expect(resolveAutocloseGraceSeconds(0.5)).toBe(0.5);
  expect(resolveAutocloseGraceSeconds(0)).toBe(30);
  expect(resolveAutocloseGraceSeconds(-1)).toBe(30);
  expect(resolveAutocloseGraceSeconds(Number.NaN)).toBe(30);
  expect(resolveAutocloseGraceSeconds(Number.POSITIVE_INFINITY)).toBe(30);
  expect(resolveAutocloseGraceSeconds("30")).toBe(30);
  expect(resolveAutocloseGraceSeconds(undefined)).toBe(30);
});
