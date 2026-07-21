/**
 * Shared harness for the main()-driving port suites. Builds a fully-stubbed
 * MainDeps so the launcher flow runs against a fake agent (the spawn recorder)
 * and injected collaborators — no real ~/.config, ~/.claude, or subprocess.
 *
 * The Python suites monkeypatched module globals + HOME; here we override the
 * same surfaces through the MainDeps seams (no mock.module, which neither hoists
 * nor resets). `os.homedir()` ignores process.env.HOME, so HOME redirection is
 * not used — the HOME-coupled config readers and state collaborators are stubs.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RequestedRouteResolution,
  RouteResolution,
  RoutingInspection,
} from "../../src/account-router";
import type { PanelSelections, PresetCatalog } from "../../src/agent/config";
import type { HarnessName } from "../../src/agent/harness";
import type { PiCodexPoolExtensionResolution } from "../../src/agent/launch-config";
import type {
  CodexPoolLaunchContext,
  CodexPoolOperatorOperation,
  CodexSessionRoutingInspection,
  MainDeps,
} from "../../src/agent/main";
import {
  MatrixConfigError,
  type MatrixV2,
  matrixConfigPath,
} from "../../src/agent/matrix";
import type { ResumeDecision } from "../../src/agent/resume-policy";
import type { SpawnedChild, SpawnFn, SpawnOptions } from "../../src/agent/run";
import type { TmuxCommandResult } from "../../src/agent/tmux-launch";
import type { PartnerLifecycle } from "../../src/agent/transcript-watch";
import type { HostTriples } from "../../src/agent/triple";
import type { BirthRecordDraft } from "../../src/birth-record";
import type {
  BusSendResult,
  PartnerCaptureLease,
  PublishedBusArtifact,
} from "../../src/bus-artifact";
import type {
  CodexPoolActivationAuthorization,
  CodexPoolWorkflowResult,
} from "../../src/codex-pool-activation";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../../src/codex-quota-scope";

/** The default host launch triples the harness injects when a test names none: an
 *  empty set (no defaults, no dispatch verbs, no panels). Triple-verb tests
 *  pass their own {@link HostTriples} fixture. */
export const DEFAULT_HOST_TRIPLES: HostTriples = {
  defaults: {},
  dispatch: {},
  panels: {},
  panelMeta: {},
  panelDefault: null,
};

/**
 * The default preset catalog the harness injects when a test names none: a
 * complete `<harness>_default` launch triple per harness so a bare fresh launch
 * resolves a model + effort/thinking (matching the production requirement that a
 * fresh launch pin them) instead of the fresh-launch fail-loud. Bare launches that
 * don't assert the exact command are unaffected; exact-command tests either see
 * these injected values or pass their own catalog / explicit flags. `presets` is
 * empty (the freeform named catalog is retired); Pi's effort segment `high`
 * translates to its thinking band.
 */
export const DEFAULT_PRESET_CATALOG: PresetCatalog = {
  presets: {},
  claude_default: { harness: "claude", model: "opus", effort: "high" },
  pi_default: { harness: "pi", model: "glm", effort: "high" },
};

/** Throwing exit so a test sees the exit code without killing the runner. */
export class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
export const throwingExit = (code: number): never => {
  throw new ExitSignal(code);
};

/** A fixed fake child pid so `runWithJobControl` fires the birth-record seam in
 *  wiring tests (production `defaultSpawn` carries the real `proc.pid`). */
export const FAKE_CHILD_PID = 4242;

/** A child that exits 0 immediately — the default fake agent. */
function okChild(): SpawnedChild {
  return {
    exited: Promise.resolve(0),
    exitCode: 0,
    signalCode: null,
    pid: FAKE_CHILD_PID,
    kill() {},
  };
}

export interface Harness {
  deps: MainDeps;
  /** Every command handed to the spawn seam, in order. */
  spawned: string[][];
  /** Spawn env/cwd options handed to the spawn seam, in order. */
  spawnOptions: SpawnOptions[];
  /** stdout sink. */
  out: string[];
  /** stderr sink. */
  err: string[];
  /** Action logs ensurePiStateSharingFn was invoked with, in order (call count =
   *  length) — the pi leaf-guard reaches every pi launch, passthrough included;
   *  there is no Keeper-owned Pi profile farm to gate it behind. */
  piStateSharingCalls: string[][];
  /** Pi prompt-artifact preflight action logs, once per inner Pi launch. */
  piPromptArtifactsCalls: string[][];
  /** Environment snapshots at each Pi preflight boundary. */
  piPromptArtifactEnvSnapshots: NodeJS.ProcessEnv[];
  /** Pi preflight/state/intent/spawn ordering recorder. */
  piLaunchOrder: string[];
  /** Every pre-spawn birth intent, in order. */
  birthIntents: BirthRecordDraft[];
  /** Every birth record the launcher emitted, in order. */
  birthRecords: {
    draft: BirthRecordDraft;
    pid: number;
    intentPath: string;
  }[];
  /** Every tmux command handed to the tmux seam, in order. */
  tmuxCommands: string[][];
  /** Call count for the injected automatic account router. */
  routerCalls: () => number;
  /** Ordinals passed to the injected explicit account resolver. */
  requestedAccountOrdinals: () => number[];
}

