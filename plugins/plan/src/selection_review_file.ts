// Close-time selection-review artifact subtree — the path/schema seam shared by
// the audit-brief assembler and the review-submit verb.
//
// Two artifacts, two homes, deliberately distinct:
//   - The AUDIT BRIEF is the content-blind handoff the auditor subagent reads. It
//     lands commit-free under the gitignored `<state>/selections/<epic>/audit-brief.json`
//     (a sibling of selection-brief's `brief.json`), so a re-run overwrites it and
//     it never draws a commit — exactly like the close-preflight brief.
//   - The REVIEW FILE is the COMMITTED per-epic dataset the submit verb writes at
//     `<data-dir>/selection-reviews/<epic>.json` — a TOP-LEVEL data-dir sibling of
//     `selections/`, NOT under `state/`, so it rides the submit verb's auto-commit
//     (a `state/` path is gitignored and would be silently dropped). Each verdict
//     snapshots the graded {tier, model} + the selection config/input hashes so a
//     future re-select cannot orphan the join back to the selection sidecar.
//
// Unlike the selection sidecar's REPLACE contract, the review file is write-once:
// the audit-brief + submit verbs both refuse a second write without `--force`, so
// a committed verdict set is never silently clobbered.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, serializeStateJson } from "./store.ts";

/** Audit-brief schema version. Integer, starts at 1; additive-only within a
 * version so a later reader tolerates an older brief. */
export const SELECTION_AUDIT_BRIEF_SCHEMA_VERSION = 1;

/** Committed review-file schema version. Integer, starts at 1; additive-only. */
export const SELECTION_REVIEW_SCHEMA_VERSION = 1;

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
  counts: ReviewCounts;
  verdicts: ReviewVerdict[];
}

/** Absolute path to the commit-free audit brief for `epicId` under `stateDir`
 * (the gitignored `<state>/selections/<epic>/audit-brief.json`). */
export function selectionAuditBriefPath(
  stateDir: string,
  epicId: string,
): string {
  return join(stateDir, "selections", epicId, "audit-brief.json");
}

/** Absolute path to the committed review file for `epicId` under `dataDir`
 * (`<data-dir>/selection-reviews/<epic>.json`). */
export function selectionReviewPath(dataDir: string, epicId: string): string {
  return join(dataDir, SELECTION_REVIEWS_DIRNAME, `${epicId}.json`);
}

/** True when a committed review file already exists for `epicId` — the write-once
 * guard both the audit-brief and submit verbs consult (refuse without --force). */
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

/** Serialize the audit brief to state JSON (sorted keys, trailing newline) — the
 * exact bytes the commit-free writer lands. Exposed so the brief verb and its
 * tests share one serialization. */
export function serializeAuditBrief(brief: Record<string, unknown>): string {
  return serializeStateJson(brief);
}
