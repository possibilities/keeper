/**
 * Global-instruction guard pins. `ensureCanonicalStowLinks` is generalized into
 * a per-harness leaf table: claude's CLAUDE.md, codex's AGENTS.md, and pi's
 * canonical AGENTS.md all re-link to the ONE keeper-owned system/shared/AGENTS.md,
 * with a per-leaf hard-error (claude, keeper-owned) vs warn-and-respect (codex/pi,
 * human-owned) split on a divergent regular-file clobber.
 *
 * Claude's `settings.json` is a SEPARATE, lesser mechanism: install-time seeding
 * only (create when absent), never the compare/repair/throw treatment above —
 * pinned in its own section below. There is no Keeper-owned profile farm: the
 * HOME-rooted orchestrators (`ensureClaudeStateSharing` / `ensurePiStateSharing`)
 * never create or scan `.claude-profiles` / `.pi-profiles`.
 */

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
  ensureCodexStateSharing,
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
// the divergence branch); parallelize them across the claude / codex / pi doc
// leaves so each harness's byte-compared AGENTS.md/CLAUDE.md leaf is pinned.
const DOC_LEAF_CASES = [
  { harness: "claude", onDivergence: "error" as const },
  { harness: "codex", onDivergence: "warn" as const },
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
    return [{ source: sharedSrc, linkPath, onDivergence }, linkPath];
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
});

// Claude's settings.json is NOT a CanonicalStowLeaf: it is seeded ONCE (when
// entirely absent) and then permanently hands-off — no compare, no repair, no
// reject, no launch-blocking, regardless of what later sits at the path.
describe("ensureClaudeStateSharing — settings.json install-time seed only", () => {
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

  test("seeds settings.json as a symlink when absent", () => {
    const log: string[] = [];
    ensureClaudeStateSharing(log, homeDir, claudeStowDir, null);
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relative(claudeDir, settingsSrc));
    expect(log.some((l) => l.includes("Seeded Claude settings"))).toBe(true);
  });

  test("never touches an existing divergent regular file (no compare, no repair, no throw)", () => {
    writeFileSync(settingsLink, '{"a": 999, "live": true}\n');
    const log: string[] = [];
    expect(() =>
      ensureClaudeStateSharing(log, homeDir, claudeStowDir, null),
    ).not.toThrow();
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(false);
    expect(readFileSync(settingsLink, "utf8")).toBe(
      '{"a": 999, "live": true}\n',
    );
  });

  test("never repairs an existing symlink to the wrong target", () => {
    const wrong = join(tmpDir, "wrong-settings.json");
    writeFileSync(wrong, "{}\n");
    symlinkSync(wrong, settingsLink);
    ensureClaudeStateSharing([], homeDir, claudeStowDir, null);
    expect(readlinkSync(settingsLink)).toBe(wrong);
  });

  test("warns and skips when the stow source is missing, never throws", () => {
    rmSync(settingsSrc);
    const log: string[] = [];
    expect(() =>
      ensureClaudeStateSharing(log, homeDir, claudeStowDir, null),
    ).not.toThrow();
    expect(existsSync(settingsLink)).toBe(false);
    expect(log.some((l) => l.includes("stow source missing"))).toBe(true);
  });

  test("a null claudeStowDir disables seeding entirely (test-only fail-open)", () => {
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

  test("claude: ~/.claude/CLAUDE.md → shared AGENTS.md", () => {
    ensureClaudeStateSharing([], homeDir, null, sharedDir);

    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMd)).toBe(relTo(claudeMd, sharedSrc));
  });

  test("codex: ~/.codex/AGENTS.md → shared AGENTS.md (passthrough-shaped)", () => {
    ensureCodexStateSharing([], homeDir, {}, sharedDir);
    const codexAgents = join(homeDir, ".codex", "AGENTS.md");
    expect(lstatSync(codexAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(codexAgents)).toBe(relTo(codexAgents, sharedSrc));
  });

  test("codex honors CODEX_HOME for the leaf link path (keeper only reads it)", () => {
    const codexHome = join(tmpDir, "custom-codex");
    ensureCodexStateSharing([], homeDir, { CODEX_HOME: codexHome }, sharedDir);
    // The leaf lands under CODEX_HOME, and the default ~/.codex is untouched.
    const codexAgents = join(codexHome, "AGENTS.md");
    expect(lstatSync(codexAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(codexAgents)).toBe(relTo(codexAgents, sharedSrc));
    expect(existsSync(join(homeDir, ".codex", "AGENTS.md"))).toBe(false);
  });

  test("pi: ~/.pi/agent/AGENTS.md → shared AGENTS.md, plus a sessions dir", () => {
    ensurePiStateSharing([], homeDir, sharedDir, {});
    const piAgents = join(homeDir, ".pi", "agent", "AGENTS.md");
    expect(lstatSync(piAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(piAgents)).toBe(relTo(piAgents, sharedSrc));
    expect(existsSync(join(homeDir, ".pi", "agent", "sessions"))).toBe(true);
  });

  test("codex leaves a human-edited AGENTS.md in place (warn, no throw)", () => {
    const codexDir = join(homeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const codexAgents = join(codexDir, "AGENTS.md");
    writeFileSync(codexAgents, "# my own codex instructions\n");
    const log: string[] = [];
    expect(() =>
      ensureCodexStateSharing(log, homeDir, {}, sharedDir),
    ).not.toThrow();
    expect(lstatSync(codexAgents).isSymbolicLink()).toBe(false);
    expect(readFileSync(codexAgents, "utf8")).toBe(
      "# my own codex instructions\n",
    );
    expect(log.some((l) => l.startsWith("WARNING"))).toBe(true);
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

  test("the real claude wiring seeds settings.json and links CLAUDE.md from absent", () => {
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
