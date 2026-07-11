/**
 * epic-deps — leaf module for cross-epic dependency resolution.
 *
 * This module owns the cwd-then-global resolver (`resolveEpicDep`) and its
 * supporting helpers (`epicIsCompleted`, `projectBasename`, `BARE_FN_PATTERN`,
 * `EpicDepResolution`). Extracted from `src/readiness.ts` (fn-637.1) so the
 * SAME resolver can be called from BOTH the readiness path (`src/readiness.ts`,
 * `scripts/board.ts`) and — in fn-637.3 — the reducer fold path
 * (`src/reducer.ts`) without an import cycle.
 *
 * Leaf-module invariant: this file imports types from `src/types.ts` and
 * `src/readiness-diagnostics.ts` ONLY. It MUST NOT import `readiness.ts` or
 * `reducer.ts` (or any module that transitively reaches back into either),
 * otherwise the reducer side of fn-637 would re-introduce the cycle this
 * extraction exists to break.
 *
 * Fold-safety invariant: the resolver does NOT read wall-clock time. The
 * `now` parameter is INJECTED by callers — the readiness/board callers pass
 * `new Date().toISOString()` (preserving the legacy behavior bit-for-bit);
 * the reducer caller (fn-637.3) will pass a timestamp derived from the
 * event being folded so a from-scratch re-fold reproduces byte-identical
 * `ResolutionDiagnostic` rows. Reading `new Date()` inside the resolver
 * would break the re-fold determinism invariant the projection-side move
 * relies on.
 */

import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import type { Epic } from "./types";

/**
 * Bare `fn-N` id pattern — `fn-` followed by digits, with no trailing
 * `-slug`. Matches `fn-100`; does NOT match `fn-100-foo`. Anchored on
 * both ends so a malformed entry doesn't slip through.
 */
export const BARE_FN_PATTERN = /^fn-(\d+)$/;

/**
 * Lift the basename of a `project_dir` without importing `node:path` into
 * downstream `readiness.ts` / reducer-fold consumers. Used to compare an
 * epic dep's consumer and upstream `project_dir` for the cross-project
 * `[<project>::#N]` render hint, and to disambiguate bare-id matches by
 * preferring same-project candidates.
 *
 * Strips trailing slashes, takes the segment after the last `/`. Equivalent
 * to `node:path` basename for POSIX paths; this module never sees Windows
 * paths (plan is POSIX-only by design). An `arthack`-prefixed pill
 * matches an `arthack/...` project dir but not `arthack-fork/...`.
 */
