/**
 * The blocking run-and-capture primitive behind `keeper agent run` / `keeper
 * agent wait`. It composes the EXISTING detached-launch + wait-for-stop +
 * show-last-message primitives in ONE process and returns a uniform,
 * schema-versioned JSON result envelope — never reimplementing spawn/wait/
 * transcript logic (those arrive as injected seams from `pair-subcommands.ts`).
 *
 * Decision A (uniform envelope): ONE shape for EVERY terminal state. The
 * `outcome` closed set carries severity and maps to a process exit code, so a
 * failure still emits the same 9-key envelope (nulls where unknown) rather than
 * a separate error object. The whole point is one shape for programmatic callers
 * (panel legs, the future subagent wrapper).
 *
 * DEP-GRAPH DISCIPLINE: this module imports TYPES ONLY (from `./dispatch` /
 * `./pair-subcommands`); every effect is a passed-in seam. It MUST NOT pull
 * `src/db.ts` / `bun:sqlite` — `cli/agent.ts`'s reach onto the cold-start
 * `keeper plan` path stays db-free (pinned by the hygiene import-scan test).
 */

import type { AgentKind } from "./dispatch";
import type {
  ResolvedHandle,
  ShowLastMessageResult,
  VerbDeps,
  WaitForStopResult,
} from "./pair-subcommands";

/**
 * Run-capture envelope contract version. Mirrors `TMUX_SCHEMA_VERSION` (integer,
 * snake_case keys). Bump ONLY on a breaking shape change — the full-key-set
 * snapshot test fails a silent drift.
 */
export const RUN_CAPTURE_SCHEMA_VERSION = 1;

/**
 * The closed set of terminal outcomes. Each maps to a process exit code via
 * {@link runCaptureExitCode}: completed/no_message succeed (0), timed_out/
 * no_transcript are retryable (4), launch_failed is internal (1), bad_args is a
 * malformed invocation (2).
 */
export type RunCaptureOutcome =
  | "completed"
  | "no_message"
  | "timed_out"
  | "no_transcript"
  | "launch_failed"
  | "bad_args";

/** The uniform run-capture result — exactly these 9 snake_case keys. */
export interface RunCaptureEnvelope {
  schema_version: number;
  agent: AgentKind | null;
  handle: string | null;
  transcript_path: string | null;
  resume_target: string | null;
  message: string | null;
  message_found: boolean;
  elapsed_seconds: number | null;
  outcome: RunCaptureOutcome;
}

/** An envelope paired with the process exit code its `outcome` maps to. */
export interface RunCaptureResult {
  envelope: RunCaptureEnvelope;
  exitCode: number;
}

const OUTCOME_EXIT_CODE: Record<RunCaptureOutcome, number> = {
  completed: 0,
  no_message: 0,
  timed_out: 4,
  no_transcript: 4,
  launch_failed: 1,
  bad_args: 2,
};

/** The process exit code an outcome maps to (severity carried by the outcome). */
export function runCaptureExitCode(outcome: RunCaptureOutcome): number {
  return OUTCOME_EXIT_CODE[outcome];
}

/** Fields fed to {@link buildRunCaptureEnvelope}; unknowns default to null. */
export interface EnvelopeFields {
  outcome: RunCaptureOutcome;
  agent?: AgentKind | null;
  handle?: string | null;
  transcriptPath?: string | null;
  resumeTarget?: string | null;
  message?: string | null;
  messageFound?: boolean;
  elapsedSeconds?: number | null;
}

/**
 * Assemble the uniform envelope + its exit code. The single construction site so
 * the key set never drifts — every outcome (success OR failure) round-trips
 * through here. Pure — exported for the full-key-set snapshot tests.
 */
export function buildRunCaptureEnvelope(
  fields: EnvelopeFields,
): RunCaptureResult {
  const envelope: RunCaptureEnvelope = {
    schema_version: RUN_CAPTURE_SCHEMA_VERSION,
    agent: fields.agent ?? null,
    handle: fields.handle ?? null,
    transcript_path: fields.transcriptPath ?? null,
    resume_target: fields.resumeTarget ?? null,
    message: fields.message ?? null,
    message_found: fields.messageFound ?? false,
    elapsed_seconds: fields.elapsedSeconds ?? null,
    outcome: fields.outcome,
  };
  return { envelope, exitCode: runCaptureExitCode(fields.outcome) };
}

const RUN_CAPTURE_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "pi",
]);

/** Discriminated result of {@link parseRunArgs}. */
export type ParseRunArgsResult =
  | { ok: true; cli: AgentKind; prompt: string; stopTimeoutMs: number | null }
  | { ok: false; error: string };

/**
 * Parse `agent run <cli> <prompt> [--stop-timeout-ms <ms>]`. Two positionals —
 * the partner CLI (claude|codex|pi) and the prompt — plus the optional stop-wait
 * override. A malformed/missing positional, an unknown flag, or an extra
 * positional maps to BAD_ARGS upstream. Pure — exported for tests.
 */
