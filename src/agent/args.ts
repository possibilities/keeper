/**
 * Launcher flag parsing — the pre-pass that strips the launcher's own
 * `--x-*` flags from argv before the residual is handed to the agent, and
 * surfaces the launch mode signals (continuation, headless, fork, account) the
 * rest of main() branches on.
 *
 * Three consumed flags carry no value (`--x-verbose`,
 * `--x-very-verbose`, `--x-no-confirm`) and wrapper value flags
 * (`--x-preset`, `--x-account`) take split or joined forms. The legacy
 * `--x-profile` value is consumed inertly so existing launch commands retain
 * their no-profile-farm behavior. Every other token passes through verbatim into
 * `remainingArgs`, preserving order — the agent sees exactly what the human
 * typed minus the launcher flags. A stray non-launcher flag (including the
 * retired `--arthack-*` spelling) is forwarded to the agent, which rejects it
 * loudly.
 */

import type { AgentKind } from "./dispatch";

export interface ParsedArgs {
  /** argv with launcher flags stripped — forwarded to the agent verbatim. */
  remainingArgs: string[];
  /** Agent-native continuation/resume/session selection was seen. */
  hasContinueOrResume: boolean;
  /** Agent-native fork mode was seen. */
  hasForkSession: boolean;
  /** Agent-native headless mode was seen. */
  hasPrint: boolean;
  /** `--x-verbose` seen — print one line per startup section. */
  launcherVerbose: boolean;
  /**
   * `--x-very-verbose` seen — section lines plus the full action log and
   * composed claude command. Implies `--x-verbose`.
   */
  launcherVeryVerbose: boolean;
  /** `--x-no-confirm` seen — suppress the cwd-confirm prompt. */
  launcherNoConfirm: boolean;
  /**
   * `--x-preset <name>` — a named launch-config preset resolved from
   * `presets.yaml` that supplies harness/model/effort defaults BELOW any
   * explicit flag or effort env. `null` when unset (no "auto"); the preset
   * never overrides an explicit `--model`/`--effort`.
   */
  launcherPreset: string | null;
  /**
   * `--x-account <cN|N>` — the requested zero-based position in Claude's
   * ordered cswap inventory. `null` means automatic account routing.
   */
  launcherAccountOrdinal: number | null;
  /** Invalid/missing selector diagnostic; main exits 2 before launching. */
  launcherAccountError: string | null;
  /** Inherited Fable intent carried by a continuation producer. */
  launcherFableIntent: boolean | null;
  /** Invalid hidden lineage carrier diagnostic. */
  launcherFableIntentError: string | null;
}

/**
 * Parse the launcher's own flags out of `args`, returning the residual argv plus
 * the launch-mode signals.
 */
export function parseArgs(args: string[]): ParsedArgs {
  return parseArgsForAgent(args, "claude");
}

/**
 * Agent-aware variant used by main(). Signal extraction respects each active
 * harness while forwarding native flags unchanged.
 */
export function parseArgsForAgent(
  args: string[],
  agent: AgentKind,
): ParsedArgs {
  const remainingArgs: string[] = [];
  let hasContinueOrResume = false;
  let hasForkSession = false;
  let hasPrint = false;
  let launcherVerbose = false;
  let launcherVeryVerbose = false;
  let launcherNoConfirm = false;
  let launcherPreset: string | null = null;
  let launcherAccountOrdinal: number | null = null;
  let launcherAccountError: string | null = null;
  let launcherFableIntent: boolean | null = null;
  let launcherFableIntentError: string | null = null;
  let parsingIgnoredProfile = false;
  let parsingLauncherPreset = false;
  let parsingLauncherAccount = false;

  const setLauncherAccount = (raw: string): void => {
    if (agent !== "claude") {
      launcherAccountOrdinal = null;
      launcherAccountError = "--x-account is only valid for Claude";
      return;
    }
    const match = raw.trim().match(/^(?:c)?(0|[1-9]\d*)$/);
    const ordinal = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(ordinal)) {
      launcherAccountOrdinal = null;
      launcherAccountError =
        "--x-account expects cN or N (a zero-based cswap inventory index)";
      return;
    }
    launcherAccountOrdinal = ordinal;
    launcherAccountError = null;
  };

  for (const arg of args) {
    if (parsingIgnoredProfile) {
      parsingIgnoredProfile = false;
      continue;
    }
    if (parsingLauncherPreset) {
      launcherPreset = arg.trim() || null;
      parsingLauncherPreset = false;
      continue;
    }
    if (parsingLauncherAccount) {
      setLauncherAccount(arg);
      parsingLauncherAccount = false;
      continue;
    }
    if (arg === "--x-verbose") {
      launcherVerbose = true;
    } else if (arg === "--x-very-verbose") {
      launcherVeryVerbose = true;
    } else if (arg === "--x-no-confirm") {
      launcherNoConfirm = true;
    } else if (arg === "--x-profile") {
      parsingIgnoredProfile = true;
    } else if (arg.startsWith("--x-profile=")) {
      // Consumed compatibility no-op: Keeper no longer owns profile farms.
    } else if (arg === "--x-preset") {
      parsingLauncherPreset = true;
    } else if (arg.startsWith("--x-preset=")) {
      launcherPreset = arg.slice("--x-preset=".length).trim() || null;
    } else if (arg === "--x-account") {
      parsingLauncherAccount = true;
    } else if (arg.startsWith("--x-account=")) {
      setLauncherAccount(arg.slice("--x-account=".length));
    } else if (arg.startsWith("--x-fable-intent=")) {
      const value = arg.slice("--x-fable-intent=".length);
      if (agent !== "claude" || (value !== "0" && value !== "1")) {
        launcherFableIntent = null;
        launcherFableIntentError =
          "--x-fable-intent expects 0 or 1 and is only valid for Claude";
      } else {
        launcherFableIntent = value === "1";
        launcherFableIntentError = null;
      }
    } else {
      remainingArgs.push(arg);
      if (isContinueOrResumeArg(arg, agent)) {
        hasContinueOrResume = true;
        if (isForkArg(arg, agent)) {
          hasForkSession = true;
        }
      } else if (isHeadlessArg(arg, agent)) {
        hasPrint = true;
      }
    }
  }

  if (parsingLauncherAccount) {
    launcherAccountError =
      "--x-account expects cN or N (a zero-based cswap inventory index)";
  }
  return {
    remainingArgs,
    hasContinueOrResume,
    hasForkSession,
    hasPrint,
    launcherVerbose,
    launcherVeryVerbose,
    launcherNoConfirm,
    launcherPreset,
    launcherAccountOrdinal,
    launcherAccountError,
    launcherFableIntent,
    launcherFableIntentError,
  };
}

function isContinueOrResumeArg(arg: string, agent: AgentKind): boolean {
  if (agent === "claude") {
    return (
      arg === "--continue" ||
      arg === "--resume" ||
      arg === "--fork-session" ||
      arg === "-c" ||
      arg === "-r"
    );
  }
  return (
    arg === "--continue" ||
    arg === "--resume" ||
    arg === "--session" ||
    arg === "--fork" ||
    arg === "--no-session" ||
    arg === "-c" ||
    arg === "-r"
  );
}

function isForkArg(arg: string, agent: AgentKind): boolean {
  if (agent === "claude") {
    return arg === "--fork-session";
  }
  return arg === "--fork";
}

function isHeadlessArg(arg: string, agent: AgentKind): boolean {
  if (agent === "claude") {
    return arg === "--print" || arg === "-p";
  }
  return (
    arg === "--print" ||
    arg === "-p" ||
    arg === "--mode" ||
    arg.startsWith("--mode=")
  );
}