export function projectBasename(dir: string | null): string {
  if (dir == null || dir === "") {
    return "";
  }
  const trimmed = dir.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Resolver-side dep-satisfaction predicate — STATUS-ONLY by the
 * folds-never-probe-liveness invariant. A resolved upstream whose status is
 * `"done"` satisfies the dependency for the reducer's `resolved_epic_deps`
 * stamp, even when the upstream has been pruned from the default-visible page
 * (`default_visible=0`) and reaches the resolver only via the completed-epics
 * index.
 *
 * This INTENTIONALLY diverges from `evaluateCloseRow`'s terminal-completed
 * check: the resolver stamps `satisfied` on status alone, but a close row only
 * renders `completed` once it is status-done AND idle. The readiness pass
 * re-narrows a `satisfied` stamp at read time — predicate 9's
 * `epicHasLiveCloseScopeWork` gate keeps a dependent blocked while the
 * status-done upstream's closer is still winding down — so the fold stays pure
 * and a re-fold reproduces byte-identical rows.
 */
export function epicIsCompleted(epic: Epic): boolean {
  return epic.status === "done";
}

/** Resolver outcome — discriminated union so callers can branch on `kind`. */
export type EpicDepResolution =
  | {
      kind: "found";
      epic: Epic;
      /**
       * Upstream's project basename when it differs from the consumer's —
       * for the renderer's `[arthack::#N]` cross-project prefix. `null`
       * when the basenames match (intra-project).
       */
      cross_project: string | null;
      /**
       * fn-637: `true` when the resolved upstream is itself completed
       * (fn-756: `status==="done"` — the same terminal predicate
       * `evaluateCloseRow` uses). A completed upstream satisfies
       * the dependency outright; predicate 9 skips it without consulting
       * `perCloseRow` (the completed upstream is pruned from the
       * default-visible page and reaches the resolver only via the
       * completed-epics index, so it has no per-close-row verdict).
       */
      completed: boolean;
    }
  | { kind: "dangling" };

/**
 * Resolve one `depends_on_epics` entry against the in-snapshot index, mirroring
 * plan's fn-600 cwd-then-global semantics. Two id shapes are accepted:
 *
 *   - Full id (`fn-100-foo`) — direct `epicById` lookup. Miss → dangling.
 *   - Bare id (`fn-100`) — `epicsByNumber` lookup. Zero matches → dangling;
 *     exactly one match → use it; 2+ matches → prefer the consumer epic's
 *     `project_dir` basename. If exactly one candidate shares it, use that
 *     candidate. Otherwise emit a `ResolutionDiagnostic` and yield dangling
 *     so the human sees the ambiguity rather than autopilot silently picking
 *     a wrong upstream.
 *
 * Anything not matching either shape (typo, malformed id) → dangling without
 * a diagnostic; the dangling pill itself is the signal.
 *
 * Exported so `scripts/board.ts` summary pill can share the same resolution
 * path as predicate 9 — they MUST agree, otherwise the summary pill and the
 * row pill could disagree on whether an upstream is dangling. The reducer
 * (fn-637.3) reuses the same function so the projection-side
 * `resolved_epic_deps` array is computed by the same code path the live
 * readiness pipeline runs — they cannot drift.
 *
 * The `now` parameter is injected (not read from `new Date()`) so the
 * resolver is fold-safe: a from-scratch reducer re-fold reproduces
 * byte-identical diagnostic rows when callers pass an event-derived
 * timestamp.
 */
export function resolveEpicDep(
  rawDep: string,
  consumer: Epic,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  diagnostics: ResolutionDiagnostic[],
  now: string,
): EpicDepResolution {
  const consumerBase = projectBasename(consumer.project_dir);

  // Bare-id form takes priority over the full-id branch so a string like
  // `fn-100` (no slug) doesn't accidentally hit the full-id lookup with a
  // partial match. The BARE_FN_PATTERN excludes the dotted task form.
  const bareMatch = BARE_FN_PATTERN.exec(rawDep);
  if (bareMatch !== null) {
    const num = Number.parseInt(bareMatch[1] ?? "", 10);
    if (Number.isNaN(num)) {
      return { kind: "dangling" };
    }
    const candidates = epicsByNumber.get(num) ?? [];
    if (candidates.length === 0) {
      return { kind: "dangling" };
    }
    if (candidates.length === 1) {
      const upstream = candidates[0];
      if (upstream === undefined) {
        return { kind: "dangling" };
      }
      const upstreamBase = projectBasename(upstream.project_dir);
      const crossProject =
        consumerBase !== "" &&
        upstreamBase !== "" &&
        consumerBase !== upstreamBase
          ? upstreamBase
          : null;
      return {
        kind: "found",
        epic: upstream,
        cross_project: crossProject,
        completed: epicIsCompleted(upstream),
      };
    }
    // 2+ candidates. Prefer the consumer's own project_dir basename.
    const sameProject = candidates.filter(
      (e) =>
        projectBasename(e.project_dir) === consumerBase && consumerBase !== "",
    );
    if (sameProject.length === 1) {
      const upstream = sameProject[0];
      if (upstream === undefined) {
        return { kind: "dangling" };
      }
      // Same-project hit can't be cross-project by definition.
      return {
        kind: "found",
        epic: upstream,
        cross_project: null,
        completed: epicIsCompleted(upstream),
      };
    }
    // Ambiguous: 2+ candidates AND no unique same-project disambiguator.
    // Emit a diagnostic with every match's full id (sorted for re-fold
    // determinism) and fall through to dangling. The `now` timestamp is
    // injected by the caller — see this function's docstring for the
    // fold-safety rationale.
    diagnostics.push({
      ts: now,
      kind: "ambiguous-dep-resolution",
      consumer_epic: consumer.epic_id,
      upstream: rawDep,
      matches: candidates.map((e) => e.epic_id).sort(),
    });
    return { kind: "dangling" };
  }

  // Full-id form. Direct lookup. Miss → dangling.
  const upstream = epicById.get(rawDep);
  if (upstream === undefined) {
    return { kind: "dangling" };
  }
  const upstreamBase = projectBasename(upstream.project_dir);
  const crossProject =
    consumerBase !== "" && upstreamBase !== "" && consumerBase !== upstreamBase
      ? upstreamBase
      : null;
  return {
    kind: "found",
    epic: upstream,
    cross_project: crossProject,
    completed: epicIsCompleted(upstream),
  };
}