export function parseRunArgs(rest: string[]): ParseRunArgsResult {
  const positionals: string[] = [];
  let stopTimeoutMs: number | null = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--stop-timeout-ms") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--stop-timeout-ms requires a value" };
      }
      const parsed = parsePositiveIntMs(value);
      if (parsed === null) {
        return {
          ok: false,
          error: `--stop-timeout-ms must be a positive integer ms: ${value}`,
        };
      }
      stopTimeoutMs = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout-ms=")) {
      const value = arg.slice("--stop-timeout-ms=".length);
      const parsed = parsePositiveIntMs(value);
      if (parsed === null) {
        return {
          ok: false,
          error: `--stop-timeout-ms must be a positive integer ms: ${value}`,
        };
      }
      stopTimeoutMs = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    positionals.push(arg);
  }

  const cli = positionals[0];
  if (cli === undefined || !RUN_CAPTURE_AGENTS.has(cli)) {
    return {
      ok: false,
      error: `<cli> must be claude|codex|pi: ${cli ?? "(missing)"}`,
    };
  }
  const prompt = positionals[1];
  if (prompt === undefined || prompt === "") {
    return { ok: false, error: "missing <prompt>" };
  }
  if (positionals.length > 2) {
    return {
      ok: false,
      error: `unexpected extra argument: ${positionals[2]}`,
    };
  }
  return { ok: true, cli: cli as AgentKind, prompt, stopTimeoutMs };
}

/** A finite positive integer of ms, or null for anything malformed. */
function parsePositiveIntMs(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The seams the compose drives — the real wait/show primitives + a clock. */
export interface RunCaptureDeps {
  waitForStop: (
    handle: ResolvedHandle,
    deps: VerbDeps,
  ) => Promise<WaitForStopResult>;
  showLastMessage: (
    handle: ResolvedHandle,
    deps: VerbDeps,
  ) => Promise<ShowLastMessageResult>;
  /** Monotonic-enough wall clock (ms) for deterministic `elapsed_seconds`. */
  now: () => number;
}

/**
 * The in-process detached-launch result for `agent run`. On success the pinned
 * {@link ResolvedHandle} is held LOCALLY (no run.json re-resolution, no
 * cross-process kill margin, no self-transcript-collision exposure); `runId` is
 * the public handle echoed into the envelope.
 */
export type RunLaunchResult =
  | { ok: true; handle: ResolvedHandle; runId: string }
  | { ok: false; error: string };

/** Inputs to {@link captureFromHandle}. */
export interface CaptureArgs {
  handle: ResolvedHandle;
  /** The public handle (run id / path) echoed into the envelope, or null. */
  handleId: string | null;
  agent: AgentKind;
  /** `deps.now()` sampled at the start of the operation, for `elapsed_seconds`. */
  startMs: number;
}

/**
 * Wait-for-stop → show-last-message → envelope on a pinned handle. Shared by
 * `agent run` (its launch tail) and `agent wait`. A failed wait is disambiguated
 * by a best-effort final-message read: a transcript that resolves means we timed
 * out mid-run (partial captured → `timed_out`); one that never resolves means the
 * path never appeared (`no_transcript`). A clean wait + read yields `completed`
 * (a message was found) or `no_message` (a tool-only/structural final turn).
 */
export async function captureFromHandle(
  deps: RunCaptureDeps,
  verbDeps: VerbDeps,
  args: CaptureArgs,
): Promise<RunCaptureResult> {
  const { handle, handleId, agent, startMs } = args;
  const resumeTarget = handle.sessionId;
  const elapsed = (): number => roundTenths((deps.now() - startMs) / 1000);

  const wait = await deps.waitForStop(handle, verbDeps);
  if (!wait.ok) {
    // The wait did not reach a stop. Probe the transcript: if it resolves, the
    // stop simply never came before the deadline (timed_out, partial captured);
    // if it does not, the path never appeared (no_transcript).
    const show = await deps.showLastMessage(handle, verbDeps);
    if (!show.ok) {
      return buildRunCaptureEnvelope({
        outcome: "no_transcript",
        agent,
        handle: handleId,
        resumeTarget,
        elapsedSeconds: elapsed(),
      });
    }
    return buildRunCaptureEnvelope({
      outcome: "timed_out",
      agent,
      handle: handleId,
      transcriptPath: show.transcriptPath,
      resumeTarget,
      message: show.text,
      messageFound: show.found,
      elapsedSeconds: elapsed(),
    });
  }

  const show = await deps.showLastMessage(handle, verbDeps);
  // The stop was seen, so a transcript exists; show normally re-resolves it
  // instantly. Should the read still fail (transcript vanished mid-flight), fall
  // back to the text the stop event itself carried rather than losing the run.
  const transcriptPath = show.ok ? show.transcriptPath : wait.transcriptPath;
  const message = show.ok ? show.text : wait.stop.message;
  const messageFound = show.ok ? show.found : wait.stop.message !== null;
  return buildRunCaptureEnvelope({
    outcome: messageFound ? "completed" : "no_message",
    agent,
    handle: handleId,
    transcriptPath,
    resumeTarget,
    message,
    messageFound,
    elapsedSeconds: elapsed(),
  });
}

/**
 * `agent run`: launch the detached run via the injected seam, hold the pinned
 * handle LOCALLY, then capture. A failed launch maps to `launch_failed` carrying
 * the agent (the envelope still emits, nulls elsewhere). The clock starts BEFORE
 * the launch so `elapsed_seconds` spans the whole run.
 */
export async function composeRunCapture(
  deps: RunCaptureDeps & { launch: () => RunLaunchResult },
  verbDeps: VerbDeps,
  agent: AgentKind,
): Promise<RunCaptureResult> {
  const startMs = deps.now();
  const launched = deps.launch();
  if (!launched.ok) {
    return buildRunCaptureEnvelope({ outcome: "launch_failed", agent });
  }
  return captureFromHandle(deps, verbDeps, {
    handle: launched.handle,
    handleId: launched.runId,
    agent,
    startMs,
  });
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}
