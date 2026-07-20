#!/usr/bin/env bun
/**
 * `keeper setup-tmux` — one-shot provisioner for the human's tmux control
 * plane. It rebuilds the deprecated `dash` dashboard on every run on its OWN
 * dedicated `tmux -L dash` server (blown away with `tmux -L dash kill-server`
 * and recreated wholesale) and provisions only the human `work` session on the
 * default server (one shell window). `autopilot` is daemon-minted on demand on
 * the default server, so setup-tmux does not create it — but it is still swept
 * for busy panes and torn down by `--kill-sessions`. It NEVER attaches or
 * `switch-client`s. It may run outside tmux or inside another server, but
 * refuses to destroy the `dash` server from one of that same server's panes.
 * `--kill-sessions` tears the `work`/`autopilot` default-server sessions down
 * first, gated by a busy-pane confirmation prompt; the dash server is always
 * rebuilt regardless of the flag.
 *
 * tmux is driven by direct `Bun.spawnSync` calls — deliberately OUTSIDE the
 * ExecBackend seam (whose session-management API stays stable; this command is
 * an experiment). Only the pure exports `localeDefaultedEnv` /
 * `MANAGED_EXEC_SESSION` are reused read-only.
 *
 * Pure argv builders + busy classification + the kill/abort decision are
 * exported and unit-tested through an injectable sync-spawn seam; this file's
 * `main` is the thin spawn-and-act layer.
 *
 * When the human `work` session is absent or only a one-shell skeleton after a
 * crash and the last tmux-server generation left crashed agents for it, the
 * first `setup-tmux` offers — one combined y/N TTY prompt carrying the picked
 * generation's age + agent count — to relaunch them by spawning
 * `keeper tabs restore --apply` SYNCHRONOUSLY per session and printing one
 * authoritative outcome line each, carrying the per-tab verified/failed/
 * unverified counts the transaction engine reports. An accepted batch is
 * marked for retry before apply and cleared only after a successful restore;
 * the reconciler-managed `autopilot` session is never offered.
 *
 *   keeper setup-tmux [--kill-sessions]
 *   keeper setup-tmux --help
 */

import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { probeChildStartTime } from "../src/birth-record";
import { resolveDbPath, resolveRestorePath } from "../src/db";
import { localeDefaultedEnv, MANAGED_EXEC_SESSION } from "../src/exec-backend";
import type { GenerationSummary } from "../src/restore-set";
import { loadRestorePlan, type RestoreSelection } from "../src/tabs-core";
import { keeperTmuxSessionCwd } from "../src/tmux-session-cwd";
import { parseOptions } from "./descriptor";
import {
  formatAge,
  formatGenerationMenu,
  parsePickerChoice,
  TABS_EXIT_PARTIAL_FAILURE,
} from "./tabs";

export const HELP = `keeper setup-tmux — provision the tmux control plane (dash server + work session)

Usage:
  keeper setup-tmux [--kill-sessions]
  keeper setup-tmux --help

Rebuilds the deprecated 'dash' dashboard every run on its OWN dedicated
'tmux -L dash' server (board + autopilot/jobs/git panes, main-vertical) and provisions only the human 'work' session on the default
server (one shell window, stamped with KEEPER_TMUX_SESSION). 'autopilot' is
daemon-minted on demand, so it is not created here — but it is still swept and
torn down by --kill-sessions. An existing 'work' session is left untouched.
NEVER attaches or switch-clients. It is safe outside tmux or inside another
tmux server; from a pane on the dash server itself it refuses the self-teardown.
Attach the dashboard with: tmux -L dash attach.

Also symlinks Keeper's tmux drop-ins idempotently and fail-open:
  tmux/keeper-notes.conf → ~/.config/tmux/conf.d/keeper-notes.conf
  tmux/keeper-shell.conf → ~/.config/tmux/conf.d/keeper-shell.conf
  tmux/keeper-guard.conf → ~/.config/tmux/conf.d/zz-keeper-guard.conf
The first binds prefix N/B to fresh Note capture/browse popups; the shell drop-in
marks new tmux shells to load Keeper's zsh aliases; the guard makes a keeper-managed
session (autopilot/pair/panels/agentbus/wrapped) prompt before a keyboard-triggered
window/split creation. They activate only if your tmux.conf sources conf.d/*.conf.
A real (non-symlink) destination is never clobbered.

When the work session ('work') is absent or only a one-shell skeleton (the first
run after a crash) and the last tmux-server generation left crashed agents for it,
it offers — ONE combined y/N prompt on a TTY only, never auto — to relaunch them.
The prompt carries the picked generation's age + agent count (a skeleton is
recognizable at the prompt); on confirm it spawns 'keeper tabs restore --apply'
SYNCHRONOUSLY per session and prints one authoritative outcome line each: the
restored count with generation context (an 'unverified=' note when a tab
launched without attach evidence), a PARTIAL line with the restored/failed/
unverified breakdown when some tabs failed, or the verbatim failure incl. the
autopilot-gate refusal for any other non-zero exit. An accepted batch is marked
for retry before apply and cleared only after a successful restore; a marked
retry is offered even when the session now exists. The managed 'autopilot'
session is never offered. A present non-skeleton session without a retry marker,
zero candidates, or a non-TTY skips that session's offer.

A CONTESTED auto-pick — the richest generation isn't the freshest, or the
derived cohort disagrees with the last non-empty disaster mirror — never silently
restores: on a TTY it presents a numbered generation picker with an explicit
skip option; off a TTY it prints a visible refusal naming 'keeper tabs restore'
and restores nothing (never blocking provisioning). Retry markers
(already-disambiguated picks) bypass this gate.

Options:
  --kill-sessions  Kill the default-server 'work'/'autopilot' sessions before
                   setup. Prompts y/N only when they hold busy (non-shell
                   foreground) panes; with no busy panes it kills without
                   prompting. Non-TTY stdin with busy panes aborts (exit 1)
                   having killed nothing. The 'dash' server is always rebuilt
                   regardless of this flag.
  --help           Show this help

Busy-scan caveat: a pane is "busy" only by its FOREGROUND command
(pane_current_command). A backgrounded job sitting behind an idle shell reads as
NOT busy and will not trigger the confirmation prompt.
`;

export const DASH_SESSION = "dash" as const;
/** The session(s) setup-tmux PROVISIONS — ensure-looped, minted when absent.
 *  Only the human `work` session: `autopilot` is daemon-minted on demand on the
 *  default server, and dash lives on its own `-L dash` server (always
 *  rebuilt). */
export const PROVISION_SESSIONS = ["work"] as const;
/** The sessions a `--kill-sessions` run sweeps for busy panes + tears down on
 *  the DEFAULT server: the human `work` session plus the daemon-managed
 *  `autopilot` — autopilot is not provisioned here but is swept/killed so live
 *  workers surface in the confirm table and get torn down. Dash is NOT in this
 *  set: it lives on its own `-L dash` server and is torn down unconditionally
 *  by rebuildDash. */
export const SWEEP_KILL_SESSIONS = ["work", MANAGED_EXEC_SESSION] as const;

/** The three right-hand dash panes, in split order, after the board main pane. */
export const DASH_SUB_PANES = ["autopilot", "jobs", "git"] as const;

const HOME_DIR = keeperTmuxSessionCwd(process.env);
const KEEPER_DIR = `${HOME_DIR}/code/keeper`;
/** Detached-session fallback size when neither $TMUX nor `tput` yields one. */
const FALLBACK_WIDTH = 200;
const FALLBACK_HEIGHT = 50;

/** Every setup subprocess is bounded. Ordinary tmux probes and mutations are
 * cheap; server/session creation gets startup slack; an accepted tab restore
 * may launch several agents and gets a much larger, but still finite, bound. */
export const SETUP_TMUX_COMMAND_TIMEOUT_MS = 5_000;
export const SETUP_TMUX_NEW_SESSION_TIMEOUT_MS = 15_000;
export const SETUP_TMUX_RESTORE_TIMEOUT_MS = 300_000;

/** Foreground commands that mean an idle shell, NOT a busy pane. A leading `-`
 *  (login shell) is stripped before the membership test. */
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "dash"]);

