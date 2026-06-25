/**
 * `keeper pair panel start|wait` — the cross-OS panel fan-out orchestrator the
 * `plan:panel-runner` agent drives instead of hand-rolling `setsid`/`timeout` in
 * shell (neither exists on stock macOS). All the OS-specific machinery lives here
 * in TS: detachment via a `nohup` double-fork POSIX-shell wrapper (NOT
 * `setsid`/`timeout`/`gtimeout`), a `Date.now()`-deadline poll loop (NOT a shell
 * `timeout`), and atomic same-dir temp-then-rename sentinels (EXDEV-safe on
 * macOS, where `os.tmpdir()` is a different APFS volume).
 *
 *   - `start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]`
 *     resolves the panel members in-process, copies the prompt into a scratch
 *     dir, launches every member as a DETACHED `keeper pair send` leg, persists
 *     `<dir>/manifest.json`, prints it, and exits 0 immediately.
 *   - `wait --dir <d> [--chunk <s>]` re-reads the manifest and blocks ONE chunk
 *     polling each leg's terminality; exit 0 + verdict JSON when all legs are
 *     terminal, exit 124 when the chunk elapses (re-issuable), exit 2 on a
 *     missing/corrupt manifest or bad flags.
 *
 * CONTENT-BLIND: `wait` reads each `.yaml` only for EXISTENCE and each `.log`
 * only for the wrapper's own `[keeper-pair]` event / `pair:` arg-fault lines —
 * NEVER a panelist's answer content. `exit 0` means all-terminal, NOT
 * all-success: the agent keys off the verdict's `ok` flag.
 *
 * No keeper.db write, no RPC, no third-party deps — `node:*` plus the dep-free
 * `src/agent/config` + `src/pair-command` leaves only.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  loadPresetRegistry,
  type PresetRegistry,
} from "../agent/config";
import {
  PAIR_CLIS,
  type PairCli,
  resolvePairKeeperAgentPath,
} from "../pair-command";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Panel name used when `--panel` is absent (the panel-runner default). */
export const DEFAULT_PANEL_NAME = "default";
/** Per-leg `keeper pair send --timeout` default (seconds). */
export const DEFAULT_PANEL_TIMEOUT_SECONDS = 1800;
/** Default `wait --chunk` (seconds) — the panel-runner's ≤9-min window. */
export const DEFAULT_PANEL_CHUNK_SECONDS = 540;
/** `--chunk` ceiling: a `wait` is one Bash call, capped at 600s by the harness,
 *  so the chunk must stay safely under it (a 30s margin for poll overhead). A
 *  chunk above this is rejected so the agent never wedges the single call. */
export const MAX_CHUNK_SECONDS = 570;
/** Poll cadence inside one `wait` chunk. */
const POLL_INTERVAL_MS = 5_000;
/** A pidfile-dead leg is only a crash-fail once this long has elapsed since
 *  `wait` began polling — the pidfile is written a beat after the leg spawns, so
 *  a fresh `wait` gives the leg a moment before trusting a dead pid. */
const PID_STARTUP_GRACE_MS = 3_000;
/** The tmux session every leg lands in (matches the panel-runner). */
const PANEL_SESSION = "panels";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved panel member. `preset` set → launch via `--preset <preset>`;
 *  absent → the legacy `--cli <harness>` form. `name` is the leg label and the
 *  basename of its `.yaml`/`.log`/`.pidfile`. */
export interface PanelMember {
  name: string;
  harness: PairCli;
  preset?: string;
}

/** One member's persisted launch record in the manifest. `pidfile` is null when
 *  the leg's spawn threw at launch (it never started → a normal N-of-N fail). */
export interface PanelManifestMember {
  name: string;
  harness: string;
  yaml: string;
  log: string;
  pidfile: string | null;
}

/** The `start`-persisted, `wait`-re-read manifest. */
export interface PanelManifest {
  dir: string;
  members: PanelManifestMember[];
}

/** One member's verdict line. `status:"ok"` ⇒ `yaml` set, `reason` null;
 *  `status:"fail"` ⇒ `yaml` null, `reason` a wrapper-sourced diagnostic. */
export interface PanelVerdictMember {
  name: string;
  harness: string;
  status: "ok" | "fail";
  yaml: string | null;
  reason: string | null;
}

