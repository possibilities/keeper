/**
 * main() assembly — the launcher control flow, wiring the pure modules, the
 * state layer, and the process layer. Side-effecting collaborators (spawn, the
 * keystroke read, profile listing/picking, exit) are injected via `MainDeps` so
 * the whole flow is testable against a fake agent and a recording spawn.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import {
  type BirthRecordDraft,
  buildBirthDraft,
  emitBirthRecord,
} from "../birth-record";
import { ensureCodexDirTrust } from "../codex-trust";
import { isDefaultTmuxEnvValue } from "../exec-backend";
import { ensureHermesShimTrust } from "../hermes-trust";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "../keeper-agent-path";
import { runPanel } from "../pair/panel";
import { DEFAULT_PROFILE, listProfiles, pickProfile } from "../usage-picker";
import { normalizeKeeperAgentProfileArg, parseArgsForAgent } from "./args";
import {
  type CodexSessionNameIndexerOptions,
  codexSessionIdFromRolloutPath,
  startCodexSessionNameIndexer,
} from "./codex-session-index";
import {
  ConfigError,
  loadPanelSelections,
  loadPluginSources,
  loadPresetCatalog,
  type PanelSelections,
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
  KEEPER_AGENT_RUNBOOK,
  type SubcommandKind,
  splitSubcommand,
  USAGE,
  VERSION,
} from "./dispatch";
import {
  HARNESS_DESCRIPTORS,
  type HarnessName,
  mapKeeperEffortToAxis,
} from "./harness";
import {
  FINAL_MESSAGE_DIRECTIVE,
  piExtensionArgs,
  READ_ONLY_DIRECTIVE,
} from "./launch-config";
import {
  type LaunchHandleDeps,
  launchToResolvedHandle,
  tmuxTranscriptSessionId,
} from "./launch-handle";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STOP_TIMEOUT_MS,
  isValidMatrixToken,
  loadMatrix,
  type Matrix,
  matrixConfigPath,
  presetNameFor,
  providerCheckFindings,
  type ResolveResult,
  resolveModel,
} from "./matrix";
import {
  resolveHandle,
  runShowLastMessage,
  runWaitForStop,
  type VerbDeps,
} from "./pair-subcommands";
import {
  findCodexPassthroughCommand,
  findHermesPassthroughCommand,
  findPassthroughCommand,
  findPiPassthroughCommand,
  hasExplicitCodexEffortArg,
  hasExplicitCodexModelArg,
  hasExplicitCodexProfileArg,
  hasExplicitEffortArg,
  hasExplicitModelArg,
  hasExplicitThinkingArg,
  piModelColonThinking,
  resolveStartupEffortOverride,
  resolveStartupModelOverride,
  resolveStartupThinkingOverride,
} from "./passthrough";
import { makePhaser } from "./phaser";
import { discoverPlugins, PluginError } from "./plugins";
import {
  type ChildSpawnedFn,
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
  type RunCaptureEnvelope,
  type RunCaptureResult,
} from "./run-capture";
import { extractPromptText, resolveSessionSlug } from "./session-name";
import {
  findShadowProfileDirs,
  type ShadowProfileAgent,
  type ShadowProfileFinding,
} from "./shadow-profiles";
import {
  defaultClaudeStowDir,
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
  hermesBin: string;
  pluginConfigPath: string;
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
  /**
   * Read the host provider matrix from `matrix.yaml`; null when absent (the
   * caller falls back to claude-only embedded defaults). Producer-side launch
   * config, re-parsed per call, never a fold input. Injected so the `providers`
   * verbs are testable against fixture matrices without a real `~/.config`.
   */
  loadMatrixFn: () => Matrix | null;
  /**
   * True when a roster provider's harness binary is reachable on PATH — the
   * `providers check` reachability probe. HOME/PATH-coupled, so a seam;
   * `realDeps()` binds it against the resolved per-harness bins.
   */
  providerReachableFn: (harness: HarnessName) => boolean;
  startCodexSessionNameIndexerFn: (
    opts: CodexSessionNameIndexerOptions,
  ) => () => void;
  /**
   * Emit a birth record for a freshly-spawned non-claude harness child (codex /
   * pi / hermes): probe the child's platform-tagged start_time and atomically
   * write the maildir record the ingest worker turns into a synthetic
   * SessionStart. Fail-open — a write failure degrades to presence-only. Injected
   * so the launcher wiring is testable without a real fs write or `ps` fork;
   * `realDeps()` binds the real {@link emitBirthRecord}. Claude launches never
   * call it (its hook SessionStart is the authoritative presence + resume seed).
   */
  emitBirthRecord: (draft: BirthRecordDraft, pid: number) => void;
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
  /**
   * Resolve the keeper plugin-owned Claude settings file that carries the
   * statusLine command, or null to skip the fail-open injection. A seam keeps
   * byte-pin tests path-independent.
   */
  resolveStatuslineSettingsPathFn: () => string | null;
  /**
   * The pi native flags that arm keeper's ephemeral in-process extension
   * (`["-e", <path>]`, or `[]` when the extension file is absent). Injected into
   * every managed pi launch so pi shows live working/stopped churn; a seam so the
   * byte-pin harness fixes the flags without depending on the real repo path.
   * `realDeps()` binds it to {@link piExtensionArgs} (fail-open existence check).
   */
  resolvePiExtensionArgsFn: () => string[];
}

