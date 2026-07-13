// Dep-light, PRODUCER-ONLY worktree-eligibility heuristic. Decides whether a git
// toplevel is "worktree-friendly" — a repo that can be safely forked into a
// parallel `~/worktrees/...` lane — versus one that must dispatch sequentially on
// the shared checkout. A repo is eligible iff it carries >=1 root language
// manifest, NO workspace-orchestration marker, and NO submodules. Everything else
// is `disabled`: a normal, NON-error fallback (never a sticky DispatchFailed).
//
// Dep-free by contract: node:fs/node:path only — NO bun:sqlite, NO src/db.ts, NO
// third-party deps, NO subprocess. A leaf producer module mirroring
// src/git-toplevel.ts (the per-cycle memo shape) and the
// hand-rolled, no-parser-dep TOML peek). NEVER call from a fold.
//
// FAIL CLOSED by contract: a worktree against a monorepo / submodule repo would
// hand a fresh checkout the wrong dependency tree, so any read/parse failure on an
// EXISTING manifest disables the repo. A MISSING file (ENOENT) is "absent", NOT an
// error. The eligibility verdict is fully derived from gathered signals by the
// PURE `classifyWorktreeEligibility`; the producer `assessRepo` only does I/O.

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** Per-read cap. A workspace marker sits near the top of any real manifest and a
 *  language manifest's mere existence is what matters, so 32KiB is ample; the cap
 *  bounds a hostile / pathological file. A header beyond the cap is missed (the
 *  one fail-open boundary) — real-world manifests are far smaller. */
const READ_CAP_BYTES = 32 * 1024;

/** The `disabled` reason prefix. `disabled` mints NO `dispatch_failures` row and
 *  never touches recover-pass auto-clear scoping — it is purely an operator-facing
 *  status string, not a sticky reject key. */
const DISABLED_PREFIX = "worktree-disabled";

/** The verdict string for an eligible repo. */
export const ELIGIBLE_REASON = "worktree-eligible";

/** A workspace-orchestration marker name — the `<which>` in a
 *  `worktree-disabled:workspace-marker:<which>` reason. */
export type WorkspaceMarker =
  | "pnpm-workspace"
  | "turbo"
  | "nx"
  | "lerna"
  | "rush"
  | "go-work"
  | "npm-workspaces"
  | "cargo-workspace"
  | "uv-workspace";

/** The already-gathered signal set the pure classifier reduces. No I/O — the
 *  producer fills this in, tests synthesize it directly. */
export interface RepoSignals {
  /** True iff >=1 root language manifest exists (existence-only). */
  hasLanguageManifest: boolean;
  /** Workspace markers detected, in stable precedence order. The first names the
   *  disabling reason. Empty => no workspace orchestration. */
  workspaceMarkers: readonly WorkspaceMarker[];
  /** `.gitmodules` exists at the root. */
  hasSubmodules: boolean;
  /** A read/parse failure on an EXISTING file — fail closed. ENOENT is NOT this. */
  probeError: boolean;
}

/** The eligibility verdict. `reason` names the disabling signal (or
 *  {@link ELIGIBLE_REASON}). */
export interface WorktreeEligibility {
  eligible: boolean;
  reason: string;
}

/** Root language manifests (existence-only). `package.json` alone is sufficient —
 *  a lockfile only refines the package-manager label, not eligibility. */
const LANGUAGE_MANIFESTS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "build.zig",
  "deno.json",
  "deno.jsonc",
  "Gemfile",
  "composer.json",
  "Package.swift",
];

/** Workspace-orchestration markers detected by file existence alone. */
const WORKSPACE_EXISTENCE_MARKERS: readonly [string, WorkspaceMarker][] = [
  ["pnpm-workspace.yaml", "pnpm-workspace"],
  ["turbo.json", "turbo"],
  ["nx.json", "nx"],
  ["lerna.json", "lerna"],
  ["rush.json", "rush"],
  ["go.work", "go-work"],
];

/** Cargo workspace table header. Line-anchored (`/m`), so a commented-out
 *  `# [workspace]` fails the anchor and a trailing same-line comment is irrelevant
 *  to the prefix match; a `[workspace.dependencies]` sub-table does NOT match (no
 *  `]` directly after `workspace`). `[workspace]` disables ALWAYS, even alongside
 *  `[package]` (the workspace-root-with-root-crate). A header buried in a
 *  multiline string errs toward disable — the SAFE direction. */
const CARGO_WORKSPACE_RE = /^\s*\[workspace\]/m;

/** uv (python) workspace table header — same line-anchored discipline. A bare
 *  `[tool.poetry]` is NOT a workspace. */
const UV_WORKSPACE_RE = /^\s*\[tool\.uv\.workspace\]/m;

/**
 * PURE, total reduction of {@link RepoSignals} to a verdict. No I/O. Eligible iff
 * (>=1 language manifest) AND (no workspace marker) AND (no submodules) AND (no
 * probeError); otherwise `disabled` with a reason naming the disabling signal.
 *
 * Precedence (deterministic when multiple signals fire): probeError (we cannot
 * trust our own reading) > workspace-marker (a monorepo — the most informative
 * verdict) > submodules > no-manifest.
 */
