import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { keeperTmuxSessionCwd } from "../tmux-session-cwd";
import type { AgentKind } from "./dispatch";

/**
 * Field separator for the `-F` capture format. ASCII SOH (`\x01`) survives a
 * tmux server frozen in the C locale: a C-locale client sanitizes TAB in `-F`
 * output to `_`, which silently mangles a `\t`-delimited parse. SOH is never
 * a printable session/window/pane token, so it is a safe, lossless delimiter.
 */
const CAPTURE_FS = "\x01";
const CAPTURE_FORMAT = `#{session_name}${CAPTURE_FS}#{window_id}${CAPTURE_FS}#{pane_id}`;

/**
 * Bounded spawn timeouts. tmux lookups/window creation are cheap; session
 * creation may briefly block on server startup. A timeout is mapped to a
 * non-zero TmuxCommandResult (never an uncaught throw) so the caller classifies
 * it as retryable rather than crashing the launcher.
 */
const TMUX_DEFAULT_TIMEOUT_MS = 5_000;
const TMUX_NEW_SESSION_TIMEOUT_MS = 15_000;

/**
 * Sentinel exit code a timed-out / signal-killed spawn carries on its
 * TmuxCommandResult. `tmuxError` reclassifies it to the retryable launcher exit
 * code so a contended server surfaces as transient, not a generic internal error.
 */
const TMUX_TIMEOUT_RESULT_CODE = 124;

/**
 * Launcher exit-code taxonomy for tmux mode. A machine caller binds on these:
 * `BAD_ARGS` is a malformed invocation (minted at the parse site in main());
 * `NOOP` is a prereq the caller can't retry into (tmux missing, session gone);
 * `RETRYABLE` is transient (timeout / lock contention) and worth a retry;
 * `INTERNAL` is a parse/logic failure. Kept distinct so the taxonomy can't
 * silently collide; pinned in the test suite so it can't drift.
 */
export const TMUX_EXIT = {
  INTERNAL: 1,
  BAD_ARGS: 2,
  NOOP: 3,
  RETRYABLE: 4,
} as const;

/**
 * Run-artifact GC policy. The startup sweep (run once before this launch's run
 * dir is created) deletes a `tmux-runs/<runId>/` dir only when it is past the
 * TTL AND its recorded marker pid is dead (a dir with no readable marker pid
 * falls back to age-only — the generous TTL keeps an in-flight run safe). A
 * secondary count-cap keeps at most N most-recent dirs, deleting oldest-first
 * subject to the same liveness gate.
 *
 * Pid caveat: the launcher exits immediately on a detached launch, so its OWN pid
 * dies at once — liveness is NOT keyed on it. run.json records the surviving
 * tmux pane's client pid when knowable; when it is not, the age-only fallback
 * with a generous TTL governs.
 */
const RUN_GC_TTL_MS = 24 * 60 * 60 * 1_000;
const RUN_GC_MAX_KEEP = 50;
const RUN_DIR_PREFIX = "tmux-";

/** Directories scanned when `tmux` is not on the spawn PATH (stripped env). */
const KNOWN_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// `timeoutMs` overrides the per-command spawn bound when set; callers omit it
// and get the new-session vs default floor. A test exercising the timeout-
// classification path passes a tiny value so a real `sleep` spawn trips the
// timeout in milliseconds instead of blocking on the multi-second floor.
export type TmuxCommandRunner = (
  cmd: string[],
  timeoutMs?: number,
) => TmuxCommandResult;

export class TmuxLaunchError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}

export interface ParsedTmuxLaunch {
  enabled: boolean;
  remainingArgs: string[];
  options: TmuxLaunchOptions;
  error: string | null;
}

export interface TmuxLaunchOptions {
  session: string | null;
  windowName: string | null;
  socketName: string | null;
  socketPath: string | null;
  detached: boolean;
  /**
   * Suppress the `$stateDir/tmux-runs/<runId>/` artifact trail (launch.sh +
   * run.json). The launch command is inlined as `bash -c <body>` instead of an
   * `exec bash <launchScript>`, preserving the `-l -i` re-exec semantics; the
   * JSON result then carries `runDir:null, launchScript:null`. For callers that
   * do not need the on-disk trail.
   */
  noArtifacts: boolean;
  /**
   * Caller-injected env, last-wins per duplicate KEY, forwarded to the pane via
   * tmux `-e KEY=VALUE` on both new-session and new-window. Keys are validated
   * and dynamic-linker keys are rejected at parse time; values have control
   * chars stripped. Empty when `--x-tmux-env` is never passed, so the
   * built tmux argv stays byte-identical to the pre-flag form.
   */
  env: [string, string][];
}