/** Production deps — the real collaborators. */
export function realDeps(): MainDeps {
  // Relocate the legacy launcher state dir before the launcher's tmux-runs/
  // mkdir reads launcherStateDir (a launch with an explicit --name never hits
  // the cwd-ordinal chokepoint, so this surface must migrate too).
  migrateLegacyAgentStateDir();
  const bins: Record<HarnessName, string> = {
    claude: join(homedir(), ".local", "bin", "claude"),
    codex: resolveCodexBin(process.env),
    pi: "pi",
    hermes: resolveHermesBin(),
  };
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
    claudeBin: bins.claude,
    codexBin: bins.codex,
    piBin: bins.pi,
    hermesBin: bins.hermes,
    pluginConfigPath: pluginConfigPath(),
    loadPluginSourcesFn: loadPluginSources,
    loadPresetCatalogFn: loadPresetCatalog,
    loadPanelSelectionsFn: (catalog) => loadPanelSelections(catalog),
    ensureClaudeStateSharingFn: (listProfilesFn, actionLog) =>
      ensureClaudeStateSharing(
        listProfilesFn,
        actionLog,
        homedir(),
        defaultClaudeStowDir(),
      ),
    ensureKeeperAgentProfileDirFn: ensureKeeperAgentProfileDir,
    ensurePiStateSharingFn: (listProfilesFn, actionLog) =>
      ensurePiStateSharing(listProfilesFn, actionLog, homedir()),
    ensureKeeperAgentPiProfileDirFn: (profileName, actionLog) =>
      ensureKeeperAgentPiProfileDir(profileName, actionLog, homedir()),
    findShadowProfileDirsFn: () =>
      findShadowProfileDirs(listProfiles, homedir()),
    loadMatrixFn: loadMatrix,
    providerReachableFn: (harness) => isBinaryReachable(bins[harness]),
    startCodexSessionNameIndexerFn: startCodexSessionNameIndexer,
    emitBirthRecord: (draft, pid) => emitBirthRecord(process.env, draft, pid),
    tmuxBin: resolveTmuxBin(process.env),
    launcherArgvPrefix: buildLauncherArgvPrefix(
      process.execPath,
      resolveKeeperAgentPathDepFree(),
    ),
    launcherStateDir: defaultKeeperAgentStateDir(process.env),
    transcriptHomeDir: homedir(),
    runTmuxCommandFn: defaultTmuxCommandRunner,
    resolveStatuslineSettingsPathFn: resolveKeeperPluginStatuslineSettingsPath,
    resolvePiExtensionArgsFn: () => piExtensionArgs(),
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
 * Resolve the hermes binary: the canonical `~/.local/bin/hermes` install path
 * when present + executable, else the bare `hermes` name (PATH fallback). Mirrors
 * the binary-before-config ordering — a machine without the install path still
 * launches if `hermes` is on PATH.
 */
function resolveHermesBin(): string {
  const installed = join(homedir(), ".local", "bin", "hermes");
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return "hermes";
  }
}

/**
 * True when a resolved harness binary is reachable + executable — the
 * `providers check` reachability probe. An absolute path is X_OK-tested directly;
 * a bare name is searched across PATH. Any access failure reads as unreachable.
 */
