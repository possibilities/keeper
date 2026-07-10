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

import type { CodexSessionNameIndexerOptions } from "../../src/agent/codex-session-index";
import type { PanelSelections, PresetCatalog } from "../../src/agent/config";
import type { HarnessName } from "../../src/agent/harness";
import type { MainDeps } from "../../src/agent/main";
import {
  MatrixConfigError,
  type MatrixV2,
  matrixConfigPath,
} from "../../src/agent/matrix";
import type { ResumeDecision } from "../../src/agent/resume-policy";
import type { SpawnedChild, SpawnFn } from "../../src/agent/run";
import type { ShadowProfileFinding } from "../../src/agent/shadow-profiles";
import type { TmuxCommandResult } from "../../src/agent/tmux-launch";
import type { HostTriples } from "../../src/agent/triple";
import type { BirthRecordDraft } from "../../src/birth-record";

/** The default host launch triples the harness injects when a test names none: an
 *  empty set (no defaults, no worker/escalation, no panels). Triple-verb tests
 *  pass their own {@link HostTriples} fixture. */
export const DEFAULT_HOST_TRIPLES: HostTriples = {
  defaults: {},
  worker: null,
  escalation: null,
  panels: {},
  panelDefault: null,
};

/**
 * The default preset catalog the harness injects when a test names none: a
 * complete `<harness>_default` launch triple per harness so a bare fresh launch
 * resolves a model + effort/thinking (matching the production requirement that a
 * fresh launch pin them) instead of the fresh-launch fail-loud. Bare launches that
 * don't assert the exact command are unaffected; exact-command tests either see
 * these injected values or pass their own catalog / explicit flags. `presets` is
 * empty (the freeform named catalog is retired); pi's effort segment `high`
 * translates to its thinking band, hermes carries the axisless `na`.
 */
export const DEFAULT_PRESET_CATALOG: PresetCatalog = {
  presets: {},
  claude_default: { harness: "claude", model: "opus", effort: "high" },
  codex_default: { harness: "codex", model: "gpt", effort: "high" },
  pi_default: { harness: "pi", model: "glm", effort: "high" },
  hermes_default: { harness: "hermes", model: "gpt-5.5", effort: "na" },
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
  /** stdout sink. */
  out: string[];
  /** stderr sink. */
  err: string[];
  /** Profile names ensureKeeperAgentProfileDirFn was called with, in order. */
  bootstrappedProfiles: string[];
  /** Action logs ensureCodexStateSharingFn was invoked with, in order (call count
   *  = length) — the codex leaf-guard reaches every codex launch, passthrough too. */
  codexStateSharingCalls: string[][];
  /** Profile lists ensurePiStateSharingFn's `listProfilesFn` arg resolved to, in
   *  order (call count = length) — the pi leaf-guard reaches every pi launch,
   *  passthrough included, fed the `() => []` arm on passthrough. */
  piStateSharingCalls: string[][];
  /** Codex synthetic session-name indexer starts, in order. */
  codexSessionNameIndexers: CodexSessionNameIndexerOptions[];
  /** Every birth record the launcher emitted (draft + child pid), in order. */
  birthRecords: { draft: BirthRecordDraft; pid: number }[];
  /** Every tmux command handed to the tmux seam, in order. */
  tmuxCommands: string[][];
  /** Call count for the injected picker. */
  pickerCalls: () => number;
}

export interface HarnessOptions {
  argv: string[];
  /**
   * When false (default), `argv` is the launcher's working args and the harness
   * prepends the `claude` subcommand token so main()'s dispatch pre-pass routes
   * to the run path. Set true to drive main() with the literal argv — used by
   * the dispatch suite to test bare/unknown/help/version classification.
   */
  rawArgv?: boolean;
  agent?: "claude" | "codex" | "pi" | "hermes";
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeBin?: string;
  codexBin?: string;
  piBin?: string;
  hermesBin?: string;
  pickProfile?: () => string;
  listProfiles?: () => string[];
  /** Profile dir ensureKeeperAgentProfileDirFn returns (default deterministic). */
  profileDir?: string;
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
  /** Shadow/stray findings findShadowProfileDirsFn returns (default empty). */
  findShadowProfileDirs?: () => ShadowProfileFinding[];
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
  /** `resume` verb + `run --resume` decision seam (default: `{kind:"unknown",
   *  target}` — no fixture db, no real subprocess spawn). Pass a fixed
   *  `ResumeDecision` or a function of the target (and the optional
   *  `requireHarness` the `run <cli> --resume` path passes) to drive the resume
   *  route's branches. */
  resolveResumeDecision?:
    | ResumeDecision
    | ((target: string, requireHarness?: HarnessName) => ResumeDecision);
}

