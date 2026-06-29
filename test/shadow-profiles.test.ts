/**
 * The read-only shadow/stray profile-dir detector (src/agent/shadow-profiles.ts)
 * and its `keeper agent profiles check [--json]` subcommand. Two groups:
 *
 *  - findShadowProfileDirs runs against a real tmp home: reserved shadows
 *    (`default`/`auto`), untracked strays, auth detection (.credentials.json /
 *    .claude.json oauthAccount / pi auth.json), tracked-profile exclusion, NFC
 *    comparison, parse/ENOENT robustness, pi coverage, and a before/after tree
 *    snapshot proving ZERO filesystem mutation.
 *  - main()-driven `profiles check` tests inject findings through the MainDeps
 *    seam to pin exit codes (0/9/1), the stdout(data)/stderr(prose) split, and
 *    the --json envelope shape (id + remediation per finding).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import {
  findShadowProfileDirs,
  type ShadowProfileFinding,
} from "../src/agent/shadow-profiles";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

let tmpDir: string;
let home: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "shadow-profiles-"));
  home = join(tmpDir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create `~/.claude-profiles/<name>` and seed the named auth/config files. */
function claudeProfile(
  name: string,
  files: Record<string, string> = {},
): string {
  const dir = join(home, ".claude-profiles", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

function piProfile(name: string, files: Record<string, string> = {}): string {
  const dir = join(home, ".pi-profiles", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

/** Seed the native `~/.claude/.claude.json` with `content` (the tier source). */
function claudeHome(content: string): void {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), content);
}

/** A `.claude.json` whose oauthAccount carries a KNOWN (resolvable) tier. */
const RESOLVED_TIER_JSON = JSON.stringify({
  oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" },
});

const OAUTH_JSON = JSON.stringify({
  oauthAccount: { organizationRateLimitTier: "max_20x" },
});

function findingFor(
  findings: ShadowProfileFinding[],
  agent: "claude" | "pi",
  name: string,
): ShadowProfileFinding | undefined {
  return findings.find((f) => f.agent === agent && f.name === name);
}

/** A stable, content-bearing snapshot of a dir tree for a no-mutation check. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        out.push(`l:${r}`);
      } else if (e.isDirectory()) {
        out.push(`d:${r}`);
        walk(join(d, e.name), r);
      } else {
        out.push(`f:${r}:${readFileSync(join(d, e.name), "utf8")}`);
      }
    }
  };
  walk(dir, "");
  return out;
}

describe("findShadowProfileDirs", () => {
  test("flags an auth-bearing `default/` shadow as a reserved shadow", () => {
    claudeProfile("default", { ".claude.json": OAUTH_JSON });
    const findings = findShadowProfileDirs(() => [], home);
    const f = findingFor(findings, "claude", "default");
    expect(f).toEqual({
      agent: "claude",
      name: "default",
      hasAuth: true,
      isReservedShadow: true,
      tracked: false,
    });
  });

  test("detects auth via a .credentials.json file", () => {
    claudeProfile("default", { ".credentials.json": "{}" });
    const f = findingFor(
      findShadowProfileDirs(() => [], home),
      "claude",
      "default",
    );
    expect(f?.hasAuth).toBe(true);
  });

  test("excludes a tracked managed profile (configured, non-reserved)", () => {
    claudeProfile("multi-claude-1", { ".claude.json": OAUTH_JSON });
    const findings = findShadowProfileDirs(() => ["multi-claude-1"], home);
    expect(findingFor(findings, "claude", "multi-claude-1")).toBeUndefined();
    expect(findings).toEqual([]);
  });

  test("a configured `default` is STILL a reserved shadow (split-brain)", () => {
    // "default" maps to ~/.claude; a ~/.claude-profiles/default dir is always a
    // shadow even when agentusage lists it — surfaced with tracked=true.
    claudeProfile("default", { ".claude.json": OAUTH_JSON });
    const f = findingFor(
      findShadowProfileDirs(() => ["default", "multi-claude-1"], home),
      "claude",
      "default",
    );
    expect(f?.isReservedShadow).toBe(true);
    expect(f?.tracked).toBe(true);
  });

  test("flags a signed-out untracked stray with hasAuth=false", () => {
    claudeProfile("old-profile", { ".claude.json": "{}" });
    const f = findingFor(
      findShadowProfileDirs(() => [], home),
      "claude",
      "old-profile",
    );
    expect(f).toEqual({
      agent: "claude",
      name: "old-profile",
      hasAuth: false,
      isReservedShadow: false,
      tracked: false,
    });
  });

  test("an unparseable .claude.json is a no-auth finding, not a crash", () => {
    claudeProfile("broken", { ".claude.json": "{not json" });
    let findings: ShadowProfileFinding[] = [];
    expect(() => {
      findings = findShadowProfileDirs(() => [], home);
    }).not.toThrow();
    expect(findingFor(findings, "claude", "broken")?.hasAuth).toBe(false);
  });

  test("a vanished/empty stray dir and a dangling .claude.json don't crash", () => {
    // No auth files at all (observationally identical to a mid-scan ENOENT), plus
    // a dangling-symlink .claude.json whose readFileSync throws ENOENT.
    claudeProfile("empty-stray");
    const dangling = claudeProfile("dangling");
    symlinkSync(join(dangling, "nope.json"), join(dangling, ".claude.json"));
    let findings: ShadowProfileFinding[] = [];
    expect(() => {
      findings = findShadowProfileDirs(() => [], home);
    }).not.toThrow();
    expect(findingFor(findings, "claude", "empty-stray")?.hasAuth).toBe(false);
    expect(findingFor(findings, "claude", "dangling")?.hasAuth).toBe(false);
  });

  test("compares the tracked set on an NFC-normalized form", () => {
    // dir name composed (NFC), config name decomposed (NFD) → must still match.
    claudeProfile("café", { ".claude.json": OAUTH_JSON });
    const findings = findShadowProfileDirs(() => ["café"], home);
    expect(findings).toEqual([]);
  });

  test("covers the pi root (~/.pi-profiles) incl. auth.json + reserved shadow", () => {
    piProfile("default", { "auth.json": "{}" });
    piProfile("old-pi");
    const findings = findShadowProfileDirs(() => [], home);
    const reserved = findingFor(findings, "pi", "default");
    expect(reserved).toEqual({
      agent: "pi",
      name: "default",
      hasAuth: true,
      isReservedShadow: true,
      tracked: false,
    });
    expect(findingFor(findings, "pi", "old-pi")?.hasAuth).toBe(false);
  });

  test("a missing profiles root yields no findings (not an error)", () => {
    expect(findShadowProfileDirs(() => [], home)).toEqual([]);
  });

  test("a throwing listProfiles fails open (everything scanned, no crash)", () => {
    claudeProfile("multi-claude-1", { ".claude.json": OAUTH_JSON });
    const findings = findShadowProfileDirs(() => {
      throw new Error("catalog exploded");
    }, home);
    // With an empty tracked set, the otherwise-managed profile is reported.
    expect(findingFor(findings, "claude", "multi-claude-1")).toBeDefined();
  });

  test("performs ZERO filesystem mutation", () => {
    claudeProfile("default", { ".claude.json": OAUTH_JSON });
    claudeProfile("multi-claude-1", { ".credentials.json": "{}" });
    piProfile("default", { "auth.json": "{}" });
    const before = snapshotTree(home);
    findShadowProfileDirs(() => ["multi-claude-1"], home);
    expect(snapshotTree(home)).toEqual(before);
  });
});

describe("canonical ~/.claude tier detection", () => {
  const TIER_FINDING: ShadowProfileFinding = {
    agent: "claude",
    name: ".claude",
    hasAuth: true,
    isReservedShadow: false,
    tracked: false,
    tierUnresolved: true,
  };

  test("authed but tier absent → a distinct tier-unresolved finding", () => {
    claudeHome(JSON.stringify({ oauthAccount: { foo: "bar" } }));
    const f = findingFor(
      findShadowProfileDirs(() => [], home),
      "claude",
      ".claude",
    );
    expect(f).toEqual(TIER_FINDING);
  });

  test("authed but the tier is an UNKNOWN key → tier-unresolved", () => {
    // "max_20x" is not a TIER_MULTIPLIERS key (the keys are `default_claude_*`).
    claudeHome(OAUTH_JSON);
    const f = findingFor(
      findShadowProfileDirs(() => [], home),
      "claude",
      ".claude",
    );
    expect(f?.tierUnresolved).toBe(true);
  });

  test("authed but the tier is non-string → tier-unresolved", () => {
    claudeHome(
      JSON.stringify({ oauthAccount: { organizationRateLimitTier: 20 } }),
    );
    const f = findingFor(
      findShadowProfileDirs(() => [], home),
      "claude",
      ".claude",
    );
    expect(f?.tierUnresolved).toBe(true);
  });

  test("authed with a KNOWN tier → no finding", () => {
    claudeHome(RESOLVED_TIER_JSON);
    const findings = findShadowProfileDirs(() => [], home);
    expect(findingFor(findings, "claude", ".claude")).toBeUndefined();
  });

  test("no oauthAccount (not authed here) → NOT a tier finding", () => {
    // Keychain-only / no oauthAccount object is a different state, not re-home-incomplete.
    claudeHome(JSON.stringify({ somethingElse: true }));
    const findings = findShadowProfileDirs(() => [], home);
    expect(findingFor(findings, "claude", ".claude")).toBeUndefined();
  });

  test("a missing ~/.claude/.claude.json yields no tier finding", () => {
    const findings = findShadowProfileDirs(() => [], home);
    expect(findingFor(findings, "claude", ".claude")).toBeUndefined();
  });

  test("an unparseable ~/.claude/.claude.json → no tier finding, no crash", () => {
    claudeHome("{not json");
    let findings: ShadowProfileFinding[] = [];
    expect(() => {
      findings = findShadowProfileDirs(() => [], home);
    }).not.toThrow();
    expect(findingFor(findings, "claude", ".claude")).toBeUndefined();
  });
});

// ── `keeper agent profiles check` subcommand through main() ──────────────────

function profilesHarness(argv: string[], shadow: () => ShadowProfileFinding[]) {
  return makeHarness({
    argv,
    rawArgv: true,
    findShadowProfileDirs: shadow,
  });
}

const SAMPLE_FINDINGS: ShadowProfileFinding[] = [
  {
    agent: "claude",
    name: "default",
    hasAuth: true,
    isReservedShadow: true,
    tracked: true,
  },
  {
    agent: "pi",
    name: "old-pi",
    hasAuth: false,
    isReservedShadow: false,
    tracked: false,
  },
];

/** The native ~/.claude authed-but-tier-unresolvable finding. */
const TIER_FINDING: ShadowProfileFinding = {
  agent: "claude",
  name: ".claude",
  hasAuth: true,
  isReservedShadow: false,
  tracked: false,
  tierUnresolved: true,
};

describe("profiles check subcommand", () => {
  test("clean board exits 0, prose to stderr, no stdout, no launch", async () => {
    const h = profilesHarness(["profiles", "check"], () => []);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toBe("");
    expect(h.err.join("")).toContain("no shadow or stray");
    expect(h.spawned.length).toBe(0);
  });

  test("findings exit 9, data to stdout, summary to stderr", async () => {
    const h = profilesHarness(["profiles", "check"], () => SAMPLE_FINDINGS);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const out = h.out.join("");
    expect(out).toContain("~/.claude-profiles/default");
    expect(out).toContain("auth-bearing-reserved-shadow");
    expect(out).toContain("~/.pi-profiles/old-pi");
    // Remediation prose is emitted per finding.
    expect(out).toContain("Re-home it into ~/.claude");
    const err = h.err.join("");
    expect(err).toContain("2 finding(s)");
    expect(err).toContain("1 auth-bearing");
    expect(err).toContain("nothing was moved or deleted");
  });

  test("--json emits the envelope with id + remediation per finding", async () => {
    const h = profilesHarness(
      ["profiles", "check", "--json"],
      () => SAMPLE_FINDINGS,
    );
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const parsed = JSON.parse(h.out.join("")) as {
      schema_version: number;
      findings: Array<Record<string, unknown>>;
      summary: { total: number; authBearing: number; tierMissing: number };
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.summary).toEqual({
      total: 2,
      authBearing: 1,
      tierMissing: 0,
    });
    expect(parsed.findings[0]).toMatchObject({
      id: "claude:default",
      agent: "claude",
      name: "default",
      path: "~/.claude-profiles/default",
      kind: "auth-bearing-reserved-shadow",
      hasAuth: true,
      isReservedShadow: true,
      tracked: true,
    });
    expect(typeof parsed.findings[0]?.remediation).toBe("string");
    expect(parsed.findings[0]?.remediation as string).toContain("~/.claude");
    expect(parsed.findings[1]?.kind).toBe("stray");
  });

  test("--json on a clean board exits 0 with an empty findings array", async () => {
    const h = profilesHarness(["profiles", "check", "--json"], () => []);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join("")) as {
      findings: unknown[];
      summary: { total: number };
    };
    expect(parsed.findings).toEqual([]);
    expect(parsed.summary.total).toBe(0);
  });

  test("a scan that throws is a tool error: exit 1, Error to stderr", async () => {
    const h = profilesHarness(["profiles", "check"], () => {
      throw new Error("readdir blew up");
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(1);
    expect(h.out.join("")).toBe("");
    expect(h.err.join("")).toContain("Error:");
    expect(h.spawned.length).toBe(0);
  });

  test("tier-metadata-missing: canonical path + distinct id, counted apart", async () => {
    // A `claude:default` shadow AND the ~/.claude tier finding coexist — the
    // tier finding MUST NOT collide on `claude:default`.
    const h = profilesHarness(["profiles", "check", "--json"], () => [
      SAMPLE_FINDINGS[0] as ShadowProfileFinding,
      TIER_FINDING,
    ]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    const parsed = JSON.parse(h.out.join("")) as {
      findings: Array<Record<string, unknown>>;
      summary: { total: number; authBearing: number; tierMissing: number };
    };
    const ids = parsed.findings.map((f) => f.id as string);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate id
    expect(ids).toContain("claude:default");
    expect(ids).toContain("claude:~/.claude");
    const tier = parsed.findings.find((f) => f.id === "claude:~/.claude");
    expect(tier).toMatchObject({
      kind: "tier-metadata-missing",
      path: "~/.claude",
      agent: "claude",
      name: ".claude",
      hasAuth: true,
    });
    expect(tier?.remediation as string).toContain("?x");
    // Counted SEPARATELY: the tier finding is not in the auth-bearing tally.
    expect(parsed.summary).toEqual({
      total: 2,
      authBearing: 1,
      tierMissing: 1,
    });
  });

  test("tier-metadata-missing flips exit to 9 and notes it in the summary", async () => {
    const h = profilesHarness(["profiles", "check"], () => [TIER_FINDING]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(9);
    expect(h.out.join("")).toContain("~/.claude  [tier-metadata-missing]");
    const err = h.err.join("");
    expect(err).toContain("1 finding(s)");
    expect(err).toContain("0 auth-bearing");
    expect(err).toContain("1 tier-metadata-missing");
  });
});
