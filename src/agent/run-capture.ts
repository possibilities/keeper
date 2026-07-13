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

/** Durable ownership record written beside a launched run's existing artifacts. */
export const RUN_CONTROL_SCHEMA_VERSION = 1;

export type RunControlStatus = "running" | "cancelling" | "terminal";

/**
 * The deliberately narrow control surface for one launched run. The tmux argv is
 * copied byte-for-byte from the launch result; consumers must never derive a
 * target from a display name or pid.
 */
export interface RunControlArtifact {
  schema_version: number;
  run_id: string;
  agent: AgentKind;
  started_at_ms: number;
  kill_window_command: string[];
  status: RunControlStatus;
}

export interface RunControlIdentity {
  run_id: string;
  agent: AgentKind;
  kill_window_command: string[];
}

export interface TmuxTeardownCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExactTeardownResult =
  | { kind: "torn_down" }
  | { kind: "already_gone" }
  | { kind: "unresolved_teardown_error"; error: string };

export type CancelRunResult =
  | { kind: "cancelled" }
  | { kind: "already_gone" }
  | { kind: "already_terminal" }
  | { kind: "identity_mismatch" }
  | { kind: "unresolved_teardown_error"; error: string };

/** Build the running-state record immediately available after a tmux launch. */
export function buildRunControlArtifact(args: {
  runId: string;
  agent: AgentKind;
  startedAtMs: number;
  killWindowCommand: string[];
}): RunControlArtifact {
  return {
    schema_version: RUN_CONTROL_SCHEMA_VERSION,
    run_id: args.runId,
    agent: args.agent,
    started_at_ms: args.startedAtMs,
    kill_window_command: [...args.killWindowCommand],
    status: "running",
  };
}

function alreadyGoneTmuxError(stderr: string): boolean {
  return /(?:can't find (?:window|session)|no server running|no sessions|session not found|window not found)/i.test(
    stderr,
  );
}

/**
 * Make exact tmux teardown single-shot. The first resolved result is cached, so
 * converging completion/cancellation paths can safely invoke the same closure.
 */
export function createExactRunTeardown(
  killWindowCommand: readonly string[],
  runTmuxCommand: (
    command: string[],
    timeoutMs?: number,
  ) => TmuxTeardownCommandResult,
  timeoutMs = 5_000,
): () => ExactTeardownResult {
  let resolved: ExactTeardownResult | null = null;
  return () => {
    if (resolved !== null) {
      return resolved;
    }
    try {
      const result = runTmuxCommand([...killWindowCommand], timeoutMs);
      resolved =
        result.exitCode === 0
          ? { kind: "torn_down" }
          : alreadyGoneTmuxError(result.stderr)
            ? { kind: "already_gone" }
            : {
                kind: "unresolved_teardown_error",
                error: `tmux kill-window exited ${result.exitCode}: ${result.stderr.trim()}`,
              };
    } catch (err) {
      resolved = {
        kind: "unresolved_teardown_error",
        error: (err as Error).message,
      };
    }
    return resolved;
  };
}

function sameControlIdentity(
  artifact: RunControlArtifact,
  claimed: RunControlIdentity,
): boolean {
  return (
    artifact.run_id === claimed.run_id &&
    artifact.agent === claimed.agent &&
    artifact.kill_window_command.length ===
      claimed.kill_window_command.length &&
    artifact.kill_window_command.every(
      (token, index) => token === claimed.kill_window_command[index],
    )
  );
}

/**
 * Cancellation entry seam. Storage and tmux are injected so callers can use the
 * same atomic writer and bounded exact teardown as terminal finalization.
 */
