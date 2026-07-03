/**
 * Per-harness descriptor registry pins (`src/agent/harness.ts`). The registry is
 * the single source of truth for which harnesses keeper drives; every parallel
 * harness union derives from it. These tests assert (a) every descriptor field is
 * defined for every harness, (b) the derivation root is internally consistent, (c)
 * the exported unions actually derive from it, and (d) an unknown harness name
 * fails loud at config load — the "harness name lives in exactly one place"
 * contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadPresetCatalog } from "../src/agent/config";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_NAME_SET,
  HARNESS_NAMES,
  harnessDescriptor,
  isCapturableHarness,
  isHarnessName,
  type SecondAxis,
} from "../src/agent/harness";
import { AGENT_CLIS } from "../src/agent/launch-config";

const SECOND_AXES: ReadonlySet<SecondAxis> = new Set([
  "effort",
  "thinking",
  "none",
]);
const HOOK_MECHANISMS: ReadonlySet<string> = new Set(["claude-hooks", "none"]);

describe("harness registry — descriptor completeness", () => {
  test("every harness has a fully-defined descriptor keyed by its own name", () => {
    for (const name of HARNESS_NAMES) {
      const d = HARNESS_DESCRIPTORS[name];
      expect(d).toBeDefined();
      // The descriptor's `name` must match its registry key (no copy-paste drift).
      expect(d.name).toBe(name);
      expect(typeof d.displayName).toBe("string");
      expect(d.displayName.length).toBeGreaterThan(0);
      expect(typeof d.binaryName).toBe("string");
      expect(d.binaryName.length).toBeGreaterThan(0);
      expect(typeof d.profileEnvVar).toBe("string");
      expect(d.profileEnvVar.length).toBeGreaterThan(0);
      expect(SECOND_AXES.has(d.secondAxis)).toBe(true);
      expect(typeof d.capturable).toBe("boolean");
      expect(typeof d.mintsOwnSessionId).toBe("boolean");
      expect(HOOK_MECHANISMS.has(d.hookMechanism)).toBe(true);
    }
  });

  test("the registry has exactly the HARNESS_NAMES roster (no stray keys)", () => {
    expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual(
      [...HARNESS_NAMES].sort(),
    );
  });

  test("per-harness facts are pinned (claude/codex/pi)", () => {
    expect(HARNESS_DESCRIPTORS.claude.displayName).toBe("Claude");
    expect(HARNESS_DESCRIPTORS.codex.displayName).toBe("Codex");
    expect(HARNESS_DESCRIPTORS.pi.displayName).toBe("Pi");
    // Second axis: claude/codex take effort, pi takes thinking.
    expect(HARNESS_DESCRIPTORS.claude.secondAxis).toBe("effort");
    expect(HARNESS_DESCRIPTORS.codex.secondAxis).toBe("effort");
    expect(HARNESS_DESCRIPTORS.pi.secondAxis).toBe("thinking");
    // Session identity: only codex mints its own id keeper can't pin at launch.
    expect(HARNESS_DESCRIPTORS.codex.mintsOwnSessionId).toBe(true);
    expect(HARNESS_DESCRIPTORS.claude.mintsOwnSessionId).toBe(false);
    expect(HARNESS_DESCRIPTORS.pi.mintsOwnSessionId).toBe(false);
    // Only claude has a native hook channel today.
    expect(HARNESS_DESCRIPTORS.claude.hookMechanism).toBe("claude-hooks");
    expect(HARNESS_DESCRIPTORS.codex.hookMechanism).toBe("none");
    expect(HARNESS_DESCRIPTORS.pi.hookMechanism).toBe("none");
    // Profile env vars are the KEEPER_AGENT_<X>_PROFILE names main() consumes.
    expect(HARNESS_DESCRIPTORS.claude.profileEnvVar).toBe(
      "KEEPER_AGENT_CLAUDE_PROFILE",
    );
    expect(HARNESS_DESCRIPTORS.codex.profileEnvVar).toBe(
      "KEEPER_AGENT_CODEX_PROFILE",
    );
    expect(HARNESS_DESCRIPTORS.pi.profileEnvVar).toBe(
      "KEEPER_AGENT_PI_PROFILE",
    );
  });
});

describe("harness registry — membership + capability predicates", () => {
  test("HARNESS_NAME_SET matches the HARNESS_NAMES roster", () => {
    expect([...HARNESS_NAME_SET].sort()).toEqual([...HARNESS_NAMES].sort());
  });

  test("isHarnessName is true for known names, false for an unknown one", () => {
    for (const name of HARNESS_NAMES) {
      expect(isHarnessName(name)).toBe(true);
    }
    expect(isHarnessName("hermes")).toBe(false);
    expect(isHarnessName("")).toBe(false);
  });

  test("harnessDescriptor resolves known names and returns undefined otherwise", () => {
    expect(harnessDescriptor("claude")).toBe(HARNESS_DESCRIPTORS.claude);
    expect(harnessDescriptor("hermes")).toBeUndefined();
  });

  test("isCapturableHarness reads the capability, defaulting unknown to false", () => {
    // Panel eligibility gates on this — all three current harnesses are capturable.
    expect(isCapturableHarness("claude")).toBe(true);
    expect(isCapturableHarness("codex")).toBe(true);
    expect(isCapturableHarness("pi")).toBe(true);
    // An unknown / not-yet-capturable harness is not panel-eligible.
    expect(isCapturableHarness("hermes")).toBe(false);
  });
});

describe("harness registry — parallel unions derive from it", () => {
  test("AGENT_CLIS (launch-config) is the registry name set", () => {
    expect([...AGENT_CLIS].sort()).toEqual([...HARNESS_NAMES].sort());
  });
});

describe("harness registry — unknown harness fails loud at load", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-harness-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a preset naming an unknown harness is rejected at catalog load", () => {
    const p = join(tmpDir, "presets.yaml");
    writeFileSync(p, "presets:\n  x:\n    harness: hermes\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
    // The one place the harness roster is enforced — the registry-derived set.
    expect(() => loadPresetCatalog(p)).toThrow(/claude\|codex\|pi/);
  });
});
