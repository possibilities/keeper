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
import type { MainDeps } from "../../src/agent/main";
import type { SpawnedChild, SpawnFn } from "../../src/agent/run";
import type { ShadowProfileFinding } from "../../src/agent/shadow-profiles";
import type { TmuxCommandResult } from "../../src/agent/tmux-launch";

/** Throwing exit so a test sees the exit code without killing the runner. */
export class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
export const throwingExit = (code: number): never => {
  throw new ExitSignal(code);
};

/** A child that exits 0 immediately — the default fake agent. */
function okChild(): SpawnedChild {
  return {
    exited: Promise.resolve(0),
    exitCode: 0,
    signalCode: null,
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
  /** Profile names ensureAgentwrapProfileDirFn was called with, in order. */
  bootstrappedProfiles: string[];
  /** Codex synthetic session-name indexer starts, in order. */
  codexSessionNameIndexers: CodexSessionNameIndexerOptions[];
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
  agent?: "claude" | "codex" | "pi";
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeBin?: string;
  codexBin?: string;
  piBin?: string;
  pickProfile?: () => string;
  listProfiles?: () => string[];
  /** Profile dir ensureAgentwrapProfileDirFn returns (default deterministic). */
  profileDir?: string;
  launcherModel?: string | null;
  launcherEffort?: string | null;
  codexLauncherModel?: string | null;
  codexLauncherEffort?: string | null;
  piLauncherModel?: string | null;
  piLauncherThinking?: string | null;
  /** Preset catalog loadPresetCatalogFn returns (default empty). */
  presetCatalog?: PresetCatalog;
  /** Panel selections loadPanelSelectionsFn returns (default empty). */
  panelSelections?: PanelSelections;
  /** Shadow/stray findings findShadowProfileDirsFn returns (default empty). */
  findShadowProfileDirs?: () => ShadowProfileFinding[];
  claudeStowDir?: string | null;
  spawn?: SpawnFn;
  nextCwdOrdinal?: (dirName: string) => number;
  randomUuid?: () => string;
  tmuxBin?: string;
  launcherArgvPrefix?: string[];
  agentwrapStateDir?: string;
  transcriptHomeDir?: string;
  tmuxCommand?: (cmd: string[]) => TmuxCommandResult;
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
  const codexSessionNameIndexers: CodexSessionNameIndexerOptions[] = [];
  const tmuxCommands: string[][] = [];
  let pickerCalls = 0;

  const homeBin = opts.homeBin ?? "/fake-home/.local/bin/claude";
  const codexBin = opts.codexBin ?? "/fake-home/bin/codex";
  const piBin = opts.piBin ?? "/fake-home/.local/bin/pi";
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
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: throwingExit,
    claudeBin: homeBin,
    codexBin,
    piBin,
    pluginConfigPath: "/fake-home/.config/agentwrap/plugins.yaml",
    loadLauncherDefaultsFn: () => ({
      model: opts.launcherModel ?? null,
      effort: opts.launcherEffort ?? null,
    }),
    loadCodexLauncherDefaultsFn: () => ({
      model: opts.codexLauncherModel ?? null,
      effort: opts.codexLauncherEffort ?? null,
    }),
    loadPiLauncherDefaultsFn: () => ({
      model: opts.piLauncherModel ?? null,
      thinking: opts.piLauncherThinking ?? null,
    }),
    loadClaudeStowDirFn: () => opts.claudeStowDir ?? null,
    loadPluginSourcesFn: () => ({ pluginDirs: [], pluginScanDirs: [] }),
    loadPresetCatalogFn: () => opts.presetCatalog ?? { presets: {} },
    loadPanelSelectionsFn: () =>
      opts.panelSelections ?? { panels: {}, default: null },
    ensureClaudeStateSharingFn: () => {},
    ensureAgentwrapProfileDirFn: (profileName: string) => {
      bootstrappedProfiles.push(profileName);
      return [profileDir, false];
    },
    ensurePiStateSharingFn: () => {},
    ensureAgentwrapPiProfileDirFn: (profileName: string) => {
      bootstrappedProfiles.push(profileName);
      return [profileDir, false];
    },
    findShadowProfileDirsFn: opts.findShadowProfileDirs ?? (() => []),
    startCodexSessionNameIndexerFn: (opts: CodexSessionNameIndexerOptions) => {
      codexSessionNameIndexers.push(opts);
      return () => {};
    },
    tmuxBin: opts.tmuxBin ?? "tmux",
    launcherArgvPrefix: opts.launcherArgvPrefix ?? [
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
    ],
    agentwrapStateDir: opts.agentwrapStateDir ?? "/tmp/agentwrap-test-state",
    transcriptHomeDir: opts.transcriptHomeDir ?? "/fake-home",
    runTmuxCommandFn: (cmd: string[]): TmuxCommandResult => {
      tmuxCommands.push(cmd);
      if (opts.tmuxCommand !== undefined) {
        return opts.tmuxCommand(cmd);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  return {
    deps,
    spawned,
    out,
    err,
    bootstrappedProfiles,
    codexSessionNameIndexers,
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
