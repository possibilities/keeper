/**
 * Symlink-farm pins for the path-explicit helpers: forceSymlink is idempotent
 * and replaces a stale link, refuses to clobber a real directory; and
 * ensureProfileClaudeJson force-merges onboarding/theme/trust defaults,
 * rebuilds a corrupt file, and is a no-op once converged. The HOME-rooted
 * orchestrator (ensureClaudeStateSharing) is exercised end-to-end in the parity
 * matrix; here we pin the leaf behaviors that compose it.
 *
 * The canonical-link guard (ensureCanonicalStowLinks) is generalized into a
 * per-harness leaf table: claude's CLAUDE.md, codex's AGENTS.md, and pi's
 * canonical AGENTS.md all re-link to the ONE keeper-owned system/shared/AGENTS.md,
 * with a per-leaf hard-error (claude, keeper-owned) vs warn-and-respect (codex/pi,
 * human-owned) split on a divergent regular-file clobber.
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
  ensureProfileClaudeJson,
  forceSymlink,
  StateError,
} from "../src/agent/state-sharing";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-state-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("forceSymlink", () => {
  test("creates the link and reports changed", () => {
    const target = join(tmpDir, "target.json");
    writeFileSync(target, "{}\n");
    const link = join(tmpDir, "link.json");
    expect(forceSymlink(link, target)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  test("is idempotent (a same-target link reports no change)", () => {
    const target = join(tmpDir, "target.json");
    writeFileSync(target, "{}\n");
    const link = join(tmpDir, "link.json");
    forceSymlink(link, target);
    expect(forceSymlink(link, target)).toBe(false);
  });

  test("replaces a stale link", () => {
    const t1 = join(tmpDir, "t1");
    const t2 = join(tmpDir, "t2");
    writeFileSync(t1, "a");
    writeFileSync(t2, "b");
    const link = join(tmpDir, "link");
    forceSymlink(link, t1);
    expect(forceSymlink(link, t2)).toBe(true);
    expect(readlinkSync(link)).toBe(t2);
  });

  test("refuses to clobber a real directory at the link path", () => {
    const target = join(tmpDir, "target");
    writeFileSync(target, "x");
    const link = join(tmpDir, "realdir");
    mkdirSync(link, { recursive: true });
    expect(() => forceSymlink(link, target)).toThrow(StateError);
  });
});

describe("ensureProfileClaudeJson", () => {
  test("creates a converged .claude.json with onboarding defaults", () => {
    const profileDir = join(tmpDir, "profile");
    mkdirSync(profileDir, { recursive: true });
    expect(ensureProfileClaudeJson(profileDir)).toBe(true);
    const data = JSON.parse(
      readFileSync(join(profileDir, ".claude.json"), "utf8"),
    );
    expect(data.hasCompletedOnboarding).toBe(true);
    expect(data.theme).toBe("dark");
    expect(data.lastReleaseNotesSeen).toBe("9.9.99");
  });

  test("is a no-op once converged", () => {
    const profileDir = join(tmpDir, "profile");
    mkdirSync(profileDir, { recursive: true });
    ensureProfileClaudeJson(profileDir);
    expect(ensureProfileClaudeJson(profileDir)).toBe(false);
  });

  test("rebuilds a corrupt file", () => {
    const profileDir = join(tmpDir, "profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, ".claude.json"), "{ not json");
    expect(ensureProfileClaudeJson(profileDir)).toBe(true);
    const data = JSON.parse(
      readFileSync(join(profileDir, ".claude.json"), "utf8"),
    );
    expect(data.theme).toBe("dark");
  });

  test("merges trust entries for the given paths", () => {
    const profileDir = join(tmpDir, "profile");
    mkdirSync(profileDir, { recursive: true });
    const trustPath = join(tmpDir, "code", "proj");
    ensureProfileClaudeJson(profileDir, [trustPath]);
    const data = JSON.parse(
      readFileSync(join(profileDir, ".claude.json"), "utf8"),
    );
    expect(data.projects[trustPath]).toEqual({
      allowedTools: [],
      isTrusted: true,
      hasTrustDialogAccepted: true,
    });
  });
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
});

describe("ensureCanonicalStowLinks — settings.json (json compare, hard-error)", () => {
  let homeDir: string;
  let claudeDir: string;
  let settingsSrc: string;
  let settingsLink: string;

  const relTo = (link: string, target: string): string =>
    relative(dirname(link), target);

  beforeEach(() => {
    homeDir = join(tmpDir, "home");
    claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    settingsSrc = join(tmpDir, "repo", "settings.json");
    mkdirSync(dirname(settingsSrc), { recursive: true });
    writeFileSync(settingsSrc, '{\n  "a": 1,\n  "b": 2\n}\n');
    settingsLink = join(claudeDir, "settings.json");
  });

  const settingsLeaf = (): CanonicalStowLeaf => ({
    source: settingsSrc,
    linkPath: settingsLink,
    compare: "json",
    onDivergence: "error",
  });

  test("relinks a key-reordered-but-semantically-equal clobber (no throw)", () => {
    writeFileSync(settingsLink, '{"b":2,"a":1}');
    expect(() =>
      ensureCanonicalStowLinks([settingsLeaf()], [], {}),
    ).not.toThrow();
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relTo(settingsLink, settingsSrc));
  });

  test("throws StateError on a divergent clobber with recovery commands", () => {
    writeFileSync(settingsLink, '{"a": 999}');
    let thrown: unknown;
    try {
      ensureCanonicalStowLinks([settingsLeaf()], [], {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("diff -u");
    expect(msg).toContain("stow --restow");
    expect(msg).toContain("KEEPER_AGENT_SKIP_LINK_GUARD=1");
    // The divergent file must be left untouched (not relinked).
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(false);
  });

  test("skips + warns when the stow source file is missing", () => {
    rmSync(settingsSrc);
    const log: string[] = [];
    ensureCanonicalStowLinks([settingsLeaf()], log, {});
    expect(() => lstatSync(settingsLink)).toThrow();
    expect(log.some((l) => l.includes("stow source missing"))).toBe(true);
  });

  test("KEEPER_AGENT_SKIP_LINK_GUARD bypasses the guard with a loud warning", () => {
    writeFileSync(settingsLink, '{"a": 999}');
    const log: string[] = [];
    // Divergent clobber that WOULD throw — but the bypass skips it entirely.
    ensureCanonicalStowLinks([settingsLeaf()], log, {
      KEEPER_AGENT_SKIP_LINK_GUARD: "1",
    });
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(false);
    expect(log.some((l) => l.includes("KEEPER_AGENT_SKIP_LINK_GUARD"))).toBe(
      true,
    );
  });
});

// Each harness's real state-sharing entry, run against a sandboxed HOME + a temp
// shared source, must land its global-instruction leaf as a symlink resolving to
// the ONE shared AGENTS.md.
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

  test("claude: ~/.claude/CLAUDE.md → shared AGENTS.md, settings.json → claude stow", () => {
    const claudeStow = join(tmpDir, "repo", "system", "claude", ".claude");
    mkdirSync(claudeStow, { recursive: true });
    const settingsSrc = join(claudeStow, "settings.json");
    writeFileSync(settingsSrc, '{"a":1}\n');

    ensureClaudeStateSharing(() => [], [], homeDir, claudeStow, sharedDir);

    const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMd)).toBe(relTo(claudeMd, sharedSrc));

    const settingsLink = join(homeDir, ".claude", "settings.json");
    expect(lstatSync(settingsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink)).toBe(relTo(settingsLink, settingsSrc));
  });

  test("codex: ~/.codex/AGENTS.md → shared AGENTS.md (passthrough-shaped, no profile)", () => {
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

  test("pi: ~/.pi/agent/AGENTS.md → shared AGENTS.md (no configured profiles)", () => {
    ensurePiStateSharing(() => [], [], homeDir, sharedDir, {});
    const piAgents = join(homeDir, ".pi", "agent", "AGENTS.md");
    expect(lstatSync(piAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(piAgents)).toBe(relTo(piAgents, sharedSrc));
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

  test("the real claude wiring creates ~/.claude/{settings.json,CLAUDE.md} from absent", () => {
    const home = join(tmpDir, "guard-home");
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeStow = defaultClaudeStowDir();
    const sharedStow = defaultSharedStowDir();

    ensureClaudeStateSharing(() => [], [], home, claudeStow, sharedStow);

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
