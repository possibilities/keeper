/**
 * Launcher-owned worker-cell resolution — the ONE seam both work-launch
 * producers (the autopilot reconciler and manual `keeper dispatch`) share to
 * decide which per-cell `work` plugin a task's launch loads.
 *
 * PRODUCER-ONLY, filesystem-probing by contract. Every function here may read
 * the on-disk plugin tree (manifest existence, a scan-dir shadow probe), so it
 * lives OUTSIDE the pure reducer: {@link resolveWorkerCell} is called from a
 * producer path (`runReconcileCycle` / the dispatch CLI), NEVER a `reconcile`
 * arm or any fold — re-fold determinism holds because no fold reaches this
 * module. The pure `workerCellPluginDir` compose STAYS in `reconcile-core`
 * (the pure reducer import must never gain an I/O-module dep); this module
 * imports it one-directionally, never the reverse.
 *
 * The seam returns MACHINE KINDS ONLY — a closed discriminated union of
 * `{ok:true, pluginDir}` and four typed rejects, carrying minimal machine
 * fields and NO prose. Each caller composes its own operator text from the
 * kind, which is exactly what keeps the producer's byte-pinned sticky-reason
 * strings (including the `KEEPER_ROOT`-baked remediation) untouched while a
 * hand-run dispatch prints its own three-part actionable error. A closed union
 * plus `assertNever` at each caller makes the compiler the parity net: a new
 * reject kind fails compilation at any unmapped switch.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WORKERS_BASE } from "../plugins/plan/src/subagents_config.ts";
import { ConfigError, loadPluginSources } from "./agent/config";
import {
  driverFor,
  loadMatrix,
  type Matrix,
  providerOrderFor,
} from "./agent/matrix";
import { KEEPER_ROOT, workerCellPluginDir } from "./reconcile-core";

/**
 * The ABSOLUTE base of the generated per-cell `work`-plugin tree
 * (`${KEEPER_ROOT}/plugins/plan/workers`). Every `--plugin-dir`-selected
 * `work:worker` cell lives UNDER this base; a `work`-named manifest found OUTSIDE
 * it while scanning a claude `plugin_scan_dir` is a shadowing collision that would
 * silently steal the `work:worker` constant from the selected cell.
 */
export const WORKER_CELL_BASE: string = join(
  KEEPER_ROOT,
  "plugins",
  "plan",
  WORKERS_BASE,
);

/**
 * Scan-dir probe for a non-cell `work`-named plugin that would shadow the
 * launch-time `work:worker` cell. Mirrors the launcher's scan-dir discovery
 * (`discoverPlugins` step 2b — the IMMEDIATE children of each `plugin_scan_dir`)
 * and returns the first child whose `.claude-plugin/plugin.json` is `name:
 * "work"` yet sits OUTSIDE {@link WORKER_CELL_BASE} — such a manifest re-claims
 * the `work:worker` name at launch and shadows the selected cell. Returns the
 * offending manifest path, else null.
 *
 * On-disk I/O by contract — called ONLY from a producer path, NEVER a
 * `reconcile`/fold arm, so re-fold determinism holds. Fail-safe: an unreadable
 * scan dir / missing or malformed manifest is skipped (not a `work` collision),
 * so a transient fs error never wedges dispatch. Exported for tests.
 */
export function findShadowingWorkManifest(
  scanDirs: readonly string[],
  cellBase: string = WORKER_CELL_BASE,
): string | null {
  const base = resolve(cellBase);
  for (const scanDir of scanDirs) {
    let entries: string[];
    try {
      entries = readdirSync(scanDir).sort();
    } catch {
      // Missing/unreadable scan dir — skipped, mirroring `discoverPlugins`.
      continue;
    }
    for (const name of entries) {
      const pluginDir = join(scanDir, name);
      const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
      let data: { name?: string };
      try {
        if (!statSync(pluginDir).isDirectory()) {
          continue;
        }
        data = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      } catch {
        // No manifest / malformed JSON — not a `work` collision.
        continue;
      }
      if (data.name !== "work") {
        continue;
      }
      // A cell manifest under the generated base IS the legitimate `work:worker`
      // source (a scan dir may point straight at the workers tree) — never a shadow.
      if (resolve(pluginDir).startsWith(base + sep)) {
        continue;
      }
      return manifest;
    }
  }
  return null;
}

