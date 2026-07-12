#!/usr/bin/env bun
/**
 * `keeper` offline maintenance window — ONE supported command for the whole
 * offline `keeper.db` reclaim, replacing the manual sequence stitched across a
 * CLI verb, a script, and raw launchctl:
 *
 *   bun scripts/reclaim-db.ts -> launchctl bootout ... -> keeper reclaim
 *   -> launchctl bootstrap ... -> keeper await server-up
 *
 * Sequence: capture autopilot state -> pause -> await the board drain signal
 * (`keeper status` .in_flight board-work + pending-dispatch counts) -> take a
 * pre-reclaim snapshot while the daemon is still live -> stop keeperd
 * (launchctl bootout) -> `keeper reclaim` (which ITSELF snapshots +
 * checkpoints + VACUUM INTOs + self-verifies + atomically swaps) -> restart
 * (launchctl bootstrap) -> `keeper await server-up` -> verify the result
 * (auto_vacuum=2, size, a search-history forensics probe) -> `--hold` (leave
 * autopilot paused) or restore it to whatever it was before the window.
 *
 * Fails safe at every step: once paused, this never unpauses except on the
 * single successful restore call at the very end. A `reclaim` failure (never
 * swaps on its own self-verify failure) restarts the daemon so the board
 * isn't stranded down, but stays paused for triage regardless of hold/play. A
 * post-restart `verify` failure leaves the pre-reclaim snapshot untouched and
 * autopilot paused — this function never deletes or restores a snapshot
 * itself; that is an operator triage step (see src/backup.ts's
 * restoreInstructions).
 *
 * Usage:
 *   bun scripts/maintenance-window.ts            # reclaim, then restore autopilot
 *   bun scripts/maintenance-window.ts --hold     # reclaim, leave autopilot paused
 *   bun scripts/maintenance-window.ts --help
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { daemonUp, run as runReclaimCli } from "../cli/reclaim";
import { backupDb } from "../src/backup";
import { KEEPERD_LAUNCHD_LABEL } from "../src/daemon";
import { openDb, resolveDbPath, resolveSockPath } from "../src/db";

// ---------------------------------------------------------------------------
// Pure orchestration — every I/O boundary is an injected dep so this can be
// tested with no real daemon, launchctl, or subprocess (see the "real deps"
// wiring below for the production implementations).
// ---------------------------------------------------------------------------

export interface StepResult {
  ok: boolean;
  error: string | null;
}

export interface CaptureResult extends StepResult {
  paused: boolean;
}

export interface SnapshotResult extends StepResult {
  path: string | null;
}

export interface MaintenanceWindowDeps {
  getAutopilotPaused(): Promise<CaptureResult>;
  setAutopilotPaused(paused: boolean): Promise<StepResult>;
  awaitDrain(): Promise<StepResult>;
  snapshot(): Promise<SnapshotResult>;
  stopDaemon(): Promise<StepResult>;
  reclaim(): Promise<StepResult>;
  startDaemon(): Promise<StepResult>;
  awaitServerUp(): Promise<StepResult>;
  verify(): Promise<StepResult>;
  log(line: string): void;
}

export interface MaintenanceWindowOptions {
  hold: boolean;
}

export type MaintenanceWindowStep =
  | "capture"
  | "pause"
  | "drain"
  | "snapshot"
  | "stop"
  | "reclaim"
  | "start"
  | "server-up"
  | "verify";

export type MaintenanceWindowResult =
  | { outcome: "restored" }
  | { outcome: "held" }
  | { outcome: "restore_failed"; error: string }
  | { outcome: "failed"; step: MaintenanceWindowStep; error: string };

/**
 * Run the whole offline-reclaim window against injected `deps`. Never throws
 * on a step failure — every fallible step reports `{ok:false, error}` and the
 * function returns a typed outcome instead. Once `setAutopilotPaused(true)`
 * succeeds, autopilot is NEVER unpaused again except by the single restore
 * call at the very end of the fully-successful, non-`--hold` path — every
 * other return (including every `failed` outcome) leaves it paused.
 */
