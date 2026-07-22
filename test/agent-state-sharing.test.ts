import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  type CanonicalStowLeaf,
  defaultClaudeStowDir,
  defaultSharedStowDir,
  ensureCanonicalStowLinks,
  ensureClaudeStateSharing,
  ensurePiStateSharing,
  StateError,
} from "../src/agent/state-sharing";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-state-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// The four core guard behaviors are IDENTICAL across every leaf (they never touch
// the divergence branch); parallelize them across the Claude and Pi doc leaves.
// Each harness's byte-compared AGENTS.md/CLAUDE.md leaf is pinned.
const DOC_LEAF_CASES = [
  { harness: "claude", onDivergence: "error" as const },
  { harness: "pi", onDivergence: "warn" as const },
];

describe("ensureCanonicalStowLinks — per-leaf behaviors", () => {
  let sharedDir: string;
  let sharedSrc: string;

  const relTo = (link: string, target: string): string =>
    relative(dirname(link), target);

  beforeEach(() => {
    sharedDir = join(tmpDir, "repo", "system", "shared");
    mkdirSync(sharedDir, { recursive: true });
    sharedSrc = join(sharedDir, "AGENTS.md");
    writeFileSync(sharedSrc, "# shared canonical\n");
  });

  for (const { harness, onDivergence } of DOC_LEAF_CASES) {
    const linkPathFor = (): string => join(tmpDir, `leaf-${harness}`, "DOC.md");
    const leaf = (): CanonicalStowLeaf => ({
      source: sharedSrc,
      linkPath: linkPathFor(),
      compare: "bytes",
      onDivergence,
    });

    describe(`${harness} doc leaf`, () => {
      test("creates the relative link when the canonical path is absent", () => {
        const log: string[] = [];
        ensureCanonicalStowLinks([leaf()], log, {});
        expect(lstatSync(linkPathFor()).isSymbolicLink()).toBe(true);
        expect(readlinkSync(linkPathFor())).toBe(
          relTo(linkPathFor(), sharedSrc),
        );
      });

      test("is a no-op when the correct relative link already exists", () => {
        mkdirSync(dirname(linkPathFor()), { recursive: true });
        symlinkSync(relTo(linkPathFor(), sharedSrc), linkPathFor());
        const log: string[] = [];
        ensureCanonicalStowLinks([leaf()], log, {});
        expect(log).toEqual([]);
      });

      test("repairs a symlink pointing at the wrong target (the cutover)", () => {
        const wrong = join(tmpDir, "wrong.md");
        writeFileSync(wrong, "old\n");
        mkdirSync(dirname(linkPathFor()), { recursive: true });
        symlinkSync(wrong, linkPathFor());
        const log: string[] = [];
        ensureCanonicalStowLinks([leaf()], log, {});
        expect(readlinkSync(linkPathFor())).toBe(
          relTo(linkPathFor(), sharedSrc),
        );
        expect(log.some((l) => l.includes("wrong target"))).toBe(true);
      });

      test("relinks an identical regular-file clobber and logs", () => {
        mkdirSync(dirname(linkPathFor()), { recursive: true });
        writeFileSync(linkPathFor(), readFileSync(sharedSrc, "utf8"));
        const log: string[] = [];
        ensureCanonicalStowLinks([leaf()], log, {});
        expect(lstatSync(linkPathFor()).isSymbolicLink()).toBe(true);
        expect(readlinkSync(linkPathFor())).toBe(
          relTo(linkPathFor(), sharedSrc),
        );
        expect(log.some((l) => l.includes("identical clobber"))).toBe(true);
      });
    });
  }
});

describe("ensureCanonicalStowLinks — divergent-clobber split", () => {
  let sharedSrc: string;

  beforeEach(() => {
    const sharedDir = join(tmpDir, "repo", "system", "shared");
    mkdirSync(sharedDir, { recursive: true });
    sharedSrc = join(sharedDir, "AGENTS.md");
    writeFileSync(sharedSrc, "# shared canonical\n");
  });

  const divergentLeaf = (
    onDivergence: "error" | "warn",
  ): [CanonicalStowLeaf, string] => {
    const linkPath = join(tmpDir, `leaf-${onDivergence}`, "DOC.md");
    mkdirSync(dirname(linkPath), { recursive: true });
    writeFileSync(linkPath, "# HUMAN EDIT — do not clobber\n");
    return [
      { source: sharedSrc, linkPath, compare: "bytes", onDivergence },
      linkPath,
    ];
  };

  test("an error leaf (claude) throws StateError and leaves the file untouched", () => {
    const [leaf, linkPath] = divergentLeaf("error");
    expect(() => ensureCanonicalStowLinks([leaf], [], {})).toThrow(StateError);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkPath, "utf8")).toBe(
      "# HUMAN EDIT — do not clobber\n",
    );
  });

  test("a warn leaf (codex/pi) does NOT throw, leaves the file, logs a WARNING", () => {
    const [leaf, linkPath] = divergentLeaf("warn");
    const log: string[] = [];
    expect(() => ensureCanonicalStowLinks([leaf], log, {})).not.toThrow();
    // Live file preserved byte-for-byte, still a regular file (never re-linked).
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(linkPath, "utf8")).toBe(
      "# HUMAN EDIT — do not clobber\n",
    );
    expect(
      log.some((l) => l.startsWith("WARNING") && l.includes(linkPath)),
    ).toBe(true);
  });

  test("a warn leaf preserves a non-file clobber without reading it", () => {
    const linkPath = join(tmpDir, "warn-directory");
    mkdirSync(linkPath);
    const leaf: CanonicalStowLeaf = {
      source: sharedSrc,
      linkPath,
      compare: "bytes",
      onDivergence: "warn",
    };
    const log: string[] = [];
    expect(() => ensureCanonicalStowLinks([leaf], log, {})).not.toThrow();
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    expect(log).toEqual([expect.stringContaining("WARNING")]);
  });
});

