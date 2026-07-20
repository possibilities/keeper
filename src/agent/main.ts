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
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryCollection, roundTrip } from "../../cli/control-rpc";
import {
  constructObservedFableFocus,
  inspectRouting,
  modelHasFableIntent,
  type RequestedRouteResolution,
  type RouteResolution,
  type RouteSelection,
  type RoutingInspection,
  resolveObservedManagedRoute,
  selectRoute,
  selectRouteByAccountOrdinal,
} from "../account-router";
import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  cswapListArgv,
  existingCswapAccountConfigDir,
  KEEPER_ACCOUNT_ORDINAL_ENV,
  KEEPER_ACCOUNT_ROUTE_ENV,
  MAX_OUTPUT_BYTES,
  resolveCodexAccountRoutingRoot,
  resolveCswapCommand,
  SUBPROCESS_TIMEOUT_MS,
} from "../account-routing-config";
import {
  awaitProviderLegGrant,
  type BirthOwnerTuple,
  type BirthRecordDraft,
  birthRootFromIntentPath,
  buildBirthDraft,
  consumeProviderLegGrant,
  defaultBirthDir,
  emitBirthRecord,
  PROVIDER_LEG_GATE_ENV,
  PROVIDER_LEG_LAUNCH_ID_ENV,
  PROVIDER_LEG_LAUNCHER_PID_ENV,
  PROVIDER_LEG_LAUNCHER_START_TIME_ENV,
  PROVIDER_LEG_SHIM_PROCESS_TITLE,
  PROVIDER_LEG_WRAPPER_ATTEMPT_ENV,
  PROVIDER_LEG_WRAPPER_JOB_ID_ENV,
  parseProviderLegLaunchCarrier,
  writeBirthIntent,
} from "../birth-record";
import {
  acquirePartnerCaptureLease,
  BusSendAttemptError,
  type BusSendResult,
  type PartnerCaptureLease,
  type PublishedBusArtifact,
  publishBusArtifact,
  removeBusArtifact,
  resolveBusArtifactRoot,
  sendBusArtifact,
} from "../bus-artifact";
import {
  type CodexObservationRefreshFailureState,
  makeCodexBoundedRunner,
  readCodexObservationRefreshFailureState,
  refreshCodexObservationIfStale,
} from "../codex-account-observation-refresh";
import {
  CODEX_NATIVE_FALLBACK_WARNING,
  type CodexRoutingInspection,
  inspectCodexRouting,
  selectCodexRoute,
} from "../codex-account-router";
import {
  activateCodexPool,
  armCodexPoolProofWindow,
  CODEX_POOL_DEGRADED_VERDICT,
  CODEX_POOL_PROOF_WINDOW_ENV,
  type CodexPoolActivationAuthorization,
  type CodexPoolActivationDeps,
  type CodexPoolProblemCode,
  type CodexPoolProofWindowState,
  type CodexPoolWorkflowResult,
  captureCodexPoolProof,
  codexPoolAliasesFromEnvironment,
  codexPoolBindings,
  codexPoolObservationVerifies,
  codexPoolStatus,
  effectiveCodexPoolActivation,
  FileCodexPoolActivationStore,
  recoverCodexPool,
  resolveKeeperRevision,
  rollbackCodexPool,
  verdictCodexPoolProof,
  verifyCodexPool,
} from "../codex-pool-activation";
import { DISPATCH_FLOORS, type DispatchVerb } from "../dispatch-launch-config";
import { isDefaultTmuxEnvValue } from "../exec-backend";
import { normalizeUtcTimestamp } from "../fable-focus";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "../keeper-agent-path";
import { runPanel } from "../pair/panel";
import type { FableFocusInput, NonFableFocusInput } from "../types";
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
  mergeClaudeWorkspaceTrust,
  type PiCodexPoolExtensionResolution,
  piExtensionArgs,
  READ_ONLY_DIRECTIVE,
  resolvePiCodexPoolExtension,
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
  modelArgValue,
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
  captureLivePartnerResponse,
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
import {
  type PartnerLifecycle,
  snapshotInjectedMessageCaptureBoundary,
  snapshotInvocationStopFloor,
  type TranscriptStop,
} from "./transcript-watch";
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

export interface CodexPoolLaunchContext {
  mode: "native" | "active";
  /**
   * The pool is active but pinned to a single healthy alias while the other is
   * quota-dead — launched as `active` routing, surfaced as `active-degraded` to
   * operators. Defaults to a balanced (non-degraded) active pool when absent.
   */
  degraded?: boolean;
  aliases: string[];
  config_binding: string;
  revision?: string;
  initial_alias: string | null;
  problem_code: CodexPoolProblemCode | null;
}

export interface CodexSessionRoutingInspection {
  activation: {
    mode: "native" | "active" | "active-degraded";
    problem_code: CodexPoolProblemCode | null;
  };
  companion: {
    health: PiCodexPoolExtensionResolution["health"];
    problem_code: PiCodexPoolExtensionResolution["problem_code"];
  };
  capacity: CodexRoutingInspection & {
    refresh_failure_state?: CodexObservationRefreshFailureState | null;
  };
}

