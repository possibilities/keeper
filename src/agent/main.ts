/**
 * main() assembly — the launcher control flow, wiring the pure modules, the
 * state layer, and the process layer. Side-effecting collaborators (spawn, the
 * keystroke read, exit) are injected via `MainDeps` so the whole flow is
 * testable against a fake agent and a recording spawn.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRouting,
  type RouteSelection,
  type RoutingInspection,
  selectRoute,
} from "../account-router";
import {
  KEEPER_ACCOUNT_ORDINAL_ENV,
  KEEPER_ACCOUNT_ROUTE_ENV,
  resolveCswapCommand,
} from "../account-routing-config";
import {
  type BirthRecordDraft,
  buildBirthDraft,
  emitBirthRecord,
} from "../birth-record";
import { DISPATCH_FLOORS, type DispatchVerb } from "../dispatch-launch-config";
import { isDefaultTmuxEnvValue } from "../exec-backend";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "../keeper-agent-path";
import { runPanel } from "../pair/panel";
import { parseArgsForAgent } from "./args";
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
  parseYaml,
  pluginConfigPath,
  presetsCatalogPath,
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
  ResumeLaunchUnsupportedError,
} from "./harness";
import {
  buildAgentLaunchArgv,
  composeManagedClaudeArgv,
  FINAL_MESSAGE_DIRECTIVE,
  piExtensionArgs,
  READ_ONLY_DIRECTIVE,
} from "./launch-config";
import {
  type LaunchHandleDeps,
  launchEnvForAgent,
  launchToResolvedHandle,
  tmuxTranscriptSessionId,
} from "./launch-handle";
import {
  isValidMatrixToken,
  loadMatrixV2,
  MatrixConfigError,
  type MatrixV2,
  matrixConfigPath,
  providerCheckFindingsV2,
  type ResolveResult,
  resolveModelV2,
} from "./matrix";
import {
  resolveHandle,
  runShowLastMessage,
  runWaitForStop,
  type VerbDeps,
} from "./pair-subcommands";
import {
  findPassthroughCommand,
  findPiPassthroughCommand,
  hasExplicitEffortArg,
  hasExplicitModelArg,
  hasExplicitThinkingArg,
  piModelColonThinking,
  resolveStartupEffortOverride,
  resolveStartupModelOverride,
  resolveStartupThinkingOverride,
} from "./passthrough";
import { makePhaser } from "./phaser";
import {
  ensurePiPromptArtifacts,
  PiPromptArtifactsError,
  stampPiPromptCompilerEnv,
} from "./pi-prompt-artifacts";
import { discoverPlugins, PluginError } from "./plugins";
// Type-only: resolveResumeDecision itself is NEVER imported here — it
// transitively pulls src/db.ts (bun:sqlite) via server-worker.ts, a cost this
// cold-start launcher must never pay. See resume-resolve-cli.ts (spawned as a
// subprocess by resolveResumeDecisionFn below) for the real call.
import type { ResumeDecision } from "./resume-policy";
import {
  type ChildSpawnedFn,
  defaultSpawn,
  runPassthrough,
  runWithJobControl,
  type SpawnFn,
} from "./run";
import {
  buildRunCaptureEnvelope,
  buildRunControlArtifact,
  captureFromHandle,
  composeRunCapture,
  createExactRunTeardown,
  type ExactTeardownResult,
  type ParseRunArgsResult,
  parseRunArgs,
  type RunCaptureDeps,
  type RunCaptureEnvelope,
  type RunCaptureResult,
  type RunControlArtifact,
} from "./run-capture";
import { extractPromptText, resolveSessionSlug } from "./session-name";
import {
  defaultClaudeStowDir,
  defaultSharedStowDir,
  ensureClaudeStateSharing,
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
import {
  enumerateTriplesV2,
  extractHostTriples,
  formatTriple,
  type HostTripleFinding,
  type HostTriples,
  hostTripleRefs,
  lintHostTriplesV2,
  parseTriple,
  type Triple,
} from "./triple";
import { readSingleChar } from "./tty";

export interface MainDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: SpawnFn;
  readChar: () => string;
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
  piBin: string;
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
  /**
   * Re-assert Claude's canonical `~/.claude/CLAUDE.md` global-instruction link
   * onto the one shared source. HOME-coupled, so a seam; `realDeps()` binds it
   * against `homedir()` + `defaultClaudeStowDir()` + `defaultSharedStowDir()`.
   * Claude's `settings.json` is install-time-seeded only — this never compares,
   * repairs, or blocks a launch on its live drift.
   */
  ensureClaudeStateSharingFn: (actionLog: string[]) => void;
  /**
   * Materialize Pi's canonical `~/.pi/agent` root and re-assert its canonical
   * `AGENTS.md` global-instruction link onto the one shared source. HOME-coupled,
   * so a seam; `realDeps()` binds it against `homedir()` + `defaultSharedStowDir()`
   * + `process.env`. Runs unconditionally on every pi launch, passthrough
   * included — there is no Keeper-owned Pi profile farm.
   */
  ensurePiStateSharingFn: (actionLog: string[]) => void;
  /**
   * Compile Pi's static plan prompt artifacts through the keeper CLI subprocess.
   * Runs once in the inner Pi launcher before Pi state discovery, including native
   * passthrough commands. The subprocess inherits the stamped launch environment.
   */
  ensurePiPromptArtifactsFn: (actionLog: string[]) => void;
  /**
   * Read the host provider matrix from `matrix.yaml` (v2, ADR 0036) — REQUIRED,
   * never null: an absent/unparseable/empty/schema-invalid file throws the typed
   * four-state {@link MatrixConfigError}. Producer-side launch config, re-parsed
   * per call, never a fold input. Injected so the `presets`/`providers` verbs
   * are testable against fixture matrices without a real `~/.config`.
   */
  loadMatrixFn: () => MatrixV2;
  /**
   * Read the operator's launch triples from the host files — the four harness
   * defaults + worker/escalation from `presets.yaml` and the panel members from
   * `panel.yaml`, harvested leniently as raw strings (the doctor validates them
   * against the cube). Powers `presets list`/`presets resolve` and the
   * `providers check` host-triple lint. Producer-side, re-read per call; injected
   * so the triple verbs are testable against fixtures without a real `~/.config`.
   */
  loadHostTriplesFn: () => HostTriples;
  /**
   * True when a roster provider's harness binary is reachable on PATH — the
   * `providers check` reachability probe. HOME/PATH-coupled, so a seam;
   * `realDeps()` binds it against the resolved per-harness bins.
   */
  providerReachableFn: (harness: HarnessName) => boolean;
  /**
   * Emit a birth record for a freshly-spawned Pi child: probe the child's platform-tagged start_time and atomically
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
  /**
   * Resolve `target` (a current name, former name, session id, id prefix, or
   * current-title substring) to a {@link ResumeDecision} for the `resume` verb and
   * `agent run --resume`. `requireHarness`, when set, restricts the match to that
   * harness (the `agent run <cli>` positional supplies it so a same-name match on a
   * different CLI reports a distinct `harness-mismatch` rather than launching the
   * wrong harness); omitted (the harness-agnostic `resume` verb) matches any.
   * Throws on a tool-level failure (db open, a malformed subprocess result) —
   * a resolved-but-non-"ok" decision (live/ambiguous/unknown/no-target) is a
   * SUCCESSFUL return, never a throw. `realDeps()` binds it to a SUBPROCESS
   * spawn of `resume-resolve-cli.ts`, never a direct import of
   * `resolveResumeDecision` (see the import-site comment for why); a test
   * injects a pure fake, so the fast suite never touches a real db or spawn.
   */
  resolveResumeDecisionFn: (
    target: string,
    requireHarness?: HarnessName,
  ) => ResumeDecision;
  /**
   * Resolve the account route for one Claude launch (fresh / resume / restore) —
   * the single Claude process-boundary decision. Reads the latest validated
   * observation, records a short-lived launch reservation, and fails open to the
   * native default on every uncertain path. Selection is INDEPENDENT per launch:
   * no prior attribution or conversation identity participates. Injected so the
   * launch path is testable without touching the real observation sidecar /
   * ledger; `realDeps()` binds {@link selectRoute}.
   */
  selectAccountRouteFn: () => RouteSelection;
  /**
   * Read-only account-routing diagnostic behind `accounts check` — reports
   * integration health, snapshot age, PII-free candidates, and the route policy
   * would choose WITHOUT recording a reservation. `realDeps()` binds
   * {@link inspectRouting}.
   */
  inspectRoutingFn: () => RoutingInspection;
  /**
   * The claude-swap executable a MANAGED route wraps the launch through
   * (`cswap run <slot> --share-history -- <Claude argv…>`). `realDeps()` resolves
   * it via `KEEPER_CSWAP_BIN` / PATH; a seam keeps the managed byte-pins path-
   * independent.
   */
  cswapBin: string;
}

