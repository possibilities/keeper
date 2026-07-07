// Out-of-band selection-review artifact subtree — the path/schema seam shared
// by the audit-brief assembler and the review-submit verb.
//
// Two artifacts, both COMMITTED top-level data-dir siblings — deliberately NOT
// under `state/`, so each rides its writing verb's auto-commit the same way the
// selection sidecar does (a `state/` path is gitignored and would be silently
// dropped from the commit):
//   - The AUDIT BRIEF is the content-blind grading packet a human-invoked
//     grading skill hands its auditor, at
//     `<data-dir>/selection-audit-briefs/<epic>.json`. It carries no selector
//     rationale/confidence/label_source — those stay in the selection sidecar
//     for calibration only, kept from the blinded grading pass.
//   - The REVIEW FILE is the per-epic verdict dataset the submit verb writes at
//     `<data-dir>/selection-reviews/<epic>.json`. Each verdict snapshots the
//     graded {tier, model} + the selection config/input hashes so a future
//     re-select cannot orphan the join back to the selection sidecar.
//
// Unlike the selection sidecar's REPLACE contract, both artifacts are
// write-once, each guarded on its OWN existence: a repeat `selection-audit-brief`
// skips idempotently (a re-close is not a re-audit), and `selection-review-submit`
// refuses a second write; both accept `--force` to deliberately re-derive.
//
// Neither directory is folded by the daemon plan worker — classifyPlanPath folds
// only `epics/`, `tasks/`, and `state/{tasks,epics}/*.state.json`; a
// `selection-audit-briefs/<id>.json` or `selection-reviews/<id>.json` path
// classifies as none, so the daemon skips both.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./store.ts";

/** Committed audit-brief schema version. Integer, starts at 1; additive-only
 * within a version so a later reader tolerates an older brief. */
export const SELECTION_AUDIT_BRIEF_SCHEMA_VERSION = 1;

/** Committed review-file schema version. Integer, starts at 1; additive-only.
 * Bumped to 2 when rubric_version/judge_model_version/prompt_hash joined the
 * existing config/input hashes — an older file simply lacks the three keys. */
export const SELECTION_REVIEW_SCHEMA_VERSION = 2;

/** The data-dir-relative directory holding per-epic committed audit briefs. */
export const SELECTION_AUDIT_BRIEFS_DIRNAME = "selection-audit-briefs";

/** The data-dir-relative directory holding per-epic committed review files. */
export const SELECTION_REVIEWS_DIRNAME = "selection-reviews";

/** The three-way categorical verdict every auditable cell is graded on. Coarse
 * by design — a fine numeric scale manufactures false precision the assemblable
 * signal set cannot support. */
export const REVIEW_VERDICT_VALUES = [
  "underpowered",
  "right_sized",
  "overpowered",
] as const;

export type ReviewVerdictValue = (typeof REVIEW_VERDICT_VALUES)[number];

/** True iff `v` is one of the three categorical verdicts. */
export function isReviewVerdictValue(v: unknown): v is ReviewVerdictValue {
  return (
    typeof v === "string" &&
    (REVIEW_VERDICT_VALUES as readonly string[]).includes(v)
  );
}

/** One graded cell in the committed review file: the auditor's verdict + one
 * evidence sentence, snapshotting the graded {tier, model} and the selection run's
 * config/input hashes so the row joins to the selection sidecar across future
 * re-selects. */
export interface ReviewVerdict {
  task_id: string;
  verdict: ReviewVerdictValue;
  /** One concise evidence sentence grounding the verdict in the outcome record. */
  evidence: string;
  /** The graded cell — snapshotted, never re-read from the moving task JSON. */
  tier: string;
  model: string;
  /** The selection run's provenance hashes (from the sidecar) at grade time. */
  config_hash: string;
  input_hash: string;
}

/** Verdict tallies across the graded cells. `right_sized` stays silent; the flag
 * fires only when `underpowered + overpowered > 0`. */
export interface ReviewCounts {
  underpowered: number;
  right_sized: number;
  overpowered: number;
}

/** The committed per-epic selection-review dataset. */
export interface SelectionReviewFile {
  schema_version: number;
  epic_id: string;
  /** Wall-clock stamp via the store clock seam (nowIso; KEEPER_PLAN_NOW-aware). */
  created_at: string;
  /** The selection run's hashes this review grades against (epic-level). */
  selection_config_hash: string;
  selection_input_hash: string;
  /** The grading run's own provenance keys — a rubric or judge-model change (or
   * a re-rendered prompt) never masquerades as a policy shift when cohorts are
   * compared. Absent on a schema_version 1 file predating this key set. */
  rubric_version: string;
  judge_model_version: string;
  prompt_hash: string;
  counts: ReviewCounts;
  verdicts: ReviewVerdict[];
}

/** Absolute path to the committed audit brief for `epicId` under `dataDir`
 * (`<data-dir>/selection-audit-briefs/<epic>.json`). */
export function selectionAuditBriefPath(
  dataDir: string,
  epicId: string,
): string {
  return join(dataDir, SELECTION_AUDIT_BRIEFS_DIRNAME, `${epicId}.json`);
}

/** True when a committed audit brief already exists for `epicId` — the
 * write-once guard the brief verb consults on its OWN existence (refuse
 * without --force; a re-close skips idempotently). */
export function selectionAuditBriefExists(
  dataDir: string,
  epicId: string,
): boolean {
  return existsSync(selectionAuditBriefPath(dataDir, epicId));
}

/** Write the committed audit-brief file atomically, recording the touched path
 * so it rides the brief verb's auto-commit. Returns the absolute path written. */
export function writeSelectionAuditBriefFile(
  dataDir: string,
  epicId: string,
  brief: Record<string, unknown>,
): string {
  const path = selectionAuditBriefPath(dataDir, epicId);
  atomicWriteJson(path, brief, dataDir);
  return path;
}

/** Absolute path to the committed review file for `epicId` under `dataDir`
 * (`<data-dir>/selection-reviews/<epic>.json`). */
export function selectionReviewPath(dataDir: string, epicId: string): string {
  return join(dataDir, SELECTION_REVIEWS_DIRNAME, `${epicId}.json`);
}

/** True when a committed review file already exists for `epicId` — the write-once
 * guard the submit verb consults (refuse without --force). */
export function selectionReviewExists(
  dataDir: string,
  epicId: string,
): boolean {
  return existsSync(selectionReviewPath(dataDir, epicId));
}

/** Write the committed review file atomically, recording the touched path so it
 * rides the submit verb's auto-commit. Returns the absolute path written. */
export function writeSelectionReviewFile(
  dataDir: string,
  file: SelectionReviewFile,
): string {
  const path = selectionReviewPath(dataDir, file.epic_id);
  atomicWriteJson(path, file as unknown as Record<string, unknown>, dataDir);
  return path;
}