export function classifyWorktreeEligibility(
  signals: RepoSignals,
): WorktreeEligibility {
  if (signals.probeError) {
    return { eligible: false, reason: `${DISABLED_PREFIX}:probe-error` };
  }
  if (signals.workspaceMarkers.length > 0) {
    return {
      eligible: false,
      reason: `${DISABLED_PREFIX}:workspace-marker:${signals.workspaceMarkers[0]}`,
    };
  }
  if (signals.hasSubmodules) {
    return { eligible: false, reason: `${DISABLED_PREFIX}:submodules` };
  }
  if (!signals.hasLanguageManifest) {
    return { eligible: false, reason: `${DISABLED_PREFIX}:no-manifest` };
  }
  return { eligible: true, reason: ELIGIBLE_REASON };
}

/** Read at most {@link READ_CAP_BYTES} of a file. Returns `null` when the file is
 *  absent (ENOENT) — "absent", not an error. Re-throws ANY other error (EACCES,
 *  ENOTDIR, IO) so the caller fails closed. The existence-then-open window can
 *  race a deletion; an ENOENT from `openSync` is handled here too (treated as
 *  absent), so a vanished file is never a probe error. */
function tryReadCapped(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    const buf = Buffer.allocUnsafe(READ_CAP_BYTES);
    const n = readSync(fd, buf, 0, READ_CAP_BYTES, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Gather {@link RepoSignals} from the filesystem at `toplevel`. Existence-checked
 * reads, capped, fail-closed: any read/parse error on an existing file sets
 * `probeError`; a missing file is absent. An empty `toplevel` (a bug upstream —
 * `join("", name)` would resolve against cwd) fails closed.
 */
function gatherRepoSignals(toplevel: string): RepoSignals {
  if (!toplevel) {
    return {
      hasLanguageManifest: false,
      workspaceMarkers: [],
      hasSubmodules: false,
      probeError: true,
    };
  }

  let probeError = false;
  const markers: WorkspaceMarker[] = [];

  try {
    let hasLanguageManifest = false;
    for (const name of LANGUAGE_MANIFESTS) {
      if (existsSync(join(toplevel, name))) {
        hasLanguageManifest = true;
        break;
      }
    }

    // Existence-only workspace markers (stable order = reason precedence).
    for (const [file, marker] of WORKSPACE_EXISTENCE_MARKERS) {
      if (existsSync(join(toplevel, file))) {
        markers.push(marker);
      }
    }

    // package.json `"workspaces"` KEY presence (even `[]` / `{packages:[]}`) =
    // monorepo. JSON.parse + `"workspaces" in obj`; a parse failure on an existing
    // (possibly cap-truncated) file fails closed.
    try {
      const pkg = tryReadCapped(join(toplevel, "package.json"));
      if (pkg !== null) {
        const obj = JSON.parse(pkg);
        if (
          obj !== null &&
          typeof obj === "object" &&
          !Array.isArray(obj) &&
          "workspaces" in obj
        ) {
          markers.push("npm-workspaces");
        }
      }
    } catch {
      probeError = true;
    }

    // Cargo.toml `[workspace]` (always disables, even with `[package]`).
    try {
      const cargo = tryReadCapped(join(toplevel, "Cargo.toml"));
      if (cargo !== null && CARGO_WORKSPACE_RE.test(cargo)) {
        markers.push("cargo-workspace");
      }
    } catch {
      probeError = true;
    }

    // pyproject.toml `[tool.uv.workspace]` (NOT `[tool.poetry]` alone).
    try {
      const pyproject = tryReadCapped(join(toplevel, "pyproject.toml"));
      if (pyproject !== null && UV_WORKSPACE_RE.test(pyproject)) {
        markers.push("uv-workspace");
      }
    } catch {
      probeError = true;
    }

    const hasSubmodules = existsSync(join(toplevel, ".gitmodules"));

    return {
      hasLanguageManifest,
      workspaceMarkers: markers,
      hasSubmodules,
      probeError,
    };
  } catch {
    // Backstop: any unexpected fs failure fails closed.
    return {
      hasLanguageManifest: false,
      workspaceMarkers: markers,
      hasSubmodules: false,
      probeError: true,
    };
  }
}

/**
 * PRODUCER: gather signals at `toplevel` and classify. The single non-memoized
 * entry point — wrap with {@link memoizedAssessRepo} on the dispatch path.
 */
export function assessRepo(toplevel: string): WorktreeEligibility {
  return classifyWorktreeEligibility(gatherRepoSignals(toplevel));
}

/**
 * A per-cycle memoized {@link assessRepo}, keyed by toplevel. Mirrors
 * {@link memoizedNullableGitToplevel}: an undefined-miss sentinel (the verdict is
 * always a defined object, so `hit !== undefined` is a true miss check), GC'd at
 * cycle end so a transient probe failure re-probes next cycle rather than
 * permanently darkening a repo.
 */
export function memoizedAssessRepo(): (
  toplevel: string,
) => WorktreeEligibility {
  const cache = new Map<string, WorktreeEligibility>();
  return (toplevel: string): WorktreeEligibility => {
    const hit = cache.get(toplevel);
    if (hit !== undefined) {
      return hit;
    }
    const result = assessRepo(toplevel);
    cache.set(toplevel, result);
    return result;
  };
}