export function cancelRunFromControlArtifact(args: {
  path: string;
  claimedIdentity: RunControlIdentity;
  readArtifact: (path: string) => RunControlArtifact;
  writeArtifact: (path: string, artifact: RunControlArtifact) => void;
  runTmuxCommand: (
    command: string[],
    timeoutMs?: number,
  ) => TmuxTeardownCommandResult;
  timeoutMs?: number;
}): CancelRunResult {
  const artifact = args.readArtifact(args.path);
  if (!sameControlIdentity(artifact, args.claimedIdentity)) {
    return { kind: "identity_mismatch" };
  }
  if (artifact.status === "terminal") {
    return { kind: "already_terminal" };
  }
  args.writeArtifact(args.path, { ...artifact, status: "cancelling" });
  const teardown = createExactRunTeardown(
    artifact.kill_window_command,
    args.runTmuxCommand,
    args.timeoutMs,
  )();
  if (teardown.kind === "unresolved_teardown_error") {
    return teardown;
  }
  args.writeArtifact(args.path, { ...artifact, status: "terminal" });
  return teardown.kind === "already_gone"
    ? { kind: "already_gone" }
    : { kind: "cancelled" };
}

/**
 * The closed set of terminal outcomes. Each maps to a process exit code via
 * {@link runCaptureExitCode}: completed/no_message succeed (0), timed_out/
 * no_transcript/transcript_ambiguous are retryable (4), launch_failed is internal
 * (1), bad_args is a malformed invocation (2). `transcript_ambiguous` is distinct
 * from `no_transcript`: attribution collided, so Keeper refused to guess a
 * foreign answer.
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
      /** `--reap-window-on-terminal` — a one-shot leg posture: after the terminal
       *  envelope is written, the handler best-effort kills the tmux window the
       *  launch opened. Panel legs always pass it; pair/debug launches stay
       *  resident (resumable) without it. */
      reapWindowOnTerminal: boolean;
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
      /** Raw `--effort` override — rides onto the launch posture. Null when unset. */
      effort: string | null;
      /** Raw `--session` name — the tmux session GROUPING (rides as
       *  `--x-tmux-session`), NOT the transcript session id, so co-grouped runs
       *  never collide transcripts. Null when unset. */
      session: string | null;
      /** Raw `--output` path — the atomic result-file sink the handler writes the
       *  envelope to on EVERY outcome, in addition to stdout. Null when unset. */
      output: string | null;
      /** Raw `--name` value — the launch NAME. Rides onto the tmux window name for
       *  every harness, and onto the harness-native `--name` for claude/pi. An
       *  explicit name suppresses the interactive auto-mint on the detached
       *  re-exec. Null when unset. */
      name: string | null;
      /** Raw `--resume` value — a partner name / former name / session id / id
       *  prefix / current-title substring to RESUME (resolution, refuse-live, and
       *  the harness-match check all stay handler-side; the parser only extracts
       *  the string). DISTINCT from `--session`, which merely names the tmux window
       *  GROUPING — `--resume` continues a prior conversation. Null when unset. */
      resume: string | null;
    }
  | { ok: false; error: string };

/**
 * Parse `agent run <cli> <prompt> [--read-only] [--reap-window-on-terminal]
 * [--stop-timeout <dur>]`. Two
 * positionals — the partner CLI (Claude/Pi) and the prompt — plus the
 * optional read-only posture, the one-shot reap posture, and stop-wait override. A malformed/missing
 * positional, an unknown flag, or an extra positional maps to BAD_ARGS upstream.
 * `--read-only` is prompting-only: it prepends the read-only directive to the
 * prompt and relies on the model following it (keeper enforces nothing).
 * `--system-file <path>` /
 * `--system <text>` supply a caller-side `System:`-prepend (mutually exclusive);
 * the parser returns the RAW path/text — the handler reads any file.
 * `--preset <name>` / `--model <m>` / `--effort <e>` / `--session <name>` /
 * `--output <path>` / `--name <n>` / `--resume <name-or-id>` are additive value
 * flags (both split and `=` forms): the parser returns the RAW values (config
 * resolution, the launch-posture overlay, the atomic write, and resume resolution
 * all happen handler-side). `--resume` is DISTINCT from `--session`: `--session`
 * names the tmux window GROUPING, `--resume` continues a prior partner
 * conversation (and forbids `--model`/`--effort`/`--preset`, which the resumed
 * session already owns — enforced handler-side). ALL default-absent, so an argv
 * without them stays byte-identical. Pure — exported for tests.
 */