/**
 * Default {@link WorkerCellProbeDeps.probeShadow} impl: read the launcher plugin
 * config and scan its real `plugin_scan_dirs` for a shadowing non-cell `work`
 * manifest. Fail-safe on a missing/invalid config (mirrors
 * `resolveWorkerLaunchConfig`'s swallow-to-constants posture) — no scan dirs
 * means nothing to shadow. Producer-only.
 */
export function defaultShadowingWorkProbe(): string | null {
  let scanDirs: readonly string[];
  try {
    scanDirs = loadPluginSources().pluginScanDirs;
  } catch (err) {
    if (err instanceof ConfigError) {
      return null;
    }
    throw err;
  }
  return findShadowingWorkManifest(scanDirs);
}

/**
 * The pure worker-cell compose result — the input {@link resolveWorkerCell}
 * applies its filesystem-probe precedence over. `pluginDir` is the composed
 * absolute cell dir, or `null` for a legitimately cell-less launch (either axis
 * null, or a `close` row). `reject` is set IFF the pure
 * `workerCellPluginDir` compose THREW (an out-of-matrix pair) — it carries the
 * throw's message and is mutually exclusive with a non-null `pluginDir`.
 */
export interface WorkerCellCompose {
  pluginDir: string | null;
  reject?: string;
}

/**
 * Wrap the pure `workerCellPluginDir` (which STAYS in `reconcile-core`) in the
 * SAME try/catch shape the producer's inline compose uses — a corrupt
 * out-of-matrix `(model, tier)` pair becomes a carried `reject` rather than a
 * throw. Used by the dispatch CLI, which composes fresh from the task's
 * projection `{model, tier}`; the producer keeps its own inline copy in the
 * pure `reconcile` so the reducer never imports this I/O module.
 */
