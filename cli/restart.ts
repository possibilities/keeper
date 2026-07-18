#!/usr/bin/env bun
/** `keeper daemon restart` — restart the LaunchAgent and wait for a caught-up serve. */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveRestartLedgerPath } from "../src/db";
import { parseLinuxStarttime, splitArgsLstart } from "../src/proc-starttime";
import { readRestartLedgerSnapshot } from "../src/restart-ledger";
import {
  classifyRestartEvidence,
  DEFAULT_RESTART_STABILIZATION_MS,
  MAX_RESTART_DIAGNOSTIC_CHARS,
  type RestartEvidenceVerdict,
  type RestartHealthObservation,
  type RestartIdentity,
  type RestartLedgerSnapshot,
  type RestartProcessIdentityState,
} from "../src/restart-observation";
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
export const RESTART_STABILIZATION_MS = DEFAULT_RESTART_STABILIZATION_MS;
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

Runs \`launchctl kickstart -k gui/$UID/arthack.keeperd\` once, then proves the
old process identity is gone and one different ledger-backed served identity is
caught up and unchanged for at least 12 seconds. The wait is bounded; refused or
inconclusive evidence fails honestly and never triggers another kickstart.

Flags:
  --timeout <duration>  Overall wait bound (default 10m; e.g. 30s, 2m)
  --sock <path>         Daemon socket override ($KEEPER_SOCK / default)
  --help, -h            Show this help

Exit codes:
  0  one replacement identity satisfied durability, Drain, health, and stability
  1  restart evidence remained missing, mismatched, unstable, or inconclusive
  2  usage error

Plist edits need \`launchctl bootout\` plus \`launchctl bootstrap\`; kickstart
only restarts the already bootstrapped job.
`;

export type RestartProblemCode =
  | "kickstart-failed"
  | "health-timeout"
  | "restart-unproven"
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
  pid: number;
  start_time: string;
  ts: number;
}