export interface TmuxLaunchRequest {
  agent: AgentKind;
  innerArgs: string[];
  options: TmuxLaunchOptions;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /**
   * The transcript session id the inner launch will mint for Claude/Pi (null
   * when a launch has no pre-known id). Recorded in run.json so a later
   * `wait-for-stop`/`show-last-message` resolves the right transcript by id.
   */
  transcriptSessionId: string | null;
  /** Launch wall-clock, recorded so the verbs filter to fresh transcripts. */
  startedAtMs: number;
  stateDir: string;
  /** Absolute `tmux` binary; resolved by the caller so a stripped PATH can't ENOENT it. */
  tmuxBin: string;
  /**
   * The argv PREFIX the detached pane re-execs, ahead of the agent token + inner
   * args: `[<abs bun>, <abs cli/keeper.ts>, "agent"]`. Computed by the caller
   * from `resolveKeeperAgentPath` — NEVER from `process.argv[1]` (which is
   * `daemon.ts` under keeperd, `cli/keeper.ts` under the CLI, neither carrying
   * the `agent` token). Both entries are absolute so the launch script's `cd` +
   * keeperd's stripped LaunchAgent PATH cannot mis-resolve them.
   */
  launcherArgvPrefix: string[];
  randomUuid: () => string;
  runTmuxCommand: TmuxCommandRunner;
}

export interface TmuxLaunchResult {
  id: string;
  /** Run-artifact dir; null when `--no-artifacts` suppressed the trail. */
  runDir: string | null;
  session: string;
  windowId: string;
  paneId: string;
  /** Path to launch.sh; null when `--no-artifacts` inlined the launch command. */
  launchScript: string | null;
  attachCommand: string[] | null;
  /** Socket-correct argv that kills exactly the window this launch opened —
   *  the reap-on-terminal posture's teardown handle. */
  killWindowCommand: string[] | null;
  message: string | null;
}

const VALUE_FLAGS = new Set([
  "--x-tmux-session",
  "--x-tmux-window-name",
  "--x-tmux-socket-name",
  "--x-tmux-socket-path",
  "--x-tmux-L",
  "--x-tmux-S",
]);

/** Repeatable env-injection flag, parsed separately from the scalar VALUE_FLAGS. */
const ENV_FLAG = "--x-tmux-env";

/** Env keys whose injection would alter the dynamic linker; hard-blocked. */
const BLOCKED_ENV_KEY = /^(LD_|DYLD_)/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from injected values is the intent.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

export function parseKeeperAgentTmuxArgs(args: string[]): ParsedTmuxLaunch {
  const remainingArgs: string[] = [];
  const options: TmuxLaunchOptions = {
    session: null,
    windowName: null,
    socketName: null,
    socketPath: null,
    detached: false,
    noArtifacts: false,
    env: [],
  };
  let enabled = false;
  let pendingFlag: string | null = null;

  for (const arg of args) {
    if (pendingFlag !== null) {
      const flag = pendingFlag;
      pendingFlag = null;
      const error =
        flag === ENV_FLAG
          ? addTmuxEnv(options, arg)
          : setTmuxValue(options, flag, arg);
      if (error !== null) {
        return { enabled: true, remainingArgs, options, error };
      }
      enabled = true;
      continue;
    }

    if (arg === "--x-tmux") {
      enabled = true;
      continue;
    }
    if (arg === "--x-tmux-detached") {
      options.detached = true;
      enabled = true;
      continue;
    }
    if (arg === "--no-artifacts" || arg === "--x-no-artifacts") {
      options.noArtifacts = true;
      enabled = true;
      continue;
    }

    if (arg === ENV_FLAG) {
      pendingFlag = ENV_FLAG;
      enabled = true;
      continue;
    }
    if (arg.startsWith(`${ENV_FLAG}=`)) {
      const error = addTmuxEnv(options, arg.slice(ENV_FLAG.length + 1));
      if (error !== null) {
        return { enabled: true, remainingArgs, options, error };
      }
      enabled = true;
      continue;
    }

    const joined = splitJoinedTmuxFlag(arg);
    if (joined !== null) {
      const [flag, value] = joined;
      const error = setTmuxValue(options, flag, value);
      if (error !== null) {
        return { enabled: true, remainingArgs, options, error };
      }
      enabled = true;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      pendingFlag = arg;
      enabled = true;
      continue;
    }

    remainingArgs.push(arg);
  }

  if (pendingFlag !== null) {
    return {
      enabled: true,
      remainingArgs,
      options,
      error: `${pendingFlag} requires a value`,
    };
  }

  if (options.socketName !== null && options.socketPath !== null) {
    return {
      enabled: true,
      remainingArgs,
      options,
      error:
        "--x-tmux-L/--x-tmux-socket-name and --x-tmux-S/--x-tmux-socket-path are mutually exclusive",
    };
  }

  return { enabled, remainingArgs, options, error: null };
}