/**
 * Result shape of a single sync spawn — the `Bun.spawnSync` contract this
 * command depends on. `exitCode === null` means signal-killed (treated as
 * failure); `stdout`/`stderr` are Buffers.
 */
export interface SyncSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitedDueToTimeout?: boolean;
  readonly signalCode?: string | number | null;
}

export interface SyncSpawnOptions {
  readonly env?: Record<string, string>;
  readonly timeout?: number;
}

/** Injectable sync-spawn seam matching `Bun.spawnSync`. */
export type SyncSpawnFn = (
  cmd: string[],
  options?: SyncSpawnOptions,
) => SyncSpawnResult;

/** Pure per-command timeout policy used by both production and injected tests. */
export function setupTmuxSpawnTimeoutMs(cmd: readonly string[]): number {
  if (cmd[0] === "keeper" && cmd[1] === "tabs" && cmd[2] === "restore") {
    return SETUP_TMUX_RESTORE_TIMEOUT_MS;
  }
  if (cmd.includes("new-session")) {
    return SETUP_TMUX_NEW_SESSION_TIMEOUT_MS;
  }
  return SETUP_TMUX_COMMAND_TIMEOUT_MS;
}

const defaultSpawn: SyncSpawnFn = (cmd, options) =>
  Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout ?? setupTmuxSpawnTimeoutMs(cmd),
    ...(options?.env != null ? { env: options.env } : {}),
  }) as unknown as SyncSpawnResult;

/**
 * Injectable filesystem seam — the minimal `node:fs` subset the tmux drop-in
 * installer needs. Injected (never inlined) so `main` stays test-drivable
 * without touching real `~/.config`. `lstat` reports whether a destination is a
 * symlink (vs a real file); `readlink` resolves an existing symlink's target;
 * `symlink`/`mkdir` create. A method throwing surfaces as the fail-open
 * warn-and-continue path.
 */
export interface GuardFs {
  lstatIsSymlink(path: string): boolean | null;
  readlink(path: string): string;
  symlink(target: string, path: string): void;
  mkdirp(path: string): void;
}

const defaultGuardFs: GuardFs = {
  lstatIsSymlink: (path) => {
    try {
      return fs.lstatSync(path).isSymbolicLink();
    } catch {
      // ENOENT (link absent) ⇒ null so the caller creates it.
      return null;
    }
  },
  readlink: (path) => fs.readlinkSync(path),
  symlink: (target, path) => {
    // Replace any existing (stale) symlink — `symlinkSync` fails EEXIST
    // otherwise. The caller only reaches here for an absent or wrong-target
    // SYMLINK path (a real file is refused upstream), so the unlink is safe.
    try {
      fs.unlinkSync(path);
    } catch {
      // Absent path ⇒ nothing to unlink; proceed to create.
    }
    fs.symlinkSync(target, path);
  },
  mkdirp: (path) => {
    fs.mkdirSync(path, { recursive: true });
  },
};

export interface DashServerIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly socketPath: string;
}

export interface DashRecoveryResult {
  readonly recovered: boolean;
  readonly detail: string;
}

/** Injectable ownership store + identity-guarded recovery seam. Tests use a
 * fake; production persists a pid/start-time and socket inode. */
export interface DashServerRecovery {
  clear(): void;
  record(identity: DashServerIdentity): void;
  recoverTimedOutServer(): DashRecoveryResult;
}

interface DashServerLease extends DashServerIdentity {
  readonly schema_version: 1;
  readonly socketDev: string;
  readonly socketIno: string;
}

export function resolveDashServerLeasePath(): string {
  return join(dirname(resolveRestorePath()), "dash-tmux-server.json");
}

function socketIdentity(
  socketPath: string,
): { socketDev: string; socketIno: string } | null {
  try {
    const stat = fs.lstatSync(socketPath, { bigint: true });
    if (!stat.isSocket()) return null;
    return { socketDev: String(stat.dev), socketIno: String(stat.ino) };
  } catch {
    return null;
  }
}

function pidOwnsSocket(pid: number, socketPath: string): boolean {
  try {
    const result = Bun.spawnSync(
      ["lsof", "-nP", "-a", "-p", String(pid), "-U", "-Fn"],
      {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 1_000,
      },
    );
    if (result.exitedDueToTimeout || result.exitCode !== 0) return false;
    return result.stdout
      .toString()
      .split("\n")
      .some((line) => line === `n${socketPath}`);
  } catch {
    return false;
  }
}

function socketHasAnyOwner(socketPath: string): boolean {
  try {
    const result = Bun.spawnSync(["lsof", "-nP", "-U", "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1_000,
    });
    if (result.exitedDueToTimeout || result.exitCode !== 0) return true;
    return result.stdout
      .toString()
      .split("\n")
      .some((line) => line === `n${socketPath}`);
  } catch {
    // Inconclusive ownership fails safe: never unlink.
    return true;
  }
}

function parseDashServerLease(raw: string): DashServerLease | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const lease = value as Record<string, unknown>;
  if (
    lease.schema_version !== 1 ||
    !Number.isSafeInteger(lease.pid) ||
    (lease.pid as number) <= 1 ||
    typeof lease.startTime !== "string" ||
    lease.startTime === "" ||
    typeof lease.socketPath !== "string" ||
    !isAbsolute(lease.socketPath) ||
    basename(lease.socketPath) !== DASH_SESSION ||
    typeof lease.socketDev !== "string" ||
    lease.socketDev === "" ||
    typeof lease.socketIno !== "string" ||
    lease.socketIno === ""
  ) {
    return null;
  }
  return lease as unknown as DashServerLease;
}

function unlinkRecordedSocket(lease: DashServerLease): void {
  const current = socketIdentity(lease.socketPath);
  if (
    current?.socketDev !== lease.socketDev ||
    current.socketIno !== lease.socketIno ||
    socketHasAnyOwner(lease.socketPath)
  ) {
    return;
  }
  try {
    fs.unlinkSync(lease.socketPath);
  } catch {
    // A concurrently completed teardown already removed it.
  }
}

