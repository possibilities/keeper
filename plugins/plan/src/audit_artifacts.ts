// Close-phase audit artifact subtree — the byte-parity port of
// planctl/audit_artifacts.py: path helpers, the artifact schema version, the
// canonical order-independent commit-set hash, and a COMMIT-FREE atomic writer.
//
// `/plan:close` is a content-blind coordinator: every pipeline artifact (audit
// brief, report, verdict, follow-up plan) persists under gitignored
// `<primary_repo>/<data-dir>/state/audits/<epic_id>/`, validated at emission by
// the submit verbs.
//
// Why writeArtifact is NOT store.atomicWrite: atomicWrite records the path in
// the session touched-paths log, which the next mutating verb's auto-commit
// sweeps into a `chore(plan): …` commit. Audit artifacts live under
// gitignored `state/` and must NEVER draw a commit — like claim's worker brief,
// they are runtime-state-only. So writeArtifact uses atomicWriteRaw (same-dir
// tmp → fsync → rename → parent-dir fsync) with NO touched-paths bookkeeping,
// then chmods 0600 — distinct from atomicWrite/writeBrief, which omits the mode.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { SELECTION_SCHEMA_VERSION } from "./selection_sidecar.ts";
import { resolveDataDirOrDefault } from "./state_path.ts";
import { atomicWriteRaw, nowIso, serializeStateJson } from "./store.ts";
import { SELECTION_BRIEF_SCHEMA_VERSION } from "./verbs/selection_brief.ts";

/** Audit-artifact schema version. Integer, starts at 1; additive-only within a
 * version. computeCommitSetHash folds this in, so a bump invalidates every
 * prior hash. NOT `const` so a test can shift it the way Python monkeypatches
 * audit_artifacts.AUDIT_SCHEMA_VERSION to prove the fold-in. */
export let AUDIT_SCHEMA_VERSION = 1;

/** Override the schema version (test seam mirroring Python's monkeypatch). */
export function setAuditSchemaVersion(version: number): void {
  AUDIT_SCHEMA_VERSION = version;
}

/** Artifact basenames under `audits/<epic_id>/`. */
export const BRIEF_BASENAME = "brief.json";
export const REPORT_BASENAME = "report.md";
export const REPORT_META_BASENAME = "report.meta.json";
export const VERDICT_BASENAME = "verdict.json";
export const FOLLOWUP_BASENAME = "followup.yaml";

/** An on-disk artifact carries a `schema_version` newer than this code knows.
 * Carries the offending `found` version and the `known` ceiling so a reader verb
 * can surface both. A reader hard-fails on too-new rather than guessing at a
 * future shape. Mirrors ArtifactSchemaTooNewError. */
export class ArtifactSchemaTooNewError extends Error {
  readonly found: number;
  readonly known: number;

  constructor(found: number, known: number = AUDIT_SCHEMA_VERSION) {
    super(
      `audit artifact schema_version ${found} is newer than this ` +
        `keeper plan knows (${known}); upgrade keeper plan`,
    );
    this.name = "ArtifactSchemaTooNewError";
    this.found = found;
    this.known = known;
  }
}

/** `<primary_repo>/<data-dir>/state/audits` (a pure path — not created here).
 * The data dir is `.keeper/`. */
export function auditsRoot(primaryRepo: string): string {
  return join(
    resolveDataDirOrDefault(resolveResolved(primaryRepo)),
    "state",
    "audits",
  );
}

/** Per-epic artifact dir, creating the tree lazily at 0700 on both levels.
 * mkdir honors umask on create, so re-assert 0700 on `audits/` and the per-epic
 * subdir regardless of umask. Idempotent — a re-call only re-asserts the mode.
 * Mirrors audit_dir. */
