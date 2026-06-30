/**
 * main() assembly — the launcher control flow, wiring the pure modules, the
 * state layer, and the process layer. Side-effecting collaborators (spawn, the
 * keystroke read, profile listing/picking, exit) are injected via `MainDeps` so
 * the whole flow is testable against a fake agent and a recording spawn.
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "../keeper-agent-path";
import { buildPairLaunchArgv } from "../pair-command";
import { DEFAULT_PROFILE, listProfiles, pickProfile } from "../usage-picker";
import { normalizeKeeperAgentProfileArg, parseArgsForAgent } from "./args";
import {
  type CodexSessionNameIndexerOptions,
  startCodexSessionNameIndexer,
} from "./codex-session-index";
import {
  ConfigError,
  codexConfigPath,
  type LauncherDefaults,
  loadClaudeStowDir,
  loadLauncherDefaults,
  loadPanelSelections,
  loadPiLauncherDefaults,
  loadPluginSources,
  loadPresetCatalog,
  type PanelSelections,
  type PiLauncherDefaults,
  type PluginSources,
  type Preset,
  type PresetCatalog,
  panelConfigPath,
  pluginConfigPath,
  presetsCatalogPath,
  resolvePreset,
} from "./config";
import { checkCwdInProjectRoot } from "./cwd-confirm";
import { migrateLegacyAgentStateDir, nextCwdOrdinal } from "./cwd-ordinal";
import {
  type AgentKind,
  hasKeeperAgentHelpFlag,
  KEEPER_AGENT_HELP,
  type SubcommandKind,
  splitSubcommand,
  USAGE,
  VERSION,
} from "./dispatch";
import {
  type ResolvedHandle,
  resolveHandle,
  runShowLastMessage,
  runWaitForStop,
} from "./pair-subcommands";
import {
  findCodexPassthroughCommand,
  findPassthroughCommand,
  findPiPassthroughCommand,
  hasExplicitCodexEffortArg,
  hasExplicitCodexModelArg,
  hasExplicitCodexProfileArg,
  resolveStartupEffortOverride,
  resolveStartupModelOverride,
  resolveStartupThinkingOverride,
} from "./passthrough";
import { makePhaser } from "./phaser";
import { discoverPlugins, PluginError } from "./plugins";
import {
  defaultSpawn,
  runPassthrough,
  runWithJobControl,
  type SpawnFn,
} from "./run";
import {
  buildRunCaptureEnvelope,
  captureFromHandle,
  composeRunCapture,
  parseRunArgs,
  type RunCaptureDeps,
  type RunCaptureResult,
  type RunLaunchResult,
} from "./run-capture";
import { extractPromptText, resolveSessionSlug } from "./session-name";
import {
  findShadowProfileDirs,
  type ShadowProfileAgent,
  type ShadowProfileFinding,
} from "./shadow-profiles";
import {
  ensureClaudeStateSharing,
  ensureKeeperAgentPiProfileDir,
  ensureKeeperAgentProfileDir,
  ensurePiStateSharing,
  StateError,
} from "./state-sharing";
import {
  defaultKeeperAgentStateDir,
  defaultTmuxCommandRunner,
  launchKeeperAgentInTmux,
  parseKeeperAgentTmuxArgs,
  resolveTmuxBin,
  TMUX_EXIT,
  type TmuxCommandRunner,
  TmuxLaunchError,
} from "./tmux-launch";
import type { TranscriptStop } from "./transcript-watch";
import { readSingleChar } from "./tty";

export interface MainDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: SpawnFn;
  readChar: () => string;
  listProfilesFn: () => string[];
  pickProfileFn: () => string;
  nextCwdOrdinalFn: (dirName: string) => number;
  randomUuid: () => string;
  /** Wall clock (ms), seam for deterministic run-capture `elapsed_seconds`. */
  now: () => number;
  write: (s: string) => void;
  writeErr: (s: string) => void;
  exit: (code: number) => never;
  // HOME-coupled collaborators, injected so the whole flow is testable without
  // a real ~/.config or ~/.claude tree. `os.homedir()` ignores process.env.HOME
  // (it reads the passwd db), so these cannot be isolated by redirecting HOME —
  // they must be seams. realDeps() wires the production implementations.
  claudeBin: string;
  codexBin: string;
  piBin: string;
  pluginConfigPath: string;
  loadLauncherDefaultsFn: () => LauncherDefaults;
  loadCodexLauncherDefaultsFn: () => LauncherDefaults;
  loadPiLauncherDefaultsFn: () => PiLauncherDefaults;
  loadClaudeStowDirFn: () => string | null;
  loadPluginSourcesFn: () => PluginSources;
  /**
   * Read the preset catalog from `presets.yaml` (required + validated).
   * Producer-side launch config only — never a fold input; re-parsed per dispatch
   * (no watcher) so an edit lands without a daemon bounce.
   */
  loadPresetCatalogFn: () => PresetCatalog;
  /**
   * Read the panel selections from `panel.yaml`, resolved against the catalog.
   * Required + validated; consulted only when a name is not a catalog preset.
   */
  loadPanelSelectionsFn: (catalog: PresetCatalog) => PanelSelections;
  ensureClaudeStateSharingFn: (
    listProfilesFn: () => string[],
    actionLog: string[],
    claudeStowDir: string | null,
  ) => void;
  ensureKeeperAgentProfileDirFn: (
    profileName: string,
    trustPaths: string[] | null,
    actionLog: string[] | null,
  ) => [string, boolean];
  ensurePiStateSharingFn: (
    listProfilesFn: () => string[],
    actionLog: string[],
  ) => void;
  ensureKeeperAgentPiProfileDirFn: (
    profileName: string,
    actionLog: string[] | null,
  ) => [string, boolean];
  /**
   * Read-only scan of `~/.claude-profiles` + `~/.pi-profiles` for shadow/stray
   * dirs (the `profiles check` diagnostic). HOME-coupled, so injected: realDeps()
   * binds the real `findShadowProfileDirs` against `homedir()`.
   */
  findShadowProfileDirsFn: () => ShadowProfileFinding[];
  startCodexSessionNameIndexerFn: (
    opts: CodexSessionNameIndexerOptions,
  ) => () => void;
  tmuxBin: string;
  /**
   * The argv PREFIX the detached pane re-execs (`[<abs bun>, <abs cli/keeper.ts>,
   * "agent"]`), ahead of the agent token + inner args. Resolved in `realDeps()`
   * from `resolveKeeperAgentPathDepFree` (db.ts-free — the launcher carries no
   * daemon dependency), NOT from `process.argv[1]`.
   */
  launcherArgvPrefix: string[];
  launcherStateDir: string;
  transcriptHomeDir: string;
  runTmuxCommandFn: TmuxCommandRunner;
}

/** Production deps — the real collaborators. */
export function realDeps(): MainDeps {
  // Relocate the legacy ~/.local/state/agentwrap dir before the launcher's
  // tmux-runs/ mkdir reads launcherStateDir (a launch with an explicit --name
  // never hits the cwd-ordinal chokepoint, so this surface must migrate too).
  migrateLegacyAgentStateDir();
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    spawn: defaultSpawn,
    readChar: readSingleChar,
    listProfilesFn: listProfiles,
    pickProfileFn: pickProfile,
    nextCwdOrdinalFn: nextCwdOrdinal,
    randomUuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    claudeBin: join(homedir(), ".local", "bin", "claude"),
    codexBin: resolveCodexBin(process.env),
    piBin: "pi",
    pluginConfigPath: pluginConfigPath(),
    loadLauncherDefaultsFn: loadLauncherDefaults,
    loadCodexLauncherDefaultsFn: () => loadLauncherDefaults(codexConfigPath()),
    loadPiLauncherDefaultsFn: loadPiLauncherDefaults,
    loadClaudeStowDirFn: loadClaudeStowDir,
    loadPluginSourcesFn: loadPluginSources,
    loadPresetCatalogFn: loadPresetCatalog,
    loadPanelSelectionsFn: (catalog) => loadPanelSelections(catalog),
    ensureClaudeStateSharingFn: (listProfilesFn, actionLog, claudeStowDir) =>
      ensureClaudeStateSharing(
        listProfilesFn,
        actionLog,
        homedir(),
        claudeStowDir,
      ),
    ensureKeeperAgentProfileDirFn: ensureKeeperAgentProfileDir,
    ensurePiStateSharingFn: (listProfilesFn, actionLog) =>
      ensurePiStateSharing(listProfilesFn, actionLog, homedir()),
    ensureKeeperAgentPiProfileDirFn: (profileName, actionLog) =>
      ensureKeeperAgentPiProfileDir(profileName, actionLog, homedir()),
    findShadowProfileDirsFn: () =>
      findShadowProfileDirs(listProfiles, homedir()),
    startCodexSessionNameIndexerFn: startCodexSessionNameIndexer,
    tmuxBin: resolveTmuxBin(process.env),
    launcherArgvPrefix: buildLauncherArgvPrefix(
      process.execPath,
      resolveKeeperAgentPathDepFree(),
    ),
    launcherStateDir: defaultKeeperAgentStateDir(process.env),
    transcriptHomeDir: homedir(),
    runTmuxCommandFn: defaultTmuxCommandRunner,
  };
}

