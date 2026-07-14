#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs as parseNodeArgs } from "node:util";
import type { MainDeps } from "../src/agent/main";
import { resolveDbPath } from "../src/db";
import type { HistoryCatalogAdapter } from "../src/history/catalog";
import { loadSessionCatalog } from "../src/history/load-catalog";
import type {
  CatalogSession,
  SessionCatalog,
  SessionReferenceMatch,
} from "../src/history/model";
import { resolveSessionReference } from "../src/history/resolver";
import {
  boundedResumeCandidates,
  buildResumeReentryCommand,
  decideSelectedResume,
  type ForegroundResumeLaunch,
  formatResumePicker,
  parseResumePickerChoice,
  publicResolutionCandidate,
  RESUME_PICKER_MAX,
  type ResumeLiveness,
  type ResumeLivenessDeps,
} from "../src/history/resume";
import { keeperStateDir } from "../src/keeper-state-dir";
import {
  nodeResumeResolveFs,
  type ResumeResolveFs,
} from "../src/resume-resolve";
import { readOsStartTime } from "../src/seed-sweep";
import { isPidAlive } from "../src/server-worker";
import { parseOptions } from "./descriptor";
import { errorEnvelope } from "./envelope";

export const RESUME_SCHEMA_VERSION = 1;

export const HELP = `keeper resume <session-reference> [options]

Resolve a Claude/Pi Session through the shared catalog and continue it in the
foreground. Titles are selectors only; the native harness always receives the
full native session id. Ambiguity is never resolved by recency.

Options:
  --project <path>       Restrict resolution to one artifact-derived project
  --format human|json    Decision/error format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help without scanning history
`;

export interface ResumeCliResult {
  code: number;
  stdout: string;
  stderr: string;
  launch: ForegroundResumeLaunch | null;
}

export interface ResumeCliDeps {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  dbPath: string;
  stateDir: string;
  fs: ResumeResolveFs;
  catalog?: SessionCatalog;
  catalogAdapters?: readonly HistoryCatalogAdapter[];
  loadCatalog?: () => SessionCatalog;
  isTty: boolean;
  /** Injected line picker. Production renders the supplied bounded candidates;
   * tests return a line without opening a real terminal. */
  pick(
    candidates: readonly CatalogSession[],
    total: number,
  ): Promise<string | null>;
  liveness: ResumeLivenessDeps;
  /** Foreground process seam. Production delegates to the existing keeper-agent
   * launcher; tests never start a real harness. The returned status propagates. */
  launchForeground(request: ForegroundResumeLaunch): Promise<number>;
}

function result(
  code: number,
  stdout = "",
  stderr = "",
  launch: ForegroundResumeLaunch | null = null,
): ResumeCliResult {
  return { code, stdout, stderr, launch };
}

function usage(message: string): ResumeCliResult {
  return result(2, "", `keeper resume: ${message}\n\n${HELP}`);
}

function parseFormat(
  values: Record<string, unknown>,
): "human" | "json" | string {
  const explicit = typeof values.format === "string" ? values.format : null;
  if (values.json === true && explicit !== null && explicit !== "json") {
    return `--json conflicts with --format ${explicit}`;
  }
  const format = values.json === true ? "json" : (explicit ?? "human");
  return format === "human" || format === "json"
    ? format
    : `--format must be human or json (got '${format}')`;
}

function jsonFailure(
  code: string,
  message: string,
  recovery: string,
  details?: unknown,
): ResumeCliResult {
  return result(
    1,
    `${JSON.stringify(
      errorEnvelope(RESUME_SCHEMA_VERSION, {
        code,
        message,
        recovery,
        ...(details === undefined ? {} : { details }),
      }),
      null,
      2,
    )}\n`,
  );
}

function failure(
  format: "human" | "json",
  code: string,
  message: string,
  recovery: string,
  options: { details?: unknown; structured?: boolean } = {},
): ResumeCliResult {
  if (format === "json" || options.structured === true) {
    return jsonFailure(code, message, recovery, options.details);
  }
  return result(1, "", `keeper resume: ${message}\nrecovery: ${recovery}\n`);
}

function livenessData(liveness: ResumeLiveness | null): unknown {
  if (liveness === null) return null;
  return {
    state: liveness.state,
    reason: liveness.reason,
    evidence: liveness.evidence.map((item) => ({
      job_id: item.jobId,
      pid: item.pid,
      recorded_start_time: item.recordedStartTime,
      observed_start_time: item.observedStartTime,
      status: item.status,
    })),
  };
}