/** Parse a host YAML file to its raw body, or null when the file is absent (the
 *  lenient host-triple harvest treats an absent file as no triples). Malformed
 *  YAML surfaces as a ConfigError from `parseYaml`, propagated to the verb. */
function readYamlFileIfPresent(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  return parseYaml(readFileSync(path, "utf8"));
}

/** Production deps — the real collaborators. */
export function realDeps(): MainDeps {
  // Relocate the legacy launcher state dir before the launcher's tmux-runs/
  // mkdir reads launcherStateDir (a launch with an explicit --name never hits
  // the cwd-ordinal chokepoint, so this surface must migrate too).
  migrateLegacyAgentStateDir();
  const bins: Record<HarnessName, string> = {
    claude: join(homedir(), ".local", "bin", "claude"),
    pi: "pi",
  };
  const launcherArgvPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolveKeeperAgentPathDepFree(),
  );
  const piPromptCompilerPaths = {
    executablePath: launcherArgvPrefix[0] ?? "",
    keeperCliPath: launcherArgvPrefix[1] ?? "",
  };
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    spawn: defaultSpawn,
    readChar: readSingleChar,
    nextCwdOrdinalFn: nextCwdOrdinal,
    randomUuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    claudeBin: bins.claude,
    piBin: bins.pi,
    pluginConfigPath: pluginConfigPath(),
    loadPluginSourcesFn: loadPluginSources,
    loadPresetCatalogFn: loadPresetCatalog,
    loadPanelSelectionsFn: () => loadPanelSelections(),
    ensureClaudeStateSharingFn: (actionLog) =>
      ensureClaudeStateSharing(
        actionLog,
        homedir(),
        defaultClaudeStowDir(),
        defaultSharedStowDir(),
      ),
    ensurePiStateSharingFn: (actionLog) =>
      ensurePiStateSharing(
        actionLog,
        homedir(),
        defaultSharedStowDir(),
        process.env,
      ),
    ensurePiPromptArtifactsFn: (actionLog) =>
      ensurePiPromptArtifacts(actionLog, {
        ...piPromptCompilerPaths,
        env: process.env,
      }),
    loadMatrixFn: loadMatrixV2,
    loadHostTriplesFn: () =>
      extractHostTriples(
        readYamlFileIfPresent(presetsCatalogPath()),
        readYamlFileIfPresent(panelConfigPath()),
      ),
    providerReachableFn: (harness) => isBinaryReachable(bins[harness]),
    emitBirthRecord: (draft, pid) => emitBirthRecord(process.env, draft, pid),
    tmuxBin: resolveTmuxBin(process.env),
    launcherArgvPrefix,
    launcherStateDir: defaultKeeperAgentStateDir(process.env),
    transcriptHomeDir: homedir(),
    runTmuxCommandFn: defaultTmuxCommandRunner,
    resolveStatuslineSettingsPathFn: resolveKeeperPluginStatuslineSettingsPath,
    resolvePiExtensionArgsFn: () => piExtensionArgs(),
    resolveResumeDecisionFn: (target, requireHarness) =>
      resolveResumeDecisionViaSubprocess(
        process.execPath,
        resumeResolveCliPath(),
        target,
        requireHarness,
      ),
    selectAccountRouteFn: () => selectRoute(),
    inspectRoutingFn: () => inspectRouting(),
    cswapBin: resolveCswapCommand(),
  };
}

/** Absolute path to `resume-resolve-cli.ts`, resolved relative to THIS module
 *  (robust across worktrees and a `bun link`ed binary alike). */
function resumeResolveCliPath(): string {
  return fileURLToPath(new URL("./resume-resolve-cli.ts", import.meta.url));
}

/**
 * Resolve a `resume` target via a SUBPROCESS boundary rather than an import —
 * `resolveResumeDecision` transitively pulls `src/db.ts` (bun:sqlite) through
 * its liveness probe, a cost `cli/agent.ts`'s cold-start bundle must never pay
 * (a dynamic import bundles inline just like a static one; only a real process
 * boundary isolates it — see the hygiene test pinning the bundle bun:sqlite-free).
 * Blocking (`spawnSync`): the resume verb is a one-shot CLI invocation, not a
 * hot loop, so the extra process start is an acceptable cost for keeping the
 * launcher's own cold start db-free. Throws on a malformed/tool-error result —
 * a resolved-but-non-"ok" `ResumeDecision` is a normal, non-throwing return.
 */
function resolveResumeDecisionViaSubprocess(
  bunBin: string,
  scriptPath: string,
  target: string,
  requireHarness?: HarnessName,
): ResumeDecision {
  const argv =
    requireHarness === undefined
      ? [scriptPath, target]
      : [scriptPath, target, requireHarness];
  const result = spawnSync(bunBin, argv, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? "").trim();
  let parsed: unknown = null;
  try {
    parsed = stdout === "" ? null : JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { kind?: unknown }).kind !== "string"
  ) {
    const diagnostic =
      (result.stderr ?? "").trim() ||
      stdout ||
      `exit ${result.status ?? "null"}`;
    throw new Error(
      `keeper agent resume: resolver produced no valid decision: ${diagnostic}`,
    );
  }
  const decision = parsed as { kind: string; message?: string };
  if (decision.kind === "tool-error") {
    throw new Error(decision.message ?? "resume resolver failed");
  }
  return parsed as ResumeDecision;
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