/**
 * Build a Harness with sensible inert defaults. State sharing is a no-op;
 * profile bootstrap returns (profileDir, false); config readers return a fixed
 * shared-settings path and empty plugin sources; the spawn seam records.
 */
export function makeHarness(opts: HarnessOptions): Harness {
  const spawned: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const bootstrappedProfiles: string[] = [];
  const codexStateSharingCalls: string[][] = [];
  const piStateSharingCalls: string[][] = [];
  const codexSessionNameIndexers: CodexSessionNameIndexerOptions[] = [];
  const birthRecords: { draft: BirthRecordDraft; pid: number }[] = [];
  const tmuxCommands: string[][] = [];
  let pickerCalls = 0;

  const homeBin = opts.homeBin ?? "/fake-home/.local/bin/claude";
  const codexBin = opts.codexBin ?? "/fake-home/bin/codex";
  const piBin = opts.piBin ?? "/fake-home/.local/bin/pi";
  const hermesBin = opts.hermesBin ?? "/fake-home/.local/bin/hermes";
  const profileDir = opts.profileDir ?? "/fake-home/.claude-profiles/stub";

  const pickProfile = opts.pickProfile ?? (() => "default");

  const spawn: SpawnFn =
    opts.spawn ??
    ((cmd: string[]): SpawnedChild => {
      spawned.push(cmd);
      return okChild();
    });

  const deps: MainDeps = {
    argv: opts.rawArgv ? opts.argv : [opts.agent ?? "claude", ...opts.argv],
    env: opts.env ?? {},
    cwd: opts.cwd ?? "/fake-home/code/proj",
    spawn,
    readChar: () => "n",
    listProfilesFn: opts.listProfiles ?? (() => []),
    pickProfileFn: () => {
      pickerCalls += 1;
      return pickProfile();
    },
    nextCwdOrdinalFn: opts.nextCwdOrdinal ?? (() => 1),
    randomUuid:
      opts.randomUuid ?? (() => "00000000-0000-0000-0000-000000000000"),
    now: opts.now ?? (() => 0),
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: throwingExit,
    claudeBin: homeBin,
    codexBin,
    piBin,
    hermesBin,
    pluginConfigPath: "/fake-home/.config/keeper/plugins.yaml",
    loadPluginSourcesFn: () => ({ pluginDirs: [], pluginScanDirs: [] }),
    loadPresetCatalogFn: () => opts.presetCatalog ?? DEFAULT_PRESET_CATALOG,
    loadPanelSelectionsFn: () =>
      opts.panelSelections ?? { panels: {}, default: null },
    loadHostTriplesFn: () => opts.hostTriples ?? DEFAULT_HOST_TRIPLES,
    ensureClaudeStateSharingFn: () => {},
    ensureCodexStateSharingFn: (actionLog: string[]) => {
      codexStateSharingCalls.push(actionLog);
    },
    ensureKeeperAgentProfileDirFn: (profileName: string) => {
      bootstrappedProfiles.push(profileName);
      return [profileDir, false];
    },
    ensurePiStateSharingFn: (listProfilesFn: () => string[]) => {
      piStateSharingCalls.push(listProfilesFn());
    },
    ensureKeeperAgentPiProfileDirFn: (profileName: string) => {
      bootstrappedProfiles.push(profileName);
      return [profileDir, false];
    },
    findShadowProfileDirsFn: opts.findShadowProfileDirs ?? (() => []),
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
    startCodexSessionNameIndexerFn: (opts: CodexSessionNameIndexerOptions) => {
      codexSessionNameIndexers.push(opts);
      return () => {};
    },
    emitBirthRecord: (draft: BirthRecordDraft, pid: number) => {
      birthRecords.push({ draft, pid });
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
    resolveResumeDecisionFn: (target: string, requireHarness?: HarnessName) => {
      const decision = opts.resolveResumeDecision;
      if (typeof decision === "function") {
        return decision(target, requireHarness);
      }
      return decision ?? { kind: "unknown", target };
    },
  };

  return {
    deps,
    spawned,
    out,
    err,
    bootstrappedProfiles,
    codexStateSharingCalls,
    piStateSharingCalls,
    codexSessionNameIndexers,
    birthRecords,
    tmuxCommands,
    pickerCalls: () => pickerCalls,
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
