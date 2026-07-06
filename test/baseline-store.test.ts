/**
 * Pure unit pins for `src/baseline-store.ts` — the suite-baseline CONTRACT
 * module (docs/adr/0005). NO subprocess, NO git, NO daemon: every test drives a
 * pure helper directly or a filesystem helper against a per-test tmpdir. Expected
 * values are hand-authored constants / fixtures, never re-derived by the code
 * under test.
 *
 * Covers the task's acceptance: key composition (toolchain in the key), the
 * envelope union (green / suite-red+flaky / infra-by-kind / timeout, plus
 * miss/computing on the read side), fail-open parse, atomic-write round-trip,
 * retention eviction order, and the "an infra failure can never be green" verdict
 * invariant.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineResult,
  baselineKey,
  buildRequest,
  classifyFailures,
  classifyRead,
  currentToolchain,
  deriveResult,
  isValidSha,
  leafDir,
  leafPath,
  parseLeaf,
  parseRequest,
  pruneLeafs,
  readLeaf,
  readRequest,
  requestPath,
  type SuiteRun,
  selectEvictions,
  spoolDir,
  type ToolchainFingerprint,
  writeLeaf,
  writeRequest,
} from "../src/baseline-store";
import { repoDirHash } from "../src/worktree-plan";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "baseline-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TC_A: ToolchainFingerprint = {
  bunVersion: "1.1.0",
  platform: "darwin-arm64",
};
const TC_B: ToolchainFingerprint = {
  bunVersion: "1.2.0",
  platform: "darwin-arm64",
};
const REPO = "/Users/x/code/keeper";
const SHA = "a".repeat(40);

// ── key composition ──────────────────────────────────────────────────────────

test("key composes from repo identity, sha, and toolchain and is stable", () => {
  const input = { repoDir: REPO, sha: SHA, toolchain: TC_A };
  const key = baselineKey(input);
  // Independent structure: <repoHash>-<sha>-<toolchainHash>. The repo + sha
  // prefix is asserted against the repo hash and the sha directly.
  expect(key.startsWith(`${repoDirHash(REPO)}-${SHA}-`)).toBe(true);
  // Deterministic: same input → same key.
  expect(baselineKey(input)).toBe(key);
});

test("two runs differing only in Bun version resolve to different keys", () => {
  const a = baselineKey({ repoDir: REPO, sha: SHA, toolchain: TC_A });
  const b = baselineKey({ repoDir: REPO, sha: SHA, toolchain: TC_B });
  expect(a).not.toBe(b);
});

test("platform, repo, and sha each independently change the key", () => {
  const base = baselineKey({ repoDir: REPO, sha: SHA, toolchain: TC_A });
  const diffPlatform = baselineKey({
    repoDir: REPO,
    sha: SHA,
    toolchain: { ...TC_A, platform: "linux-x64" },
  });
  const diffRepo = baselineKey({
    repoDir: "/other/repo",
    sha: SHA,
    toolchain: TC_A,
  });
  const diffSha = baselineKey({
    repoDir: REPO,
    sha: "b".repeat(40),
    toolchain: TC_A,
  });
  expect(diffPlatform).not.toBe(base);
  expect(diffRepo).not.toBe(base);
  expect(diffSha).not.toBe(base);
});

test("key is filesystem-safe even for a malicious sha (traversal guard)", () => {
  const key = baselineKey({
    repoDir: REPO,
    sha: "../../etc/passwd",
    toolchain: TC_A,
  });
  expect(key).toMatch(/^[0-9a-z-]+$/);
  expect(key).not.toContain("/");
  expect(key).not.toContain("..");
});

test("key toolchain segment matches an independently hand-computed FNV-1a digest", () => {
  // Hand-computed offline (NOT via the module under test) over the exact
  // delimited byte sequence `${bunVersion}\x00${platform}` — pins the raw NUL
  // delimiter byte-for-byte so a future edit can't silently widen/shrink it.
  const key = baselineKey({ repoDir: REPO, sha: SHA, toolchain: TC_A });
  expect(key).toBe(`${repoDirHash(REPO)}-${SHA}-i6ctkr`);
});

test("currentToolchain reports the live bun version and platform-arch", () => {
  const tc = currentToolchain();
  expect(tc.bunVersion).toBe(Bun.version);
  expect(tc.platform).toBe(`${process.platform}-${process.arch}`);
});

test("isValidSha accepts abbreviated + full hex, rejects junk", () => {
  expect(isValidSha("a".repeat(40))).toBe(true);
  expect(isValidSha("abc1234")).toBe(true);
  expect(isValidSha("abc123")).toBe(false); // < 7
  expect(isValidSha("../../etc")).toBe(false);
  expect(isValidSha("zzzzzzz")).toBe(false);
});

// ── path scheme stability ────────────────────────────────────────────────────

test("path scheme is stable and rooted under <state-dir>/baseline", () => {
  expect(leafDir(dir)).toBe(join(dir, "baseline", "leafs"));
  expect(spoolDir(dir)).toBe(join(dir, "baseline", "requests"));
  expect(leafPath("repo-sha-tc", dir)).toBe(
    join(dir, "baseline", "leafs", "repo-sha-tc.json"),
  );
  expect(requestPath("req-123", dir)).toBe(
    join(dir, "baseline", "requests", "req-123.json"),
  );
});

test("leafPath sanitizes a hostile key — no path escape", () => {
  const p = leafPath("../../../etc/passwd", dir);
  expect(p.startsWith(join(dir, "baseline", "leafs"))).toBe(true);
  expect(p).not.toContain("..");
});

// ── envelope: verdict classification ─────────────────────────────────────────

function run(exitCode: number, failingTests: string[]): SuiteRun {
  return { startedAt: 1000, durationMs: 500, exitCode, failingTests };
}

const DERIVE_BASE = {
  key: "k",
  sha: SHA,
  toolchain: TC_A,
  computedAt: 1_700_000_000_000,
};

test("a clean 'ran' outcome derives green", () => {
  const res = deriveResult({
    ...DERIVE_BASE,
    outcome: { kind: "ran", runs: [run(0, [])] },
  });
  expect(res.status).toBe("green");
});

test("a red run with a same-sha retry marks fail-then-pass as flaky-suspect", () => {
  // run1 fails A and B; the retry fails only A → B passed on retry (flaky), A hard.
  const res = deriveResult({
    ...DERIVE_BASE,
    outcome: {
      kind: "ran",
      runs: [run(1, ["testA", "testB"]), run(1, ["testA"])],
    },
  });
  expect(res.status).toBe("suite-red");
  if (res.status !== "suite-red") throw new Error("unreachable");
  const byId = new Map(res.failing.map((f) => [f.id, f.flakySuspect]));
  expect(byId.get("testA")).toBe(false); // failed both runs → hard
  expect(byId.get("testB")).toBe(true); // failed then passed → flaky
  expect(res.runs.length).toBe(2); // raw runs retained, verdict derived
});

test("classifyFailures: unanimous failures are not flaky, single-run failures are", () => {
  const failing = classifyFailures([
    run(1, ["hard", "flaky"]),
    run(1, ["hard"]),
  ]);
  const byId = new Map(failing.map((f) => [f.id, f.flakySuspect]));
  expect(byId.get("hard")).toBe(false);
  expect(byId.get("flaky")).toBe(true);
});

test("infra outcomes are infra-error by kind and NEVER green", () => {
  for (const kind of ["checkout", "install", "spawn"] as const) {
    const res = deriveResult({
      ...DERIVE_BASE,
      outcome: { kind: "infra", infra: kind, message: "boom" },
    });
    expect(res.status).toBe("infra-error");
    if (res.status !== "infra-error") throw new Error("unreachable");
    expect(res.kind).toBe(kind);
    expect(res.status).not.toBe("green");
  }
});

test("a timeout outcome is timeout and NEVER green, even with partial runs", () => {
  const res = deriveResult({
    ...DERIVE_BASE,
    outcome: { kind: "timeout", deadlineMs: 60_000, runs: [run(1, ["slow"])] },
  });
  expect(res.status).toBe("timeout");
  if (res.status !== "timeout") throw new Error("unreachable");
  expect(res.deadlineMs).toBe(60_000);
  expect(res.status).not.toBe("green");
});

// ── read-side states ─────────────────────────────────────────────────────────

test("classifyRead: leaf present → the leaf; absent → computing/miss by pending", () => {
  const leaf: BaselineResult = {
    ...DERIVE_BASE,
    status: "green",
    runs: [run(0, [])],
  };
  expect(classifyRead(leaf, false, "k")).toBe(leaf);
  expect(classifyRead(null, true, "k")).toEqual({
    status: "computing",
    key: "k",
  });
  expect(classifyRead(null, false, "k")).toEqual({ status: "miss", key: "k" });
});

// ── fail-open parse ──────────────────────────────────────────────────────────

test("parseLeaf is fail-open on garbage, non-object, and unknown status", () => {
  expect(parseLeaf("not json {")).toBeNull();
  expect(parseLeaf("[]")).toBeNull();
  expect(parseLeaf("42")).toBeNull();
  expect(parseLeaf(JSON.stringify({ status: "bogus" }))).toBeNull();
  // Missing required base fields → null.
  expect(parseLeaf(JSON.stringify({ status: "green", runs: [] }))).toBeNull();
});

test("parseLeaf rejects an oversized body without throwing", () => {
  const huge = `{"x":"${"a".repeat(2 * (1 << 20))}"}`;
  expect(parseLeaf(huge)).toBeNull();
});

test("readLeaf of a missing or truncated file yields null", () => {
  expect(readLeaf(join(dir, "nope.json"))).toBeNull();
  const p = join(dir, "truncated.json");
  writeFileSync(p, '{"status":"green","key":"k","sha":"');
  expect(readLeaf(p)).toBeNull();
});

test("a coerced infra-error leaf can never be read as green", () => {
  const leaf: BaselineResult = {
    ...DERIVE_BASE,
    status: "infra-error",
    kind: "install",
    message: "frozen lockfile mismatch",
  };
  const parsed = parseLeaf(JSON.stringify(leaf));
  expect(parsed).not.toBeNull();
  expect(parsed?.status).toBe("infra-error");
  expect(parsed?.status).not.toBe("green");
});

// ── atomic write round-trip ──────────────────────────────────────────────────

test("writeLeaf → readLeaf round-trips a suite-red envelope and leaves no temp", () => {
  const leaf: BaselineResult = {
    ...DERIVE_BASE,
    status: "suite-red",
    failing: [{ id: "testA", flakySuspect: false }],
    runs: [run(1, ["testA"])],
  };
  const p = leafPath("round-trip-key", dir);
  writeLeaf(p, leaf);
  expect(readLeaf(p)).toEqual(leaf);
  // Atomic write cleans up after itself — no dotfile temps linger.
  const leftover = readdirSync(leafDir(dir)).filter((n) => n.startsWith("."));
  expect(leftover).toEqual([]);
});

test("writeLeaf over an existing leaf replaces it", () => {
  const p = leafPath("replace-key", dir);
  writeLeaf(p, { ...DERIVE_BASE, status: "green", runs: [run(0, [])] });
  writeLeaf(p, {
    ...DERIVE_BASE,
    status: "infra-error",
    kind: "checkout",
    message: "no such sha",
  });
  expect(readLeaf(p)?.status).toBe("infra-error");
});

test("request round-trips through the spool", () => {
  const req = buildRequest(
    { repoDir: REPO, sha: SHA, toolchain: TC_A },
    1_700_000_000_000,
  );
  const p = requestPath("req-abc", dir);
  writeRequest(p, req);
  const back = readRequest(p);
  expect(back).toEqual(req);
  expect(back?.key).toBe(
    baselineKey({ repoDir: REPO, sha: SHA, toolchain: TC_A }),
  );
});

test("parseRequest is fail-open on garbage", () => {
  expect(parseRequest("{")).toBeNull();
  expect(parseRequest(JSON.stringify({ key: "k" }))).toBeNull();
});

// ── retention eviction ───────────────────────────────────────────────────────

test("selectEvictions keeps the most-recent cap and evicts oldest first", () => {
  const entries = [
    { name: "old.json", mtimeMs: 100 },
    { name: "mid.json", mtimeMs: 200 },
    { name: "new.json", mtimeMs: 300 },
  ];
  expect(selectEvictions(entries, 3)).toEqual([]);
  expect(selectEvictions(entries, 2)).toEqual(["old.json"]);
  expect(selectEvictions(entries, 1)).toEqual(["old.json", "mid.json"]);
  expect(selectEvictions(entries, 0)).toEqual([
    "old.json",
    "mid.json",
    "new.json",
  ]);
});

test("selectEvictions breaks mtime ties by name for determinism", () => {
  const entries = [
    { name: "b.json", mtimeMs: 100 },
    { name: "a.json", mtimeMs: 100 },
    { name: "c.json", mtimeMs: 100 },
  ];
  expect(selectEvictions(entries, 1)).toEqual(["a.json", "b.json"]);
});

test("pruneLeafs evicts the oldest files on disk beyond the cap", () => {
  const d = leafDir(dir);
  const seed = (name: string, mtimeSec: number) => {
    const p = join(d, name);
    // writeLeaf ensures the dir; a raw write is fine once it exists.
    writeLeaf(p, { ...DERIVE_BASE, status: "green", runs: [run(0, [])] });
    utimesSync(p, mtimeSec, mtimeSec);
  };
  seed("k1.json", 100);
  seed("k2.json", 200);
  seed("k3.json", 300);
  seed("k4.json", 400);

  const evicted = pruneLeafs(d, 2);
  expect(evicted.sort()).toEqual(["k1.json", "k2.json"]);
  const remaining = readdirSync(d)
    .filter((n) => n.endsWith(".json"))
    .sort();
  expect(remaining).toEqual(["k3.json", "k4.json"]);
});

test("pruneLeafs is fail-open on a missing dir", () => {
  expect(pruneLeafs(join(dir, "does-not-exist"))).toEqual([]);
});
