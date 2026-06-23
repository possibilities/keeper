#!/usr/bin/env bun
/**
 * `keeper setup-tmux` — one-shot provisioner for the human's tmux control
 * plane. It rebuilds the deprecated `dash` dashboard on every run on its OWN
 * dedicated `tmux -L dash` server (blown away with `tmux -L dash kill-server`
 * and recreated wholesale) and provisions only the human `work` session on the
 * default server (one shell window). `autopilot` is daemon-minted on demand on
 * the default server, so setup-tmux does not create it — but it is still swept
 * for busy panes and torn down by `--kill-sessions`. It NEVER attaches or
 * `switch-client`s, so it is safe to run inside or outside tmux.
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
 * When the human `work` session is ABSENT after a
 * crash and the last tmux-server generation left crashed agents for it, the
 * first `setup-tmux` offers — one combined y/N TTY prompt — to relaunch them;
 * the reconciler-managed `autopilot` session is never offered.
 *
 *   keeper setup-tmux [--kill-sessions]
 *   keeper setup-tmux --help
 */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { openDb, resolveDbPath } from "../src/db";
import { localeDefaultedEnv, MANAGED_EXEC_SESSION } from "../src/exec-backend";
import { deriveLastGenerationSet } from "../src/restore-set";

export const HELP = `keeper setup-tmux — provision the tmux control plane (dash server + work session)

Usage:
  keeper setup-tmux [--kill-sessions]
  keeper setup-tmux --help

Rebuilds the deprecated 'dash' dashboard every run on its OWN dedicated
'tmux -L dash' server (board + autopilot/jobs/git/builds/usage panes,
main-vertical) and provisions only the human 'work' session on the default
server (one shell window, stamped with KEEPER_TMUX_SESSION). 'autopilot' is
daemon-minted on demand, so it is not created here — but it is still swept and
torn down by --kill-sessions. An existing 'work' session is left untouched.
NEVER attaches or switch-clients — safe to run inside or outside tmux. Attach
the dashboard with: tmux -L dash attach.

When the work session ('work') is ABSENT (the first run
after a crash) and the last tmux-server generation left crashed agents for it,
it offers — ONE combined y/N prompt on a TTY only, never auto — to relaunch them
via 'restore-agents --last-generation', per absent session. The managed
'autopilot' session is never offered. A present session, zero candidates, or a
non-TTY skips that session's offer.

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

/** The five right-hand dash panes, in split order, after the board main pane. */
export const DASH_SUB_PANES = [
  "autopilot",
  "jobs",
  "git",
  "builds",
  "usage",
] as const;

const KEEPER_DIR = `${process.env.HOME ?? ""}/code/keeper`;
/** Detached-session fallback size when neither $TMUX nor `tput` yields one. */
const FALLBACK_WIDTH = 200;
const FALLBACK_HEIGHT = 50;

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
}

/** Injectable sync-spawn seam matching `Bun.spawnSync`. */
export type SyncSpawnFn = (
  cmd: string[],
  options?: { env?: Record<string, string> },
) => SyncSpawnResult;

const defaultSpawn: SyncSpawnFn = (cmd, options) =>
  Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    ...(options?.env != null ? { env: options.env } : {}),
  }) as unknown as SyncSpawnResult;

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
 * `tmux -L dash new-session -d -s dash -c <dir> -e TMUX= -x <W> -y <H> -P -F
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
    KEEPER_DIR,
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
 * `split-window -d -t =dash -c <dir> -P -F '#{pane_id}' -- <argv...>`. `-d`
 * keeps the new pane unfocused; `-P -F '#{pane_id}'` prints the created pane's
 * id so we can re-select the board pane positionally-independent of
 * `pane-base-index`.
 */
