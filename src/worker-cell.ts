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
import { WORKERS_BASE } from "../plugins/plan/src/worker_cells.ts";
import { ConfigError, loadPluginSources } from "./agent/config";
import { loadMatrixV2, MatrixConfigError, type MatrixV2 } from "./agent/matrix";
import {
  type HostMatrixAxes,
  KEEPER_ROOT,
  type MatrixFailureState,
  workerCellPluginDir,
} from "./reconcile-core";

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
 * `resolveDispatchLaunchConfig`'s swallow-to-floor posture) — no scan dirs
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
 * applies its precedence over. `pluginDir` is the composed absolute cell dir, or
 * `null` for a legitimately cell-less launch (either axis null, or a `close` row).
 * At most one reject field is set: `matrixReject` IFF the host matrix FAILED to
 * load (the four-state discriminator, ADR 0036), else `reject` IFF the pure
 * `workerCellPluginDir` compose THREW (an out-of-matrix pair carrying the throw's
 * message). Each is mutually exclusive with a non-null `pluginDir`.
 */
export interface WorkerCellCompose {
  pluginDir: string | null;
  reject?: string;
  /** Set IFF the host matrix could not be loaded — the four-state failure the
   *  caller surfaces as a distress sticky naming the state. */
  matrixReject?: { state: MatrixFailureState; detail: string };
  /**
   * The capability `{model, tier}` this compose was built from — carried so a
   * caller can name the model/tier in its reject prose. Optional so a bare
   * `{pluginDir}` literal (a cell-less or resolved compose) stays valid.
   */
  model?: string | null;
  tier?: string | null;
}

/**
 * Wrap the pure `workerCellPluginDir` compose in the SAME reject-carried shape the
 * producer's inline compose uses, loading the host matrix FRESH at invocation. Used
 * by the dispatch CLI, which composes one worker's `{model, tier}` from the task's
 * projection; the producer instead composes inline in the pure `reconcile` from the
 * cycle's ONE injected matrix snapshot (so the reducer never imports this I/O
 * module). A matrix that fails to load becomes a `matrixReject` (the four-state
 * discriminator), a corrupt out-of-matrix pair a `reject` — never a throw. The
 * loader is injected so tests drive every state without touching disk.
 */
export function composeWorkerCellDir(
  model: string | null,
  tier: string | null,
  load: () => MatrixV2 = () => loadMatrixV2(),
): WorkerCellCompose {
  // A null EITHER axis is a cell-less launch (the always-loaded base `plan` plugin),
  // matrix-independent by design — never a reject, and the matrix stays unread.
  if (model === null || tier === null) {
    return { pluginDir: null, model, tier };
  }
  let axes: HostMatrixAxes;
  try {
    const matrix = load();
    axes = {
      models: matrix.subagentModels,
      effortsByModel: matrix.effortsByModel,
      efforts: matrix.efforts,
    };
  } catch (err) {
    if (err instanceof MatrixConfigError) {
      return {
        pluginDir: null,
        matrixReject: { state: err.state, detail: err.message },
        model,
        tier,
      };
    }
    throw err;
  }
  try {
    return { pluginDir: workerCellPluginDir(model, tier, axes), model, tier };
  } catch (err) {
    return {
      pluginDir: null,
      reject: err instanceof Error ? err.message : String(err),
      model,
      tier,
    };
  }
}

/**
 * The closed result union {@link resolveWorkerCell} returns. `ok:true` carries
 * the resolved `pluginDir` (`null` = cell-less, launch with no `--plugin-dir`).
 * The four rejects carry minimal machine fields and NO prose — each caller
 * composes its own operator text. Adding a reject kind here breaks compilation
 * at every caller's `assertNever`-closed switch (the parity net).
 *
 * `bad-matrix` carries the four-state discriminator (ADR 0036): the host matrix
 * was absent / unparseable / schema-invalid / valid-but-empty. With no matrix
 * there is no cell to compose, so it ranks FIRST — the caller mints a distress
 * sticky naming the state, cleared by `retry_dispatch` once the config is fixed.
 */
export type WorkerCellResult =
  | { ok: true; pluginDir: string | null }
  | { ok: false; kind: "bad-matrix"; state: MatrixFailureState; detail: string }
  | { ok: false; kind: "out-of-matrix"; message: string }
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
}

/**
 * The shared resolution seam. Applies the producer's exact precedence over a
 * compose result: bad-matrix (no matrix loaded) → out-of-matrix (compose threw) →
 * missing (cell manifest absent) → shadowed (a non-cell `work` plugin sits in a
 * scan dir). Returns a machine-kind union; each caller composes its own reason
 * prose. Filesystem probes fire lazily in precedence order — the shadow probe is
 * reached ONLY for a present cell whose manifest exists, so a reject or cell-less
 * launch never touches the scan dirs. The host matrix reaches this seam already
 * resolved on the compose (the producer's cycle snapshot, or the CLI's fresh
 * load), so this function itself is pure over its inputs + the two fs probes.
 */
export function resolveWorkerCell(
  compose: WorkerCellCompose,
  deps: WorkerCellProbeDeps,
): WorkerCellResult {
  if (compose.matrixReject !== undefined) {
    return {
      ok: false,
      kind: "bad-matrix",
      state: compose.matrixReject.state,
      detail: compose.matrixReject.detail,
    };
  }
  if (compose.reject !== undefined) {
    return { ok: false, kind: "out-of-matrix", message: compose.reject };
  }
  const pluginDir = compose.pluginDir;
  if (pluginDir == null) {
    // Cell-less: either axis null, or a `close` row — no `--plugin-dir`.
    return { ok: true, pluginDir: null };
  }
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!deps.dirExists(manifest)) {
    return { ok: false, kind: "missing", pluginDir };
  }
  const shadowManifest = deps.probeShadow();
  if (shadowManifest != null) {
    return {
      ok: false,
      kind: "shadowed",
      pluginDir,
      shadowManifest,
    };
  }
  return { ok: true, pluginDir };
}
