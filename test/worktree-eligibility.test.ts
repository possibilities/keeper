// Fast tier: pure heuristic + an fs-gather over a per-test tmpdir. NO git /
// daemon / subprocess (fs is allowed). The oracle (keeper=eligible,
// arthack=disabled(workspace), zellijsub=disabled(cargo-workspace), bare
// dir=disabled(no-manifest)) is reproduced against synthetic fixtures.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessRepo,
  classifyWorktreeEligibility,
  ELIGIBLE_REASON,
  memoizedAssessRepo,
  type RepoSignals,
  type WorkspaceMarker,
} from "../src/worktree-eligibility";

// ---------------------------------------------------------------------------
// PURE classifyWorktreeEligibility
// ---------------------------------------------------------------------------

/** A clean, eligible signal set; override per case. */
function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    hasLanguageManifest: true,
    workspaceMarkers: [],
    hasSubmodules: false,
    probeError: false,
    ...overrides,
  };
}

test("classify: clean single repo is eligible", () => {
  expect(classifyWorktreeEligibility(signals())).toEqual({
    eligible: true,
    reason: ELIGIBLE_REASON,
  });
});

test("classify: no manifest -> disabled:no-manifest", () => {
  expect(
    classifyWorktreeEligibility(signals({ hasLanguageManifest: false })),
  ).toEqual({ eligible: false, reason: "worktree-disabled:no-manifest" });
});

test("classify: submodules -> disabled:submodules", () => {
  expect(classifyWorktreeEligibility(signals({ hasSubmodules: true }))).toEqual(
    { eligible: false, reason: "worktree-disabled:submodules" },
  );
});

test("classify: probeError -> disabled:probe-error", () => {
  expect(classifyWorktreeEligibility(signals({ probeError: true }))).toEqual({
    eligible: false,
    reason: "worktree-disabled:probe-error",
  });
});

test("classify: each workspace-marker kind names the reason", () => {
  const kinds: WorkspaceMarker[] = [
    "pnpm-workspace",
    "turbo",
    "nx",
    "lerna",
    "rush",
    "go-work",
    "npm-workspaces",
    "cargo-workspace",
    "uv-workspace",
  ];
  for (const kind of kinds) {
    expect(
      classifyWorktreeEligibility(signals({ workspaceMarkers: [kind] })),
    ).toEqual({
      eligible: false,
      reason: `worktree-disabled:workspace-marker:${kind}`,
    });
  }
});

test("classify: probeError dominates other signals", () => {
  expect(
    classifyWorktreeEligibility(
      signals({
        hasLanguageManifest: true,
        workspaceMarkers: ["turbo"],
        hasSubmodules: true,
        probeError: true,
      }),
    ).reason,
  ).toBe("worktree-disabled:probe-error");
});

test("classify: workspace-marker outranks submodules and no-manifest", () => {
  expect(
    classifyWorktreeEligibility(
      signals({
        hasLanguageManifest: false,
        workspaceMarkers: ["pnpm-workspace"],
        hasSubmodules: true,
      }),
    ).reason,
  ).toBe("worktree-disabled:workspace-marker:pnpm-workspace");
});