const CLAUDE_SESSION_ENV_VARS_TO_SCRUB: readonly string[] = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
];

function scrubInheritedClaudeSessionEnv(
  env: NodeJS.ProcessEnv,
  actionLog: string[],
): void {
  const scrubbed: string[] = [];
  for (const key of CLAUDE_SESSION_ENV_VARS_TO_SCRUB) {
    if (env[key] !== undefined) {
      delete env[key];
      scrubbed.push(key);
    }
  }
  if (scrubbed.length > 0) {
    actionLog.push(
      `Scrubbed inherited Claude session env: ${scrubbed.join(", ")}`,
    );
  }
}

function resolveCodexBin(env: NodeJS.ProcessEnv): string {
  for (const pathEntry of (env.PATH ?? "").split(delimiter)) {
    const dir = pathEntry || ".";
    const candidate = join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (basename(resolved) === "arthack-codex.py") {
        continue;
      }
      return resolved;
    } catch {
      // Try the next PATH entry.
    }
  }
  return "codex";
}

/**
 * True iff `flag` appears as an exact token or in joined `flag=value` form.
 * A strict superset of `args.includes(flag)`: unlike passthrough.ts's effort/
 * model predicates it does NOT stop at a bare `--`, so it only ever broadens
 * the existing `includes` guard by also matching the joined form.
 */
function hasFlagToken(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** Format the run command with line continuations for readability (>80 chars). */
function formatCommand(runCmd: string[]): string {
  const cmdStr = runCmd.join(" ");
  if (cmdStr.length <= 80) {
    return cmdStr;
  }
  let formatted = "";
  for (const part of runCmd) {
    if (!formatted) {
      formatted = part;
    } else if (part.startsWith("--") || part === "-f") {
      formatted += ` \\\n  ${part}`;
    } else {
      formatted += ` ${part}`;
    }
  }
  return formatted;
}

function printVerbose(
  deps: MainDeps,
  actionLog: string[],
  commandLine: string,
): void {
  deps.write("Actions:\n");
  for (const action of actionLog) {
    deps.write(`- ${action}\n`);
  }
  deps.write("\n");
  deps.write("Command:\n");
  deps.write(`${commandLine}\n`);
}

function displayAgent(agent: AgentKind): string {
  if (agent === "claude") {
    return "Claude";
  }
  if (agent === "codex") {
    return "Codex";
  }
  return "Pi";
}

function agentProfileEnvName(agent: AgentKind): string {
  if (agent === "claude") {
    return "KEEPER_AGENT_CLAUDE_PROFILE";
  }
  if (agent === "codex") {
    return "KEEPER_AGENT_CODEX_PROFILE";
  }
  return "KEEPER_AGENT_PI_PROFILE";
}

function findPassthroughForAgent(
  agent: AgentKind,
  args: string[],
): string | null {
  if (agent === "claude") {
    return findPassthroughCommand(args);
  }
  if (agent === "codex") {
    return findCodexPassthroughCommand(args);
  }
  return findPiPassthroughCommand(args);
}

function hasPiMetadataPassthrough(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (
      arg === "-h" ||
      arg === "--help" ||
      arg === "-v" ||
      arg === "--version" ||
      arg === "--list-models" ||
      arg === "--export" ||
      arg.startsWith("--export=")
    ) {
      return true;
    }
    if (arg === "--mode") {
      return args[i + 1] === "rpc";
    }
    if (arg === "--mode=rpc") {
      return true;
    }
  }
  return false;
}

function resolveCodexStartupModelOverride(
  args: string[],
  defaultModel: string | null,
): string | null {
  if (hasExplicitCodexModelArg(args)) {
    return null;
  }
  return defaultModel;
}

function resolveCodexStartupEffortOverride(
  args: string[],
  defaultEffort: string | null,
): string | null {
  if (hasExplicitCodexEffortArg(args)) {
    return null;
  }
  return defaultEffort;
}

function codexEffortConfigArg(effort: string): string {
  return `model_reasoning_effort="${effort}"`;
}

function codexConfigValue(args: string[], index: number): string | null {
  const arg = args[index];
  if (arg === "-c" || arg === "--config") {
    return args[index + 1] ?? "";
  }
  if (arg?.startsWith("--config=")) {
    return arg.slice("--config=".length);
  }
  return null;
}

function configStartsWithKey(
  value: string,
  keys: ReadonlySet<string>,
): boolean {
  const trimmed = value.trim();
  for (const key of keys) {
    if (trimmed === key || trimmed.startsWith(`${key}=`)) {
      return true;
    }
  }
  return false;
}

function hasCodexPermissionsOverride(args: string[]): boolean {
  const configKeys = new Set(["sandbox_mode", "approval_policy"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return false;
    }
    if (
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--yolo" ||
      arg === "-s" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-a" ||
      arg === "--ask-for-approval" ||
      arg.startsWith("--ask-for-approval=")
    ) {
      return true;
    }

    const configValue = codexConfigValue(args, i);
    if (configValue !== null) {
      if (configStartsWithKey(configValue, configKeys)) {
        return true;
      }
      if (arg === "-c" || arg === "--config") {
        i += 1;
      }
    }
  }
  return false;
}

function hasCodexWebSearchOverride(args: string[]): boolean {
  const configKeys = new Set(["web_search"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return false;
    }
    if (arg === "--search") {
      return true;
    }

    const configValue = codexConfigValue(args, i);
    if (configValue !== null) {
      if (configStartsWithKey(configValue, configKeys)) {
        return true;
      }
      if (arg === "-c" || arg === "--config") {
        i += 1;
      }
    }
  }
  return false;
}

function codexWrapperDefaults(args: string[]): string[] {
  const defaults: string[] = [];
  if (!hasCodexPermissionsOverride(args)) {
    defaults.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (!hasCodexWebSearchOverride(args)) {
    defaults.push("--search");
  }
  return defaults;
}

function existingSessionId(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--session-id") {
      return args[i + 1] ?? null;
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length) || null;
    }
  }
  return null;
}

/**
 * The pinned transcript session id for a tmux launch: an explicit user
 * `--session-id`, else a freshly minted uuid for a new claude/pi session. Null
 * for codex (no id pin) and for a continue/resume launch (keeps the persisted
 * session). This one id is recorded in run.json `transcriptSessionId`, forwarded
 * into the pane via the `-e KEEPER_AGENT_TMUX_SESSION_ID` carrier, and consumed by
 * the inner re-exec's `--session-id` push — one source of truth, no divergence.
 */
function tmuxTranscriptSessionId(
  agent: AgentKind,
  args: string[],
  randomUuid: () => string,
): string | null {
  if (agent === "codex") {
    return null;
  }

  const parsed = parseArgsForAgent(args, agent);
  const explicit = existingSessionId(parsed.remainingArgs);
  if (explicit !== null) {
    return explicit;
  }
  if (parsed.hasContinueOrResume) {
    return null;
  }
  return randomUuid();
}

/**
 * tmux-mode JSON contract version. One stable schema serves the launch result,
 * the `wait-for-stop` / `show-last-message` subcommand results, and the error
 * object on a non-zero exit. Bump only on a breaking shape change.
 */