function splitJoinedTmuxFlag(arg: string): [string, string] | null {
  const eq = arg.indexOf("=");
  if (eq === -1) {
    return null;
  }
  const flag = arg.slice(0, eq);
  if (!VALUE_FLAGS.has(flag)) {
    return null;
  }
  return [flag, arg.slice(eq + 1)];
}

function setTmuxValue(
  options: TmuxLaunchOptions,
  flag: string,
  rawValue: string,
): string | null {
  const value = rawValue.trim();
  if (value === "") {
    return `${flag} requires a non-empty value`;
  }

  if (flag === "--x-tmux-session") {
    options.session = value;
  } else if (flag === "--x-tmux-window-name") {
    options.windowName = value;
  } else if (flag === "--x-tmux-socket-name" || flag === "--x-tmux-L") {
    options.socketName = value;
  } else if (flag === "--x-tmux-socket-path" || flag === "--x-tmux-S") {
    options.socketPath = value;
  }
  return null;
}

/**
 * Validate and accumulate one `--x-tmux-env KEY=VALUE` pair (last-wins
 * per duplicate KEY). The KEY is matched against a strict env-name regex and
 * dynamic-linker keys are hard-blocked; control chars are stripped from VALUE.
 * Returns a non-null error string on a malformed/blocked key, which the parse
 * caller surfaces and main() mints to BAD_ARGS (exit 2). The raw VALUE is NOT
 * trimmed: a value may legitimately carry surrounding whitespace.
 */
function addTmuxEnv(options: TmuxLaunchOptions, raw: string): string | null {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    return `${ENV_FLAG} requires KEY=VALUE (missing '=')`;
  }
  const key = raw.slice(0, eq);
  if (!ENV_KEY_RE.test(key)) {
    return `${ENV_FLAG} key must match ^[A-Z_][A-Z0-9_]*$: ${key}`;
  }
  if (BLOCKED_ENV_KEY.test(key)) {
    return `${ENV_FLAG} key is not allowed (dynamic-linker key): ${key}`;
  }
  const value = raw.slice(eq + 1).replace(CONTROL_CHARS_RE, "");
  const existing = options.env.findIndex(([k]) => k === key);
  if (existing !== -1) {
    options.env[existing] = [key, value];
  } else {
    options.env.push([key, value]);
  }
  return null;
}

export function defaultKeeperAgentStateDir(env: NodeJS.ProcessEnv): string {
  const xdgStateHome = (env.XDG_STATE_HOME ?? "").trim();
  if (xdgStateHome !== "") {
    return join(xdgStateHome, "keeper-agent");
  }
  return join(homedir(), ".local", "state", "keeper-agent");
}

export const defaultTmuxCommandRunner: TmuxCommandRunner = (
  cmd: string[],
  timeoutMs?: number,
): TmuxCommandResult => {
  try {
    const proc = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: tmuxSpawnEnv(process.env),
      timeout:
        timeoutMs ??
        (cmd.includes("new-session")
          ? TMUX_NEW_SESSION_TIMEOUT_MS
          : TMUX_DEFAULT_TIMEOUT_MS),
    });
    if (proc.exitedDueToTimeout || proc.exitCode === null) {
      return {
        exitCode: TMUX_TIMEOUT_RESULT_CODE,
        stdout: bufferToString(proc.stdout),
        stderr: proc.exitedDueToTimeout
          ? "tmux command timed out"
          : `tmux command killed by signal ${proc.signalCode ?? "unknown"}`,
      };
    }
    return {
      exitCode: proc.exitCode,
      stdout: bufferToString(proc.stdout),
      stderr: bufferToString(proc.stderr),
    };
  } catch (exc) {
    if (isSpawnNotFound(exc)) {
      throw new TmuxLaunchError(
        "tmux command not found. Install tmux or remove --x-tmux.",
        TMUX_EXIT.NOOP,
      );
    }
    throw exc;
  }
};