describe("ensureClaudeStateSharing — canonical settings.json", () => {
  let homeDir: string;
  let claudeDir: string;
  let claudeStowDir: string;
  let settingsSrc: string;
  let settingsLink: string;

  beforeEach(() => {
    homeDir = join(tmpDir, "home");
    claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    claudeStowDir = join(tmpDir, "repo", "system", "claude", ".claude");
    mkdirSync(claudeStowDir, { recursive: true });
    settingsSrc = join(claudeStowDir, "settings.json");
    writeFileSync(settingsSrc, '{\n  "a": 1,\n  "b": 2\n}\n');
    settingsLink = join(claudeDir, "settings.json");
  });

  test("creates the relative settings symlink when absent", () => {
    const log: string[] = [];
    ensureClaudeStateSharing(log, homeDir, claudeStowDir, null);
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relative(claudeDir, settingsSrc));
    expect(log.some((line) => line.includes("Created canonical"))).toBe(true);
  });

  test("repairs a wrong-target settings symlink and logs", () => {
    const wrong = join(tmpDir, "wrong-settings.json");
    writeFileSync(wrong, "{}\n");
    symlinkSync(wrong, settingsLink);
    const log: string[] = [];
    ensureClaudeStateSharing(log, homeDir, claudeStowDir, null);
    expect(readlinkSync(settingsLink)).toBe(relative(claudeDir, settingsSrc));
    expect(log.some((line) => line.includes("wrong target"))).toBe(true);
  });

  test("relinks semantically equal JSON despite formatting and key order", () => {
    writeFileSync(settingsLink, '{"b":2,"a":1}');
    const log: string[] = [];
    ensureClaudeStateSharing(log, homeDir, claudeStowDir, null);
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relative(claudeDir, settingsSrc));
    expect(log.some((line) => line.includes("identical clobber"))).toBe(true);
  });

  test("treats __proto__ as data when comparing semantic JSON", () => {
    writeFileSync(settingsLink, '{"a":1,"b":2,"__proto__":{"hook":true}}\n');
    expect(() =>
      ensureClaudeStateSharing([], homeDir, claudeStowDir, null),
    ).toThrow(StateError);
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(false);
  });

  test("blocks divergent JSON, preserves it, and prints recovery choices", () => {
    const divergent = '{"a":999,"live":true}\n';
    writeFileSync(settingsLink, divergent);
    let thrown: unknown;
    try {
      ensureClaudeStateSharing([], homeDir, claudeStowDir, null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateError);
    const message = (thrown as Error).message;
    expect(message).toContain("diff -u");
    expect(message).toContain("Discard the live file");
    expect(message).toContain("Keep the live file");
    expect(message).toContain("KEEPER_AGENT_SKIP_LINK_GUARD=1");
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(false);
    expect(readFileSync(settingsLink, "utf8")).toBe(divergent);
  });

  test("recovery commands shell-quote paths containing spaces and apostrophes", () => {
    const unusualHome = join(tmpDir, "home with 'quote");
    const unusualClaude = join(unusualHome, ".claude");
    mkdirSync(unusualClaude, { recursive: true });
    writeFileSync(join(unusualClaude, "settings.json"), '{"a":999}\n');
    let message = "";
    try {
      ensureClaudeStateSharing([], unusualHome, claudeStowDir, null);
    } catch (error) {
      message = (error as Error).message;
    }
    const commands = message
      .split("\n")
      .filter((line) => /^( {2}diff | {2}rm | {2}cp )/.test(line));
    expect(message).toContain("home with '\\''quote");
    expect(message).not.toContain("'home with 'quote");
    expect(commands).toHaveLength(4);
  });

  test("refuses a non-file clobber without reading or removing it", () => {
    mkdirSync(settingsLink);
    let thrown: unknown;
    try {
      ensureClaudeStateSharing([], homeDir, claudeStowDir, null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateError);
    expect((thrown as Error).message).toContain("unsupported filesystem type");
    expect(lstatSync(settingsLink).isDirectory()).toBe(true);
  });

  test("warns and skips when the repository settings source is missing", () => {
    rmSync(settingsSrc);
    const log: string[] = [];
    ensureClaudeStateSharing(log, homeDir, claudeStowDir, null);
    expect(existsSync(settingsLink)).toBe(false);
    expect(log.some((line) => line.includes("stow source missing"))).toBe(true);
  });

  test("the bypass leaves a divergent regular file untouched and logs loudly", () => {
    const divergent = '{"a":999}\n';
    writeFileSync(settingsLink, divergent);
    const leaves: CanonicalStowLeaf[] = [
      {
        source: settingsSrc,
        linkPath: settingsLink,
        compare: "json",
        onDivergence: "error",
      },
    ];
    const log: string[] = [];
    ensureCanonicalStowLinks(leaves, log, {
      KEEPER_AGENT_SKIP_LINK_GUARD: "1",
    });
    expect(readFileSync(settingsLink, "utf8")).toBe(divergent);
    expect(log).toEqual([
      expect.stringContaining("settings and harness global-instruction"),
    ]);
  });

  test("a null claudeStowDir disables the settings leaf", () => {
    ensureClaudeStateSharing([], homeDir, null, null);
    expect(existsSync(settingsLink)).toBe(false);
  });
});