function fileDashServerRecovery(
  path = resolveDashServerLeasePath(),
): DashServerRecovery {
  const clear = (): void => {
    try {
      fs.unlinkSync(path);
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
    }
  };
  const readLease = (): DashServerLease | null => {
    try {
      return parseDashServerLease(fs.readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  return {
    clear,
    record: (identity) => {
      const socket = socketIdentity(identity.socketPath);
      if (socket === null) {
        throw new Error("dash socket is absent or not a Unix socket");
      }
      const lease: DashServerLease = {
        schema_version: 1,
        ...identity,
        ...socket,
      };
      fs.mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, path);
    },
    recoverTimedOutServer: () => {
      const lease = readLease();
      if (lease === null) {
        return {
          recovered: false,
          detail: "no valid recorded dash-server identity",
        };
      }

      type ProcessIdentityState = "owned" | "gone" | "foreign" | "inconclusive";
      const probeIdentity = (): ProcessIdentityState => {
        try {
          process.kill(lease.pid, 0);
        } catch (error) {
          return (error as { code?: string })?.code === "ESRCH"
            ? "gone"
            : "inconclusive";
        }
        const startTime = probeChildStartTime(lease.pid);
        if (startTime === null) return "inconclusive";
        return startTime === lease.startTime ? "owned" : "foreign";
      };

      let state = probeIdentity();
      if (state === "inconclusive") {
        return {
          recovered: false,
          detail: `could not verify recorded pid ${lease.pid}`,
        };
      }
      if (state !== "owned") {
        // The recorded process identity is already gone. Do not unlink by pathname:
        // a concurrent replacement may now own it. A new tmux client handles a
        // genuinely stale socket itself.
        clear();
        return { recovered: true, detail: "recorded dash server was gone" };
      }
      const recordedSocketStillOwned = (): boolean => {
        const socket = socketIdentity(lease.socketPath);
        return (
          socket?.socketDev === lease.socketDev &&
          socket.socketIno === lease.socketIno &&
          pidOwnsSocket(lease.pid, lease.socketPath)
        );
      };
      if (!recordedSocketStillOwned()) {
        return {
          recovered: false,
          detail: `recorded socket identity is not owned by pid ${lease.pid}`,
        };
      }

      try {
        process.kill(lease.pid, "SIGTERM");
      } catch (error) {
        return {
          recovered: false,
          detail: `failed to SIGTERM recorded pid ${lease.pid}: ${String(error)}`,
        };
      }
      let deadline = Date.now() + 2_000;
      while (state === "owned" && Date.now() < deadline) {
        Bun.sleepSync(25);
        state = probeIdentity();
      }
      if (state === "inconclusive") {
        return {
          recovered: false,
          detail: `lost process identity after SIGTERM for pid ${lease.pid}`,
        };
      }
      if (state === "owned") {
        // If TERM released the recorded socket, rebuilding may proceed without
        // any stronger signal. Otherwise re-check process + socket ownership as
        // close to SIGKILL as the platform permits.
        if (!recordedSocketStillOwned()) {
          clear();
          return {
            recovered: true,
            detail: `recorded pid ${lease.pid} released the dash socket`,
          };
        }
        state = probeIdentity();
        if (state !== "owned") {
          if (state === "inconclusive") {
            return {
              recovered: false,
              detail: `lost process identity before SIGKILL for pid ${lease.pid}`,
            };
          }
          clear();
          return {
            recovered: true,
            detail: `recorded pid ${lease.pid} exited after SIGTERM`,
          };
        }
        try {
          process.kill(lease.pid, "SIGKILL");
        } catch (error) {
          return {
            recovered: false,
            detail: `failed to SIGKILL recorded pid ${lease.pid}: ${String(error)}`,
          };
        }
        deadline = Date.now() + 1_000;
        while (state === "owned" && Date.now() < deadline) {
          Bun.sleepSync(25);
          state = probeIdentity();
        }
      }
      if (state === "inconclusive") {
        return {
          recovered: false,
          detail: `lost process identity after SIGKILL for pid ${lease.pid}`,
        };
      }
      if (state === "owned") {
        return {
          recovered: false,
          detail: `recorded pid ${lease.pid} survived SIGKILL`,
        };
      }
      unlinkRecordedSocket(lease);
      clear();
      return {
        recovered: true,
        detail: `terminated recorded pid ${lease.pid}`,
      };
    },
  };
}

// ===========================================================================
// Pure argv builders — `zsh -ic` triples, never shell strings.
// ===========================================================================

/** Prefix dash-targeting argv with the `-L dash` GLOBAL flag so every dash call
 *  hits the dedicated dash server, never the default one. `-L <name>` MUST
 *  precede the subcommand (placed after, tmux silently treats it as a
 *  subcommand option and targets the default server), so this helper is the
 *  single guard against a missed/misplaced site. */
export function dashTmux(...args: string[]): string[] {
  return ["tmux", "-L", DASH_SESSION, ...args];
}

/** Wrap a keeper subcommand in the `zsh -ic` triple that survives the TUI
 *  quitting: the pane drops to an interactive shell instead of closing. The
 *  argv triple is passed to tmux verbatim — NEVER a single joined shell
 *  string. */
export function dashPaneArgv(sub: string): string[] {
  return ["zsh", "-ic", `keeper ${sub}; exec $SHELL`];
}

/** `kill-session -t =<session>` — `=` forces an exact match (bare names
 *  fnmatch). Any non-zero exit means "nothing to kill" on the default path. */
export function buildKillSessionArgs(session: string): string[] {
  return ["tmux", "kill-session", "-t", `=${session}`];
}

/** `tmux -L dash kill-server` — blow away the WHOLE dash server before rebuild.
 *  NEVER a bare `kill-server` (that would destroy the default server where
 *  `work` lives) and NEVER `kill-session` (kill-session leaves an empty server
 *  so a later new-session lands stale). Routed through the tolerant `run` so a
 *  first-ever run with no dash server yet is fine. */
export function buildKillDashServerArgs(): string[] {
  return dashTmux("kill-server");
}

/** Read the dedicated server's pid and socket after a successful rebuild so a
 * later timed-out `kill-server` can fence that recorded process. */
export function buildDashServerIdentityArgs(): string[] {
  return dashTmux("display-message", "-p", "#{pid} #{socket_path}");
}

/** Parse `<pid> <absolute-socket-path>` without assuming the path has no spaces. */
export function parseDashServerIdentity(
  output: string,
): { pid: number; socketPath: string } | null {
  const match = output.trim().match(/^(\d+)\s+(.+)$/s);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] as string, 10);
  const socketPath = (match[2] as string).trim();
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !isAbsolute(socketPath) ||
    basename(socketPath) !== DASH_SESSION
  ) {
    return null;
  }
  return { pid, socketPath };
}

/** True when setup itself is hosted by the server it would destroy. */
export function isInsideDashServer(tmuxEnv: string | undefined): boolean {
  if (tmuxEnv == null || tmuxEnv === "") return false;
  const socketPath = tmuxEnv.split(",", 1)[0] ?? "";
  return isAbsolute(socketPath) && basename(socketPath) === DASH_SESSION;
}

/** `has-session -t =<session>` existence probe. Stderr is captured by the
 *  caller; any non-zero exit (no session OR no server) reads as "absent". */
export function buildHasSessionArgs(session: string): string[] {
  return ["tmux", "has-session", "-t", `=${session}`];
}

/** `list-sessions` server-liveness probe — non-zero ⇒ no server running. */
export function buildListSessionsArgs(): string[] {
  return ["tmux", "list-sessions"];
}

/** `display -p '#{<metric>}'` — read an attached client's width/height. Valid
 *  only inside tmux with a client; the caller gates on $TMUX. */
export function buildDisplayMetricArgs(metric: string): string[] {
  return ["tmux", "display", "-p", `#{${metric}}`];
}

/** `tput <cap>` size probe used outside tmux. Needs $TERM; numeric output is
 *  validated by the caller, not the exit code. */
export function buildTputArgs(cap: string): string[] {
  return ["tput", cap];
}

/**
 * `tmux -L dash new-session -d -s dash -c <home> -e TMUX= -x <W> -y <H> -P -F
 * '#{pane_id}' -- <argv...>`. Detached on the dedicated dash server, the board
 * pane's `zsh -ic` triple after `--`, explicitly sized so the detached session
 * does not boot at tmux's 80x24 default. `-e TMUX=` clears the inherited
 * outer-server `$TMUX` so a bare `tmux` inside a dash pane doesn't misroute to
 * the default server. `-P -F '#{pane_id}'` prints the board pane's id so it can
 * be re-focused after the splits.
 */
export function buildDashNewSessionArgs(
  width: number,
  height: number,
): string[] {
  return dashTmux(
    "new-session",
    "-d",
    "-s",
    DASH_SESSION,
    "-c",
    HOME_DIR,
    "-e",
    "TMUX=",
    "-x",
    String(width),
    "-y",
    String(height),
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...dashPaneArgv("board"),
  );
}

/** `set-option -w -t =dash: main-pane-width '50%'`. Window/pane targets need
 *  the trailing `:` (exact session, current window) — a bare `=dash` resolves
 *  only as a SESSION target; window-target commands reject it ("no such
 *  window"). */
export function buildSetMainPaneWidthArgs(): string[] {
  return dashTmux(
    "set-option",
    "-w",
    "-t",
    `=${DASH_SESSION}:`,
    "main-pane-width",
    "50%",
  );
}

/**
 * `split-window -d -t =dash -c <home> -P -F '#{pane_id}' -- <argv...>`. `-d`
 * keeps the new pane unfocused; `-P -F '#{pane_id}'` prints the created pane's
 * id so we can re-select the board pane without positional pane targets.
 */
export function buildDashSplitArgs(sub: string): string[] {
  return dashTmux(
    "split-window",
    "-d",
    "-t",
    `=${DASH_SESSION}:`,
    "-c",
    HOME_DIR,
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...dashPaneArgv(sub),
  );
}

/** `select-layout -t =dash main-vertical` — re-run after EVERY split so the
 *  next split always has room ("no space for new pane" otherwise). */
export function buildSelectLayoutArgs(): string[] {
  return dashTmux("select-layout", "-t", `=${DASH_SESSION}:`, "main-vertical");
}

/** `select-pane -t <paneId>` — focus the board pane by its captured id. The
 *  captured `#{pane_id}` is re-targetable only on the SAME server, so this must
 *  carry `-L dash` too. */
export function buildSelectPaneArgs(paneId: string): string[] {
  return dashTmux("select-pane", "-t", paneId);
}