/**
 * Spawn env for a tmux client that must stay byte-faithful. Spreads
 * `...process.env` so PATH and the `KEEPER_TMUX_PANE` carrier survive, then
 * defaults the locale to UTF-8 and TERM/COLORTERM only when absent — a tmux
 * client minted under the C locale (a stripped LaunchAgent env) sanitizes the
 * `-F` capture delimiter, mangling every parse. The locale default is applied
 * ONLY when no UTF-8 locale var is already set (setlocale precedence: LC_ALL >
 * LC_CTYPE > LANG); a global `LC_ALL` is never set. Exported for tests.
 */
export function tmuxSpawnEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  if (!isUtf8(effectiveCtypeLocale(out))) {
    // A non-UTF-8 LC_ALL would override LC_CTYPE for every category, so drop it
    // (deleting is not the same as setting a global LC_ALL, which we never do)
    // and pin the CTYPE category to UTF-8. LANG is the broad fallback.
    if (!isUtf8(out.LC_ALL)) {
      delete out.LC_ALL;
    }
    out.LC_CTYPE = "C.UTF-8";
    if (!isUtf8(out.LANG)) {
      out.LANG = "C.UTF-8";
    }
  }
  out.TERM = out.TERM ?? "xterm-256color";
  out.COLORTERM = out.COLORTERM ?? "truecolor";
  return out;
}

/** Locale that wins the CTYPE category: LC_ALL > LC_CTYPE > LANG. */
function effectiveCtypeLocale(env: Record<string, string>): string {
  return env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
}

function isUtf8(locale: string | undefined): boolean {
  return locale !== undefined && /utf-?8/i.test(locale);
}

function isSpawnNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function bufferToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return "";
}