export function auditDir(primaryRepo: string, epicId: string): string {
  const root = auditsRoot(primaryRepo);
  const epicDir = join(root, epicId);
  mkdirSync(epicDir, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(epicDir, 0o700);
  return epicDir;
}

export function briefPath(primaryRepo: string, epicId: string): string {
  return join(auditDir(primaryRepo, epicId), BRIEF_BASENAME);
}

export function reportPath(primaryRepo: string, epicId: string): string {
  return join(auditDir(primaryRepo, epicId), REPORT_BASENAME);
}

export function reportMetaPath(primaryRepo: string, epicId: string): string {
  return join(auditDir(primaryRepo, epicId), REPORT_META_BASENAME);
}

export function verdictPath(primaryRepo: string, epicId: string): string {
  return join(auditDir(primaryRepo, epicId), VERDICT_BASENAME);
}

export function followupPath(primaryRepo: string, epicId: string): string {
  return join(auditDir(primaryRepo, epicId), FOLLOWUP_BASENAME);
}

export function followupMetaPath(primaryRepo: string, epicId: string): string {
  return `${followupPath(primaryRepo, epicId)}.meta.json`;
}

/** The durable minted-marker basename a blocking close-gate stamps once it
 * scaffolds the follow-up. */
export const BLOCKING_FOLLOWUP_BASENAME = "blocking-followup.json";

/** `audits/<source_epic_id>/blocking-followup.json` (a pure path — never
 * created here, so a reader draws no side-effect). The marker's PRESENCE, paired
 * with the committed `blocks_closing_of` pointer on the follow-up epic, is the
 * disambiguator: pointer-found is an adopt/re-emit, marker-but-no-pointer is a
 * deleted-while-gated follow-up (a typed failure), neither is a never-minted
 * first pass. */
export function blockingFollowupPath(
  primaryRepo: string,
  sourceEpicId: string,
): string {
  return join(
    auditsRoot(primaryRepo),
    sourceEpicId,
    BLOCKING_FOLLOWUP_BASENAME,
  );
}

/** Persist the blocking-followup minted-marker for `sourceEpicId` COMMIT-FREE
 * (0600), recording which epic the gate scaffolded. Written only AFTER a
 * successful follow-up scaffold, so the marker never claims a mint that did not
 * land. Creates the per-epic audit tree. Returns the resolved path. */
export function writeBlockingFollowupMarker(
  primaryRepo: string,
  sourceEpicId: string,
  followupEpicId: string,
): string {
  auditDir(primaryRepo, sourceEpicId);
  return writeArtifact(
    blockingFollowupPath(primaryRepo, sourceEpicId),
    serializeStateJson({
      schema_version: AUDIT_SCHEMA_VERSION,
      source_epic_id: sourceEpicId,
      followup_epic_id: followupEpicId,
      minted_at: nowIso(),
    }),
  );
}

/** Read the blocking-followup minted-marker for `sourceEpicId`; null when
 * absent (never minted). A present-but-corrupt marker still returns non-null
 * (with an empty id) — a mint DID happen, so the caller fails closed rather than
 * blindly re-scaffolding. Never throws. */
export function readBlockingFollowupMarker(
  primaryRepo: string,
  sourceEpicId: string,
): { followupEpicId: string } | null {
  const path = blockingFollowupPath(primaryRepo, sourceEpicId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const id = parsed.followup_epic_id;
    return { followupEpicId: typeof id === "string" ? id : "" };
  } catch {
    return { followupEpicId: "" };
  }
}

// ---------------------------------------------------------------------------
// Per-task audit gate — the artifacts the block-machinery audit gate writes for
// a flagged task between its worker committing and stamping done. One artifact
// per task lives at `audits/<epic_id>/tasks/<task_id>.json`, task-id-keyed so
// parallel worktree lanes (each a distinct task) never write the same path.
// close-preflight references each as the brief's per-task `finding_ref`, and the
// close quality-auditor reads them for fingerprint dedup.
// ---------------------------------------------------------------------------

/** `audits/<epic_id>/tasks/` — the per-task artifact dir, created lazily at
 * 0700 (auditDir already asserts 0700 on the two parent levels; this re-asserts
 * it on the `tasks/` level regardless of umask). Idempotent. */
export function taskAuditDir(primaryRepo: string, epicId: string): string {
  const dir = join(auditDir(primaryRepo, epicId), "tasks");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

/** `audits/<epic_id>/tasks/<task_id>.json` (a pure path — never created). The
 * single canonical home for a task's audit result; close-preflight's per-task
 * `finding_ref` resolves here. */
export function taskFindingPath(
  primaryRepo: string,
  epicId: string,
  taskId: string,
): string {
  return join(auditsRoot(primaryRepo), epicId, "tasks", `${taskId}.json`);
}

/** Read + schema-gate the per-task finding artifact for (epic, task); null when
 * absent. Hard-fails ArtifactSchemaTooNewError on a too-new schema_version (the
 * shared reader gate), never guesses at a future shape. */
export function readTaskFinding(
  primaryRepo: string,
  epicId: string,
  taskId: string,
): Record<string, unknown> | null {
  return readArtifactJson(taskFindingPath(primaryRepo, epicId, taskId));
}

/** Atomically persist a per-task finding artifact COMMIT-FREE (0600), returning
 * the resolved path. Stamps `schema_version`, `task_id`, `epic_id`, and a
 * canonical `commit_set_hash` over the artifact's own `commits` groups — the
 * staleness key: a later audit against the same commit set short-circuits
 * (taskFindingCoversCommitSet). Creates the `tasks/` dir. Last-writer-wins, like
 * every audit artifact. */
export function writeTaskFinding(
  primaryRepo: string,
  epicId: string,
  taskId: string,
  finding: Record<string, unknown>,
): string {
  taskAuditDir(primaryRepo, epicId);
  const commits = coerceCommitGroups(finding.commits);
  const stamped = {
    ...finding,
    schema_version: AUDIT_SCHEMA_VERSION,
    task_id: taskId,
    epic_id: epicId,
    commit_set_hash: computeCommitSetHash(commits),
  };
  return writeArtifact(
    taskFindingPath(primaryRepo, epicId, taskId),
    serializeStateJson(stamped),
  );
}

/** True when a persisted per-task finding for (epic, task) already covers
 * `commitGroups` — its stamped `commit_set_hash` equals the hash of that set.
 * The crashed-and-resumed orchestrator's short-circuit: a fresh persisted result
 * means the audit already ran against this exact commit set, so skip the
 * re-audit. A missing artifact or an absent/mismatched hash reads false
 * (re-audit); a too-new schema surfaces via readArtifactJson's hard-fail. */
export function taskFindingCoversCommitSet(
  primaryRepo: string,
  epicId: string,
  taskId: string,
  commitGroups: CommitGroup[],
): boolean {
  const parsed = readTaskFinding(primaryRepo, epicId, taskId);
  if (parsed === null) {
    return false;
  }
  const stored = parsed.commit_set_hash;
  return (
    typeof stored === "string" && stored === computeCommitSetHash(commitGroups)
  );
}

export type ClosePhaseGrade = "satisfied" | "not_needed" | "unfinished";

export interface ClosePhaseResume {
  audit: ClosePhaseGrade;
  plan: ClosePhaseGrade;
  selection: ClosePhaseGrade;
  findings: number | null;
  fatal: boolean | null;
  followup_present: boolean;
  selection_verdict_path: string | null;
}

/** Grade persisted close artifacts against the freshly derived commit set.
 * Each phase is usable only after every preceding applicable phase is usable;
 * malformed, torn, stale, or too-new artifacts therefore invalidate that phase
 * and everything downstream. No persisted phase artifact is the ordinary fresh
 * close and returns null. */
export function closePhaseResume(
  primaryRepo: string,
  epicId: string,
  freshCommitSetHash: string,
): ClosePhaseResume | null {
  const auditRoot = join(auditsRoot(primaryRepo), epicId);
  const report = join(auditRoot, REPORT_BASENAME);
  const reportMeta = join(auditRoot, REPORT_META_BASENAME);
  const verdict = join(auditRoot, VERDICT_BASENAME);
  const followup = join(auditRoot, FOLLOWUP_BASENAME);
  const followupMeta = `${followup}.meta.json`;
  const stateDir = join(
    resolveDataDirOrDefault(resolveResolved(primaryRepo)),
    "state",
  );
  const selectionDir = join(stateDir, "selections", epicId);
  const selectionBrief = join(selectionDir, "followup-brief.json");
  const selectionVerdict = join(selectionDir, "followup-verdict.json");
  const phasePaths = [
    report,
    reportMeta,
    verdict,
    followup,
    followupMeta,
    selectionBrief,
    selectionVerdict,
  ];
  if (!phasePaths.some((path) => existsSync(path))) {
    return null;
  }

  const unfinished = (audit: ClosePhaseGrade): ClosePhaseResume => ({
    audit,
    plan: "unfinished",
    selection: "unfinished",
    findings: null,
    fatal: null,
    followup_present: false,
    selection_verdict_path: null,
  });

  const reportDoc = safeReadArtifact(reportMeta);
  if (
    !existsSync(report) ||
    !artifactHasKnownSchema(reportDoc) ||
    reportDoc.commit_set_hash !== freshCommitSetHash ||
    typeof reportDoc.findings !== "number" ||
    !Number.isInteger(reportDoc.findings) ||
    reportDoc.findings < 0
  ) {
    return unfinished("unfinished");
  }

  const findings = reportDoc.findings;
  if (findings === 0) {
    return {
      audit: "satisfied",
      plan: "not_needed",
      selection: "not_needed",
      findings,
      fatal: false,
      followup_present: false,
      selection_verdict_path: null,
    };
  }

  const verdictDoc = safeReadArtifact(verdict);
  if (
    !artifactHasKnownSchema(verdictDoc) ||
    verdictDoc.commit_set_hash !== freshCommitSetHash ||
    typeof verdictDoc.fatal !== "boolean" ||
    !Array.isArray(verdictDoc.decisions)
  ) {
    return {
      ...unfinished("satisfied"),
      findings,
    };
  }

  const fatal = verdictDoc.fatal;
  if (fatal) {
    return {
      audit: "satisfied",
      plan: "satisfied",
      selection: "not_needed",
      findings,
      fatal,
      followup_present: false,
      selection_verdict_path: null,
    };
  }

  const needsFollowup = verdictDoc.decisions.some((decision) => {
    if (decision === null || typeof decision !== "object") {
      return false;
    }
    const task = (decision as Record<string, unknown>).task;
    return typeof task === "number" && Number.isInteger(task) && task > 0;
  });
  if (!needsFollowup) {
    return {
      audit: "satisfied",
      plan: "satisfied",
      selection: "not_needed",
      findings,
      fatal,
      followup_present: false,
      selection_verdict_path: null,
    };
  }

  const followupDoc = safeReadArtifact(followupMeta);
  if (
    !existsSync(followup) ||
    !artifactHasKnownSchema(followupDoc) ||
    followupDoc.commit_set_hash !== freshCommitSetHash
  ) {
    return {
      ...unfinished("satisfied"),
      findings,
      fatal,
    };
  }

  let followupInputHash: string;
  try {
    followupInputHash = createHash("sha256")
      .update(readFileSync(followup))
      .digest("hex");
  } catch {
    return {
      ...unfinished("satisfied"),
      findings,
      fatal,
    };
  }

  const selectionBriefDoc = safeReadArtifact(
    selectionBrief,
    SELECTION_BRIEF_SCHEMA_VERSION,
  );
  const selectionVerdictDoc = safeReadArtifact(
    selectionVerdict,
    SELECTION_SCHEMA_VERSION,
  );
  const selectionProvenance =
    selectionVerdictDoc?.selection !== null &&
    typeof selectionVerdictDoc?.selection === "object" &&
    !Array.isArray(selectionVerdictDoc.selection)
      ? (selectionVerdictDoc.selection as Record<string, unknown>)
      : null;
  const selectionFresh =
    artifactHasKnownSchema(selectionBriefDoc, SELECTION_BRIEF_SCHEMA_VERSION) &&
    selectionBriefDoc.from_followup === true &&
    selectionBriefDoc.input_hash === followupInputHash &&
    artifactHasKnownSchema(selectionVerdictDoc, SELECTION_SCHEMA_VERSION) &&
    selectionProvenance?.input_hash === followupInputHash;

  return {
    audit: "satisfied",
    plan: "satisfied",
    selection: selectionFresh ? "satisfied" : "unfinished",
    findings,
    fatal,
    followup_present: true,
    selection_verdict_path: selectionFresh ? selectionVerdict : null,
  };
}

function safeReadArtifact(
  path: string,
  ceiling = AUDIT_SCHEMA_VERSION,
): Record<string, unknown> | null {
  try {
    return readArtifactJson(path, ceiling);
  } catch {
    return null;
  }
}

function artifactHasKnownSchema(
  artifact: Record<string, unknown> | null,
  ceiling = AUDIT_SCHEMA_VERSION,
): artifact is Record<string, unknown> {
  return (
    artifact !== null &&
    typeof artifact.schema_version === "number" &&
    Number.isInteger(artifact.schema_version) &&
    artifact.schema_version >= 1 &&
    artifact.schema_version <= ceiling
  );
}

/** Coerce an unknown `commits` field to a CommitGroup[] the hash accepts —
 * drop non-object entries so a malformed artifact never throws into the hash. */
function coerceCommitGroups(value: unknown): CommitGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (g) => g !== null && typeof g === "object" && !Array.isArray(g),
  ) as CommitGroup[];
}