export async function runMaintenanceWindow(
  opts: MaintenanceWindowOptions,
  deps: MaintenanceWindowDeps,
): Promise<MaintenanceWindowResult> {
  const captured = await deps.getAutopilotPaused();
  if (!captured.ok) {
    return {
      outcome: "failed",
      step: "capture",
      error: captured.error ?? "failed to read autopilot state",
    };
  }
  const wasPaused = captured.paused;
  deps.log(
    `autopilot was ${wasPaused ? "already paused" : "unpaused"} at window start`,
  );

  const paused = await deps.setAutopilotPaused(true);
  if (!paused.ok) {
    return {
      outcome: "failed",
      step: "pause",
      error: paused.error ?? "failed to pause autopilot",
    };
  }
  deps.log("autopilot paused");

  const drained = await deps.awaitDrain();
  if (!drained.ok) {
    return {
      outcome: "failed",
      step: "drain",
      error: drained.error ?? "board-work drain did not reach zero",
    };
  }
  deps.log("board drained (no active board-work sessions)");

  const snap = await deps.snapshot();
  if (!snap.ok) {
    return {
      outcome: "failed",
      step: "snapshot",
      error: snap.error ?? "pre-reclaim snapshot failed",
    };
  }
  deps.log(`pre-reclaim snapshot kept at ${snap.path}`);

  const stopped = await deps.stopDaemon();
  if (!stopped.ok) {
    return {
      outcome: "failed",
      step: "stop",
      error: stopped.error ?? "daemon did not stop",
    };
  }
  deps.log("daemon stopped");

  const reclaimed = await deps.reclaim();
  if (!reclaimed.ok) {
    // `keeper reclaim` self-verifies BEFORE it ever swaps, so a failure here
    // means the original DB is untouched — bring the daemon back so the board
    // isn't stranded down, but stay paused for triage regardless of hold/play.
    await deps.startDaemon();
    await deps.awaitServerUp();
    return {
      outcome: "failed",
      step: "reclaim",
      error: reclaimed.error ?? "reclaim failed",
    };
  }
  deps.log("reclaim verified and swapped in");

  const started = await deps.startDaemon();
  if (!started.ok) {
    return {
      outcome: "failed",
      step: "start",
      error: started.error ?? "daemon did not restart",
    };
  }

  const up = await deps.awaitServerUp();
  if (!up.ok) {
    return {
      outcome: "failed",
      step: "server-up",
      error: up.error ?? "daemon did not report up",
    };
  }
  deps.log("daemon back up");

  const verified = await deps.verify();
  if (!verified.ok) {
    // Fail-safe: never unpause on a verify mismatch. The pre-reclaim snapshot
    // from the `snapshot` step above is left exactly where it was — this
    // function never deletes or restores it.
    return {
      outcome: "failed",
      step: "verify",
      error: verified.error ?? "post-restart verify failed",
    };
  }
  deps.log("post-restart verify passed (auto_vacuum, size, history probe)");

  if (opts.hold) {
    deps.log("--hold: leaving autopilot paused");
    return { outcome: "held" };
  }

  const restored = await deps.setAutopilotPaused(wasPaused);
  if (!restored.ok) {
    // Surfaced distinctly from a `failed` reclaim: the reclaim itself
    // succeeded, only the final restore call did not.
    return {
      outcome: "restore_failed",
      error:
        `reclaim succeeded but restoring autopilot to paused=${wasPaused} failed: ` +
        `${restored.error ?? "unknown"} — autopilot state unknown, verify with 'keeper status --json'`,
    };
  }
  deps.log(`autopilot restored to paused=${wasPaused}`);
  return { outcome: "restored" };
}

// ---------------------------------------------------------------------------
// Real deps — production wiring over `keeper` subprocesses, launchctl, and
// direct src/backup.ts calls. Never exercised by the fast test tier (no real
// daemon / subprocess / launchctl there); the pure function above is what's
// under test.
// ---------------------------------------------------------------------------

const DRAIN_POLL_MS = 3_000;
const DRAIN_TIMEOUT_MS = 10 * 60_000;
const STOP_CONFIRM_POLL_MS = 500;
const STOP_CONFIRM_TIMEOUT_MS = 15_000;
const SERVER_UP_TIMEOUT_ARG = "2m";
const SERVER_UP_TIMEOUT_MS = 2 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