// Each harness's real state-sharing entry, run against a sandboxed HOME + a temp
// shared source, must land its global-instruction leaf as a symlink resolving to
// the ONE shared AGENTS.md — and never create or scan a profile-farm directory.
describe("per-harness wiring resolves the leaf to the shared source", () => {
  let homeDir: string;
  let sharedDir: string;
  let sharedSrc: string;

  const relTo = (link: string, target: string): string =>
    relative(dirname(link), target);

  beforeEach(() => {
    homeDir = join(tmpDir, "home");
    mkdirSync(homeDir, { recursive: true });
    sharedDir = join(tmpDir, "repo", "system", "shared");
    mkdirSync(sharedDir, { recursive: true });
    sharedSrc = join(sharedDir, "AGENTS.md");
    writeFileSync(sharedSrc, "# shared canonical\n");
  });

  test("claude: settings.json → Claude source and CLAUDE.md → shared AGENTS.md", () => {
    const claudeStow = join(tmpDir, "repo", "system", "claude", ".claude");
    mkdirSync(claudeStow, { recursive: true });
    const settingsSrc = join(claudeStow, "settings.json");
    writeFileSync(settingsSrc, "{}\n");

    ensureClaudeStateSharing([], homeDir, claudeStow, sharedDir);

    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMd)).toBe(relTo(claudeMd, sharedSrc));
    const settingsLink = join(homeDir, ".claude", "settings.json");
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relTo(settingsLink, settingsSrc));
  });

  test("pi: ~/.pi/agent/AGENTS.md → shared AGENTS.md, plus a sessions dir", () => {
    ensurePiStateSharing([], homeDir, sharedDir, {});
    const piAgents = join(homeDir, ".pi", "agent", "AGENTS.md");
    expect(lstatSync(piAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(piAgents)).toBe(relTo(piAgents, sharedSrc));
    expect(existsSync(join(homeDir, ".pi", "agent", "sessions"))).toBe(true);
  });

  test("no profile farm: claude and pi state sharing create no .claude-profiles or .pi-profiles dir", () => {
    ensureClaudeStateSharing([], homeDir, null, sharedDir);
    ensurePiStateSharing([], homeDir, sharedDir, {});
    expect(existsSync(join(homeDir, ".claude-profiles"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi-profiles"))).toBe(false);
  });
});

describe("defaultSharedStowDir", () => {
  test("resolves to the repo's system/shared with the real AGENTS.md present", () => {
    const dir = defaultSharedStowDir();
    expect(dir.endsWith(join("system", "shared"))).toBe(true);
    const agents = join(dir, "AGENTS.md");
    expect(existsSync(agents)).toBe(true);
    // The doc leaves MUST source from the REAL file, never a symlink, or readlink
    // would churn across launches.
    expect(lstatSync(agents).isSymbolicLink()).toBe(false);
  });
});

describe("defaultClaudeStowDir", () => {
  test("resolves to the repo's system/claude/.claude with both leaves present", () => {
    const dir = defaultClaudeStowDir();
    expect(dir.endsWith(join("system", "claude", ".claude"))).toBe(true);
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    // CLAUDE.md is now a symlink into ../../shared/AGENTS.md — existsSync follows it.
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  test("the real Claude wiring enforces settings.json and CLAUDE.md from absent", () => {
    const home = join(tmpDir, "guard-home");
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeStow = defaultClaudeStowDir();
    const sharedStow = defaultSharedStowDir();

    ensureClaudeStateSharing([], home, claudeStow, sharedStow);

    const settingsLink = join(claudeDir, "settings.json");
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(
      relative(claudeDir, join(claudeStow, "settings.json")),
    );
    const claudeMdLink = join(claudeDir, "CLAUDE.md");
    expect(lstatSync(claudeMdLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMdLink)).toBe(
      relative(claudeDir, join(sharedStow, "AGENTS.md")),
    );
  });
});
