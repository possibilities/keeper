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
 * `./pair-subcommands`) plus the dep-free harness registry (`./harness`, pure
 * data); every effect is a passed-in seam. It MUST NOT pull `src/db.ts` /
 * `bun:sqlite` — `cli/agent.ts`'s reach onto the cold-start `keeper plan` path
 * stays db-free (pinned by the hygiene import-scan test).
 */

import { parseDuration } from "../duration";
import type { AgentKind } from "./dispatch";
import { HARNESS_NAME_SET } from "./harness";
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
 * no_transcript/transcript_ambiguous are retryable (4), launch_failed is internal
 * (1), bad_args is a malformed invocation (2). `transcript_ambiguous` is distinct
 * from `no_transcript`: the transcript did NOT simply fail to appear — a codex
 * leg found more than one same-cwd rollout it could not attribute to itself (a
 * concurrent session collided), so it refuses to guess a foreign answer.
 */
export type RunCaptureOutcome =
  | "completed"
  | "no_message"
  | "timed_out"
  | "no_transcript"
  | "transcript_ambiguous"
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
  transcript_ambiguous: 4,
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

/** The harnesses `agent run` accepts — derived from the harness registry so the
 *  name set lives in one place (no near-copy to drift). */
const RUN_CAPTURE_AGENTS: ReadonlySet<string> = HARNESS_NAME_SET;

/** Discriminated result of {@link parseRunArgs}. */
export type ParseRunArgsResult =
  | {
      ok: true;
      cli: AgentKind;
      prompt: string;
      stopTimeoutMs: number | null;
      readOnly: boolean;
      /** Raw `--system-file` path (unread — the pure parser never touches the
       *  filesystem); the handler resolves it to text. Null when unset. */
      systemFile: string | null;
      /** Raw `--system` inline text. Null when unset. Mutually exclusive with
       *  {@link systemFile} — two spellings of one input. */
      system: string | null;
      /** Raw `--preset` name (unresolved — the pure parser never reads config).
       *  The handler resolves it and validates its harness == `<cli>`. Null when
       *  unset. */
      preset: string | null;
      /** Raw `--model` override — rides onto the launch posture (an explicit
       *  --model wins over the preset). Null when unset. */
      model: string | null;
      /** Raw `--effort` override — rides onto the launch posture (codex reasoning
       *  effort). Null when unset. */
      effort: string | null;
      /** Raw `--session` name — the tmux session GROUPING (rides as
       *  `--x-tmux-session`), NOT the transcript session id, so co-grouped runs
       *  never collide transcripts. Null when unset. */
      session: string | null;
      /** Raw `--output` path — the atomic result-file sink the handler writes the
       *  envelope to on EVERY outcome, in addition to stdout. Null when unset. */
      output: string | null;
      /** Raw `--name` value — the launch NAME. Rides onto the tmux window name for
       *  every harness, and onto the harness-native `--name` for claude/pi (codex
       *  has none). An explicit name suppresses the interactive auto-mint on the
       *  detached re-exec. Null when unset. */
      name: string | null;
    }
  | { ok: false; error: string };

/**
 * Parse `agent run <cli> <prompt> [--read-only] [--stop-timeout <dur>]`. Two
 * positionals — the partner CLI (claude|codex|pi) and the prompt — plus the
 * optional read-only posture and stop-wait override. A malformed/missing
 * positional, an unknown flag, or an extra positional maps to BAD_ARGS upstream.
 * `--read-only` is prompting-only: it prepends the read-only directive to the
 * prompt and relies on the model following it (keeper enforces nothing).
 * `--system-file <path>` /
 * `--system <text>` supply a caller-side `System:`-prepend (mutually exclusive);
 * the parser returns the RAW path/text — the handler reads any file.
 * `--preset <name>` / `--model <m>` / `--effort <e>` / `--session <name>` /
 * `--output <path>` / `--name <n>` are additive value flags (both split and `=` forms): the
 * parser returns the RAW values (config resolution, the launch-posture overlay,
 * and the atomic write happen handler-side). ALL default-absent, so an argv
 * without them stays byte-identical. Pure — exported for tests.
 */