export type CodexPoolOperatorOperation =
  | "status"
  | "proof-capture"
  | "proof-verdict"
  | "activate"
  | "verify"
  | "rollback"
  | "recover";

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
   * Publish the authority-visible Pi intent before spawn. A failure aborts the
   * launch rather than creating an invisible live process. The post-spawn birth
   * atomically replaces this intent; a publication failure leaves it behind so
   * terminal adoption remains fail-closed. Both seams keep tests off the real
   * birth maildir and `ps`; Claude uses its hook SessionStart instead.
   */
  writeBirthIntent: (draft: BirthRecordDraft) => string;
  emitBirthRecord: (
    draft: BirthRecordDraft,
    pid: number,
    intentPath: string,
  ) => void;
  /** Optional deterministic seam for the owned-leg pre-exec grant wait. */
  awaitProviderLegGrantFn?: (
    birthRoot: string,
    owner: BirthOwnerTuple,
  ) => Promise<boolean>;
  /** Optional deterministic seam for the final pid-preserving provider exec. */
  execProviderLegFn?: (command: string[], env: Record<string, string>) => never;
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
  resolvePiCodexPoolExtensionFn: () => PiCodexPoolExtensionResolution;
  codexPoolLaunchContextFn: (reserve?: boolean) => CodexPoolLaunchContext;
  inspectCodexSessionRoutingFn: () => CodexSessionRoutingInspection;
  runCodexPoolWorkflowFn: (
    operation: CodexPoolOperatorOperation,
    source?: string,
    authorization?: CodexPoolActivationAuthorization | null,
  ) => CodexPoolWorkflowResult;
  /**
   * Best-effort refresh of the codex routing observation sidecar before an
   * activate/verify workflow reads it through `inspectCodexRouting` — the
   * verification gate needs a fresh observation and nothing else in the CLI
   * path produces one. A failed refresh is swallowed; verify still gates.
   */
  refreshCodexObservationFn: () => Promise<void>;
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
  publishBusArtifactFn: (root: string, body: string) => PublishedBusArtifact;
  removeBusArtifactFn: (root: string, id: string) => boolean;
  sendBusArtifactFn: (
    sockPath: string,
    artifact: PublishedBusArtifact,
    target: string,
    mediaType?: string,
    beforePublish?: () => boolean,
  ) => Promise<BusSendResult>;
  acquirePartnerCaptureLeaseFn: (
    root: string,
    partnerJobId: string,
  ) => PartnerCaptureLease | null;
  resolveBusArtifactRootFn: () => string;
  /**
   * Resolve one mandatory managed account for a Claude launch. Selection is
   * independent per start/resume/restore and fails before process creation when
   * no fresh routeable claude-swap account exists.
   */
  selectAccountRouteFn: (
    model: string | null,
    fableIntent: boolean | null,
  ) => RouteResolution;
  /**
   * Resolve a human-requested zero-based Claude account index exactly. Unlike
   * automatic routing this is fail-loud and never substitutes another account.
   */
  selectAccountRouteByOrdinalFn: (
    ordinal: number,
    model: string | null,
    fableIntent: boolean | null,
  ) => RequestedRouteResolution;
  /** Resolve stored process-lineage intent for an agent-native continuation. */
  resolveFableIntentFn: (target: string) => Promise<boolean | null>;
  setFableFocusFn: (
    focus: FableFocusInput | null,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  setNonFableFocusFn: (
    focus: NonFableFocusInput | null,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * Read-only account-routing diagnostic behind `accounts check` — reports
   * integration health, snapshot age, PII-free candidates, and the route policy
   * would choose WITHOUT recording a reservation. `realDeps()` binds
   * {@link inspectRouting}.
   */
  inspectRoutingFn: (fableIntent?: boolean | null) => RoutingInspection;
  /** Read one exact jobs row through the daemon. Transport uncertainty remains
   *  unknown and can never be promoted to partner death. */
  probePartnerLifecycleFn: (jobId: string) => Promise<PartnerLifecycle>;
  /**
   * The claude-swap executable a MANAGED route wraps the launch through
   * (`cswap run <slot> --share-history -- <Claude argv…>`). `realDeps()` resolves
   * it via `KEEPER_CSWAP_BIN` / PATH; a seam keeps the managed byte-pins path-
   * independent.
   */
  cswapBin: string;
  resolveAccountConfigDirFn: (slot: number) => string;
  seedClaudeWorkspaceTrustFn: (configDir: string, cwd: string) => boolean;
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

function productionCodexPoolActivationDeps(
  env: NodeJS.ProcessEnv,
): CodexPoolActivationDeps {
  const aliases = codexPoolAliasesFromEnvironment(env);
  const bindings = codexPoolBindings(resolveKeeperRevision(), aliases);
  const store = new FileCodexPoolActivationStore();
  const verifies = (
    candidate: Parameters<CodexPoolActivationDeps["verify"]>[0],
  ) =>
    resolvePiCodexPoolExtension().health === "ready" &&
    codexPoolObservationVerifies(candidate, inspectCodexRouting());
  return {
    store,
    bindings,
    nowMs: () => Date.now(),
    reload: () => resolvePiCodexPoolExtension().health === "ready",
    verify: verifies,
  };
}

function productionCodexPoolWorkflow(
  env: NodeJS.ProcessEnv,
  operation: CodexPoolOperatorOperation,
  source?: string,
  authorization?: CodexPoolActivationAuthorization | null,
): CodexPoolWorkflowResult {
  try {
    const deps = productionCodexPoolActivationDeps(env);
    switch (operation) {
      case "status":
        return codexPoolStatus(deps);
      case "proof-capture":
        return source
          ? captureCodexPoolProof(deps, source)
          : {
              schema_version: 1,
              ok: false,
              operation,
              state: "native",
              problem_code: "proof-missing",
              proof: null,
            };
      case "proof-verdict":
        return verdictCodexPoolProof(deps, source);
      case "activate":
        return activateCodexPool(deps, source, authorization);
      case "verify":
        return verifyCodexPool(deps);
      case "rollback":
        return rollbackCodexPool(deps);
      case "recover":
        return recoverCodexPool(deps);
    }
  } catch {
    return {
      schema_version: 1,
      ok: false,
      operation,
      state: "native",
      problem_code: "activation-config-invalid",
      proof: null,
    };
  }
}

function productionCodexPoolLaunchContext(
  env: NodeJS.ProcessEnv,
  reserve = false,
): CodexPoolLaunchContext {
  try {
    const deps = productionCodexPoolActivationDeps(env);
    const effective = effectiveCodexPoolActivation(deps.store, deps.bindings);
    const inspection = inspectCodexRouting();
    const degraded = effective.mode === "active-degraded";
    const ready =
      (effective.mode === "active" || degraded) &&
      effective.state !== null &&
      codexPoolObservationVerifies(effective.state, inspection);
    const route = ready && reserve ? selectCodexRoute() : null;
    const routed = route === null || route.kind === "pooled";
    const pinnedAlias = degraded
      ? (effective.state?.degraded?.pinned_alias ?? null)
      : null;
    return {
      mode: ready && routed ? "active" : "native",
      degraded: ready && routed && degraded,
      aliases: [...deps.bindings.aliases],
      config_binding: deps.bindings.config_binding,
      revision: deps.bindings.revision,
      initial_alias:
        route?.kind === "pooled" ? route.alias : degraded ? pinnedAlias : null,
      problem_code:
        ready && routed
          ? null
          : (effective.problem_code ??
            (route?.kind === "native-fallback"
              ? route.reason
              : inspection.health === "missing"
                ? "observation-missing"
                : inspection.health === "stale"
                  ? "observation-stale"
                  : "pool-unavailable")),
    };
  } catch {
    return {
      mode: "native",
      aliases: ["keeper-codex-a", "keeper-codex-b"],
      config_binding: "0".repeat(64),
      initial_alias: null,
      problem_code: "activation-config-invalid",
    };
  }
}

function productionCodexSessionInspection(
  env: NodeJS.ProcessEnv,
): CodexSessionRoutingInspection {
  const companion = resolvePiCodexPoolExtension();
  const capacity = {
    ...inspectCodexRouting(),
    refresh_failure_state: readCodexObservationRefreshFailureState(
      resolveCodexAccountRoutingRoot(),
    ),
  };
  const launch = productionCodexPoolLaunchContext(env);
  return {
    activation: {
      mode:
        companion.health !== "ready"
          ? "native"
          : launch.degraded === true
            ? "active-degraded"
            : launch.mode,
      problem_code: companion.problem_code ?? launch.problem_code,
    },
    companion: {
      health: companion.health,
      problem_code: companion.problem_code,
    },
    capacity,
  };
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
  const cswapBin = resolveCswapCommand();
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
    writeBirthIntent: (draft) => writeBirthIntent(defaultBirthDir(), draft),
    emitBirthRecord: (draft, pid, intentPath) =>
      emitBirthRecord({}, draft, pid, intentPath),
    tmuxBin: resolveTmuxBin(process.env),
    launcherArgvPrefix,
    launcherStateDir: defaultKeeperAgentStateDir(process.env),
    transcriptHomeDir: homedir(),
    runTmuxCommandFn: defaultTmuxCommandRunner,
    resolveStatuslineSettingsPathFn: resolveKeeperPluginStatuslineSettingsPath,
    resolvePiExtensionArgsFn: () => piExtensionArgs(),
    resolvePiCodexPoolExtensionFn: () => resolvePiCodexPoolExtension(),
    codexPoolLaunchContextFn: (reserve) =>
      productionCodexPoolLaunchContext(process.env, reserve),
    inspectCodexSessionRoutingFn: () =>
      productionCodexSessionInspection(process.env),
    runCodexPoolWorkflowFn: (operation, source, authorization) =>
      productionCodexPoolWorkflow(
        process.env,
        operation,
        source,
        authorization,
      ),
    refreshCodexObservationFn: async () => {
      try {
        await refreshCodexObservationIfStale({
          stateDir: resolveCodexAccountRoutingRoot(),
          runner: makeCodexBoundedRunner(),
          nowMs: () => Date.now(),
          maxAgeMs: CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
        });
      } catch {
        // Verification gates on the observation; a failed refresh surfaces there.
      }
    },
    resolveResumeDecisionFn: (target, requireHarness) =>
      resolveResumeDecisionViaSubprocess(
        process.execPath,
        resumeResolveCliPath(),
        target,
        requireHarness,
      ),
    publishBusArtifactFn: publishBusArtifact,
    removeBusArtifactFn: removeBusArtifact,
    sendBusArtifactFn: sendBusArtifact,
    acquirePartnerCaptureLeaseFn: acquirePartnerCaptureLease,
    resolveBusArtifactRootFn: resolveBusArtifactRoot,
    selectAccountRouteFn: (model, fableIntent) =>
      selectRoute({ model, fableIntent }),
    selectAccountRouteByOrdinalFn: (ordinal, model, fableIntent) =>
      selectRouteByAccountOrdinal(ordinal, { model, fableIntent }),
    resolveFableIntentFn: (target) =>
      resolveStoredFableIntent(resolveAgentSockPath(process.env), target),
    setFableFocusFn: (focus) =>
      setFableFocus(resolveAgentSockPath(process.env), focus),
    setNonFableFocusFn: (focus) =>
      setNonFableFocus(resolveAgentSockPath(process.env), focus),
    inspectRoutingFn: (fableIntent = null) =>
      inspectRouting({
        model:
          fableIntent === true
            ? "fable"
            : fableIntent === false
              ? "non-fable"
              : null,
        fableIntent,
      }),
    probePartnerLifecycleFn: (jobId) =>
      probePartnerLifecycle(resolveAgentSockPath(process.env), jobId),
    cswapBin,
    resolveAccountConfigDirFn: (slot) =>
      resolveAccountConfigDir(cswapBin, slot),
    seedClaudeWorkspaceTrustFn: seedClaudeWorkspaceTrust,
  };
}

function resolveAccountConfigDir(cswapBin: string, slot: number): string {
  const [command, ...args] = cswapListArgv(cswapBin);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error("claude-swap account inventory is unavailable");
  }
  let inventory: unknown;
  try {
    inventory = JSON.parse(result.stdout);
  } catch {
    throw new Error("claude-swap account inventory is malformed");
  }
  return existingCswapAccountConfigDir(slot, inventory);
}