function findPassthroughForAgent(
  agent: AgentKind,
  args: string[],
): string | null {
  if (agent === "claude") {
    return findPassthroughCommand(args);
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

/**
 * Whether a launch supplied its model + effort/thinking explicitly (the
 * both-explicit escape from the fresh-launch default gate). Per harness: claude
 * counts `--effort` OR the `CLAUDE_CODE_EFFORT_LEVEL` env; Pi counts `--thinking` OR the
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
  if (agent === "pi") {
    return (
      `Error: keeper agent pi: no model/thinking resolved for a fresh launch. ` +
      `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
      `or pass --model <model> --thinking <thinking> ` +
      `(or --model <model>:<thinking>).\n`
    );
  }
  return (
    `Error: keeper agent claude: no model/effort resolved for a fresh launch. ` +
    `Set ${key} in presets.yaml (see 'keeper agent presets list'), ` +
    `or pass --model <model> --effort <effort>.\n`
  );
}

/** The `<harness>_default` launch triple for a harness — the triple a bare
 *  `keeper agent <harness>` resolves. Keyed per harness so a new harness's default
 *  never silently falls through to another's. */
function harnessDefaultTriple(
  agent: AgentKind,
  catalog: PresetCatalog,
): Triple | null {
  switch (agent) {
    case "claude":
      return catalog.claude_default ?? null;
    case "pi":
      return catalog.pi_default ?? null;
  }
}

/**
 * Bridge a parsed launch {@link Triple} into the {@link Preset} shape the launch
 * resolver machinery consumes. The triple's single `effort` segment routes onto the
 * harness's own second axis (descriptor-driven): Claude takes it as `effort`
 * and Pi as `thinking`.
 * The launch path then translates that band per-harness at argv-build time exactly
 * as a hand-authored preset did. `role` is never carried by a triple.
 */
function presetFromTriple(t: Triple): Preset {
  const axis = HARNESS_DESCRIPTORS[t.harness].secondAxis;
  return {
    harness: t.harness,
    model: t.model,
    effort: axis === "effort" ? t.effort : null,
    thinking: axis === "thinking" ? t.effort : null,
    role: null,
  };
}

/**
 * The shared fresh-launch readiness core both gates route through: does the
 * RESOLVED preset (plus any explicit-flag `signals`) supply BOTH a model and the
 * harness's correct SECOND AXIS — `effort` for Claude, `thinking` for Pi?
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
  const axis = HARNESS_DESCRIPTORS[agent].secondAxis;
  const second =
    axis === "thinking" ? (preset?.thinking ?? null) : (preset?.effort ?? null);
  const secondResolved = second !== null || signals.effortOrThinking;
  return modelResolved && secondResolved;
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
 *  run-capture compose. */
function makeVerbDeps(deps: MainDeps): VerbDeps {
  return {
    env: deps.env,
    homeDir: deps.transcriptHomeDir,
  };
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
 * detached-leg pollers, written on EVERY outcome, exit-code-independent. The
 * parent dir is created as needed (`mkdir -p`), so a not-yet-existing target dir
 * self-heals; a write failure that survives that (an unwritable path — e.g. a
 * non-directory occupying the parent chain) is the `--output` path's OWN
 * bad_args: it emits the bad_args envelope to stdout only (the broken path gets
 * no retry) and exits 2.
 */
function emitRunCapture(
  deps: MainDeps,
  result: RunCaptureResult,
  outputPath: string | null = null,
  reap?: () => ExactTeardownResult,
  control?: { path: string; artifact: RunControlArtifact },
): never {
  let emitted = result;
  if (outputPath !== null) {
    try {
      writeEnvelopeAtomic(outputPath, result.envelope);
    } catch (err) {
      deps.writeErr(
        `agent: cannot write --output ${outputPath}: ${(err as Error).message}\n`,
      );
      emitted = buildRunCaptureEnvelope({ outcome: "bad_args" });
    }
  }

  // The answer is observable before teardown on every path, including a failed
  // --output write. Teardown can never rewrite a viable captured answer.
  deps.write(`${JSON.stringify(emitted.envelope)}\n`);

  let teardown: ExactTeardownResult | null = null;
  if (reap !== undefined) {
    if (control !== undefined) {
      try {
        writeControlAtomic(control.path, {
          ...control.artifact,
          status: "cancelling",
        });
      } catch (err) {
        deps.writeErr(
          `agent: cannot update run control before reap: ${(err as Error).message}\n`,
        );
      }
    }
    teardown = reap();
    if (teardown.kind === "unresolved_teardown_error") {
      deps.writeErr(
        `agent: reap-window-on-terminal failed (window left resident): ${teardown.error}\n`,
      );
    }
  }

  // A failed reap deliberately remains `cancelling`: the exact target stays
  // inspectable and a later owner can distinguish/retry unresolved teardown.
  if (
    control !== undefined &&
    (reap === undefined || teardown?.kind !== "unresolved_teardown_error")
  ) {
    try {
      writeControlAtomic(control.path, {
        ...control.artifact,
        status: "terminal",
      });
    } catch (err) {
      deps.writeErr(
        `agent: cannot mark run control terminal: ${(err as Error).message}\n`,
      );
    }
  }
  return deps.exit(emitted.exitCode);
}

/**
 * The reap-on-terminal teardown for {@link emitRunCapture}: kills exactly the
 * tmux window this run launched, via the socket-correct argv the launch
 * returned. Undefined (no teardown) unless the posture was requested AND the
 * launch actually opened a window — so a plain `agent run` stays resident and
 * resumable, and only an explicitly one-shot leg tears itself down.
 */
function reapThunk(
  deps: MainDeps,
  requested: boolean,
  killWindowCommand: string[] | null,
): (() => ExactTeardownResult) | undefined {
  if (!requested || killWindowCommand === null) {
    return undefined;
  }
  return createExactRunTeardown(killWindowCommand, deps.runTmuxCommandFn);
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
  // Self-create the parent so a `--output` at a not-yet-existing dir (e.g. the
  // wrapped-envelope spool) lands rather than ENOENTs; recursive is idempotent.
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(
    dirname(target),
    `.keeper-agent-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(envelope)}\n`);
  renameSync(tmp, target);
}

/** Persist the narrow ownership record with the same-directory atomicity. */
function writeControlAtomic(
  target: string,
  artifact: RunControlArtifact,
): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(
    dirname(target),
    `.keeper-agent-control-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(artifact)}\n`);
  renameSync(tmp, target);
}

function controlPath(stateDir: string, runId: string): string {
  return join(stateDir, "tmux-runs", runId, "control.json");
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
  // RESUME: `agent run <cli> "<ask>" --resume <name-or-id>` continues a prior
  // partner conversation instead of a fresh launch. It is a wholly separate path
  // — resolve the target, run the refuse-live / harness-match / cwd checks, then
  // launch+capture in the RECORDED cwd — and skips the fresh-launch readiness
  // gate below (the resumed session already owns its model/effort).
  if (parsed.resume !== null) {
    return runResumeCaptureSubcommand(deps, parsed, agent, verbDeps);
  }
  // Fresh-launch readiness gate (mirrors the interactive launcher gate through
  // the shared {@link resolveLaunchReadiness} core, each keeping its OWN emission
  // contract — here bad_args, there exit 2). `agent run` is always a fresh
  // one-shot (no --continue/--resume analog), so an underspecified preset /
  // `<cli>_default` that resolves neither a model nor the harness's second axis
  // (effort for Claude, thinking for Pi) would launch a DOOMED detached
  // pane surfacing as no_transcript/timed_out — short-circuit to bad_args instead.
  // The both-explicit escape (`--model` + `--effort`) needs no default and never
  // reads the catalog. `--preset` is config-free otherwise, so its harness must
  // equal the positional `<cli>`; a missing catalog / unknown preset (ConfigError)
  // is bad_args too. The result-file sink still gets every bad_args envelope.
  const runBothExplicit = parsed.model !== null && parsed.effort !== null;
  let runPreset: Preset | null = null;
  if (parsed.preset !== null) {
    const parsedTriple = parseTriple(parsed.preset);
    if (!parsedTriple.ok) {
      deps.writeErr(`agent: --preset ${parsedTriple.error}\n`);
      return runBadArgs();
    }
    runPreset = presetFromTriple(parsedTriple.triple);
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
    const defaultTriple = harnessDefaultTriple(agent, catalog);
    if (defaultTriple !== null) {
      runPreset = presetFromTriple(defaultTriple);
    }
  }
  // Route the resolved triple (or default) plus the explicit --model/--effort
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
          `or pass --preset <triple> or --model <model> --effort <effort>.\n`,
      );
      return runBadArgs();
    }
  }
  const composed = composeRunPrompt(deps, parsed);
  if (!composed.ok) {
    deps.writeErr(composed.error);
    return emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
      parsed.output,
    );
  }
  const prompt = composed.prompt;
  let killWindowCommand: string[] | null = null;
  let control: { path: string; artifact: RunControlArtifact } | undefined;
  let controlWriteFailed = false;
  let result: RunCaptureResult;
  try {
    result = await composeRunCapture(
      {
        ...runCaptureSeams(deps),
        launch: () => {
          const launched = launchToResolvedHandle({
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
          });
          return launched;
        },
        onLaunched: (launched) => {
          killWindowCommand = launched.killWindowCommand;
          control = {
            path: controlPath(deps.launcherStateDir, launched.runId),
            artifact: buildRunControlArtifact({
              runId: launched.runId,
              agent,
              startedAtMs: launched.handle.startedAtMs,
              killWindowCommand: launched.killWindowCommand,
            }),
          };
          try {
            writeControlAtomic(control.path, control.artifact);
          } catch (err) {
            controlWriteFailed = true;
            throw err;
          }
        },
      },
      verbDeps,
      agent,
    );
  } catch (err) {
    deps.writeErr(
      `agent: cannot persist run control: ${(err as Error).message}\n`,
    );
    result = buildRunCaptureEnvelope({ outcome: "launch_failed", agent });
  }
  return emitRunCapture(
    deps,
    result,
    parsed.output,
    reapThunk(
      deps,
      parsed.reapWindowOnTerminal || controlWriteFailed,
      killWindowCommand,
    ),
    control,
  );
}

/** A successfully-parsed `agent run` argv (the `ok:true` arm of parseRunArgs). */
type ParsedRunArgs = Extract<ParseRunArgsResult, { ok: true }>;