/** The `wait` verdict the agent consumes. `ok` is all-success (NOT all-terminal
 *  — exit 0 already conveys all-terminal). */
export interface PanelVerdict {
  dir: string;
  ok: boolean;
  members: PanelVerdictMember[];
}

/** A detached, fire-and-forget leg spawn (Bun.spawn-shaped subset; injectable
 *  for tests). The wrapper redirects the leg's std streams + writes its pidfile,
 *  so this returns nothing — the caller never waits on it. */
export type PanelSpawnFn = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; cwd: string },
) => void;

/** Injectable seams (exec-backend house style): spawn / clock / sleep / pid
 *  probe / registry loader / output streams, plus the resolved launcher path. */
export interface PanelDeps {
  keeperBin: string;
  keeperAgentPath: string;
  env: Record<string, string | undefined>;
  cwd: string;
  loadRegistry: () => PresetRegistry;
  spawn: PanelSpawnFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pidAlive: (pid: number) => boolean;
  write: (s: string) => void;
  writeErr: (s: string) => void;
  /** Poll cadence override (tests); defaults to {@link POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Pid-death grace override (tests); defaults to {@link PID_STARTUP_GRACE_MS}. */
  graceMs?: number;
}

/** Discriminated member-resolution result. */
export type ResolveMembersResult =
  | { ok: true; members: PanelMember[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Member resolution (mirrors src/agent/main.ts runPresetsResolve, plus the
// panel-runner legacy fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve a panel name to its members. Precedence: a registry PANEL hit → its
 * members (each named by its preset, validated pair-launchable); else a single
 * PRESET hit → a one-member panel; else (unknown/undefined name) → the legacy
 * two-model fallback `opus`(claude) + `codex`(codex), launched via `--cli`. A
 * panel/preset member pinning a non-pairable harness (pi) fails loud. Pure.
 */
export function resolvePanelMembers(
  registry: PresetRegistry,
  name: string,
): ResolveMembersResult {
  const panelMembers = registry.panels[name];
  if (panelMembers !== undefined) {
    const members: PanelMember[] = [];
    for (const memberName of panelMembers) {
      const preset = registry.presets[memberName];
      if (preset === undefined) {
        return {
          ok: false,
          error: `panel '${name}' references undefined preset '${memberName}'`,
        };
      }
      if (!PAIR_CLIS.has(preset.harness)) {
        return {
          ok: false,
          error: `panel '${name}' member '${memberName}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex only)`,
        };
      }
      members.push({
        name: memberName,
        harness: preset.harness as PairCli,
        preset: memberName,
      });
    }
    if (members.length === 0) {
      return { ok: false, error: `panel '${name}' resolved to zero members` };
    }
    return { ok: true, members };
  }

  const preset = registry.presets[name];
  if (preset !== undefined) {
    if (!PAIR_CLIS.has(preset.harness)) {
      return {
        ok: false,
        error: `preset '${name}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex only)`,
      };
    }
    return {
      ok: true,
      members: [{ name, harness: preset.harness as PairCli, preset: name }],
    };
  }

  // Legacy two-model fallback — works with zero config.
  return {
    ok: true,
    members: [
      { name: "opus", harness: "claude" },
      { name: "codex", harness: "codex" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Leg argv + detachment wrapper (pure)
// ---------------------------------------------------------------------------

/**
 * Build one leg's `keeper pair send` argv:
 *   `<bun> <keeper.ts> pair send <prompt> {--preset <m>|--cli <harness>}
 *     --read-only --session panels --output <dir>/<m>.yaml --timeout <T>`.
 * The `[<bun>, <keeper.ts>]` prefix is the self-re-exec transport (daemon.ts
 * precedent); `--read-only` keeps every panelist a non-mutating explorer. Pure.
 */
export function buildPanelLegArgv(opts: {
  keeperBin: string;
  keeperAgentPath: string;
  promptPath: string;
  member: PanelMember;
  yamlPath: string;
  timeoutSeconds: number;
}): string[] {
  const launchFlag =
    opts.member.preset !== undefined
      ? ["--preset", opts.member.preset]
      : ["--cli", opts.member.harness];
  return [
    opts.keeperBin,
    opts.keeperAgentPath,
    "pair",
    "send",
    opts.promptPath,
    ...launchFlag,
    "--read-only",
    "--session",
    PANEL_SESSION,
    "--output",
    opts.yamlPath,
    "--timeout",
    String(opts.timeoutSeconds),
  ];
}

/**
 * The detachment shell program. A short-lived POSIX shell double-forks the real
 * leg so it reparents to launchd/init the instant `start` exits (raw
 * `Bun.spawn({detached:true}).unref()` is reported to die on macOS parent-exit):
 * `nohup` makes the leg SIGHUP-immune (POSIX on both OSs), `</dev/null` severs
 * stdin so the Bash tool sees EOF, `>"$LOG" 2>&1` captures both streams (NOT
 * `&>>` — `/bin/sh` is bash 3.2 on macOS), `&` backgrounds it, and `echo $!`
 * records the REAL backgrounded pid. `$LOG`/`$PIDFILE` arrive via env. Zero
 * `setsid`/`timeout`/`gtimeout`.
 */
export const DETACH_SCRIPT =
  'nohup "$@" </dev/null >"$LOG" 2>&1 & echo $! > "$PIDFILE"';

/** Wrap a leg argv in the {@link DETACH_SCRIPT} shell. The `--` is the `$0`
 *  placeholder so the leg argv lands in `"$@"` (`$1..$n`). Pure. */
export function buildDetachWrapperArgv(legArgv: readonly string[]): string[] {
  return ["sh", "-c", DETACH_SCRIPT, "--", ...legArgv];
}

// ---------------------------------------------------------------------------
// Atomic same-dir write
// ---------------------------------------------------------------------------

/** Write `content` to `target` via a temp file in the SAME dir, then rename —
 *  EXDEV-safe on macOS (never crosses the `os.tmpdir()` volume boundary). */
function writeFileAtomic(dir: string, target: string, content: string): void {
  const tmp = join(
    dir,
    `.keeper-panel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Terminality (in wait) — log-line authoritative, pid the crash backstop only
// ---------------------------------------------------------------------------

/** Scan a leg's `.log` for the wrapper's OWN terminal signal. Content-blind:
 *  reads only `[keeper-pair] completed`/`failed` event lines and a `pair: …`
 *  arg-fault stderr line (exit-2 before any event line) — never panelist
 *  content. Returns whether the leg is terminal, whether it failed, and the
 *  captured fail reason. */
function scanLogTerminal(logPath: string): {
  terminal: boolean;
  failed: boolean;
  reason: string | null;
} {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return { terminal: false, failed: false, reason: null };
  }
  let failedLine: string | undefined;
  let completedLine: string | undefined;
  let argFaultLine: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[keeper-pair] failed")) {
      failedLine = line;
    } else if (line.startsWith("[keeper-pair] completed")) {
      completedLine = line;
    } else if (line.startsWith("pair:") && argFaultLine === undefined) {
      argFaultLine = line;
    }
  }
  if (failedLine !== undefined) {
    const idx = failedLine.indexOf("error=");
    const fromEvent =
      idx >= 0 ? failedLine.slice(idx + "error=".length).trim() : "";
    const reason = fromEvent !== "" ? fromEvent : (argFaultLine ?? failedLine);
    return { terminal: true, failed: true, reason };
  }
  if (completedLine !== undefined) {
    // `completed` is emitted only AFTER the atomic `--output` rename, so a
    // `completed` log with no `.yaml` (step 1 already missed) is contradictory —
    // surface it as a fail rather than a silent success.
    return {
      terminal: true,
      failed: true,
      reason: "leg reported completed but produced no output file",
    };
  }
  if (argFaultLine !== undefined) {
    // An arg fault (exit 2) prints `pair: …` and exits before any event line.
    return { terminal: true, failed: true, reason: argFaultLine };
  }
  return { terminal: false, failed: false, reason: null };
}

/** Read + parse a pidfile to a positive int, or null when missing/unparseable. */
function readPid(pidfile: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** One member's status, precedence: `.yaml` exists → ok; else `.log` terminal
 *  line → success/fail; else pidfile-dead-past-grace → crash fail; else
 *  running. The pid is the crash backstop ONLY. */
function evaluateLeg(
  member: PanelManifestMember,
  deps: PanelDeps,
  waitStartMs: number,
): {
  status: "ok" | "fail" | "running";
  yaml: string | null;
  reason: string | null;
} {
  if (existsSync(member.yaml)) {
    return { status: "ok", yaml: member.yaml, reason: null };
  }
  const log = scanLogTerminal(member.log);
  if (log.terminal) {
    return { status: "fail", yaml: null, reason: log.reason };
  }
  // A null pidfile means `start`'s spawn threw — the leg never launched.
  if (member.pidfile === null) {
    return {
      status: "fail",
      yaml: null,
      reason: "leg failed to launch (no process spawned)",
    };
  }
  const pid = readPid(member.pidfile);
  if (pid !== null && !deps.pidAlive(pid)) {
    const graceMs = deps.graceMs ?? PID_STARTUP_GRACE_MS;
    if (deps.now() - waitStartMs >= graceMs) {
      return {
        status: "fail",
        yaml: null,
        reason: `leg process ${pid} exited before producing output (no [keeper-pair] terminal line)`,
      };
    }
  }
  return { status: "running", yaml: null, reason: null };
}

/** Build the verdict from per-member evaluations (called once all terminal). */
function buildVerdict(
  dir: string,
  members: PanelManifestMember[],
  evals: ReturnType<typeof evaluateLeg>[],
): PanelVerdict {
  const out: PanelVerdictMember[] = members.map((m, i) => {
    const e = evals[i] as ReturnType<typeof evaluateLeg>;
    return {
      name: m.name,
      harness: m.harness,
      status: e.status === "ok" ? "ok" : "fail",
      yaml: e.yaml,
      reason: e.reason,
    };
  });
  return { dir, ok: out.every((m) => m.status === "ok"), members: out };
}

// ---------------------------------------------------------------------------
// Manifest parse
// ---------------------------------------------------------------------------

/** Validate a parsed manifest object's shape. Pure. */
export function parseManifest(
  raw: unknown,
): { ok: true; manifest: PanelManifest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.dir !== "string" || obj.dir === "") {
    return { ok: false, error: "manifest.dir missing or not a string" };
  }
  if (!Array.isArray(obj.members)) {
    return { ok: false, error: "manifest.members missing or not an array" };
  }
  const members: PanelManifestMember[] = [];
  for (const m of obj.members) {
    if (m === null || typeof m !== "object") {
      return { ok: false, error: "manifest member is not an object" };
    }
    const mm = m as Record<string, unknown>;
    if (
      typeof mm.name !== "string" ||
      typeof mm.harness !== "string" ||
      typeof mm.yaml !== "string" ||
      typeof mm.log !== "string" ||
      !(mm.pidfile === null || typeof mm.pidfile === "string")
    ) {
      return { ok: false, error: "manifest member has malformed fields" };
    }
    members.push({
      name: mm.name,
      harness: mm.harness,
      yaml: mm.yaml,
      log: mm.log,
      pidfile: mm.pidfile,
    });
  }
  return { ok: true, manifest: { dir: obj.dir, members } };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

/** Inputs to {@link panelStart}. */
export interface PanelStartArgs {
  promptFile: string;
  panel: string;
  dir?: string;
  timeoutSeconds: number;
}

/**
 * `start`: resolve members → mint/use a scratch dir → copy the prompt in →
 * launch every leg DETACHED → persist + print the manifest → exit 0. Launch-all-
 * then-persist: a per-leg spawn failure is recorded with a null pidfile (so it
 * surfaces as an N-of-N fail in `wait`), and the manifest is written once.
 * Returns the process exit code (0 on success, 2 on an arg/config fault).
 */
export async function panelStart(
  args: PanelStartArgs,
  deps: PanelDeps,
): Promise<number> {
  let registry: PresetRegistry;
  try {
    registry = deps.loadRegistry();
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : String(err);
    deps.writeErr(`pair panel start: ${msg}\n`);
    return 2;
  }

  const resolved = resolvePanelMembers(registry, args.panel);
  if (!resolved.ok) {
    deps.writeErr(`pair panel start: ${resolved.error}\n`);
    return 2;
  }

  let promptText: string;
  try {
    promptText = readFileSync(args.promptFile, "utf8");
  } catch (err) {
    deps.writeErr(
      `pair panel start: cannot read prompt file '${args.promptFile}': ${(err as Error).message}\n`,
    );
    return 2;
  }

  // Mint a scratch dir on a real volume (or use the caller's), then keep every
  // sentinel + output inside it so the legs' same-dir `--output` renames stay
  // EXDEV-safe.
  let dir: string;
  if (args.dir !== undefined && args.dir !== "") {
    dir = args.dir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      deps.writeErr(
        `pair panel start: cannot create --dir '${dir}': ${(err as Error).message}\n`,
      );
      return 2;
    }
  } else {
    dir = mkdtempSync(join(tmpdir(), "keeper-panel-"));
  }

  const promptPath = join(dir, "prompt.md");
  writeFileAtomic(dir, promptPath, promptText);

  const manifestMembers: PanelManifestMember[] = [];
  for (const member of resolved.members) {
    const yamlPath = join(dir, `${member.name}.yaml`);
    const logPath = join(dir, `${member.name}.log`);
    const pidfilePath = join(dir, `${member.name}.pidfile`);
    const legArgv = buildPanelLegArgv({
      keeperBin: deps.keeperBin,
      keeperAgentPath: deps.keeperAgentPath,
      promptPath,
      member,
      yamlPath,
      timeoutSeconds: args.timeoutSeconds,
    });
    let launched = true;
    try {
      deps.spawn(buildDetachWrapperArgv(legArgv), {
        env: { ...deps.env, LOG: logPath, PIDFILE: pidfilePath },
        cwd: deps.cwd,
      });
    } catch {
      launched = false;
    }
    manifestMembers.push({
      name: member.name,
      harness: member.harness,
      yaml: yamlPath,
      log: logPath,
      pidfile: launched ? pidfilePath : null,
    });
  }

  const manifest: PanelManifest = { dir, members: manifestMembers };
  writeFileAtomic(
    dir,
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  deps.write(`${JSON.stringify(manifest)}\n`);
  return 0;
}

/** Inputs to {@link panelWait}. */
export interface PanelWaitArgs {
  dir: string;
  chunkSeconds: number;
}

/**
 * `wait`: re-read the manifest and block ONE chunk polling every leg's
 * terminality on a `Date.now()` deadline (no busy loop — a `sleep` interval).
 * All legs terminal → print the verdict JSON, exit 0. Chunk elapsed → exit 124
 * (re-issuable). Missing/corrupt manifest or bad flags → exit 2. Stateless
 * across re-issues. Returns the process exit code.
 */
export async function panelWait(
  args: PanelWaitArgs,
  deps: PanelDeps,
): Promise<number> {
  if (!Number.isFinite(args.chunkSeconds) || args.chunkSeconds <= 0) {
    deps.writeErr(
      `pair panel wait: --chunk must be a positive number (got ${args.chunkSeconds})\n`,
    );
    return 2;
  }
  if (args.chunkSeconds > MAX_CHUNK_SECONDS) {
    deps.writeErr(
      `pair panel wait: --chunk ${args.chunkSeconds} exceeds the ${MAX_CHUNK_SECONDS}s ceiling (a wait is one Bash call, capped at 600s)\n`,
    );
    return 2;
  }

  const manifestPath = join(args.dir, "manifest.json");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    deps.writeErr(
      `pair panel wait: cannot read manifest at ${manifestPath}: ${(err as Error).message}\n`,
    );
    return 2;
  }
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) {
    deps.writeErr(`pair panel wait: corrupt manifest: ${parsed.error}\n`);
    return 2;
  }
  const { dir, members } = parsed.manifest;

  const chunkMs = args.chunkSeconds * 1000;
  const waitStartMs = deps.now();
  const deadline = waitStartMs + chunkMs;
  const pollMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

  for (;;) {
    const evals = members.map((m) => evaluateLeg(m, deps, waitStartMs));
    if (evals.every((e) => e.status !== "running")) {
      deps.write(`${JSON.stringify(buildVerdict(dir, members, evals))}\n`);
      return 0;
    }
    if (deps.now() >= deadline) {
      return 124;
    }
    await deps.sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// CLI entry (production deps)
// ---------------------------------------------------------------------------

/** `process.kill(pid, 0)` liveness — alive iff it resolves or EPERM; ESRCH ⇒
 *  gone. Inlined (mirrors daemon.ts `pidAlive`) so this leaf never imports the
 *  bun:sqlite DB graph. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Build the production deps: real spawn (detached + unref'd), wall clock,
 *  `Bun.sleep`, the pid probe, the real registry loader, and the resolved
 *  launcher transport. */
export function buildPanelDeps(): PanelDeps {
  return {
    keeperBin: process.execPath,
    keeperAgentPath: resolvePairKeeperAgentPath(),
    env: process.env as Record<string, string | undefined>,
    cwd: process.cwd(),
    loadRegistry: () => loadPresetRegistry(),
    spawn: (argv, opts) => {
      const proc = Bun.spawn(argv, {
        env: opts.env,
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      proc.unref();
    },
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    pidAlive,
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  };
}

export const PANEL_HELP = `keeper pair panel — cross-OS panel fan-out (start | wait)

Usage:
  keeper pair panel start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]
  keeper pair panel wait --dir <d> [--chunk <s>]

start  resolves the panel members (registry panel, single preset, or the legacy
       opus+codex fallback), launches each as a DETACHED read-only \`keeper pair
       send\` leg in the 'panels' session, writes <dir>/manifest.json, prints it,
       and exits 0 immediately. Prints {dir, members:[{name,harness,yaml,log,pidfile}]}.
wait   re-reads the manifest and blocks ONE --chunk window polling each leg.
       Exit 0 + verdict JSON {dir, ok, members:[{name,harness,status,yaml,reason}]}
       when all legs are terminal; exit 124 when the chunk elapses (re-issue it);
       exit 2 on a missing/corrupt manifest or bad flags. Exit 0 means ALL-TERMINAL,
       not all-success — key off the verdict's 'ok' flag.

Options:
  --panel <name>    Panel/preset name (default: ${DEFAULT_PANEL_NAME})
  --dir <d>         Scratch dir (start: minted when absent; wait: required)
  --timeout <s>     Per-leg keeper pair send timeout (default: ${DEFAULT_PANEL_TIMEOUT_SECONDS})
  --chunk <s>       wait window in seconds (default: ${DEFAULT_PANEL_CHUNK_SECONDS}, max ${MAX_CHUNK_SECONDS})
  --help, -h        Show this help
`;

/**
 * Route `keeper pair panel <start|wait> …`. Parses flags, builds the production
 * deps, dispatches to {@link panelStart}/{@link panelWait}, and exits with their
 * code. Never returns (always exits).
 */
export async function runPanel(argv: string[]): Promise<void> {
  const op = argv[0];
  if (op === "--help" || op === "-h" || op === undefined) {
    process.stdout.write(PANEL_HELP);
    process.exit(op === undefined ? 2 : 0);
  }
  if (op !== "start" && op !== "wait") {
    process.stderr.write(
      `pair panel: unknown operation '${op}' (expected 'start' or 'wait')\n`,
    );
    process.exit(2);
  }

  const deps = buildPanelDeps();

  if (op === "start") {
    const parsed = parseArgs({
      args: argv.slice(1),
      options: {
        panel: { type: "string" },
        dir: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    if (parsed.values.help) {
      process.stdout.write(PANEL_HELP);
      process.exit(0);
    }
    const promptFile = parsed.positionals[0];
    if (promptFile === undefined) {
      process.stderr.write(
        "pair panel start: missing <prompt-file> positional\n",
      );
      process.exit(2);
    }
    const timeoutSeconds =
      parsed.values.timeout !== undefined
        ? Number(parsed.values.timeout)
        : DEFAULT_PANEL_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      process.stderr.write(
        `pair panel start: --timeout must be a positive number (got ${parsed.values.timeout})\n`,
      );
      process.exit(2);
    }
    const code = await panelStart(
      {
        promptFile,
        panel: parsed.values.panel ?? DEFAULT_PANEL_NAME,
        dir: parsed.values.dir,
        timeoutSeconds,
      },
      deps,
    );
    process.exit(code);
  }

  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      dir: { type: "string" },
      chunk: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (parsed.values.help) {
    process.stdout.write(PANEL_HELP);
    process.exit(0);
  }
  const dir = parsed.values.dir;
  if (dir === undefined || dir === "") {
    process.stderr.write("pair panel wait: --dir <d> is required\n");
    process.exit(2);
  }
  const chunkSeconds =
    parsed.values.chunk !== undefined
      ? Number(parsed.values.chunk)
      : DEFAULT_PANEL_CHUNK_SECONDS;
  const code = await panelWait({ dir, chunkSeconds }, deps);
  process.exit(code);
}
