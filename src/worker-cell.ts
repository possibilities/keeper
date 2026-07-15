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
 * `{ok:true, pluginDir}` and typed rejects, carrying minimal machine
 * fields and NO prose. Each caller composes its own operator text from the
 * kind, which is exactly what keeps the producer's byte-pinned sticky-reason
 * strings (including the `KEEPER_ROOT`-baked remediation) untouched while a
 * hand-run dispatch prints its own three-part actionable error. A closed union
 * plus `assertNever` at each caller makes the compiler the parity net: a new
 * reject kind fails compilation at any unmapped switch.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKERS_BASE } from "../plugins/plan/src/worker_cells.ts";
import {
  type ClaudeWorkerVerificationResult,
  verifyClaudeWorkerCohort,
} from "../plugins/prompt/src/claude_worker_compiler.ts";
import { ConfigError, loadPluginSources } from "./agent/config";
import { loadMatrixV2, MatrixConfigError, type MatrixV2 } from "./agent/matrix";
import { assertNever } from "./dispatch-failure-key";
import type {
  EquivalenceCell,
  EquivalenceDirection,
  ProviderConstraintRejectReason,
  WorkerProvider,
} from "./provider-equivalence";
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

/** Canonical repair command shared by manual and automated dispatch failures. */
export const WORKER_CELL_COMPILE_COMMAND =
  "keeper prompt compile --role work:worker --target claude";

/** A launcher-preloaded `work` manifest and its physical plugin identity. */
export interface WorkPluginManifest {
  /** Config/discovery path, retained for a concise operator-facing rejection. */
  readonly manifest: string;
  /** `realpath` of the directory that owns {@link manifest}. */
  readonly physicalPluginDir: string;
}

export type WorkPluginManifestInventory = readonly WorkPluginManifest[];

function inspectWorkManifest(pluginDir: string): WorkPluginManifest | null {
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  try {
    if (!statSync(pluginDir).isDirectory()) return null;
    const data = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: unknown;
    };
    if (data.name !== "work") return null;
    return {
      manifest,
      physicalPluginDir: realpathSync.native(pluginDir),
    };
  } catch {
    // Missing, unreadable, or malformed entries do not claim `work` here.
    return null;
  }
}

/**
 * Inventory every `work` manifest the launcher config can preload: each explicit
 * `plugin_dirs` entry itself, plus immediate children of `plugin_scan_dirs`.
 * Paths are physicalized so a symlink cannot disguise a sibling/external plugin
 * as the selected cell. This is producer-only filesystem I/O.
 */
