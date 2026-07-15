import { basename } from "node:path";
import { buildHarnessResumeArgv, HARNESS_DESCRIPTORS } from "../agent/harness";
import { type ResumeResolveFs, resolveClaudeCwd } from "../resume-resolve";
import type {
  CatalogSession,
  HistoryHarness,
  SessionResolutionCandidate,
} from "./model";

export const RESUME_PICKER_MAX = 50;

export type ResumeLivenessEvidenceStatus =
  | "live"
  | "dead"
  | "recycled"
  | "unknown";

export interface ResumeLivenessEvidence {
  jobId: string;
  pid: number | null;
  recordedStartTime: string | null;
  observedStartTime: string | null;
  status: ResumeLivenessEvidenceStatus;
}

export type ResumeLiveness =
  | {
      state: "live";
      reason: "positive_process_identity";
      evidence: ResumeLivenessEvidence[];
    }
  | {
      state: "not_live";
      reason: "positive_dead_or_recycled_identity";
      evidence: ResumeLivenessEvidence[];
    }
  | {
      state: "unknown";
      reason: "standalone_session" | "no_positive_process_identity";
      evidence: ResumeLivenessEvidence[];
    };

export interface ResumeLivenessDeps {
  isPidAlive(pid: number): boolean;
  readStartTime(pid: number): string | null;
}

/** Refuse-live uses only a positive `(pid,start_time)` identity. Missing process
 * facts and inconclusive probes remain unknown; they are never fabricated dead. */
export function probeResumeLiveness(
  session: CatalogSession,
  deps: ResumeLivenessDeps,
): ResumeLiveness {
  if (session.jobs.length === 0) {
    return {
      state: "unknown",
      reason: "standalone_session",
      evidence: [],
    };
  }

  const evidence: ResumeLivenessEvidence[] = [];
  for (const job of session.jobs) {
    const pid = job.pid;
    const recordedStartTime = job.startTime;
    if (
      pid === null ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      recordedStartTime === null ||
      recordedStartTime === ""
    ) {
      evidence.push({
        jobId: job.jobId,
        pid,
        recordedStartTime,
        observedStartTime: null,
        status: "unknown",
      });
      continue;
    }
    let alive: boolean;
    try {
      alive = deps.isPidAlive(pid);
    } catch {
      evidence.push({
        jobId: job.jobId,
        pid,
        recordedStartTime,
        observedStartTime: null,
        status: "unknown",
      });
      continue;
    }
    if (!alive) {
      evidence.push({
        jobId: job.jobId,
        pid,
        recordedStartTime,
        observedStartTime: null,
        status: "dead",
      });
      continue;
    }
    let observedStartTime: string | null;
    try {
      observedStartTime = deps.readStartTime(pid);
    } catch {
      observedStartTime = null;
    }
    evidence.push({
      jobId: job.jobId,
      pid,
      recordedStartTime,
      observedStartTime,
      status:
        observedStartTime === null
          ? "unknown"
          : observedStartTime === recordedStartTime
            ? "live"
            : "recycled",
    });
  }

  if (evidence.some((item) => item.status === "live")) {
    return {
      state: "live",
      reason: "positive_process_identity",
      evidence,
    };
  }
  if (
    evidence.length > 0 &&
    evidence.every(
      (item) => item.status === "dead" || item.status === "recycled",
    )
  ) {
    return {
      state: "not_live",
      reason: "positive_dead_or_recycled_identity",
      evidence,
    };
  }
  return {
    state: "unknown",
    reason: "no_positive_process_identity",
    evidence,
  };
}

export type ResumeIdentityResult =
  | { kind: "ok" }
  | { kind: "conflict"; reason: string; jobIds: string[] };

/** The artifact's harness/native id is authoritative. A Keeper alias may add
 * lookup and lifecycle metadata, but a divergent native id or transcript path
 * is a hard conflict, never a fallback target. */
