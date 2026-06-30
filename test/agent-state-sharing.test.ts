/**
 * Symlink-farm pins for the path-explicit helpers: forceSymlink is idempotent
 * and replaces a stale link, refuses to clobber a real directory; and
 * ensureProfileClaudeJson force-merges onboarding/theme/trust defaults,
 * rebuilds a corrupt file, and is a no-op once converged. The HOME-rooted
 * orchestrator (ensureClaudeStateSharing) is exercised end-to-end in the parity
 * matrix; here we pin the leaf behaviors that compose it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
  ensureCanonicalStowLinks,
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

describe("ensureCanonicalStowLinks", () => {
  // A tmp home with a stow source dir holding settings.json + CLAUDE.md, plus an
  // empty ~/.claude/. homeDir is injected (os.homedir ignores $HOME).
  let homeDir: string;
  let stowDir: string;
  let claudeDir: string;

  const settingsSrc = (): string => join(stowDir, "settings.json");
  const settingsLink = (): string => join(claudeDir, "settings.json");
  const claudeMdSrc = (): string => join(stowDir, "CLAUDE.md");
  const claudeMdLink = (): string => join(claudeDir, "CLAUDE.md");
  const relTo = (link: string, target: string): string =>
    relative(dirname(link), target);

  beforeEach(() => {
    homeDir = join(tmpDir, "home");
    stowDir = join(tmpDir, "repo", "system", "claude", ".claude");
    claudeDir = join(homeDir, ".claude");
    mkdirSync(stowDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsSrc(), '{\n  "a": 1,\n  "b": 2\n}\n');
    writeFileSync(claudeMdSrc(), "# canonical\n");
  });

  test("creates the relative link when the canonical path is absent", () => {
    const log: string[] = [];
    ensureCanonicalStowLinks(stowDir, homeDir, log, {});
    expect(lstatSync(settingsLink()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink())).toBe(
      relTo(settingsLink(), settingsSrc()),
    );
    expect(readlinkSync(claudeMdLink())).toBe(
      relTo(claudeMdLink(), claudeMdSrc()),
    );
  });

  test("is a no-op when the correct relative link already exists", () => {
    symlinkSync(relTo(settingsLink(), settingsSrc()), settingsLink());
    symlinkSync(relTo(claudeMdLink(), claudeMdSrc()), claudeMdLink());
    const log: string[] = [];
    ensureCanonicalStowLinks(stowDir, homeDir, log, {});
    expect(log).toEqual([]);
    expect(readlinkSync(settingsLink())).toBe(
      relTo(settingsLink(), settingsSrc()),
    );
  });

  test("repairs a symlink pointing at the wrong target", () => {
    const wrong = join(tmpDir, "wrong.json");
    writeFileSync(wrong, "{}");
    symlinkSync(wrong, settingsLink());
    const log: string[] = [];
    ensureCanonicalStowLinks(stowDir, homeDir, log, {});
    expect(readlinkSync(settingsLink())).toBe(
      relTo(settingsLink(), settingsSrc()),
    );
    expect(log.some((l) => l.includes("wrong target"))).toBe(true);
  });

  test("relinks an identical regular-file clobber and logs", () => {
    writeFileSync(settingsLink(), readFileSync(settingsSrc(), "utf8"));
    const log: string[] = [];
    ensureCanonicalStowLinks(stowDir, homeDir, log, {});
    expect(lstatSync(settingsLink()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink())).toBe(
      relTo(settingsLink(), settingsSrc()),
    );
    expect(log.some((l) => l.includes("identical clobber"))).toBe(true);
  });

  test("relinks a key-reordered-but-semantically-equal settings clobber (no throw)", () => {
    // Same JSON, different key order + whitespace — must NOT hard-error.
    writeFileSync(settingsLink(), '{"b":2,"a":1}');
    const log: string[] = [];
    expect(() =>
      ensureCanonicalStowLinks(stowDir, homeDir, log, {}),
    ).not.toThrow();
    expect(lstatSync(settingsLink()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settingsLink())).toBe(
      relTo(settingsLink(), settingsSrc()),
    );
  });

  test("throws StateError on a divergent settings clobber with recovery commands", () => {
    writeFileSync(settingsLink(), '{"a": 999}');
    let thrown: unknown;
    try {
      ensureCanonicalStowLinks(stowDir, homeDir, [], {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StateError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("diff -u");
    expect(msg).toContain("stow --restow");
    expect(msg).toContain("KEEPER_AGENT_SKIP_LINK_GUARD=1");
    // The divergent file must be left untouched (not relinked).
    expect(lstatSync(settingsLink()).isSymbolicLink()).toBe(false);
  });

  test("byte-compares CLAUDE.md: divergent content throws", () => {
    writeFileSync(claudeMdLink(), "# tampered\n");
    expect(() => ensureCanonicalStowLinks(stowDir, homeDir, [], {})).toThrow(
      StateError,
    );
  });

  test("relinks an identical CLAUDE.md clobber", () => {
    writeFileSync(claudeMdLink(), readFileSync(claudeMdSrc(), "utf8"));
    ensureCanonicalStowLinks(stowDir, homeDir, [], {});
    expect(lstatSync(claudeMdLink()).isSymbolicLink()).toBe(true);
  });

  test("skips + warns when the stow source file is missing", () => {
    rmSync(settingsSrc());
    const log: string[] = [];
    ensureCanonicalStowLinks(stowDir, homeDir, log, {});
    // settings.json source gone → no link created; CLAUDE.md still linked.
    expect(() => lstatSync(settingsLink())).toThrow();
    expect(log.some((l) => l.includes("stow source missing"))).toBe(true);
    expect(lstatSync(claudeMdLink()).isSymbolicLink()).toBe(true);
  });

  test("KEEPER_AGENT_SKIP_LINK_GUARD bypasses the guard with a loud warning", () => {
    writeFileSync(settingsLink(), '{"a": 999}');
    const log: string[] = [];
    // Divergent clobber that WOULD throw — but the bypass skips it entirely.
    ensureCanonicalStowLinks(stowDir, homeDir, log, {
      KEEPER_AGENT_SKIP_LINK_GUARD: "1",
    });
    expect(lstatSync(settingsLink()).isSymbolicLink()).toBe(false);
    expect(log.some((l) => l.includes("KEEPER_AGENT_SKIP_LINK_GUARD"))).toBe(
      true,
    );
  });
});