export function inventoryWorkPluginManifests(
  pluginDirs: readonly string[],
  pluginScanDirs: readonly string[],
): WorkPluginManifestInventory {
  const inventory: WorkPluginManifest[] = [];
  for (const pluginDir of pluginDirs) {
    const entry = inspectWorkManifest(pluginDir);
    if (entry !== null) inventory.push(entry);
  }
  for (const scanDir of pluginScanDirs) {
    let names: string[];
    try {
      names = readdirSync(scanDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const entry = inspectWorkManifest(join(scanDir, name));
      if (entry !== null) inventory.push(entry);
    }
  }
  return inventory;
}

/** Read launcher config and produce its complete preloaded `work` inventory. */
export function defaultWorkPluginManifestInventory(): WorkPluginManifestInventory {
  try {
    const sources = loadPluginSources();
    return inventoryWorkPluginManifests(
      sources.pluginDirs,
      sources.pluginScanDirs,
    );
  } catch (err) {
    if (err instanceof ConfigError) return [];
    throw err;
  }
}

/** Physical identity for the selected cell; injected at callers for pure tests. */
export function physicalPluginDir(pluginDir: string): string {
  try {
    return realpathSync.native(pluginDir);
  } catch {
    return resolve(pluginDir);
  }
}

/**
 * Pure exact-cell comparison over one inventory snapshot. A `work` manifest is
 * legitimate only when its physical directory is the exact selected physical
 * directory. This deliberately rejects generated siblings as well as external
 * `work` plugins; there is no broad workers-tree exemption.
 */
export function findShadowingWorkManifest(
  inventory: WorkPluginManifestInventory,
  selectedPhysicalPluginDir: string,
): string | null {
  const selected = resolve(selectedPhysicalPluginDir);
  for (const entry of inventory) {
    if (resolve(entry.physicalPluginDir) !== selected) return entry.manifest;
  }
  return null;
}

/** One-shot production shadow probe used by manual dispatch. */
export function defaultShadowingWorkProbe(pluginDir: string): string | null {
  return findShadowingWorkManifest(
    defaultWorkPluginManifestInventory(),
    physicalPluginDir(pluginDir),
  );
}

/** Machine-only freshness result accepted by the shared resolution seam. */
export type WorkerCellFreshness =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * Cycle-shareable compiler verification snapshot. The optional inventory on an
 * injected `{ok:true}` keeps filesystem-free tests terse; production always
 * supplies the exact verified output inventory.
 */
export type WorkerCellCohortVerification =
  | {
      readonly ok: true;
      readonly fingerprint?: string;
      readonly pluginDirs?: readonly string[];
    }
  | { readonly ok: false; readonly detail: string };

/** Run the compiler-owned read-only verifier and retain exact output cell dirs. */
export function verifyWorkerCellCohort(
  verify: () => ClaudeWorkerVerificationResult = verifyClaudeWorkerCohort,
): WorkerCellCohortVerification {
  const verified: ClaudeWorkerVerificationResult = verify();
  if (!verified.ok) {
    const path = verified.failure.path;
    return {
      ok: false,
      detail:
        `${verified.failure.kind}: ${verified.failure.message}` +
        (path === undefined ? "" : ` (${path})`),
    };
  }
  return {
    ok: true,
    fingerprint: verified.fingerprint,
    pluginDirs: verified.outputs.map((output) =>
      // The compiler output row's cell is the ownership inventory. Do not infer
      // capabilities through provider equivalence at runtime.
      join(WORKER_CELL_BASE, `${output.cell.model}-${output.cell.effort}`),
    ),
  };
}

/** Compare one exact selected dir against a shared compiler verification. */
export function selectedWorkerCellFreshness(
  pluginDir: string,
  verified: WorkerCellCohortVerification,
): WorkerCellFreshness {
  if (!verified.ok) return verified;
  // `{ok:true}` is the intentionally tiny injected clean fixture contract.
  if (verified.pluginDirs === undefined) return { ok: true };
  const selected = resolve(pluginDir);
  if (verified.pluginDirs.some((dir) => resolve(dir) === selected)) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: `selected-cell-not-in-verified-cohort: ${pluginDir}`,
  };
}