// ---------------------------------------------------------------------------
// PRODUCER assessRepo + memoizedAssessRepo over a tmpdir
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `keeper-wt-elig-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file under the tmp repo (parent dirs assumed to exist). */
function w(name: string, body: string): void {
  writeFileSync(join(tmpDir, name), body);
}

test("assessRepo: clean single (package.json only) is eligible", () => {
  w("package.json", JSON.stringify({ name: "x", version: "1.0.0" }));
  expect(assessRepo(tmpDir)).toEqual({
    eligible: true,
    reason: ELIGIBLE_REASON,
  });
});

test("assessRepo: crisp single-project polyglot is eligible", () => {
  w("package.json", JSON.stringify({ name: "polyglot", version: "1.0.0" }));
  w("pyproject.toml", '[project]\nname = "polyglot"\n');
  expect(assessRepo(tmpDir)).toEqual({
    eligible: true,
    reason: ELIGIBLE_REASON,
  });
});

test("assessRepo: arthack-oracle (pnpm-workspace + turbo + uv.workspace) is disabled(workspace)", () => {
  w("package.json", JSON.stringify({ name: "arthack", private: true }));
  w("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  w("turbo.json", JSON.stringify({ pipeline: {} }));
  w("pyproject.toml", '[tool.uv.workspace]\nmembers = ["libs/*"]\n');
  const result = assessRepo(tmpDir);
  expect(result.eligible).toBe(false);
  expect(result.reason).toBe(
    "worktree-disabled:workspace-marker:pnpm-workspace",
  );
});

test("assessRepo: zellijsub-oracle (Cargo [package] + [workspace]) is disabled(cargo-workspace)", () => {
  w(
    "Cargo.toml",
    '[package]\nname = "zellijsub"\nversion = "0.1.0"\n\n[workspace]\nmembers = ["crates/*"]\n',
  );
  expect(assessRepo(tmpDir)).toEqual({
    eligible: false,
    reason: "worktree-disabled:workspace-marker:cargo-workspace",
  });
});

test("assessRepo: bare docs dir (no manifest) is disabled(no-manifest)", () => {
  w("README.md", "# just docs\n");
  expect(assessRepo(tmpDir)).toEqual({
    eligible: false,
    reason: "worktree-disabled:no-manifest",
  });
});

test("assessRepo: empty dir (all ENOENT) is disabled(no-manifest), NOT probe-error", () => {
  expect(assessRepo(tmpDir).reason).toBe("worktree-disabled:no-manifest");
});

test('assessRepo: package.json "workspaces":[] is disabled(npm-workspaces)', () => {
  w("package.json", JSON.stringify({ name: "mono", workspaces: [] }));
  expect(assessRepo(tmpDir).reason).toBe(
    "worktree-disabled:workspace-marker:npm-workspaces",
  );
});

test("assessRepo: [tool.poetry] alone is NOT a workspace (eligible)", () => {
  w("pyproject.toml", '[tool.poetry]\nname = "x"\nversion = "0.1.0"\n');
  expect(assessRepo(tmpDir)).toEqual({
    eligible: true,
    reason: ELIGIBLE_REASON,
  });
});

test("assessRepo: Cargo single crate ([package] only) is eligible", () => {
  w("Cargo.toml", '[package]\nname = "solo"\nversion = "0.1.0"\n');
  expect(assessRepo(tmpDir)).toEqual({
    eligible: true,
    reason: ELIGIBLE_REASON,
  });
});

test("assessRepo: commented-out [workspace] does not false-positive", () => {
  w("Cargo.toml", '[package]\nname = "solo"\n# [workspace] disabled\n');
  expect(assessRepo(tmpDir).eligible).toBe(true);
});

test("assessRepo: .gitmodules present is disabled(submodules)", () => {
  w("package.json", JSON.stringify({ name: "x" }));
  w(".gitmodules", '[submodule "vendor"]\n  path = vendor\n');
  expect(assessRepo(tmpDir).reason).toBe("worktree-disabled:submodules");
});

test("assessRepo: malformed package.json fails closed (probe-error)", () => {
  w("package.json", "{ this is not json ");
  expect(assessRepo(tmpDir).reason).toBe("worktree-disabled:probe-error");
});

test("assessRepo: empty toplevel fails closed (probe-error)", () => {
  expect(assessRepo("").reason).toBe("worktree-disabled:probe-error");
});

test("assessRepo: a [workspace] header beyond the 32KiB read cap is missed (cap tradeoff)", () => {
  // Real Cargo.toml are far smaller than 32KiB; this documents the one fail-open
  // boundary — a header past the cap is not read, so the repo reads as a single
  // crate. The padding is TOML comment lines (regex-scanned, never parsed).
  const padding = `${"# pad\n".repeat(7000)}`; // ~42KiB, > 32KiB cap
  w("Cargo.toml", `[package]\nname = "big"\n${padding}[workspace]\n`);
  expect(assessRepo(tmpDir).eligible).toBe(true);
});

test("memoizedAssessRepo: caches per toplevel (a mid-cycle marker change does not flip)", () => {
  w("package.json", JSON.stringify({ name: "x" }));
  const memo = memoizedAssessRepo();
  const first = memo(tmpDir);
  expect(first.eligible).toBe(true);

  // A marker appears AFTER the first probe; the cached verdict is grandfathered.
  w("pnpm-workspace.yaml", "packages: []\n");
  const second = memo(tmpDir);
  expect(second).toBe(first); // same cached object reference
  expect(second.eligible).toBe(true);

  // A fresh memo (next cycle) re-probes and sees the marker.
  expect(memoizedAssessRepo()(tmpDir).eligible).toBe(false);
});

test("memoizedAssessRepo: distinct toplevels each probe independently", () => {
  const other = join(tmpdir(), `keeper-wt-elig-other-${process.pid}`);
  mkdirSync(other, { recursive: true });
  try {
    w("package.json", JSON.stringify({ name: "x" }));
    writeFileSync(join(other, "README.md"), "# docs\n");
    const memo = memoizedAssessRepo();
    expect(memo(tmpDir).eligible).toBe(true);
    expect(memo(other).reason).toBe("worktree-disabled:no-manifest");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