export function seedClaudeWorkspaceTrust(
  configDir: string,
  cwd: string,
): boolean {
  const canonicalCwd = realpathSync.native(cwd);
  const legacyPath = join(configDir, ".config.json");
  const configPath = existsSync(legacyPath)
    ? legacyPath
    : join(configDir, ".claude.json");
  const merge = mergeClaudeWorkspaceTrust(
    readFileSync(configPath, "utf8"),
    canonicalCwd,
  );
  if (!merge.ok) throw new Error(merge.error);
  if (!merge.changed) return false;

  const tmpPath = join(
    dirname(configPath),
    `.${basename(configPath)}.keeper-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, merge.body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tmpPath, configPath);
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
  return true;
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

const CODEX_POOL_PROOF_WINDOW_FLAG = "--x-codex-pool-proof-window=arm";

function consumeCodexPoolProofWindowFlag(args: string[]): {
  remainingArgs: string[];
  armed: boolean;
  error: string | null;
} {
  const prefix = "--x-codex-pool-proof-window";
  const matching = args.filter(
    (arg) => arg === prefix || arg.startsWith(`${prefix}=`),
  );
  return {
    remainingArgs: args.filter(
      (arg) => arg !== prefix && !arg.startsWith(`${prefix}=`),
    ),
    armed:
      matching.length === 1 && matching[0] === CODEX_POOL_PROOF_WINDOW_FLAG,
    error:
      matching.length === 0 ||
      (matching.length === 1 && matching[0] === CODEX_POOL_PROOF_WINDOW_FLAG)
        ? null
        : `${prefix} must appear once as ${CODEX_POOL_PROOF_WINDOW_FLAG}`,
  };
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
function tmuxErrorJson(
  exitCode: number,
  message: string,
  reasonOverride?: string,
): string {
  return `${JSON.stringify({
    schema_version: TMUX_SCHEMA_VERSION,
    error: true,
    reason: reasonOverride ?? tmuxErrorReason(exitCode),
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
      deps.write(
        tmuxErrorJson(
          TMUX_EXIT.RETRYABLE,
          result.error,
          result.reason === "partner_died" ? "partner_died" : undefined,
        ),
      );
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
    probePartnerLifecycle: deps.probePartnerLifecycleFn,
  };
}

function resolveAgentSockPath(env: NodeJS.ProcessEnv): string {
  const override = (env.KEEPER_SOCK ?? "").trim();
  return override !== ""
    ? override
    : join(homedir(), ".local", "state", "keeper", "keeperd.sock");
}

function continuationTarget(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--resume" || arg === "-r") {
      const value = args[i + 1];
      return value === undefined || value.startsWith("-") ? null : value;
    }
    if (arg?.startsWith("--resume=")) {
      return arg.slice("--resume=".length) || null;
    }
  }
  return null;
}

async function resolveStoredFableIntent(
  sockPath: string,
  target: string,
): Promise<boolean | null> {
  try {
    const rows = await queryCollection<Record<string, unknown>>(
      sockPath,
      "jobs",
      { job_id: target },
    );
    const row = rows[0];
    if (row?.fable_intent === 1 || row?.fable_intent === true) return true;
    if (row?.fable_intent === 0 || row?.fable_intent === false) return false;
    return modelHasFableIntent(
      typeof row?.current_model_id === "string" ? row.current_model_id : null,
    )
      ? true
      : null;
  } catch {
    return null;
  }
}

async function setFableFocus(
  sockPath: string,
  focus: FableFocusInput | null,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const id = crypto.randomUUID();
  try {
    const response = await roundTrip(
      sockPath,
      {
        type: "rpc",
        id,
        method: "set_autopilot_config",
        params: { fable_focus: focus },
      },
      id,
    );
    if (response.type === "rpc_result") return { ok: true };
    return {
      ok: false,
      code: response.type === "error" ? response.code : "focus_rpc_unexpected",
      message:
        response.type === "error"
          ? response.message
          : "unexpected daemon response while setting Fable focus",
    };
  } catch {
    return {
      ok: false,
      code: "focus_rpc_unreachable",
      message:
        "the daemon did not acknowledge the Fable focus update; inspect state before retrying",
    };
  }
}

async function setNonFableFocus(
  sockPath: string,
  focus: NonFableFocusInput | null,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const id = crypto.randomUUID();
  try {
    const response = await roundTrip(
      sockPath,
      {
        type: "rpc",
        id,
        method: "set_autopilot_config",
        params: { non_fable_focus: focus },
      },
      id,
    );
    if (response.type === "rpc_result") return { ok: true };
    return {
      ok: false,
      code: response.type === "error" ? response.code : "focus_rpc_unexpected",
      message:
        response.type === "error"
          ? response.message
          : "unexpected daemon response while setting Non-Fable focus",
    };
  } catch {
    return {
      ok: false,
      code: "focus_rpc_unreachable",
      message:
        "the daemon did not acknowledge the Non-Fable focus update; inspect state before retrying",
    };
  }
}

function resolveBusSockPath(env: NodeJS.ProcessEnv): string {
  const override = (env.KEEPER_BUS_SOCK ?? "").trim();
  return override !== ""
    ? override
    : join(homedir(), ".local", "state", "keeper", "bus.sock");
}

async function probePartnerLifecycle(
  sockPath: string,
  jobId: string,
): Promise<PartnerLifecycle> {
  try {
    const rows = await queryCollection<Record<string, unknown>>(
      sockPath,
      "jobs",
      { job_id: jobId },
    );
    const row = rows.find((candidate) => candidate.job_id === jobId);
    const state = row?.state;
    if (state === "ended" || state === "killed") {
      return { kind: "terminal", state, reason: null };
    }
    return row === undefined ? { kind: "unknown" } : { kind: "live" };
  } catch {
    return { kind: "unknown" };
  }
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
    transcriptHomeDir: deps.transcriptHomeDir,
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

  // A `timed_out` outcome means ONLY that the caller's observation deadline
  // elapsed — the Partner's termination is UNCONFIRMED, so it may still be
  // running. Never reap its window or stamp its control terminal (that would kill
  // a live Partner and discard a recoverable answer); leave it resident and
  // resumable, and surface honest liveness guidance. Keyed on the ORIGINAL
  // outcome so a failed --output write can never retroactively authorize teardown
  // after a timeout.
  if (result.envelope.outcome === "timed_out") {
    emitTimeoutGuidance(deps, result);
    return deps.exit(emitted.exitCode);
  }

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
 * Honest stderr guidance after a run-capture observation deadline elapses. The
 * captured message is a bounded partial, never a final answer, and the Partner
 * window is left resident. Positive liveness reports the Partner is still
 * running; unknown evidence says only that termination was not observed — neither
 * claims the partial is final, and both point at a non-resending recovery path
 * (`show-last-message`) plus a resumable re-wait.
 */
function emitTimeoutGuidance(deps: MainDeps, result: RunCaptureResult): void {
  const env = result.envelope;
  const target = env.transcript_path ?? env.handle;
  const pathAgent =
    target?.includes("/") === true && env.agent !== null
      ? ` --agent ${env.agent}`
      : "";
  const liveBusCapture =
    env.handle !== null &&
    env.transcript_path !== null &&
    !env.handle.startsWith("tmux-") &&
    env.handle !== env.transcript_path;
  const recovery =
    target === null
      ? ""
      : liveBusCapture
        ? ` Read its late answer without resending via ` +
          `\`keeper agent show-last-message ${target}${pathAgent}\`.`
        : ` Read its latest without resending via ` +
          `\`keeper agent show-last-message ${target}${pathAgent}\`, or keep waiting with ` +
          `\`keeper agent wait ${target}${pathAgent}\`.`;
  const elapsed =
    env.elapsed_seconds !== null ? ` after ${env.elapsed_seconds}s` : "";
  const partner =
    env.agent !== null ? `${displayAgent(env.agent)} Partner` : "Partner";
  if (result.timeoutLiveness === "live") {
    const job = env.resume_target !== null ? ` (job ${env.resume_target})` : "";
    deps.writeErr(
      `agent: observation deadline elapsed${elapsed} — the ${partner} is still ` +
        `running${job}. The captured message is a partial, not a final answer; ` +
        `the window was left resident.${recovery}\n`,
    );
    return;
  }
  deps.writeErr(
    `agent: observation deadline elapsed${elapsed} — termination was not ` +
      `observed for the ${partner}. The captured message is a partial, not a ` +
      `final answer; the window was left resident.${recovery}\n`,
  );
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
  const proofWindowRequest = consumeCodexPoolProofWindowFlag(rest);
  if (proofWindowRequest.error !== null) {
    deps.writeErr(`agent: ${proofWindowRequest.error}\n`);
    return emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args" }),
    );
  }
  const parsed = parseRunArgs(proofWindowRequest.remainingArgs);
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
  if (proofWindowRequest.armed && (agent !== "pi" || parsed.resume !== null)) {
    deps.writeErr(
      "agent: --x-codex-pool-proof-window=arm requires a fresh managed Pi session.\n",
    );
    return runBadArgs();
  }
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
              codexPoolProofWindow: proofWindowRequest.armed || undefined,
              name: parsed.name ?? undefined,
            },
            stopTimeoutMs: parsed.stopTimeoutMs,
          });
          return launched;
        },
        onLaunched: (launched) => {
          killWindowCommand = launched.killWindowCommand;
          control = {
            path:
              parsed.control?.path ??
              controlPath(deps.launcherStateDir, launched.runId),
            artifact: buildRunControlArtifact({
              runId: launched.runId,
              agent,
              startedAtMs: launched.handle.startedAtMs,
              killWindowCommand: launched.killWindowCommand,
              owner: parsed.control?.owner,
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
 * launch). Unknown / ambiguous / no-target decisions emit actionable bad_args;
 * Refuse-live routes to the exact Partner's existing Bus inbox instead.
 * Launch + capture happen in the RECORDED cwd (resume is cwd-scoped — the native
 * CLI finds the session only there), pinning the resumed session's id on the handle
 * so discovery + the envelope resume_target resolve the POST-resume id: claude's
 * freshly-forked child uuid. A positively-live decision takes the sibling path:
 * one exact-job Bus artifact and a transcript capture gated on its injection.
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
    return runLivePartnerCapture(deps, parsed, agent, verbDeps, decision);
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
            path:
              parsed.control?.path ??
              controlPath(deps.launcherStateDir, launched.runId),
            artifact: buildRunControlArtifact({
              runId: launched.runId,
              agent,
              startedAtMs: launched.handle.startedAtMs,
              killWindowCommand: launched.killWindowCommand,
              owner: parsed.control?.owner,
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

async function runLivePartnerCapture(
  deps: MainDeps,
  parsed: ParsedRunArgs,
  agent: AgentKind,
  verbDeps: VerbDeps,
  decision: Extract<ResumeDecision, { kind: "live" }>,
): Promise<never> {
  const emitBad = (message: string): never => {
    deps.writeErr(`${message}\n`);
    return emitRunCapture(
      deps,
      buildRunCaptureEnvelope({ outcome: "bad_args", agent }),
      parsed.output,
    );
  };
  if (
    decision.resume_target == null ||
    decision.resume_target === "" ||
    decision.cwd == null ||
    decision.cwd === ""
  ) {
    return emitBad(
      `agent: live Partner ${decision.job_id} has no exact transcript identity`,
    );
  }
  const composed = composeRunPrompt(deps, parsed);
  if (!composed.ok) return emitBad(composed.error.trimEnd());

  const startMs = deps.now();
  const artifactRoot = deps.resolveBusArtifactRootFn();
  const identityStillLive = (): boolean => {
    try {
      const current = deps.resolveResumeDecisionFn(decision.job_id, agent);
      return (
        current.kind === "live" &&
        current.job_id === decision.job_id &&
        current.pid === decision.pid &&
        current.start_time === decision.start_time &&
        current.resume_target === decision.resume_target &&
        current.cwd === decision.cwd
      );
    } catch {
      return false;
    }
  };

  const captured = await captureLivePartnerResponse(
    {
      ...runCaptureSeams(deps),
      acquire: () =>
        deps.acquirePartnerCaptureLeaseFn(artifactRoot, decision.job_id),
      publish: () => deps.publishBusArtifactFn(artifactRoot, composed.prompt),
      remove: (id) => {
        deps.removeBusArtifactFn(artifactRoot, id);
      },
      snapshotBoundary: () =>
        snapshotInjectedMessageCaptureBoundary({
          agent,
          cwd: decision.cwd as string,
          env: deps.env,
          homeDir: deps.transcriptHomeDir,
          startedAtMs: 0,
          sessionId: decision.resume_target as string,
        }),
      send: (artifact, beforePublish) =>
        deps.sendBusArtifactFn(
          resolveBusSockPath(deps.env),
          artifact as PublishedBusArtifact,
          decision.job_id,
          "text/markdown",
          beforePublish,
        ),
      identityStillLive,
      deliveryIsAmbiguous: (err) =>
        err instanceof BusSendAttemptError && err.deliveryAmbiguous,
    },
    verbDeps,
    {
      handle: {
        agent,
        cwd: decision.cwd,
        sessionId: decision.resume_target,
        startedAtMs: 0,
        transcriptPath: null,
        stopTimeoutMs: parsed.stopTimeoutMs,
        lifecycleJobId: decision.job_id,
      },
      handleId: decision.job_id,
      agent,
      startMs,
    },
  );

  switch (captured.disposition) {
    case "capture_busy":
      deps.writeErr(
        `agent: a response-bearing request is already active for exact Partner ${decision.job_id}.\n`,
      );
      break;
    case "identity_changed":
      deps.writeErr(
        `agent: exact Partner ${decision.job_id} changed identity before Bus publish; no message was sent.\n`,
      );
      break;
    case "boundary_unavailable":
      deps.writeErr(
        `agent: exact Partner ${decision.job_id} has no attributable transcript; no message was sent.\n`,
      );
      break;
    case "delivery_failed":
      deps.writeErr(
        `agent: Bus message to exact Partner ${decision.job_id} was not delivered${captured.detail ? `: ${captured.detail}` : "."}\n`,
      );
      break;
    case "capture_failed":
      deps.writeErr(
        `agent: response capture for exact Partner ${decision.job_id} failed after possible delivery${captured.detail ? `: ${captured.detail}` : "."}\n`,
      );
      break;
    case "delivery_ambiguous":
      deps.writeErr(
        `agent: Bus delivery acknowledgement for exact Partner ${decision.job_id} was ambiguous; the message was not resent, and capture waited for its transcript boundary.\n`,
      );
      break;
    case "captured":
      break;
  }
  return emitRunCapture(deps, captured.result, parsed.output);
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

const FABLE_FOCUS_COMMAND_SCHEMA_VERSION = 1;

function focusEnvelope(
  ok: boolean,
  data: unknown,
  error: { code: string; message: string; recovery: string } | null = null,
): string {
  return `${JSON.stringify({
    schema_version: FABLE_FOCUS_COMMAND_SCHEMA_VERSION,
    ok,
    error,
    data: ok ? data : null,
  })}\n`;
}

async function runFableFocusCommand(
  deps: MainDeps,
  operation: "show" | "set" | "clear",
  rest: string[],
): Promise<never> {
  const jsonCount = rest.filter((arg) => arg === "--json").length;
  const json = jsonCount === 1;
  const args = rest.filter((arg) => arg !== "--json");
  if (jsonCount > 1) {
    deps.writeErr("accounts fable-focus accepts --json at most once\n");
    return deps.exit(2);
  }
  const inspection = deps.inspectRoutingFn(true);
  const status = inspection.fable_focus ?? {
    configured: false,
    state: "unavailable",
    target_route: null,
    lifetime: null,
    target_eligible: null,
    outcome: "fallback",
    reason: "policy-unavailable",
    diagnostic: "delivery-unreachable",
  };
  const emitStatus = (): void => {
    if (json) deps.write(focusEnvelope(true, status));
    else {
      deps.write(
        `Fable focus: ${status.state} target=${status.target_route ?? "none"} ` +
          `outcome=${status.outcome} reason=${status.reason}\n`,
      );
    }
  };
  if (operation === "show") {
    if (args.length !== 0) {
      deps.writeErr("accounts fable-focus show accepts only --json\n");
      return deps.exit(2);
    }
    emitStatus();
    return deps.exit(0);
  }
  if (operation === "clear") {
    if (args.length !== 0) {
      deps.writeErr("accounts fable-focus clear accepts only --json\n");
      return deps.exit(2);
    }
    if (!status.configured && status.state === "off") {
      emitStatus();
      return deps.exit(0);
    }
    const result = await deps.setFableFocusFn(null);
    if (!result.ok) {
      deps.write(
        focusEnvelope(false, null, {
          code: result.code,
          message: result.message,
          recovery:
            "Re-read with 'keeper agent accounts fable-focus show --json' before retrying.",
        }),
      );
      return deps.exit(1);
    }
    deps.write(
      focusEnvelope(true, {
        ...status,
        configured: false,
        state: "off",
        target_route: null,
        lifetime: null,
        outcome: "off",
        reason: "policy-off",
      }),
    );
    return deps.exit(0);
  }

  const targetValue = args[0];
  const lifetimeKind = args[1];
  let expectedReset: string | null = null;
  const expectIndex = args.indexOf("--expect-reset");
  if (expectIndex >= 0) {
    expectedReset = args[expectIndex + 1] ?? null;
    args.splice(expectIndex, 2);
  }
  if (
    targetValue === undefined ||
    lifetimeKind === undefined ||
    args.length < 2 ||
    args.length > 3
  ) {
    deps.writeErr(
      "accounts fable-focus set expects <route|cN> <permanent|absolute|current-reset|cycle-end> [UTC deadline]\n",
    );
    return deps.exit(2);
  }
  let focus: FableFocusInput;
  if (lifetimeKind === "current-reset" || lifetimeKind === "cycle-end") {
    if (args.length !== 2 || (expectIndex >= 0 && expectedReset === null)) {
      deps.writeErr("invalid current reset guard grammar\n");
      return deps.exit(2);
    }
    const built = constructObservedFableFocus(
      targetValue,
      lifetimeKind,
      expectedReset,
      {
        stateDir: deps.env.KEEPER_ACCOUNT_ROUTING_ROOT,
        nowMs: deps.now(),
      },
    );
    if (!built.ok) {
      deps.write(
        focusEnvelope(false, null, {
          code: built.code,
          message: "the guarded Fable reset boundary could not be accepted",
          recovery:
            "Refresh account observations and re-read the target reset before retrying.",
        }),
      );
      return deps.exit(2);
    }
    focus = built.focus;
  } else {
    if (expectIndex >= 0) {
      deps.writeErr("--expect-reset requires current-reset or cycle-end\n");
      return deps.exit(2);
    }
    const target = resolveObservedManagedRoute(targetValue, {
      stateDir: deps.env.KEEPER_ACCOUNT_ROUTING_ROOT,
      nowMs: deps.now(),
    });
    if (!target.ok) {
      deps.write(
        focusEnvelope(false, null, {
          code: target.code,
          message: "the Fable focus target could not be resolved",
          recovery:
            "Use a stable claude-swap:<slot> route or refresh the cN inventory.",
        }),
      );
      return deps.exit(2);
    }
    if (lifetimeKind === "permanent" && args.length === 2) {
      focus = {
        target_route: target.target_route,
        lifetime: { kind: "permanent" },
      };
    } else if (lifetimeKind === "absolute" && args.length === 3) {
      const deadline = normalizeUtcTimestamp(args[2]);
      if (deadline === null) {
        deps.writeErr(
          "absolute Fable focus requires a timezone-bearing UTC deadline\n",
        );
        return deps.exit(2);
      }
      focus = {
        target_route: target.target_route,
        lifetime: { kind: "absolute", deadline_at: deadline },
      };
    } else {
      deps.writeErr("invalid Fable focus lifetime grammar\n");
      return deps.exit(2);
    }
  }
  if (
    status.configured &&
    status.target_route === focus.target_route &&
    JSON.stringify(status.lifetime) ===
      JSON.stringify(
        focus.lifetime.kind === "current-reset"
          ? { kind: "absolute", deadline_at: focus.lifetime.reset_at }
          : focus.lifetime,
      )
  ) {
    emitStatus();
    return deps.exit(0);
  }
  const result = await deps.setFableFocusFn(focus);
  if (!result.ok) {
    deps.write(
      focusEnvelope(false, null, {
        code: result.code,
        message: result.message,
        recovery:
          "Re-read Fable focus state before retrying an uncertain update.",
      }),
    );
    return deps.exit(1);
  }
  deps.write(
    focusEnvelope(true, {
      configured: true,
      target_route: focus.target_route,
      lifetime:
        focus.lifetime.kind === "current-reset"
          ? {
              kind: "absolute",
              deadline_at: focus.lifetime.reset_at,
            }
          : focus.lifetime,
    }),
  );
  return deps.exit(0);
}

async function runNonFableFocusCommand(
  deps: MainDeps,
  operation: "show" | "set" | "clear",
  rest: string[],
): Promise<never> {
  const jsonCount = rest.filter((arg) => arg === "--json").length;
  const eligibleGuardCount = rest.filter(
    (arg) => arg === "--require-eligible",
  ).length;
  const json = jsonCount === 1;
  const args = rest.filter(
    (arg) => arg !== "--json" && arg !== "--require-eligible",
  );
  if (jsonCount > 1 || eligibleGuardCount > 1) {
    deps.writeErr(
      "accounts non-fable-focus accepts --json and --require-eligible at most once\n",
    );
    return deps.exit(2);
  }
  if (operation !== "set" && eligibleGuardCount !== 0) {
    deps.writeErr("--require-eligible is valid only for non-fable-focus set\n");
    return deps.exit(2);
  }

  const nowMs = deps.now();
  const inspection = deps.inspectRoutingFn(false);
  const status = inspection.non_fable_focus ?? {
    configured: false,
    state: "unavailable",
    target_route: null,
    lifetime: null,
    target_eligible: null,
    outcome: "fallback",
    reason: "policy-unavailable",
    diagnostic: "delivery-unreachable",
  };
  const emitStatus = (): void => {
    if (json) deps.write(focusEnvelope(true, status));
    else {
      deps.write(
        `Non-Fable focus: ${status.state} target=${status.target_route ?? "none"} ` +
          `outcome=${status.outcome} reason=${status.reason}\n`,
      );
    }
  };

  if (operation === "show") {
    if (args.length !== 0) {
      deps.writeErr("accounts non-fable-focus show accepts only --json\n");
      return deps.exit(2);
    }
    emitStatus();
    return deps.exit(0);
  }
  if (operation === "clear") {
    if (args.length !== 0) {
      deps.writeErr("accounts non-fable-focus clear accepts only --json\n");
      return deps.exit(2);
    }
    if (!status.configured && status.state === "off") {
      emitStatus();
      return deps.exit(0);
    }
    const result = await deps.setNonFableFocusFn(null);
    if (!result.ok) {
      deps.write(
        focusEnvelope(false, null, {
          code: result.code,
          message: result.message,
          recovery:
            "Re-read with 'keeper agent accounts non-fable-focus show --json' before retrying.",
        }),
      );
      return deps.exit(1);
    }
    deps.write(
      focusEnvelope(true, {
        ...status,
        configured: false,
        state: "off",
        target_route: null,
        lifetime: null,
        outcome: "off",
        reason: "policy-off",
      }),
    );
    return deps.exit(0);
  }

  if (args.length < 2 || args.length > 3) {
    deps.writeErr(
      "accounts non-fable-focus set expects <route|cN> <permanent|absolute> [timezone-bearing deadline] [--require-eligible]\n",
    );
    return deps.exit(2);
  }
  const target = resolveObservedManagedRoute(args[0] ?? "", {
    stateDir: deps.env.KEEPER_ACCOUNT_ROUTING_ROOT,
    nowMs,
  });
  if (!target.ok) {
    deps.write(
      focusEnvelope(false, null, {
        code: target.code,
        message: "the Non-Fable focus target could not be resolved",
        recovery:
          "Use a stable claude-swap:<slot> route or refresh the cN inventory.",
      }),
    );
    return deps.exit(2);
  }

  let focus: NonFableFocusInput;
  if (args[1] === "permanent" && args.length === 2) {
    focus = {
      target_route: target.target_route,
      lifetime: { kind: "permanent" },
    };
  } else if (args[1] === "absolute" && args.length === 3) {
    const deadline = normalizeUtcTimestamp(args[2]);
    if (deadline === null) {
      deps.writeErr(
        "absolute Non-Fable focus requires a timezone-bearing deadline\n",
      );
      return deps.exit(2);
    }
    if (Date.parse(deadline) <= nowMs) {
      deps.write(
        focusEnvelope(false, null, {
          code: "focus_deadline_elapsed",
          message: "the Non-Fable focus deadline has elapsed",
          recovery: "Choose a future absolute deadline before retrying.",
        }),
      );
      return deps.exit(2);
    }
    focus = {
      target_route: target.target_route,
      lifetime: { kind: "absolute", deadline_at: deadline },
    };
  } else {
    deps.writeErr("invalid Non-Fable focus lifetime grammar\n");
    return deps.exit(2);
  }

  if (eligibleGuardCount === 1) {
    if (
      !inspection.enabled ||
      !inspection.fresh ||
      inspection.health !== "ok"
    ) {
      deps.write(
        focusEnvelope(false, null, {
          code: "focus_observation_unavailable",
          message:
            "guarded Non-Fable focus requires fresh global capacity evidence",
          recovery: "Refresh account observations before retrying.",
        }),
      );
      return deps.exit(2);
    }
    if (
      !inspection.candidates.some(
        (candidate) => candidate.id === focus.target_route,
      )
    ) {
      deps.write(
        focusEnvelope(false, null, {
          code: "focus_target_ineligible",
          message: "the Non-Fable focus target is not currently eligible",
          recovery:
            "Choose an eligible stable route or wait for capacity to recover.",
        }),
      );
      return deps.exit(2);
    }
  }

  if (
    status.configured &&
    status.target_route === focus.target_route &&
    JSON.stringify(status.lifetime) === JSON.stringify(focus.lifetime)
  ) {
    emitStatus();
    return deps.exit(0);
  }
  const result = await deps.setNonFableFocusFn(focus);
  if (!result.ok) {
    deps.write(
      focusEnvelope(false, null, {
        code: result.code,
        message: result.message,
        recovery:
          "Re-read Non-Fable focus state before retrying an uncertain update.",
      }),
    );
    return deps.exit(1);
  }
  deps.write(
    focusEnvelope(true, {
      configured: true,
      target_route: focus.target_route,
      lifetime: focus.lifetime,
    }),
  );
  return deps.exit(0);
}

async function runCodexPoolCommand(
  deps: MainDeps,
  operation: CodexPoolOperatorOperation | "enroll",
  rawArgs: string[],
): Promise<never> {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((arg) => arg !== "--json");
  if (operation === "enroll") {
    const alias = args[0];
    const context = deps.codexPoolLaunchContextFn();
    const companion = deps.resolvePiCodexPoolExtensionFn();
    if (
      json ||
      args.length !== 1 ||
      alias === undefined ||
      !context.aliases.includes(alias)
    ) {
      deps.writeErr(
        "accounts codex-pool enroll expects one configured opaque alias and an interactive terminal\n",
      );
      return deps.exit(2);
    }
    if (companion.health !== "ready") {
      deps.writeErr(
        `Error: [${companion.problem_code ?? "companion-incompatible"}] ${CODEX_NATIVE_FALLBACK_WARNING}\n`,
      );
      return deps.exit(1);
    }
    deps.env.KEEPER_JOB_ID =
      (deps.env.KEEPER_JOB_ID ?? "").trim() || "codex-pool-enrollment";
    deps.env.KEEPER_PI_CODEX_POOL_MODE = "native";
    deps.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(context.aliases);
    deps.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = context.config_binding;
    delete deps.env.KEEPER_PI_CODEX_POOL_REVISION;
    deps.writeErr(
      "Warning: enrolling this alias revokes that account's other live grants " +
        "(legacy leg and bare Pi), causing a native Codex outage until activation.\n",
    );
    deps.writeErr(
      `Codex pool enrollment is interactive; in Pi run /login ${alias}, then exit.\n`,
    );
    return runPassthrough(
      [deps.piBin, ...companion.args, "--model", "openai-codex/gpt-5.4-mini"],
      deps.spawn,
      deps.exit,
      { env: deps.env, cwd: deps.cwd },
    );
  }

  // The degraded waiver is deliberately explicit: only `activate` accepts
  // `--authorize-degraded=<verdict>`, and only when the value names the exact
  // degraded verdict. Anything else is rejected rather than silently ignored.
  const degradedFlagName = "--authorize-degraded";
  const degradedFlag = args.find(
    (arg) => arg === degradedFlagName || arg.startsWith(`${degradedFlagName}=`),
  );
  const positional = args.filter((arg) => arg !== degradedFlag);
  let authorization: CodexPoolActivationAuthorization | null = null;
  if (degradedFlag !== undefined) {
    if (
      operation !== "activate" ||
      degradedFlag !== `${degradedFlagName}=${CODEX_POOL_DEGRADED_VERDICT}`
    ) {
      deps.writeErr(`accounts codex-pool ${operation} has invalid arguments\n`);
      return deps.exit(2);
    }
    authorization = { degraded_verdict: CODEX_POOL_DEGRADED_VERDICT };
  }
  const takesSource =
    operation === "proof-capture" ||
    operation === "proof-verdict" ||
    operation === "activate";
  const source = positional[0];
  if (
    (!takesSource && positional.length !== 0) ||
    (takesSource && positional.length > 1) ||
    (operation === "proof-capture" && source === undefined)
  ) {
    deps.writeErr(`accounts codex-pool ${operation} has invalid arguments\n`);
    return deps.exit(2);
  }
  if (operation === "activate" || operation === "verify") {
    await deps.refreshCodexObservationFn();
  }
  const outcome = deps.runCodexPoolWorkflowFn(operation, source, authorization);
  if (json) {
    deps.write(`${JSON.stringify(outcome)}\n`);
  } else {
    deps.write(
      `codex pool: operation=${outcome.operation} state=${outcome.state} ` +
        `result=${outcome.ok ? "ok" : (outcome.problem_code ?? "failed")}\n`,
    );
    if (outcome.proof !== null) {
      deps.write(
        `proof: verdict=${outcome.proof.verdict} ` +
          `reasons=${outcome.proof.reasons.join(",") || "none"}\n`,
      );
    }
  }
  const readOnlyStatus =
    operation === "status" || operation === "proof-verdict";
  return deps.exit(
    outcome.ok || (readOnlyStatus && operation === "status") ? 0 : 1,
  );
}

/**
 * `accounts check [--json]`: the read-only account-routing diagnostic. Reports
 * integration health, observation age, PII-free candidates, and the generic-
 * only route policy WOULD pick — WITHOUT recording a reservation or launching
 * anything. A machine diagnostic (the `--json` snapshot the operator/tests
 * consume), not a replacement usage viewer. Always exits 0: a disabled or absent
 * integration is a reported state, not an error.
 */
function runAccountsCheck(deps: MainDeps, json: boolean): never {
  const claude = deps.inspectRoutingFn();
  const codex = deps.inspectCodexSessionRoutingFn();
  if (json) {
    deps.write(
      `${JSON.stringify({
        schema_version: 1,
        claude_launch_routing: claude,
        codex_session_routing: codex,
      })}\n`,
    );
    return deps.exit(0);
  }
  deps.write(
    `claude launch routing: health=${claude.health} ` +
      `fresh=${claude.fresh} enabled=${claude.enabled} ` +
      `model-scope=${claude.model_scope ?? "generic-only"}\n`,
  );
  if (claude.would_choose === null) {
    deps.write(`would choose: unavailable (${claude.error ?? "unknown"})\n`);
  } else {
    deps.write(
      `would choose: ${claude.would_choose.id} ` +
        `(${claude.would_choose.reason})\n`,
    );
  }
  for (const c of claude.candidates) {
    deps.write(
      `  ${c.id} [${c.kind}] worst-util=${c.worst_utilization.toFixed(3)} ` +
        `fable-left=${c.fable_remaining === null ? "none" : c.fable_remaining.toFixed(3)}\n`,
    );
  }
  for (const [label, focus] of [
    ["Fable focus", claude.fable_focus],
    ["Non-Fable focus", claude.non_fable_focus],
  ] as const) {
    deps.write(
      `${label}: state=${focus.state} target=${focus.target_route ?? "none"} ` +
        `eligible=${focus.target_eligible ?? "unknown"} outcome=${focus.outcome} ` +
        `reason=${focus.reason} diagnostic=${focus.diagnostic}\n`,
    );
  }
  const refreshFailure = codex.capacity.refresh_failure_state;
  const refreshFailureText =
    refreshFailure === undefined || refreshFailure === null
      ? "none"
      : `count=${refreshFailure.consecutive_failures} last=${refreshFailure.last_failure_class ?? "none"}@${refreshFailure.last_failure_at_ms ?? "none"}`;
  deps.write(
    `codex session routing: activation=${codex.activation.mode} ` +
      `companion=${codex.companion.health} capacity=${codex.capacity.health} ` +
      `fresh=${codex.capacity.fresh} refresh-failures=${refreshFailureText}\n`,
  );
  if (codex.activation.mode === "active-degraded") {
    deps.write(
      "codex session routing: DEGRADED single-alias operation " +
        "(pinned to one healthy alias, NOT balanced)\n",
    );
  }
  if (codex.capacity.verdict.kind === "pooled") {
    deps.write(
      `session route candidate: ${codex.capacity.verdict.alias} ` +
        `(${codex.capacity.verdict.reason})\n`,
    );
  } else {
    deps.write(
      `session route candidate: native openai-codex ` +
        `(${codex.activation.problem_code ?? codex.capacity.verdict.reason})\n`,
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
    if (decision.harness === "claude" && decision.fable_intent != null) {
      launchArgv.splice(
        1,
        0,
        `--x-fable-intent=${decision.fable_intent ? "1" : "0"}`,
      );
    }
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

  const discoverySessionId = resumeSessionId ?? decision.resume_target;
  const lifecycleJobId =
    decision.harness === "pi" ? deps.randomUuid() : discoverySessionId;
  tmuxLaunch.options.env = [
    ...tmuxLaunch.options.env.filter(([key]) => key !== "KEEPER_JOB_ID"),
    ["KEEPER_JOB_ID", lifecycleJobId],
  ];
  const invocationStopFloor = snapshotInvocationStopFloor({
    agent: decision.harness,
    cwd,
    env: deps.env,
    homeDir: deps.transcriptHomeDir,
    startedAtMs: deps.now(),
    sessionId: discoverySessionId,
    isResume: true,
  });

  try {
    const result = launchKeeperAgentInTmux({
      agent: decision.harness,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: launchEnvForAgent(decision.harness, deps.env),
      cwd,
      transcriptSessionId: null,
      resolvedTranscriptSessionId: discoverySessionId,
      startedAtMs: deps.now(),
      lifecycleJobId,
      invocationStopFloor,
      isResume: true,
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
  if (dispatch.kind === "accounts-codex-pool") {
    return runCodexPoolCommand(deps, dispatch.operation, dispatch.rest);
  }
  if (dispatch.kind === "accounts-fable-focus") {
    return runFableFocusCommand(deps, dispatch.operation, dispatch.rest);
  }
  if (dispatch.kind === "accounts-non-fable-focus") {
    return runNonFableFocusCommand(deps, dispatch.operation, dispatch.rest);
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

  // Managed Pi account aliases share one canonical state root. Ambient storage
  // overrides can outlive the shell or pane that introduced them and silently
  // split native session discovery; explicit native storage flags still pass
  // through when a deliberately isolated launch is needed.
  if (agent === "pi") {
    for (const name of [
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
    ] as const) {
      if (deps.env[name] === undefined) continue;
      delete deps.env[name];
      actionLog.push(
        `Cleared inherited ${name}; managed Pi uses canonical state`,
      );
    }
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
        lifecycleJobId: transcriptSessionId,
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

  const proofWindowRequest = consumeCodexPoolProofWindowFlag(argv);
  if (proofWindowRequest.error !== null) {
    deps.writeErr(`Error: ${proofWindowRequest.error}.\n`);
    return deps.exit(2);
  }
  argv = proofWindowRequest.remainingArgs;
  const parsed = parseArgsForAgent(argv, agent);
  const { remainingArgs, hasContinueOrResume, hasForkSession, hasPrint } =
    parsed;
  const { launcherVerbose, launcherVeryVerbose, launcherNoConfirm } = parsed;
  if (parsed.launcherAccountError !== null) {
    deps.writeErr(`Error: ${parsed.launcherAccountError}.\n`);
    return deps.exit(2);
  }
  if (parsed.launcherFableIntentError !== null) {
    deps.writeErr(`Error: ${parsed.launcherFableIntentError}.\n`);
    return deps.exit(2);
  }

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
  if (
    proofWindowRequest.armed &&
    (agent !== "pi" || hasContinueOrResume || shouldPassthrough)
  ) {
    deps.writeErr(
      "Error: --x-codex-pool-proof-window=arm requires a fresh managed Pi session.\n",
    );
    return deps.exit(2);
  }
  let codexProofWindow: CodexPoolProofWindowState | null = null;
  if (proofWindowRequest.armed) {
    codexProofWindow = armCodexPoolProofWindow(deps.now(), process.pid);
    actionLog.push("Armed the launch-scoped Codex pool proof window");
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

  // Resolve the one mandatory Claude route before either the passthrough or
  // configured launch branch. This is the sole process-boundary decision. A
  // configured launch contributes its effective model so Fable demand or
  // non-Fable conservation participates in account scoring. Informational
  // passthrough has no model workload and follows the non-Fable policy.
  let resolvedClaudeRoute: RouteSelection | null = null;
  let resolvedClaudeConfigDir: string | null = null;
  if (agent === "claude") {
    const routingModel = shouldPassthrough
      ? null
      : hasExplicitModelArg(remainingArgs)
        ? modelArgValue(remainingArgs)
        : (resolvedPreset?.model ?? null);
    let fableIntent: boolean | null = shouldPassthrough
      ? false
      : routingModel !== null
        ? modelHasFableIntent(routingModel)
        : parsed.launcherFableIntent;
    if (fableIntent === null && hasContinueOrResume) {
      const target =
        continuationTarget(remainingArgs) ??
        (deps.env.KEEPER_JOB_ID ?? "").trim();
      if (target !== "") {
        fableIntent = await deps.resolveFableIntentFn(target);
      }
    }
    if (fableIntent === null) {
      delete deps.env.KEEPER_FABLE_INTENT;
    } else {
      deps.env.KEEPER_FABLE_INTENT = fableIntent ? "1" : "0";
    }
    const resolution =
      parsed.launcherAccountOrdinal !== null
        ? deps.selectAccountRouteByOrdinalFn(
            parsed.launcherAccountOrdinal,
            routingModel,
            fableIntent,
          )
        : deps.selectAccountRouteFn(routingModel, fableIntent);
    if (!resolution.ok) {
      const routingError = resolution.error.trimEnd();
      const punctuation = /[.!?]$/u.test(routingError) ? "" : ".";
      deps.writeErr(`Error: ${routingError}${punctuation}\n`);
      return deps.exit(parsed.launcherAccountOrdinal === null ? 1 : 2);
    }
    resolvedClaudeRoute = resolution.selection;
    deps.env[KEEPER_ACCOUNT_ROUTE_ENV] = resolvedClaudeRoute.id;
    delete deps.env[KEEPER_ACCOUNT_ORDINAL_ENV];
    if (resolvedClaudeRoute.accountOrdinal !== undefined) {
      deps.env[KEEPER_ACCOUNT_ORDINAL_ENV] = String(
        resolvedClaudeRoute.accountOrdinal,
      );
    }
    actionLog.push(
      `Resolved account route: ${resolvedClaudeRoute.id} (${resolvedClaudeRoute.reason})`,
    );
    if (routingModel !== null && routingModel.trim().length > 0) {
      actionLog.push(`Applied account quota scope for model: ${routingModel}`);
    }
    note(`route: ${resolvedClaudeRoute.id}`);
    try {
      resolvedClaudeConfigDir = deps.resolveAccountConfigDirFn(
        resolvedClaudeRoute.slot,
      );
      deps.env.CLAUDE_CONFIG_DIR = resolvedClaudeConfigDir;
      actionLog.push(
        `Resolved account config directory for slot ${resolvedClaudeRoute.slot}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.writeErr(
        `Warning: Claude account config preflight failed: ${message}; launching anyway.\n`,
      );
    }
  }

  if (shouldPassthrough) {
    let ptCmd = [bin, ...remainingArgs];
    if (agent === "claude" && resolvedClaudeRoute !== null) {
      ptCmd = composeManagedClaudeArgv({
        cswapBin: deps.cswapBin,
        slot: resolvedClaudeRoute.slot,
        nativeClaudeArgv: ptCmd,
      });
      actionLog.push(
        `Routed through claude-swap slot ${resolvedClaudeRoute.slot}`,
      );
    }
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

  // Claude chooses one launch route. Pi defers Codex session routing to its
  // launch-scoped companion while leaving every non-Codex Provider unchanged.

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

    const piExtArgs = deps.resolvePiExtensionArgsFn();
    if (piExtArgs.length > 0) {
      runCmd.push(...piExtArgs);
      actionLog.push(`Armed keeper pi extension: ${piExtArgs.join(" ")}`);
    }

    const companion = deps.resolvePiCodexPoolExtensionFn();
    const codexWorkload =
      startupModel === null ||
      startupModel === "openai-codex" ||
      startupModel.startsWith("openai-codex/");
    const codexContext = deps.codexPoolLaunchContextFn(
      companion.health === "ready" && codexWorkload,
    );
    if (codexProofWindow !== null) {
      if (!codexWorkload) {
        deps.writeErr(
          "Error: the Codex pool proof window requires an openai-codex startup model.\n",
        );
        return deps.exit(2);
      }
      if (
        companion.health !== "ready" ||
        codexContext.problem_code === "activation-config-invalid" ||
        codexContext.problem_code === "recovery-required"
      ) {
        deps.writeErr(
          `Error: [${companion.problem_code ?? codexContext.problem_code ?? "pool-unavailable"}] ${CODEX_NATIVE_FALLBACK_WARNING}\n`,
        );
        return deps.exit(1);
      }
    }
    const codexMode =
      companion.health !== "ready"
        ? "native"
        : codexProofWindow !== null && codexContext.mode !== "active"
          ? "proof"
          : codexContext.mode;
    const codexProblem =
      codexMode === "proof"
        ? null
        : (companion.problem_code ?? codexContext.problem_code);
    deps.env.KEEPER_PI_CODEX_POOL_MODE = codexMode;
    deps.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(
      codexContext.aliases,
    );
    deps.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = codexContext.config_binding;
    if (codexMode === "proof" && codexProofWindow !== null) {
      deps.env[CODEX_POOL_PROOF_WINDOW_ENV] = JSON.stringify(codexProofWindow);
      if (codexContext.revision !== undefined) {
        deps.env.KEEPER_PI_CODEX_POOL_REVISION = codexContext.revision;
      } else {
        delete deps.env.KEEPER_PI_CODEX_POOL_REVISION;
      }
    } else {
      delete deps.env[CODEX_POOL_PROOF_WINDOW_ENV];
      delete deps.env.KEEPER_PI_CODEX_POOL_REVISION;
    }
    if (codexMode === "active" && codexContext.initial_alias !== null) {
      deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = codexContext.initial_alias;
    } else {
      delete deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS;
    }
    if (codexProblem === null) {
      delete deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON;
    } else {
      deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON = codexProblem;
    }
    if (companion.args.length > 0) {
      runCmd.push(...companion.args);
      actionLog.push(
        `Armed Pi Codex pool companion: ${companion.args.join(" ")}`,
      );
    } else {
      deps.writeErr(
        `Warning: [${codexProblem ?? "companion-incompatible"}] ${CODEX_NATIVE_FALLBACK_WARNING}\n`,
      );
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

  // Apply the already-resolved mandatory route to the configured Claude argv.
  if (agent === "claude" && resolvedClaudeRoute !== null) {
    runCmd = composeManagedClaudeArgv({
      cswapBin: deps.cswapBin,
      slot: resolvedClaudeRoute.slot,
      nativeClaudeArgv: runCmd,
    });
    actionLog.push(
      `Routed through claude-swap slot ${resolvedClaudeRoute.slot}`,
    );
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

  const providerGate = parseProviderLegLaunchCarrier(deps.env);
  if (providerGate.kind === "invalid") {
    deps.writeErr("Error: malformed provider-leg ownership carrier.\n");
    return deps.exit(2);
  }
  if (providerGate.kind === "valid" && agent !== "pi") {
    deps.writeErr(
      "Error: owned provider-leg gate requires launcher birth support.\n",
    );
    return deps.exit(2);
  }

  if (agent === "claude" && resolvedClaudeConfigDir !== null) {
    try {
      const changed = deps.seedClaudeWorkspaceTrustFn(
        resolvedClaudeConfigDir,
        deps.cwd,
      );
      actionLog.push(
        changed
          ? "Seeded Claude workspace trust"
          : "Claude workspace trust already seeded",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.writeErr(
        `Warning: Claude workspace trust preflight failed: ${message}; launching anyway.\n`,
      );
    }
  }

  // pi shares this path with claude; only pi gets a launcher birth record.
  // Claude's SessionStart hook remains presence recording and never authorizes
  // the paid process.
  const armedBirth =
    agent === "pi"
      ? armBirthRecord(deps, "pi", {
          spawnName: resolvedSessionName,
          configDir: null,
          pinnedSessionId: sessionUuid,
          hasContinueOrResume,
          remainingArgs,
        })
      : undefined;

  if (providerGate.kind === "valid" && armedBirth !== undefined) {
    process.title = PROVIDER_LEG_SHIM_PROCESS_TITLE;
    try {
      armedBirth.publish(process.pid);
    } catch (error) {
      deps.writeErr(
        `Error: provider-leg identity promotion failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return deps.exit(1);
    }
    const owner: BirthOwnerTuple = {
      leg_launch_id: providerGate.carrier.leg_launch_id,
      wrapper_job_id: providerGate.carrier.wrapper_job_id,
      wrapper_dispatch_attempt_id:
        providerGate.carrier.wrapper_dispatch_attempt_id,
    };
    const birthRoot = birthRootFromIntentPath(armedBirth.intentPath);
    const granted = deps.awaitProviderLegGrantFn
      ? await deps.awaitProviderLegGrantFn(birthRoot, owner)
      : await awaitProviderLegGrant({
          now: () => Date.now(),
          sleep: (ms) => Bun.sleep(ms),
          consume: () => consumeProviderLegGrant(birthRoot, owner),
        });
    if (!granted) {
      deps.writeErr("Error: provider-leg grant timed out before exec.\n");
      return deps.exit(1);
    }
    for (const key of [
      PROVIDER_LEG_GATE_ENV,
      PROVIDER_LEG_LAUNCH_ID_ENV,
      PROVIDER_LEG_WRAPPER_JOB_ID_ENV,
      PROVIDER_LEG_WRAPPER_ATTEMPT_ENV,
      PROVIDER_LEG_LAUNCHER_PID_ENV,
      PROVIDER_LEG_LAUNCHER_START_TIME_ENV,
    ]) {
      delete deps.env[key];
    }
    const execEnv = Object.fromEntries(
      Object.entries(deps.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    if (deps.execProviderLegFn !== undefined) {
      return deps.execProviderLegFn(runCmd, execEnv);
    }
    if (typeof process.execve !== "function") {
      deps.writeErr(
        "Error: provider-leg exec is unavailable on this runtime.\n",
      );
      return deps.exit(1);
    }
    process.execve("/usr/bin/env", ["env", ...runCmd], execEnv);
    return deps.exit(1);
  }

  return runWithJobControl(runCmd, deps.spawn, deps.exit, armedBirth?.publish, {
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
): { publish: ChildSpawnedFn; intentPath: string } {
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
  // Authority-visible BEFORE spawn. If publication later fails, the intent
  // deliberately remains and terminal adoption stays fail-closed.
  const intentPath = deps.writeBirthIntent(draft);
  return {
    intentPath,
    publish: (pid: number) => deps.emitBirthRecord(draft, pid, intentPath),
  };
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