export interface CommitGroup {
  repo: string;
  shas?: string[] | null;
}

/** Canonical, order-independent SHA-256 over an epic's source commit set —
 * byte-identical to compute_commit_set_hash. The hash pins the exact set of
 * source commits the close pipeline was run against; only the *set* of
 * (repo, sha) pairs matters.
 *
 * Per repo: SHAs are deduped + sorted lexicographically. The `{repo: [sorted]}`
 * map is serialized with sorted keys, compact separators, ensure_ascii. The
 * schema version is folded in, so a bump invalidates every prior hash. The
 * input is never mutated. The serialization must match Python's
 * `json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
 * byte-for-byte for the hash to match across engines. */
export function computeCommitSetHash(commitGroups: CommitGroup[]): string {
  const byRepo: { [repo: string]: string[] } = {};
  for (const group of commitGroups) {
    const repo = String(group.repo);
    const shas = group.shas ?? [];
    byRepo[repo] = Array.from(new Set(shas)).sort();
  }

  const canonical = {
    schema_version: AUDIT_SCHEMA_VERSION,
    commit_set: byRepo,
  };
  const payload = canonicalJson(canonical);
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

/** Serialize `value` byte-identical to Python
 * `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`:
 * recursive key sort, no inter-token spaces, \uXXXX-escaped non-ASCII. The
 * recursive sort + compact separators + ensure_ascii are exactly the three
 * facts a naive JSON.stringify gets wrong for the hash input. */
function canonicalJson(value: unknown): string {
  return ensureAscii(JSON.stringify(sortKeysDeep(value)));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: unknown } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function ensureAscii(serialized: string): string {
  let out = "";
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    out +=
      code >= 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : serialized[i];
  }
  return out;
}