function isBinaryReachable(bin: string): boolean {
  try {
    if (isAbsolute(bin)) {
      accessSync(bin, constants.X_OK);
      return true;
    }
  } catch {
    return false;
  }
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(pathEntry || ".", bin), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

/**
 * Run `hermes sessions export --source cli -` and return its JSONL text, or null
 * on any failure. The hermes M2 capture seam ({@link runHermesSessionsExport} is
 * bound onto {@link VerbDeps.hermesExport} for the wait/show verbs). `--source cli`
 * bounds the export to keeper's own one-shot launches (`source: cli`); reading is
 * strictly read-only. A non-zero exit / spawn error / empty stdout → null so the
 * poll loop keeps trying and fails to `no_transcript`, never hangs. Production
 * only — tests inject a fixture seam, so this subprocess never runs under test.
 */
function runHermesSessionsExport(
  hermesBin: string,
  env: NodeJS.ProcessEnv,
): string | null {
  try {
    const result = spawnSync(
      hermesBin,
      ["sessions", "export", "--source", "cli", "-"],
      { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    return result.stdout.trim() === "" ? null : result.stdout;
  } catch {
    return null;
  }
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
  return HARNESS_DESCRIPTORS[agent].displayName;
}

function agentProfileEnvName(agent: AgentKind): string {
  return HARNESS_DESCRIPTORS[agent].profileEnvVar;
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
  if (agent === "hermes") {
    return findHermesPassthroughCommand(args);
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

/**
 * Whether a launch supplied its model + effort/thinking explicitly (the
 * both-explicit escape from the fresh-launch default gate). Per harness: claude
 * counts `--effort` OR the `CLAUDE_CODE_EFFORT_LEVEL` env; codex counts `-c
 * model_reasoning_effort=`, and a `--profile` exempts the whole launch (the
 * profile is the model/effort source); pi counts `--thinking` OR the
 * `--model <id>:<thinking>` colon shorthand.
 */
interface LaunchConfigSignals {
  model: boolean;
  effortOrThinking: boolean;
  exemptAll: boolean;
}

function resolveLaunchConfigSignals(
  agent: AgentKind,
  args: string[],
  env: NodeJS.ProcessEnv,
): LaunchConfigSignals {
  if (agent === "codex") {
    return {
      model: hasExplicitCodexModelArg(args),
      effortOrThinking: hasExplicitCodexEffortArg(args),
      exemptAll: hasExplicitCodexProfileArg(args),
    };
  }
  if (agent === "hermes") {
    // Model-only: hermes shares codex's `-m`/`--model` spelling and exposes no
    // second axis, so `effortOrThinking` is trivially satisfied (readiness rests
    // on the model alone via the descriptor-driven core).
    return {
      model: hasExplicitCodexModelArg(args),
      effortOrThinking: true,
      exemptAll: false,
    };
  }
  if (agent === "pi") {
    const colon = piModelColonThinking(args) !== null;
    return {
      model: hasExplicitModelArg(args) || colon,
      effortOrThinking: hasExplicitThinkingArg(args) || colon,
      exemptAll: false,
    };
  }
  return {
    model: hasExplicitModelArg(args),
    effortOrThinking:
      hasExplicitEffortArg(args) ||
      (env.CLAUDE_CODE_EFFORT_LEVEL ?? "").trim() !== "",
    exemptAll: false,
  };
}

/**
 * The self-healing fresh-launch fail-loud message — names the exact
 * `<harness>_default` key to set AND the flag alternative, never the resolution
 * order. keeper no longer silently defers to the agent's native model/effort.
 */
function unresolvedDefaultMessage(agent: AgentKind): string {
  const key = `${agent}_default`;
  if (agent === "codex") {
    return (
      `Error: keeper agent codex: no model/effort resolved for a fresh launch. ` +
      `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
      `or pass --model <model> -c model_reasoning_effort=<effort> ` +
      `(or --profile <profile>).\n`
    );
  }
  if (agent === "pi") {
    return (
      `Error: keeper agent pi: no model/thinking resolved for a fresh launch. ` +
      `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
      `or pass --model <model> --thinking <thinking> ` +
      `(or --model <model>:<thinking>).\n`
    );
  }
  if (agent === "hermes") {
    return (
      `Error: keeper agent hermes: no model resolved for a fresh launch. ` +
      `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
      `or pass -m <model> (hermes is model-only — no effort/thinking).\n`
    );
  }
  return (
    `Error: keeper agent claude: no model/effort resolved for a fresh launch. ` +
    `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
    `or pass --model <model> --effort <effort>.\n`
  );
}

/** The `<harness>_default` pointer for a harness — the preset a bare
 *  `keeper agent <harness>` resolves. Keyed per harness so a new harness's default
 *  never silently falls through to another's. */
function harnessDefaultName(
  agent: AgentKind,
  catalog: PresetCatalog,
): string | null {
  switch (agent) {
    case "claude":
      return catalog.claude_default ?? null;
    case "codex":
      return catalog.codex_default ?? null;
    case "pi":
      return catalog.pi_default ?? null;
    case "hermes":
      return catalog.hermes_default ?? null;
  }
}

/**
 * The shared fresh-launch readiness core both gates route through: does the
 * RESOLVED preset (plus any explicit-flag `signals`) supply BOTH a model and the
 * harness's correct SECOND AXIS — `effort` for claude/codex, `thinking` for pi?
 * Pure; each gate keeps its OWN emission contract (the run path emits its
 * bad_args envelope, the launcher path keeps its exit-2 fail-loud message). A
 * null `preset` means no default resolved, so readiness rests entirely on the
 * flags. The both-explicit / profile-exempt escape is the caller's to short-
 * circuit before calling this — a caller in the both-explicit branch never asks.
 */
function resolveLaunchReadiness(
  agent: AgentKind,
  preset: Preset | null,
  signals: LaunchConfigSignals,
): boolean {
  const modelResolved = (preset?.model ?? null) !== null || signals.model;
  // A model-only harness (hermes, `secondAxis: "none"`) needs no second axis —
  // the model alone makes it ready. The axis is descriptor-driven, never a
  // harness-name literal.
  const axis = HARNESS_DESCRIPTORS[agent].secondAxis;
  if (axis === "none") {
    return modelResolved;
  }
  const second =
    axis === "thinking" ? (preset?.thinking ?? null) : (preset?.effort ?? null);
  const secondResolved = second !== null || signals.effortOrThinking;
  return modelResolved && secondResolved;
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

/**
 * The no-approval posture keeper prepends for a hermes launch: `--yolo` unless the
 * caller already set an explicit posture (`--yolo` or `--safe-mode`). Paired with
 * the `HERMES_ACCEPT_HOOKS=1` pane env (set at launch) so a detached one-shot never
 * stalls on an approval or a first-use hook-consent prompt.
 */
function hermesWrapperDefaults(args: string[]): string[] {
  if (args.includes("--yolo") || args.includes("--safe-mode")) {
    return [];
  }
  return ["--yolo"];
}

/** Return the plugin-owned statusLine settings file, or null fail-open. */
export function resolveKeeperPluginStatuslineSettingsPath(): string | null {
  const path = join(
    dirname(dirname(import.meta.dir)),
    "plugins",
    "keeper",
    "settings.json",
  );
  return existsSync(path) ? path : null;
}

/** The hermes model override, or null to leave it to the caller. An explicit
 *  `-m`/`--model` (hermes shares codex's model-flag spelling) wins over the
 *  preset/hermes_default. */
function resolveHermesStartupModelOverride(
  args: string[],
  defaultModel: string | null,
): string | null {
  if (hasExplicitCodexModelArg(args)) {
    return null;
  }
  return defaultModel;
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
  const verbDeps = makeVerbDeps(deps);

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

/** The transcript-verb deps shared by wait-for-stop / show-last-message / the
 *  run-capture compose — the env + home for the file-transcript agents, plus the
 *  hermes export seam (a bounded `hermes sessions export` subprocess) its
 *  store-based capture polls. */
function makeVerbDeps(deps: MainDeps): VerbDeps {
  return {
    env: deps.env,
    homeDir: deps.transcriptHomeDir,
    hermesExport: () => runHermesSessionsExport(deps.hermesBin, deps.env),
  };
}

/** The wait/show/clock seams the run-capture compose drives, bound to the
 *  production primitives + the injected clock. */
function runCaptureSeams(deps: MainDeps): RunCaptureDeps {
  return {
    waitForStop: runWaitForStop,
    showLastMessage: runShowLastMessage,
    now: deps.now,
    resolveCodexResumeTarget: ({ transcriptPath }) =>
      codexSessionIdFromRolloutPath(transcriptPath),
  };
}

/** The launch-seam effect deps the shared launch→handle helper drives, bound to
 *  the production launcher collaborators. */
function launchHandleDeps(deps: MainDeps): LaunchHandleDeps {
  return {
    env: deps.env,
    cwd: deps.cwd,
    tmuxBin: deps.tmuxBin,
    launcherStateDir: deps.launcherStateDir,
    launcherArgvPrefix: deps.launcherArgvPrefix,
    randomUuid: deps.randomUuid,
    runTmuxCommand: deps.runTmuxCommandFn,
    ensureCodexDirTrust,
    ensureHermesShimTrust,
    now: deps.now,
    writeErr: deps.writeErr,
  };
}

/**
 * Emit the run-capture envelope as exactly ONE JSON line on stdout, then exit
 * with the outcome's code. JSON-ONLY on stdout (no bare-text prelude like
 * show-last-message) — every diagnostic already went to stderr, so a programmatic
 * caller parses stdout cleanly.
 *
 * When `outputPath` is set (`agent run --output`), the SAME envelope is ALSO
 * written there ATOMICALLY (temp-in-same-dir + rename) — an additional sink for
 * detached-leg pollers, written on EVERY outcome, exit-code-independent. A write
 * failure (a missing parent dir / an unwritable path) is the `--output` path's
 * OWN bad_args: it emits the bad_args envelope to stdout only (the broken path
 * gets no retry) and exits 2.
 */
function emitRunCapture(
  deps: MainDeps,
  result: RunCaptureResult,
  outputPath: string | null = null,
): never {
  if (outputPath !== null) {
    try {
      writeEnvelopeAtomic(outputPath, result.envelope);
    } catch (err) {
      deps.writeErr(
        `agent: cannot write --output ${outputPath}: ${(err as Error).message}\n`,
      );
      const bad = buildRunCaptureEnvelope({ outcome: "bad_args" });
      deps.write(`${JSON.stringify(bad.envelope)}\n`);
      return deps.exit(bad.exitCode);
    }
  }
  deps.write(`${JSON.stringify(result.envelope)}\n`);
  return deps.exit(result.exitCode);
}

/**
 * Atomically write the run-capture envelope (one JSON line) to `target`: a temp
 * file in the SAME dir (EXDEV-safe — never crosses a volume boundary), then
 * rename. The `.tmp` name is poller-invisible (a poller matches only the final
 * path), so the presence flip is atomic. Mirrors panel.ts's `writeFileAtomic`.
 */
function writeEnvelopeAtomic(
  target: string,
  envelope: RunCaptureEnvelope,
): void {
  const tmp = join(
    dirname(target),
    `.keeper-agent-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(envelope)}\n`);
  renameSync(tmp, target);
}

/**
 * The first positional (run id or transcript path) of an `agent wait` argv —
 * echoed into the envelope's `handle`. Mirrors `resolveHandle`'s positional
 * detection (skip `--agent`/`--stop-timeout` values and any other `--flag`).
 */
function firstHandleToken(rest: string[]): string | null {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--agent" || arg === "--stop-timeout") {
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
  const verbDeps = makeVerbDeps(deps);
  const runBadArgs = (): Promise<never> =>
    emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
      parsed.output,
    );
  // Fresh-launch readiness gate (mirrors the interactive launcher gate through
  // the shared {@link resolveLaunchReadiness} core, each keeping its OWN emission
  // contract — here bad_args, there exit 2). `agent run` is always a fresh
  // one-shot (no --continue/--resume analog), so an underspecified preset /
  // `<cli>_default` that resolves neither a model nor the harness's second axis
  // (effort for claude/codex, thinking for pi) would launch a DOOMED detached
  // pane surfacing as no_transcript/timed_out — short-circuit to bad_args instead.
  // The both-explicit escape (`--model` + `--effort`) needs no default and never
  // reads the catalog. `--preset` is config-free otherwise, so its harness must
  // equal the positional `<cli>`; a missing catalog / unknown preset (ConfigError)
  // is bad_args too. The result-file sink still gets every bad_args envelope.
  const runBothExplicit = parsed.model !== null && parsed.effort !== null;
  let runPreset: Preset | null = null;
  if (parsed.preset !== null) {
    try {
      runPreset = resolvePreset(deps.loadPresetCatalogFn(), parsed.preset);
    } catch (exc) {
      if (exc instanceof ConfigError) {
        deps.writeErr(`agent: ${exc.message}\n`);
        return runBadArgs();
      }
      throw exc;
    }
    if (runPreset.harness !== agent) {
      deps.writeErr(
        `agent: --preset ${parsed.preset} pins harness ${runPreset.harness}, ` +
          `but the ${agent} run was given.\n`,
      );
      return runBadArgs();
    }
  } else if (!runBothExplicit) {
    let catalog: PresetCatalog;
    try {
      catalog = deps.loadPresetCatalogFn();
    } catch (exc) {
      if (exc instanceof ConfigError) {
        deps.writeErr(`agent: ${exc.message}\n`);
        return runBadArgs();
      }
      throw exc;
    }
    const defaultName = harnessDefaultName(agent, catalog);
    if (defaultName !== null) {
      runPreset = resolvePreset(catalog, defaultName);
    }
  }
  // Route the resolved preset (or default) plus the explicit --model/--effort
  // flags through the shared readiness core. The both-explicit escape already
  // supplies both axes, so it skips the check.
  if (!runBothExplicit) {
    const runSignals: LaunchConfigSignals = {
      model: parsed.model !== null,
      effortOrThinking: parsed.effort !== null,
      exemptAll: false,
    };
    if (!resolveLaunchReadiness(agent, runPreset, runSignals)) {
      deps.writeErr(
        `agent: no model/effort resolved for a fresh ${agent} run. ` +
          `Set ${agent}_default in presets.yaml (see 'keeper agent presets list'), ` +
          `or pass --preset <name> or --model <model> --effort <effort>.\n`,
      );
      return runBadArgs();
    }
  }
  // Resolve the `--system-file`/`--system` seam to text HANDLER-SIDE (the pure
  // parser never reads the fs). A relative `--system-file` resolves against the
  // caller cwd; a missing/unreadable file is `bad_args` (exit 2), never a throw.
  let systemText: string | null = null;
  if (parsed.systemFile !== null) {
    const path = isAbsolute(parsed.systemFile)
      ? parsed.systemFile
      : join(deps.cwd, parsed.systemFile);
    try {
      systemText = readFileSync(path, "utf8").trim();
    } catch (err) {
      deps.writeErr(
        `agent: cannot read --system-file ${path}: ${(err as Error).message}\n`,
      );
      return emitRunCapture(
        deps,
        buildRunCaptureEnvelope({ outcome: "bad_args" }),
        parsed.output,
      );
    }
  } else if (parsed.system !== null) {
    systemText = parsed.system.trim();
  }
  // Compose CALLER-SIDE (raw `\n\n` join, no `User:` scaffold — `agent run` has
  // no role framing):
  // [read-only directive]? → [final-message directive] → [System: <text>]? →
  // [user prompt], UNIFORM across claude/codex/pi/hermes. The shared launch
  // helper stays directive-free so the caller is the sole prepender. Read-only
  // is prompting-only: the directive is the whole mechanism (keeper enforces
  // nothing — no tool strip, no changed-files audit). The final-message
  // directive is always-on (no flag gates it, harmless to a harness that has
  // no background-agent concept of its own). The `System:` block is user-turn
  // text, NOT a privileged system prompt — the native `--append-system-prompt`
  // upgrade is a deliberate future step. An empty-after-trim system value is a
  // no-op skip.
  const promptParts: string[] = [];
  if (parsed.readOnly) {
    promptParts.push(READ_ONLY_DIRECTIVE);
  }
  promptParts.push(FINAL_MESSAGE_DIRECTIVE);
  if (systemText !== null && systemText !== "") {
    promptParts.push(`System: ${systemText}`);
  }
  promptParts.push(parsed.prompt);
  const prompt = promptParts.join("\n\n");
  const result = await composeRunCapture(
    {
      ...runCaptureSeams(deps),
      launch: () =>
        launchToResolvedHandle({
          deps: launchHandleDeps(deps),
          agent,
          prompt,
          posture: {
            preset: parsed.preset ?? undefined,
            model: parsed.model ?? undefined,
            effort: parsed.effort ?? undefined,
            session: parsed.session ?? undefined,
            name: parsed.name ?? undefined,
          },
          stopTimeoutMs: parsed.stopTimeoutMs,
        }),
    },
    verbDeps,
    agent,
  );
  return emitRunCapture(deps, result, parsed.output);
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
  const verbDeps = makeVerbDeps(deps);
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
 * every member harness (claude|codex|pi) is pair-launchable. The reserved name
 * `default` dereferences to the configured default panel and reports that
 * panel's real name (a null default is fail-loud naming `default`). A `kind`
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

  // `default` is reserved and can never be a catalog preset (the direct lookup
  // above misses it), so here it aliases the configured default panel —
  // dereferenced to its real name so the envelope reports the target panel.
  let lookup = name;
  if (name === "default") {
    if (selections.default === null || selections.default === "") {
      deps.writeErr(
        "Error: 'default' given but no default panel set in panel.yaml.\n",
      );
      return deps.exit(2);
    }
    lookup = selections.default;
  }

  const panelMembers = selections.panels[lookup];
  if (panelMembers !== undefined) {
    // Load-time validation already guarantees each member resolves to a
    // panel-launchable (claude|codex) catalog preset.
    const members = panelMembers.map((memberName) => {
      const preset = catalog.presets[memberName] as Preset;
      return { name: memberName, harness: preset.harness };
    });
    deps.write(`${JSON.stringify({ kind: "panel", name: lookup, members })}\n`);
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
        defaults: {
          claude: catalog.claude_default ?? null,
          codex: catalog.codex_default ?? null,
          pi: catalog.pi_default ?? null,
          hermes: catalog.hermes_default ?? null,
        },
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
  lines.push(
    "Harness defaults (the preset a bare `keeper agent <harness>` resolves):",
  );
  for (const [harness, pointer] of [
    ["claude", catalog.claude_default],
    ["codex", catalog.codex_default],
    ["pi", catalog.pi_default],
    ["hermes", catalog.hermes_default],
  ] as const) {
    lines.push(`  ${harness}_default  ${pointer ?? "(unset)"}`);
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

/** `providers` (host-matrix doctor) JSON contract version. */
const PROVIDERS_SCHEMA_VERSION = 1;
/** `providers resolve`: a wrapped model has no configured provider (no_route). */
const PROVIDERS_NO_ROUTE_EXIT = 3;
/** `providers check`: one or more roster/preset/reachability drift findings. */
const PROVIDERS_CHECK_DRIFT_EXIT = 9;

/**
 * `providers resolve <model> <effort>`: emit the cost-ordered serving candidates
 * for a model from the host matrix, plus the defaults block. A native (claude)
 * model resolves to the single claude candidate; a wrapped model resolves to its
 * pecking-ordered foreign candidates. An UNROUTABLE wrapped model (no configured
 * provider) exits with the distinct `no_route` code; a bad model/effort token
 * exits 2; a malformed matrix exits 2. An ABSENT matrix is the claude-only world:
 * every model resolves native (byte-identical to today, where no non-claude
 * provider exists), so no_route can only arise once a matrix configures wrapped
 * models.
 */
function runProvidersResolve(
  deps: MainDeps,
  model: string,
  effort: string,
): never {
  for (const [label, token] of [
    ["model", model],
    ["effort", effort],
  ] as const) {
    if (!isValidMatrixToken(token)) {
      deps.writeErr(
        `agent providers resolve: ${label} '${token}' is not a valid token ` +
          "(lowercase alnum, hyphen, underscore, dot; no leading dot).\n",
      );
      return deps.exit(2);
    }
  }
  let matrix: Matrix | null;
  try {
    matrix = deps.loadMatrixFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }
  const result: ResolveResult =
    matrix === null
      ? {
          driver: "native",
          candidates: [
            {
              harness: "claude",
              model_id: model,
              preset_name: presetNameFor("claude", model),
            },
          ],
        }
      : resolveModel(matrix, model);
  if (result.driver === "wrapped" && result.candidates.length === 0) {
    deps.writeErr(
      `agent providers resolve: no configured provider serves the wrapped ` +
        `model '${model}' in ${matrixConfigPath()} (no_route). Add a provider ` +
        "serving it to the matrix roster, or correct the model token.\n",
    );
    deps.write(
      `${JSON.stringify({
        schema_version: PROVIDERS_SCHEMA_VERSION,
        error: "no_route",
        model,
        effort,
        driver: result.driver,
        candidates: [],
      })}\n`,
    );
    return deps.exit(PROVIDERS_NO_ROUTE_EXIT);
  }
  const defaults = matrix?.defaults ?? {
    stop_timeout_ms: DEFAULT_STOP_TIMEOUT_MS,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
  };
  deps.write(
    `${JSON.stringify({
      schema_version: PROVIDERS_SCHEMA_VERSION,
      model,
      effort,
      driver: result.driver,
      candidates: result.candidates,
      defaults,
    })}\n`,
  );
  return deps.exit(0);
}

/**
 * `providers check`: the host-matrix doctor. Reports roster-vs-preset-catalog and
 * roster-vs-binary-reachability drift — one line per finding on stderr, the
 * structured findings as a JSON line on stdout. An ABSENT matrix is clean (exit
 * 0, claude-only defaults, nothing to drift); a malformed matrix is a tool error
 * (exit 1); drift findings exit 9. Read-only — never mutates config.
 */
function runProvidersCheck(deps: MainDeps): never {
  let matrix: Matrix | null;
  try {
    matrix = deps.loadMatrixFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(1);
    }
    throw exc;
  }
  if (matrix === null) {
    deps.write(
      `${JSON.stringify({
        schema_version: PROVIDERS_SCHEMA_VERSION,
        matrix_present: false,
        findings: [],
      })}\n`,
    );
    deps.writeErr(
      `providers check: no matrix.yaml at ${matrixConfigPath()} — claude-only ` +
        "embedded defaults, nothing to drift.\n",
    );
    return deps.exit(0);
  }
  // The hand-authored preset names the auto-generated `<provider>-<model>` set
  // must not collide with. A missing/invalid catalog is not fatal to the doctor —
  // treat it as no hand-authored presets (the collision axis is simply empty).
  let handAuthored: ReadonlySet<string>;
  try {
    handAuthored = new Set(Object.keys(deps.loadPresetCatalogFn().presets));
  } catch (exc) {
    if (exc instanceof ConfigError) {
      handAuthored = new Set();
    } else {
      throw exc;
    }
  }
  const rendered = providerCheckFindings(
    matrix,
    handAuthored,
    deps.providerReachableFn,
  ).map((f) =>
    f.kind === "binary-unreachable"
      ? {
          kind: f.kind,
          provider: f.provider,
          binary: f.binary,
          line: `provider '${f.provider}' binary '${f.binary}' is not reachable on PATH`,
        }
      : {
          kind: f.kind,
          preset: f.preset,
          provider: f.provider,
          model: f.model,
          line: `auto-generated preset '${f.preset}' collides with a hand-authored preset`,
        },
  );
  deps.write(
    `${JSON.stringify({
      schema_version: PROVIDERS_SCHEMA_VERSION,
      matrix_present: true,
      findings: rendered,
    })}\n`,
  );
  for (const f of rendered) {
    deps.writeErr(`${f.line}\n`);
  }
  if (rendered.length === 0) {
    deps.writeErr(
      "providers check: roster, preset catalog, and binaries all consistent.\n",
    );
    return deps.exit(0);
  }
  deps.writeErr(`providers check: ${rendered.length} finding(s).\n`);
  return deps.exit(PROVIDERS_CHECK_DRIFT_EXIT);
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
  if (dispatch.kind === "agent-help") {
    // Meta mode: the operator runbook. cli/agent.ts routes it before deps are
    // built; handling it here too keeps the launcher self-consistent when main()
    // is driven directly, and never falls through to the harness-launch branch.
    deps.write(KEEPER_AGENT_RUNBOOK);
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
  if (dispatch.kind === "panel") {
    // Route into `runPanel` — one engine. `runPanel` self-emits its
    // manifest/verdict on stdout and owns its exit code (0 all-terminal / 124
    // chunk-elapsed / 2 bad-config), so it always `process.exit()`s and never
    // returns; the `deps.exit(0)` below only satisfies the `never` return type.
    await runPanel(dispatch.rest);
    return deps.exit(0);
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
  if (dispatch.kind === "providers-resolve") {
    return runProvidersResolve(deps, dispatch.model, dispatch.effort);
  }
  if (dispatch.kind === "providers-check") {
    return runProvidersCheck(deps);
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
  // The injected resolved bins, keyed by harness — the descriptor-lookup form of
  // the old `agent === "claude" ? … : …` chain (byte-identical selection).
  const bins: Record<AgentKind, string> = {
    claude: deps.claudeBin,
    codex: deps.codexBin,
    pi: deps.piBin,
    hermes: deps.hermesBin,
  };
  const bin = bins[agent];
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

  // Harness default + fresh-launch fail-loud. A FRESH launch (not a
  // continuation, not a passthrough; --print IS fresh) with no --x-preset falls
  // back to the catalog's `<harness>_default` so keeper owns the session's
  // model/effort/thinking. A launch that already pins BOTH explicitly (the
  // both-explicit escape) needs no default and never reads the catalog. When the
  // resolved model OR effort/thinking is still absent, the launch is fail-loud
  // (exit 2, self-healing message) — keeper no longer silently defers to the
  // agent's native settings. Resume/continuation + passthrough are exempt.
  const freshLaunch = !hasContinueOrResume && !shouldPassthrough;
  const launchSignals = resolveLaunchConfigSignals(
    agent,
    remainingArgs,
    deps.env,
  );
  const bothExplicit =
    launchSignals.exemptAll ||
    (launchSignals.model && launchSignals.effortOrThinking);
  if (freshLaunch && !bothExplicit) {
    if (resolvedPreset === null) {
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
      const defaultName = harnessDefaultName(agent, catalog);
      if (defaultName !== null) {
        resolvedPreset = resolvePreset(catalog, defaultName);
        actionLog.push(`Resolved ${agent}_default preset '${defaultName}'`);
      }
    }
    // Shared readiness core (same as the run gate): the resolved model AND the
    // harness's second axis (effort for claude/codex, thinking for pi) must both
    // resolve from the preset or an explicit flag.
    if (!resolveLaunchReadiness(agent, resolvedPreset, launchSignals)) {
      deps.writeErr(unresolvedDefaultMessage(agent));
      return deps.exit(2);
    }
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
        deps.ensureClaudeStateSharingFn(deps.listProfilesFn, actionLog);
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

    // Preset (--x-preset or the resolved codex_default) supplies the default;
    // resolveCodexStartup*Override still gives an explicit flag priority.
    const defaultModel = resolvedPreset?.model ?? null;
    const defaultEffort = resolvedPreset?.effort ?? null;
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
      // A keeper effort maps onto codex's reasoning band via the descriptor
      // (keeper `max` → codex `xhigh`); an already-native band passes through.
      const band = mapKeeperEffortToAxis("codex", startupEffort);
      const effortConfig = codexEffortConfigArg(band);
      runCmd.push("-c", effortConfig);
      actionLog.push(`Added Codex effort override: -c ${effortConfig}`);
      note(`effort: ${band}`);
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

    const onCodexSpawned = armBirthRecord(deps, "codex", {
      spawnName: codexSessionName,
      configDir: codexHome,
      pinnedSessionId: null,
      hasContinueOrResume,
      remainingArgs,
    });
    return runWithJobControl(runCmd, deps.spawn, deps.exit, onCodexSpawned);
  }

  if (agent === "hermes") {
    // Hermes uses its native config — keeper does no profile routing for it (M0-M2).
    if (launcherProfile === "auto") {
      launcherProfile = "";
      actionLog.push("Using native Hermes config");
    }

    const runCmd = [bin];
    // No-approval posture: --yolo (unless the caller set one) + the hook-consent
    // env below. hermes is model-only, so there is no effort/thinking to inject.
    const defaults = hermesWrapperDefaults(remainingArgs);
    runCmd.push(...defaults);
    if (defaults.includes("--yolo")) {
      actionLog.push("Added Hermes no-approval default (--yolo)");
    }

    // Preset (--x-preset or the resolved hermes_default) supplies the model;
    // an explicit -m/--model still wins.
    const startupModel = resolveHermesStartupModelOverride(
      remainingArgs,
      resolvedPreset?.model ?? null,
    );
    if (startupModel !== null) {
      runCmd.push("-m", startupModel);
      actionLog.push(`Added startup model override: -m ${startupModel}`);
      note(`model: ${startupModel}`);
    }

    runCmd.push(...remainingArgs);

    // Seed hook consent so a non-TTY / fresh pane never silently skips (or blocks
    // on) hermes's first-use shell-hook prompt. Equivalent to `--accept-hooks`,
    // but as pane env it survives the detached re-exec.
    deps.env.HERMES_ACCEPT_HOOKS = "1";
    actionLog.push("Set HERMES_ACCEPT_HOOKS=1");
    deps.env[agentProfileEnvName(agent)] = launcherProfile || "default";

    if (launcherVeryVerbose) {
      printVerbose(deps, actionLog, formatCommand(runCmd));
    }
    if (sectionsOn) {
      deps.write("~ launching hermes\n");
    }

    const hermesSpawnName = resolveLaunchSessionName(
      remainingArgs,
      deps.cwd,
      deps.nextCwdOrdinalFn,
    ).sessionName;
    const onHermesSpawned = armBirthRecord(deps, "hermes", {
      spawnName: hermesSpawnName,
      configDir: null,
      pinnedSessionId: null,
      hasContinueOrResume,
      remainingArgs,
    });
    return runWithJobControl(runCmd, deps.spawn, deps.exit, onHermesSpawned);
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
    // Preset (--x-preset or the resolved claude_default) supplies the default;
    // resolveStartup*Override still encode explicit > env > default per field.
    const defaultModel = resolvedPreset?.model ?? null;
    const defaultEffort = resolvedPreset?.effort ?? null;
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

    // Pass the plugin-owned settings file explicitly so statusLine is present
    // before Claude's TUI renders. A caller-supplied --settings wins.
    if (hasFlagToken(remainingArgs, "--settings")) {
      actionLog.push("Skipped statusline config (caller set --settings)");
    } else {
      const statuslineSettings = deps.resolveStatuslineSettingsPathFn();
      if (statuslineSettings !== null) {
        runCmd.push("--settings", statuslineSettings);
        actionLog.push(
          `Injected statusline config: --settings ${statuslineSettings}`,
        );
      }
    }
  } else {
    // Preset (--x-preset or the resolved pi_default) supplies the default. A
    // `--model <id>:<thinking>` colon shorthand carries thinking itself, so it
    // suppresses the default --thinking injection (pi rejects a conflicting flag).
    const defaultModel = resolvedPreset?.model ?? null;
    const defaultThinking =
      piModelColonThinking(remainingArgs) !== null
        ? null
        : (resolvedPreset?.thinking ?? null);
    const startupThinking = resolveStartupThinkingOverride(
      remainingArgs,
      defaultThinking,
    );
    const startupModel = resolveStartupModelOverride(
      remainingArgs,
      defaultModel,
    );
    if (startupThinking !== null) {
      // A keeper effort maps onto pi's band via the descriptor (keeper `max` → pi
      // `xhigh`); an already-native band (e.g. `off`) passes through unchanged.
      const band = mapKeeperEffortToAxis("pi", startupThinking);
      runCmd.push("--thinking", band);
      actionLog.push(`Added Pi thinking override: --thinking ${band}`);
      note(`thinking: ${band}`);
    }
    if (startupModel !== null) {
      runCmd.push("--model", startupModel);
      actionLog.push(`Added startup model override: --model ${startupModel}`);
      note(`model: ${startupModel}`);
    }

    // Arm keeper's ephemeral pi extension (`-e <path>`) so this session shows
    // live working/stopped churn — the M3b live-state channel, paired with the
    // birth record armed below. EPHEMERAL per-launch only (never a persistent pi
    // install). Fail-open: `resolvePiExtensionArgsFn` returns `[]` when the
    // extension file is absent, degrading pi to presence-only. Both interactive
    // and detached launches pass through this managed-launch choke point.
    const piExtArgs = deps.resolvePiExtensionArgsFn();
    if (piExtArgs.length > 0) {
      runCmd.push(...piExtArgs);
      actionLog.push(`Armed keeper pi extension: ${piExtArgs.join(" ")}`);
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
  // Captured for the pi birth record's spawn_name (display title).
  let resolvedSessionName: string | null = null;
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
    resolvedSessionName = sessionName;
    if (resolvedSlug) {
      actionLog.push(`Resolved session slug: ${resolvedSlug}`);
    } else {
      actionLog.push(`Used cwd-ordinal fallback: ${sessionName}`);
    }
    runCmd.push("--name", sessionName);
    actionLog.push(`Set session name: ${sessionName}`);
    note(`session: ${sessionName}`);
  }

  // This gate is the SOLE plugin-discovery seam and keys ONLY on the agent CLI,
  // not the launch channel — an autopilot/dispatch worker is a plain `keeper
  // agent claude …` (exec-backend.ts buildKeeperAgentLaunchArgv), so it inherits
  // the FULL plugins.yaml (keeper + plan + arthack) exactly like an interactive
  // session. The per-cell worker `--plugin-dir` (exec-backend.ts) is ADDITIVE,
  // not isolating. Reality map: docs/plugin-composition-map.md.
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
      // Worker plugin-isolation gate. A keeper-automated (human-less) worker
      // launch carries `--dangerously-skip-permissions` — keeper's own
      // human-less worker permission posture on the autopilot/dispatch worker
      // AND the pair partner; an interactive human session never does. When the
      // `worker_plugin_isolation` config knob is set, such a launch drops the
      // `plugin_scan_dirs` RESULTS — it keeps the hard-listed `plugin_dirs`
      // (keeper + plan) plus its additive per-cell `--plugin-dir`. Interactive
      // launches and the explicitly hard-listed `plugin_dirs` are never touched.
      const stripScanDirs =
        (sources.workerPluginIsolation ?? false) &&
        hasFlagToken(remainingArgs, "--dangerously-skip-permissions");
      try {
        const discovery = discoverPlugins(
          deps.cwd,
          sources,
          deps.pluginConfigPath,
          { stripScanDirs },
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
    // it hard-caps itself to 256-color whenever $TMUX is set. For keeper's
    // default tmux socket, carry the pane id to keeper's carrier var FIRST so
    // the events-writer hook can still stamp tmux coords (its native arm keys
    // off $TMUX, which we delete here). Foreign tmux sockets are deliberately
    // not carried because pane ids are server-local.
    // KEEPER_TMUX_PANE must match the literal read in ~/code/keeper/src/
    // exec-backend.ts (paneIdCarrierEnvVar) — keep both sides in sync (drift guard).
    const pane = deps.env.TMUX_PANE ?? "";
    if (pane !== "" && isDefaultTmuxEnvValue(deps.env.TMUX)) {
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

  // pi shares this path with claude; only pi gets a birth record (claude's hook
  // SessionStart is its authoritative presence seed). pi pins its session id, so
  // the pinned uuid is its job identity + resume target.
  const onChildSpawned: ChildSpawnedFn | undefined =
    agent === "pi"
      ? armBirthRecord(deps, "pi", {
          spawnName: resolvedSessionName,
          configDir: profileDir,
          pinnedSessionId: sessionUuid,
          hasContinueOrResume,
          remainingArgs,
        })
      : undefined;
  return runWithJobControl(runCmd, deps.spawn, deps.exit, onChildSpawned);
}

function safeList(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Arm the birth record for a non-claude launch: resolve the keeper job identity,
 * export it (plus codex's rollout originator override) to the harness child, and
 * return the post-spawn callback that writes the maildir record. A birth record
 * is the ONLY presence channel for codex/pi/hermes (they fire no keeper hook);
 * claude is exempt — its SessionStart hook is authoritative for both presence and
 * resume seed — and never calls this.
 *
 * Identity: pi pins its session id at launch (`job_id = session_id`); codex/hermes
 * get a keeper-minted uuid. A RESUME relaunch reuses the ORIGINAL job id carried
 * back in `KEEPER_JOB_ID` (set by the revive script / keeper tabs restore) so the
 * revived session folds onto its existing row instead of minting an orphan. The
 * callback runs shared by interactive AND detached launches: a detached pane
 * re-execs `keeper agent` and passes back through this same spawn choke point, so
 * the record is written by the pane's own launcher, never the outer wrapper.
 *
 * Identity (the job id) and the resume key (the harness-native target) stay
 * DISTINCT per the glossary: on a resume the `resume_target` is read from the
 * harness-native argv token ({@link resumeTargetFromArgv}), NEVER the carried job
 * id — an adopted-then-resumed session whose job id diverged from its native
 * session id must re-emit the SESSION id as its next resume key, not its identity.
 */
function armBirthRecord(
  deps: MainDeps,
  agent: Exclude<AgentKind, "claude">,
  opts: {
    spawnName: string | null;
    configDir: string | null;
    /** The session id keeper pinned at launch (pi), or null for a harness that
     *  mints its own (codex/hermes). */
    pinnedSessionId: string | null;
    hasContinueOrResume: boolean;
    /** The harness-native argv forwarded to the child — the source the resume
     *  target is read from on a resume relaunch (pi `--session`, codex `resume`,
     *  hermes `--resume`). */
    remainingArgs: string[];
  },
): ChildSpawnedFn {
  const descriptor = HARNESS_DESCRIPTORS[agent];
  const carried = (deps.env.KEEPER_JOB_ID ?? "").trim();
  let jobId: string;
  if (opts.hasContinueOrResume && carried !== "") {
    jobId = carried;
  } else if (opts.pinnedSessionId !== null) {
    jobId = opts.pinnedSessionId;
  } else {
    jobId = deps.randomUuid();
  }
  // Export the identity to the harness child. Codex additionally overrides its
  // rollout originator so the rollout tail can positively attribute the session.
  deps.env.KEEPER_JOB_ID = jobId;
  if (agent === "codex") {
    deps.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = jobId;
  }
  // Resume: the native resume key lives in the argv, distinct from the job id.
  // Fresh: pi's key is its pinned session id (= job id, authoritative at launch);
  // codex/hermes back-fill theirs post-stop, so it is null at birth.
  const resumeTarget = opts.hasContinueOrResume
    ? resumeTargetFromArgv(opts.remainingArgs, agent)
    : descriptor.mintsOwnSessionId
      ? null
      : jobId;
  const draft = buildBirthDraft(deps.env, {
    session_id: jobId,
    harness: agent,
    cwd: deps.cwd,
    spawn_name: opts.spawnName,
    config_dir: opts.configDir,
    resume_target: resumeTarget,
    launch_ts: new Date(deps.now()).toISOString(),
  });
  return (pid: number) => deps.emitBirthRecord(draft, pid);
}

/**
 * The harness-native resume key present in a resume launch's forwarded argv —
 * the token FOLLOWING the harness's own resume verb/flag (pi `--session <t>`,
 * codex `resume <t>`, hermes `--resume <t>`, sourced from the descriptor). Returns
 * null when the token is absent or has no following value (a target-less
 * `--continue`/`resume`), so the caller stamps a null resume key rather than the
 * job id. Scanned ONLY on a resume relaunch, so a fresh launch whose prompt
 * happens to contain the verb never false-matches. Pure.
 */
function resumeTargetFromArgv(
  args: string[],
  agent: Exclude<AgentKind, "claude">,
): string | null {
  const token = HARNESS_DESCRIPTORS[agent].resumeArgv.token;
  const idx = args.indexOf(token);
  if (idx === -1) {
    return null;
  }
  const target = args[idx + 1];
  return target !== undefined && target !== "" ? target : null;
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
