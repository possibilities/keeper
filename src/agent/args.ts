/**
 * Launcher flag parsing — the pre-pass that strips the launcher's own
 * `--agentwrap-*` flags from argv before the residual is handed to the agent, and
 * surfaces the launch mode signals (continuation, headless, fork, profile) the
 * rest of main() branches on.
 *
 * Three consumed flags carry no value (`--agentwrap-verbose`,
 * `--agentwrap-very-verbose`, `--agentwrap-no-confirm`) and wrapper value flags
 * (`--agentwrap-profile`, `--agentwrap-preset`,
 * `--agentwrap-codex-session-name`) take either split (`--agentwrap-profile x`)
 * or joined (`--agentwrap-profile=x`) form. Every other token passes through verbatim into
 * `remainingArgs`, preserving order — the agent sees exactly what the human
 * typed minus the launcher flags. A stray non-launcher flag (including the
 * retired `--arthack-*` spelling) is forwarded to the agent, which rejects it
 * loudly.
 */

import type { AgentKind } from "./dispatch";
import { CODEX_OPTIONS_WITH_REQUIRED_VALUE } from "./passthrough";

/** Normalize a CLI-visible profile alias onto internal routing. */
export function normalizeAgentwrapProfileArg(profileName: string): string {
  const normalized = profileName.trim();
  if (normalized === "default") {
    return "";
  }
  return normalized;
}

export interface ParsedArgs {
  /** argv with launcher flags stripped — forwarded to the agent verbatim. */
  remainingArgs: string[];
  /** Agent-native continuation/resume/session selection was seen. */
  hasContinueOrResume: boolean;
  /** Agent-native fork mode was seen. */
  hasForkSession: boolean;
  /** Agent-native headless mode was seen. */
  hasPrint: boolean;
  /** `--agentwrap-verbose` seen — print one line per startup section. */
  agentwrapVerbose: boolean;
  /**
   * `--agentwrap-very-verbose` seen — section lines plus the full action log and
   * composed claude command. Implies `--agentwrap-verbose`.
   */
  agentwrapVeryVerbose: boolean;
  /** `--agentwrap-no-confirm` seen — suppress the cwd-confirm prompt. */
  agentwrapNoConfirm: boolean;
  /** Resolved profile selector: `"auto"`, `""` (default account), or a name. */
  agentwrapProfile: string;
  /** True when a profile was specified on the CLI (vs. defaulted to "auto"). */
  explicitAgentwrapProfile: boolean;
  /** Synthetic Codex session name to index once the live session id is known. */
  agentwrapCodexSessionName: string | null;
  /**
   * `--agentwrap-preset <name>` — a named launch-config preset resolved from
   * `presets.yaml` that supplies harness/model/effort defaults BELOW any
   * explicit flag or effort env. `null` when unset (no "auto"); the preset
   * never overrides an explicit `--model`/`--effort`.
   */
  agentwrapPreset: string | null;
  /**
   * `--agentwrap-modal` seen — experimental: host claude in a Bun PTY under an
   * OpenTUI modal-overlay shell. Opt-in, claude-only, interactive-TTY-only;
   * stripped from `remainingArgs` so the child never sees it.
   */
  agentwrapModal: boolean;
}

/**
 * Parse the launcher's own flags out of `args`, returning the residual argv plus
 * the launch-mode signals. Does NOT apply the AGENTWRAP_PROFILE env override or
 * the "default"-normalization — those happen in main() after parsing, logged as
 * separate action-log entries.
 */
export function parseArgs(args: string[]): ParsedArgs {
  return parseArgsForAgent(args, "claude");
}

/**
 * Agent-aware variant used by main(). Claude and Codex reuse the wrapper flags
 * but disagree on native short options: Claude `-p` is print and `-c` is
 * continue; Codex `-p` is profile and `-c` is config. Signal extraction must
 * respect that split while forwarding all native flags unchanged.
 */
