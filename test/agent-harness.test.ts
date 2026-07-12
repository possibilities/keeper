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

const DASH_PROMPT_GUARDS: ReadonlySet<string> = new Set([
  "double-dash",
  "equals-join",
  "unsupported",
]);

const SECOND_AXES: ReadonlySet<SecondAxis> = new Set([
  "effort",
  "thinking",
  "none",
]);
const HOOK_MECHANISMS: ReadonlySet<string> = new Set([
  "claude-hooks",
  "pi-extension",
  "codex-rollout-tail",
  "none",
]);

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
      expect(SECOND_AXES.has(d.secondAxis)).toBe(true);
      expect(typeof d.capturable).toBe("boolean");
      expect(typeof d.mintsOwnSessionId).toBe("boolean");
      expect(HOOK_MECHANISMS.has(d.hookMechanism)).toBe(true);
      expect(["flag", "subcommand"]).toContain(d.resumeArgv.kind);
      expect(typeof d.resumeArgv.token).toBe("string");
      expect(d.resumeArgv.token.length).toBeGreaterThan(0);
      expect(DASH_PROMPT_GUARDS.has(d.resumeLaunch.dashGuard)).toBe(true);
    }
  });

  test("the registry has exactly the HARNESS_NAMES roster (no stray keys)", () => {
    expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual(
      [...HARNESS_NAMES].sort(),
    );
  });

  test("per-harness facts are pinned (claude/codex/pi/hermes)", () => {
    expect(HARNESS_DESCRIPTORS.claude.displayName).toBe("Claude");
    expect(HARNESS_DESCRIPTORS.codex.displayName).toBe("Codex");
    expect(HARNESS_DESCRIPTORS.pi.displayName).toBe("Pi");
    expect(HARNESS_DESCRIPTORS.hermes.displayName).toBe("Hermes");
    // Second axis: claude/codex take effort, pi takes thinking, hermes is
    // model-only (none).
    expect(HARNESS_DESCRIPTORS.claude.secondAxis).toBe("effort");
    expect(HARNESS_DESCRIPTORS.codex.secondAxis).toBe("effort");
    expect(HARNESS_DESCRIPTORS.pi.secondAxis).toBe("thinking");
    expect(HARNESS_DESCRIPTORS.hermes.secondAxis).toBe("none");
    // Session identity: codex + hermes mint their own id keeper can't pin at launch.
    expect(HARNESS_DESCRIPTORS.codex.mintsOwnSessionId).toBe(true);
    expect(HARNESS_DESCRIPTORS.hermes.mintsOwnSessionId).toBe(true);
    expect(HARNESS_DESCRIPTORS.claude.mintsOwnSessionId).toBe(false);
    expect(HARNESS_DESCRIPTORS.pi.mintsOwnSessionId).toBe(false);
    // Live-churn mechanism: claude via native hooks, pi via the in-process
    // extension (M3b), codex via the daemon-side rollout tailer (stop-only);
    // hermes is presence-only today.
    expect(HARNESS_DESCRIPTORS.claude.hookMechanism).toBe("claude-hooks");
    expect(HARNESS_DESCRIPTORS.codex.hookMechanism).toBe("codex-rollout-tail");
    expect(HARNESS_DESCRIPTORS.pi.hookMechanism).toBe("pi-extension");
    expect(HARNESS_DESCRIPTORS.hermes.hookMechanism).toBe("none");
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
    expect(isHarnessName("hermes")).toBe(true);
    expect(isHarnessName("grok")).toBe(false);
    expect(isHarnessName("")).toBe(false);
  });

  test("harnessDescriptor resolves known names and returns undefined otherwise", () => {
    expect(harnessDescriptor("claude")).toBe(HARNESS_DESCRIPTORS.claude);
    expect(harnessDescriptor("hermes")).toBe(HARNESS_DESCRIPTORS.hermes);
    expect(harnessDescriptor("grok")).toBeUndefined();
  });

  test("resumeArgv forms are pinned per harness (codex is the verb-position subcommand)", () => {
    expect(HARNESS_DESCRIPTORS.claude.resumeArgv).toEqual({
      kind: "flag",
      token: "--resume",
    });
    // Codex resumes via a VERB-POSITION subcommand, not an option flag.
    expect(HARNESS_DESCRIPTORS.codex.resumeArgv).toEqual({
      kind: "subcommand",
      token: "resume",
    });
    expect(HARNESS_DESCRIPTORS.pi.resumeArgv).toEqual({
      kind: "flag",
      token: "--session",
    });
    expect(HARNESS_DESCRIPTORS.hermes.resumeArgv).toEqual({
      kind: "flag",
      token: "--resume",
    });
  });

  test("resumeLaunch dash-prompt guard is pinned per harness (probe-verified live)", () => {
    // claude/codex: a live-probed `--` end-of-options guard reliably ends
    // option parsing (docs/adr/0034 + this task's own claude/codex probes).
    expect(HARNESS_DESCRIPTORS.claude.resumeLaunch).toEqual({
      dashGuard: "double-dash",
    });
    expect(HARNESS_DESCRIPTORS.codex.resumeLaunch).toEqual({
      dashGuard: "double-dash",
    });
    // pi: probe-verified NEITHER `--` nor an `=`-joined form is safe for its
    // bare positional prompt — a resume-launch builder must fail loud.
    expect(HARNESS_DESCRIPTORS.pi.resumeLaunch).toEqual({
      dashGuard: "unsupported",
    });
    // hermes: probe-verified only the `=`-joined oneshot form is safe.
    expect(HARNESS_DESCRIPTORS.hermes.resumeLaunch).toEqual({
      dashGuard: "equals-join",
    });
  });

  test("buildHarnessResumeArgv emits the [token, target] pair, defaulting unknown/NULL to claude", () => {
    expect(buildHarnessResumeArgv("claude", "u")).toEqual(["--resume", "u"]);
    expect(buildHarnessResumeArgv("codex", "r")).toEqual(["resume", "r"]);
    expect(buildHarnessResumeArgv("pi", "p")).toEqual(["--session", "p"]);
    expect(buildHarnessResumeArgv("hermes", "h")).toEqual(["--resume", "h"]);
    // NULL/unknown ⇒ claude form.
    expect(buildHarnessResumeArgv(null, "u")).toEqual(["--resume", "u"]);
    expect(buildHarnessResumeArgv("grok", "u")).toEqual(["--resume", "u"]);
  });

  test("harnessOrClaude normalizes NULL/empty/unknown to claude, passing known names through", () => {
    expect(harnessOrClaude(null)).toBe("claude");
    expect(harnessOrClaude(undefined)).toBe("claude");
    expect(harnessOrClaude("")).toBe("claude");
    expect(harnessOrClaude("  ")).toBe("claude");
    expect(harnessOrClaude("grok")).toBe("claude");
    expect(harnessOrClaude("codex")).toBe("codex");
    expect(harnessOrClaude("hermes")).toBe("hermes");
  });

  test("isCapturableHarness reads the capability, defaulting unknown to false", () => {
    // Panel eligibility gates on this — all four current harnesses are capturable.
    expect(isCapturableHarness("claude")).toBe(true);
    expect(isCapturableHarness("codex")).toBe(true);
    expect(isCapturableHarness("pi")).toBe(true);
    expect(isCapturableHarness("hermes")).toBe(true);
    // An unknown harness is not panel-eligible.
    expect(isCapturableHarness("grok")).toBe(false);
  });
});