/** Compose result: the assembled prompt, or a stderr-ready error line (a
 *  `--system-file` that cannot be read) the caller maps to bad_args. */
type ComposedPrompt =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

/**
 * Compose the `agent run` prompt CALLER-SIDE (raw `\n\n` join, no `User:` scaffold
 * — `agent run` has no role framing): [read-only directive]? → [final-message
 * directive] → [System: <text>]? → [user prompt], uniform across Claude/Pi and
 * across fresh AND resume runs (a resumed leg carries the same directive
 * contract). The shared launch helper stays directive-free so this is the sole
 * prepender. Read-only is prompting-only (the directive is the whole mechanism —
 * keeper enforces nothing); the final-message directive is always-on; the `System:`
 * block is user-turn text, not a privileged system prompt. Resolves the
 * `--system-file`/`--system` seam to text here (the pure parser never reads the fs):
 * a relative `--system-file` resolves against the CALLER cwd (not the resumed
 * partner's), and a missing/unreadable file is `bad_args`, never a throw. An
 * empty-after-trim system value is a no-op skip.
 */
function composeRunPrompt(
  deps: MainDeps,
  parsed: ParsedRunArgs,
): ComposedPrompt {
  let systemText: string | null = null;
  if (parsed.systemFile !== null) {
    const path = isAbsolute(parsed.systemFile)
      ? parsed.systemFile
      : join(deps.cwd, parsed.systemFile);
    try {
      systemText = readFileSync(path, "utf8").trim();
    } catch (err) {
      return {
        ok: false,
        error: `agent: cannot read --system-file ${path}: ${(err as Error).message}\n`,
      };
    }
  } else if (parsed.system !== null) {
    systemText = parsed.system.trim();
  }
  const promptParts: string[] = [];
  if (parsed.readOnly) {
    promptParts.push(READ_ONLY_DIRECTIVE);
  }
  promptParts.push(FINAL_MESSAGE_DIRECTIVE);
  if (systemText !== null && systemText !== "") {
    promptParts.push(`System: ${systemText}`);
  }
  promptParts.push(parsed.prompt);
  return { ok: true, prompt: promptParts.join("\n\n") };
}

/**
 * `agent run <cli> "<ask>" --resume <name-or-id>`: continue a prior partner
 * conversation, then capture the resumed session's NEW final answer into the same
 * uniform envelope. The resumed session OWNS its config, so `--model`/`--effort`/
 * `--preset` alongside `--resume` is bad_args; resolution goes through the
 * resume-policy module REQUIRING the `<cli>` positional's harness (a same-name
 * match on a different harness is a distinct `harness-mismatch`, never a wrong-CLI
 * launch). A refuse-live / unknown / ambiguous / no-target decision each emits a
 * distinct actionable bad_args with the envelope still written to `--output`.
 * Launch + capture happen in the RECORDED cwd (resume is cwd-scoped — the native
 * CLI finds the session only there), pinning the resumed session's id on the handle
 * so discovery + the envelope resume_target resolve the POST-resume id: claude's
 * freshly-forked child uuid.
 */
async function runResumeCaptureSubcommand(
  deps: MainDeps,
  parsed: ParsedRunArgs,
  agent: AgentKind,
  verbDeps: VerbDeps,
): Promise<never> {
  const target = parsed.resume as string;
  const emitBad = (): Promise<never> =>
    emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
      parsed.output,
    );

  // The resumed session keeps its own model/effort/preset — passing them here is a
  // contradiction, not an override. Fail loud rather than silently drop them.
  if (
    parsed.model !== null ||
    parsed.effort !== null ||
    parsed.preset !== null
  ) {
    deps.writeErr(
      "agent: --model/--effort/--preset cannot be combined with --resume — " +
        "the resumed session keeps its own config.\n",
    );
    return emitBad();
  }

  let decision: ResumeDecision;
  try {
    decision = deps.resolveResumeDecisionFn(target, agent);
  } catch (err) {
    deps.writeErr(
      `agent: --resume cannot resolve '${target}': ${(err as Error).message}\n`,
    );
    return emitBad();
  }

  if (decision.kind === "unknown") {
    deps.writeErr(
      `agent: --resume: no partner session found matching '${target}'.\n`,
    );
    return emitBad();
  }
  if (decision.kind === "harness-mismatch") {
    deps.writeErr(
      `agent: --resume '${target}' did not resolve to a ${decision.require_harness} ` +
        `session (newest match: ${displayAgent(decision.harness)} job ` +
        `${decision.job_id}). Run it as \`keeper agent run ${decision.harness} ` +
        `… --resume ${target}\` to resume the ${decision.harness} session instead.\n`,
    );
    return emitBad();
  }
  if (decision.kind === "live") {
    deps.writeErr(
      `agent: --resume '${target}' resolves to a LIVE ${displayAgent(decision.harness)} ` +
        `session (job ${decision.job_id}${decision.title !== null ? `, "${decision.title}"` : ""}). ` +
        `It is still running — message it instead: ` +
        `keeper bus chat send ${decision.job_id} "<msg>"\n`,
    );
    return emitBad();
  }
  if (decision.kind === "ambiguous") {
    deps.writeErr(
      `agent: --resume '${target}' is ambiguous among ${decision.candidates.length} ` +
        "equally-recent sessions — resume by the exact job id.\n",
    );
    return emitBad();
  }
  if (decision.kind === "no-target") {
    deps.writeErr(
      `agent: --resume: matched ${displayAgent(decision.harness)} job ` +
        `${decision.job_id} has no resume target — it cannot be resumed.\n`,
    );
    return emitBad();
  }

  // decision.kind === "ok". Resume is cwd-scoped — the native CLI can locate the
  // session only under its recorded cwd, so launch + discover THERE, not deps.cwd.
  const resumeCwd = decision.cwd;
  if (resumeCwd === null || resumeCwd === "" || !existsSync(resumeCwd)) {
    deps.writeErr(
      `agent: --resume: the recorded cwd for ${displayAgent(decision.harness)} job ` +
        `${decision.job_id}${resumeCwd ? ` ('${resumeCwd}')` : ""} no longer exists ` +
        "— cannot resume there.\n",
    );
    return emitBad();
  }

  const composed = composeRunPrompt(deps, parsed);
  if (!composed.ok) {
    deps.writeErr(composed.error);
    return emitBad();
  }

  // claude forks a NEW child session file on --resume (ADR 0034); mint + pin the
  // child uuid so strict discovery resolves the child (never the parent) and the
  // envelope reports it as the POST-resume id. Pi resumes its existing
  // session in place, so the resumed id IS the target.
  const childSessionId =
    decision.harness === "claude" ? deps.randomUuid() : undefined;
  const discoverySessionId =
    decision.harness === "claude"
      ? (childSessionId as string)
      : decision.resume_target;

  let killWindowCommand: string[] | null = null;
  let control: { path: string; artifact: RunControlArtifact } | undefined;
  let controlWriteFailed = false;
  let result: RunCaptureResult;
  try {
    result = await composeRunCapture(
      {
        ...runCaptureSeams(deps),
        launch: () => {
          const launched = launchToResolvedHandle({
            deps: { ...launchHandleDeps(deps), cwd: resumeCwd },
            agent,
            prompt: composed.prompt,
            // The resumed session owns its config, but presentation still rides
            // the shared launch-posture seam so a resumed provider leg can
            // rejoin its tmux grouping and keep a display-only title.
            posture: {
              session: parsed.session ?? undefined,
              name: parsed.name ?? undefined,
            },
            stopTimeoutMs: parsed.stopTimeoutMs,
            resume: {
              target: decision.resume_target,
              childSessionId,
              sessionId: discoverySessionId,
            },
          });
          return launched;
        },
        onLaunched: (launched) => {
          killWindowCommand = launched.killWindowCommand;
          control = {
            path: controlPath(deps.launcherStateDir, launched.runId),
            artifact: buildRunControlArtifact({
              runId: launched.runId,
              agent,
              startedAtMs: launched.handle.startedAtMs,
              killWindowCommand: launched.killWindowCommand,
            }),
          };
          try {
            writeControlAtomic(control.path, control.artifact);
          } catch (err) {
            controlWriteFailed = true;
            throw err;
          }
        },
      },
      verbDeps,
      agent,
    );
  } catch (err) {
    deps.writeErr(
      `agent: cannot persist run control: ${(err as Error).message}\n`,
    );
    result = buildRunCaptureEnvelope({ outcome: "launch_failed", agent });
  }
  return emitRunCapture(
    deps,
    result,
    parsed.output,
    reapThunk(
      deps,
      parsed.reapWindowOnTerminal || controlWriteFailed,
      killWindowCommand,
    ),
    control,
  );
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
 * `presets resolve <name>`: emit the resolved launch reference JSON to stdout. A
 * well-formed launch triple echoes its parse (`{kind:"triple", triple, harness,
 * model, effort}`); a name matching a panel derefs to its ordered member triples
 * (`{kind:"panel", name, members:[...]}`) in declaration order. The reserved name
 * `default` dereferences to the configured default panel and reports that panel's
 * real name (a null default is fail-loud naming `default`). A `kind` discriminator
 * pins the contract downstream skills parse with jq. A name that is neither a
 * well-formed triple nor a known panel is fail-loud (exit 2), the error naming the
 * offending triple segment and the known panels.
 */