function decisionDetails(
  session: CatalogSession,
  liveness: ResumeLiveness | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    harness: session.harness,
    qualified_id: session.qualifiedNativeId,
    native_target: session.nativeId,
    current_title: session.currentTitle,
    project: session.project,
    artifact_path: session.artifact?.path ?? null,
    liveness: livenessData(liveness),
    ...extra,
  };
}

function loadCatalog(deps: ResumeCliDeps): SessionCatalog {
  if (deps.catalog !== undefined) return deps.catalog;
  if (deps.loadCatalog !== undefined) return deps.loadCatalog();
  return loadSessionCatalog({
    root: { homeDir: deps.homeDir, env: deps.env },
    dbPath: deps.dbPath,
    stateDir: deps.stateDir,
    adapters: deps.catalogAdapters,
    completeTitleHistory: true,
  });
}

function canonicalPath(path: string, fs: ResumeResolveFs): string {
  return fs.exists(path) ? fs.realpath(path) : resolve(path);
}

function constrainProject(
  catalog: SessionCatalog,
  project: string | null,
  fs: ResumeResolveFs,
): SessionCatalog {
  if (project === null) return catalog;
  return {
    ...catalog,
    sessions: catalog.sessions.filter(
      (session) =>
        session.project !== null &&
        canonicalPath(session.project, fs) === project,
    ),
  };
}

function sessionsForResolution(
  catalog: SessionCatalog,
  sessionKeys: readonly string[],
): CatalogSession[] {
  const byKey = new Map(
    catalog.sessions.map((session) => [session.sessionKey, session]),
  );
  return sessionKeys.flatMap((key) => {
    const session = byKey.get(key);
    return session === undefined ? [] : [session];
  });
}

function ambiguityDetails(
  match: SessionReferenceMatch,
  candidates: readonly CatalogSession[],
  total: number,
): Record<string, unknown> {
  return {
    match,
    candidate_count: total,
    candidates_truncated: candidates.length < total,
    candidates: candidates.map((session) => {
      const item = publicResolutionCandidate(session);
      return {
        session_key: item.sessionKey,
        harness: item.harness,
        native_id: item.nativeId,
        qualified_id: item.qualifiedNativeId,
        project: item.project,
        current_title: item.currentTitle,
        updated_at: item.updatedAt,
        job_ids: item.jobIds,
        artifact_path: item.artifactPath,
      };
    }),
  };
}

/** Return the project flag needed to make a qualified-id re-entry unique. A null
 * result means no flag is needed; `false` means project cannot disambiguate the
 * duplicate artifacts and no unsafe command should be printed. */
function reentryProject(
  catalog: SessionCatalog,
  selected: CatalogSession,
  fs: ResumeResolveFs,
): string | null | false {
  const sameId = catalog.sessions.filter(
    (session) =>
      session.harness === selected.harness &&
      session.nativeId === selected.nativeId,
  );
  if (sameId.length <= 1) return null;
  if (selected.project === null || selected.project === "") return false;
  const project = canonicalPath(selected.project, fs);
  const narrowed = sameId.filter(
    (session) =>
      session.project !== null &&
      canonicalPath(session.project, fs) === project,
  );
  return narrowed.length === 1 ? project : false;
}

/** Distinct catalog artifacts that collapse onto the same public
 * `(harness,native-id,project)` native resume key cannot be made safe by a
 * picker: the harness argv has no artifact-path slot. */
function collidingNativeArtifacts(
  catalog: SessionCatalog,
  selected: CatalogSession,
  fs: ResumeResolveFs,
): CatalogSession[] {
  const selectedProject =
    selected.project === null ? null : canonicalPath(selected.project, fs);
  return catalog.sessions.filter(
    (session) =>
      session.harness === selected.harness &&
      session.nativeId === selected.nativeId &&
      (session.project === null
        ? selectedProject === null
        : canonicalPath(session.project, fs) === selectedProject),
  );
}

function isSpawnNotFound(error: unknown): error is { path: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT" &&
    typeof (error as { path?: unknown }).path === "string"
  );
}

/** Parse, resolve, preflight, and (only on a same-cwd unambiguous decision)
 * invoke the injected foreground launcher. */