describe("harness registry — parallel unions derive from it", () => {
  test("AGENT_CLIS (launch-config) is the registry name set", () => {
    expect([...AGENT_CLIS].sort()).toEqual([...HARNESS_NAMES].sort());
  });
});

describe("buildResumeLaunchPromptTail — per-harness dash-prompt guard", () => {
  test("double-dash (claude, codex): always [--, prompt], even for a normal prompt", () => {
    expect(buildResumeLaunchPromptTail("claude", "hello")).toEqual([
      "--",
      "hello",
    ]);
    expect(buildResumeLaunchPromptTail("codex", "hello")).toEqual([
      "--",
      "hello",
    ]);
  });

  test("double-dash (claude, codex): a leading-dash prompt rides safely behind --", () => {
    expect(buildResumeLaunchPromptTail("claude", "-dash-prompt")).toEqual([
      "--",
      "-dash-prompt",
    ]);
    expect(buildResumeLaunchPromptTail("codex", "-dash-prompt")).toEqual([
      "--",
      "-dash-prompt",
    ]);
  });

  test("equals-join (hermes): folds the prompt onto the owning flag with =, even for a normal prompt", () => {
    expect(buildResumeLaunchPromptTail("hermes", "hello", "-z")).toEqual([
      "-z=hello",
    ]);
  });

  test("equals-join (hermes): a leading-dash prompt rides safely joined, never as a separate token", () => {
    expect(buildResumeLaunchPromptTail("hermes", "-dash-prompt", "-z")).toEqual(
      ["-z=-dash-prompt"],
    );
  });

  test("equals-join (hermes) without a joinFlagToken throws ResumeLaunchUnsupportedError", () => {
    expect(() => buildResumeLaunchPromptTail("hermes", "hello")).toThrow(
      ResumeLaunchUnsupportedError,
    );
  });

  test("unsupported (pi): a normal prompt passes through unchanged", () => {
    expect(buildResumeLaunchPromptTail("pi", "hello world")).toEqual([
      "hello world",
    ]);
  });

  test("unsupported (pi): a leading-dash prompt fails loud — never silently dropped or misrouted", () => {
    expect(() => buildResumeLaunchPromptTail("pi", "-dash-prompt")).toThrow(
      ResumeLaunchUnsupportedError,
    );
  });

  test("unknown/NULL harness defaults to claude's double-dash guard", () => {
    expect(buildResumeLaunchPromptTail(null, "hello")).toEqual(["--", "hello"]);
    expect(buildResumeLaunchPromptTail("grok", "hello")).toEqual([
      "--",
      "hello",
    ]);
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

  test("a launch triple naming an unknown harness is rejected at catalog load", () => {
    const p = join(tmpDir, "presets.yaml");
    writeFileSync(p, "claude_default: grok::opus::high\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
    // The one place the harness roster is enforced — the registry-derived set.
    expect(() => loadPresetCatalog(p)).toThrow(/claude\|codex\|pi\|hermes/);
  });
});