const TMUX_SCHEMA_VERSION = 1;

/**
 * The machine-readable launch schema, emitted as one stdout line the moment the
 * window is created. `transcriptPath`/`stop`/`waitedForStop` are retained at
 * null/false for shape stability — reading the transcript is now the job of the
 * composable `wait-for-stop` / `show-last-message` subcommands (keyed off the
 * `id` handle). `session/windowId/paneId` live at the top level (the stable bind
 * points) and stay mirrored under `tmux` for richer readers.
 */
function tmuxMetadata(args: {
  agent: AgentKind;
  cwd: string;
  id: string;
  runDir: string | null;
  session: string;
  windowId: string;
  paneId: string;
  launchScript: string | null;
  attachCommand: string[] | null;
  transcriptPath: string | null;
  stop: TranscriptStop | null;
  waitedForStop: boolean;
}): string {
  return `${JSON.stringify({
    schema_version: TMUX_SCHEMA_VERSION,
    id: args.id,
    agent: args.agent,
    cwd: args.cwd,
    session: args.session,
    windowId: args.windowId,
    paneId: args.paneId,
    runDir: args.runDir,
    launchScript: args.launchScript,
    transcriptPath: args.transcriptPath,
    waitedForStop: args.waitedForStop,
    stop: args.stop,
    tmux: {
      session: args.session,
      windowId: args.windowId,
      paneId: args.paneId,
      attachCommand: args.attachCommand,
    },
  })}\n`;
}

/**
 * The structured error object, emitted as one stdout line on a non-zero exit
 * (Pattern A: machine-readable on every path). `schema_version` is shared with
 * the success shape; `reason` is a stable, code-keyed machine token; `exitCode`
 * mirrors the process exit so a caller binding on stdout never has to read it.
 * Human diagnostics still go to stderr.
 */
function tmuxErrorJson(exitCode: number, message: string): string {
  return `${JSON.stringify({
    schema_version: TMUX_SCHEMA_VERSION,
    error: true,
    reason: tmuxErrorReason(exitCode),
    exitCode,
    message,
  })}\n`;
}

function tmuxErrorReason(exitCode: number): string {
  switch (exitCode) {
    case TMUX_EXIT.NOOP:
      return "prerequisite_missing";
    case TMUX_EXIT.RETRYABLE:
      return "transient";
    case TMUX_EXIT.BAD_ARGS:
      return "bad_args";
    default:
      return "internal";
  }
}

/**
 * Drive the post-launch transcript verbs (`wait-for-stop` / `show-last-message`).
 * Resolve the `<handle>` (run id or transcript path) to its agent/cwd/session,
 * then block-for-stop or read-final-message. Emits one machine-readable JSON
 * line on stdout in both modes; a bad handle/arg exits BAD_ARGS, a transcript
 * never appearing exits RETRYABLE — same exit taxonomy as tmux mode.
 */
async function runTranscriptSubcommand(
  deps: MainDeps,
  verb: SubcommandKind,
  rest: string[],
): Promise<never> {
  const resolution = resolveHandle({
    rest,
    cwd: deps.cwd,
    stateDir: deps.launcherStateDir,
  });
  if (!resolution.ok) {
    deps.writeErr(`keeper agent: ${resolution.error}\n`);
    deps.write(tmuxErrorJson(TMUX_EXIT.BAD_ARGS, resolution.error));
    return deps.exit(TMUX_EXIT.BAD_ARGS);
  }
  const verbDeps = { env: deps.env, homeDir: deps.transcriptHomeDir };

  if (verb === "wait-for-stop") {
    const result = await runWaitForStop(resolution.handle, verbDeps);
    if (!result.ok) {
      deps.writeErr(`Error: ${result.error}\n`);
      deps.write(tmuxErrorJson(TMUX_EXIT.RETRYABLE, result.error));
      return deps.exit(TMUX_EXIT.RETRYABLE);
    }
    deps.write(
      `${JSON.stringify({
        schema_version: TMUX_SCHEMA_VERSION,
        agent: resolution.handle.agent,
        transcriptPath: result.transcriptPath,
        waitedForStop: true,
        stop: result.stop,
      })}\n`,
    );
    return deps.exit(0);
  }

  const result = await runShowLastMessage(resolution.handle, verbDeps);
  if (!result.ok) {
    deps.writeErr(`Error: ${result.error}\n`);
    deps.write(tmuxErrorJson(TMUX_EXIT.RETRYABLE, result.error));
    return deps.exit(TMUX_EXIT.RETRYABLE);
  }
  // The bare final message goes to stdout for direct capture; the JSON metadata
  // line follows so a structured reader sees agent/transcriptPath/found and can
  // distinguish a tool-only empty turn (found:true, message:null) from no turn.
  if (result.text !== null) {
    deps.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  }
  deps.write(
    `${JSON.stringify({
      schema_version: TMUX_SCHEMA_VERSION,
      agent: resolution.handle.agent,
      transcriptPath: result.transcriptPath,
      found: result.found,
      message: result.text,
    })}\n`,
  );
  return deps.exit(0);
}

/** The wait/show/clock seams the run-capture compose drives, bound to the
 *  production primitives + the injected clock. */
function runCaptureSeams(deps: MainDeps): RunCaptureDeps {
  return {
    waitForStop: runWaitForStop,
    showLastMessage: runShowLastMessage,
    now: deps.now,
  };
}

/**
 * Emit the run-capture envelope as exactly ONE JSON line on stdout, then exit
 * with the outcome's code. JSON-ONLY on stdout (no bare-text prelude like
 * show-last-message) — every diagnostic already went to stderr, so a programmatic
 * caller parses stdout cleanly.
 */
function emitRunCapture(deps: MainDeps, result: RunCaptureResult): never {
  deps.write(`${JSON.stringify(result.envelope)}\n`);
  return deps.exit(result.exitCode);
}

/**
 * The first positional (run id or transcript path) of an `agent wait` argv —
 * echoed into the envelope's `handle`. Mirrors `resolveHandle`'s positional
 * detection (skip `--agent`/`--stop-timeout-ms` values and any other `--flag`).
 */
function firstHandleToken(rest: string[]): string | null {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--agent" || arg === "--stop-timeout-ms") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    return arg;
  }
  return null;
}

/**
 * The `agent run` launch seam: assemble the per-CLI detached launch argv (reusing
 * the pair builder for the native posture flags), strip the prefix + cli token,
 * and drive `launchKeeperAgentInTmux` DIRECTLY — no subprocess re-exec. The pinned
 * handle returned here is held LOCALLY by the compose (no run.json re-resolution,
 * no cross-process kill margin, no self-transcript-collision exposure). A
 * parse/launch failure maps to `launch_failed`; diagnostics go to stderr.
 */
function launchForRunCapture(
  deps: MainDeps,
  agent: AgentKind,
  prompt: string,
  stopTimeoutMs: number | null,
): RunLaunchResult {
  const launchArgv = buildPairLaunchArgv({
    launcherArgvPrefix: [],
    cli: agent,
    prompt,
    readOnly: false,
  });
  const tmuxLaunch = parseKeeperAgentTmuxArgs(launchArgv.slice(1));
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`agent: ${tmuxLaunch.error}\n`);
    return { ok: false, error: tmuxLaunch.error };
  }
  const startedAtMs = deps.now();
  const transcriptSessionId = tmuxTranscriptSessionId(
    agent,
    tmuxLaunch.remainingArgs,
    deps.randomUuid,
  );
  try {
    const result = launchKeeperAgentInTmux({
      agent,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: deps.env,
      cwd: deps.cwd,
      transcriptSessionId,
      startedAtMs,
      stateDir: deps.launcherStateDir,
      tmuxBin: deps.tmuxBin,
      launcherArgvPrefix: deps.launcherArgvPrefix,
      randomUuid: deps.randomUuid,
      runTmuxCommand: deps.runTmuxCommandFn,
    });
    const handle: ResolvedHandle = {
      agent,
      cwd: deps.cwd,
      sessionId: transcriptSessionId,
      startedAtMs,
      transcriptPath: null,
      stopTimeoutMs,
    };
    return { ok: true, handle, runId: result.id };
  } catch (exc) {
    if (exc instanceof TmuxLaunchError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return { ok: false, error: exc.message };
    }
    throw exc;
  }
}

