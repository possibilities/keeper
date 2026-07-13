import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadPresetCatalog } from "../src/agent/config";
import { splitSubcommand } from "../src/agent/dispatch";
import {
  buildHarnessResumeArgv,
  buildResumeLaunchPromptTail,
  HARNESS_DESCRIPTORS,
  HARNESS_NAME_SET,
  HARNESS_NAMES,
  harnessDescriptor,
  harnessOrClaude,
  isCapturableHarness,
  isHarnessName,
  ResumeLaunchUnsupportedError,
  type SecondAxis,
} from "../src/agent/harness";
import { AGENT_CLIS } from "../src/agent/launch-config";

const SECOND_AXES: ReadonlySet<SecondAxis> = new Set([
  "effort",
  "thinking",
  "none",
]);

const HOOK_MECHANISMS = new Set(["claude-hooks", "pi-extension", "none"]);

describe("harness registry", () => {
  test("contains only supported harnesses with complete descriptors", () => {
    expect(HARNESS_NAMES).toEqual(["claude", "pi", "hermes"]);
    expect(Object.keys(HARNESS_DESCRIPTORS)).toEqual([...HARNESS_NAMES]);
    for (const name of HARNESS_NAMES) {
      const descriptor = HARNESS_DESCRIPTORS[name];
      expect(descriptor.name).toBe(name);
      expect(descriptor.displayName.length).toBeGreaterThan(0);
      expect(descriptor.binaryName.length).toBeGreaterThan(0);
      expect(SECOND_AXES.has(descriptor.secondAxis)).toBe(true);
      expect(HOOK_MECHANISMS.has(descriptor.hookMechanism)).toBe(true);
      expect(descriptor.resumeArgv.token.length).toBeGreaterThan(0);
    }
  });

  test("membership and derived CLI sets reject the retired harness", () => {
    expect([...HARNESS_NAME_SET]).toEqual([...HARNESS_NAMES]);
    expect([...AGENT_CLIS]).toEqual([...HARNESS_NAMES]);
    expect(isHarnessName("claude")).toBe(true);
    expect(isHarnessName("pi")).toBe(true);
    expect(isHarnessName("hermes")).toBe(true);
    expect(isHarnessName("codex")).toBe(false);
    expect(harnessDescriptor("codex")).toBeUndefined();
    expect(isCapturableHarness("codex")).toBe(false);
    expect(splitSubcommand(["codex"])).toEqual({
      kind: "usage",
      unknown: "codex",
    });
  });

  test("per-harness capabilities remain intact", () => {
    expect(HARNESS_DESCRIPTORS.claude.secondAxis).toBe("effort");
    expect(HARNESS_DESCRIPTORS.pi.secondAxis).toBe("thinking");
    expect(HARNESS_DESCRIPTORS.hermes.secondAxis).toBe("none");
    expect(HARNESS_DESCRIPTORS.claude.hookMechanism).toBe("claude-hooks");
    expect(HARNESS_DESCRIPTORS.pi.hookMechanism).toBe("pi-extension");
    expect(HARNESS_DESCRIPTORS.hermes.hookMechanism).toBe("none");
    expect(HARNESS_DESCRIPTORS.hermes.mintsOwnSessionId).toBe(true);
  });

  test("resume argv forms are descriptor-driven", () => {
    expect(buildHarnessResumeArgv("claude", "c")).toEqual(["--resume", "c"]);
    expect(buildHarnessResumeArgv("pi", "p")).toEqual(["--session", "p"]);
    expect(buildHarnessResumeArgv("hermes", "h")).toEqual(["--resume", "h"]);
  });

  test("only null or empty stored harnesses normalize to claude", () => {
    expect(harnessOrClaude(null)).toBe("claude");
    expect(harnessOrClaude(undefined)).toBe("claude");
    expect(harnessOrClaude("  ")).toBe("claude");
    expect(harnessOrClaude("pi")).toBe("pi");
    expect(() => harnessOrClaude("codex")).toThrow("unknown harness 'codex'");
    expect(() => buildHarnessResumeArgv("codex", "x")).toThrow(
      "unknown harness 'codex'",
    );
  });
});

describe("resume prompt guards", () => {
  test("claude uses an end-of-options guard", () => {
    expect(buildResumeLaunchPromptTail("claude", "-ask")).toEqual([
      "--",
      "-ask",
    ]);
  });

  test("pi rejects a leading-dash prompt", () => {
    expect(buildResumeLaunchPromptTail("pi", "hello")).toEqual(["hello"]);
    expect(() => buildResumeLaunchPromptTail("pi", "-ask")).toThrow(
      ResumeLaunchUnsupportedError,
    );
  });

  test("hermes joins its prompt flag", () => {
    expect(buildResumeLaunchPromptTail("hermes", "-ask", "-z")).toEqual([
      "-z=-ask",
    ]);
    expect(() => buildResumeLaunchPromptTail("hermes", "ask")).toThrow(
      ResumeLaunchUnsupportedError,
    );
  });
});

describe("retired harness config", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-harness-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a Codex triple is rejected as an unregistered harness", () => {
    const path = join(tmpDir, "presets.yaml");
    writeFileSync(path, "claude_default: codex::gpt-5.5::high\n");
    expect(() => loadPresetCatalog(path)).toThrow(ConfigError);
    expect(() => loadPresetCatalog(path)).toThrow(/claude\|pi\|hermes/);
  });

  test("the retired default key is an unknown active configuration surface", () => {
    const path = join(tmpDir, "presets.yaml");
    writeFileSync(path, "codex_default: codex::gpt-5.5::high\n");
    expect(() => loadPresetCatalog(path)).toThrow(/Unknown top-level key/);
  });
});