function runPresetsResolve(deps: MainDeps, name: string): never {
  const parsed = parseTriple(name);
  if (parsed.ok) {
    deps.write(
      `${JSON.stringify({
        kind: "triple",
        triple: formatTriple(parsed.triple),
        harness: parsed.triple.harness,
        model: parsed.triple.model,
        effort: parsed.triple.effort,
      })}\n`,
    );
    return deps.exit(0);
  }

  // Not a triple → a panel name. Panel members are raw launch-triple strings; the
  // deref echoes them verbatim (the doctor is the sole validator of their cube
  // membership), never re-resolving a named catalog preset (retired, ADR 0033).
  let host: HostTriples;
  try {
    host = deps.loadHostTriplesFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  // `default` is reserved and can never be a launch triple, so here it aliases the
  // configured default panel — dereferenced to its real name.
  let lookup = name;
  if (name === "default") {
    if (host.panelDefault === null || host.panelDefault === "") {
      deps.writeErr(
        "Error: 'default' given but no default panel set in panel.yaml.\n",
      );
      return deps.exit(2);
    }
    lookup = host.panelDefault;
  }

  const members = host.panels[lookup];
  if (members !== undefined) {
    deps.write(`${JSON.stringify({ kind: "panel", name: lookup, members })}\n`);
    return deps.exit(0);
  }

  const panelNames = Object.keys(host.panels).sort();
  deps.writeErr(
    `Error: '${name}' is neither a well-formed launch triple ` +
      `(harness::model::effort) nor a known panel. ${parsed.error}. ` +
      `Panels: ${panelNames.length > 0 ? panelNames.join(", ") : "(none)"}.\n`,
  );
  return deps.exit(2);
}

/**
 * Load the v2 host matrix as `MatrixV2 | null` — `absent` flattens to null (the
 * `presets list`/`providers check` claude-only-world handling predates ADR 0036
 * and stays as-is), while any OTHER four-state failure (unparseable/valid-but-
 * empty/schema-invalid) still throws {@link MatrixConfigError} for the caller to
 * render fail-loud. `providers resolve` calls {@link MainDeps.loadMatrixFn}
 * directly instead — an absent matrix there IS the fail-loud case.
 */
function loadMatrixOrNull(deps: MainDeps): MatrixV2 | null {
  try {
    return deps.loadMatrixFn();
  } catch (exc) {
    if (exc instanceof MatrixConfigError && exc.state === "absent") {
      return null;
    }
    throw exc;
  }
}

/** One resolved row of the `dispatch:` per-verb table `presets list` renders:
 *  the operator-configured triple when the catalog's `dispatch.<verb>` row is
 *  set, else the compiled floor rendered as its `claude::<model>::<effort>`
 *  triple (the floor's implicit harness — dispatch is claude-only until
 *  harness dispatch lands, ADR 0040); `handoff`'s fully-absent floor renders
 *  `triple: null`. `floored` marks a row that fell through to the compiled
 *  default rather than an operator-configured value. */
interface DispatchListRow {
  verb: DispatchVerb;
  triple: string | null;
  floored: boolean;
}

/**
 * Build the per-verb `dispatch:` table for `presets list`: every {@link
 * DispatchVerb} in {@link DISPATCH_FLOORS}' declared (canonical) order,
 * resolved from the catalog's configured triple or the compiled floor — the
 * SAME floor `resolveDispatchLaunchConfig` (`src/dispatch-launch-config.ts`)
 * applies at dispatch time, so a floored row here is never a display-only lie
 * about what actually launches. Pure over the catalog.
 */
function buildDispatchListRows(catalog: PresetCatalog): DispatchListRow[] {
  const verbs = Object.keys(DISPATCH_FLOORS) as DispatchVerb[];
  return verbs.map((verb) => {
    const configured = catalog.dispatch?.[verb] ?? null;
    if (configured !== null) {
      return { verb, triple: formatTriple(configured), floored: false };
    }
    const floor = DISPATCH_FLOORS[verb];
    if (floor.model === undefined || floor.effort === undefined) {
      return { verb, triple: null, floored: true };
    }
    return {
      verb,
      triple: formatTriple({
        harness: "claude",
        model: floor.model,
        effort: floor.effort,
      }),
      floored: true,
    };
  });
}

/**
 * The strength-band display ladder (ADR 0046): weak, light, standard, strong,
 * max sort first, in that order; an unrecognized or absent band (a legacy
 * list-form panel, or an object-form one whose `strength` didn't harvest)
 * sorts last. Presentation-only — band vocabulary is NOT enforced here (that
 * is the plan plugin's structural gate over the committed roster); an unknown
 * string is displayed and ordered last, never rejected.
 */
const PANEL_BAND_ORDER: readonly string[] = [
  "weak",
  "light",
  "standard",
  "strong",
  "max",
];

function panelBandRank(strength: string): number {
  const i = PANEL_BAND_ORDER.indexOf(strength);
  return i === -1 ? PANEL_BAND_ORDER.length : i;
}

/** Panel names ordered weak→strong by band ({@link PANEL_BAND_ORDER}), then
 *  name — the order both `presets list` output forms render panels in. */
function sortedPanelNames(host: HostTriples): string[] {
  return Object.keys(host.panels).sort((a, b) => {
    const rank =
      panelBandRank(host.panelMeta[a]?.strength ?? "") -
      panelBandRank(host.panelMeta[b]?.strength ?? "");
    return rank !== 0 ? rank : a.localeCompare(b);
  });
}

/**
 * `presets list [--json]`: the discovery surface — the virtual launch cube plus
 * the four harness defaults, the resolved `dispatch:` per-verb table, and the
 * configured panels. Enumerates every triple the host matrix defines (cell AND
 * launch-only capabilities, launch ids fanned over effective efforts, an
 * axisless harness emitting `na`) grouped per harness, echoes the four
 * `<harness>_default` triples and each panel's ordered members + strength +
 * description read from the host files, and resolves every dispatch verb to
 * its configured triple or compiled floor ({@link buildDispatchListRows}),
 * flagging a floored row. Panels are ordered weak→strong by band then name
 * ({@link sortedPanelNames}) in both output forms. Human-readable by default,
 * `--json` ({kind:"presets-list", harnesses, defaults, dispatch, panels,
 * default}) for machine consumption. A malformed matrix / host file / preset
 * catalog is fail-loud (exit 2); an ABSENT matrix is the claude-only world
 * with an empty cube, never a crash.
 */
function runPresetsList(deps: MainDeps, json: boolean): never {
  let matrix: MatrixV2 | null;
  let host: HostTriples;
  let catalog: PresetCatalog;
  try {
    matrix = loadMatrixOrNull(deps);
    host = deps.loadHostTriplesFn();
    catalog = deps.loadPresetCatalogFn();
  } catch (exc) {
    if (exc instanceof MatrixConfigError || exc instanceof ConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  const harnesses = matrix === null ? [] : enumerateTriplesV2(matrix);
  const defaults = {
    claude: host.defaults.claude ?? null,
    pi: host.defaults.pi ?? null,
  };
  const panelNames = sortedPanelNames(host);
  const dispatchRows = buildDispatchListRows(catalog);

  if (json) {
    deps.write(
      `${JSON.stringify({
        kind: "presets-list",
        harnesses: harnesses.map((group) => ({
          harness: group.harness,
          triples: group.triples.map((t) => ({
            triple: t.triple,
            capability: t.capability,
            native_id: t.launch_id,
            effort: t.effort,
            cell: t.cell,
          })),
        })),
        defaults,
        dispatch: dispatchRows,
        panels: panelNames.map((name) => ({
          name,
          strength: host.panelMeta[name]?.strength ?? "",
          description: host.panelMeta[name]?.description ?? "",
          members: host.panels[name] ?? [],
        })),
        default: host.panelDefault,
      })}\n`,
    );
    return deps.exit(0);
  }

  const lines: string[] = [`Launch cube (${matrixConfigPath()}):`];
  if (harnesses.length === 0) {
    lines.push(
      "  (no matrix — claude-only embedded defaults, no enumerable triples)",
    );
  } else {
    for (const group of harnesses) {
      lines.push(`  ${group.harness}:`);
      if (group.triples.length === 0) {
        lines.push("    (no models)");
      } else {
        for (const t of group.triples) {
          const tag = t.cell ? "" : " (launch-only)";
          lines.push(`    ${t.triple}${tag}`);
        }
      }
    }
  }
  lines.push(`Harness defaults (${presetsCatalogPath()}):`);
  for (const harness of ["claude", "pi"] as const) {
    lines.push(`  ${harness}_default  ${defaults[harness] ?? "(unset)"}`);
  }
  lines.push(`Dispatch table (${presetsCatalogPath()}):`);
  for (const row of dispatchRows) {
    const tag = row.floored ? " (floored)" : "";
    lines.push(`  ${row.verb}  ${row.triple ?? "(none)"}${tag}`);
  }
  lines.push(`Panels (${panelConfigPath()}):`);
  if (panelNames.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of panelNames) {
      const marker = host.panelDefault === name ? " (default)" : "";
      const meta = host.panelMeta[name];
      const band = meta?.strength ? meta.strength : "(no strength)";
      const description = meta?.description ?? "";
      lines.push(
        `  ${name} [${band}]${marker}  ${description}  [${(host.panels[name] ?? []).join(", ")}]`,
      );
    }
  }
  deps.write(`${lines.join("\n")}\n`);
  return deps.exit(0);
}

/** `providers` (host-matrix doctor) JSON contract version. */
const PROVIDERS_SCHEMA_VERSION = 1;
/** `providers resolve`: a wrapped model has no configured provider (no_route). */
const PROVIDERS_NO_ROUTE_EXIT = 3;
/** `providers check`: one or more roster/triple/reachability drift findings. */
const PROVIDERS_CHECK_DRIFT_EXIT = 9;
/** `providers check`: a host launch triple the operator wrote is malformed — a
 *  tool fault (the config is broken), distinct from off-cube drift (exit 9). */
const PROVIDERS_CHECK_FAULT_EXIT = 1;

/**
 * `providers resolve <model> <effort>`: emit the winning serving candidate for a
 * model from the host matrix, plus the defaults block. A native (claude) model
 * resolves to the single claude candidate; a wrapped model resolves to the
 * pecking-order-winning foreign candidate (v2/ADR 0036/0010: a capability served
 * by more than one provider is one axis value owned by the first, every later
 * entry shadowed). An UNROUTABLE wrapped model (no configured provider) exits
 * with the distinct `no_route` code; a bad model/effort token exits 2; a
 * malformed matrix exits 2. An ABSENT matrix is a typed loud failure (ADR 0036 —
 * the host matrix is REQUIRED): it exits 2 naming the absent state and the
 * copy-the-example fix, never a silent claude-native fallback candidate.
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
  let matrix: MatrixV2;
  try {
    matrix = deps.loadMatrixFn();
  } catch (exc) {
    if (exc instanceof MatrixConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }
  const result: ResolveResult = resolveModelV2(matrix, model);
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
  const defaults = matrix.defaults;
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

/** One rendered `providers check` finding — the structured fields plus a
 *  human-readable `line` for stderr. */
type RenderedProviderFinding = { kind: string; line: string } & Record<
  string,
  unknown
>;

/** Render a host launch-triple finding into its envelope + stderr-line form. */
function renderHostTripleFinding(
  f: HostTripleFinding,
): RenderedProviderFinding {
  if (f.kind === "malformed-triple") {
    return {
      kind: f.kind,
      source: f.source,
      triple: f.triple,
      error: f.error,
      line: `malformed launch triple at ${f.source}: '${f.triple}' — ${f.error}`,
    };
  }
  return {
    kind: f.kind,
    source: f.source,
    triple: f.triple,
    line: `launch triple at ${f.source}: '${f.triple}' is outside the enumerable cube (drift)`,
  };
}

/**
 * `providers check`: the host-matrix doctor. Reports roster-vs-binary-reachability
 * drift and lints the operator's host launch triples (the four defaults, every
 * `dispatch:` verb, panel members) against the enumerable cube — one line per
 * finding on stderr, the structured findings as a JSON line on stdout. An ABSENT
 * matrix is clean (exit 0, claude-only defaults, nothing to drift). A malformed
 * matrix OR a malformed host triple is a tool fault (exit 1); a well-formed triple
 * outside the cube (or an unreachable binary) is drift (exit 9). Read-only — never
 * mutates config.
 */
function runProvidersCheck(deps: MainDeps): never {
  let matrix: MatrixV2 | null;
  try {
    matrix = loadMatrixOrNull(deps);
  } catch (exc) {
    if (exc instanceof MatrixConfigError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(PROVIDERS_CHECK_FAULT_EXIT);
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
  // The operator's host launch triples, linted against the cube. A missing/invalid
  // host file is not fatal to the roster axis — treat it as no host triples (the
  // triple-drift axis is simply empty).
  let host: HostTriples;
  try {
    host = deps.loadHostTriplesFn();
  } catch (exc) {
    if (exc instanceof ConfigError) {
      host = {
        defaults: {},
        dispatch: {},
        panels: {},
        panelMeta: {},
        panelDefault: null,
      };
    } else {
      throw exc;
    }
  }
  const tripleFindings = lintHostTriplesV2(matrix, hostTripleRefs(host));
  const rendered: RenderedProviderFinding[] = [
    ...providerCheckFindingsV2(matrix, deps.providerReachableFn).map((f) => ({
      kind: f.kind,
      provider: f.provider,
      binary: f.binary,
      line: `provider '${f.provider}' binary '${f.binary}' is not reachable on PATH`,
    })),
    ...tripleFindings.map(renderHostTripleFinding),
  ];
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
      "providers check: roster, binaries, and host launch triples all consistent.\n",
    );
    return deps.exit(0);
  }
  // A malformed host triple is a tool fault (exit 1); everything else is drift
  // (exit 9). A fault dominates when both are present.
  const fault = tripleFindings.some((f) => f.kind === "malformed-triple");
  deps.writeErr(`providers check: ${rendered.length} finding(s).\n`);
  return deps.exit(
    fault ? PROVIDERS_CHECK_FAULT_EXIT : PROVIDERS_CHECK_DRIFT_EXIT,
  );
}

/**
 * `accounts check [--json]`: the read-only account-routing diagnostic. Reports
 * integration health, observation age, PII-free candidates, and the route the
 * per-launch policy WOULD pick — WITHOUT recording a reservation or launching
 * anything. A machine diagnostic (the `--json` snapshot the operator/tests
 * consume), not a replacement usage viewer. Always exits 0: a disabled or absent
 * integration is a reported state, not an error.
 */
function runAccountsCheck(deps: MainDeps, json: boolean): never {
  const inspection = deps.inspectRoutingFn();
  if (json) {
    deps.write(`${JSON.stringify(inspection)}\n`);
    return deps.exit(0);
  }
  deps.write(
    `account routing: health=${inspection.health} ` +
      `fresh=${inspection.fresh} enabled=${inspection.enabled}\n`,
  );
  deps.write(
    `would choose: ${inspection.would_choose.id} ` +
      `(${inspection.would_choose.reason})\n`,
  );
  for (const c of inspection.candidates) {
    deps.write(
      `  ${c.id} [${c.kind}] worst-util=${c.worst_utilization.toFixed(3)}\n`,
    );
  }
  return deps.exit(0);
}

/**
 * `resume <name-or-id> [prompt...]`: the harness-agnostic re-attach verb.
 * Resolves `target` through the resume-policy module (via the
 * {@link MainDeps.resolveResumeDecisionFn} subprocess seam), refuses a live
 * target / reports ambiguity / an unknown target without launching anything,
 * then relaunches the matched partner as a detached interactive TUI in its
 * RECORDED cwd — a FRESH tracked job (never folded onto the resolved row),
 * carrying the matched row's current title as the launch name so a later
 * resume by the same name chains onto this newer lineage.
 */
function runResumeSubcommand(
  deps: MainDeps,
  target: string,
  rest: string[],
): never {
  const prompt = rest.join(" ");
  let decision: ResumeDecision;
  try {
    decision = deps.resolveResumeDecisionFn(target);
  } catch (err) {
    deps.writeErr(
      `Error: keeper agent resume: cannot resolve '${target}': ` +
        `${(err as Error).message}\n`,
    );
    return deps.exit(2);
  }

  if (decision.kind === "unknown") {
    deps.writeErr(
      `Error: keeper agent resume: no partner session found matching '${target}'.\n`,
    );
    return deps.exit(2);
  }
  if (decision.kind === "live") {
    deps.writeErr(
      `Error: keeper agent resume: '${target}' resolves to a LIVE ` +
        `${displayAgent(decision.harness)} session (job ${decision.job_id}` +
        `${decision.title !== null ? `, "${decision.title}"` : ""}). It is ` +
        `still running — message it instead: ` +
        `keeper bus chat send ${decision.job_id} "<msg>"\n`,
    );
    return deps.exit(2);
  }
  if (decision.kind === "ambiguous") {
    deps.writeErr(
      `Error: keeper agent resume: '${target}' is ambiguous among ` +
        `${decision.candidates.length} equally-recent sessions:\n`,
    );
    for (const c of decision.candidates) {
      deps.writeErr(
        `  ${c.job_id}  ${c.harness}  ${c.title ?? "(untitled)"}  ` +
          `updated_at=${c.updated_at}\n`,
      );
    }
    deps.writeErr("Resume by the exact job id to disambiguate.\n");
    return deps.exit(2);
  }
  if (decision.kind === "harness-mismatch") {
    deps.writeErr(
      `Error: keeper agent resume: '${target}' did not resolve to a ` +
        `${decision.require_harness} session (newest match: ` +
        `${decision.harness} job ${decision.job_id}).\n`,
    );
    return deps.exit(2);
  }
  if (decision.kind === "no-target") {
    deps.writeErr(
      `Error: keeper agent resume: matched ${decision.harness} job ` +
        `${decision.job_id}${decision.title !== null ? ` ("${decision.title}")` : ""} ` +
        `has no resume target — it cannot be resumed.\n`,
    );
    return deps.exit(2);
  }

  // decision.kind === "ok"
  const cwd = decision.cwd;
  if (cwd === null || cwd === "" || !existsSync(cwd)) {
    deps.writeErr(
      `Error: keeper agent resume: the recorded cwd for ${decision.harness} ` +
        `job ${decision.job_id}${cwd ? ` ('${cwd}')` : ""} no longer exists ` +
        `— cannot resume there.\n`,
    );
    return deps.exit(2);
  }

  deps.writeErr(
    `Resuming ${displayAgent(decision.harness)} job ${decision.job_id}` +
      `${decision.title !== null ? ` ("${decision.title}")` : ""} in ${cwd}\n`,
  );

  // claude forks a NEW child session file on --resume (docs/adr/0034); the
  // child uuid is minted HERE (never by the builder) and pinned via
  // --session-id --fork-session. Other harnesses resume their existing
  // native session, so they carry no such id.
  const resumeSessionId =
    decision.harness === "claude" ? deps.randomUuid() : undefined;

  if (decision.harness === "pi") {
    try {
      stampPiPromptCompilerEnv(deps.env, {
        executablePath: deps.launcherArgvPrefix[0] ?? "",
        keeperCliPath: deps.launcherArgvPrefix[1] ?? "",
      });
    } catch (exc) {
      if (exc instanceof PiPromptArtifactsError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
  }

  let launchArgv: string[];
  try {
    launchArgv = buildAgentLaunchArgv({
      launcherArgvPrefix: [],
      cli: decision.harness,
      prompt,
      name: decision.title ?? undefined,
      resumeTarget: decision.resume_target,
      resumeSessionId,
    });
  } catch (exc) {
    if (exc instanceof ResumeLaunchUnsupportedError) {
      deps.writeErr(`Error: keeper agent resume: ${exc.message}\n`);
      return deps.exit(2);
    }
    throw exc;
  }

  // A resume launch must mint a FRESH job id — never fold onto the matched
  // row (Claude is immune: its --session-id above is explicit argv, not
  // env-carried). Pi derives identity from KEEPER_JOB_ID, which a
  // freshly-forked tmux SERVER would otherwise inherit from THIS process's own
  // ambient env (a resume launch with no explicit --x-tmux-session lands in
  // the shared 'keeper-agent' session, per tmux-launch.ts's resolveSession
  // fallback) — force it empty so identity always comes from the fresh mint.
  const tmuxLaunch = parseKeeperAgentTmuxArgs([
    ...launchArgv.slice(1),
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
  ]);
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`keeper agent resume: ${tmuxLaunch.error}\n`);
    return deps.exit(2);
  }

  try {
    const result = launchKeeperAgentInTmux({
      agent: decision.harness,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: launchEnvForAgent(decision.harness, deps.env),
      cwd,
      transcriptSessionId: null,
      startedAtMs: deps.now(),
      stateDir: deps.launcherStateDir,
      tmuxBin: deps.tmuxBin,
      launcherArgvPrefix: deps.launcherArgvPrefix,
      randomUuid: deps.randomUuid,
      runTmuxCommand: deps.runTmuxCommandFn,
    });
    deps.write(
      `${JSON.stringify({
        resumed: true,
        job_id: decision.job_id,
        harness: decision.harness,
        title: decision.title,
        cwd,
        run_id: result.id,
        session: result.session,
        window_id: result.windowId,
        attach_command: result.attachCommand,
      })}\n`,
    );
    return deps.exit(0);
  } catch (exc) {
    if (exc instanceof TmuxLaunchError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return deps.exit(exc.exitCode);
    }
    throw exc;
  }
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
  if (dispatch.kind === "providers-resolve") {
    return runProvidersResolve(deps, dispatch.model, dispatch.effort);
  }
  if (dispatch.kind === "providers-check") {
    return runProvidersCheck(deps);
  }
  if (dispatch.kind === "accounts-check") {
    return runAccountsCheck(deps, dispatch.json);
  }
  if (dispatch.kind === "resume") {
    return runResumeSubcommand(deps, dispatch.target, dispatch.rest);
  }

  // Resolve the leading-token harness. `run` carries it directly; the
  // harnessless `run-preset` form drives it from the launch triple's harness
  // segment. The triple (CLI flag or harnessless head) resolves per field below the
  // explicit-flag / env slots; a head agent disagreeing with the triple's harness
  // is rejected.
  let agent: AgentKind;
  let argv: string[];
  let dispatchPresetName: string | null = null;
  if (dispatch.kind === "run-preset") {
    dispatchPresetName = dispatch.presetName;
    const parsedTriple = parseTriple(dispatch.presetName);
    if (!parsedTriple.ok) {
      deps.writeErr(`Error: --x-preset ${parsedTriple.error}\n`);
      return deps.exit(2);
    }
    agent = parsedTriple.triple.harness;
    argv = dispatch.rest;
  } else {
    agent = dispatch.agent;
    argv = dispatch.rest;
  }
  // The injected resolved bins, keyed by harness — the descriptor-lookup form of
  // the old `agent === "claude" ? … : …` chain (byte-identical selection).
  const bins: Record<AgentKind, string> = {
    claude: deps.claudeBin,
    pi: deps.piBin,
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

  // Bind every Pi descendant to this launcher's already-resolved compiler
  // prefix. Stamp before the tmux split so an outer delegator forwards the same
  // executable + checkout to the inner launcher, which then preflights once.
  if (agent === "pi") {
    try {
      stampPiPromptCompilerEnv(deps.env, {
        executablePath: deps.launcherArgvPrefix[0] ?? "",
        keeperCliPath: deps.launcherArgvPrefix[1] ?? "",
      });
    } catch (exc) {
      if (exc instanceof PiPromptArtifactsError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
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

  // Launch-triple resolution: the `--x-preset` flag value (or the harnessless
  // head, already mirrored onto parsed.launcherPreset). Parse it once here so its
  // model/effort/thinking can layer into the resolver default slots BELOW the
  // explicit-flag / effort-env precedence. A head agent disagreeing with the
  // triple's harness is fail-loud — never silently re-route the launch.
  const presetName = parsed.launcherPreset ?? dispatchPresetName;
  let resolvedPreset: Preset | null = null;
  if (presetName !== null) {
    const parsedTriple = parseTriple(presetName);
    if (!parsedTriple.ok) {
      deps.writeErr(`Error: --x-preset ${parsedTriple.error}\n`);
      return deps.exit(2);
    }
    resolvedPreset = presetFromTriple(parsedTriple.triple);
    if (dispatch.kind === "run" && resolvedPreset.harness !== agent) {
      deps.writeErr(
        `Error: --x-preset ${presetName} pins harness ` +
          `${resolvedPreset.harness}, but the ${agent} subcommand was given.\n`,
      );
      return deps.exit(2);
    }
    actionLog.push(
      `Resolved triple '${presetName}' (${resolvedPreset.harness})`,
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
  const passthroughFlags = new Set(["-h", "--help", "-v", "--version"]);
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
      const defaultTriple = harnessDefaultTriple(agent, catalog);
      if (defaultTriple !== null) {
        resolvedPreset = presetFromTriple(defaultTriple);
        actionLog.push(
          `Resolved ${agent}_default triple '${formatTriple(defaultTriple)}'`,
        );
      }
    }
    // Shared readiness core (same as the run gate): the resolved model AND the
    // harness's second axis (effort for Claude, thinking for Pi) must both
    // resolve from the triple or an explicit flag.
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
        deps.ensureClaudeStateSharingFn(actionLog);
      });
    } catch (exc) {
      if (exc instanceof StateError || exc instanceof ConfigError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
  } else if (agent === "pi") {
    // Compile before touching Pi's state root or resolving Pi launch resources.
    // This inner-only branch covers managed and passthrough launches; the outer
    // tmux delegator returns above and the pane re-exec performs the preflight.
    try {
      phase("ensure Pi prompt artifacts", () => {
        deps.ensurePiPromptArtifactsFn(actionLog);
      });
      phase("ensure shared Pi state", () => {
        deps.ensurePiStateSharingFn(actionLog);
      });
    } catch (exc) {
      if (exc instanceof PiPromptArtifactsError || exc instanceof StateError) {
        deps.writeErr(`Error: ${exc.message}\n`);
        return deps.exit(1);
      }
      throw exc;
    }
  }

  if (shouldPassthrough) {
    const ptCmd = [bin];
    ptCmd.push(...remainingArgs);
    if (launcherVeryVerbose) {
      printVerbose(deps, actionLog, ptCmd.join(" "));
    }
    return runPassthrough(ptCmd, deps.spawn, deps.exit, {
      env: deps.env,
      cwd: deps.cwd,
    });
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

  // The account router owns every Claude launch. Pi launches against its one
  // canonical account.

  // Build agent command.
  let runCmd = [bin, ...remainingArgs];
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
    // This mutation reaches Claude because runWithJobControl passes deps.env to
    // defaultSpawn, which materializes the map instead of using inherit-mode.
    // Bun's inherited environ can ignore deletes from the launcher's env view;
    // keep the explicit spread in run.ts or this strip silently no-ops and
    // Claude keeps $TMUX → caps to 256-color.
    delete deps.env.TMUX;
    delete deps.env.TMUX_PANE;
    actionLog.push("Stripped TMUX/TMUX_PANE for truecolor");
  }

  if (agent === "claude") {
    scrubInheritedClaudeSessionEnv(deps.env, actionLog);
  }

  // ── Claude account routing — the single Claude process-boundary decision ──
  // Every Claude start/resume/restore resolves an account route from the latest
  // validated observation. Selection is INDEPENDENT per launch: no prior
  // attribution or conversation identity participates (cross-account resume stays
  // conversation-correct via claude-swap's --share-history). The router fails open
  // to the native default whenever an integration is unavailable or balancing is
  // disabled, so a native decision preserves the launch byte-for-byte. A managed
  // decision wraps the already-built Claude argv in the public
  // `cswap run <slot> --share-history -- <argv…>` contract, letting claude-swap
  // own account isolation and the exec handoff. The PII-free route id rides
  // KEEPER_ACCOUNT_ROUTE on BOTH paths — it survives claude-swap's same-account
  // fast path, so route identity never depends on CLAUDE_CONFIG_DIR. A separate
  // optional ordinal carries only the selected position in a multi-account
  // cswap inventory; sparse slot numbers are never shown as account ordinals.
  if (agent === "claude") {
    const route = deps.selectAccountRouteFn();
    deps.env[KEEPER_ACCOUNT_ROUTE_ENV] = route.id;
    delete deps.env[KEEPER_ACCOUNT_ORDINAL_ENV];
    if (route.accountOrdinal !== undefined) {
      deps.env[KEEPER_ACCOUNT_ORDINAL_ENV] = String(route.accountOrdinal);
    }
    actionLog.push(`Resolved account route: ${route.id} (${route.reason})`);
    note(`route: ${route.id}`);
    if (route.kind === "managed" && route.slot !== null) {
      runCmd = composeManagedClaudeArgv({
        cswapBin: deps.cswapBin,
        slot: route.slot,
        nativeClaudeArgv: runCmd,
      });
      actionLog.push(`Routed through claude-swap slot ${route.slot}`);
    }
  }

  if (launcherVeryVerbose) {
    printVerbose(deps, actionLog, formatCommand(runCmd));
  }

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
          configDir: null,
          pinnedSessionId: sessionUuid,
          hasContinueOrResume,
          remainingArgs,
        })
      : undefined;
  return runWithJobControl(runCmd, deps.spawn, deps.exit, onChildSpawned, {
    env: deps.env,
    cwd: deps.cwd,
  });
}

/**
 * Arm the birth record for a Pi launch: resolve the keeper job identity,
 * export it to the harness child, and return the post-spawn callback that writes
 * the maildir record. Claude is exempt because its SessionStart hook is
 * authoritative for both presence and resume seed.
 *
 * Identity (the job id) and the resume key (the harness-native target) stay
 * distinct: on a resume the `resume_target` is read from the harness-native argv
 * token ({@link resumeTargetFromArgv}), never the carried job id.
 */
function armBirthRecord(
  deps: MainDeps,
  agent: "pi",
  opts: {
    spawnName: string | null;
    configDir: string | null;
    /** The session id keeper pinned at launch. */
    pinnedSessionId: string | null;
    hasContinueOrResume: boolean;
    /** The harness-native argv forwarded to the child. */
    remainingArgs: string[];
  },
): ChildSpawnedFn {
  const carried = (deps.env.KEEPER_JOB_ID ?? "").trim();
  let jobId: string;
  if (opts.hasContinueOrResume && carried !== "") {
    jobId = carried;
  } else if (opts.pinnedSessionId !== null) {
    jobId = opts.pinnedSessionId;
  } else {
    jobId = deps.randomUuid();
  }
  deps.env.KEEPER_JOB_ID = jobId;
  const resumeTarget = opts.hasContinueOrResume
    ? resumeTargetFromArgv(opts.remainingArgs, agent)
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
 * the token following the harness's own resume flag. Returns
 * null when the token is absent or has no following value (a target-less
 * `--continue`/`resume`), so the caller stamps a null resume key rather than the
 * job id. Scanned ONLY on a resume relaunch, so a fresh launch whose prompt
 * happens to contain the verb never false-matches. Pure.
 */
function resumeTargetFromArgv(args: string[], agent: "pi"): string | null {
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
 * available and the cwd ordinal fallback otherwise. Claude and Pi turn that into `--name`.
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