/**
 * `agent run <cli> <prompt>`: compose launch→wait→show in one process, emitting
 * the uniform run-capture envelope. A bad invocation short-circuits to bad_args
 * with the same envelope (nulls elsewhere) — never a separate error shape.
 */
async function runRunCaptureSubcommand(
  deps: MainDeps,
  rest: string[],
): Promise<never> {
  const parsed = parseRunArgs(rest);
  if (!parsed.ok) {
    deps.writeErr(`agent: ${parsed.error}\n`);
    return emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
    );
  }
  const agent = parsed.cli;
  const verbDeps = { env: deps.env, homeDir: deps.transcriptHomeDir };
  const result = await composeRunCapture(
    {
      ...runCaptureSeams(deps),
      launch: () =>
        launchForRunCapture(deps, agent, parsed.prompt, parsed.stopTimeoutMs),
    },
    verbDeps,
    agent,
  );
  return emitRunCapture(deps, result);
}

/**
 * `agent wait <handle>`: resolve the handle (run id or transcript path), then
 * wait→show and emit the SAME uniform envelope. An unresolvable handle is
 * bad_args.
 */
async function runWaitCaptureSubcommand(
  deps: MainDeps,
  rest: string[],
): Promise<never> {
  const startMs = deps.now();
  const resolution = resolveHandle({
    rest,
    cwd: deps.cwd,
    stateDir: deps.launcherStateDir,
  });
  if (!resolution.ok) {
    deps.writeErr(`agent: ${resolution.error}\n`);
    return emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
    );
  }
  const verbDeps = { env: deps.env, homeDir: deps.transcriptHomeDir };
  const result = await captureFromHandle(runCaptureSeams(deps), verbDeps, {
    handle: resolution.handle,
    handleId: firstHandleToken(rest),
    agent: resolution.handle.agent,
    startMs,
  });
  return emitRunCapture(deps, result);
}

/**
 * `presets resolve <name>`: emit the resolved launch-config JSON to stdout. A
 * name matching a single preset emits `{kind:"preset", name, harness, model,
 * effort, thinking, role}` (absent fields null); a name matching a panel emits
 * `{kind:"panel", name, members:[{name, harness}, ...]}` in declaration order —
 * every member harness (claude|codex|pi) is pair-launchable. A `kind`
 * discriminator pins the contract task 4's panel SKILL parses with jq. A name
 * matching neither is fail-loud (exit 2).
 */
