#!/usr/bin/env bun
/** `keeper daemon restart` — restart the LaunchAgent and wait for a caught-up serve. */

import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveRestartLedgerPath } from "../src/db";
import { parseRestartLedger } from "../src/restart-ledger";
import { parseOptions } from "./descriptor";
import { parseDuration } from "./duration";
import { emitEnvelope, errorEnvelope, successEnvelope } from "./envelope";

export const RESTART_SCHEMA_VERSION = 1;
// Post-boot catch-up on a loaded event store runs minutes before reporting
// caught-up, and lengthens as the store grows; the default waits generously
// for a genuinely-booting daemon (a healthy boot returns at the third clean
// probe, well before this bound) while `--timeout` still overrides.
export const DEFAULT_RESTART_TIMEOUT_MS = 600_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
// `launchctl kickstart -k` does a real kill-and-respawn, not an instant call,
// so it needs a multi-second budget to complete without being TERM-killed
// mid-work. 15s fits that shape with margin while still bounding a
// genuinely wedged launchctl.
export const KICKSTART_TIMEOUT_MS = 15_000;
export const REQUIRED_HEALTHY_PROBES = 3;
export const INITIAL_BACKOFF_MS = 100;
export const MAX_BACKOFF_MS = 1_500;
export const MAX_KICKSTART_OUTPUT_CHARS = 4_096;

export const DAEMON_HELP = `keeper daemon — daemon lifecycle operations

Usage:
  keeper daemon restart [--timeout <duration>] [--sock <path>]
  keeper daemon --help

Subcommands:
  restart  Restart keeperd and wait for a caught-up serve
`;

export const HELP = `keeper daemon restart — restart keeperd and wait for a caught-up serve

Usage:
  keeper daemon restart [--timeout <duration>] [--sock <path>]

Runs \`launchctl kickstart -k gui/$UID/arthack.keeperd\`, then waits for the
socket to answer a read query whose boot status reports \`catching_up: false\`.
The wait is bounded; a refused socket while the old daemon releases its flock is
transient. A launchd throttle is reported separately from a slow boot.

Flags:
  --timeout <duration>  Overall wait bound (default 2m30s; e.g. 10s, 2m)
  --sock <path>         Daemon socket override ($KEEPER_SOCK / default)
  --help, -h            Show this help

Exit codes:
  0  daemon answered healthy and caught up
  1  kickstart failed, launchd throttled respawn, or health wait timed out
  2  usage error

Plist edits need \`launchctl bootout\` plus \`launchctl bootstrap\`; kickstart
only restarts the already bootstrapped job.
`;

export type RestartProblemCode =
  | "kickstart-failed"
  | "health-timeout"
  | "throttled-respawn";

export interface ParsedRestartArgs {
  sock: string;
  timeoutMs: number;
}

type ParseResult =
  | { ok: true; args: ParsedRestartArgs }
  | { ok: false; message: string; help: boolean };

function resolveSockPath(): string {
  const override = process.env.KEEPER_SOCK;
  return override && override.length > 0
    ? override
    : join(homedir(), ".local", "state", "keeper", "keeperd.sock");
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (typeof uid === "number") return uid;
  const fallback = Number(process.env.UID);
  return Number.isInteger(fallback) ? fallback : 0;
}