export function parseRunArgs(rest: string[]): ParseRunArgsResult {
  const positionals: string[] = [];
  let stopTimeoutMs: number | null = null;
  let readOnly = false;
  let systemFile: string | null = null;
  let system: string | null = null;
  let preset: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let session: string | null = null;
  let output: string | null = null;
  let name: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    if (arg === "--stop-timeout") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--stop-timeout requires a value" };
      }
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout=")) {
      const value = arg.slice("--stop-timeout=".length);
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      continue;
    }
    if (arg === "--system-file") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--system-file requires a value" };
      }
      systemFile = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--system-file=")) {
      systemFile = arg.slice("--system-file=".length);
      continue;
    }
    if (arg === "--system") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--system requires a value" };
      }
      system = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--system=")) {
      system = arg.slice("--system=".length);
      continue;
    }
    if (arg === "--preset") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--preset requires a value" };
      }
      preset = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--preset=")) {
      preset = arg.slice("--preset=".length);
      continue;
    }
    if (arg === "--model") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--model requires a value" };
      }
      model = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--effort") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--effort requires a value" };
      }
      effort = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--effort=")) {
      effort = arg.slice("--effort=".length);
      continue;
    }
    if (arg === "--session") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--session requires a value" };
      }
      session = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
      continue;
    }
    if (arg === "--output") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--output requires a value" };
      }
      output = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
      continue;
    }
    if (arg === "--name") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--name requires a value" };
      }
      name = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    positionals.push(arg);
  }

  // Two spellings of ONE input — never both. The handler reads the file (or
  // takes the inline text) and composes a single `System:` block.
  if (systemFile !== null && system !== null) {
    return {
      ok: false,
      error: "cannot combine --system-file and --system",
    };
  }

  const cli = positionals[0];
  if (cli === undefined || !RUN_CAPTURE_AGENTS.has(cli)) {
    return {
      ok: false,
      error: `<cli> must be ${[...RUN_CAPTURE_AGENTS].join("|")}: ${cli ?? "(missing)"}`,
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
  return {
    ok: true,
    cli: cli as AgentKind,
    prompt,
    stopTimeoutMs,
    readOnly,
    systemFile,
    system,
    preset,
    model,
    effort,
    session,
    output,
    name,
  };
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
  /**
   * Resolve a codex resume target (its session uuid) from the ALREADY-resolved
   * rollout transcript path. Optional + codex-only: bound in `main.ts` to the
   * pure `codexSessionIdFromRolloutPath` parser (this module keeps its
   * types-only, dep-free contract). claude/pi never reach it — their
   * `handle.sessionId` is pinned at launch and stays authoritative.
   */
  resolveCodexResumeTarget?: (args: {
    transcriptPath: string;
  }) => string | null;
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
  const baseResume = handle.sessionId;
  // claude/pi pin `handle.sessionId` at launch — authoritative, keep it. codex
  // and hermes can't be pinned (they mint their own id): discover it POST-STOP.
  // codex parses the resolved rollout path via the seam; hermes's wait/show carry
  // its native session id AS the `transcriptPath` (it has no transcript file), so
  // that value IS the resume target directly.
  const resolveResume = (transcriptPath: string | null): string | null => {
    if (baseResume !== null) {
      return baseResume;
    }
    if (transcriptPath === null) {
      return null;
    }
    if (agent === "hermes") {
      return transcriptPath;
    }
    if (agent !== "codex") {
      return null;
    }
    return deps.resolveCodexResumeTarget?.({ transcriptPath }) ?? null;
  };
  const elapsed = (): number => roundTenths((deps.now() - startMs) / 1000);

  const wait = await deps.waitForStop(handle, verbDeps);
  if (!wait.ok) {
    // The wait did not reach a stop. Probe the transcript: if it resolves, the
    // stop simply never came before the deadline (timed_out, partial captured);
    // if it does not, either a concurrent same-cwd session made attribution
    // ambiguous (transcript_ambiguous — refuse to guess a foreign answer) or the
    // path never appeared (no_transcript).
    const show = await deps.showLastMessage(handle, verbDeps);
    if (!show.ok) {
      const ambiguous =
        show.reason === "ambiguous" || wait.reason === "ambiguous";
      return buildRunCaptureEnvelope({
        outcome: ambiguous ? "transcript_ambiguous" : "no_transcript",
        agent,
        handle: handleId,
        resumeTarget: baseResume,
        elapsedSeconds: elapsed(),
      });
    }
    return buildRunCaptureEnvelope({
      outcome: "timed_out",
      agent,
      handle: handleId,
      transcriptPath: show.transcriptPath,
      resumeTarget: resolveResume(show.transcriptPath),
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
  // For claude, the gated wait stop is the BLESSED settled turn: prefer its own
  // message so a later human-resume turn's whole-file re-scan cannot displace
  // the answer. Only a structural claude stop (null text) falls back to the
  // re-scan. codex/pi/hermes keep the re-scan-first preference (their stop text
  // is a subset of what show-last-message resolves).
  let message: string | null;
  let messageFound: boolean;
  if (agent === "claude" && wait.stop.message !== null) {
    message = wait.stop.message;
    messageFound = true;
  } else if (show.ok) {
    message = show.text;
    messageFound = show.found;
  } else {
    message = wait.stop.message;
    messageFound = wait.stop.message !== null;
  }
  return buildRunCaptureEnvelope({
    outcome: messageFound ? "completed" : "no_message",
    agent,
    handle: handleId,
    transcriptPath,
    resumeTarget: resolveResume(transcriptPath),
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