export function parseArgsForAgent(
  args: string[],
  agent: AgentKind,
): ParsedArgs {
  const remainingArgs: string[] = [];
  let hasContinueOrResume = false;
  let hasForkSession = false;
  let hasPrint = false;
  let agentwrapVerbose = false;
  let agentwrapVeryVerbose = false;
  let agentwrapNoConfirm = false;
  let agentwrapModal = false;
  let agentwrapProfile = "auto";
  let agentwrapCodexSessionName: string | null = null;
  let agentwrapPreset: string | null = null;
  let explicitAgentwrapProfile = false;
  let parsingAgentwrapProfile = false;
  let parsingAgentwrapCodexSessionName = false;
  let parsingAgentwrapPreset = false;

  for (const arg of args) {
    if (parsingAgentwrapProfile) {
      agentwrapProfile = arg;
      explicitAgentwrapProfile = true;
      parsingAgentwrapProfile = false;
      continue;
    }
    if (parsingAgentwrapCodexSessionName) {
      agentwrapCodexSessionName = arg.trim() || null;
      parsingAgentwrapCodexSessionName = false;
      continue;
    }
    if (parsingAgentwrapPreset) {
      agentwrapPreset = arg.trim() || null;
      parsingAgentwrapPreset = false;
      continue;
    }
    if (arg === "--agentwrap-verbose") {
      agentwrapVerbose = true;
    } else if (arg === "--agentwrap-very-verbose") {
      agentwrapVeryVerbose = true;
    } else if (arg === "--agentwrap-no-confirm") {
      agentwrapNoConfirm = true;
    } else if (arg === "--agentwrap-modal") {
      agentwrapModal = true;
    } else if (arg === "--agentwrap-profile") {
      parsingAgentwrapProfile = true;
      explicitAgentwrapProfile = true;
    } else if (arg.startsWith("--agentwrap-profile=")) {
      agentwrapProfile = arg.slice("--agentwrap-profile=".length);
      explicitAgentwrapProfile = true;
    } else if (arg === "--agentwrap-codex-session-name") {
      parsingAgentwrapCodexSessionName = true;
    } else if (arg.startsWith("--agentwrap-codex-session-name=")) {
      agentwrapCodexSessionName =
        arg.slice("--agentwrap-codex-session-name=".length).trim() || null;
    } else if (arg === "--agentwrap-preset") {
      parsingAgentwrapPreset = true;
    } else if (arg.startsWith("--agentwrap-preset=")) {
      agentwrapPreset = arg.slice("--agentwrap-preset=".length).trim() || null;
    } else {
      remainingArgs.push(arg);
      if (agent !== "codex" && isContinueOrResumeArg(arg, agent)) {
        hasContinueOrResume = true;
        if (isForkArg(arg, agent)) {
          hasForkSession = true;
        }
      } else if (agent !== "codex" && isHeadlessArg(arg, agent)) {
        hasPrint = true;
      }
    }
  }

  if (agent === "codex") {
    const command = firstCodexCommand(remainingArgs);
    if (command === "resume" || command === "fork") {
      hasContinueOrResume = true;
      hasForkSession = command === "fork";
    } else if (command === "exec" || command === "review") {
      hasPrint = true;
    }
  }

  return {
    remainingArgs,
    hasContinueOrResume,
    hasForkSession,
    hasPrint,
    agentwrapVerbose,
    agentwrapVeryVerbose,
    agentwrapNoConfirm,
    agentwrapModal,
    agentwrapProfile,
    explicitAgentwrapProfile,
    agentwrapCodexSessionName,
    agentwrapPreset,
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
  if (agent === "codex") {
    return arg === "resume" || arg === "fork";
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
  if (agent === "codex") {
    return arg === "fork";
  }
  return arg === "--fork";
}

function isHeadlessArg(arg: string, agent: AgentKind): boolean {
  if (agent === "claude") {
    return arg === "--print" || arg === "-p";
  }
  if (agent === "codex") {
    return arg === "exec" || arg === "review";
  }
  return (
    arg === "--print" ||
    arg === "-p" ||
    arg === "--mode" ||
    arg.startsWith("--mode=")
  );
}

function firstCodexCommand(args: string[]): string | null {
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx] as string;
    if (arg === "--") {
      return null;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (arg.includes("=")) {
        idx += 1;
        continue;
      }
      if (CODEX_OPTIONS_WITH_REQUIRED_VALUE.has(arg)) {
        idx += 2;
        continue;
      }
      idx += 1;
      continue;
    }
    return arg;
  }
  return null;
}