export function validateResumeArtifactIdentity(
  session: CatalogSession,
  fs: ResumeResolveFs,
): ResumeIdentityResult {
  if (session.nativeId === "") {
    return {
      kind: "conflict",
      reason: "the selected artifact has an empty native session id",
      jobIds: session.jobs.map((job) => job.jobId),
    };
  }
  const artifactPath =
    session.artifact === null ? null : fs.realpath(session.artifact.path);
  const conflicts: string[] = [];
  for (const job of session.jobs) {
    if (job.harness !== session.harness || job.nativeId !== session.nativeId) {
      conflicts.push(job.jobId);
      continue;
    }
    if (
      artifactPath !== null &&
      job.transcriptPath !== null &&
      fs.realpath(job.transcriptPath) !== artifactPath
    ) {
      conflicts.push(job.jobId);
    }
  }
  return conflicts.length === 0
    ? { kind: "ok" }
    : {
        kind: "conflict",
        reason:
          "Keeper job alias identity conflicts with the selected native artifact",
        jobIds: [...new Set(conflicts)].sort(),
      };
}

export type ResumeArtifactCwdResult =
  | { kind: "resolved"; cwd: string; artifactPath: string }
  | {
      kind: "failed";
      code:
        | "artifact_missing"
        | "artifact_unreadable"
        | "artifact_identity_conflict"
        | "artifact_cwd_unresolved"
        | "cwd_vanished";
      reason: string;
      found: string[];
    };

/** Resolve the launch cwd from the exact selected artifact. Claude reuses the
 * transcript-tail resolver, pinned to this artifact; Pi's catalog project is
 * native transcript metadata and is canonicalized only after existence checks. */
export function resolveResumeArtifactCwd(
  session: CatalogSession,
  fs: ResumeResolveFs,
): ResumeArtifactCwdResult {
  if (session.artifact === null) {
    return {
      kind: "failed",
      code: "artifact_missing",
      reason: "the selected Session has no native transcript artifact",
      found: [],
    };
  }
  const artifactPath = fs.realpath(session.artifact.path);
  if (!fs.exists(artifactPath)) {
    return {
      kind: "failed",
      code: "artifact_missing",
      reason: `the selected transcript artifact is absent: ${artifactPath}`,
      found: [],
    };
  }
  if (fs.readTail(artifactPath, 1) === null) {
    return {
      kind: "failed",
      code: "artifact_unreadable",
      reason: `the selected transcript artifact is not a readable file: ${artifactPath}`,
      found: [artifactPath],
    };
  }
  if (session.harness === "claude") {
    const observedCwds = [
      session.project,
      ...session.jobs.map((job) => job.project),
    ].flatMap((value) => (value === null || value === "" ? [] : [value]));
    const resolution = resolveClaudeCwd(fs, {
      sessionId: session.nativeId,
      recordedCwd: session.project,
      projectRoots: [],
      observedCwds: [...new Set(observedCwds)],
      artifactPath,
    });
    if (resolution.kind === "resolved") {
      return {
        kind: "resolved",
        cwd: fs.realpath(resolution.cwd),
        artifactPath,
      };
    }
    if (resolution.kind === "preflight-failed") {
      return {
        kind: "failed",
        code: resolution.reason.includes("no longer exists")
          ? "cwd_vanished"
          : resolution.reason.includes("does not match")
            ? "artifact_identity_conflict"
            : "artifact_cwd_unresolved",
        reason: resolution.reason,
        found: resolution.found,
      };
    }
    return {
      kind: "failed",
      code: "artifact_cwd_unresolved",
      reason: "the selected Claude artifact did not resolve a launch cwd",
      found: [artifactPath],
    };
  }

  if (!basename(artifactPath).endsWith(`_${session.nativeId}.jsonl`)) {
    return {
      kind: "failed",
      code: "artifact_identity_conflict",
      reason: `the selected Pi artifact does not encode native session ${session.nativeId}`,
      found: [artifactPath],
    };
  }
  const project = session.project;
  if (project === null || project === "") {
    return {
      kind: "failed",
      code: "artifact_cwd_unresolved",
      reason: `the Pi artifact ${artifactPath} carries no project cwd`,
      found: [artifactPath],
    };
  }
  if (!fs.exists(project)) {
    return {
      kind: "failed",
      code: "cwd_vanished",
      reason: `the artifact-derived cwd no longer exists: ${project}`,
      found: [artifactPath],
    };
  }
  return { kind: "resolved", cwd: fs.realpath(project), artifactPath };
}