export interface KickstartWarning {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export type RestartHealthProbe =
  | {
      status: "served";
      identity: RestartIdentity;
      healthy: boolean;
      catching_up: boolean;
    }
  | {
      status: "unavailable";
      diagnostic: string;
    };

export interface RestartDeps {
  readonly runLaunchctl: (
    args: string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
  readonly probeHealth: (
    sock: string,
    timeoutMs: number,
  ) => Promise<RestartHealthProbe>;
  readonly readBootLedger: () => Promise<RestartLedgerSnapshot>;
  readonly classifyOldProcess: (
    identity: RestartIdentity,
  ) => RestartProcessIdentityState | Promise<RestartProcessIdentityState>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
  readonly isCancelled?: () => boolean;
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

interface RestartFailureDiagnostics {
  evidence: RestartEvidenceVerdict;
  cancelled: boolean;
  pre_restart_probe?: string;
  last_probe?: string;
  ledger?: string;
  launchctl_state?: KickstartWarning;
  kickstart_warning?: KickstartWarning;
}

function failure(
  code: RestartProblemCode,
  deps: RestartDeps,
  diagnostics: RestartFailureDiagnostics,
): void {
  const details: Record<
    RestartProblemCode,
    { message: string; recovery: string }
  > = {
    "kickstart-failed": {
      message:
        "The restart command failed and the replacement evidence remained incomplete.",
      recovery:
        "Inspect the bounded evidence, launchd status, and daemon stderr. Reconcile the current daemon identity before issuing another restart.",
    },
    "health-timeout": {
      message:
        "The keeper daemon did not prove a stable caught-up replacement before the restart deadline.",
      recovery:
        "Inspect the bounded evidence and daemon stderr, then reconcile the current daemon identity before issuing another restart.",
    },
    "restart-unproven": {
      message:
        "The restart did not prove one stable ledger-backed replacement identity.",
      recovery:
        "Inspect the bounded evidence for missing, mismatched, or unstable identity data. Reconcile the current daemon identity before issuing another restart.",
    },
    "throttled-respawn": {
      message:
        "The restart remained unproven while launchctl reported a throttled respawn.",
      recovery:
        "Inspect daemon stderr for the crash loop, fix the boot fault, and reconcile the current daemon identity before retrying.",
    },
  };
  emitEnvelope(
    errorEnvelope(RESTART_SCHEMA_VERSION, {
      code,
      ...details[code],
      details: diagnostics,
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

function boundDiagnostic(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_RESTART_DIAGNOSTIC_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_RESTART_DIAGNOSTIC_CHARS - 12)}…[truncated]`;
}

export async function readRestartBootLedger(): Promise<RestartLedgerSnapshot> {
  const snapshot = readRestartLedgerSnapshot(resolveRestartLedgerPath());
  if (snapshot.status === "missing") return { status: "missing" };
  if (snapshot.status === "unreadable") {
    return {
      status: "unreadable",
      diagnostic: boundDiagnostic(snapshot.diagnostic),
    };
  }
  return {
    status: "readable",
    boots: snapshot.lines.flatMap((line) =>
      line.kind === "boot" && line.pid !== null && line.start_time !== null
        ? [
            {
              boot_id: line.boot_id,
              pid: line.pid,
              start_time: line.start_time,
              ts: line.ts,
            },
          ]
        : [],
    ),
  };
}

export async function readLatestBoot(): Promise<RestartBootMarker | null> {
  const snapshot = await readRestartBootLedger();
  return snapshot.status === "readable"
    ? (snapshot.boots.at(-1) ?? null)
    : null;
}

function validIdentity(value: unknown): value is RestartIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.boot_id === "string" &&
    identity.boot_id.length > 0 &&
    typeof identity.pid === "number" &&
    Number.isInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.start_time === "string" &&
    identity.start_time.length > 0
  );
}

export function parseRestartHealthFrame(frame: unknown): RestartHealthProbe {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return { status: "unavailable", diagnostic: "invalid response frame" };
  }
  const object = frame as Record<string, unknown>;
  const boot = object.boot;
  if (object.type !== "result") {
    return { status: "unavailable", diagnostic: "non-result response frame" };
  }
  if (!validIdentity(boot)) {
    return {
      status: "unavailable",
      diagnostic: "result frame omitted a valid served boot identity",
    };
  }
  const catchingUp = (boot as unknown as Record<string, unknown>).catching_up;
  if (typeof catchingUp !== "boolean") {
    return {
      status: "unavailable",
      diagnostic: "result frame omitted boolean Drain state",
    };
  }
  return {
    status: "served",
    identity: {
      boot_id: boot.boot_id,
      pid: boot.pid,
      start_time: boot.start_time,
    },
    healthy: true,
    catching_up: catchingUp,
  };
}

export function isCaughtUpFrame(frame: unknown): boolean {
  const observation = parseRestartHealthFrame(frame);
  return observation.status === "served" && !observation.catching_up;
}

export async function probeSocketHealth(
  sockPath: string,
  timeoutMs: number,
): Promise<RestartHealthProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = "";
    const finish = (observation: RestartHealthProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(observation);
    };
    const socket = createConnection({ path: sockPath });
    const timer = setTimeout(
      () =>
        finish({
          status: "unavailable",
          diagnostic: "socket probe timed out",
        }),
      timeoutMs,
    );
    socket.once("error", (error) =>
      finish({
        status: "unavailable",
        diagnostic: boundDiagnostic(error.message),
      }),
    );
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(parseRestartHealthFrame(JSON.parse(buffered.slice(0, newline))));
      } catch {
        finish({
          status: "unavailable",
          diagnostic: "socket returned malformed JSON",
        });
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "query", collection: "jobs", limit: 1 })}\n`,
      );
    });
  });
}

function readOsStartTime(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "lstart=,args="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) return null;
      const split = splitArgsLstart(result.stdout?.toString() ?? "");
      return split === null ? null : `darwin:${split.lstart}`;
    }
    if (process.platform === "linux") {
      const start = parseLinuxStarttime(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
      );
      return start === null ? null : `linux:${start}`;
    }
  } catch {}
  return null;
}

