// Selection sidecar — the provenance record every `assign-cells` run writes.
//
// A schema-versioned, git-committed JSON capturing everything the model-effort
// selector saw and set for one epic's cells: the applied {tier, model,
// rationale, confidence, label_source} per task plus the selector's own
// provenance block (harness/model, config + input hashes, shuffle seed, outcome,
// raw verdict). It is the transitional dataset — label_source-tagged,
// hash-anchored — that heuristic-guided selection generates until historical
// usage data can replace the heuristics.
//
// PATH — the sidecar lands at `<data-dir>/selections/<epic_id>.json`, a
// TOP-LEVEL data-dir sibling of `epics/` / `tasks/` / `specs/`, deliberately NOT
// under `<data-dir>/state/`. Two invariants force this home:
//   - It must be COMMITTED (git-recoverable for offline analysis) and ride the
//     SAME auto-commit as the cell writes. The verb auto-commit stages the
//     intersection of the touched-paths log with git's dirty set; a path under
//     the gitignored `state/` subtree is never dirty, so a sidecar there would be
//     silently dropped from the commit. A top-level `selections/` path is not
//     gitignored, so `atomicWriteJson` (which records the touched path) lands it
//     in the commit exactly as the cell writes land.
//   - It must NOT be folded by the daemon plan worker. classifyPlanPath folds
//     only `epics/`, `tasks/`, and `state/{tasks,epics}/*.state.json`; a
//     `selections/<id>.json` path classifies as none, so the daemon skips it.
// A re-select REPLACES the sidecar (idempotent, single JSON object — no append).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./store.ts";

/** Selection-sidecar schema version. Integer, starts at 1; additive-only within
 * a version so a later reader tolerates an older sidecar. */
export const SELECTION_SCHEMA_VERSION = 1;

/** The data-dir-relative directory holding per-epic selection sidecars. */
export const SELECTIONS_DIRNAME = "selections";

/** One applied cell in the sidecar: the {tier, model} set on a task plus the
 * selector's per-cell provenance (rationale / confidence / label_source). */
export interface SidecarCell {
  task_id: string;
  tier: string;
  model: string;
  /** The selector's free-text justification, or null when omitted. */
  rationale: string | null;
  /** The selector's confidence signal, stored opaque (number or string), or
   * null when omitted. */
  confidence: number | string | null;
  /** Dataset-era tag — e.g. `heuristic-guided` for a real selection,
   * `heuristic-default` for a degrade that stamped the mechanical default. */
  label_source: string;
}

/** The selector's own {harness, model} — which agent produced this selection. */
export interface SidecarSelector {
  harness: string;
  model: string;
}

/** The full selection sidecar written to `<data-dir>/selections/<epic_id>.json`. */
export interface SelectionSidecar {
  schema_version: number;
  epic_id: string;
  /** Wall-clock stamp via the store clock seam (nowIso; KEEPER_PLAN_NOW-aware). */
  created_at: string;
  selector: SidecarSelector;
  /** Hash of the selector config the run used — joins the dataset by config era. */
  config_hash: string;
  /** Hash of the epic/task inputs the selector saw. */
  input_hash: string;
  /** Candidate-order shuffle seed the selector recorded, or null. */
  shuffle_seed: number | null;
  /** `completed` or `degraded:<reason>` — captured verbatim from the selector. */
  outcome: string;
  /** The selector's raw verdict text, or null on a degrade with no verdict. */
  verdict_raw: string | null;
  cells: SidecarCell[];
}

/** Absolute path to the selection sidecar for `epicId` under `dataDir`. */
export function selectionSidecarPath(dataDir: string, epicId: string): string {
  return join(dataDir, SELECTIONS_DIRNAME, `${epicId}.json`);
}

/** Read + parse the selection sidecar for `epicId`, or null when it is absent or
 * unparseable. The close-time selection auditor reads it for each executed cell's
 * rationale / confidence / label_source plus the run's config + input hashes; a
 * missing sidecar means the epic never ran through the cell selector, so grading
 * has no provenance to ground on and the caller fails loud rather than guessing. */
export function readSelectionSidecar(
  dataDir: string,
  epicId: string,
): SelectionSidecar | null {
  const path = selectionSidecarPath(dataDir, epicId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SelectionSidecar;
  } catch {
    return null;
  }
}

/** Write (REPLACE) the selection sidecar atomically, recording the touched path
 * so it rides the verb's auto-commit alongside the cell writes. Returns the
 * absolute path written. A prior sidecar for the same epic is overwritten, never
 * appended to (idempotent re-select). */
export function writeSelectionSidecar(
  dataDir: string,
  sidecar: SelectionSidecar,
): string {
  const path = selectionSidecarPath(dataDir, sidecar.epic_id);
  atomicWriteJson(path, sidecar as unknown as Record<string, unknown>, dataDir);
  return path;
}