export function composeWorkerCellDir(
  model: string | null,
  tier: string | null,
): WorkerCellCompose {
  try {
    return { pluginDir: workerCellPluginDir(model, tier) };
  } catch (err) {
    return {
      pluginDir: null,
      reject: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The host-matrix route verdict for a WRAPPED-candidate cell — a `{model, tier}`
 * the compiled (claude-only) subagents matrix rejected, so it may be a capability
 * model claude does not serve. `no-route` carries the capability model: a wrapped
 * model no configured provider serves, OR a malformed matrix at probe time (the
 * daemon degrades a parse failure to the SAME visible no-route rather than
 * faulting). `routed` covers every non-no-route verdict — a native model, an
 * absent matrix (the claude-only world), or a wrapped model with ≥1 serving
 * provider — and leaves the generic out-of-matrix reject standing.
 */
export type WorkerCellRoute =
  | { kind: "routed" }
  | { kind: "no-route"; model: string };

/**
 * Default {@link WorkerCellProbeDeps.probeRoute} impl: classify a capability
 * model against the host matrix (ADR 0010). Called ONLY for a wrapped-candidate
 * cell (a compose that fell outside the compiled subagents matrix), so a native
 * (claude) cell never reaches it and never reads `matrix.yaml`.
 *
 * PRODUCER-ONLY, filesystem-probing by contract (mirrors {@link
 * defaultShadowingWorkProbe}). Degrade-not-throw: a malformed matrix
 * (`ConfigError`) becomes a `no-route` verdict so the daemon mints a visible
 * sticky naming the file instead of a `fatalExit` — fail-loud parsing stays a
 * CLI-only posture. An ABSENT matrix (`null`) is the claude-only world → `routed`
 * (a non-claude token there is a plain out-of-matrix, never a no-route). The
 * matrix loader is injected so tests drive every branch without touching disk.
 */
export function defaultRouteProbe(
  model: string,
  load: () => Matrix | null = () => loadMatrix(),
): WorkerCellRoute {
  let matrix: Matrix | null;
  try {
    matrix = load();
  } catch (err) {
    if (err instanceof ConfigError) {
      return { kind: "no-route", model };
    }
    throw err;
  }
  if (matrix === null || driverFor(matrix, model) === "native") {
    return { kind: "routed" };
  }
  return providerOrderFor(matrix, model).length > 0
    ? { kind: "routed" }
    : { kind: "no-route", model };
}

/**
 * The closed result union {@link resolveWorkerCell} returns. `ok:true` carries
 * the resolved `pluginDir` (`null` = cell-less, launch with no `--plugin-dir`).
 * The four rejects carry minimal machine fields and NO prose — each caller
 * composes its own operator text. Adding a reject kind here breaks compilation
 * at every caller's `assertNever`-closed switch (the parity net).
 *
 * `no-route` carries the capability `model`: a WRAPPED cell (a model claude does
 * not serve) that the host matrix routes to zero providers — the caller composes
 * the sticky naming `matrix.yaml`, cleared by `retry_dispatch` after the config
 * is fixed.
 */
export type WorkerCellResult =
  | { ok: true; pluginDir: string | null }
  | { ok: false; kind: "out-of-matrix"; message: string }
  | { ok: false; kind: "no-route"; model: string }
  | { ok: false; kind: "missing"; pluginDir: string }
  | { ok: false; kind: "shadowed"; pluginDir: string; shadowManifest: string };

/**
 * Injected filesystem probes so each caller controls its own probe cadence. The
 * producer passes a per-cycle MEMOIZED shadow closure (one on-disk scan per
 * reconcile cycle, first cell launch only); the dispatch CLI passes the fresh
 * {@link defaultShadowingWorkProbe} (it launches one worker). `probeShadow` is
 * invoked ONLY when a cell is present and its manifest exists — the hot loop
 * never regresses to a readdir-per-launch.
 */
export interface WorkerCellProbeDeps {
  dirExists: (path: string) => boolean;
  probeShadow: () => string | null;
  /**
   * Host-matrix route probe, bound to the cell's capability model at the call
   * site (the producer / dispatch CLI pass {@link defaultRouteProbe}). Consulted
   * ONLY when the compose fell outside the compiled subagents matrix (a wrapped
   * candidate); a native cell never reaches it, so the matrix file stays unread
   * for claude cells and dispatch is byte-identical with or without a matrix.
   */
  probeRoute: () => WorkerCellRoute;
}

/**
 * The shared resolution seam. Applies the producer's exact precedence over a
 * compose result: out-of-matrix (compose threw) → missing (cell manifest
 * absent) → shadowed (a non-cell `work` plugin sits in a scan dir). Returns a
 * machine-kind union; each caller composes its own reason prose. Filesystem
 * probes fire lazily in precedence order — the shadow probe is reached ONLY for
 * a present cell whose manifest exists, so a reject or cell-less launch never
 * touches the scan dirs.
 *
 * The host-matrix route probe fires ONLY down the compose-reject arm — a wrapped
 * capability model claude does not serve lands here as an out-of-matrix compose,
 * and the probe re-classifies it: no serving provider (or a malformed matrix) is
 * a `no-route` reject naming the model, ranked AHEAD of the generic
 * out-of-matrix; any other verdict leaves out-of-matrix standing. A native cell
 * (a real cell dir composed) skips this arm entirely and never touches the route
 * probe.
 */
export function resolveWorkerCell(
  compose: WorkerCellCompose,
  deps: WorkerCellProbeDeps,
): WorkerCellResult {
  if (compose.reject !== undefined) {
    const route = deps.probeRoute();
    if (route.kind === "no-route") {
      return { ok: false, kind: "no-route", model: route.model };
    }
    return { ok: false, kind: "out-of-matrix", message: compose.reject };
  }
  if (compose.pluginDir == null) {
    // Cell-less: either axis null, or a `close` row — no `--plugin-dir`.
    return { ok: true, pluginDir: null };
  }
  const manifest = join(compose.pluginDir, ".claude-plugin", "plugin.json");
  if (!deps.dirExists(manifest)) {
    return { ok: false, kind: "missing", pluginDir: compose.pluginDir };
  }
  const shadowManifest = deps.probeShadow();
  if (shadowManifest != null) {
    return {
      ok: false,
      kind: "shadowed",
      pluginDir: compose.pluginDir,
      shadowManifest,
    };
  }
  return { ok: true, pluginDir: compose.pluginDir };
}