export interface ForegroundResumeLaunch {
  harness: HistoryHarness;
  target: string;
  cwd: string;
  qualifiedId: string;
  /** The descriptor-native base argv, before Keeper's launch carriers add their
   * normal account, plugin, statusline, and Pi lifecycle arguments. */
  baseNativeArgv: string[];
  /** Argv fed to the existing foreground `keeper agent` launcher. */
  agentArgv: string[];
  /** Pi only: the one unambiguous existing Keeper identity to revive. Null
   * clears any ambient carrier so the launcher mints a fresh alias safely. */
  keeperJobIdCarrier: string | null;
  liveness: ResumeLiveness;
}

type ResumeArtifactFailureCode = Extract<
  ResumeArtifactCwdResult,
  { kind: "failed" }
>["code"];

export type SelectedResumeDecision =
  | {
      kind: "launch";
      launch: ForegroundResumeLaunch;
      artifactPath: string;
    }
  | {
      kind: "live";
      session: CatalogSession;
      liveness: ResumeLiveness;
    }
  | {
      kind: "wrong_cwd";
      session: CatalogSession;
      targetCwd: string;
      currentCwd: string;
      artifactPath: string;
      liveness: ResumeLiveness;
    }
  | {
      kind: "failed";
      code:
        | ResumeArtifactFailureCode
        | "alias_conflict"
        | "current_cwd_vanished"
        | "unsupported_harness";
      reason: string;
      found: string[];
      liveness: ResumeLiveness | null;
      conflictJobIds?: string[];
    };