/**
 * `new-session -d -s <name> -c <home> -e KEEPER_TMUX_SESSION=<name>` work-session
 * mint. The `-e` stamp mirrors exec-backend's session mint so hook attribution
 * matches daemon-minted sessions.
 */
export function buildWorkNewSessionArgs(session: string): string[] {
  return [
    "tmux",
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    HOME_DIR,
    "-e",
    `KEEPER_TMUX_SESSION=${session}`,
  ];
}

/**
 * `list-panes -s -t =<name> -F '<TAB-delimited, window_name LAST>'`. `-s` spans
 * every window in the session. `window_name` is free user text placed LAST with
 * a bounded split downstream so an embedded TAB can't corrupt the command
 * field. Spawned under `localeDefaultedEnv` so a C-locale client does not
 * sanitize the TAB delimiters to `_` (which would parse every pane idle).
 */
export function buildListPanesArgs(session: string): string[] {
  return [
    "tmux",
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    "#{session_name}\t#{window_index}\t#{pane_current_command}\t#{window_name}",
  ];
}

// ===========================================================================
// Busy classification
// ===========================================================================

export interface BusyPane {
  readonly session: string;
  readonly windowIndex: string;
  readonly command: string;
  readonly windowName: string;
}

/** A pane is busy when its foreground command is not a known shell. A leading
 *  `-` (login shell, e.g. `-zsh`) is stripped before the membership test. */
export function isBusyCommand(command: string): boolean {
  const base = command.startsWith("-") ? command.slice(1) : command;
  return base !== "" && !SHELL_COMMANDS.has(base);
}

/** True only for the one idle-shell pane setup-tmux provisions as a session
 * skeleton. Malformed output, zero panes, multiple panes, and any foreground
 * command other than a known shell are all treated as non-skeletons. */
export function isRestoreSessionSkeleton(sweepOutput: string): boolean {
  let panes = 0;
  for (const line of sweepOutput.split("\n")) {
    if (line === "") {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 4) {
      return false;
    }
    const command = parts[2] ?? "";
    const base = command.startsWith("-") ? command.slice(1) : command;
    if (!SHELL_COMMANDS.has(base)) {
      return false;
    }
    panes++;
    if (panes > 1) {
      return false;
    }
  }
  return panes === 1;
}

/**
 * Parse the TAB-delimited `list-panes` sweep for ONE session into its busy
 * panes. `window_name` is LAST and may itself contain TABs, so the split is
 * bounded to 4 fields (the 4th absorbs any embedded TABs). Blank lines and
 * lines with too few fields are skipped.
 */
export function parseBusyPanes(sweepOutput: string): BusyPane[] {
  const out: BusyPane[] = [];
  for (const line of sweepOutput.split("\n")) {
    if (line === "") {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 4) {
      continue;
    }
    const [session, windowIndex, command, ...rest] = parts as [
      string,
      string,
      string,
      ...string[],
    ];
    const windowName = rest.join("\t");
    if (isBusyCommand(command)) {
      out.push({ session, windowIndex, command, windowName });
    }
  }
  return out;
}

/** Render the busy-pane confirmation table: `session:window  name → command`. */
export function renderBusyTable(panes: BusyPane[]): string {
  return panes
    .map((p) => `${p.session}:${p.windowIndex}  ${p.windowName} → ${p.command}`)
    .join("\n");
}

// ===========================================================================
// Sizing
// ===========================================================================

/** Parse a size probe's stdout to a positive integer, else null (exit code is
 *  NOT trusted — `tput` can exit 0 with junk). */