type HarnessRoutingInspection = Omit<RoutingInspection, "non_fable_focus"> &
  Partial<Pick<RoutingInspection, "non_fable_focus">>;

export interface HarnessOptions {
  argv: string[];
  /**
   * When false (default), `argv` is the launcher's working args and the harness
   * prepends the `claude` subcommand token so main()'s dispatch pre-pass routes
   * to the run path. Set true to drive main() with the literal argv — used by
   * the dispatch suite to test bare/unknown/help/version classification.
   */
  rawArgv?: boolean;
  agent?: "claude" | "pi";
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeBin?: string;
  piBin?: string;
  /**
   * Preset catalog loadPresetCatalogFn returns. Default: {@link
   * DEFAULT_PRESET_CATALOG} — a `<harness>_default` for each harness so a bare
   * fresh launch resolves a model/effort/thinking instead of the fresh-launch
   * fail-loud. Pass `{ presets: {} }` to exercise that fail-loud, or a custom
   * catalog (with its own `<harness>_default`) to pin the injected values.
   */
  presetCatalog?: PresetCatalog;
  /** Panel selections loadPanelSelectionsFn returns (default empty). */
  panelSelections?: PanelSelections;
  /** Host launch triples loadHostTriplesFn returns (default {@link
   *  DEFAULT_HOST_TRIPLES} — an empty set). */
  hostTriples?: HostTriples;
  /** Host matrix loadMatrixFn returns (default null → absent, so loadMatrixFn
   *  throws the typed `absent` {@link MatrixConfigError}, matching production). */
  matrix?: MatrixV2 | null;
  /** Provider-binary reachability probe (default: every provider reachable). */
  providerReachable?: (harness: HarnessName) => boolean;
  spawn?: SpawnFn;
  nextCwdOrdinal?: (dirName: string) => number;
  randomUuid?: () => string;
  /** Wall-clock seam (ms); default returns 0 for deterministic elapsed. */
  now?: () => number;
  tmuxBin?: string;
  launcherArgvPrefix?: string[];
  launcherStateDir?: string;
  transcriptHomeDir?: string;
  tmuxCommand?: (cmd: string[]) => TmuxCommandResult;
  /** Statusline `--settings` path seam (default: fixed fake plugin path). */
  resolveStatuslineSettingsPath?: () => string | null;
  /** Pi extension arming flags seam (default: `[]` — no `-e` injected, so the
   *  argv byte-pins stay path-independent). Pass `["-e", "<fake>"]` to exercise
   *  the injection. */
  resolvePiExtensionArgs?: () => string[];
  resolvePiCodexPoolExtension?: () => PiCodexPoolExtensionResolution;
  codexPoolLaunchContext?: (
    reserve?: boolean,
    modelId?: string | null,
  ) => CodexPoolLaunchContext;
  inspectCodexSessionRouting?: () => CodexSessionRoutingInspection;
  refreshCodexObservation?: () => Promise<void>;
  runCodexPoolWorkflow?: (
    operation: CodexPoolOperatorOperation,
    source?: string,
    authorization?: CodexPoolActivationAuthorization | null,
  ) => CodexPoolWorkflowResult;
  /** Pi prompt-artifact preflight seam; may throw a typed launcher failure. */
  ensurePiPromptArtifacts?: (actionLog: string[]) => void;
  /** `resume` verb + `run --resume` decision seam (default: `{kind:"unknown",
   *  target}` — no fixture db, no real subprocess spawn). Pass a fixed
   *  `ResumeDecision` or a function of the target (and the optional
   *  `requireHarness` the `run <cli> --resume` path passes) to drive the resume
   *  route's branches. */
  resolveResumeDecision?:
    | ResumeDecision
    | ((target: string, requireHarness?: HarnessName) => ResumeDecision);
  publishBusArtifact?: (root: string, body: string) => PublishedBusArtifact;
  removeBusArtifact?: (root: string, id: string) => boolean;
  sendBusArtifact?: (
    sockPath: string,
    artifact: PublishedBusArtifact,
    target: string,
    mediaType?: string,
    beforePublish?: () => boolean,
  ) => Promise<BusSendResult>;
  acquirePartnerCaptureLease?: (
    root: string,
    partnerJobId: string,
  ) => PartnerCaptureLease | null;
  busArtifactRoot?: string;
  /** Mandatory managed account result for an unpinned Claude launch. */
  selectAccountRoute?: (
    model: string | null,
    fableIntent?: boolean | null,
  ) => RouteResolution;
  /** Exact result for a requested zero-based account ordinal. */
  selectAccountRouteByOrdinal?: (
    ordinal: number,
    model: string | null,
    fableIntent?: boolean | null,
  ) => RequestedRouteResolution;
  /** Read-only routing snapshot the `accounts check` diagnostic returns. Default:
   *  a disabled `no-observation` snapshot. */
  inspectRouting?: (fableIntent?: boolean | null) => HarnessRoutingInspection;
  resolveFableIntent?: (target: string) => Promise<boolean | null>;
  setFableFocus?: MainDeps["setFableFocusFn"];
  setNonFableFocus?: MainDeps["setNonFableFocusFn"];
  probePartnerLifecycle?: (jobId: string) => Promise<PartnerLifecycle>;
  /** claude-swap executable a managed route wraps through (default fake path). */
  cswapBin?: string;
  resolveAccountConfigDir?: (slot: number) => string;
  seedClaudeWorkspaceTrust?: (configDir: string, cwd: string) => boolean;
}