/** Atomically write `content` to `path` COMMIT-FREE; return the resolved path.
 * Uses atomicWriteRaw (same-dir tmp → fsync → rename → parent-dir fsync, tmp
 * unlinked on any throw) which records NOTHING in the session touched-paths log,
 * so the next mutating verb's auto-commit never sweeps the artifact into a
 * data-dir commit — then chmods 0600. Deliberately NOT store.atomicWrite (it
 * touched-logs) and NOT writeBrief (it omits the mode). Mirrors write_artifact. */
export function writeArtifact(path: string, content: string): string {
  const dest = resolveResolved(path);
  atomicWriteRaw(dest, content);
  chmodSync(dest, 0o600);
  return realpathSync(dest);
}

/** Serialize `brief` to `audits/<epic_id>/brief.json` (atomic, commit-free).
 * Stable serialization (sorted keys, indent 2, trailing newline) keeps the
 * on-disk brief diff-friendly. Mirrors write_brief_artifact. */
export function writeBriefArtifact(
  primaryRepo: string,
  epicId: string,
  brief: Record<string, unknown>,
): string {
  return writeArtifact(
    briefPath(primaryRepo, epicId),
    serializeStateJson(brief),
  );
}

/** Read + parse an artifact's JSON, hard-failing on a schema_version above
 * `ceiling` (ArtifactSchemaTooNewError). Returns null when the file is absent
 * (the reader's missing-artifact path). */
export function readArtifactJson(
  path: string,
  ceiling = AUDIT_SCHEMA_VERSION,
): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    unknown
  >;
  const found = parsed.schema_version;
  if (typeof found === "number" && found > ceiling) {
    throw new ArtifactSchemaTooNewError(found, ceiling);
  }
  return parsed;
}

/** `str(Path(p).resolve())` — absolute, symlinks resolved when the path exists,
 * else the plain absolute form (never throws). */
function resolveResolved(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