export async function runResumeCli(
  argv: string[],
  injected?: ResumeCliDeps,
): Promise<ResumeCliResult> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("resume"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) return result(0, HELP);
  if (parsed.positionals.length !== 1) {
    return usage(
      parsed.positionals.length === 0
        ? "<session-reference> is required"
        : "too many arguments",
    );
  }
  const format = parseFormat(parsed.values);
  if (format !== "human" && format !== "json") return usage(format);
  if (
    parsed.values.project !== undefined &&
    (typeof parsed.values.project !== "string" ||
      parsed.values.project.length === 0)
  ) {
    return usage("--project requires a non-empty path");
  }

  const deps = injected ?? defaultResumeCliDeps();
  const project =
    typeof parsed.values.project === "string"
      ? canonicalPath(resolve(deps.cwd, parsed.values.project), deps.fs)
      : null;
  let fullCatalog: SessionCatalog;
  try {
    fullCatalog = loadCatalog(deps);
  } catch {
    return failure(
      format,
      "catalog_read_failed",
      "could not read the shared Session catalog",
      "Confirm native history roots and keeper.db are readable, then retry.",
    );
  }
  const catalog = constrainProject(fullCatalog, project, deps.fs);
  const reference = parsed.positionals[0] as string;
  const resolution = resolveSessionReference(catalog, reference);
  if (resolution.kind === "not_found") {
    return failure(
      format,
      "session_not_found",
      `no Session matched '${reference}'`,
      "Run `keeper history list --format json` and retry with a qualified native id, exact job id, or exact title.",
      { details: { reference, project } },
    );
  }

  let selected: CatalogSession;
  if (resolution.kind === "ambiguous") {
    const allCandidates = sessionsForResolution(
      catalog,
      resolution.candidates.map((candidate) => candidate.sessionKey),
    );
    const shown = boundedResumeCandidates(allCandidates, RESUME_PICKER_MAX);
    if (format === "json" || !deps.isTty) {
      return failure(
        format,
        "session_ambiguous",
        `the reference '${reference}' matches multiple distinct Sessions`,
        "Retry with --project or a qualified native id; no Session was launched.",
        {
          structured: !deps.isTty,
          details: ambiguityDetails(
            resolution.match,
            shown,
            allCandidates.length,
          ),
        },
      );
    }
    const answer = await deps.pick(shown, allCandidates.length);
    const choice = parseResumePickerChoice(answer, shown.length);
    if (choice.kind === "cancelled") {
      return failure(
        format,
        "picker_cancelled",
        "selection cancelled; launched nothing",
        "Retry and choose a numbered Session, or narrow with --project.",
      );
    }
    if (choice.kind === "invalid") {
      return failure(
        format,
        "picker_invalid",
        "invalid Session selection; launched nothing",
        `Retry and enter a number from 1 to ${shown.length}.`,
      );
    }
    selected = shown[choice.index] as CatalogSession;
  } else {
    selected = resolution.session;
  }

  const artifactCollisions = collidingNativeArtifacts(
    fullCatalog,
    selected,
    deps.fs,
  );
  if (artifactCollisions.length > 1) {
    return failure(
      format,
      "artifact_ambiguous",
      "multiple native artifacts collapse onto the same harness id and project, so the native resume key is ambiguous",
      "Remove or repair the duplicate native artifacts before resuming; Keeper will not guess one.",
      {
        details: {
          harness: selected.harness,
          qualified_id: selected.qualifiedNativeId,
          project: selected.project,
          artifacts: artifactCollisions.map(
            (session) => session.artifact?.path ?? null,
          ),
        },
      },
    );
  }

  const decision = decideSelectedResume(selected, {
    fs: deps.fs,
    currentCwd: deps.cwd,
    liveness: deps.liveness,
  });
  if (decision.kind === "failed") {
    return failure(
      format,
      decision.code,
      decision.reason,
      "Repair or restore the selected native artifact/cwd, then retry with the same qualified id.",
      {
        details: decisionDetails(selected, decision.liveness, {
          found: decision.found,
          conflict_job_ids: decision.conflictJobIds ?? [],
        }),
      },
    );
  }
  if (decision.kind === "live") {
    const liveJobs = decision.liveness.evidence
      .filter((item) => item.status === "live")
      .map((item) => item.jobId);
    return failure(
      format,
      "session_live",
      `${selected.qualifiedNativeId} is already live; refusing a second foreground resume`,
      liveJobs.length === 1
        ? `Use the live Session instead (Keeper job ${liveJobs[0]}).`
        : "Use the live Session instead; no process was launched.",
      { details: decisionDetails(selected, decision.liveness) },
    );
  }
  if (decision.kind === "wrong_cwd") {
    const narrowing = reentryProject(fullCatalog, selected, deps.fs);
    if (narrowing === false) {
      return failure(
        format,
        "artifact_ambiguous",
        "the selected native id has multiple artifacts in the same project, so a safe re-entry command cannot identify it",
        "Narrow or repair the duplicate native artifacts before resuming.",
        {
          details: decisionDetails(selected, decision.liveness, {
            resolved_cwd: decision.targetCwd,
            current_cwd: decision.currentCwd,
          }),
        },
      );
    }
    const command = buildResumeReentryCommand({
      cwd: decision.targetCwd,
      qualifiedId: selected.qualifiedNativeId,
      project: narrowing,
    });
    if (format === "json") {
      return failure(
        format,
        "wrong_cwd",
        "the artifact-derived cwd differs from the current cwd; launched nothing",
        "Run the emitted command exactly to change directory and re-resolve the selected Session.",
        {
          details: decisionDetails(selected, decision.liveness, {
            resolved_cwd: decision.targetCwd,
            current_cwd: decision.currentCwd,
            command,
          }),
        },
      );
    }
    // Human wrong-cwd output is intentionally one pasteable command and nothing
    // else. It is data only; this process never sends it to a shell.
    return result(1, `${command}\n`);
  }

  try {
    const status = await deps.launchForeground(decision.launch);
    return result(status, "", "", decision.launch);
  } catch (error) {
    if (isSpawnNotFound(error)) {
      return failure(
        format,
        "binary_not_found",
        `agent binary not found: ${error.path}`,
        "Install the selected Claude/Pi CLI and retry; no alternate harness was launched.",
        { details: decisionDetails(selected, decision.launch.liveness) },
      );
    }
    return failure(
      format,
      "launch_failed",
      `could not launch ${selected.harness}: ${(error as Error).message}`,
      "Fix the native harness launch error and retry; Keeper did not fall back to another Session.",
      { details: decisionDetails(selected, decision.launch.liveness) },
    );
  }
}