export function parseRestartArgs(argv: string[]): ParseResult {
  if (argv[0] !== "restart") {
    return {
      ok: false,
      help: false,
      message: "expected the 'restart' verb",
    };
  }

  let values: Record<string, unknown>;
  try {
    values = parseArgs({
      args: argv.slice(1),
      options: parseOptions("daemon", "restart"),
      allowPositionals: false,
      strict: true,
    }).values as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      help: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (values.help === true) return { ok: false, help: true, message: "" };

  let timeoutMs = DEFAULT_RESTART_TIMEOUT_MS;
  if (typeof values.timeout === "string") {
    const parsed = parseDuration(values.timeout);
    if (!parsed.ok) {
      return { ok: false, help: false, message: `--timeout ${parsed.message}` };
    }
    timeoutMs = parsed.ms;
  }
  return {
    ok: true,
    args: {
      timeoutMs,
      sock: typeof values.sock === "string" ? values.sock : resolveSockPath(),
    },
  };
}

export function launchctlDomain(uid: number): string {
  return `gui/${uid}/arthack.keeperd`;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RestartBootMarker {
  boot_id: string;
  ts: number;
}

export interface KickstartWarning {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface RestartDeps {
  readonly runLaunchctl: (
    args: string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
  /** True only when the socket served a reply with `boot.catching_up === false`. */
  readonly probeHealth: (sock: string, timeoutMs: number) => Promise<boolean>;
  /** Reads the newest boot ledger entry so health cannot be attributed to a stale daemon. */
  readonly readLatestBoot: () => Promise<RestartBootMarker | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
  readonly uid: () => number;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly exit: (code: number) => never;
}

export function isThrottledLaunchctlState(output: string): boolean {
  return (
    /\bthrottled\b/i.test(output) ||
    /(?:state|reason)\s*=\s*[^\n]*\bthrottl/i.test(output)
  );
}

function failure(
  code: RestartProblemCode,
  deps: RestartDeps,
  kickstartWarning?: KickstartWarning,
): void {
  const details: Record<
    RestartProblemCode,
    { message: string; recovery: string }
  > = {
    "kickstart-failed": {
      message: "launchd could not restart the keeper daemon.",
      recovery:
        "Confirm the LaunchAgent is bootstrapped, then retry. Plist edits require launchctl bootout plus bootstrap, not kickstart.",
    },
    "health-timeout": {
      message:
        "The keeper daemon did not become healthy and caught up before the restart deadline.",
      recovery:
        "Inspect the daemon's launchd status and server stderr, then retry once the boot fault is fixed.",
    },
    "throttled-respawn": {
      message: "launchd is throttling keeperd after repeated respawns.",
      recovery:
        "Inspect server stderr for the crash loop, fix the boot fault, then retry the restart.",
    },
  };
  emitEnvelope(
    errorEnvelope(RESTART_SCHEMA_VERSION, {
      code,
      ...details[code],
      ...(kickstartWarning === undefined
        ? {}
        : { details: { kickstart_warning: kickstartWarning } }),
    }),
    deps,
  );
}

function boundKickstartOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_KICKSTART_OUTPUT_CHARS) return trimmed;
  const suffix = "…[truncated]";
  return `${trimmed.slice(0, MAX_KICKSTART_OUTPUT_CHARS - suffix.length)}${suffix}`;
}

function kickstartWarning(result: CommandResult): KickstartWarning {
  return {
    exit_code: result.exitCode,
    stdout: boundKickstartOutput(result.stdout),
    stderr: boundKickstartOutput(result.stderr),
    timed_out: result.timedOut === true,
  };
}

function isFreshBoot(
  before: RestartBootMarker | null,
  current: RestartBootMarker | null,
): boolean {
  if (current === null) return false;
  return (
    before === null ||
    current.boot_id !== before.boot_id ||
    current.ts > before.ts
  );
}

export async function readLatestBoot(): Promise<RestartBootMarker | null> {
  let raw: string;
  try {
    raw = await readFile(resolveRestartLedgerPath(), "utf8");
  } catch {
    return null;
  }
  const latest = parseRestartLedger(raw)
    .filter((line) => line.kind === "boot")
    .at(-1);
  return latest === undefined
    ? null
    : { boot_id: latest.boot_id, ts: latest.ts };
}

/**
 * Caught-up verdict for one served reply frame. The serve worker stamps a
 * `boot` header onto object-form frames while any catch-up state holds, and a
 * pre-serialized memo line rides ONLY at steady state — so an absent header on
 * a `result` frame is itself caught-up evidence, and only a positive
 * `catching_up: true` reads as still booting.
 */
export function isCaughtUpFrame(frame: {
  type?: unknown;
  boot?: { catching_up?: unknown };
}): boolean {
  return frame.type === "result" && frame.boot?.catching_up !== true;
}

/** One bounded healthy attempt. Connection refusal is simply `false`, never fatal. */
export async function probeSocketHealth(
  sockPath: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = "";
    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(healthy);
    };
    const socket = createConnection({ path: sockPath });
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("error", () => finish(false));
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      try {
        const frame = JSON.parse(buffered.slice(0, newline)) as {
          type?: unknown;
          boot?: { catching_up?: unknown };
        };
        finish(isCaughtUpFrame(frame));
      } catch {
        finish(false);
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "query", collection: "jobs", limit: 1 })}\n`,
      );
    });
  });
}

async function runLaunchctl(
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const child = Bun.spawn(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // A process that already exited needs no cleanup.
    }
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

function jitteredBackoff(baseMs: number, random: () => number): number {
  return Math.max(1, Math.round(baseMs * (0.8 + random() * 0.4)));
}

export async function runRestart(
  args: ParsedRestartArgs,
  deps: RestartDeps,
): Promise<void> {
  const startedAt = deps.now();
  const deadline = startedAt + args.timeoutMs;
  const domain = launchctlDomain(deps.uid());
  const preRestartBoot = await deps.readLatestBoot();
  let kickstart: CommandResult;
  try {
    kickstart = await deps.runLaunchctl(
      ["kickstart", "-k", domain],
      Math.min(KICKSTART_TIMEOUT_MS, args.timeoutMs),
    );
  } catch {
    failure("kickstart-failed", deps);
    return;
  }
  const failedKickstart =
    kickstart.exitCode !== 0 || kickstart.timedOut === true;
  const retainedKickstart = kickstartWarning(kickstart);
  const retainedKickstartWarning = failedKickstart
    ? retainedKickstart
    : undefined;

  const emitSuccess = (healthyProbes: number): void => {
    emitEnvelope(
      successEnvelope(RESTART_SCHEMA_VERSION, {
        domain,
        healthy_probes: healthyProbes,
        ...(retainedKickstartWarning === undefined
          ? {}
          : { kickstart_warning: retainedKickstartWarning }),
      }),
      deps,
    );
  };

  let healthyInARow = 0;
  let backoffMs = INITIAL_BACKOFF_MS;
  while (deps.now() < deadline) {
    const remaining = deadline - deps.now();
    const healthy = await deps.probeHealth(
      args.sock,
      Math.max(1, Math.min(DEFAULT_PROBE_TIMEOUT_MS, remaining)),
    );
    if (healthy) {
      healthyInARow += 1;
      if (
        healthyInARow >= REQUIRED_HEALTHY_PROBES &&
        isFreshBoot(preRestartBoot, await deps.readLatestBoot())
      ) {
        emitSuccess(healthyInARow);
        return;
      }
    } else {
      healthyInARow = 0;
      let state: CommandResult | null = null;
      try {
        state = await deps.runLaunchctl(
          ["print", domain],
          Math.max(
            1,
            Math.min(DEFAULT_PROBE_TIMEOUT_MS, deadline - deps.now()),
          ),
        );
      } catch {
        // A failed state probe cannot make a refused boot terminal.
      }
      if (
        state !== null &&
        isThrottledLaunchctlState(`${state.stdout}\n${state.stderr}`)
      ) {
        failure("throttled-respawn", deps);
        return;
      }
    }
    const waitMs = Math.min(
      jitteredBackoff(backoffMs, deps.random),
      Math.max(0, deadline - deps.now()),
    );
    if (waitMs <= 0) break;
    await deps.sleep(waitMs);
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  }
  // The fresh-boot ledger row is monotonic — once the new boot lands it stays —
  // but the in-loop check only re-reads it on a healthy probe, so a boot that
  // lands during the final backoff before the deadline is never re-evaluated.
  // Re-check the evidence one last time: consecutive healthy probes plus a
  // landed fresh boot prove the restart succeeded, regardless of the kickstart
  // exit code (a nonzero/timed-out kickstart is retained as a warning, not a
  // terminal verdict — exit 143 is our own launchctl-kill timeout, not a failed
  // restart).
  if (
    healthyInARow >= REQUIRED_HEALTHY_PROBES &&
    isFreshBoot(preRestartBoot, await deps.readLatestBoot())
  ) {
    emitSuccess(healthyInARow);
    return;
  }
  failure(
    failedKickstart ? "kickstart-failed" : "health-timeout",
    deps,
    retainedKickstartWarning,
  );
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(DAEMON_HELP);
    process.exit(0);
  }
  const parsed = parseRestartArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper daemon: ${parsed.message}\n\n${HELP}`);
    process.exit(2);
  }
  await runRestart(parsed.args, {
    runLaunchctl,
    probeHealth: probeSocketHealth,
    readLatestBoot,
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    random: () => Math.random(),
    uid: currentUid,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  });
}