export function launchKeeperAgentInTmux(
  req: TmuxLaunchRequest,
): TmuxLaunchResult {
  const tmuxBase = buildTmuxBase(req.tmuxBin, req.options);
  const sameServer = isCurrentTmuxServer(req.env, req.options);
  const session = resolveSession(req, tmuxBase, sameServer);
  const windowName = req.options.windowName;

  // Sweep stale run dirs before creating this launch's dir, so an in-flight run
  // (this one, not yet on disk) is never a sweep candidate.
  if (!req.options.noArtifacts) {
    sweepRunArtifacts(join(req.stateDir, "tmux-runs"), Date.now());
  }

  const { runId, runDir, launchScript, launchCommand } = req.options.noArtifacts
    ? inlineLaunch(req)
    : artifactLaunch(req);

  // Pin the partner's transcript identity end-to-end: forward the session-id
  // carrier into the pane via `-e` (alongside any caller-injected env) so the
  // inner re-exec's `--session-id` push (`main.ts`) uses the SAME uuid recorded
  // in run.json `transcriptSessionId`. On an existing tmux server, without this
  // the inner mints a FRESH uuid and writes `<fresh>.jsonl`, which the strict
  // resolver then misses. A launch with no id (`transcriptSessionId:null`) omits
  // the carrier and keeps the env byte-identical to the pre-pin form.
  const paneEnv = withTranscriptSessionCarrier(
    req.options.env,
    req.transcriptSessionId,
  );
  const sessionCwd = keeperTmuxSessionCwd(req.env);

  const newWindowCmd = [
    ...tmuxBase,
    "new-window",
    "-d",
    "-P",
    "-F",
    CAPTURE_FORMAT,
    "-t",
    `=${session}:`,
    ...windowNameArgs(windowName),
    ...envArgs(paneEnv),
    "-c",
    req.cwd,
    launchCommand,
  ];
  const newSessionCmd = [
    ...tmuxBase,
    "new-session",
    "-d",
    "-P",
    "-F",
    CAPTURE_FORMAT,
    "-s",
    session,
    ...windowNameArgs(windowName),
    ...envArgs(paneEnv),
    "-c",
    sessionCwd,
    launchCommand,
  ];

  const exists = runTmux(req, [
    ...tmuxBase,
    "has-session",
    "-t",
    `=${session}`,
  ]).exitCode;

  let created = runTmux(req, exists === 0 ? newWindowCmd : newSessionCmd);
  // TOCTOU recovery: a concurrent launch can create `session` between our
  // has-session probe and our new-session, so tmux rejects ours with "duplicate
  // session". The session now exists — add a window to it instead of failing.
  // This is what lets many partners share one named session (e.g. the `panels`
  // / `pair` pairing sessions) without a launch race.
  if (
    exists !== 0 &&
    created.exitCode !== 0 &&
    /duplicate session/i.test(created.stderr)
  ) {
    created = runTmux(req, newWindowCmd);
  }

  if (created.exitCode !== 0) {
    throw tmuxError("failed to create tmux window", created);
  }

  const target = parseCreatedTarget(created.stdout, session);
  if (runDir !== null && launchScript !== null) {
    writeRunMetadata(req, {
      id: runId,
      runDir,
      launchScript,
      session: target.session,
      windowId: target.windowId,
      paneId: target.paneId,
      windowName,
      tmuxBase,
    });
  }

  if (req.options.detached) {
    return {
      id: runId,
      runDir,
      session: target.session,
      windowId: target.windowId,
      paneId: target.paneId,
      launchScript,
      attachCommand: [...tmuxBase, "attach-session", "-t", target.session],
      killWindowCommand: [...tmuxBase, "kill-window", "-t", target.windowId],
      message: startedMessage(target.session, target.windowId, tmuxBase),
    };
  }

  if (sameServer) {
    const selected = runTmux(req, [
      ...tmuxBase,
      "select-window",
      "-t",
      target.windowId,
    ]);
    if (selected.exitCode !== 0) {
      throw tmuxError("failed to select tmux window", selected);
    }
    const switched = runTmux(req, [
      ...tmuxBase,
      "switch-client",
      "-t",
      target.session,
    ]);
    if (switched.exitCode !== 0) {
      throw tmuxError("failed to switch tmux client", switched);
    }
    return {
      id: runId,
      runDir,
      session: target.session,
      windowId: target.windowId,
      paneId: target.paneId,
      launchScript,
      attachCommand: [...tmuxBase, "attach-session", "-t", target.session],
      killWindowCommand: [...tmuxBase, "kill-window", "-t", target.windowId],
      message: null,
    };
  }

  if (isInsideTmux(req.env)) {
    return {
      id: runId,
      runDir,
      session: target.session,
      windowId: target.windowId,
      paneId: target.paneId,
      launchScript,
      attachCommand: [...tmuxBase, "attach-session", "-t", target.session],
      killWindowCommand: [...tmuxBase, "kill-window", "-t", target.windowId],
      message: startedMessage(target.session, target.windowId, tmuxBase),
    };
  }

  const selected = runTmux(req, [
    ...tmuxBase,
    "select-window",
    "-t",
    target.windowId,
  ]);
  if (selected.exitCode !== 0) {
    throw tmuxError("failed to select tmux window", selected);
  }

  return {
    id: runId,
    runDir,
    session: target.session,
    windowId: target.windowId,
    paneId: target.paneId,
    launchScript,
    attachCommand: [...tmuxBase, "attach-session", "-t", target.session],
    killWindowCommand: [...tmuxBase, "kill-window", "-t", target.windowId],
    message: null,
  };
}

function windowNameArgs(windowName: string | null): string[] {
  if (windowName === null) {
    return [];
  }
  return ["-n", windowName];
}

/**
 * Caller-injected env as tmux `-e KEY=VALUE` argv elements (exec-array, never
 * shell-interpolated). Empty when no `--x-tmux-env` was passed, so the
 * built tmux argv stays byte-identical to the pre-flag form.
 */