/** One-shot production freshness probe used by manual dispatch. */
export function defaultWorkerCellFreshnessProbe(
  pluginDir: string,
): WorkerCellFreshness {
  return selectedWorkerCellFreshness(pluginDir, verifyWorkerCellCohort());
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
  /** Set IFF the `worker_provider` pin could not translate the assigned cell (ADR
   *  0047) — the fail-closed reject, carried so a caller composes an operator
   *  reason naming the cells + direction. Ranks after {@link matrixReject}, before
   *  the compose reject. */
  providerReject?: {
    reason: ProviderConstraintRejectReason;
    provider: WorkerProvider;
    direction: EquivalenceDirection;
    assigned: EquivalenceCell;
    target: EquivalenceCell | null;
    detail?: string;
  };
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
      driverByModel: matrix.driverByModel,
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
 * The rejects carry minimal machine fields and NO prose — each caller
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
  | {
      ok: false;
      kind: "provider-reject";
      reason: ProviderConstraintRejectReason;
      provider: WorkerProvider;
      direction: EquivalenceDirection;
      assigned: EquivalenceCell;
      target: EquivalenceCell | null;
      detail?: string;
    }
  | { ok: false; kind: "out-of-matrix"; message: string }
  | { ok: false; kind: "missing"; pluginDir: string }
  | { ok: false; kind: "stale"; pluginDir: string; detail: string }
  | { ok: false; kind: "shadowed"; pluginDir: string; shadowManifest: string };

/**
 * Injected filesystem probes so each caller controls its own probe cadence. The
 * producer passes per-cycle memoized freshness and inventory closures; the
 * dispatch CLI passes one-shot production probes. Both are invoked ONLY when a
 * cell is present and its manifest exists, in freshness-before-shadow order.
 */
export interface WorkerCellProbeDeps {
  dirExists: (path: string) => boolean;
  /** Verify the exact selected cell against the compiler-owned cohort. */
  probeFreshness: (pluginDir: string) => WorkerCellFreshness;
  /** Compare the exact selected cell with one preloaded-work inventory. */
  probeShadow: (pluginDir: string) => string | null;
}

/**
 * The shared resolution seam. Applies the producer's exact precedence over a
 * compose result: bad-matrix → provider-reject → out-of-matrix → missing →
 * stale/unverified cohort → exact-cell shadow → ok. Returns a machine-kind union;
 * each caller composes its own reason prose. Filesystem probes fire lazily in that
 * precedence order, so an earlier reject or cell-less launch never verifies or
 * inventories the worker plugin tree.
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
  // Provider-pin reject ranks after bad-matrix (no host matrix ⇒ no target to
  // validate) and before the compose reject — no cell composes when the pin
  // refuses, so `pluginDir` is null and the fallthrough never reaches disk.
  if (compose.providerReject !== undefined) {
    return {
      ok: false,
      kind: "provider-reject",
      reason: compose.providerReject.reason,
      provider: compose.providerReject.provider,
      direction: compose.providerReject.direction,
      assigned: compose.providerReject.assigned,
      target: compose.providerReject.target,
      ...(compose.providerReject.detail !== undefined
        ? { detail: compose.providerReject.detail }
        : {}),
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
  const freshness = deps.probeFreshness(pluginDir);
  if (!freshness.ok) {
    return {
      ok: false,
      kind: "stale",
      pluginDir,
      detail: freshness.detail,
    };
  }
  const shadowManifest = deps.probeShadow(pluginDir);
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

/**
 * Compose the operator reason for a `worker_provider` fail-closed reject (ADR
 * 0047) — the SHARED formatter the autopilot producer (sticky `DispatchFailed`)
 * AND manual `keeper dispatch` (synchronous refusal) both surface, so the two
 * paths name the same cells + direction for the same task + pin (the identical-
 * decision parity). Each of the three reasons is distinct and NAMES the assigned
 * cell, the mapped target (when relevant), the pin, and the direction; NONE ever
 * falls back to the assigned provider. The `worker-provider-*` prefixes are the
 * documented problem codes (docs/problem-codes.md). The closed switch is
 * `assertNever`-guarded so a new reason fails compilation here.
 */
export function providerRejectReason(reject: {
  reason: ProviderConstraintRejectReason;
  provider: WorkerProvider;
  direction: EquivalenceDirection;
  assigned: EquivalenceCell;
  target: EquivalenceCell | null;
  detail?: string;
}): string {
  const named = (c: EquivalenceCell): string => `${c.model}/${c.effort}`;
  const assigned = named(reject.assigned);
  const pin = reject.provider;
  const dir = reject.direction;
  switch (reject.reason) {
    case "no-map-entry":
      return (
        `worker-provider-no-map-entry: worker_provider=${pin} has no ${dir} ` +
        `equivalence entry for assigned cell ${assigned} — refusing to dispatch ` +
        "(no fallback to the assigned provider); add the mapping to " +
        "plugins/plan/provider-equivalence.yaml, re-run the drift gate, then retry"
      );
    case "target-not-on-host":
      return (
        `worker-provider-target-not-on-host: worker_provider=${pin} maps assigned ` +
        `cell ${assigned} (${dir}) to ${reject.target ? named(reject.target) : "(none)"}, ` +
        "which is not a dispatchable cell on the live host matrix — refusing to " +
        "dispatch (no fallback); fix the map target or the host matrix, then retry"
      );
    case "map-malformed":
      return (
        `worker-provider-map-malformed: worker_provider=${pin} cannot translate ` +
        `assigned cell ${assigned} (${dir}) — the equivalence map failed to load` +
        `${reject.detail !== undefined ? ` (${reject.detail})` : ""}; refusing to ` +
        "dispatch (no fallback); fix plugins/plan/provider-equivalence.yaml, then retry"
      );
    default:
      return assertNever(reject.reason);
  }
}