/**
 * Build a Harness with sensible inert defaults. State sharing is a no-op;
 * config readers return a fixed shared-settings path and empty plugin
 * sources; the spawn seam records.
 */
export function makeHarness(opts: HarnessOptions): Harness {
  const spawned: string[][] = [];
  const spawnOptions: SpawnOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const piStateSharingCalls: string[][] = [];
  const piPromptArtifactsCalls: string[][] = [];
  const piPromptArtifactEnvSnapshots: NodeJS.ProcessEnv[] = [];
  const piLaunchOrder: string[] = [];
  const birthIntents: BirthRecordDraft[] = [];
  const birthRecords: {
    draft: BirthRecordDraft;
    pid: number;
    intentPath: string;
  }[] = [];
  const tmuxCommands: string[][] = [];
  let routerCalls = 0;
  const requestedAccountOrdinals: number[] = [];

  const selectAccountRoute =
    opts.selectAccountRoute ??
    (() => ({
      ok: true as const,
      selection: {
        id: "claude-swap:1",
        kind: "managed" as const,
        slot: 1,
        reason: "harness-managed",
      },
    }));

  // Keep the cwd-confirm gate deterministic in temp-backed isolated worktrees.
  // Explicit callers can still override the logical shell path.
  const env = {
    PWD: join(homedir(), "code", "fixture-project"),
    ...(opts.env ?? {}),
  };
  const homeBin = opts.homeBin ?? "/fake-home/.local/bin/claude";
  const piBin = opts.piBin ?? "/fake-home/.local/bin/pi";

  const spawn: SpawnFn =
    opts.spawn ??
    ((cmd: string[], options: SpawnOptions = {}): SpawnedChild => {
      spawned.push(cmd);
      spawnOptions.push(options);
      piLaunchOrder.push("spawn");
      return okChild();
    });

  const deps: MainDeps = {
    argv: opts.rawArgv ? opts.argv : [opts.agent ?? "claude", ...opts.argv],
    env,
    cwd: opts.cwd ?? "/fake-home/code/proj",
    spawn,
    readChar: () => "n",
    nextCwdOrdinalFn: opts.nextCwdOrdinal ?? (() => 1),
    randomUuid:
      opts.randomUuid ?? (() => "00000000-0000-0000-0000-000000000000"),
    now: opts.now ?? (() => 0),
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: throwingExit,
    claudeBin: homeBin,
    piBin,
    pluginConfigPath: "/fake-home/.config/keeper/plugins.yaml",
    loadPluginSourcesFn: () => ({ pluginDirs: [], pluginScanDirs: [] }),
    loadPresetCatalogFn: () => opts.presetCatalog ?? DEFAULT_PRESET_CATALOG,
    loadPanelSelectionsFn: () =>
      opts.panelSelections ?? { panels: {}, default: null },
    loadHostTriplesFn: () => opts.hostTriples ?? DEFAULT_HOST_TRIPLES,
    ensureClaudeStateSharingFn: () => {},
    ensurePiStateSharingFn: (actionLog: string[]) => {
      piStateSharingCalls.push(actionLog);
      piLaunchOrder.push("state");
    },
    ensurePiPromptArtifactsFn: (actionLog: string[]) => {
      piPromptArtifactsCalls.push(actionLog);
      piPromptArtifactEnvSnapshots.push({ ...env });
      piLaunchOrder.push("preflight");
      opts.ensurePiPromptArtifacts?.(actionLog);
    },
    loadMatrixFn: () => {
      if (opts.matrix === undefined || opts.matrix === null) {
        throw new MatrixConfigError(
          "absent",
          matrixConfigPath(),
          "no matrix.yaml found",
        );
      }
      return opts.matrix;
    },
    providerReachableFn: opts.providerReachable ?? (() => true),
    writeBirthIntent: (draft: BirthRecordDraft) => {
      birthIntents.push(draft);
      piLaunchOrder.push("intent");
      return "/fake-births/pending/intent.json";
    },
    emitBirthRecord: (
      draft: BirthRecordDraft,
      pid: number,
      intentPath: string,
    ) => {
      birthRecords.push({ draft, pid, intentPath });
    },
    tmuxBin: opts.tmuxBin ?? "tmux",
    launcherArgvPrefix: opts.launcherArgvPrefix ?? [
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
    ],
    launcherStateDir: opts.launcherStateDir ?? "/tmp/keeper-agent-test-state",
    transcriptHomeDir: opts.transcriptHomeDir ?? "/fake-home",
    runTmuxCommandFn: (cmd: string[]): TmuxCommandResult => {
      tmuxCommands.push(cmd);
      if (opts.tmuxCommand !== undefined) {
        return opts.tmuxCommand(cmd);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    resolveStatuslineSettingsPathFn:
      opts.resolveStatuslineSettingsPath ??
      (() => "/fake-home/code/keeper/plugins/keeper/settings.json"),
    resolvePiExtensionArgsFn: opts.resolvePiExtensionArgs ?? (() => []),
    resolvePiCodexPoolExtensionFn:
      opts.resolvePiCodexPoolExtension ??
      (() => ({
        args: [],
        health: "missing",
        problem_code: "companion-missing",
      })),
    codexPoolLaunchContextFn:
      opts.codexPoolLaunchContext ??
      (() => ({
        mode: "native",
        activation_mode: "native",
        aliases: ["keeper-codex-a", "keeper-codex-b"],
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: [],
          [CODEX_SPARK_QUOTA_SCOPE]: [],
        },
        requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
        config_binding: "a".repeat(64),
        initial_alias: null,
        problem_code: "activation-pending",
      })),
    inspectCodexSessionRoutingFn:
      opts.inspectCodexSessionRouting ??
      (() => ({
        activation: {
          mode: "native",
          problem_code: "activation-pending",
        },
        companion: {
          health: "missing",
          problem_code: "companion-missing",
        },
        capacity: {
          provider: "openai-codex",
          health: "missing",
          config_binding: null,
          observed_at_ms: null,
          fresh: false,
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          verdict: {
            kind: "native-fallback",
            provider: "openai-codex",
            reason: "observation-missing",
            warning:
              "[keeper-codex-pool] pool-unavailable; using native openai-codex",
          },
          candidates: [],
        },
      })),
    refreshCodexObservationFn: opts.refreshCodexObservation ?? (async () => {}),
    runCodexPoolWorkflowFn:
      opts.runCodexPoolWorkflow ??
      ((operation) => ({
        schema_version: 1,
        ok: false,
        operation,
        state: "native",
        problem_code: "activation-pending",
        proof: null,
      })),
    resolveResumeDecisionFn: (target: string, requireHarness?: HarnessName) => {
      const decision = opts.resolveResumeDecision;
      if (typeof decision === "function") {
        return decision(target, requireHarness);
      }
      return decision ?? { kind: "unknown", target };
    },
    publishBusArtifactFn:
      opts.publishBusArtifact ??
      ((_root, body) => ({
        path: "/fake-bus-artifacts/00000000000000000000000000000001",
        ref: {
          id: "00000000000000000000000000000001",
          len: body.length,
          sha256: "0".repeat(64),
        },
      })),
    removeBusArtifactFn: opts.removeBusArtifact ?? (() => true),
    sendBusArtifactFn:
      opts.sendBusArtifact ??
      (async (_sock, _artifact, _target, _mediaType, beforePublish) => {
        if (!(beforePublish?.() ?? true)) {
          throw new Error("recipient identity is no longer live");
        }
        return { result: "delivered", recipients: 1 };
      }),
    acquirePartnerCaptureLeaseFn:
      opts.acquirePartnerCaptureLease ??
      (() => ({ path: "/fake-partner-capture", release() {} })),
    resolveBusArtifactRootFn: () =>
      opts.busArtifactRoot ?? "/fake-bus-artifacts",
    selectAccountRouteFn: (model, fableIntent) => {
      routerCalls += 1;
      return selectAccountRoute(model, fableIntent);
    },
    selectAccountRouteByOrdinalFn: (ordinal, model, fableIntent) => {
      requestedAccountOrdinals.push(ordinal);
      return (
        opts.selectAccountRouteByOrdinal?.(ordinal, model, fableIntent) ?? {
          ok: true,
          selection: {
            id: "claude-swap:1",
            kind: "managed" as const,
            slot: 1,
            accountOrdinal: ordinal,
            reason: "requested-account",
          },
        }
      );
    },
    resolveFableIntentFn: opts.resolveFableIntent ?? (async () => null),
    setFableFocusFn: opts.setFableFocus ?? (async () => ({ ok: true })),
    setNonFableFocusFn: opts.setNonFableFocus ?? (async () => ({ ok: true })),
    inspectRoutingFn: (fableIntent) => {
      const inspection = opts.inspectRouting?.(fableIntent) ?? {
        model_scope: null,
        health: "no-observation" as const,
        observed_at_ms: null,
        age_ms: null,
        fresh: false,
        enabled: false,
        error: "no claude-swap account inventory is available",
        would_choose: null,
        candidates: [],
        fable_focus: {
          configured: false,
          state: "off" as const,
          target_route: null,
          lifetime: null,
          target_eligible: null,
          outcome: "off" as const,
          reason: "policy-off" as const,
          diagnostic: "none",
        },
      };
      return {
        non_fable_focus: {
          configured: false,
          state: "off",
          target_route: null,
          lifetime: null,
          target_eligible: null,
          outcome: "off",
          reason: "policy-off",
          diagnostic: "none",
        },
        ...inspection,
      };
    },
    probePartnerLifecycleFn:
      opts.probePartnerLifecycle ?? (async () => ({ kind: "unknown" })),
    cswapBin: opts.cswapBin ?? "/fake-home/.local/bin/cswap",
    resolveAccountConfigDirFn:
      opts.resolveAccountConfigDir ??
      ((slot) => `/fake-home/.claude-swap/sessions/${slot}-account`),
    seedClaudeWorkspaceTrustFn: opts.seedClaudeWorkspaceTrust ?? (() => false),
  };

  return {
    deps,
    spawned,
    spawnOptions,
    out,
    err,
    piStateSharingCalls,
    piPromptArtifactsCalls,
    piPromptArtifactEnvSnapshots,
    piLaunchOrder,
    birthIntents,
    birthRecords,
    tmuxCommands,
    routerCalls: () => routerCalls,
    requestedAccountOrdinals: () => [...requestedAccountOrdinals],
  };
}

/** Value of `--name` in a recorded command, or null. */
export function nameArg(cmd: string[]): string | null {
  const idx = cmd.indexOf("--name");
  if (idx === -1 || idx + 1 >= cmd.length) {
    return null;
  }
  return cmd[idx + 1] ?? null;
}

/**
 * Every value of `flag` in a recorded command, split (`flag val`) or joined
 * (`flag=val`) — `nameArg` is indexOf-based and sees only the split form.
 */
export function flagValues(cmd: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const tok = cmd[i];
    if (tok === flag) {
      const next = cmd[i + 1];
      if (next !== undefined) {
        values.push(next);
      }
    } else if (tok?.startsWith(`${flag}=`)) {
      values.push(tok.slice(flag.length + 1));
    }
  }
  return values;
}

/** Run main() and return the single recorded command, asserting it ran. */
export async function runAndCapture(
  h: Harness,
  main: (deps: MainDeps) => Promise<never>,
): Promise<string[]> {
  await expectExit(main(h.deps));
  if (h.spawned.length !== 1) {
    throw new Error(
      `expected exactly one spawned command, got ${h.spawned.length}`,
    );
  }
  return h.spawned[0] as string[];
}

/** Await a main() promise that must reject with ExitSignal; returns the code. */
export async function expectExit(p: Promise<never>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExitSignal) {
      return e.code;
    }
    throw e;
  }
  throw new Error("expected main() to exit, but it returned");
}