export function buildDashSplitArgs(sub: string): string[] {
  return dashTmux(
    "split-window",
    "-d",
    "-t",
    `=${DASH_SESSION}:`,
    "-c",
    KEEPER_DIR,
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
 * `new-session -d -s <name> -c <dir> -e KEEPER_TMUX_SESSION=<name>` work-session
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
    KEEPER_DIR,
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
      const r = spawn(buildDisplayMetricArgs(metric));
      if (r.exitCode === 0) {
        const n = parseSize(r.stdout.toString());
        if (n != null) {
          return n;
        }
      }
    }
    const t = spawn(buildTputArgs(cap));
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

class TmuxError extends Error {
  constructor(
    readonly argv: string[],
    readonly stderr: string,
  ) {
    super(`tmux failed: ${argv.join(" ")}\n${stderr}`);
    this.name = "TmuxError";
  }
}

/** Run a tmux/tput command and return its result; surface ENOENT as a clear
 *  "tmux not found" error rather than a stack trace. */
function run(
  spawn: SyncSpawnFn,
  argv: string[],
  env?: Record<string, string>,
): SyncSpawnResult {
  try {
    return spawn(argv, env != null ? { env } : undefined);
  } catch (e) {
    const msg =
      (e as { code?: string })?.code === "ENOENT"
        ? `keeper setup-tmux: '${argv[0]}' not found on PATH`
        : `keeper setup-tmux: failed to spawn ${argv[0]}: ${String(e)}`;
    throw new TmuxError(argv, msg);
  }
}

/** Run a command that MUST succeed; throw `TmuxError` (exit-code null = signal
 *  kill = failure) so `main` can fail loud with the argv + stderr. */
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
 *  unconditional kill-server, sized new-session, main-pane-width, the five
 *  splits each followed by a layout pass, then re-focus the board pane by its
 *  captured id. */
function rebuildDash(spawn: SyncSpawnFn): void {
  // Unconditional dash-server kill — any non-zero (no server yet) is fine.
  run(spawn, buildKillDashServerArgs());

  const { width, height } = resolveDashSize(spawn);
  const boardPane = runChecked(spawn, buildDashNewSessionArgs(width, height));
  const boardPaneId = boardPane.stdout.toString().trim();
  runChecked(spawn, buildSetMainPaneWidthArgs());

  for (const sub of DASH_SUB_PANES) {
    runChecked(spawn, buildDashSplitArgs(sub));
    // Re-balance after EVERY split — splitting all five then laying out once
    // fails "no space for new pane".
    runChecked(spawn, buildSelectLayoutArgs());
  }

  // Re-focus the board pane by its captured id (positional `.1` breaks under
  // pane-base-index 1).
  if (boardPaneId !== "") {
    runChecked(spawn, buildSelectPaneArgs(boardPaneId));
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

/** Human work sessions eligible for the restore offer: every sweep/kill session
 *  except the reconciler-managed `autopilot` (= [work], iterated in
 *  SWEEP_KILL_SESSIONS order for deterministic prompt/spawn output). Derived
 *  from the sweep/kill set so the `!== MANAGED_EXEC_SESSION` filter stays
 *  meaningful. */
export const RESTORABLE = SWEEP_KILL_SESSIONS.filter(
  (s) => s !== MANAGED_EXEC_SESSION,
);

/**
 * Injectable provider for the last-generation crash-candidate counts, keyed by
 * backend session name. Default opens `keeper.db` READ-ONLY (NOT the ExecBackend
 * seam — reading the DB is allowed here; only multiplexer drive stays outside
 * it), runs {@link deriveLastGenerationSet} ONCE, and groups its candidates by
 * `backend_exec_session_id`. Tests inject a fake so they need no real DB.
 * Daemon-down is fine (read-only connection); any open/read failure degrades to
 * `{}` (skip every offer rather than crash setup).
 */
export type CandidateCountFn = () => Record<string, number>;

const defaultCandidateCount: CandidateCountFn = () => {
  try {
    const { db } = openDb(resolveDbPath(), { readonly: true });
    try {
      const { candidates } = deriveLastGenerationSet(db);
      const counts: Record<string, number> = {};
      for (const c of candidates) {
        counts[c.backend_exec_session_id] =
          (counts[c.backend_exec_session_id] ?? 0) + 1;
      }
      return counts;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
};

/**
 * Build the restore-agents spawn argv for one session's last-generation set —
 * the subprocess owns ExecBackend; setup-tmux only spawns it. `--apply` actually
 * relaunches, `--session <name>` scopes to that session, `--last-generation`
 * bounds to the kill-anchored generation window.
 */
export function buildRestoreAgentsArgv(session: string): string[] {
  return [
    "bun",
    `${KEEPER_DIR}/scripts/restore-agents.ts`,
    "--apply",
    "--session",
    session,
    "--last-generation",
  ];
}

export async function main(
  argv: string[],
  spawn: SyncSpawnFn = defaultSpawn,
  candidateCount: CandidateCountFn = defaultCandidateCount,
): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      "kill-sessions": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  try {
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
    // ahead of provisioning regardless. A session is offered only when it is
    // ABSENT (the first setup-tmux after a crash) AND has >0 last-generation
    // candidates; a present session means this run isn't a recovery for it and
    // we skip silently. Counts are read ONCE up front, and RESTORABLE (not the
    // count-map keys) is the iteration source so a stale or non-provisioned
    // `backend_exec_session_id` can't leak into the prompt.
    const counts = candidateCount();
    const offered = RESTORABLE.filter(
      (session) =>
        run(spawn, buildHasSessionArgs(session)).exitCode !== 0 &&
        (counts[session] ?? 0) > 0,
    );
    let restoreSessions: readonly string[] = [];
    if (offered.length > 0) {
      const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
      // Non-empty offer AND TTY ⇒ ONE combined prompt naming each session +
      // count; non-TTY NEVER auto-restores.
      if (tty) {
        const detail = offered.map((s) => `${s}: ${counts[s] ?? 0}`).join(", ");
        if (await confirm(`Restore last-session agents (${detail})? [y/N] `)) {
          restoreSessions = offered;
        }
      }
    }

    // Fail-open: the deprecated dash server is isolated on its own socket, so a
    // rebuild failure must not block provisioning the human's `work` session —
    // warn and continue, exit 0.
    try {
      rebuildDash(spawn);
    } catch (e) {
      const detail = e instanceof TmuxError ? e.message : String(e);
      process.stderr.write(
        `keeper setup-tmux: dash rebuild failed, continuing — ${detail}\n`,
      );
    }
    ensureWorkSessions(spawn);
    process.stdout.write(
      `keeper setup-tmux: '${DASH_SESSION}' rebuilt, work sessions ensured — attach with: tmux -L ${DASH_SESSION} attach\n`,
    );

    // Continue-on-error: each spawn is fire-and-forget via run() so one
    // session's restore failing can't abort the other or the completed setup.
    for (const session of restoreSessions) {
      // The subprocess owns ExecBackend; setup-tmux only spawns it.
      run(spawn, buildRestoreAgentsArgv(session));
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