function parseSize(out: string): number | null {
  const n = Number.parseInt(out.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the detached dash session size: `$TMUX` set ⇒ the attached client's
 * `#{client_width}`/`#{client_height}`; else `tput cols`/`tput lines`; else
 * the 200x50 fallback. Each axis falls back independently.
 */
export function resolveDashSize(spawn: SyncSpawnFn): {
  width: number;
  height: number;
} {
  const probe = (metric: string, cap: string, fallback: number): number => {
    if (process.env.TMUX != null && process.env.TMUX !== "") {
      const r = run(spawn, buildDisplayMetricArgs(metric));
      if (r.exitCode === 0) {
        const n = parseSize(r.stdout.toString());
        if (n != null) {
          return n;
        }
      }
    }
    const t = run(spawn, buildTputArgs(cap));
    if (t.exitCode === 0) {
      const n = parseSize(t.stdout.toString());
      if (n != null) {
        return n;
      }
    }
    return fallback;
  };
  return {
    width: probe("client_width", "cols", FALLBACK_WIDTH),
    height: probe("client_height", "lines", FALLBACK_HEIGHT),
  };
}

// ===========================================================================
// Spawn-and-act layer
// ===========================================================================

type TmuxFailureKind = "exit" | "signal" | "timeout" | "spawn";

class TmuxError extends Error {
  constructor(
    readonly argv: string[],
    readonly stderr: string,
    readonly kind: TmuxFailureKind = "exit",
  ) {
    super(`tmux failed: ${argv.join(" ")}\n${stderr}`);
    this.name = "TmuxError";
  }
}

/** Run a tmux/tput command and return its result; surface ENOENT as a clear
 *  "tmux not found" error rather than a stack trace. Timeout and signal death
 *  are distinct from an ordinary non-zero exit, so callers never mistake a
 *  wedged probe for "server/session absent". */
function run(
  spawn: SyncSpawnFn,
  argv: string[],
  env?: Record<string, string>,
): SyncSpawnResult {
  const timeout = setupTmuxSpawnTimeoutMs(argv);
  let result: SyncSpawnResult;
  try {
    result = spawn(argv, {
      timeout,
      ...(env != null ? { env } : {}),
    });
  } catch (e) {
    const msg =
      (e as { code?: string })?.code === "ENOENT"
        ? `keeper setup-tmux: '${argv[0]}' not found on PATH`
        : `keeper setup-tmux: failed to spawn ${argv[0]}: ${String(e)}`;
    throw new TmuxError(argv, msg, "spawn");
  }
  if (result.exitedDueToTimeout === true) {
    throw new TmuxError(
      argv,
      `command timed out after ${timeout}ms`,
      "timeout",
    );
  }
  if (result.exitCode === null) {
    throw new TmuxError(
      argv,
      `command killed by signal ${result.signalCode ?? "unknown"}`,
      "signal",
    );
  }
  return result;
}

/** Run a command that MUST succeed; throw `TmuxError` so `main` can fail loud
 *  with the argv + stderr. */
function runChecked(
  spawn: SyncSpawnFn,
  argv: string[],
  env?: Record<string, string>,
): SyncSpawnResult {
  const r = run(spawn, argv, env);
  if (r.exitCode !== 0) {
    throw new TmuxError(argv, r.stderr.toString());
  }
  return r;
}

/** Rebuild the dash session from scratch on its dedicated `-L dash` server:
 *  unconditional kill-server, sized new-session, main-pane-width, the four
 *  splits each followed by a layout pass, then re-focus the board pane by its
 *  captured id. A timed-out kill may terminate only the recycle-safe server
 *  identity recorded by an earlier successful rebuild. */
function rebuildDash(spawn: SyncSpawnFn, recovery?: DashServerRecovery): void {
  try {
    const result = run(spawn, buildKillDashServerArgs());
    const stderr = result.stderr.toString().toLowerCase();
    const confirmedAbsent =
      result.exitCode !== 0 &&
      (stderr.includes("no server running") ||
        stderr.includes("failed to connect") ||
        (stderr.includes("error connecting to") &&
          stderr.includes("no such file or directory")));
    if (result.exitCode !== 0 && !confirmedAbsent) {
      throw new TmuxError(
        buildKillDashServerArgs(),
        result.stderr.toString() ||
          `kill-server exited ${String(result.exitCode)} without a confirmed no-server result`,
      );
    }
    try {
      recovery?.clear();
    } catch (error) {
      process.stderr.write(
        `keeper setup-tmux: could not clear stale dash recovery identity — ${String(error)}\n`,
      );
    }
  } catch (error) {
    if (
      !(error instanceof TmuxError) ||
      error.kind !== "timeout" ||
      !recovery
    ) {
      throw error;
    }
    const result = recovery.recoverTimedOutServer();
    if (!result.recovered) {
      throw new TmuxError(
        error.argv,
        `${error.stderr}; identity-guarded recovery refused: ${result.detail}`,
        "timeout",
      );
    }
    process.stderr.write(
      `keeper setup-tmux: recovered unresponsive dash server — ${result.detail}\n`,
    );
  }

  const { width, height } = resolveDashSize(spawn);
  const boardPane = runChecked(spawn, buildDashNewSessionArgs(width, height));
  const boardPaneId = boardPane.stdout.toString().trim();

  // Lease the replacement immediately: if a later split/layout command wedges,
  // the next setup run can still terminate this recorded partial server.
  if (recovery !== undefined) {
    try {
      const result = runChecked(spawn, buildDashServerIdentityArgs());
      const parsed = parseDashServerIdentity(result.stdout.toString());
      if (parsed === null) {
        throw new Error("tmux returned an invalid pid/socket identity");
      }
      const startTime = probeChildStartTime(parsed.pid);
      if (startTime === null) {
        throw new Error("could not read the dash server process start time");
      }
      recovery.record({ ...parsed, startTime });
    } catch (error) {
      // The dashboard remains usable, but a later wedged kill cannot be
      // escalated without this recorded ownership proof.
      process.stderr.write(
        `keeper setup-tmux: dash recovery identity not recorded — ${String(error)}\n`,
      );
    }
  }

  runChecked(spawn, buildSetMainPaneWidthArgs());

  for (const sub of DASH_SUB_PANES) {
    runChecked(spawn, buildDashSplitArgs(sub));
    // Re-balance after EVERY split — splitting all four then laying out once
    // fails "no space for new pane".
    runChecked(spawn, buildSelectLayoutArgs());
  }

  // Re-focus the board pane by its captured id; positional pane targets are
  // brittle after layout changes.
  if (boardPaneId !== "") {
    runChecked(spawn, buildSelectPaneArgs(boardPaneId));
  }
}

/** Keeper-owned tmux drop-in sources in this repo. */
export function notesConfSource(): string {
  return `${KEEPER_DIR}/tmux/keeper-notes.conf`;
}

export function shellConfSource(): string {
  return `${KEEPER_DIR}/tmux/keeper-shell.conf`;
}

/** Reload the shell marker into an already-running default tmux server. */
export function buildSourceShellConfArgs(): string[] {
  return ["tmux", "source-file", shellConfSource()];
}

export function guardConfSource(): string {
  return `${KEEPER_DIR}/tmux/keeper-guard.conf`;
}

/** The Note popup destination. `home` empty ⇒ no root-relative path. */
export function notesConfLink(home: string): string {
  return home === "" ? "" : `${home}/.config/tmux/conf.d/keeper-notes.conf`;
}

export function shellConfLink(home: string): string {
  return home === "" ? "" : `${home}/.config/tmux/conf.d/keeper-shell.conf`;
}

/** `zz-` sources the guard after the human's own create-key bindings. */
export function guardConfLink(home: string): string {
  return home === "" ? "" : `${home}/.config/tmux/conf.d/zz-keeper-guard.conf`;
}

interface TmuxConfSpec {
  readonly label: string;
  readonly source: string;
  readonly link: string;
}

function tmuxConfSpecs(home: string): readonly TmuxConfSpec[] {
  return [
    {
      label: "note popup",
      source: notesConfSource(),
      link: notesConfLink(home),
    },
    {
      label: "zsh drop-in marker",
      source: shellConfSource(),
      link: shellConfLink(home),
    },
    {
      label: "managed-session guard",
      source: guardConfSource(),
      link: guardConfLink(home),
    },
  ];
}

/** Install or repair one symlink without ever replacing a real file. */
function ensureTmuxConfSymlink(gfs: GuardFs, spec: TmuxConfSpec): void {
  const isLink = gfs.lstatIsSymlink(spec.link);
  if (isLink === false) {
    process.stderr.write(
      `keeper setup-tmux: ${spec.link} is a real file (not a symlink), refusing to clobber — ${spec.label} not installed\n`,
    );
    return;
  }
  if (isLink === true) {
    let current = "";
    try {
      current = gfs.readlink(spec.link);
    } catch {
      // A dangling or unreadable symlink is repaired below.
    }
    if (current === spec.source) return;
  }
  gfs.symlink(spec.source, spec.link);
}

/**
 * Idempotently install Keeper's tmux drop-ins. The shared parent is created
 * once. Each link fails open independently, so one stale or protected
 * destination never prevents installing the other or provisioning sessions.
 */
function ensureTmuxConfSymlinks(gfs: GuardFs): void {
  const home = process.env.HOME ?? "";
  if (home === "") {
    process.stderr.write(
      "keeper setup-tmux: empty HOME, skipping tmux drop-in symlinks\n",
    );
    return;
  }
  const specs = tmuxConfSpecs(home);
  gfs.mkdirp(join(home, ".config", "tmux", "conf.d"));
  for (const spec of specs) {
    try {
      ensureTmuxConfSymlink(gfs, spec);
    } catch (error) {
      process.stderr.write(
        `keeper setup-tmux: ${spec.label} symlink install failed, continuing — ${String(error)}\n`,
      );
    }
  }
}

/** Ensure each provisioned session exists (mint when absent, never touch when
 *  present). `has-session` non-zero (no session OR no server) ⇒ absent. */
function ensureWorkSessions(spawn: SyncSpawnFn): void {
  for (const session of PROVISION_SESSIONS) {
    const probe = run(spawn, buildHasSessionArgs(session));
    if (probe.exitCode !== 0) {
      runChecked(spawn, buildWorkNewSessionArgs(session));
    }
  }
}

/** A fresh restore may target an absent session or the exact one-shell
 * skeleton setup-tmux provisions. A real session is left alone; accepted retry
 * markers use their separate idempotent path. */
function canAcceptFreshRestore(spawn: SyncSpawnFn, session: string): boolean {
  if (run(spawn, buildHasSessionArgs(session)).exitCode !== 0) {
    return true;
  }
  const sweep = run(
    spawn,
    buildListPanesArgs(session),
    localeDefaultedEnv(process.env),
  );
  return (
    sweep.exitCode === 0 && isRestoreSessionSkeleton(sweep.stdout.toString())
  );
}

/** Sweep the sweep/kill sessions for busy panes under a locale-defaulted env so
 *  a C-locale client doesn't sanitize the TAB delimiters. */
export function sweepBusyPanes(spawn: SyncSpawnFn): BusyPane[] {
  const env = localeDefaultedEnv(process.env);
  const busy: BusyPane[] = [];
  for (const session of SWEEP_KILL_SESSIONS) {
    const r = run(spawn, buildListPanesArgs(session), env);
    // A non-zero sweep (session absent) contributes no panes.
    if (r.exitCode === 0) {
      busy.push(...parseBusyPanes(r.stdout.toString()));
    }
  }
  return busy;
}

/** Kill the default-server sweep/kill sessions (`work` + `autopilot`),
 *  tolerating any non-zero (already gone). Dash is NOT killed here — rebuildDash
 *  tears down its dedicated `-L dash` server unconditionally. */
function killAllSessions(spawn: SyncSpawnFn): void {
  for (const session of SWEEP_KILL_SESSIONS) {
    run(spawn, buildKillSessionArgs(session));
  }
}

/** Prompt y/N on a confirmed TTY. EOF/Ctrl-D / anything but y/Y ⇒ false. The
 *  readline interface is created here (after the TTY gate) and always closed. */
async function confirm(
  prompt = "Kill these sessions? [y/N] ",
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
      rl.on("close", () => resolve(""));
    });
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/** Read one raw line on a confirmed TTY (the ambiguity picker's numbered choice).
 *  EOF/Ctrl-D / close resolves empty (⇒ abort). Mirrors {@link confirm}'s
 *  readline lifecycle — created after the TTY gate, always closed. */
async function promptLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
      rl.on("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

/** Human work sessions eligible for the restore offer: every sweep/kill session
 *  except the reconciler-managed `autopilot` (= [work], iterated in
 *  SWEEP_KILL_SESSIONS order for deterministic prompt/spawn output). Derived
 *  from the sweep/kill set so the `!== MANAGED_EXEC_SESSION` filter stays
 *  meaningful. */
export const RESTORABLE = SWEEP_KILL_SESSIONS.filter(
  (s) => s !== MANAGED_EXEC_SESSION,
);

/**
 * One session's restore offer, derived from the SAME selection seam
 * (`loadRestorePlan`) the applied restore reads — so the promised count matches
 * what `keeper tabs restore --apply --generation <id>` restores. `count` is the
 * session's candidate count in the picked generation; `generationId` is that
 * generation (the `--generation <id>` target, `null` on the killed-cohort
 * fallback); `generationLastTs` / `generationMaxPanes` are the prompt's age +
 * skeleton-hint context (`null` on the fallback, which carries no generation).
 */
export interface RestoreOffer {
  count: number;
  generationId: string | null;
  generationLastTs: number | null;
  generationMaxPanes: number | null;
}

/**
 * The restore-offer envelope the boot flow escalates on: the per-session offers
 * PLUS the generation-level metadata the escalate-or-refuse contract needs.
 * `ambiguous` forces the picker (TTY) / refusal (non-TTY) instead of a silent
 * auto-pick; `eligible` is the picker menu (newest-first); `fallbackNote` is the
 * VISIBLE degraded-restore banner. `offers` is keyed by backend session name.
 */
export interface RestoreOfferBundle {
  offers: Record<string, RestoreOffer>;
  ambiguous: boolean;
  eligible: GenerationSummary[];
  fallbackNote?: string;
}

/**
 * Injectable provider for the restore-offer bundle. Default runs
 * {@link loadRestorePlan} ONCE (read-only `keeper.db`, NO tmux drive — it probes
 * `G_now` read-only itself) and groups the picked generation's candidates by
 * `backend_exec_session_id`, stamping each session's offer with the shared
 * generation context. Routing the offer through the SAME seam the applied restore
 * reads keeps the promised count and the restored set in lockstep. An optional
 * `generationId` re-resolves THAT generation verbatim (the picker's second pass),
 * bypassing the auto-pick and the mirror cross-check. Tests inject a fake so they
 * need no real DB. Daemon-down is fine (read-only); any open/read failure
 * degrades to an empty non-ambiguous bundle (skip every offer rather than crash
 * setup) — exactly the old count-path catch.
 */
export type RestoreOfferFn = (
  generationId?: string | null,
) => RestoreOfferBundle;

/**
 * Collect the last NON-EMPTY restore.json mirror's job-id set (every session
 * bucket's agents). Absent / garbage / empty-set mirror ⇒ empty set (no
 * cross-check). Read-only, best-effort — the mirror is a disaster-fallback
 * cross-check, never the restore source.
 */
export function readMirrorJobIds(mirrorPath: string): Set<string> {
  const ids = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(mirrorPath, "utf8")) as {
      current?: {
        sessions?: Record<string, { agents?: { job_id?: unknown }[] }>;
      } | null;
    };
    const sessions = parsed?.current?.sessions;
    if (sessions != null && typeof sessions === "object") {
      for (const bucket of Object.values(sessions)) {
        for (const agent of bucket?.agents ?? []) {
          if (typeof agent?.job_id === "string" && agent.job_id !== "") {
            ids.add(agent.job_id);
          }
        }
      }
    }
  } catch {
    // Absent / unreadable / non-JSON mirror ⇒ empty set ⇒ no cross-check.
  }
  return ids;
}