async function promptResumeChoice(
  candidates: readonly CatalogSession[],
  total: number,
): Promise<string | null> {
  process.stdout.write(
    `Multiple Sessions match. Choose one${
      candidates.length < total
        ? ` (showing ${candidates.length} of ${total}; use --project to narrow)`
        : ""
    }:\n`,
  );
  process.stdout.write(`${formatResumePicker(candidates)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((done) => {
      let settled = false;
      const finish = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        done(answer);
      };
      rl.question(
        "Session to resume (number, or blank to cancel): ",
        (answer) => finish(answer),
      );
      rl.on("close", () => finish(null));
    });
  } finally {
    rl.close();
  }
}

class ForegroundResumeExit extends Error {
  constructor(readonly code: number) {
    super(`foreground resume exit ${code}`);
  }
}

/** Prepare the existing agent launcher for a foreground resume without mutating
 * process globals. The cloned env is the only place Pi's job-id carrier is
 * added/cleared; run.ts receives that env and cwd explicitly at spawn time. */
export function prepareForegroundResumeAgentDeps(
  request: ForegroundResumeLaunch,
  deps: MainDeps,
): MainDeps {
  const env: NodeJS.ProcessEnv = { ...deps.env, PWD: request.cwd };
  const prepared: MainDeps = {
    ...deps,
    argv: [...request.agentArgv],
    cwd: request.cwd,
    env,
  };
  if (request.harness === "pi") {
    if (request.keeperJobIdCarrier === null) {
      delete env.KEEPER_JOB_ID;
    } else {
      env.KEEPER_JOB_ID = request.keeperJobIdCarrier;
    }
  }
  return prepared;
}

/** Production foreground handoff. The existing agent launcher owns account
 * routing, Claude plugins/statusline, Pi extension/birth lifecycle, inherited
 * stdio, process-group signals, and exact child exit propagation. */
export async function launchForegroundResume(
  request: ForegroundResumeLaunch,
): Promise<number> {
  const { main: agentMain, realDeps } = await import("../src/agent/main");
  const deps = prepareForegroundResumeAgentDeps(request, realDeps());
  deps.exit = (code: number): never => {
    throw new ForegroundResumeExit(code);
  };
  try {
    await agentMain(deps);
  } catch (error) {
    if (error instanceof ForegroundResumeExit) return error.code;
    throw error;
  }
  return 0;
}

function defaultResumeCliDeps(): ResumeCliDeps {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    dbPath: resolveDbPath(),
    stateDir: keeperStateDir(),
    fs: nodeResumeResolveFs(),
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    pick: promptResumeChoice,
    liveness: { isPidAlive, readStartTime: readOsStartTime },
    launchForeground: launchForegroundResume,
  };
}

export async function main(
  argv: string[],
  deps?: ResumeCliDeps,
): Promise<void> {
  const outcome = await runResumeCli(argv, deps);
  if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
  if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
  if (outcome.code !== 0) process.exit(outcome.code);
}

if (import.meta.main) {
  await main(Bun.argv.slice(3));
}