export function parseRunArgs(rest: string[]): ParseRunArgsResult {
  const positionals: string[] = [];
  let stopTimeoutMs: number | null = null;
  let readOnly = false;
  let reapWindowOnTerminal = false;
  let systemFile: string | null = null;
  let system: string | null = null;
  let preset: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let session: string | null = null;
  let output: string | null = null;
  let name: string | null = null;
  let resume: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    if (arg === "--reap-window-on-terminal") {
      reapWindowOnTerminal = true;
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
    if (arg === "--resume") {
      const value = rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--resume requires a value" };
      }
      resume = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      resume = arg.slice("--resume=".length);
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
    reapWindowOnTerminal,
    systemFile,
    system,
    preset,
    model,
    effort,
    session,
    output,
    name,
    resume,
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
}

/**
 * The in-process detached-launch result for `agent run`. On success the pinned
 * {@link ResolvedHandle} is held LOCALLY (no run.json re-resolution, no
 * cross-process kill margin, no self-transcript-collision exposure); `runId` is
 * the public handle echoed into the envelope.
 */
export type RunLaunchResult =
  | {
      ok: true;
      handle: ResolvedHandle;
      runId: string;
      /** The socket-correct `tmux kill-window` argv for the window this detached
       *  launch opened. It is mandatory ownership identity, never reconstructed. */
      killWindowCommand: string[];
    }
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
  const elapsed = (): number => roundTenths((deps.now() - startMs) / 1000);

  const wait = await deps.waitForStop(handle, verbDeps);
  if (!wait.ok) {
    // The wait did not reach a stop. When the transcript path DID resolve and
    // only the stop wait timed out, read that known path once for a partial
    // capture (timed_out) — never re-run path discovery on a second budget. A
    // path-stage failure is already terminal: the whole budget was spent
    // looking, so re-probing would just spend another one (no_transcript, or
    // transcript_ambiguous when attribution collided).
    const knownPath = wait.transcriptPath ?? null;
    if (knownPath === null) {
      return buildRunCaptureEnvelope({
        outcome:
          wait.reason === "ambiguous"
            ? "transcript_ambiguous"
            : "no_transcript",
        agent,
        handle: handleId,
        resumeTarget: baseResume,
        elapsedSeconds: elapsed(),
      });
    }
    const show = await deps.showLastMessage(
      { ...handle, transcriptPath: knownPath },
      verbDeps,
    );
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
      resumeTarget: baseResume,
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
  // re-scan. Pi keeps the re-scan-first preference (its stop text is a subset
  // of what show-last-message resolves).
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
  // `completed` promises a non-empty deliverable: a found-but-textless final
  // turn (tool-only / refusal / empty text) is `no_message`, so a panel or
  // pair caller never treats an answerless leg as a usable answer.
  const deliverable = messageFound && message !== null && message.trim() !== "";
  return buildRunCaptureEnvelope({
    outcome: deliverable ? "completed" : "no_message",
    agent,
    handle: handleId,
    transcriptPath,
    resumeTarget: baseResume,
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
  deps: RunCaptureDeps & {
    launch: () => RunLaunchResult;
    /** Runs synchronously after launch success and before capture can wait. */
    onLaunched?: (launched: Extract<RunLaunchResult, { ok: true }>) => void;
  },
  verbDeps: VerbDeps,
  agent: AgentKind,
): Promise<RunCaptureResult> {
  const startMs = deps.now();
  const launched = deps.launch();
  if (!launched.ok) {
    return buildRunCaptureEnvelope({ outcome: "launch_failed", agent });
  }
  deps.onLaunched?.(launched);
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