function oneKeeperJobCarrier(session: CatalogSession): string | null {
  if (session.harness !== "pi") return null;
  const ids = [...new Set(session.jobs.map((job) => job.jobId))];
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Complete dry decision for one already-selected Session. It never launches or
 * changes directory; callers may inspect the liveness/cwd metadata first. */
export function decideSelectedResume(
  session: CatalogSession,
  options: {
    fs: ResumeResolveFs;
    currentCwd: string;
    liveness: ResumeLivenessDeps;
  },
): SelectedResumeDecision {
  if (session.harness !== "claude" && session.harness !== "pi") {
    return {
      kind: "failed",
      code: "unsupported_harness",
      reason: `foreground resume does not support harness '${String(session.harness)}'`,
      found: session.artifact === null ? [] : [session.artifact.path],
      liveness: null,
    };
  }
  const identity = validateResumeArtifactIdentity(session, options.fs);
  if (identity.kind === "conflict") {
    return {
      kind: "failed",
      code: "alias_conflict",
      reason: identity.reason,
      found: session.artifact === null ? [] : [session.artifact.path],
      liveness: null,
      conflictJobIds: identity.jobIds,
    };
  }
  const liveness = probeResumeLiveness(session, options.liveness);
  if (liveness.state === "live") {
    return { kind: "live", session, liveness };
  }
  const artifact = resolveResumeArtifactCwd(session, options.fs);
  if (artifact.kind === "failed") {
    return { ...artifact, liveness };
  }
  if (!options.fs.exists(options.currentCwd)) {
    return {
      kind: "failed",
      code: "current_cwd_vanished",
      reason: `the current cwd no longer exists: ${options.currentCwd}`,
      found: [],
      liveness,
    };
  }
  const currentCwd = options.fs.realpath(options.currentCwd);
  if (currentCwd !== artifact.cwd) {
    return {
      kind: "wrong_cwd",
      session,
      targetCwd: artifact.cwd,
      currentCwd,
      artifactPath: artifact.artifactPath,
      liveness,
    };
  }

  const nativeResume = buildHarnessResumeArgv(
    session.harness,
    session.nativeId,
  );
  return {
    kind: "launch",
    artifactPath: artifact.artifactPath,
    launch: {
      harness: session.harness,
      target: session.nativeId,
      cwd: artifact.cwd,
      qualifiedId: session.qualifiedNativeId,
      baseNativeArgv: [
        HARNESS_DESCRIPTORS[session.harness].binaryName,
        ...nativeResume,
      ],
      agentArgv: [session.harness, "--x-no-confirm", ...nativeResume],
      keeperJobIdCarrier: oneKeeperJobCarrier(session),
      liveness,
    },
  };
}

function boundedInline(
  value: string | null,
  max: number,
  fallback = "(untitled)",
): string {
  if (value === null) return fallback;
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const inline = printable.replace(/\s+/g, " ");
  return inline.length <= max ? inline : `${inline.slice(0, max - 1)}…`;
}

/** Bounded candidate rows for both the TTY menu and ambiguity envelopes. */
export function boundedResumeCandidates(
  candidates: readonly CatalogSession[],
  max = RESUME_PICKER_MAX,
): CatalogSession[] {
  const cap = Math.max(1, Math.min(RESUME_PICKER_MAX, Math.trunc(max)));
  return candidates.slice(0, cap);
}

/** Numbered TTY chooser. Every row carries the contract fields while hostile or
 * enormous title/project text is flattened and bounded. */
export function formatResumePicker(
  candidates: readonly CatalogSession[],
): string {
  return candidates
    .map(
      (session, index) =>
        `  [${index + 1}] ${session.harness}  ${boundedInline(session.currentTitle, 100)}  ` +
        `${boundedInline(session.qualifiedNativeId, 180)}  ` +
        `project=${boundedInline(session.project, 180, "unknown")}  ` +
        `updated=${session.updatedAt ?? "unknown"}`,
    )
    .join("\n");
}

export type ResumePickerChoice =
  | { kind: "selected"; index: number }
  | { kind: "cancelled" }
  | { kind: "invalid" };

export function parseResumePickerChoice(
  answer: string | null,
  count: number,
): ResumePickerChoice {
  if (answer === null) return { kind: "cancelled" };
  const trimmed = answer.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "q") {
    return { kind: "cancelled" };
  }
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const selected = Number(trimmed);
  return Number.isSafeInteger(selected) && selected >= 1 && selected <= count
    ? { kind: "selected", index: selected - 1 }
    : { kind: "invalid" };
}

export function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The wrong-cwd command is display-only data. It is never fed to a shell. */
export function buildResumeReentryCommand(options: {
  cwd: string;
  qualifiedId: string;
  project?: string | null;
}): string {
  const project = options.project;
  return (
    `cd -- ${posixShellQuote(options.cwd)} && keeper resume ` +
    `${posixShellQuote(options.qualifiedId)}` +
    (project === undefined || project === null || project === ""
      ? ""
      : ` --project ${posixShellQuote(project)}`)
  );
}

export function publicResolutionCandidate(
  session: CatalogSession,
): SessionResolutionCandidate & { updatedAt: string | null } {
  return {
    sessionKey: session.sessionKey,
    harness: session.harness,
    nativeId: session.nativeId,
    qualifiedNativeId: session.qualifiedNativeId,
    project: session.project,
    currentTitle: session.currentTitle,
    jobIds: session.jobs.map((job) => job.jobId).sort(),
    artifactPath: session.artifact?.path ?? null,
    updatedAt: session.updatedAt,
  };
}
