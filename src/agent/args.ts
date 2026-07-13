/**
 * Launcher flag parsing — the pre-pass that strips the launcher's own
 * `--x-*` flags from argv before the residual is handed to the agent, and
 * surfaces the launch mode signals (continuation, headless, fork, profile) the
 * rest of main() branches on.
 *
 * Three consumed flags carry no value (`--x-verbose`,
 * `--x-very-verbose`, `--x-no-confirm`) and wrapper value flags
 * (`--x-preset`) take either split (`--x-profile x`)
 * or joined (`--x-profile=x`) form. Every other token passes through verbatim into
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
}

/**
 * Parse the launcher's own flags out of `args`, returning the residual argv plus
 * the launch-mode signals. Does NOT apply the KEEPER_AGENT_PROFILE env override or
 * the "default"-normalization — those happen in main() after parsing, logged as
 * separate action-log entries.
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
  let parsingLauncherPreset = false;

  for (const arg of args) {
    if (parsingLauncherPreset) {
      launcherPreset = arg.trim() || null;
      parsingLauncherPreset = false;
      continue;
    }
    if (arg === "--x-verbose") {
      launcherVerbose = true;
    } else if (arg === "--x-very-verbose") {
      launcherVeryVerbose = true;
    } else if (arg === "--x-no-confirm") {
      launcherNoConfirm = true;
    } else if (arg === "--x-preset") {
      parsingLauncherPreset = true;
    } else if (arg.startsWith("--x-preset=")) {
      launcherPreset = arg.slice("--x-preset=".length).trim() || null;
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

  return {
    remainingArgs,
    hasContinueOrResume,
    hasForkSession,
    hasPrint,
    launcherVerbose,
    launcherVeryVerbose,
    launcherNoConfirm,
    launcherPreset,
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
  if (agent === "hermes") {
    // Hermes resumes by ID (`--resume`/`-r`) or by name/most-recent
    // (`--continue`/`-c`); it has no fork or session-select flag.
    return (
      arg === "--resume" || arg === "--continue" || arg === "-r" || arg === "-c"
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
  if (agent === "hermes") {
    return false;
  }
  return arg === "--fork";
}

function isHeadlessArg(arg: string, agent: AgentKind): boolean {
  if (agent === "claude") {
    return arg === "--print" || arg === "-p";
  }
  if (agent === "hermes") {
    // Hermes's one-shot mode prints only the final message — headless-equivalent.
    return arg === "-z" || arg === "--oneshot";
  }
  return (
    arg === "--print" ||
    arg === "-p" ||
    arg === "--mode" ||
    arg.startsWith("--mode=")
  );
}
