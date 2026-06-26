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
import { DEFAULT_PROFILE, listProfiles, pickProfile } from "../usage-picker";
import { normalizeAgentwrapProfileArg, parseArgsForAgent } from "./args";
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
  loadPiLauncherDefaults,
  loadPluginSources,
  loadPresetRegistry,
  type PiLauncherDefaults,
  type PluginSources,
  type Preset,
  type PresetRegistry,
  pluginConfigPath,
  resolvePreset,
} from "./config";
import { checkCwdInProjectRoot } from "./cwd-confirm";
import { nextCwdOrdinal } from "./cwd-ordinal";
import {
  AGENTWRAP_HELP,
  type AgentKind,
  hasAgentwrapHelpFlag,
  type SubcommandKind,
  splitSubcommand,
  USAGE,
  VERSION,
} from "./dispatch";
import {
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
import { extractPromptText, resolveSessionSlug } from "./session-name";
import {
  ensureAgentwrapPiProfileDir,
  ensureAgentwrapProfileDir,
  ensureClaudeStateSharing,
  ensurePiStateSharing,
  StateError,
} from "./state-sharing";
import {
  defaultAgentwrapStateDir,
  defaultTmuxCommandRunner,
  launchAgentwrapInTmux,
  parseAgentwrapTmuxArgs,
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
   * Read the named-preset registry from `presets.yaml`. Producer-side launch
   * config only — never a fold input; re-parsed per dispatch (no watcher) so an
   * edit lands without a daemon bounce.
   */
  loadPresetRegistryFn: () => PresetRegistry;
  ensureClaudeStateSharingFn: (
    listProfilesFn: () => string[],
    actionLog: string[],
    claudeStowDir: string | null,
  ) => void;
  ensureAgentwrapProfileDirFn: (
    profileName: string,
    trustPaths: string[] | null,
    actionLog: string[] | null,
  ) => [string, boolean];
  ensurePiStateSharingFn: (
    listProfilesFn: () => string[],
    actionLog: string[],
  ) => void;
  ensureAgentwrapPiProfileDirFn: (
    profileName: string,
    actionLog: string[] | null,
  ) => [string, boolean];
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
  agentwrapStateDir: string;
  transcriptHomeDir: string;
  runTmuxCommandFn: TmuxCommandRunner;
}

/** Production deps — the real collaborators. */
export function realDeps(): MainDeps {
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
    loadPresetRegistryFn: loadPresetRegistry,
    ensureClaudeStateSharingFn: (listProfilesFn, actionLog, claudeStowDir) =>
      ensureClaudeStateSharing(
        listProfilesFn,
        actionLog,
        homedir(),
        claudeStowDir,
      ),
    ensureAgentwrapProfileDirFn: ensureAgentwrapProfileDir,
    ensurePiStateSharingFn: (listProfilesFn, actionLog) =>
      ensurePiStateSharing(listProfilesFn, actionLog, homedir()),
    ensureAgentwrapPiProfileDirFn: (profileName, actionLog) =>
      ensureAgentwrapPiProfileDir(profileName, actionLog, homedir()),
    startCodexSessionNameIndexerFn: startCodexSessionNameIndexer,
    tmuxBin: resolveTmuxBin(process.env),
    launcherArgvPrefix: buildLauncherArgvPrefix(
      process.execPath,
      resolveKeeperAgentPathDepFree(),
    ),
    agentwrapStateDir: defaultAgentwrapStateDir(process.env),
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
    return "AGENTWRAP_CLAUDE_PROFILE";
  }
  if (agent === "codex") {
    return "AGENTWRAP_CODEX_PROFILE";
  }
  return "AGENTWRAP_PI_PROFILE";
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
 * into the pane via the `-e AGENTWRAP_TMUX_SESSION_ID` carrier, and consumed by
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
    stateDir: deps.agentwrapStateDir,
  });
  if (!resolution.ok) {
    deps.writeErr(`agentwrap: ${resolution.error}\n`);
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

/**
 * `presets resolve <name>`: emit the resolved launch-config JSON to stdout. A
 * name matching a single preset emits `{kind:"preset", name, harness, model,
 * effort, thinking, role}` (absent fields null); a name matching a panel emits
 * `{kind:"panel", name, members:[{name, harness}, ...]}` in declaration order,
 * validating each member is pair-launchable (claude|codex) and failing loud if a
 * member pins pi. A `kind` discriminator pins the contract task 4's panel SKILL
 * parses with jq. A name matching neither is fail-loud (exit 2).
 */
function runPresetsResolve(deps: MainDeps, name: string): never {
  let registry: PresetRegistry;
  try {
    registry = deps.loadPresetRegistryFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  const panelMembers = registry.panels[name];
  if (panelMembers !== undefined) {
    const members: { name: string; harness: string }[] = [];
    for (const memberName of panelMembers) {
      // Load-time validation already guarantees the member resolves.
      const preset = registry.presets[memberName] as Preset;
      if (preset.harness === "pi") {
        deps.writeErr(
          `Error: panel '${name}' member '${memberName}' pins harness pi, ` +
            "which is not pair-launchable (claude|codex only).\n",
        );
        return deps.exit(2);
      }
      members.push({ name: memberName, harness: preset.harness });
    }
    deps.write(`${JSON.stringify({ kind: "panel", name, members })}\n`);
    return deps.exit(0);
  }

  let preset: Preset;
  try {
    preset = resolvePreset(registry, name);
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }
  deps.write(
    `${JSON.stringify({
      kind: "preset",
      name,
      harness: preset.harness,
      model: preset.model,
      effort: preset.effort,
      thinking: preset.thinking,
      role: preset.role,
    })}\n`,
  );
  return deps.exit(0);
}

export async function main(deps: MainDeps): Promise<never> {
  const actionLog: string[] = [];

  // Subcommand dispatch pre-pass: classify the leading argv token before any
  // wrapper logic. This MUST precede parseArgs and passthrough detection — an
  // unstripped leading agent name would fall through the passthrough scan and
  // become a prompt arg. `run` continues the launcher flow with the remaining
  // args; help/version/usage print + exit through the deps seams.
  const dispatch = splitSubcommand(deps.argv);
  if (dispatch.kind === "help") {
    deps.write(USAGE);
    return deps.exit(0);
  }
  if (dispatch.kind === "help-wrapper") {
    deps.write(AGENTWRAP_HELP);
    return deps.exit(0);
  }
  if (dispatch.kind === "version") {
    deps.write(VERSION);
    return deps.exit(0);
  }
  if (dispatch.kind === "usage") {
    if (dispatch.unknown !== undefined) {
      deps.writeErr(`agentwrap: unknown subcommand '${dispatch.unknown}'\n`);
    }
    deps.writeErr(USAGE);
    return deps.exit(2);
  }
  if (dispatch.kind === "subcommand") {
    return runTranscriptSubcommand(deps, dispatch.verb, dispatch.rest);
  }
  if (dispatch.kind === "presets-resolve") {
    return runPresetsResolve(deps, dispatch.presetName);
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
      preset = resolvePreset(deps.loadPresetRegistryFn(), dispatch.presetName);
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
  // detection, and launch — `agentwrap <agent> --agentwrap-help` prints the
  // overlay help and exits without reaching the native agent. Native `--help`
  // carries no `--agentwrap-help` token, so it still passes through unchanged.
  if (hasAgentwrapHelpFlag(argv)) {
    deps.write(AGENTWRAP_HELP);
    return deps.exit(0);
  }

  const tmuxLaunch = parseAgentwrapTmuxArgs(argv);
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`agentwrap: ${tmuxLaunch.error}\n`);
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
      const result = launchAgentwrapInTmux({
        agent,
        innerArgs: tmuxLaunch.remainingArgs,
        options: tmuxLaunch.options,
        env: deps.env,
        cwd: deps.cwd,
        transcriptSessionId,
        startedAtMs,
        stateDir: deps.agentwrapStateDir,
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
  const { agentwrapVerbose, agentwrapVeryVerbose, agentwrapNoConfirm } = parsed;
  const { agentwrapCodexSessionName } = parsed;
  let { agentwrapProfile, explicitAgentwrapProfile } = parsed;

  // Named preset resolution: the `--agentwrap-preset` flag (or the harnessless
  // head, already mirrored onto parsed.agentwrapPreset). Resolve it once here so
  // its model/effort/thinking can layer into the resolver default slots BELOW
  // the explicit-flag / effort-env precedence. A head agent disagreeing with the
  // preset's harness is fail-loud — never silently re-route the launch.
  const presetName = parsed.agentwrapPreset ?? dispatchPresetName;
  let resolvedPreset: Preset | null = null;
  if (presetName !== null) {
    try {
      resolvedPreset = resolvePreset(deps.loadPresetRegistryFn(), presetName);
    } catch (exc) {
      if (exc instanceof ConfigError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(2);
      }
      throw exc;
    }
    if (dispatch.kind === "run" && resolvedPreset.harness !== agent) {
      deps.writeErr(
        `Error: --agentwrap-preset ${presetName} pins harness ` +
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
  if (agentwrapNoConfirm) {
    actionLog.push(
      "Parsed --agentwrap-no-confirm: cwd confirmation suppressed",
    );
  }
  if (agentwrapCodexSessionName !== null) {
    actionLog.push(
      `Parsed --agentwrap-codex-session-name: ${agentwrapCodexSessionName}`,
    );
  }

  if (!explicitAgentwrapProfile) {
    const envProfile = (deps.env.AGENTWRAP_PROFILE ?? "").trim();
    if (envProfile && envProfile !== "auto") {
      agentwrapProfile = envProfile;
      explicitAgentwrapProfile = true;
      actionLog.push(
        `Forced profile from AGENTWRAP_PROFILE env: ${envProfile}`,
      );
    }
  }

  if (explicitAgentwrapProfile && agentwrapProfile) {
    actionLog.push(`Parsed --agentwrap-profile: ${agentwrapProfile}`);
    if (agentwrapProfile !== "auto") {
      const normalized = normalizeAgentwrapProfileArg(agentwrapProfile);
      if (normalized !== agentwrapProfile) {
        actionLog.push(
          `Normalized --agentwrap-profile default to native ${agentLabel} account`,
        );
      }
      agentwrapProfile = normalized;
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
  // level 1 (--agentwrap-verbose) prints one line per startup section; level 2
  // (--agentwrap-very-verbose, which implies level 1) adds per-phase timing plus
  // the full action log and composed command. --print/passthrough force clean
  // stdout, so section lines never appear there regardless of level.
  const verbose = agentwrapVerbose || agentwrapVeryVerbose;
  const chattyQuiet = hasPrint || shouldPassthrough;
  const sectionsOn = verbose && !chattyQuiet;
  const phase = makePhaser(!sectionsOn, deps.write, agentwrapVeryVerbose);
  const note = (msg: string): void => {
    if (sectionsOn) {
      deps.write(`~ ${msg}\n`);
    }
  };

  let configuredProfiles: string[] = [];
  if (agent !== "codex" && !shouldPassthrough) {
    configuredProfiles = safeList(deps.listProfilesFn);
  }

  if (!shouldPassthrough && !hasPrint && !agentwrapNoConfirm) {
    phase("check cwd is a project dir", () => {
      checkCwdInProjectRoot(
        actionLog,
        deps.readChar,
        deps.exit,
        deps.write,
        deps.env,
      );
    });
  } else if (agentwrapNoConfirm && !shouldPassthrough && !hasPrint) {
    actionLog.push(
      "Skipped cwd confirmation (--agentwrap-no-confirm): " +
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

  if (shouldPassthrough && agentwrapProfile === "auto") {
    agentwrapProfile = "";
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
    if (agent === "codex" && agentwrapProfile) {
      if (!hasExplicitCodexProfileArg(remainingArgs)) {
        ptCmd.push("--profile", agentwrapProfile);
        actionLog.push(
          `Added Codex profile override: --profile ${agentwrapProfile}`,
        );
      }
    } else if (agent === "pi" && agentwrapProfile) {
      let profileDir: string;
      try {
        const [dir, bootstrapped] = deps.ensureAgentwrapPiProfileDirFn(
          agentwrapProfile,
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
    } else if (agent === "claude" && agentwrapProfile) {
      let profileDir: string;
      try {
        const trustPaths = [deps.cwd];
        const [dir, bootstrapped] = deps.ensureAgentwrapProfileDirFn(
          agentwrapProfile,
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
    if (agentwrapVeryVerbose) {
      printVerbose(deps, actionLog, ptCmd.join(" "));
    }
    return runPassthrough(ptCmd, deps.spawn, deps.exit);
  }

  if (agent === "codex") {
    if (agentwrapProfile === "auto") {
      agentwrapProfile = "";
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

    if (agentwrapProfile && !hasExplicitCodexProfileArg(remainingArgs)) {
      runCmd.push("--profile", agentwrapProfile);
      actionLog.push(
        `Added Codex profile override: --profile ${agentwrapProfile}`,
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
      agentwrapCodexSessionName ??
      resolveLaunchSessionName(remainingArgs, deps.cwd, deps.nextCwdOrdinalFn)
        .sessionName;
    note(`profile: ${agentwrapProfile || "default"}`);
    note(`session: ${codexSessionName}`);
    if (agentwrapCodexSessionName === null) {
      actionLog.push(
        `Derived Codex synthetic session-name: ${codexSessionName}`,
      );
    }
    actionLog.push(
      `Started Codex synthetic session-name indexer: ${codexSessionName}`,
    );

    if (agentwrapVeryVerbose) {
      printVerbose(deps, actionLog, formatCommand(runCmd));
    }

    deps.env[agentProfileEnvName(agent)] = agentwrapProfile || "default";

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

  if (agentwrapProfile === "auto" && configuredProfiles.length === 1) {
    const forced = configuredProfiles[0] as string;
    const normalizedForced = normalizeAgentwrapProfileArg(forced);
    agentwrapProfile = normalizedForced;
    actionLog.push(
      `Forced profile from config list: ${forced}` +
        (normalizedForced !== forced
          ? ` (normalized to default ${agentLabel} account)`
          : ""),
    );
  }

  if (agentwrapProfile === "auto") {
    const selected = phase(`auto-select ${agentLabel} profile`, () => {
      try {
        return deps.pickProfileFn();
      } catch {
        return DEFAULT_PROFILE;
      }
    });
    agentwrapProfile = normalizeAgentwrapProfileArg(selected);
    actionLog.push(
      `Auto-selected ${agentLabel} profile: ${selected}` +
        (agentwrapProfile !== selected
          ? ` (normalized to default ${agentLabel} account)`
          : ""),
    );
  }

  const profileDir = phase(
    "link shared settings + profile dir",
    (): string | null => {
      if (!agentwrapProfile) {
        return null;
      }
      try {
        if (agent === "pi") {
          const [dir, bootstrapped] = deps.ensureAgentwrapPiProfileDirFn(
            agentwrapProfile,
            actionLog,
          );
          if (bootstrapped) {
            actionLog.push(`Bootstrapped Pi profile config: ${dir}`);
          }
          return dir;
        }
        const trustPaths = [deps.cwd];
        const [dir, bootstrapped] = deps.ensureAgentwrapProfileDirFn(
          agentwrapProfile,
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
  note(`profile: ${agentwrapProfile || "default"}`);

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
    (deps.env.AGENTWRAP_TMUX_SESSION_ID ?? "").trim() || null;
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
    delete deps.env.AGENTWRAP_TMUX_SESSION_ID;
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

  if (agentwrapVeryVerbose) {
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
  deps.env[agentProfileEnvName(agent)] = agentwrapProfile || "default";
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