function runPresetsResolve(deps: MainDeps, name: string): never {
  let catalog: PresetCatalog;
  try {
    catalog = deps.loadPresetCatalogFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  // A catalog preset wins and needs no `panel.yaml` read; only a non-preset name
  // falls through to panel resolution (which DOES require `panel.yaml`).
  const direct = catalog.presets[name];
  if (direct !== undefined) {
    deps.write(
      `${JSON.stringify({
        kind: "preset",
        name,
        harness: direct.harness,
        model: direct.model,
        effort: direct.effort,
        thinking: direct.thinking,
        role: direct.role,
      })}\n`,
    );
    return deps.exit(0);
  }

  let selections: PanelSelections;
  try {
    selections = deps.loadPanelSelectionsFn(catalog);
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  const panelMembers = selections.panels[name];
  if (panelMembers !== undefined) {
    // Load-time validation already guarantees each member resolves to a
    // panel-launchable (claude|codex) catalog preset.
    const members = panelMembers.map((memberName) => {
      const preset = catalog.presets[memberName] as Preset;
      return { name: memberName, harness: preset.harness };
    });
    deps.write(`${JSON.stringify({ kind: "panel", name, members })}\n`);
    return deps.exit(0);
  }

  const presetNames = Object.keys(catalog.presets).sort();
  const panelNames = Object.keys(selections.panels).sort();
  deps.writeErr(
    `Error: '${name}' is not a known preset or panel. ` +
      `Presets: ${presetNames.length > 0 ? presetNames.join(", ") : "(none)"}. ` +
      `Panels: ${panelNames.length > 0 ? panelNames.join(", ") : "(none)"}.\n`,
  );
  return deps.exit(2);
}

/**
 * `presets list [--json]`: the discovery surface so an agent passes a real
 * `--preset` name. Enumerates every catalog preset (name + harness/model/effort)
 * and every panel (name + ordered members) from `presets.yaml` + `panel.yaml`.
 * Human-readable by default, `--json` ({kind:"presets-list", presets, panels,
 * default}) for machine consumption. A missing/invalid catalog or panel file is
 * fail-loud (exit 2) carrying task 1's migration hint — `presets list` IS the
 * entry point that surfaces the config gap, never a crash.
 */
function runPresetsList(deps: MainDeps, json: boolean): never {
  let catalog: PresetCatalog;
  try {
    catalog = deps.loadPresetCatalogFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  let selections: PanelSelections;
  try {
    selections = deps.loadPanelSelectionsFn(catalog);
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  const presetNames = Object.keys(catalog.presets).sort();
  const panelNames = Object.keys(selections.panels).sort();

  if (json) {
    const presets = presetNames.map((name) => {
      const p = catalog.presets[name] as Preset;
      return {
        name,
        harness: p.harness,
        model: p.model,
        effort: p.effort,
        thinking: p.thinking,
        role: p.role,
      };
    });
    const panels = panelNames.map((name) => ({
      name,
      members: (selections.panels[name] as string[]).map((member) => ({
        name: member,
        harness: (catalog.presets[member] as Preset).harness,
      })),
    }));
    deps.write(
      `${JSON.stringify({
        kind: "presets-list",
        presets,
        panels,
        default: selections.default,
      })}\n`,
    );
    return deps.exit(0);
  }

  const lines: string[] = [`Presets (${presetsCatalogPath()}):`];
  if (presetNames.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of presetNames) {
      const p = catalog.presets[name] as Preset;
      const parts: string[] = [p.harness];
      if (p.model !== null) parts.push(`model=${p.model}`);
      if (p.effort !== null) parts.push(`effort=${p.effort}`);
      if (p.thinking !== null) parts.push(`thinking=${p.thinking}`);
      if (p.role !== null) parts.push(`role=${p.role}`);
      lines.push(`  ${name}  ${parts.join(" ")}`);
    }
  }
  lines.push(`Panels (${panelConfigPath()}):`);
  if (panelNames.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of panelNames) {
      const members = selections.panels[name] as string[];
      const marker = selections.default === name ? " (default)" : "";
      lines.push(`  ${name}  [${members.join(", ")}]${marker}`);
    }
  }
  deps.write(`${lines.join("\n")}\n`);
  return deps.exit(0);
}

/** `profiles check` JSON contract version. Bump only on a breaking shape change. */
const PROFILES_CHECK_SCHEMA_VERSION = 1;

/** `profiles check` exit when one or more shadow/stray dirs are found. */
const PROFILES_CHECK_FOUND_EXIT = 9;

type ProfilesCheckFindingKind =
  | "auth-bearing-reserved-shadow"
  | "reserved-shadow"
  | "stray-auth"
  | "stray"
  | "tier-metadata-missing";

/** Classify a finding into a stable category that drives its remediation. */
function profilesCheckKind(f: ShadowProfileFinding): ProfilesCheckFindingKind {
  if (f.tierUnresolved) {
    return "tier-metadata-missing";
  }
  if (f.isReservedShadow) {
    return f.hasAuth ? "auth-bearing-reserved-shadow" : "reserved-shadow";
  }
  return f.hasAuth ? "stray-auth" : "stray";
}

function profilesRootDisplay(agent: ShadowProfileAgent): string {
  return agent === "claude" ? "~/.claude-profiles" : "~/.pi-profiles";
}

function canonicalAccountDisplay(agent: ShadowProfileAgent): string {
  return agent === "claude" ? "~/.claude" : "~/.pi";
}

/** Stable per-finding remediation prose — keeper NEVER performs the move/delete. */
function profilesCheckRemediation(
  f: ShadowProfileFinding,
  kind: ProfilesCheckFindingKind,
): string {
  const account = canonicalAccountDisplay(f.agent);
  switch (kind) {
    case "auth-bearing-reserved-shadow":
      return (
        `Auth-bearing reserved shadow: the '${f.name}' account lives in ${account}, ` +
        `so this dir strands a login nothing reads. Re-home it into ${account} by hand — ` +
        "keeper never moves it for you."
      );
    case "reserved-shadow":
      return (
        `Reserved shadow with no auth. Remove the empty dir once confirmed — ` +
        "keeper never deletes it."
      );
    case "stray-auth":
      return (
        `Untracked dir holding auth. Re-home into ${account} or add '${f.name}' to ` +
        "agentusage config.yaml profiles; keeper never moves it for you."
      );
    case "stray":
      return (
        `Untracked profile dir. Remove it or add '${f.name}' to agentusage config.yaml ` +
        "profiles; keeper never deletes it."
      );
    case "tier-metadata-missing":
      return (
        `Authed but the tier is unresolvable: ${account}'s oauthAccount carries no ` +
        "resolvable organizationRateLimitTier, so usage renders '?x' instead of the real " +
        "multiplier. A /login restores the keychain but not the oauthAccount tier cache — " +
        `re-home that metadata into ${account} (see the re-homing runbook); a persistent ` +
        "'?x' means the step is still pending. keeper never edits it for you."
      );
  }
}

/**
 * `profiles check [--json]`: the read-only shadow/stray profile-dir diagnostic.
 * Scans `~/.claude-profiles` + `~/.pi-profiles` for reserved shadows
 * (`default`/`auto`) and untracked strays, surfacing a stable `id` + remediation
 * per finding so the JSON doubles as a runbook. Findings (data) go to stdout, the
 * summary (prose) to stderr. NEVER mutates the filesystem. Exit 0 = clean, 9 =
 * findings, 1 = tool error (the scan itself threw).
 */
function runProfilesCheck(deps: MainDeps, json: boolean): never {
  let findings: ShadowProfileFinding[];
  try {
    findings = deps.findShadowProfileDirsFn();
  } catch (exc) {
    deps.writeErr(`Error: profiles check failed: ${(exc as Error).message}\n`);
    return deps.exit(1);
  }

  const enriched = findings.map((f) => {
    const kind = profilesCheckKind(f);
    // The tier-metadata finding is the native ~/.claude account, not a
    // profiles-root dir: render the canonical path + a DISTINCT id so it never
    // collides with a `claude:default` ~/.claude-profiles/default shadow.
    const canonical = canonicalAccountDisplay(f.agent);
    return {
      id: f.tierUnresolved ? `${f.agent}:${canonical}` : `${f.agent}:${f.name}`,
      agent: f.agent,
      name: f.name,
      path: f.tierUnresolved
        ? canonical
        : `${profilesRootDisplay(f.agent)}/${f.name}`,
      kind,
      hasAuth: f.hasAuth,
      isReservedShadow: f.isReservedShadow,
      tracked: f.tracked,
      remediation: profilesCheckRemediation(f, kind),
    };
  });
  // Count tier-metadata findings SEPARATELY from the auth-bearing-shadow tally:
  // their prose differs ("re-home incomplete", not "a login nothing reads"),
  // and a tier finding is authed but is not a stranded shadow.
  const tierMissing = enriched.filter(
    (f) => f.kind === "tier-metadata-missing",
  ).length;
  const authBearing = enriched.filter(
    (f) => f.hasAuth && f.kind !== "tier-metadata-missing",
  ).length;

  if (json) {
    deps.write(
      `${JSON.stringify({
        schema_version: PROFILES_CHECK_SCHEMA_VERSION,
        findings: enriched,
        summary: { total: enriched.length, authBearing, tierMissing },
      })}\n`,
    );
    return deps.exit(enriched.length === 0 ? 0 : PROFILES_CHECK_FOUND_EXIT);
  }

  if (enriched.length === 0) {
    deps.writeErr("profiles check: no shadow or stray profile dirs found.\n");
    return deps.exit(0);
  }

  for (const f of enriched) {
    deps.write(
      `${f.path}  [${f.kind}]  hasAuth=${f.hasAuth} tracked=${f.tracked}\n`,
    );
    deps.write(`    ${f.remediation}\n`);
  }
  const tierNote =
    tierMissing > 0 ? `, ${tierMissing} tier-metadata-missing` : "";
  deps.writeErr(
    `profiles check: ${enriched.length} finding(s) (${authBearing} auth-bearing${tierNote}). ` +
      "Read-only — nothing was moved or deleted.\n",
  );
  return deps.exit(PROFILES_CHECK_FOUND_EXIT);
}

export async function main(deps: MainDeps): Promise<never> {
  const actionLog: string[] = [];

  // Subcommand dispatch pre-pass: classify the leading argv token before any
  // wrapper logic. This MUST precede parseArgs and passthrough detection — an
  // unstripped leading agent name would fall through the passthrough scan and
  // become a prompt arg. A leading agent token continues the launcher flow with
  // the remaining args; the composable verbs (`wait-for-stop`/`show-last-message`
  // read a detached run's transcript, `run`/`wait` block-capture into the uniform
  // envelope) route to their handlers; help/version/usage print + exit through
  // the deps seams.
  const dispatch = splitSubcommand(deps.argv);
  if (dispatch.kind === "help") {
    deps.write(USAGE);
    return deps.exit(0);
  }
  if (dispatch.kind === "help-wrapper") {
    deps.write(KEEPER_AGENT_HELP);
    return deps.exit(0);
  }
  if (dispatch.kind === "version") {
    deps.write(VERSION);
    return deps.exit(0);
  }
  if (dispatch.kind === "usage") {
    if (dispatch.unknown !== undefined) {
      deps.writeErr(`keeper agent: unknown subcommand '${dispatch.unknown}'\n`);
    }
    deps.writeErr(USAGE);
    return deps.exit(2);
  }
  if (dispatch.kind === "subcommand") {
    return runTranscriptSubcommand(deps, dispatch.verb, dispatch.rest);
  }
  if (dispatch.kind === "run-capture") {
    return runRunCaptureSubcommand(deps, dispatch.rest);
  }
  if (dispatch.kind === "wait-capture") {
    return runWaitCaptureSubcommand(deps, dispatch.rest);
  }
  if (dispatch.kind === "presets-resolve") {
    return runPresetsResolve(deps, dispatch.presetName);
  }
  if (dispatch.kind === "presets-list") {
    return runPresetsList(deps, dispatch.json);
  }
  if (dispatch.kind === "profiles-check") {
    return runProfilesCheck(deps, dispatch.json);
  }

  // Resolve the leading-token harness. `run` carries it directly; the
  // harnessless `run-preset` form drives it from the named preset's harness.
  // The preset name (CLI flag or harnessless head) is resolved per field below
  // the explicit-flag / env slots; a head agent disagreeing with the preset's
  // harness is rejected.
  let agent: AgentKind;
  let argv: string[];
  let dispatchPresetName: string | null = null;
  if (dispatch.kind === "run-preset") {
    dispatchPresetName = dispatch.presetName;
    let preset: Preset;
    try {
      preset = resolvePreset(deps.loadPresetCatalogFn(), dispatch.presetName);
    } catch (exc) {
      if (exc instanceof ConfigError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(2);
      }
      throw exc;
    }
    agent = preset.harness;
    argv = dispatch.rest;
  } else {
    agent = dispatch.agent;
    argv = dispatch.rest;
  }
  const bin =
    agent === "claude"
      ? deps.claudeBin
      : agent === "codex"
        ? deps.codexBin
        : deps.piBin;
  const agentLabel = displayAgent(agent);

  // Wrapper-owned help short-circuits before the tmux pre-pass, passthrough
  // detection, and launch — `keeper agent <agent> --x-help` prints the
  // overlay help and exits without reaching the native agent. Native `--help`
  // carries no `--x-help` token, so it still passes through unchanged.
  if (hasKeeperAgentHelpFlag(argv)) {
    deps.write(KEEPER_AGENT_HELP);
    return deps.exit(0);
  }

  const tmuxLaunch = parseKeeperAgentTmuxArgs(argv);
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`keeper agent: ${tmuxLaunch.error}\n`);
    deps.write(tmuxErrorJson(TMUX_EXIT.BAD_ARGS, tmuxLaunch.error));
    return deps.exit(TMUX_EXIT.BAD_ARGS);
  }
  if (tmuxLaunch.enabled) {
    try {
      const startedAtMs = Date.now();
      const transcriptSessionId = tmuxTranscriptSessionId(
        agent,
        tmuxLaunch.remainingArgs,
        deps.randomUuid,
      );
      const result = launchKeeperAgentInTmux({
        agent,
        innerArgs: tmuxLaunch.remainingArgs,
        options: tmuxLaunch.options,
        env: deps.env,
        cwd: deps.cwd,
        transcriptSessionId,
        startedAtMs,
        stateDir: deps.launcherStateDir,
        tmuxBin: deps.tmuxBin,
        launcherArgvPrefix: deps.launcherArgvPrefix,
        randomUuid: deps.randomUuid,
        runTmuxCommand: deps.runTmuxCommandFn,
      });

      // Launch is a window-created contract: print one JSON handle line and exit
      // 0 the moment the window exists. The transcript wait + final-message read
      // are the composable `wait-for-stop` / `show-last-message` subcommands,
      // keyed off the printed `id` handle (or transcriptPath). The launch JSON
      // therefore always carries transcriptPath:null, stop:null.
      deps.write(
        tmuxMetadata({
          agent,
          cwd: deps.cwd,
          id: result.id,
          runDir: result.runDir,
          session: result.session,
          windowId: result.windowId,
          paneId: result.paneId,
          launchScript: result.launchScript,
          attachCommand: result.attachCommand,
          transcriptPath: null,
          stop: null,
          waitedForStop: false,
        }),
      );
      return deps.exit(0);
    } catch (exc) {
      if (exc instanceof TmuxLaunchError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        deps.write(tmuxErrorJson(exc.exitCode, exc.message));
        return deps.exit(exc.exitCode);
      }
      throw exc;
    }
  }

  const parsed = parseArgsForAgent(argv, agent);
  const { remainingArgs, hasContinueOrResume, hasForkSession, hasPrint } =
    parsed;
  const { launcherVerbose, launcherVeryVerbose, launcherNoConfirm } = parsed;
  const { launcherCodexSessionName } = parsed;
  let { launcherProfile, explicitLauncherProfile } = parsed;

  // Named preset resolution: the `--x-preset` flag (or the harnessless
  // head, already mirrored onto parsed.launcherPreset). Resolve it once here so
  // its model/effort/thinking can layer into the resolver default slots BELOW
  // the explicit-flag / effort-env precedence. A head agent disagreeing with the
  // preset's harness is fail-loud — never silently re-route the launch.
  const presetName = parsed.launcherPreset ?? dispatchPresetName;
  let resolvedPreset: Preset | null = null;
  if (presetName !== null) {
    try {
      resolvedPreset = resolvePreset(deps.loadPresetCatalogFn(), presetName);
    } catch (exc) {
      if (exc instanceof ConfigError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(2);
      }
      throw exc;
    }
    if (dispatch.kind === "run" && resolvedPreset.harness !== agent) {
      deps.writeErr(
        `Error: --x-preset ${presetName} pins harness ` +
          `${resolvedPreset.harness}, but the ${agent} subcommand was given.\n`,
      );
      return deps.exit(2);
    }
    actionLog.push(
      `Resolved preset '${presetName}' (${resolvedPreset.harness})`,
    );
  }

  if (hasContinueOrResume) {
    actionLog.push(`Detected ${agentLabel} continuation mode`);
  }
  if (hasPrint) {
    actionLog.push(`Detected ${agentLabel} headless mode`);
  }
  if (launcherNoConfirm) {
    actionLog.push("Parsed --x-no-confirm: cwd confirmation suppressed");
  }
  if (launcherCodexSessionName !== null) {
    actionLog.push(
      `Parsed --x-codex-session-name: ${launcherCodexSessionName}`,
    );
  }

  if (!explicitLauncherProfile) {
    const envProfile = (deps.env.KEEPER_AGENT_PROFILE ?? "").trim();
    if (envProfile && envProfile !== "auto") {
      launcherProfile = envProfile;
      explicitLauncherProfile = true;
      actionLog.push(
        `Forced profile from KEEPER_AGENT_PROFILE env: ${envProfile}`,
      );
    }
  }

  if (explicitLauncherProfile && launcherProfile) {
    actionLog.push(`Parsed --x-profile: ${launcherProfile}`);
    if (launcherProfile !== "auto") {
      const normalized = normalizeKeeperAgentProfileArg(launcherProfile);
      if (normalized !== launcherProfile) {
        actionLog.push(
          `Normalized --x-profile default to native ${agentLabel} account`,
        );
      }
      launcherProfile = normalized;
    }
  }

  const passthroughFlags =
    agent === "codex"
      ? new Set(["-h", "--help", "-V", "--version"])
      : new Set(["-h", "--help", "-v", "--version"]);
  const passthroughCommand = findPassthroughForAgent(agent, remainingArgs);
  let shouldPassthrough = remainingArgs.some((a) => passthroughFlags.has(a));
  if (agent === "pi" && hasPiMetadataPassthrough(remainingArgs)) {
    shouldPassthrough = true;
  }
  if (passthroughCommand !== null) {
    shouldPassthrough = true;
    actionLog.push(`Detected passthrough subcommand: ${passthroughCommand}`);
  } else if (shouldPassthrough) {
    actionLog.push("Detected passthrough informational flag");
  }

  // Verbosity ladder: level 0 (default) is silent before claude is exec'd;
  // level 1 (--x-verbose) prints one line per startup section; level 2
  // (--x-very-verbose, which implies level 1) adds per-phase timing plus
  // the full action log and composed command. --print/passthrough force clean
  // stdout, so section lines never appear there regardless of level.
  const verbose = launcherVerbose || launcherVeryVerbose;
  const chattyQuiet = hasPrint || shouldPassthrough;
  const sectionsOn = verbose && !chattyQuiet;
  const phase = makePhaser(!sectionsOn, deps.write, launcherVeryVerbose);
  const note = (msg: string): void => {
    if (sectionsOn) {
      deps.write(`~ ${msg}\n`);
    }
  };

  let configuredProfiles: string[] = [];
  if (agent !== "codex" && !shouldPassthrough) {
    configuredProfiles = safeList(deps.listProfilesFn);
  }

  if (!shouldPassthrough && !hasPrint && !launcherNoConfirm) {
    phase("check cwd is a project dir", () => {
      checkCwdInProjectRoot(
        actionLog,
        deps.readChar,
        deps.exit,
        deps.write,
        deps.env,
      );
    });
  } else if (launcherNoConfirm && !shouldPassthrough && !hasPrint) {
    actionLog.push(
      "Skipped cwd confirmation (--x-no-confirm): " +
        `${deps.env.PWD || deps.cwd}`,
    );
  }

  if (agent === "claude") {
    try {
      phase("ensure shared Claude state", () => {
        const claudeStowDir = deps.loadClaudeStowDirFn();
        deps.ensureClaudeStateSharingFn(
          deps.listProfilesFn,
          actionLog,
          claudeStowDir,
        );
      });
    } catch (exc) {
      if (exc instanceof StateError || exc instanceof ConfigError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
  } else if (agent === "pi" && !shouldPassthrough) {
    try {
      phase("ensure shared Pi state", () => {
        deps.ensurePiStateSharingFn(deps.listProfilesFn, actionLog);
      });
    } catch (exc) {
      if (exc instanceof StateError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
  }

  if (shouldPassthrough && launcherProfile === "auto") {
    launcherProfile = "";
    actionLog.push("Skipped auto profile routing for passthrough invocation");
  }

  if (shouldPassthrough) {
    const ptCmd = [bin];
    if (agent === "codex") {
      const defaults = codexWrapperDefaults(remainingArgs);
      ptCmd.push(...defaults);
      if (defaults.includes("--dangerously-bypass-approvals-and-sandbox")) {
        actionLog.push("Added Codex full-access default");
      }
      if (defaults.includes("--search")) {
        actionLog.push("Added Codex live-search default");
      }
    }
    if (agent === "codex" && launcherProfile) {
      if (!hasExplicitCodexProfileArg(remainingArgs)) {
        ptCmd.push("--profile", launcherProfile);
        actionLog.push(
          `Added Codex profile override: --profile ${launcherProfile}`,
        );
      }
    } else if (agent === "pi" && launcherProfile) {
      let profileDir: string;
      try {
        const [dir, bootstrapped] = deps.ensureKeeperAgentPiProfileDirFn(
          launcherProfile,
          actionLog,
        );
        profileDir = dir;
        if (bootstrapped) {
          actionLog.push(`Bootstrapped Pi profile config: ${profileDir}`);
        }
      } catch (exc) {
        if (exc instanceof StateError) {
          deps.writeErr(`Error: ${exc.message}\n`);
          return deps.exit(1);
        }
        throw exc;
      }
      deps.env.PI_CODING_AGENT_DIR = profileDir;
      actionLog.push(`Set PI_CODING_AGENT_DIR=${profileDir}`);
    } else if (agent === "claude" && launcherProfile) {
      let profileDir: string;
      try {
        const trustPaths = [deps.cwd];
        const [dir, bootstrapped] = deps.ensureKeeperAgentProfileDirFn(
          launcherProfile,
          trustPaths,
          actionLog,
        );
        profileDir = dir;
        if (bootstrapped) {
          actionLog.push(`Bootstrapped profile config: ${profileDir}`);
        }
      } catch (exc) {
        if (exc instanceof StateError) {
          deps.writeErr(`Error: ${exc.message}\n`);
          return deps.exit(1);
        }
        throw exc;
      }
      deps.env.CLAUDE_CONFIG_DIR = profileDir;
      actionLog.push(`Set CLAUDE_CONFIG_DIR=${profileDir}`);
    }

    ptCmd.push(...remainingArgs);
    if (launcherVeryVerbose) {
      printVerbose(deps, actionLog, ptCmd.join(" "));
    }
    return runPassthrough(ptCmd, deps.spawn, deps.exit);
  }

  if (agent === "codex") {
    if (launcherProfile === "auto") {
      launcherProfile = "";
      actionLog.push("Using native Codex profile");
    }

    const runCmd = [bin];
    const defaults = codexWrapperDefaults(remainingArgs);
    runCmd.push(...defaults);
    if (defaults.includes("--dangerously-bypass-approvals-and-sandbox")) {
      actionLog.push("Added Codex full-access default");
    }
    if (defaults.includes("--search")) {
      actionLog.push("Added Codex live-search default");
    }

    if (launcherProfile && !hasExplicitCodexProfileArg(remainingArgs)) {
      runCmd.push("--profile", launcherProfile);
      actionLog.push(
        `Added Codex profile override: --profile ${launcherProfile}`,
      );
    }

    const { model: yamlModel, effort: yamlEffort } =
      deps.loadCodexLauncherDefaultsFn();
    // Per-field: preset layers OVER yaml (a model-only preset leaves effort
    // falling through to yaml). The resolver still gives explicit/env priority.
    const defaultModel = resolvedPreset?.model ?? yamlModel;
    const defaultEffort = resolvedPreset?.effort ?? yamlEffort;
    const startupModel = resolveCodexStartupModelOverride(
      remainingArgs,
      defaultModel,
    );
    const startupEffort = resolveCodexStartupEffortOverride(
      remainingArgs,
      defaultEffort,
    );
    if (startupModel !== null) {
      runCmd.push("--model", startupModel);
      actionLog.push(`Added startup model override: --model ${startupModel}`);
      note(`model: ${startupModel}`);
    }
    if (startupEffort !== null) {
      const effortConfig = codexEffortConfigArg(startupEffort);
      runCmd.push("-c", effortConfig);
      actionLog.push(`Added Codex effort override: -c ${effortConfig}`);
      note(`effort: ${startupEffort}`);
    }

    runCmd.push(...remainingArgs);
    const codexSessionName =
      launcherCodexSessionName ??
      resolveLaunchSessionName(remainingArgs, deps.cwd, deps.nextCwdOrdinalFn)
        .sessionName;
    note(`profile: ${launcherProfile || "default"}`);
    note(`session: ${codexSessionName}`);
    if (launcherCodexSessionName === null) {
      actionLog.push(
        `Derived Codex synthetic session-name: ${codexSessionName}`,
      );
    }
    actionLog.push(
      `Started Codex synthetic session-name indexer: ${codexSessionName}`,
    );

    if (launcherVeryVerbose) {
      printVerbose(deps, actionLog, formatCommand(runCmd));
    }

    deps.env[agentProfileEnvName(agent)] = launcherProfile || "default";

    if (sectionsOn) {
      deps.write("~ launching codex\n");
    }

    const codexHome = deps.env.CODEX_HOME || join(homedir(), ".codex");
    deps.startCodexSessionNameIndexerFn({
      codexHome,
      threadName: codexSessionName,
      expectedCwd: deps.cwd,
      startedAtMs: Date.now(),
    });

    return runWithJobControl(runCmd, deps.spawn, deps.exit);
  }

  if (agent === "claude") {
    // Reset permissions.allow if present and non-empty (fail-soft).
    const settingsPath = join(deps.cwd, ".claude", "settings.local.json");
    if (existsSync(settingsPath)) {
      try {
        const data = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
          string,
          unknown
        >;
        const permissions = data.permissions as
          | Record<string, unknown>
          | undefined;
        const allow = permissions?.allow;
        if (Array.isArray(allow) && allow.length > 0) {
          const allowCount = allow.length;
          (permissions as Record<string, unknown>).allow = [];
          writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`);
          actionLog.push(
            `Reset permissions.allow (${allowCount} entries cleared)`,
          );
        }
      } catch {
        // JSONDecodeError / missing key — fail-soft.
      }
    }
  }

  if (launcherProfile === "auto" && configuredProfiles.length === 1) {
    const forced = configuredProfiles[0] as string;
    const normalizedForced = normalizeKeeperAgentProfileArg(forced);
    launcherProfile = normalizedForced;
    actionLog.push(
      `Forced profile from config list: ${forced}` +
        (normalizedForced !== forced
          ? ` (normalized to default ${agentLabel} account)`
          : ""),
    );
  }

  if (launcherProfile === "auto") {
    const selected = phase(`auto-select ${agentLabel} profile`, () => {
      try {
        return deps.pickProfileFn();
      } catch {
        return DEFAULT_PROFILE;
      }
    });
    launcherProfile = normalizeKeeperAgentProfileArg(selected);
    actionLog.push(
      `Auto-selected ${agentLabel} profile: ${selected}` +
        (launcherProfile !== selected
          ? ` (normalized to default ${agentLabel} account)`
          : ""),
    );
  }

  const profileDir = phase(
    "link shared settings + profile dir",
    (): string | null => {
      if (!launcherProfile) {
        return null;
      }
      try {
        if (agent === "pi") {
          const [dir, bootstrapped] = deps.ensureKeeperAgentPiProfileDirFn(
            launcherProfile,
            actionLog,
          );
          if (bootstrapped) {
            actionLog.push(`Bootstrapped Pi profile config: ${dir}`);
          }
          return dir;
        }
        const trustPaths = [deps.cwd];
        const [dir, bootstrapped] = deps.ensureKeeperAgentProfileDirFn(
          launcherProfile,
          trustPaths,
          actionLog,
        );
        if (bootstrapped) {
          actionLog.push(`Bootstrapped profile config: ${dir}`);
        }
        return dir;
      } catch (exc) {
        if (exc instanceof StateError) {
          deps.writeErr(`Error: ${exc.message}\n`);
          return deps.exit(1);
        }
        throw exc;
      }
    },
  );
  note(`profile: ${launcherProfile || "default"}`);

  // Build agent command.
  const runCmd = [bin, ...remainingArgs];
  actionLog.push(`Built base ${agentLabel} command`);

  if (agent === "claude") {
    const { model: yamlModel, effort: yamlEffort } =
      deps.loadLauncherDefaultsFn();
    // Per-field: preset layers OVER yaml. resolveStartup*Override still encode
    // explicit > env > default, so the net order is explicit > env > preset >
    // yaml > native, per field with no new precedence machinery.
    const defaultModel = resolvedPreset?.model ?? yamlModel;
    const defaultEffort = resolvedPreset?.effort ?? yamlEffort;
    const startupModel = resolveStartupModelOverride(
      remainingArgs,
      defaultModel,
    );
    const startupEffort = resolveStartupEffortOverride(
      remainingArgs,
      defaultEffort,
      deps.env,
    );
    if (startupEffort !== null) {
      runCmd.push("--effort", startupEffort);
      actionLog.push(
        `Added startup effort override: --effort ${startupEffort}`,
      );
      note(`effort: ${startupEffort}`);
    }
    if (startupModel !== null) {
      runCmd.push("--model", startupModel);
      actionLog.push(`Added startup model override: --model ${startupModel}`);
      note(`model: ${startupModel}`);
    }

    runCmd.push("--strict-mcp-config");
    runCmd.push("--teammate-mode", "in-process");
    actionLog.push("Added --strict-mcp-config --teammate-mode in-process");
  } else {
    const { model: yamlModel, thinking: yamlThinking } =
      deps.loadPiLauncherDefaultsFn();
    // Per-field: preset layers OVER yaml (preset.thinking is pi-only).
    const defaultModel = resolvedPreset?.model ?? yamlModel;
    const defaultThinking = resolvedPreset?.thinking ?? yamlThinking;
    const startupThinking = resolveStartupThinkingOverride(
      remainingArgs,
      defaultThinking,
    );
    const startupModel = resolveStartupModelOverride(
      remainingArgs,
      defaultModel,
    );
    if (startupThinking !== null) {
      runCmd.push("--thinking", startupThinking);
      actionLog.push(
        `Added Pi thinking override: --thinking ${startupThinking}`,
      );
      note(`thinking: ${startupThinking}`);
    }
    if (startupModel !== null) {
      runCmd.push("--model", startupModel);
      actionLog.push(`Added startup model override: --model ${startupModel}`);
      note(`model: ${startupModel}`);
    }
  }

  // Generate session ID and name for new Claude/Pi sessions.
  let sessionUuid: string | null = null;
  const tmuxSessionUuid =
    (deps.env.KEEPER_AGENT_TMUX_SESSION_ID ?? "").trim() || null;
  if (!hasContinueOrResume && !hasFlagToken(remainingArgs, "--session-id")) {
    sessionUuid = tmuxSessionUuid ?? deps.randomUuid();
    runCmd.push("--session-id", sessionUuid);
    actionLog.push(
      tmuxSessionUuid === null
        ? `Generated session ID: ${sessionUuid}`
        : `Used tmux transport session ID: ${sessionUuid}`,
    );
  }
  if (tmuxSessionUuid !== null) {
    delete deps.env.KEEPER_AGENT_TMUX_SESSION_ID;
  }
  // A fresh launch OR a fork needs a fresh --name (a fork mints a new session
  // id; plain --resume/--continue keeps its persisted title and is excluded).
  const wantSessionName = sessionUuid !== null || hasForkSession;
  if (
    wantSessionName &&
    !remainingArgs.includes("-n") &&
    !hasFlagToken(remainingArgs, "--name")
  ) {
    const { sessionName, resolvedSlug } = resolveLaunchSessionName(
      remainingArgs,
      deps.cwd,
      deps.nextCwdOrdinalFn,
    );
    if (resolvedSlug) {
      actionLog.push(`Resolved session slug: ${resolvedSlug}`);
    } else {
      actionLog.push(`Used cwd-ordinal fallback: ${sessionName}`);
    }
    runCmd.push("--name", sessionName);
    actionLog.push(`Set session name: ${sessionName}`);
    note(`session: ${sessionName}`);
  }

  if (agent === "claude") {
    phase("discover plugin dirs", () => {
      let sources: ReturnType<typeof loadPluginSources>;
      try {
        sources = deps.loadPluginSourcesFn();
      } catch (exc) {
        if (exc instanceof ConfigError) {
          deps.writeErr(`Error: ${exc.message}\n`);
          return deps.exit(1);
        }
        throw exc;
      }
      try {
        const discovery = discoverPlugins(
          deps.cwd,
          sources,
          deps.pluginConfigPath,
        );
        runCmd.push(...discovery.args);
        actionLog.push(...discovery.actions);
      } catch (exc) {
        if (exc instanceof PluginError) {
          deps.writeErr(`${exc.stderrMessage}\n`);
          return deps.exit(1);
        }
        throw exc;
      }
    });
  }

  if (agent === "claude" && (deps.env.TMUX ?? "") !== "") {
    actionLog.push("Detected tmux environment");
    // Strip tmux env from the child so Claude's ink2 renderer emits truecolor:
    // it hard-caps itself to 256-color whenever $TMUX is set. Carry the pane id
    // to keeper's carrier var FIRST so keeper's events-writer hook can still
    // stamp tmux coords (its native arm keys off $TMUX, which we delete here).
    // KEEPER_TMUX_PANE must match the literal read in ~/code/keeper/src/
    // exec-backend.ts (paneIdCarrierEnvVar) — keep both sides in sync (drift guard).
    const pane = deps.env.TMUX_PANE ?? "";
    if (pane !== "") {
      deps.env.KEEPER_TMUX_PANE = pane;
      actionLog.push(`Carried tmux pane to KEEPER_TMUX_PANE=${pane}`);
    }
    // This mutation reaches Claude only because defaultSpawn (run.ts) spawns
    // with `env: { ...process.env }`. Bun's inherit-mode spawn ignores
    // `delete process.env.X` (it hands the child the original OS environ), so
    // run.ts MUST materialize the mutated env. deps.env === process.env, so the
    // deletes below land on the object run.ts spreads. Keep that spread; never
    // switch run.ts back to inherit-mode or this strip silently no-ops and
    // Claude keeps $TMUX → caps to 256-color.
    delete deps.env.TMUX;
    delete deps.env.TMUX_PANE;
    actionLog.push("Stripped TMUX/TMUX_PANE for truecolor");
  }

  if (agent === "claude") {
    scrubInheritedClaudeSessionEnv(deps.env, actionLog);
  }

  if (launcherVeryVerbose) {
    printVerbose(deps, actionLog, formatCommand(runCmd));
  }

  // Profile auth — export the agent-native profile selector/config dir.
  if (profileDir) {
    if (agent === "pi") {
      deps.env.PI_CODING_AGENT_DIR = profileDir;
      actionLog.push(`Set PI_CODING_AGENT_DIR=${profileDir}`);
    } else {
      deps.env.CLAUDE_CONFIG_DIR = profileDir;
      actionLog.push(`Set CLAUDE_CONFIG_DIR=${profileDir}`);
    }
  }
  deps.env[agentProfileEnvName(agent)] = launcherProfile || "default";
  if (agent === "claude") {
    deps.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  if (sectionsOn) {
    deps.write(`~ launching ${agent}\n`);
  }

  return runWithJobControl(runCmd, deps.spawn, deps.exit);
}

function safeList(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Resolve the launcher's display session name once, using a prompt slug when
 * available and the cwd ordinal fallback otherwise. Claude and Pi turn that
 * into `--name`; Codex feeds the same resolved name into its synthetic thread
 * index.
 */
function resolveLaunchSessionName(
  remainingArgs: string[],
  cwd: string,
  nextCwdOrdinalFn: (dirName: string) => number,
): { sessionName: string; resolvedSlug: string | null } {
  const dirName = basename(cwd);
  const promptText = extractPromptText(remainingArgs);
  const resolvedSlug = resolveSessionSlug(promptText ?? "");
  if (resolvedSlug) {
    return { sessionName: resolvedSlug, resolvedSlug };
  }
  const ordinal = nextCwdOrdinalFn(dirName);
  return {
    sessionName: `${dirName}-${String(ordinal).padStart(3, "0")}`,
    resolvedSlug: null,
  };
}