/**
 * Pure: fold a {@link RestoreSelection} into the offer bundle, applying the
 * disaster-mirror cross-check. A derived cohort that DISAGREES with the last
 * non-empty restore.json job-id set forces `ambiguous` (so a divergence between
 * the live derivation and the pre-crash mirror escalates rather than silently
 * auto-picking). The cross-check runs only for an auto-pick
 * (`enableMirrorCrossCheck`); an explicit `--generation` pick — the picker's
 * second pass — is already disambiguated and bypasses it. An empty mirror set
 * never forces ambiguity.
 */
export function selectionToOfferBundle(
  selection: RestoreSelection,
  mirrorJobIds: ReadonlySet<string>,
  enableMirrorCrossCheck: boolean,
): RestoreOfferBundle {
  const gen = selection.pickedGeneration;
  const offers: Record<string, RestoreOffer> = {};
  for (const c of selection.candidates) {
    const key = c.backend_exec_session_id ?? "";
    const existing = offers[key];
    if (existing !== undefined) {
      existing.count += 1;
    } else {
      offers[key] = {
        count: 1,
        generationId: gen?.generation_id ?? null,
        generationLastTs: gen?.last_ts ?? null,
        generationMaxPanes: gen?.max_pane_count ?? null,
      };
    }
  }
  const mirrorDisagrees =
    enableMirrorCrossCheck &&
    !selection.ambiguous &&
    selection.candidates.length > 0 &&
    jobIdSetsDiffer(
      new Set(selection.candidates.map((c) => c.job_id)),
      mirrorJobIds,
    );
  return {
    offers,
    ambiguous: selection.ambiguous || mirrorDisagrees,
    eligible: selection.eligible,
    fallbackNote: selection.fallbackNote,
  };
}

/** Pure: does the derived job-id set disagree with a NON-EMPTY mirror set? An
 *  empty mirror is not a disagreement (nothing to cross-check against). */
function jobIdSetsDiffer(
  derived: ReadonlySet<string>,
  mirror: ReadonlySet<string>,
): boolean {
  if (mirror.size === 0) {
    return false;
  }
  if (derived.size !== mirror.size) {
    return true;
  }
  for (const id of derived) {
    if (!mirror.has(id)) {
      return true;
    }
  }
  return false;
}

const defaultRestoreOffer: RestoreOfferFn = (generationId?: string | null) => {
  try {
    const gid = generationId ?? null;
    const selection = loadRestorePlan(resolveDbPath(), { generationId: gid });
    // Auto-pick cross-checks the disaster mirror; an explicit --generation pick
    // (the picker's second pass) is already disambiguated and skips it.
    const enableCrossCheck = gid === null || gid === "";
    const mirrorJobIds = enableCrossCheck
      ? readMirrorJobIds(resolveRestorePath())
      : new Set<string>();
    return selectionToOfferBundle(selection, mirrorJobIds, enableCrossCheck);
  } catch {
    return { offers: {}, ambiguous: false, eligible: [] };
  }
};

const RESTORE_RETRY_SCHEMA_VERSION = 1;

/** Durable retry marker for setup-tmux's accepted restore batches. */
export interface RestoreRetryStore {
  read(): Record<string, RestoreOffer>;
  mark(offers: Record<string, RestoreOffer>): void;
  clear(sessions: readonly string[]): void;
}

export function resolveSetupTmuxRestoreRetryPath(): string {
  return join(dirname(resolveRestorePath()), "setup-tmux-restore-retry.json");
}

function normalizeRetryOffer(raw: unknown): RestoreOffer | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const count = obj.count;
  if (!Number.isInteger(count) || (count as number) <= 0) {
    return null;
  }
  const generationId =
    typeof obj.generationId === "string" && obj.generationId !== ""
      ? obj.generationId
      : null;
  const generationLastTs =
    typeof obj.generationLastTs === "number" &&
    Number.isFinite(obj.generationLastTs)
      ? obj.generationLastTs
      : null;
  const generationMaxPanes =
    typeof obj.generationMaxPanes === "number" &&
    Number.isFinite(obj.generationMaxPanes)
      ? obj.generationMaxPanes
      : null;
  return {
    count: count as number,
    generationId,
    generationLastTs,
    generationMaxPanes,
  };
}

function readRetryFile(path: string): Record<string, RestoreOffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (typeof sessions !== "object" || sessions === null) {
    return {};
  }
  const out: Record<string, RestoreOffer> = {};
  for (const [session, offer] of Object.entries(sessions)) {
    const normalized = normalizeRetryOffer(offer);
    if (session !== "" && normalized !== null) {
      out[session] = normalized;
    }
  }
  return out;
}