function envArgs(env: [string, string][]): string[] {
  return env.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/**
 * Append the pinned transcript session-id carrier to the pane env so the inner
 * re-exec pushes a matching `--session-id`. Appended LAST (tmux applies later
 * `-e` entries as wins on a duplicate key) so the pin is the single source of
 * truth even against a stray caller-injected key. A null id (for example, a
 * continue/resume launch) leaves the env unchanged — byte-identical to before.
 */
function withTranscriptSessionCarrier(
  env: [string, string][],
  transcriptSessionId: string | null,
): [string, string][] {
  if (transcriptSessionId === null) {
    return env;
  }
  return [
    ...env.filter(([key]) => key !== "KEEPER_AGENT_TMUX_SESSION_ID"),
    ["KEEPER_AGENT_TMUX_SESSION_ID", transcriptSessionId],
  ];
}

function buildTmuxBase(tmuxBin: string, options: TmuxLaunchOptions): string[] {
  const tmuxBase = [tmuxBin];
  if (options.socketName !== null) {
    tmuxBase.push("-L", options.socketName);
  }
  if (options.socketPath !== null) {
    tmuxBase.push("-S", options.socketPath);
  }
  return tmuxBase;
}

/**
 * Resolve `tmux` to an absolute path. `Bun.which` honors the current process
 * PATH first; a fall-back scan of the known bin dirs survives even when the
 * launcher itself runs under a stripped PATH. Returns the literal `"tmux"` only
 * when nothing is found, so the caller still gets a sensible ENOENT diagnostic.
 */
export function resolveTmuxBin(env: NodeJS.ProcessEnv): string {
  const onPath = Bun.which("tmux", { PATH: env.PATH ?? undefined });
  if (onPath !== null) {
    return onPath;
  }
  for (const dir of KNOWN_BIN_DIRS) {
    const candidate = join(dir, "tmux");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "tmux";
}

/**
 * Resolve a bin path to absolute against an invocation cwd. Retained as a pure
 * path helper; the detached pane's self-re-exec no longer derives its target
 * from here — it embeds an explicit `launcherArgvPrefix` resolved by the caller
 * (`resolveKeeperAgentPath`), since `process.argv[1]` under keeper is
 * `daemon.ts`/`cli/keeper.ts`, neither carrying the `agent` token.
 */
export function resolveKeeperAgentBin(
  bin: string,
  invocationCwd: string,
): string {
  return isAbsolute(bin) ? bin : resolvePath(invocationCwd, bin);
}

function isInsideTmux(env: NodeJS.ProcessEnv): boolean {
  return (env.TMUX ?? "") !== "";
}

function isCurrentTmuxServer(
  env: NodeJS.ProcessEnv,
  options: TmuxLaunchOptions,
): boolean {
  return (
    isInsideTmux(env) &&
    options.socketName === null &&
    options.socketPath === null
  );
}

function resolveSession(
  req: TmuxLaunchRequest,
  tmuxBase: string[],
  sameServer: boolean,
): string {
  if (req.options.session !== null) {
    return req.options.session;
  }

  if (sameServer) {
    const current = runTmux(req, [
      ...tmuxBase,
      "display-message",
      "-p",
      "#{session_name}",
    ]);
    if (current.exitCode === 0) {
      const session = current.stdout.trim();
      if (session !== "") {
        return session;
      }
    }
  }

  return "keeper-agent";
}

function runTmux(req: TmuxLaunchRequest, cmd: string[]): TmuxCommandResult {
  return req.runTmuxCommand(cmd);
}

interface LaunchPlan {
  runId: string;
  runDir: string | null;
  launchScript: string | null;
  launchCommand: string;
}

/** The artifact path: write launch.sh to a run dir and `exec bash` it. */
function artifactLaunch(req: TmuxLaunchRequest): LaunchPlan {
  const runId = `${RUN_DIR_PREFIX}${req.randomUuid()}`;
  const runDir = join(req.stateDir, "tmux-runs", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const launchScript = join(runDir, "launch.sh");
  writeFileSync(launchScript, buildLaunchScript(req), { mode: 0o700 });
  chmodSync(launchScript, 0o700);
  return {
    runId,
    runDir,
    launchScript,
    launchCommand: `exec bash ${shellQuote(launchScript)}`,
  };
}

/**
 * The `--no-artifacts` path: inline the same launch script body as a
 * `bash -c <body>` argument so nothing touches disk. The script body carries
 * the `-l -i` re-exec semantics unchanged; the leading shebang line degrades to
 * a harmless comment. `runDir`/`launchScript` are null in the JSON result.
 */
function inlineLaunch(req: TmuxLaunchRequest): LaunchPlan {
  const runId = `${RUN_DIR_PREFIX}${req.randomUuid()}`;
  return {
    runId,
    runDir: null,
    launchScript: null,
    launchCommand: `exec bash -c ${shellQuote(buildLaunchScript(req))}`,
  };
}

function buildLaunchScript(req: TmuxLaunchRequest): string {
  const argv = [req.agent, ...req.innerArgs];
  const envExports = launchScriptEnv(req.env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd -- ${shellQuote(req.cwd)}`,
  ];
  if (envExports !== "") {
    lines.push(envExports);
  }
  lines.push(
    'KEEPER_AGENT_SHELL="' + "$" + "{SHELL:-/bin/sh}" + '"',
    `exec "$KEEPER_AGENT_SHELL" -l -i -c '${tmuxShellBody()}' "$KEEPER_AGENT_SHELL" ${[
      ...req.launcherArgvPrefix,
      ...argv,
    ]
      .map(shellQuote)
      .join(" ")}`,
  );
  return `${lines.join("\n")}\n`;
}

function launchScriptEnv(env: NodeJS.ProcessEnv): [string, string][] {
  const keys = new Set([
    "PATH",
    "SHELL",
    "BUN_INSTALL",
    "KEEPER_AGENT_PROFILE",
    "CODEX_HOME",
  ]);
  for (const key of Object.keys(env)) {
    // KEEPER_AGENT_PATH is the launcher's OWN re-exec resolution env (read by
    // resolveKeeperAgentPathDepFree), not a pane-bound carrier — it shares the
    // family prefix but must never cross into the pane, or a pane would inherit
    // the parent's launcher path. Every other KEEPER_AGENT_* var forwards.
    if (key.startsWith("KEEPER_AGENT_") && key !== "KEEPER_AGENT_PATH") {
      keys.add(key);
    }
  }
  return [...keys].sort().flatMap((key): [string, string][] => {
    const value = env[key];
    if (value === undefined) {
      return [];
    }
    return [[key, value]];
  });
}

/**
 * The inner login-shell body: run the harness argv (`"$@"`), then DROP to an
 * interactive login shell so the pane stays visible whatever the harness did.
 *
 * The harness is NOT `exec`ed (that would mask its exit code and kill the drop),
 * so `$?` is captured on the very next statement: on a non-zero exit the pane
 * prints a diagnosis (the exit code — a signal death surfaces as 128+n) pointing
 * at `keeper tabs list`, where a failed restore's durable artifact carries the
 * exact rerun command. A clean exit is byte-silent (the diagnosis branch is
 * skipped). The whole body is embedded inside single quotes in `launch.sh`, so it
 * must contain NO single quote — the double quotes reach bash literally.
 */
function tmuxShellBody(): string {
  return (
    '"$@"; __kr=$?; [ "$__kr" -eq 0 ] || ' +
    'printf "\\n[keeper] pane command exited %s - run keeper tabs list for restore state and the rerun command.\\n" "$__kr" >&2; ' +
    'exec "$0" -l -i'
  );
}

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseCreatedTarget(
  stdout: string,
  fallbackSession: string,
): { session: string; windowId: string; paneId: string } {
  const line = stdout
    .trim()
    .split("\n")
    .find((candidate) => candidate !== "");
  if (line === undefined) {
    throw new TmuxLaunchError(
      "tmux did not report the created window",
      TMUX_EXIT.INTERNAL,
    );
  }
  const [session, windowId, paneId] = line.split(CAPTURE_FS);
  if (!windowId?.startsWith("@") || !paneId?.startsWith("%")) {
    throw new TmuxLaunchError(
      `unexpected tmux target output: ${line}`,
      TMUX_EXIT.INTERNAL,
    );
  }
  return { session: session || fallbackSession, windowId, paneId };
}

/**
 * One run-dir candidate for the GC predicate. `pidAlive` is the liveness of the
 * recorded surviving pid: `true`/`false` when knowable, `null` when the dir has
 * no readable marker pid (age-only fallback applies). `mtimeMs` is the dir's
 * effective age clock.
 */
export interface RunDirCandidate {
  name: string;
  mtimeMs: number;
  pidAlive: boolean | null;
}

/**
 * Pure GC predicate: pick which run dirs to sweep. A dir is swept when it is
 * BOTH past the TTL AND not-live (a `null` unknown pid counts as not-live, so
 * the age gate alone governs it). The count-cap is a secondary policy: once at
 * most `maxKeep` newest dirs are kept, any older overflow that is also not-live
 * is swept too — a live pid is never swept regardless of age or rank. Returns
 * the names to delete; never mutates its input.
 */
export function selectRunDirsToSweep(
  candidates: RunDirCandidate[],
  nowMs: number,
  ttlMs = RUN_GC_TTL_MS,
  maxKeep = RUN_GC_MAX_KEEP,
): string[] {
  const live = (c: RunDirCandidate) => c.pidAlive === true;
  const newestFirst = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = new Set<string>();

  for (const c of newestFirst) {
    if (!live(c) && c.mtimeMs < nowMs - ttlMs) {
      doomed.add(c.name);
    }
  }

  let kept = 0;
  for (const c of newestFirst) {
    if (doomed.has(c.name)) {
      continue;
    }
    kept += 1;
    if (kept > maxKeep && !live(c)) {
      doomed.add(c.name);
    }
  }

  return [...doomed];
}

/**
 * Startup sweep of the `tmux-runs` GC root. Reads each child dir's marker
 * (run.json `pid` for liveness, `createdAt`/dir mtime for age), applies
 * `selectRunDirsToSweep`, and `rmSync`s the doomed dirs — but only after a
 * path-traversal guard asserts the target is a DIRECT child of the root. A
 * missing root or any per-dir read error is swallowed (GC is best-effort and
 * must never fail a launch). Sweeps synchronously; never `fs.watch`.
 */
export function sweepRunArtifacts(root: string, nowMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  const candidates: RunDirCandidate[] = [];
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) {
      continue;
    }
    const dir = join(root, name);
    let mtimeMs: number;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) {
        continue;
      }
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ name, mtimeMs, pidAlive: readMarkerPidAlive(dir) });
  }

  for (const name of selectRunDirsToSweep(candidates, nowMs)) {
    const target = join(root, name);
    // Path-traversal guard: only ever delete a direct child of the GC root.
    if (dirname(target) !== root) {
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Read a run dir's surviving-pid liveness. Returns `true`/`false` when run.json
 * carries a numeric `pid`, else `null` (unknown → age-only). `process.kill(pid,
 * 0)` probes liveness without signalling; ESRCH means dead, EPERM means alive
 * but not ours.
 */
function readMarkerPidAlive(dir: string): boolean | null {
  let pid: unknown;
  try {
    const raw = readFileSync(join(dir, "run.json"), "utf8");
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function writeRunMetadata(
  req: TmuxLaunchRequest,
  meta: {
    id: string;
    runDir: string;
    launchScript: string;
    session: string;
    windowId: string;
    paneId: string;
    windowName: string | null;
    tmuxBase: string[];
  },
): void {
  const data = {
    id: meta.id,
    createdAt: new Date().toISOString(),
    startedAtMs: req.startedAtMs,
    // The surviving pid (the tmux pane's client) is not knowable at write time,
    // so liveness GC falls back to age-only via a generous TTL. Recorded as null
    // to make the documented fallback explicit in the on-disk format.
    pid: null,
    agent: req.agent,
    cwd: req.cwd,
    transcriptSessionId: req.transcriptSessionId,
    command: ["keeper", "agent", req.agent, ...req.innerArgs],
    tmux: {
      command: meta.tmuxBase,
      session: meta.session,
      windowId: meta.windowId,
      paneId: meta.paneId,
      windowName: meta.windowName,
      detached: req.options.detached,
    },
    runDir: meta.runDir,
    launchScript: meta.launchScript,
  };
  writeFileSync(
    join(meta.runDir, "run.json"),
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

function tmuxError(prefix: string, result: TmuxCommandResult): TmuxLaunchError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new TmuxLaunchError(
    detail ? `${prefix}: ${detail}` : prefix,
    classifyTmuxResult(result),
  );
}

/**
 * Map a failed tmux command result to a launcher exit code. A timeout/kill
 * (the sentinel result code from `defaultTmuxCommandRunner`) or a server-side
 * lock-contention message is transient/retryable (4); a vanished target session
 * is a no-op prereq (3); anything else is an internal failure (1).
 */
function classifyTmuxResult(result: TmuxCommandResult): number {
  if (result.exitCode === TMUX_TIMEOUT_RESULT_CODE) {
    return TMUX_EXIT.RETRYABLE;
  }
  const stderr = result.stderr.toLowerCase();
  if (/lock|resource temporarily unavailable|server exited/.test(stderr)) {
    return TMUX_EXIT.RETRYABLE;
  }
  if (/(can't|cannot|no such|unknown|not) .*?session/.test(stderr)) {
    return TMUX_EXIT.NOOP;
  }
  return TMUX_EXIT.INTERNAL;
}

function startedMessage(
  session: string,
  windowId: string,
  tmuxBase: string[],
): string {
  return (
    `Started keeper agent in tmux window ${windowId} (session ${session}).\n` +
    `Attach with: ${formatCommand([...tmuxBase, "attach-session", "-t", session])}\n`
  );
}

function formatCommand(cmd: string[]): string {
  return cmd.map(shellQuoteForDisplay).join(" ");
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return shellQuote(value);
}