export function classifyOldProcess(
  identity: RestartIdentity,
): RestartProcessIdentityState {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unknown";
  }
  const current = readOsStartTime(identity.pid);
  if (current === null) return "unknown";
  return current === identity.start_time ? "alive" : "recycled";
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

  let preRestartProbe: RestartHealthProbe;
  try {
    preRestartProbe = await deps.probeHealth(
      args.sock,
      Math.max(1, Math.min(DEFAULT_PROBE_TIMEOUT_MS, args.timeoutMs)),
    );
  } catch (error) {
    preRestartProbe = {
      status: "unavailable",
      diagnostic: boundDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const preRestartIdentity =
    preRestartProbe.status === "served" ? preRestartProbe.identity : null;

  let preRestartLedger: RestartLedgerSnapshot;
  try {
    preRestartLedger = await deps.readBootLedger();
  } catch (error) {
    preRestartLedger = {
      status: "unreadable",
      diagnostic: boundDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const ledgerMarker =
    preRestartLedger.status === "readable"
      ? (preRestartLedger.boots.at(-1) ?? null)
      : null;
  const preRestartLedgerStatus =
    preRestartLedger.status === "readable"
      ? ledgerMarker === null
        ? "missing"
        : "readable"
      : preRestartLedger.status;

  let kickstart: CommandResult;
  try {
    kickstart = await deps.runLaunchctl(
      ["kickstart", "-k", domain],
      Math.max(1, Math.min(KICKSTART_TIMEOUT_MS, args.timeoutMs)),
    );
  } catch (error) {
    kickstart = {
      exitCode: -1,
      stdout: "",
      stderr: boundDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const failedKickstart =
    kickstart.exitCode !== 0 || kickstart.timedOut === true;
  const retainedKickstartWarning = failedKickstart
    ? kickstartWarning(kickstart)
    : undefined;
  const command = {
    issued: true,
    accepted: !failedKickstart,
    diagnostics: {
      exit_code: kickstart.exitCode,
      timed_out: kickstart.timedOut === true,
      stdout: kickstart.stdout,
      stderr: kickstart.stderr,
    },
  } as const;

  let health: RestartHealthObservation[] = [];
  let ledger = preRestartLedger;
  let oldProcess: RestartProcessIdentityState =
    preRestartIdentity === null ? "unknown" : "alive";
  let backoffMs = INITIAL_BACKOFF_MS;
  let lastProbeDiagnostic: string | undefined;
  let ledgerDiagnostic: string | undefined =
    ledger.status === "unreadable"
      ? boundDiagnostic(ledger.diagnostic ?? "ledger unreadable")
      : undefined;
  let launchctlState: KickstartWarning | undefined;
  let sawThrottledState = false;
  let cancelled = false;
  let evidence = classifyRestartEvidence({
    pre_restart: {
      served_identity: preRestartIdentity,
      ledger_marker: ledgerMarker,
      ledger_status: preRestartLedgerStatus,
    },
    command,
    old_process: oldProcess,
    ledger,
    health,
    monotonic: {
      started_at_ms: startedAt,
      now_ms: startedAt,
      deadline_at_ms: deadline,
      stabilization_ms: RESTART_STABILIZATION_MS,
    },
    required_healthy_observations: REQUIRED_HEALTHY_PROBES,
  });

  while (deps.now() <= deadline) {
    if (deps.isCancelled?.() === true) {
      cancelled = true;
      break;
    }
    const beforeProbe = deps.now();
    const remaining = deadline - beforeProbe;
    if (remaining < 0) break;

    let probe: RestartHealthProbe;
    try {
      probe = await deps.probeHealth(
        args.sock,
        Math.max(1, Math.min(DEFAULT_PROBE_TIMEOUT_MS, remaining)),
      );
    } catch (error) {
      probe = {
        status: "unavailable",
        diagnostic: boundDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    const observedAt = deps.now();
    if (probe.status === "served") {
      health.push({
        identity: probe.identity,
        observed_at_ms: observedAt,
        healthy: probe.healthy,
        catching_up: probe.catching_up,
      });
      if (health.length > 64) health = health.slice(-64);
      lastProbeDiagnostic = undefined;
    } else {
      health = [];
      lastProbeDiagnostic = boundDiagnostic(probe.diagnostic);
      try {
        const state = await deps.runLaunchctl(
          ["print", domain],
          Math.max(
            1,
            Math.min(DEFAULT_PROBE_TIMEOUT_MS, deadline - deps.now()),
          ),
        );
        launchctlState = kickstartWarning(state);
        sawThrottledState ||= isThrottledLaunchctlState(
          `${state.stdout}\n${state.stderr}`,
        );
      } catch (error) {
        launchctlState = {
          exit_code: -1,
          stdout: "",
          stderr: boundDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
          timed_out: false,
        };
      }
    }

    try {
      ledger = await deps.readBootLedger();
    } catch (error) {
      ledger = {
        status: "unreadable",
        diagnostic: boundDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    ledgerDiagnostic =
      ledger.status === "unreadable"
        ? boundDiagnostic(ledger.diagnostic ?? "ledger unreadable")
        : undefined;

    if (preRestartIdentity !== null) {
      try {
        oldProcess = await deps.classifyOldProcess(preRestartIdentity);
      } catch {
        oldProcess = "unknown";
      }
    }

    evidence = classifyRestartEvidence({
      pre_restart: {
        served_identity: preRestartIdentity,
        ledger_marker: ledgerMarker,
        ledger_status: preRestartLedgerStatus,
      },
      command,
      old_process: oldProcess,
      ledger,
      health,
      monotonic: {
        started_at_ms: startedAt,
        now_ms: observedAt,
        deadline_at_ms: deadline,
        stabilization_ms: RESTART_STABILIZATION_MS,
      },
      required_healthy_observations: REQUIRED_HEALTHY_PROBES,
    });
    if (evidence.verdict === "proven" && evidence.identity !== null) {
      emitEnvelope(
        successEnvelope(RESTART_SCHEMA_VERSION, {
          domain,
          identity: evidence.identity,
          healthy_probes: evidence.health.consecutive_caught_up_observations,
          stabilized_for_ms: evidence.stabilization.observed_for_ms,
          ...(retainedKickstartWarning === undefined
            ? {}
            : { kickstart_warning: retainedKickstartWarning }),
        }),
        deps,
      );
      return;
    }

    const waitMs = Math.min(
      jitteredBackoff(backoffMs, deps.random),
      Math.max(0, deadline - deps.now()),
    );
    if (waitMs <= 0) break;
    await deps.sleep(waitMs);
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  }

  const now = Math.max(startedAt, deps.now());
  evidence = classifyRestartEvidence({
    pre_restart: {
      served_identity: preRestartIdentity,
      ledger_marker: ledgerMarker,
      ledger_status: preRestartLedgerStatus,
    },
    command,
    old_process: oldProcess,
    ledger,
    health,
    monotonic: {
      started_at_ms: startedAt,
      now_ms: now,
      deadline_at_ms: deadline,
      stabilization_ms: RESTART_STABILIZATION_MS,
    },
    required_healthy_observations: REQUIRED_HEALTHY_PROBES,
  });

  const throttled = sawThrottledState;
  failure(
    failedKickstart
      ? "kickstart-failed"
      : throttled
        ? "throttled-respawn"
        : cancelled ||
            evidence.reasons.some((reason) =>
              [
                "durable-boot-mismatched",
                "ledger-missing",
                "ledger-unreadable",
                "replacement-during-stabilization",
                "pre-restart-identity-missing",
                "pre-restart-ledger-missing",
                "pre-restart-ledger-unreadable",
              ].includes(reason.code),
            )
          ? "restart-unproven"
          : "health-timeout",
    deps,
    {
      evidence,
      cancelled,
      ...(preRestartProbe.status === "unavailable"
        ? { pre_restart_probe: boundDiagnostic(preRestartProbe.diagnostic) }
        : {}),
      ...(lastProbeDiagnostic === undefined
        ? {}
        : { last_probe: lastProbeDiagnostic }),
      ...(ledgerDiagnostic === undefined ? {} : { ledger: ledgerDiagnostic }),
      ...(launchctlState === undefined
        ? {}
        : { launchctl_state: launchctlState }),
      ...(retainedKickstartWarning === undefined
        ? {}
        : { kickstart_warning: retainedKickstartWarning }),
    },
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
    readBootLedger: readRestartBootLedger,
    classifyOldProcess,
    sleep: (ms) => Bun.sleep(ms),
    now: () => performance.now(),
    random: () => Math.random(),
    uid: currentUid,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  });
}