function writeRetryFile(
  path: string,
  sessions: Record<string, RestoreOffer>,
): void {
  const keys = Object.keys(sessions)
    .filter((k) => k !== "")
    .sort();
  if (keys.length === 0) {
    try {
      fs.unlinkSync(path);
    } catch (err) {
      if ((err as { code?: string })?.code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  const ordered: Record<string, RestoreOffer> = {};
  for (const key of keys) {
    ordered[key] = sessions[key] as RestoreOffer;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify(
      {
        schema_version: RESTORE_RETRY_SCHEMA_VERSION,
        sessions: ordered,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(tmp, path);
}

function fileRestoreRetryStore(
  path = resolveSetupTmuxRestoreRetryPath(),
): RestoreRetryStore {
  return {
    read: () => readRetryFile(path),
    mark: (offers) => {
      writeRetryFile(path, { ...readRetryFile(path), ...offers });
    },
    clear: (sessions) => {
      const next = readRetryFile(path);
      for (const session of sessions) {
        delete next[session];
      }
      writeRetryFile(path, next);
    },
  };
}

/**
 * Build the `keeper tabs restore --apply` spawn argv for one session — the
 * subprocess owns ExecBackend; setup-tmux only spawns it. `--session <name>`
 * scopes to that session; `--generation <id>` targets the offer's picked
 * generation (omitted on the killed-cohort fallback, where the child auto-picks);
 * `--allow-empty` makes the count/apply race — a candidate going live between the
 * offer and this apply — a benign `restored 0` (exit 0), never a failure.
 */
export function buildTabsRestoreArgv(
  session: string,
  generationId: string | null,
): string[] {
  const argv = [
    "keeper",
    "tabs",
    "restore",
    "--apply",
    "--allow-empty",
    "--session",
    session,
  ];
  if (generationId !== null && generationId !== "") {
    argv.push("--generation", generationId);
  }
  return argv;
}

/** Parse a `<field>=<n>` token off a `keeper tabs restore` summary line; null
 *  when absent (degraded/older child output, or the field wasn't emitted
 *  because the transaction engine had nothing to report for it). */
function parseSummaryField(stdout: string, field: string): number | null {
  const m = stdout.match(new RegExp(`${field}=(\\d+)`));
  return m != null ? Number.parseInt(m[1] as string, 10) : null;
}

/**
 * Render the ONE authoritative outcome line for a session's synchronous
 * `keeper tabs restore --apply` spawn, surfacing the per-tab verified/failed/
 * unverified counts the transaction engine (`src/tabs-core.ts` `countOutcomes`)
 * emits on its `# summary:` stdout line — never just an opaque exit code.
 *
 * Exit 0 ⇒ a success line: the restored count (parsed from the child summary,
 * offer count as fallback) plus the picked-generation context — a candidate
 * going live between offer and apply reads here as a benign `restored 0`,
 * never a failure. A `launched-unverified` warn can coexist with exit 0 (it
 * doesn't trip the partial-failure exit), so an `unverified=` note is appended
 * whenever the count is nonzero. Exit `TABS_EXIT_PARTIAL_FAILURE` ⇒ a PARTIAL
 * line carrying the restored/failed/unverified breakdown parsed off the same
 * summary. Any other non-zero exit ⇒ a FAILED line carrying the verbatim child
 * stderr (the autopilot-gate refusal included). Pure.
 */
export function renderRestoreOutcome(
  session: string,
  offer: RestoreOffer | undefined,
  result: SyncSpawnResult,
  nowSecs: number = Date.now() / 1000,
): string {
  const stdout = result.stdout.toString();
  const genId = offer?.generationId ?? null;
  const ctx =
    genId !== null && offer?.generationLastTs != null
      ? ` from generation ${genId} (${formatAge(nowSecs - offer.generationLastTs)} ago)`
      : "";
  if (result.exitCode === 0) {
    const restored = parseSummaryField(stdout, "restored") ?? offer?.count ?? 0;
    const unverified = parseSummaryField(stdout, "unverified") ?? 0;
    const unverifiedNote = unverified > 0 ? ` (unverified=${unverified})` : "";
    return `keeper setup-tmux: '${session}' restored ${restored} agent(s)${unverifiedNote}${ctx}`;
  }
  if (result.exitCode === TABS_EXIT_PARTIAL_FAILURE) {
    const restored = parseSummaryField(stdout, "restored") ?? 0;
    const failed = parseSummaryField(stdout, "failed") ?? 0;
    const unverified = parseSummaryField(stdout, "unverified") ?? 0;
    const unverifiedNote = unverified > 0 ? ` unverified=${unverified}` : "";
    return `keeper setup-tmux: '${session}' restore PARTIAL (exit ${TABS_EXIT_PARTIAL_FAILURE}): restored=${restored} failed=${failed}${unverifiedNote}${ctx}`;
  }
  const code =
    result.exitedDueToTimeout === true
      ? "timeout"
      : result.exitCode === null
        ? "signal"
        : String(result.exitCode);
  const stderr = result.stderr.toString().trim();
  const detail = stderr !== "" ? stderr : stdout.trim();
  return `keeper setup-tmux: '${session}' restore FAILED (exit ${code}): ${detail}`;
}

export async function main(
  argv: string[],
  spawn: SyncSpawnFn = defaultSpawn,
  restoreOffer: RestoreOfferFn = defaultRestoreOffer,
  guardFs: GuardFs = defaultGuardFs,
  retryStore: RestoreRetryStore = fileRestoreRetryStore(),
  dashRecovery?: DashServerRecovery,
): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008).
    options: parseOptions("setup-tmux"),
    allowPositionals: false,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (isInsideDashServer(process.env.TMUX)) {
    process.stderr.write(
      "keeper setup-tmux: refusing to rebuild the dash server from inside one of its own panes — run this command outside `tmux -L dash`\n",
    );
    process.exit(1);
  }

  // Injected spawn seams stay filesystem-pure by default. Production records
  // the dash process/socket identity for guarded recovery on a later timeout.
  const effectiveDashRecovery =
    dashRecovery ??
    (spawn === defaultSpawn ? fileDashServerRecovery() : undefined);

  try {
    // Fail-open: install Keeper's tmux drop-ins before provisioning. A shared
    // parent-creation failure is caught here; per-link failures are isolated by
    // ensureTmuxConfSymlinks itself.
    try {
      ensureTmuxConfSymlinks(guardFs);
    } catch (e) {
      process.stderr.write(
        `keeper setup-tmux: tmux drop-in install failed, continuing — ${String(e)}\n`,
      );
    }
    // A warm default server does not reread tmux.conf merely because a new
    // conf.d symlink appeared. Source this one drop-in before provisioning so
    // every subsequently spawned pane inherits the zsh marker. No server yet
    // is a benign non-zero: the first new-session loads tmux.conf normally.
    run(spawn, buildSourceShellConfArgs());

    if (parsed.values["kill-sessions"]) {
      // Gate on server liveness first: no server ⇒ nothing to kill, nothing
      // busy, proceed straight to setup.
      const serverUp = run(spawn, buildListSessionsArgs()).exitCode === 0;
      if (serverUp) {
        const busy = sweepBusyPanes(spawn);
        if (busy.length > 0) {
          const tty =
            process.stdout.isTTY === true && process.stdin.isTTY === true;
          if (!tty) {
            process.stderr.write(
              `keeper setup-tmux: busy panes present, refusing to kill (non-TTY):\n${renderBusyTable(busy)}\n`,
            );
            process.exit(1);
          }
          process.stdout.write(`${renderBusyTable(busy)}\n`);
          if (!(await confirm())) {
            process.stderr.write(
              "keeper setup-tmux: aborted, killed nothing\n",
            );
            process.exit(1);
          }
        }
        killAllSessions(spawn);
      }
    }

    // Restore-last-session offer — computed BEFORE ensureWorkSessions, which
    // mints `work` on the DEFAULT server (a new generation that would shift the
    // kill-anchored window). rebuildDash lives on a SEPARATE `-L dash` server
    // and no longer perturbs the default-server anchor, but the offer stays here
    // ahead of provisioning regardless. A fresh session is offered only when it
    // is absent or a one-shell skeleton AND has >0 candidates in the picked
    // generation. A marked retry is offered even when the session now
    // exists, so a failed apply remains reachable after setup created the empty
    // shell session. Offers are read ONCE up front off the SAME selection seam
    // the apply reads, and RESTORABLE (not the offer-map keys) is the iteration
    // source so a stale or non-provisioned `backend_exec_session_id` can't leak
    // into the prompt.
    const bundle = restoreOffer();
    const retryOffers = retryStore.read();
    const nowSecs = Date.now() / 1000;
    const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
    // Probe once, before the picker. Besides distinguishing setup's blank shell
    // from a real active session, caching this decision makes an accepted picker
    // choice durable across the later dash rebuild / session ensure operations.
    const freshEligibility = new Map(
      RESTORABLE.map((session) => [
        session,
        (bundle.offers[session]?.count ?? 0) > 0
          ? canAcceptFreshRestore(spawn, session)
          : false,
      ]),
    );

    // Escalate-or-refuse a CONTESTED fresh auto-pick BEFORE anything is restored
    // — never a silent auto-pick, never a silent drop. `ambiguous` fires when the
    // richest generation isn't the freshest OR the derived cohort disagrees with
    // the disaster mirror. TTY ⇒ the numbered generation picker (reusing the
    // tabs.ts menu + choice parser); non-TTY ⇒ a VISIBLE stderr refusal naming
    // `keeper tabs restore` (never blocking provisioning — setup-tmux runs at
    // shell boot where non-TTY is common). Retry offers (already-accepted,
    // disambiguated picks) are untouched by this gate.
    let freshOffers = bundle.offers;
    // A successful picker choice IS the confirmation — the picked fresh offers
    // skip the generic y/N confirm below (asking twice would be redundant).
    let pickerConfirmed = false;
    // Explicit skip bypasses BOTH fresh offers and previously accepted retry
    // markers, so setup can finish without launching any restore tabs.
    let skipRestore = false;
    const freshHasOffer = RESTORABLE.some(
      (session) =>
        freshEligibility.get(session) === true &&
        (freshOffers[session]?.count ?? 0) > 0,
    );
    if (bundle.ambiguous && freshHasOffer) {
      if (tty) {
        process.stdout.write(
          "keeper setup-tmux: ambiguous last-session restore — the newest " +
            "generation isn't unambiguously the one to restore (a richer older " +
            "cohort, or a disaster-mirror disagreement). Choose one, or skip " +
            "restore and continue setup:\n",
        );
        process.stdout.write(
          `${formatGenerationMenu(bundle.eligible, nowSecs)}\n`,
        );
        const answer = await promptLine(
          "Generation to restore (number), s to skip restore, or blank to abort: ",
        );
        const trimmedAnswer = answer.trim().toLowerCase();
        if (trimmedAnswer === "s" || trimmedAnswer === "skip") {
          freshOffers = {};
          skipRestore = true;
          retryStore.clear(RESTORABLE);
          process.stderr.write(
            "keeper setup-tmux: restore skipped — continuing setup without restoring tabs\n",
          );
        } else {
          const idx = parsePickerChoice(answer, bundle.eligible.length);
          if (idx === null) {
            freshOffers = {};
            process.stderr.write(
              "keeper setup-tmux: ambiguous restore aborted — restored nothing " +
                "(re-run `keeper tabs restore` to choose)\n",
            );
          } else {
            const chosen = bundle.eligible[idx] as GenerationSummary;
            // Re-resolve THAT generation verbatim (disambiguated, no cross-check).
            freshOffers = restoreOffer(chosen.generation_id).offers;
            pickerConfirmed = true;
          }
        }
      } else {
        process.stderr.write(
          "keeper setup-tmux: refusing an AMBIGUOUS last-session restore " +
            "(non-TTY) — the newest generation isn't unambiguously the one to " +
            "restore. Run `keeper tabs restore` on a TTY (or with " +
            "--generation <id>) to choose:\n",
        );
        process.stderr.write(
          `${formatGenerationMenu(bundle.eligible, nowSecs)}\n`,
        );
        freshOffers = {};
      }
    }

    const offers = skipRestore ? {} : { ...freshOffers, ...retryOffers };
    const offered = RESTORABLE.filter((session) => {
      const offer = offers[session];
      if ((offer?.count ?? 0) <= 0) {
        return false;
      }
      if (retryOffers[session] !== undefined) {
        return true;
      }
      return freshEligibility.get(session) === true;
    });
    let restoreSessions: readonly string[] = [];
    if (offered.length > 0) {
      // A picker-confirmed set restores WITHOUT a second y/N prompt (the pick was
      // the confirmation), marking each for retry exactly as the confirm path does.
      if (pickerConfirmed) {
        restoreSessions = offered;
        retryStore.mark(
          Object.fromEntries(
            restoreSessions.map((session) => [
              session,
              offers[session] as RestoreOffer,
            ]),
          ),
        );
      } else if (tty) {
        // Non-empty offer AND TTY ⇒ ONE combined prompt naming each session with
        // its agent count + the picked generation's age (a skeleton is
        // recognizable here); non-TTY NEVER auto-restores.
        const detail = offered
          .map((s) => {
            const o = offers[s] as RestoreOffer;
            const age =
              o.generationLastTs !== null
                ? `${formatAge(nowSecs - o.generationLastTs)} ago`
                : "age unknown";
            const panes =
              o.generationMaxPanes !== null
                ? `, peak ${o.generationMaxPanes} pane(s)`
                : "";
            return `${s}: ${o.count} agent(s), ${age}${panes}`;
          })
          .join("; ");
        if (await confirm(`Restore last-session agents (${detail})? [y/N] `)) {
          restoreSessions = offered;
          retryStore.mark(
            Object.fromEntries(
              restoreSessions.map((session) => [
                session,
                offers[session] as RestoreOffer,
              ]),
            ),
          );
        } else {
          const declinedRetries = offered.filter(
            (session) => retryOffers[session] !== undefined,
          );
          if (declinedRetries.length > 0) {
            retryStore.clear(declinedRetries);
          }
        }
      }
    }

    // Fail-open: the deprecated dash server is isolated on its own socket, so a
    // rebuild failure must not block provisioning the human's `work` session —
    // warn and continue, exit 0.
    let dashRebuilt = false;
    try {
      rebuildDash(spawn, effectiveDashRecovery);
      dashRebuilt = true;
    } catch (e) {
      const detail = e instanceof TmuxError ? e.message : String(e);
      process.stderr.write(
        `keeper setup-tmux: dash rebuild failed, continuing — ${detail}\n`,
      );
    }
    ensureWorkSessions(spawn);
    process.stdout.write(
      dashRebuilt
        ? `keeper setup-tmux: '${DASH_SESSION}' rebuilt, work sessions ensured — attach with: tmux -L ${DASH_SESSION} attach\n`
        : `keeper setup-tmux: work sessions ensured; '${DASH_SESSION}' is unavailable — rerun keeper setup-tmux\n`,
    );

    // Synchronous restore: spawn `keeper tabs restore --apply` per offered
    // session through the SyncSpawnFn seam (the subprocess owns ExecBackend),
    // capture the exit code + output, and print ONE authoritative outcome line
    // per session — nothing fire-and-forget. Continue-on-error: a spawn fault
    // (ENOENT) degrades to a FAILED line, never aborting the next session or the
    // completed setup.
    for (const session of restoreSessions) {
      const offer = offers[session];
      const argv = buildTabsRestoreArgv(session, offer?.generationId ?? null);
      let result: SyncSpawnResult;
      const timeout = setupTmuxSpawnTimeoutMs(argv);
      try {
        result = spawn(argv, { timeout });
        if (result.exitedDueToTimeout === true) {
          result = {
            ...result,
            exitCode: null,
            stderr: Buffer.from(`command timed out after ${timeout}ms`),
          };
        } else if (result.exitCode === null && result.stderr.length === 0) {
          result = {
            ...result,
            stderr: Buffer.from(
              `command killed by signal ${result.signalCode ?? "unknown"}`,
            ),
          };
        }
      } catch (e) {
        result = {
          exitCode: null,
          stdout: Buffer.from(""),
          stderr: Buffer.from(
            `keeper setup-tmux: failed to spawn ${argv[0]}: ${String(e)}`,
          ),
        };
      }
      process.stdout.write(
        `${renderRestoreOutcome(session, offer, result, nowSecs)}\n`,
      );
      if (result.exitCode === 0) {
        retryStore.clear([session]);
      }
    }
  } catch (e) {
    if (e instanceof TmuxError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry
// (its dispatcher prunes the subcommand token from argv before calling main).