class ReclaimExitSignal extends Error {
  constructor(readonly code: number) {
    super(`keeper reclaim exit(${code})`);
  }
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Spawn `cmd`, capture stdout/stderr, and hard-kill it past `timeoutMs`. */
async function runCommand(
  cmd: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (timedOut) {
      return {
        ok: false,
        stdout,
        stderr,
        error: `${cmd.join(" ")} timed out after ${timeoutMs}ms`,
      };
    }
    return {
      ok: exitCode === 0,
      stdout,
      stderr,
      error:
        exitCode === 0
          ? null
          : stderr.trim() || `${cmd.join(" ")} exited ${exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: `failed to spawn ${cmd[0]}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function requireUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error(
      "process.getuid() unavailable — launchctl control requires a POSIX host",
    );
  }
  return uid;
}

function keeperdDomain(): string {
  return `gui/${requireUid()}`;
}

function keeperdService(): string {
  return `${keeperdDomain()}/${KEEPERD_LAUNCHD_LABEL}`;
}

function keeperdLivePlist(): string {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${KEEPERD_LAUNCHD_LABEL}.plist`,
  );
}

export interface InFlightCounts {
  boardWorkJobs: number | null;
  pendingDispatches: number | null;
}

/** Parse `keeper status --json`'s `in_flight` counts; `null` means the field
 * was missing/non-numeric, distinct from a legitimate zero. */
export function readInFlightCounts(
  data: Record<string, unknown> | null,
): InFlightCounts {
  const inFlight = data?.in_flight as
    | { board_work_jobs?: unknown; pending_dispatches?: unknown }
    | undefined;
  return {
    boardWorkJobs:
      typeof inFlight?.board_work_jobs === "number"
        ? inFlight.board_work_jobs
        : null,
    pendingDispatches:
      typeof inFlight?.pending_dispatches === "number"
        ? inFlight.pending_dispatches
        : null,
  };
}

/**
 * True only once BOTH board-work sessions and launch-window (pending,
 * not-yet-bound) dispatches read zero — a launched-but-unbound worker can
 * still bind and become a board-work job between `board_work_jobs` alone
 * reading zero and the daemon stopping, so neither count alone is a safe
 * drain signal.
 */
export function isBoardQuiet(counts: InFlightCounts): boolean {
  return counts.boardWorkJobs === 0 && counts.pendingDispatches === 0;
}

/**
 * Trim/slice a prompt to the forensics probe term `captureForensicsTerm`
 * hands to `keeper search-history`. Never strips `%`/`_`/`\` — `search-history`
 * ESCAPEs those for a literal LIKE match, so stripping would break the
 * substring match the post-restart `verify()` probe depends on.
 */
export function deriveForensicsTerm(prompt: string): string | null {
  const cleaned = prompt.trim().slice(0, 32);
  return cleaned.length >= 8 ? cleaned : null;
}

/**
 * Best-effort pick of a search-history forensics term from an EXISTING
 * prompt row, taken BEFORE the daemon stops. `null` (no rows, or a read
 * failure) means the post-restart verify skips the probe rather than failing
 * a fresh/empty DB. Never throws.
 */
function captureForensicsTerm(dbPath: string): string | null {
  try {
    const { db } = openDb(dbPath, { readonly: true, migrate: false });
    try {
      const row = db
        .query(
          `SELECT json_extract(data, '$.prompt') AS prompt
             FROM events
            WHERE hook_event = 'UserPromptSubmit'
              AND json_extract(data, '$.prompt') IS NOT NULL
            ORDER BY id DESC
            LIMIT 1`,
        )
        .get() as { prompt?: unknown } | null;
      const prompt = typeof row?.prompt === "string" ? row.prompt : "";
      return deriveForensicsTerm(prompt);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function buildRealDeps(
  dbPath: string,
  sockPath: string,
): MaintenanceWindowDeps {
  const log = (line: string): void => {
    console.log(`[maintenance-window] ${line}`);
  };

  let forensicsTerm: string | null = null;
  let preReclaimBytes = 0;

  async function keeperStatusData(): Promise<Record<string, unknown> | null> {
    const res = await runCommand(
      ["keeper", "status", "--json"],
      COMMAND_TIMEOUT_MS,
    );
    if (!res.ok) {
      return null;
    }
    try {
      const envelope = JSON.parse(res.stdout) as {
        ok?: boolean;
        data?: unknown;
      };
      return envelope.ok === false
        ? null
        : (envelope.data as Record<string, unknown> | null);
    } catch {
      return null;
    }
  }

  return {
    async getAutopilotPaused() {
      const data = await keeperStatusData();
      const autopilot = data?.autopilot as { paused?: unknown } | undefined;
      if (autopilot === undefined || typeof autopilot.paused !== "boolean") {
        return {
          ok: false,
          error: "keeper status did not report autopilot.paused",
          paused: false,
        };
      }
      return { ok: true, error: null, paused: autopilot.paused };
    },

    async setAutopilotPaused(paused: boolean) {
      const res = await runCommand(
        ["keeper", "autopilot", paused ? "pause" : "play"],
        COMMAND_TIMEOUT_MS,
      );
      return { ok: res.ok, error: res.error };
    },

    async awaitDrain() {
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      for (;;) {
        const data = await keeperStatusData();
        const counts = readInFlightCounts(data);
        if (isBoardQuiet(counts)) {
          return { ok: true, error: null };
        }
        if (Date.now() >= deadline) {
          return {
            ok: false,
            error:
              counts.boardWorkJobs === null || counts.pendingDispatches === null
                ? "could not read in_flight.board_work_jobs/pending_dispatches from keeper status"
                : `${counts.boardWorkJobs} board-work session(s) and ${counts.pendingDispatches} pending dispatch(es) still active after ${DRAIN_TIMEOUT_MS}ms`,
          };
        }
        await Bun.sleep(DRAIN_POLL_MS);
      }
    },

    async snapshot() {
      try {
        preReclaimBytes = statSync(dbPath).size;
      } catch {
        preReclaimBytes = 0;
      }
      forensicsTerm = captureForensicsTerm(dbPath);
      const result = backupDb(dbPath);
      if (!result.verified || result.snapshotPath === null) {
        return {
          ok: false,
          error: result.error ?? "snapshot failed",
          path: null,
        };
      }
      return { ok: true, error: null, path: result.snapshotPath };
    },

    async stopDaemon() {
      await runCommand(
        ["launchctl", "bootout", keeperdService()],
        COMMAND_TIMEOUT_MS,
      );
      // bootout errors when the service is already unloaded — the liveness
      // poll below is the authoritative check regardless of its exit code.
      const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
      for (;;) {
        if (!daemonUp(sockPath).up) {
          return { ok: true, error: null };
        }
        if (Date.now() >= deadline) {
          return {
            ok: false,
            error: `keeperd still holds ${sockPath}.lock after ${STOP_CONFIRM_TIMEOUT_MS}ms`,
          };
        }
        await Bun.sleep(STOP_CONFIRM_POLL_MS);
      }
    },

    async reclaim() {
      const out: string[] = [];
      const err: string[] = [];
      let exitCode = 0;
      try {
        runReclaimCli(
          { dbPath, sockPath, dryRun: false, help: false, agentHelp: false },
          {
            stdout: (s: string) => out.push(s),
            stderr: (s: string) => err.push(s),
            exit: ((code: number) => {
              exitCode = code;
              throw new ReclaimExitSignal(code);
            }) as (code: number) => never,
          },
        );
      } catch (e) {
        if (!(e instanceof ReclaimExitSignal)) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      for (const line of out.join("").split("\n")) {
        if (line.length > 0) {
          log(line);
        }
      }
      return exitCode === 0
        ? { ok: true, error: null }
        : {
            ok: false,
            error: err.join("").trim() || `keeper reclaim exited ${exitCode}`,
          };
    },

    async startDaemon() {
      const res = await runCommand(
        ["launchctl", "bootstrap", keeperdDomain(), keeperdLivePlist()],
        COMMAND_TIMEOUT_MS,
      );
      return { ok: res.ok, error: res.error };
    },

    async awaitServerUp() {
      const res = await runCommand(
        ["keeper", "await", "server-up", "--timeout", SERVER_UP_TIMEOUT_ARG],
        SERVER_UP_TIMEOUT_MS + COMMAND_TIMEOUT_MS,
      );
      return { ok: res.ok, error: res.error };
    },

    async verify() {
      let autoVacuum: number | null = null;
      let postBytes = 0;
      try {
        const { db } = openDb(dbPath, { readonly: true, migrate: false });
        try {
          const row = db.query("PRAGMA auto_vacuum").get() as {
            auto_vacuum?: unknown;
          } | null;
          autoVacuum =
            typeof row?.auto_vacuum === "number" ? row.auto_vacuum : null;
        } finally {
          db.close();
        }
        postBytes = statSync(dbPath).size;
      } catch (err) {
        return {
          ok: false,
          error: `post-restart DB read failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (autoVacuum !== 2) {
        return {
          ok: false,
          error: `post-restart auto_vacuum is ${autoVacuum}, expected 2 (INCREMENTAL)`,
        };
      }
      if (
        postBytes <= 0 ||
        (preReclaimBytes > 0 && postBytes > preReclaimBytes)
      ) {
        return {
          ok: false,
          error: `post-restart DB size ${postBytes}B is not smaller than the pre-reclaim ${preReclaimBytes}B`,
        };
      }
      if (forensicsTerm !== null) {
        const res = await runCommand(
          ["keeper", "search-history", forensicsTerm, "--limit", "1"],
          COMMAND_TIMEOUT_MS,
        );
        if (!res.ok) {
          return {
            ok: false,
            error: `search-history forensics probe failed: ${res.error}`,
          };
        }
        try {
          const envelope = JSON.parse(res.stdout) as {
            data?: { matches?: unknown[] };
          };
          if (!envelope.data?.matches || envelope.data.matches.length === 0) {
            return {
              ok: false,
              error:
                "search-history forensics probe found no match for a known pre-reclaim term",
            };
          }
        } catch (err) {
          return {
            ok: false,
            error: `search-history forensics probe returned unparseable output: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }
      return { ok: true, error: null };
    },

    log,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const HELP = `keeper maintenance-window — one-command offline keeper.db reclaim

Usage:
  bun scripts/maintenance-window.ts [--hold|--play]

Runs the full supported offline-reclaim window with the existing safety
gates: capture autopilot state, pause, wait for board-work to drain, take a
pre-reclaim snapshot, stop keeperd, run 'keeper reclaim' (which itself
snapshots + checkpoints + VACUUM INTOs + self-verifies + atomically swaps),
restart keeperd, wait for it to come back up, verify the result (auto_vacuum,
size, a search-history forensics probe), then either hold or restore
autopilot to whatever it was before the window started.

On any failure this NEVER unpauses autopilot — it fails safe and leaves the
pre-reclaim snapshot in place for triage.

Options:
  --hold          Leave autopilot paused after a successful reclaim.
  --play          Restore autopilot to its captured pre-window state (default).
  --help, -h      Show this help.
`;

function parseCliArgs(argv: string[]): { hold: boolean; help: boolean } | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      hold: { type: "boolean", default: false },
      play: { type: "boolean", default: false },
      help: { type: "boolean", default: false, short: "h" },
    },
    allowPositionals: false,
  });
  if (values.hold === true && values.play === true) {
    return null;
  }
  return { hold: values.hold === true, help: values.help === true };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed === null) {
    console.error(
      "keeper maintenance-window: --hold and --play are mutually exclusive\n",
    );
    console.error(HELP);
    return 2;
  }
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }

  const dbPath = resolveDbPath();
  const sockPath = resolveSockPath();
  const deps = buildRealDeps(dbPath, sockPath);

  try {
    const result = await runMaintenanceWindow({ hold: parsed.hold }, deps);
    switch (result.outcome) {
      case "restored":
        console.log(
          "[maintenance-window] DONE — reclaim verified, autopilot restored.",
        );
        return 0;
      case "held":
        console.log(
          "[maintenance-window] DONE — reclaim verified, autopilot left PAUSED (--hold).",
        );
        return 0;
      case "restore_failed":
        console.error(`[maintenance-window] ${result.error}`);
        return 1;
      case "failed":
        console.error(
          `[maintenance-window] FAILED at step '${result.step}': ${result.error}`,
        );
        console.error(
          "[maintenance-window] autopilot is left PAUSED for triage.",
        );
        return 1;
    }
  } catch (err) {
    console.error(
      `[maintenance-window] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "[maintenance-window] autopilot state unknown — verify with 'keeper status --json'.",
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
