// Worker-cell path + compose helpers — the fs/os-free leaf the reconcile-core
// closure adopts (ADR 0036). Holds the {model × effort} cell-path convention
// and the pure {model, effort} → worker-agent compose over EXPLICIT axes, so the
// axis SOURCE (a host matrix snapshot) is the caller's choice and this module
// never reads the filesystem or environment.
//
// This module imports NO node:fs / node:os (the reconcile-core relative-import
// closure bans them; test/reconcile-core-depgraph.test.ts pins the boundary).

/** The workers-base directory (relative to the plan plugin root) under which the
 * renderer fans out one self-contained `work` plugin per {model × effort} cell.
 * A SINGLE shared constant so the launcher's `--plugin-dir` cell selection and the
 * renderer's cell-write path resolve the same tree and can't drift. */
export const WORKERS_BASE = "workers";

/** The per-cell plugin dir (relative to the plan plugin root) for a
 * {model, effort} pair: `workers/<model>-<effort>`. The renderer stamps each cell
 * here; the launcher selects one here via `--plugin-dir`. Order (model then
 * effort) mirrors the cell-naming convention. */
export function workerCellDir(model: string, effort: string): string {
  return `${WORKERS_BASE}/${model}-${effort}`;
}

/** Pure {model, effort} → worker-agent-name composition over an explicit model
 * axis + a per-model effort resolver. Returns null on EITHER null axis (the
 * /plan:work null-stop signal); throws the corrupt-on-disk guard for a non-null
 * value outside its axis. The tier is validated against the MODEL's effective
 * effort list (`effortsFor`), so a ragged host roster rejects a tier the model
 * cannot render; an unknown model resolves the top-level fallback, leaving the
 * separate model-membership throw to name it. The axis SOURCE — the host-effective
 * matrix — is the caller's choice, so this composer stays fs-free and safe for the
 * pure reconcile-core closure. */
export function composeWorkerAgent(
  effortsFor: (model: string) => readonly string[],
  models: readonly string[],
  tier: string | null,
  model: string | null,
): string | null {
  if (tier === null || model === null) {
    return null;
  }
  const efforts = effortsFor(model);
  if (!efforts.includes(tier)) {
    throw new Error(
      `unknown tier ${JSON.stringify(tier)}; expected one of ${efforts.join(", ")} or null`,
    );
  }
  if (!models.includes(model)) {
    throw new Error(
      `unknown model ${JSON.stringify(model)}; expected one of ${models.join(", ")} or null`,
    );
  }
  return `plan:worker-${model}-${tier}`;
}
