#!/usr/bin/env bun
/** Foreground Codex usage-reset command group. */

import { parseArgs } from "node:util";
import {
  buildProductionCodexUsageResetDeps,
  type CodexResetLoopOptions,
  type CodexUsageResetOutcome,
  DEFAULT_CODEX_RESET_CHECK_EVERY_MS,
  DEFAULT_CODEX_RESET_NOTIFY_EVERY_PERCENT,
  MAX_CODEX_RESET_CHECK_EVERY_MS,
  MIN_CODEX_RESET_CHECK_EVERY_MS,
  runCodexUsageResetController,
} from "../src/codex-usage-reset";
import { buildParseOptions, USAGE_RESET_CODEX_FLAGS } from "./descriptor";
import { parseDuration } from "./duration";

export const RESET_CODEX_VERB = "reset-codex-before-exceeding";

export const HELP = `keeper usage — foreground quota controls

Usage:
  keeper usage reset-codex-before-exceeding [--check-every <duration>] [--notify-every <integer>]

Verbs:
  reset-codex-before-exceeding  Wait, then redeem one Codex reset near weekly exhaustion

Flags:
  --check-every <duration>  Poll cadence, 5s..5m (default 30s)
  --notify-every <integer>  Progress boundary in used percentage points, 1..100 (default 5)
  --help, -h                Show this help
`;

export type UsageArgParse =
  | {
      readonly ok: true;
      readonly options: Required<
        Pick<CodexResetLoopOptions, "checkEveryMs" | "notifyEveryPercent">
      >;
    }
  | { readonly ok: false; readonly message: string };

export function parseUsageResetArgs(argv: string[]): UsageArgParse {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: buildParseOptions(USAGE_RESET_CODEX_FLAGS),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (parsed.positionals.length > 0) {
    return {
      ok: false,
      message: `unexpected argument '${parsed.positionals[0]}'`,
    };
  }
  const checkRaw = parsed.values["check-every"];
  let checkEveryMs = DEFAULT_CODEX_RESET_CHECK_EVERY_MS;
  if (typeof checkRaw === "string") {
    const duration = parseDuration(checkRaw);
    if (!duration.ok) {
      return { ok: false, message: `--check-every ${duration.message}` };
    }
    checkEveryMs = duration.ms;
  }
  if (
    checkEveryMs < MIN_CODEX_RESET_CHECK_EVERY_MS ||
    checkEveryMs > MAX_CODEX_RESET_CHECK_EVERY_MS
  ) {
    return { ok: false, message: "--check-every must be between 5s and 5m" };
  }

  const notifyRaw = parsed.values["notify-every"];
  let notifyEveryPercent = DEFAULT_CODEX_RESET_NOTIFY_EVERY_PERCENT;
  if (typeof notifyRaw === "string") {
    if (!/^\d+$/u.test(notifyRaw)) {
      return {
        ok: false,
        message: "--notify-every must be an integer from 1 to 100",
      };
    }
    notifyEveryPercent = Number.parseInt(notifyRaw, 10);
  }
  if (notifyEveryPercent < 1 || notifyEveryPercent > 100) {
    return {
      ok: false,
      message: "--notify-every must be an integer from 1 to 100",
    };
  }
  return { ok: true, options: { checkEveryMs, notifyEveryPercent } };
}

export interface UsageCommandDeps {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal: AbortSignal;
  readonly runController: (
    options: CodexResetLoopOptions,
  ) => Promise<CodexUsageResetOutcome>;
  readonly cancellationExitCode?: () => number;
}

export function exitCodeForUsageOutcome(
  outcome: CodexUsageResetOutcome,
  cancellationCode = 130,
): number {
  if (outcome.kind === "confirmed") return 0;
  if (outcome.kind === "cancelled") return cancellationCode;
  return 1;
}

/** Parse and forward the usage group without touching process-global state. */
export async function runUsageCommand(
  argv: string[],
  deps: UsageCommandDeps,
): Promise<number> {
  const head = argv[0];
  if (
    head === undefined ||
    head === "--help" ||
    head === "-h" ||
    head === "help"
  ) {
    if (argv.length > 1) {
      deps.stderr(`keeper usage: unexpected argument '${argv[1]}'\n\n${HELP}`);
      return 2;
    }
    deps.stdout(HELP);
    return 0;
  }
  if (head !== RESET_CODEX_VERB) {
    deps.stderr(`keeper usage: unknown verb '${head}'\n\n${HELP}`);
    return 2;
  }
  const leafArgs = argv.slice(1);
  if (leafArgs.some((arg) => arg === "--help" || arg === "-h")) {
    const withoutHelp = leafArgs.filter(
      (arg) => arg !== "--help" && arg !== "-h",
    );
    const helpParse = parseUsageResetArgs(withoutHelp);
    if (!helpParse.ok) {
      deps.stderr(`keeper usage: ${helpParse.message}\n\n${HELP}`);
      return 2;
    }
    deps.stdout(HELP);
    return 0;
  }
  const parsed = parseUsageResetArgs(leafArgs);
  if (!parsed.ok) {
    deps.stderr(`keeper usage: ${parsed.message}\n\n${HELP}`);
    return 2;
  }
  const outcome = await deps.runController(parsed.options);
  return exitCodeForUsageOutcome(outcome, deps.cancellationExitCode?.() ?? 130);
}

export async function main(argv: string[]): Promise<void> {
  const abort = new AbortController();
  let cancellationCode = 130;
  const onSigint = (): void => {
    cancellationCode = 130;
    abort.abort();
  };
  const onSigterm = (): void => {
    cancellationCode = 143;
    abort.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const deps = buildProductionCodexUsageResetDeps({ signal: abort.signal });
    const code = await runUsageCommand(argv, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      signal: abort.signal,
      runController: (options) => runCodexUsageResetController(deps, options),
      cancellationExitCode: () => cancellationCode,
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
