/**
 * `keeper agent panel start|wait|status|prune` — the cross-OS panel fan-out orchestrator the
 * `plan:panel-runner` agent drives instead of hand-rolling `setsid`/`timeout` in
 * shell (neither exists on stock macOS). All the OS-specific machinery lives here
 * in TS: detachment via a `nohup` double-fork POSIX-shell wrapper (NOT
 * `setsid`/`timeout`/`gtimeout`), a `Date.now()`-deadline poll loop (NOT a shell
 * `timeout`), and atomic same-dir temp-then-rename result files (EXDEV-safe on
 * macOS, where `os.tmpdir()` is a different APFS volume).
 *
 *   - `start <prompt-file> --slug <slug> [--panel <name>] [--run-dir <d>] [--timeout <s>]`
 *     is idempotent-by-slug: it resolves the members in-process and derives the
 *     run's durable dir from the slug (or the `--run-dir` override), then under a
 *     per-slug advisory lock either fans out fresh (copy the prompt in, launch each
 *     member as a DETACHED `keeper agent run` leg writing its own uniform JSON
 *     result envelope via `--output`, persist `<dir>/manifest.json`) or RECONCILES
 *     an existing run — reusing terminal legs, leaving running legs, relaunching
 *     only no-result legs to a new-generation result path. Prints the manifest and
 *     exits 0; a colliding-slug prompt/member mismatch or lock contention exits 2.
 *   - `wait (--slug <slug> | --run-dir <d>) [--chunk <s>]` re-reads the manifest and
 *     blocks ONE chunk polling each leg's terminality; exit 0 + verdict JSON when
 *     all legs are terminal, exit 124 when the chunk elapses (re-issuable), exit 2
 *     on a missing/corrupt manifest or bad flags. `--slug` resolves the durable
 *     dir; `--run-dir` wins if both are given.
 *   - `status (--slug <slug> | --run-dir <d>)` prints a read-only, non-blocking per-leg
 *     snapshot (completed|running|failed|absent); exit 2 on a missing manifest.
 *   - `prune` GCs abandoned run dirs under the durable panels root — lock-free AND
 *     no live leg pid AND past the started-at TTL, via a TOCTOU-safe rename-to-trash.
 *
 * CONTENT-BLIND: `wait` reads each leg's result file only for its `outcome`
 * (`completed` → ok; every other outcome → fail, `reason=<outcome>`) — NEVER a
 * panelist's `message` content — with the pidfile the sole crash backstop for a
 * leg that dies before producing a file. `exit 0` means all-terminal, NOT
 * all-success: the agent keys off the verdict's `ok` flag.
 *
 * No keeper.db write, no RPC, no third-party deps — `node:*` plus the dep-free
 * `src/agent/config` + `src/agent/launch-config` + `src/keeper-agent-path` +
 * `src/keeper-state-dir` + `src/usage-flock` (the per-slug advisory lock) leaves
 * only.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  loadPanelSelections,
  loadPresetCatalog,
  type PanelSelections,
  type Preset,
  type PresetCatalog,
  resolvePreset,
} from "../agent/config";
import {
  AGENT_CLIS,
  type AgentCli,
  loadRolePrompt,
} from "../agent/launch-config";
import { resolveKeeperAgentPathDepFree } from "../keeper-agent-path";
import { keeperStateDir } from "../keeper-state-dir";
import { slugify } from "../slug";
import { FileLock } from "../usage-flock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-leg `keeper agent run` stop-timeout default (seconds; translated to
 *  a `--stop-timeout` ms duration at launch). */
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
/** Boot-epoch reboot tolerance (ms). Two same-boot `deps.now() - uptime()*1000`
 *  reads agree within clock jitter (seconds); a reboot resets uptime, so the
 *  derived boot-epoch jumps forward by the whole downtime + prior uptime (many
 *  minutes at minimum). A generous minutes-wide band cleanly separates the two: a
 *  mismatch beyond it means the machine rebooted, so a non-terminal leg's recorded
 *  pid is a dead pre-reboot process and MUST be relaunched. */
const BOOT_EPOCH_TOLERANCE_MS = 5 * 60_000;
/** The tmux session every leg lands in (matches the panel-runner). */
const PANEL_SESSION = "panels";
/** Age past which a terminal, lock-free, pid-dead panel run dir is `panel prune`-
 *  eligible (mirrors statusline `LEAF_TTL_MS` — a run untouched this long is
 *  abandoned). Measured off the run's write-once `started-at` sentinel mtime, NOT
 *  the dir mtime (a leg's result write bumps that). */
export const PANEL_PRUNE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** The run-birth sentinel basename — written once at fresh start, never on a
 *  reconcile, so its mtime anchors `panel prune`'s age check to the run's original
 *  start instant. */
const STARTED_AT_SENTINEL = "started-at";
/** The `panel prune` trash subdir under the panels root: an eligible run dir is
 *  renamed here (a same-parent, EXDEV-safe atomic move) before its recursive
 *  removal, so a lock-free reader never observes a half-deleted dir. */
const PANEL_TRASH_DIR = ".gc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved panel member. `harness` is always the `agent run <cli>` positional;
 *  `preset` set → the leg also carries `--preset <preset>`. `name` is the leg
 *  label and the basename of its result file + pidfile.
 *
 *  The ad-hoc (panel-of-one) fields are absent for a configured panel member, so
 *  a configured member's leg argv stays byte-identical: `model`/`effort` layer a
 *  `--model`/`--effort` override onto the leg, `system` rides as `--system <text>`
 *  (a resolved `--role` prompt), and `readOnly` (default true) toggles the
 *  `--read-only` directive — a configured member always defaults to read-only. */
export interface PanelMember {
  name: string;
  harness: AgentCli;
  preset?: string;
  model?: string;
  effort?: string;
  system?: string;
  readOnly?: boolean;
}

/** One member's persisted launch record in the manifest. `yaml` is the leg's
 *  `--output` result-file path (a `keeper agent run` JSON envelope). `pidfile` is
 *  null when the leg's spawn threw at launch (it never started → a normal N-of-N
 *  fail). `startfile` is the sibling path the detach wrapper writes the leg's OS
 *  start-time to (`ps -o lstart=`), read back on every liveness check to reject a
 *  recycled pid; null on a spawn throw, and absent on a pre-durable manifest (→ the
 *  identity check degrades to bare pid liveness). `launched_at` is the `deps.now()`
 *  ms stamp taken right after a successful spawn (null in the pre-spawn skeleton and
 *  for a spawn-throw leg), so a crash mid-fan-out is reconstructable by a resuming
 *  driver. Optional so a pre-durable-format manifest still parses. */
export interface PanelManifestMember {
  name: string;
  harness: string;
  yaml: string;
  pidfile: string | null;
  startfile?: string | null;
  launched_at?: number | null;
}

/** The `start`-persisted, `wait`-re-read manifest. `slug` is the run's
 *  agent-authored identifier (each leg launches as `panel::<slug>::<preset>`),
 *  persisted top-level for run correlation. `boot_epoch_ms` is the machine's
 *  sleep-proof boot instant (`deps.bootEpochMs`, kernel-derived — see that seam);
 *  a resuming `start`/`wait` compares it against the current boot to detect a
 *  reboot (pre-reboot pidfiles are never trusted). `generation` counts (re)launch
 *  rounds — the skeleton is
 *  generation 1; a future reconcile bumps it. Both optional so a pre-durable
 *  manifest still parses. */
export interface PanelManifest {
  dir: string;
  slug: string;
  boot_epoch_ms?: number;
  generation?: number;
  members: PanelManifestMember[];
}

/** One member's verdict line. `status:"ok"` ⇒ `yaml` (the result-file path) set,
 *  `reason` null; `status:"fail"` ⇒ `yaml` null, `reason` the failing `outcome`
 *  (or a crash / corrupt-result note). */
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

/** One member's line in the read-only `status` snapshot. Four-way (unlike the
 *  verdict's binary ok/fail): `completed` (a result file with outcome
 *  `completed`), `running` (a live pid, or one launched within the startup
 *  grace), `failed` (a bad-outcome/corrupt result, a spawn-throw leg, or a dead
 *  pid past the grace), `absent` (no result and no attributable pid — never
 *  launched, or launched but left no trace). `yaml` is set only when completed. */
export interface PanelStatusMember {
  name: string;
  harness: string;
  status: "completed" | "running" | "failed" | "absent";
  yaml: string | null;
  reason: string | null;
}

/** The `status` snapshot — a single-pass, non-blocking, non-mutating per-leg
 *  classification distinct from {@link PanelVerdict}. `all_terminal` is true iff no
 *  member is still `running` (the terminal set is completed/failed/absent). */
export interface PanelStatus {
  dir: string;
  slug: string;
  generation: number;
  all_terminal: boolean;
  members: PanelStatusMember[];
}

/** The `prune` result — which slug dirs were reclaimed vs kept, and the panels
 *  root scanned. */
export interface PanelPruneResult {
  root: string;
  pruned: string[];
  kept: string[];
}

/** A detached, fire-and-forget leg spawn (Bun.spawn-shaped subset; injectable
 *  for tests). The wrapper redirects the leg's std streams + writes its pidfile,
 *  so this returns nothing — the caller never waits on it. */
export type PanelSpawnFn = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; cwd: string },
) => void;

/** A held advisory lock (FileLock-shaped): the driver releases it once its
 *  reconcile + fan-out critical section completes. */
export interface PanelLockHandle {
  release(): void;
}

/** The launch-config a panel op needs: the catalog (member harnesses) plus the
 *  panel selections (the panel definitions + the default panel). Both files are
 *  required for any panel op, so they load together. */
export interface PanelConfig {
  catalog: PresetCatalog;
  selections: PanelSelections;
}

/** Injectable seams (exec-backend house style): spawn / clock / sleep / pid
 *  probe / config loader / output streams, plus the resolved launcher path. */
export interface PanelDeps {
  keeperBin: string;
  keeperAgentPath: string;
  env: Record<string, string | undefined>;
  cwd: string;
  loadRegistry: () => PanelConfig;
  spawn: PanelSpawnFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pidAlive: (pid: number) => boolean;
  /** Live OS start-time probe for a pid (the recycle-guard's identity side),
   *  paired against the wrapper-captured `startfile`. Absent → the production
   *  `ps -o lstart=` reader ({@link readPanelStartTime}); tests inject a fake so
   *  the fast tier never forks `ps`. Returns null when it can't tell (dead pid,
   *  `ps` error) → the caller fails OPEN (trusts bare pid liveness). */
  readStartTime?: (pid: number) => string | null;
  /** Per-slug advisory-lock acquire (non-blocking). Returns a releasable handle,
   *  or null on contention (another driver holds the slug). Absent ⇒ treated as
   *  always-acquired (injected-deps tests that do not exercise contention).
   *  Production wraps {@link FileLock.tryAcquire} (flock/CLOEXEC so a detached leg
   *  never inherits the lock). */
  lock?: (lockPath: string) => PanelLockHandle | null;
  write: (s: string) => void;
  writeErr: (s: string) => void;
  /** Boot-epoch source (ms). Production wires the SLEEP-PROOF kernel reader
   *  ({@link readBootEpochMs}: darwin `kern.boottime` / linux `/proc/stat btime`,
   *  which — unlike `os.uptime()` on macOS Sonoma+ — does not drift across sleep),
   *  so `start` and `wait` compare the SAME stable boot instant across a mid-run
   *  sleep. Absent → the in-process `now() - os.uptime()*1000` fallback (fork-free
   *  for injected-deps tests, which instead pass a fixed epoch to make a reboot
   *  mismatch deterministic). */
  bootEpochMs?: () => number;
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
// Member resolution (mirrors src/agent/main.ts runPresetsResolve)
// ---------------------------------------------------------------------------

/**
 * Resolve a panel name to its members against the catalog + panel selections.
 * Precedence: a PANEL hit → its members (each named by its preset); else a
 * single catalog PRESET hit → a one-member panel; else an unknown name → fail
 * loud (the caller exits 2 — there is no zero-config fallback). A member pinning
 * a harness outside claude|codex|pi fails loud. Pure.
 */
export function resolvePanelMembers(
  catalog: PresetCatalog,
  selections: PanelSelections,
  name: string,
): ResolveMembersResult {
  const panelMembers = selections.panels[name];
  if (panelMembers !== undefined) {
    const members: PanelMember[] = [];
    for (const memberName of panelMembers) {
      const preset = catalog.presets[memberName];
      if (preset === undefined) {
        return {
          ok: false,
          error: `panel '${name}' references undefined preset '${memberName}'`,
        };
      }
      if (!AGENT_CLIS.has(preset.harness)) {
        return {
          ok: false,
          error: `panel '${name}' member '${memberName}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex|pi only)`,
        };
      }
      members.push({
        name: memberName,
        harness: preset.harness as AgentCli,
        preset: memberName,
      });
    }
    if (members.length === 0) {
      return { ok: false, error: `panel '${name}' resolved to zero members` };
    }
    return { ok: true, members };
  }

  const preset = catalog.presets[name];
  if (preset !== undefined) {
    if (!AGENT_CLIS.has(preset.harness)) {
      return {
        ok: false,
        error: `preset '${name}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex|pi only)`,
      };
    }
    return {
      ok: true,
      members: [{ name, harness: preset.harness as AgentCli, preset: name }],
    };
  }

  return { ok: false, error: `'${name}' is not a known panel or preset` };
}

/** The ad-hoc single-member selector (pairing = a panel of one). Exactly ONE of
 *  `preset`/`cli` names the member; `model`/`effort`/`system`/`readOnly` layer the
 *  per-member posture onto its leg. `system` is the ALREADY-resolved `--role`
 *  prompt text (the CLI loads it before resolution — this stays pure). */
export interface AdHocMemberSpec {
  preset?: string;
  cli?: string;
  model?: string;
  effort?: string;
  system?: string;
  readOnly: boolean;
}

/**
 * Resolve an ad-hoc selector to a SINGLE {@link PanelMember} — a panel-of-one
 * that drives one member through the shared panel leg path. `--preset <name>`
 * resolves its harness (+ model/effort launcher-side via the leg's `--preset`);
 * `--cli <x>` is a bare harness with the explicit `--model`/`--effort` overrides.
 * `--effort` is codex-only. A harness outside claude|codex|pi, an unknown
 * preset, or effort on a non-codex member fails loud (the caller exits 2). Pure —
 * the resulting member converges on the SAME manifest + leg path a configured
 * panel produces.
 */
export function resolveAdHocMember(
  catalog: PresetCatalog,
  spec: AdHocMemberSpec,
): ResolveMembersResult {
  let harness: AgentCli;
  let name: string;
  let preset: string | undefined;

  const hasPreset = spec.preset !== undefined && spec.preset !== "";
  const hasCli = spec.cli !== undefined && spec.cli !== "";
  if (hasPreset && hasCli) {
    return {
      ok: false,
      error:
        "--preset and --cli are mutually exclusive (pick one ad-hoc member)",
    };
  }
  if (hasPreset) {
    let resolved: Preset;
    try {
      resolved = resolvePreset(catalog, spec.preset as string);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof ConfigError ? err.message : String(err),
      };
    }
    if (!AGENT_CLIS.has(resolved.harness)) {
      return {
        ok: false,
        error: `preset '${spec.preset}' pins harness ${resolved.harness}, which is not pair-launchable (claude|codex|pi only)`,
      };
    }
    harness = resolved.harness as AgentCli;
    name = spec.preset as string;
    preset = spec.preset as string;
  } else if (hasCli) {
    if (!AGENT_CLIS.has(spec.cli as string)) {
      return {
        ok: false,
        error: `--cli must be claude|codex|pi (got ${spec.cli})`,
      };
    }
    harness = spec.cli as AgentCli;
    name = spec.cli as string;
  } else {
    return {
      ok: false,
      error:
        "an ad-hoc member requires --preset <name> or --cli <claude|codex|pi>",
    };
  }

  if (spec.effort !== undefined && spec.effort !== "" && harness !== "codex") {
    return { ok: false, error: "--effort is only supported for codex" };
  }

  return {
    ok: true,
    members: [
      {
        name,
        harness,
        preset,
        model: spec.model || undefined,
        effort: spec.effort || undefined,
        system: spec.system || undefined,
        readOnly: spec.readOnly,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Leg argv + detachment wrapper (pure)
// ---------------------------------------------------------------------------

/**
 * Build one leg's `keeper agent run` argv:
 *   `<bun> <keeper.ts> agent run <harness> <prompt> [--preset <m>]
 *     [--system <text>] [--model <m>] [--effort <e>] [--read-only]
 *     --session panels --output <dir>/<m>.yaml --stop-timeout <dur>`.
 * The `[<bun>, <keeper.ts>]` prefix is the self-re-exec transport (daemon.ts
 * precedent); `<harness>` is the `agent run <cli>` positional and `<prompt>` the
 * task text passed inline (agent run takes the prompt literally, not a file);
 * `--preset` layers model/effort when the member carries one. The ad-hoc
 * (panel-of-one) posture layers `--system <text>` (a resolved `--role` prompt)
 * and explicit `--model`/`--effort` overrides; a configured member sets none of
 * these, so its argv stays byte-identical. `--read-only` keeps a panelist a
 * non-mutating explorer (default ON — a configured member omits `readOnly`), and
 * `--output` makes the leg write its own uniform JSON result envelope atomically.
 * An explicit `--name panel::<slug>::<member.name>` labels the leg by which panel
 * run + which preset it is; the explicit `--name` suppresses `agent run`'s auto
 * session-name resolution, so this string is exactly what lands in tmux/forensics.
 * Pure.
 */
export function buildPanelLegArgv(opts: {
  keeperBin: string;
  keeperAgentPath: string;
  prompt: string;
  member: PanelMember;
  slug: string;
  yamlPath: string;
  stopTimeoutMs: number;
}): string[] {
  const m = opts.member;
  const postureFlags: string[] = [];
  if (m.preset !== undefined) {
    postureFlags.push("--preset", m.preset);
  }
  if (m.system !== undefined && m.system !== "") {
    postureFlags.push("--system", m.system);
  }
  if (m.model !== undefined && m.model !== "") {
    postureFlags.push("--model", m.model);
  }
  if (m.effort !== undefined && m.effort !== "") {
    postureFlags.push("--effort", m.effort);
  }
  // A configured member omits `readOnly` (default ON, byte-stable); an ad-hoc
  // member forwards its explicit `--read-only` flag.
  if (m.readOnly ?? true) {
    postureFlags.push("--read-only");
  }
  return [
    opts.keeperBin,
    opts.keeperAgentPath,
    "agent",
    "run",
    m.harness,
    opts.prompt,
    ...postureFlags,
    "--session",
    PANEL_SESSION,
    "--output",
    opts.yamlPath,
    "--stop-timeout",
    `${opts.stopTimeoutMs}ms`,
    "--name",
    `panel::${opts.slug}::${m.name}`,
  ];
}

/**
 * The detachment shell program. A short-lived POSIX shell double-forks the real
 * leg so it reparents to launchd/init the instant `start` exits (raw
 * `Bun.spawn({detached:true}).unref()` is reported to die on macOS parent-exit):
 * `nohup` makes the leg SIGHUP-immune (POSIX on both OSs), `</dev/null` severs
 * stdin so the Bash tool sees EOF, `>"$LOG" 2>&1` captures both streams (NOT
 * `&>>` — `/bin/sh` is bash 3.2 on macOS), `&` backgrounds it, and `echo $!`
 * records the REAL backgrounded pid.
 *
 * It then captures the leg's OS start-time to `$STARTFILE` (temp-then-`mv` so a
 * reader never sees a torn value) as the recycle-guard's identity anchor: `$!`
 * survives the intervening `echo` (only a new `&` job would reset it), so the same
 * backgrounded pid is probed. `ps -o lstart=` uses the AMBIENT locale/TZ — NOT
 * `LC_ALL=C TZ=UTC` — so the stored string byte-matches the same-machine live
 * probe ({@link readPanelStartTime}); forcing UTC would shift the hour and
 * false-flag every leg as recycled. A `ps` failure (the leg already exited) simply
 * leaves `$STARTFILE` absent → the check degrades to bare pid liveness.
 * `$LOG`/`$PIDFILE`/`$STARTFILE` arrive via env. Zero `setsid`/`timeout`/`gtimeout`.
 */
export const DETACH_SCRIPT =
  'nohup "$@" </dev/null >"$LOG" 2>&1 & echo $! > "$PIDFILE"; ps -o lstart= -p $! > "$STARTFILE.tmp" 2>/dev/null && mv -f "$STARTFILE.tmp" "$STARTFILE"';

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
// Terminality (in wait) — result-file authoritative, pid the crash backstop only
// ---------------------------------------------------------------------------

/** Read + parse a leg's `--output` result file to its `outcome`. Content-blind:
 *  pulls ONLY the `outcome` field off the JSON envelope, never the panelist's
 *  `message`. Returns the outcome string, or `"corrupt-result"` when the present
 *  file is missing/unreadable/unparseable/lacks a string `outcome` (never throws
 *  — a partial or malformed present file is a fail, not a crash of `wait`). */
function readResultOutcome(yamlPath: string): string {
  let text: string;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch {
    return "corrupt-result";
  }
  try {
    const parsed = JSON.parse(text) as { outcome?: unknown };
    return typeof parsed.outcome === "string"
      ? parsed.outcome
      : "corrupt-result";
  } catch {
    return "corrupt-result";
  }
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

/** Production live OS start-time probe (the default {@link PanelDeps.readStartTime}).
 *  `ps -o lstart= -p <pid>` in the AMBIENT locale/TZ, so its trimmed output
 *  byte-matches the detach wrapper's same-command capture on the same machine (see
 *  {@link DETACH_SCRIPT}). Platform-uniform (`ps -o lstart=` renders a wall-clock
 *  date on both darwin and linux) — deliberately NOT `seed-sweep.readOsStartTime`,
 *  whose linux jiffies format could never match a wrapper `lstart` capture and
 *  whose import would drag the daemon/`bun:sqlite` graph into this leaf. Returns
 *  null on a `ps` failure, a dead pid (empty output), or a throw → the caller fails
 *  OPEN. Only the production deps call it; the fast tier injects a fake. */
function readPanelStartTime(pid: number): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      timeout: 500,
    });
    if (!r.success || r.exitCode !== 0) {
      return null;
    }
    const out = (r.stdout?.toString() ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Read the wrapper-captured start-time from a leg's `startfile`, trimmed. Null
 *  when the path is absent (pre-durable manifest), the file is missing (the
 *  wrapper's `ps` capture failed), or empty — every null degrades the recycle
 *  check to bare pid liveness (today's behavior), never a false "dead". */
function readStoredStartTime(
  startfile: string | null | undefined,
): string | null {
  if (startfile === null || startfile === undefined) {
    return null;
  }
  try {
    const v = readFileSync(startfile, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The recycle guard: `kill(pid,0)` proves a pid is OCCUPIED, not that the CURRENT
 *  occupant is the leg we launched. Cross-check the wrapper-captured start-time
 *  against a live probe — a match confirms identity, a mismatch means the pid was
 *  recycled to an unrelated process (the leg is dead). Two fail-OPEN degradations
 *  keep a healthy panel from being spuriously killed (a false "dead" fails a live
 *  panel; a false "alive" only extends a bounded wait): a null STORED value (old
 *  manifest / capture failure) trusts bare liveness without probing, and a null
 *  LIVE probe (ps error) trusts bare liveness and RE-probes next entry (never
 *  memoized). A definitive match/mismatch is memoized per (startfile,pid) so a
 *  `wait`'s repeated per-tick probes fork `ps` at most once per leg. */
function legIdentityHolds(
  member: PanelManifestMember,
  pid: number,
  deps: PanelDeps,
  memo?: Map<string, boolean>,
): boolean {
  const stored = readStoredStartTime(member.startfile);
  if (stored === null) {
    return true;
  }
  const key = `${member.startfile}\0${pid}`;
  const cached = memo?.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const probe = (deps.readStartTime ?? readPanelStartTime)(pid);
  if (probe === null) {
    return true; // can't tell → fail open, re-probe next entry (do not memoize)
  }
  const holds = probe.trim() === stored;
  memo?.set(key, holds);
  return holds;
}

/** The shared per-leg filesystem probe both `wait`'s verdict ({@link evaluateLeg})
 *  and `start`'s reconcile ({@link reconcileLeg}) read from: whether the leg's
 *  result file is present and, if not, whether its recorded pid is alive AND still
 *  the SAME process ({@link legIdentityHolds} — a recycled pid reads dead). Never
 *  throws. A present result short-circuits the pid read (a terminal leg's pid is
 *  moot). `memo` (a `wait`-owned per-invocation cache) bounds the `ps` identity
 *  probe to once per leg across the poll loop. */
function probeLeg(
  member: PanelManifestMember,
  deps: PanelDeps,
  memo?: Map<string, boolean>,
): { resultPresent: boolean; pid: number | null; pidAlive: boolean } {
  if (existsSync(member.yaml)) {
    return { resultPresent: true, pid: null, pidAlive: false };
  }
  // A null pidfile means `start`'s spawn threw — the leg never launched.
  if (member.pidfile === null) {
    return { resultPresent: false, pid: null, pidAlive: false };
  }
  const pid = readPid(member.pidfile);
  let alive = pid !== null && deps.pidAlive(pid);
  if (alive && pid !== null) {
    alive = legIdentityHolds(member, pid, deps, memo);
  }
  return { resultPresent: false, pid, pidAlive: alive };
}

/** Sleep-proof boot-epoch (ms): the machine's wall-clock boot instant, the
 *  production {@link PanelDeps.bootEpochMs}. macOS Sonoma+ `os.uptime()` EXCLUDES
 *  time asleep, so `now() - uptime()*1000` drifts FORWARD across every sleep and
 *  would false-trip the reboot guard mid-run; the kernel's absolute boot timestamp
 *  does not. Darwin: `sysctl -n kern.boottime` → `{ sec = N, usec = M }` (the
 *  `\bsec` word boundary skips `usec`). Linux: `/proc/stat` `btime <sec>`. Falls
 *  back to the uptime arithmetic only when the kernel read fails (unknown platform
 *  / probe error) — still same-boot-stable within a single session. Production-only
 *  (forks `sysctl`); the fast tier injects a fixed epoch. */
function readBootEpochMs(now: () => number): number {
  try {
    if (process.platform === "darwin") {
      const r = Bun.spawnSync(["sysctl", "-n", "kern.boottime"], {
        timeout: 500,
      });
      if (r.success && r.exitCode === 0) {
        const m = (r.stdout?.toString() ?? "").match(/\bsec = (\d+)/);
        if (m?.[1] !== undefined) {
          return Number.parseInt(m[1], 10) * 1000;
        }
      }
    } else if (process.platform === "linux") {
      const m = readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m);
      if (m?.[1] !== undefined) {
        return Number.parseInt(m[1], 10) * 1000;
      }
    }
  } catch {
    // fall through to the uptime fallback
  }
  return now() - uptime() * 1000;
}

/** One member's status, precedence: result file present → parse its `outcome`
 *  (`completed` → ok; anything else → fail with `reason=<outcome>`; unparseable →
 *  fail `reason=corrupt-result`); else a null/dead pidfile past grace → crash
 *  fail; else running. The pid is the crash backstop ONLY — a leg that dies
 *  before writing its file. */
function evaluateLeg(
  member: PanelManifestMember,
  deps: PanelDeps,
  waitStartMs: number,
  memo?: Map<string, boolean>,
): {
  status: "ok" | "fail" | "running";
  yaml: string | null;
  reason: string | null;
} {
  const probe = probeLeg(member, deps, memo);
  if (probe.resultPresent) {
    const outcome = readResultOutcome(member.yaml);
    if (outcome === "completed") {
      return { status: "ok", yaml: member.yaml, reason: null };
    }
    return { status: "fail", yaml: null, reason: outcome };
  }
  // A null pidfile means `start`'s spawn threw — the leg never launched.
  if (member.pidfile === null) {
    return {
      status: "fail",
      yaml: null,
      reason: "leg failed to launch (no process spawned)",
    };
  }
  if (probe.pid !== null && !probe.pidAlive) {
    const graceMs = deps.graceMs ?? PID_STARTUP_GRACE_MS;
    if (deps.now() - waitStartMs >= graceMs) {
      return {
        status: "fail",
        yaml: null,
        reason: `leg process ${probe.pid} exited before producing a result file`,
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

/** One member's read-only `status` classification. Same result-file precedence as
 *  {@link evaluateLeg}, but the pid-death grace is anchored on the leg's OWN
 *  `launched_at` (never a caller-supplied wait-start): a read-only call's
 *  `now()`-as-wait-start would never elapse the grace, so a long-dead no-result
 *  leg would report `running` forever. Past that grace a dead pid is `failed`; a
 *  dead pid with no readable pidfile (or no recorded launch) is `absent`. Never
 *  throws, never mutates. */
function classifyLegStatus(
  member: PanelManifestMember,
  deps: PanelDeps,
  opts: { graceMs: number },
): {
  status: PanelStatusMember["status"];
  yaml: string | null;
  reason: string | null;
} {
  const probe = probeLeg(member, deps);
  if (probe.resultPresent) {
    const outcome = readResultOutcome(member.yaml);
    return outcome === "completed"
      ? { status: "completed", yaml: member.yaml, reason: null }
      : { status: "failed", yaml: null, reason: outcome };
  }
  // A null pidfile means `start`'s spawn threw — the leg never launched.
  if (member.pidfile === null) {
    return {
      status: "failed",
      yaml: null,
      reason: "leg failed to launch (no process spawned)",
    };
  }
  if (probe.pidAlive) {
    return { status: "running", yaml: null, reason: null };
  }
  // No result + a dead/unreadable pid. A leg launched within its own grace may not
  // have written its pidfile yet — still count it running; past the grace the dead
  // pid is trustworthy.
  const launchedAt = member.launched_at ?? null;
  if (launchedAt !== null && deps.now() - launchedAt < opts.graceMs) {
    return { status: "running", yaml: null, reason: null };
  }
  if (probe.pid !== null) {
    return {
      status: "failed",
      yaml: null,
      reason: `leg process ${probe.pid} exited before producing a result file`,
    };
  }
  // No result, no readable pid, past the grace (or no launch ever recorded) — the
  // leg is unattributable, neither provably failed nor running.
  return {
    status: "absent",
    yaml: null,
    reason:
      launchedAt === null
        ? "no launch recorded"
        : "launched but left no pidfile or result",
  };
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
  if (typeof obj.slug !== "string" || obj.slug === "") {
    return { ok: false, error: "manifest.slug missing or not a string" };
  }
  // Durable-manifest fields: validated when present (a malformed value is
  // corrupt), tolerated when absent (a pre-durable-format manifest). A missing
  // boot-epoch is preserved as `undefined` (NEVER coerced to 0) so `wait`'s reboot
  // guard can fail OPEN on a pre-durable manifest instead of reading 0 as a
  // reboot; `start` still treats absent as a relaunch via its own `?? 0`.
  if (
    obj.boot_epoch_ms !== undefined &&
    typeof obj.boot_epoch_ms !== "number"
  ) {
    return { ok: false, error: "manifest.boot_epoch_ms is not a number" };
  }
  if (obj.generation !== undefined && typeof obj.generation !== "number") {
    return { ok: false, error: "manifest.generation is not a number" };
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
      !(mm.pidfile === null || typeof mm.pidfile === "string")
    ) {
      return { ok: false, error: "manifest member has malformed fields" };
    }
    if (
      mm.startfile !== undefined &&
      mm.startfile !== null &&
      typeof mm.startfile !== "string"
    ) {
      return { ok: false, error: "manifest member startfile is malformed" };
    }
    if (
      mm.launched_at !== undefined &&
      mm.launched_at !== null &&
      typeof mm.launched_at !== "number"
    ) {
      return { ok: false, error: "manifest member launched_at is malformed" };
    }
    members.push({
      name: mm.name,
      harness: mm.harness,
      yaml: mm.yaml,
      pidfile: mm.pidfile,
      startfile: typeof mm.startfile === "string" ? mm.startfile : null,
      launched_at: typeof mm.launched_at === "number" ? mm.launched_at : null,
    });
  }
  return {
    ok: true,
    manifest: {
      dir: obj.dir,
      slug: obj.slug,
      boot_epoch_ms:
        typeof obj.boot_epoch_ms === "number" ? obj.boot_epoch_ms : undefined,
      generation: typeof obj.generation === "number" ? obj.generation : 1,
      members,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

/** A leg's per-generation file basename. Generation 1 keeps the bare `<name>`
 *  (byte-compatible with a pre-reconcile manifest + the `wait` path); a relaunch
 *  round N≥2 rides `<name>.g<N>` so a still-writing prior-generation leg and its
 *  relaunched successor never collide on a result path — the live winner stays
 *  authoritative, so a presumed-dead leg is never SIGTERM'd. */
function legBaseName(name: string, generation: number): string {
  return generation <= 1 ? name : `${name}.g${generation}`;
}

/** The member-set half of the identity guard: true iff the freshly-resolved
 *  members and the manifest's members are the SAME set (by name+harness).
 *  Order-independent — a reordered panel is the same run — but an added, removed,
 *  or retyped member is a colliding-slug cross-run the caller refuses (exit 2),
 *  since reconcile keys legs by name and a changed set would orphan/add legs. */
function sameMemberSet(
  resolved: PanelMember[],
  manifest: PanelManifestMember[],
): boolean {
  if (resolved.length !== manifest.length) {
    return false;
  }
  // JSON-encode the (name, harness) tuple so no delimiter can collide two
  // distinct members into one key.
  const key = (name: string, harness: string): string =>
    JSON.stringify([name, harness]);
  const have = new Set(manifest.map((m) => key(m.name, m.harness)));
  return resolved.every((m) => have.has(key(m.name, m.harness)));
}

/** One leg's reconcile action when a resuming driver re-issues `start`:
 *   - REUSE — a terminal result file is present (ANY outcome, completed OR failed):
 *     resume is not retry, so keep it.
 *   - RELAUNCH on a boot mismatch (machine rebooted → the recorded pid is a dead
 *     pre-reboot process), OR a same-boot dead/unknown pid past the launch grace.
 *   - LEAVE — same boot + a live pid (the leg is still running), or a leg launched
 *     within the startup grace whose dead-pid reading is not yet trustworthy. */
function reconcileLeg(
  member: PanelManifestMember,
  deps: PanelDeps,
  opts: { bootMismatch: boolean; graceMs: number },
): "reuse" | "leave" | "relaunch" {
  const probe = probeLeg(member, deps);
  if (probe.resultPresent) {
    return "reuse";
  }
  if (opts.bootMismatch) {
    return "relaunch";
  }
  if (probe.pidAlive) {
    return "leave";
  }
  const launchedAt = member.launched_at ?? null;
  if (launchedAt !== null && deps.now() - launchedAt < opts.graceMs) {
    return "leave";
  }
  return "relaunch";
}

/** Inputs to {@link panelStart}. `panel` undefined → the `panel.yaml` default.
 *  `adHoc` set → the panel-of-one path: members resolve from the ad-hoc selector
 *  instead of a configured panel name (`panel` is ignored, mutual exclusion
 *  enforced by the caller). */
export interface PanelStartArgs {
  promptFile: string;
  slug: string;
  panel: string | undefined;
  adHoc?: AdHocMemberSpec;
  dir?: string;
  timeoutSeconds: number;
}

/**
 * `start` — idempotent-by-slug. Resolve members → derive the run's durable dir
 * (the deterministic slug-keyed `~/.local/state/keeper/panels/<slug>/`, or the
 * `--run-dir` location override) → mkdir 0700 → acquire the per-slug advisory lock
 * (non-blocking; contention fails fast exit 2, never blocks the caller's single
 * Bash call). With the lock held, either FRESH-START (no prior manifest: copy the
 * prompt in, write the SKELETON — members + boot-epoch + generation 1 — BEFORE the
 * spawn loop, launch every leg DETACHED) or RECONCILE an existing run: an identity
 * guard (byte-exact prompt + same member set, else exit 2) refuses a colliding-slug
 * merge, then per leg REUSE a terminal result (ANY outcome — resume is not retry),
 * LEAVE a running leg, or RELAUNCH a no-result / rebooted leg to a new-generation
 * result path. Re-stamp the boot-epoch + bump the generation whenever a leg
 * relaunches; each manifest write is atomic (temp-then-rename) so lock-free readers
 * never see a torn file. Print the manifest, exit 0. Returns the process exit code
 * (0 on success, 2 on a fault). Every entry's `launched_at` is stamped post-spawn;
 * a spawn throw records a null pidfile (the N-of-N launch-failed signal `wait`
 * reads).
 */
export async function panelStart(
  args: PanelStartArgs,
  deps: PanelDeps,
): Promise<number> {
  let config: PanelConfig;
  try {
    config = deps.loadRegistry();
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : String(err);
    deps.writeErr(`pair panel start: ${msg}\n`);
    return 2;
  }

  // Members come from an ad-hoc selector (the panel-of-one) OR a configured panel
  // name; both converge on the same 1..N-entry manifest + detached-leg path.
  let resolved: ResolveMembersResult;
  if (args.adHoc !== undefined) {
    resolved = resolveAdHocMember(config.catalog, args.adHoc);
  } else {
    // `--panel` absent → the panel.yaml `default`; neither present is fail-loud.
    const panelName = args.panel ?? config.selections.default;
    if (panelName === null || panelName === "") {
      deps.writeErr(
        "pair panel start: no --panel given and no default panel set in panel.yaml\n",
      );
      return 2;
    }
    resolved = resolvePanelMembers(
      config.catalog,
      config.selections,
      panelName,
    );
  }
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

  // Derive the run's dir. `--run-dir` is a location override; without it the run
  // lives at the deterministic, slug-keyed durable path (0700) so a restarted driver
  // rediscovers it from the slug alone. Either way every sentinel + output stays
  // inside it, keeping the legs' same-dir `--output` renames EXDEV-safe.
  const dir =
    args.dir !== undefined && args.dir !== ""
      ? args.dir
      : join(keeperStateDir(), "panels", args.slug);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    deps.writeErr(
      `pair panel start: cannot create panel dir '${dir}': ${(err as Error).message}\n`,
    );
    return 2;
  }

  // A per-slug advisory lock serializes concurrent DRIVERS (never the detached
  // legs — flock/CLOEXEC keeps the fd out of every child). Non-blocking: contention
  // fails fast (a blocking acquire would wedge the caller's single Bash call). An
  // absent seam ⇒ always-acquired (injected-deps tests that skip contention).
  const lockPath = join(dir, ".lock");
  const lock =
    deps.lock !== undefined ? deps.lock(lockPath) : { release: (): void => {} };
  if (lock === null) {
    deps.writeErr(
      `pair panel start: slug '${args.slug}' is locked by another driver (${lockPath}) — a resume is already in progress\n`,
    );
    return 2;
  }

  try {
    const manifestPath = join(dir, "manifest.json");
    // The machine's boot instant, stamped into the manifest so a resuming `start`/
    // `wait` detects a reboot. Production wires the sleep-proof `deps.bootEpochMs`
    // (kernel-derived); the inline `now() - uptime()*1000` is the fork-free fallback
    // for injected-deps tests (which instead pass a fixed epoch). `start` and `wait`
    // MUST derive through the SAME seam or a sleep would look like a reboot.
    const currentBootEpochMs =
      deps.bootEpochMs !== undefined
        ? deps.bootEpochMs()
        : deps.now() - uptime() * 1000;
    // The panel's `--timeout <s>` is the per-leg stop budget; agent run wants ms.
    const stopTimeoutMs = args.timeoutSeconds * 1000;
    const graceMs = deps.graceMs ?? PID_STARTUP_GRACE_MS;

    let manifest: PanelManifest;
    // The legs to (re)launch this call — every member on a fresh start, only the
    // relaunched ones on a reconcile.
    const launchTasks: {
      member: PanelMember;
      entry: PanelManifestMember;
      logPath: string;
    }[] = [];

    if (!existsSync(manifestPath)) {
      // FRESH START — no prior run for this slug. A human-readable copy of the
      // prompt (the leg receives the text inline; agent run takes a positional, not
      // a file), then the skeleton (member set + boot-epoch + generation 1)
      // persisted BEFORE the spawn loop so a crash mid-fan-out leaves a
      // reconstructable manifest a resuming driver can reconcile against.
      writeFileAtomic(dir, join(dir, "prompt.md"), promptText);
      // The run-birth sentinel: its mtime anchors `panel prune`'s age check (never
      // the dir mtime, which a leg's result write bumps). Written ONLY here on a
      // fresh start — a reconcile never rewrites it, so it stays the run's original
      // start instant even across relaunch generations.
      writeFileAtomic(dir, join(dir, STARTED_AT_SENTINEL), `${deps.now()}\n`);
      manifest = {
        dir,
        slug: args.slug,
        boot_epoch_ms: currentBootEpochMs,
        generation: 1,
        members: resolved.members.map((member) => ({
          name: member.name,
          harness: member.harness,
          yaml: join(dir, `${legBaseName(member.name, 1)}.yaml`),
          pidfile: join(dir, `${legBaseName(member.name, 1)}.pidfile`),
          startfile: join(dir, `${legBaseName(member.name, 1)}.starttime`),
          launched_at: null,
        })),
      };
      resolved.members.forEach((member, i) => {
        launchTasks.push({
          member,
          entry: manifest.members[i] as PanelManifestMember,
          logPath: join(dir, `${legBaseName(member.name, 1)}.log`),
        });
      });
    } else {
      // RECONCILE — a prior run for this slug exists. Re-issuing the same start
      // reuses terminal legs, leaves running legs, and relaunches only no-result
      // legs; it never blindly re-fans-out.
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (err) {
        deps.writeErr(
          `pair panel start: corrupt manifest at ${manifestPath}: ${(err as Error).message}\n`,
        );
        return 2;
      }
      const parsed = parseManifest(raw);
      if (!parsed.ok) {
        deps.writeErr(
          `pair panel start: corrupt manifest at ${manifestPath}: ${parsed.error}\n`,
        );
        return 2;
      }
      const existing = parsed.manifest;

      // Identity guard — a colliding slug must never silently merge into another
      // run. The stored prompt must be byte-exact AND the resolved member set must
      // match; either mismatch is a different run → exit 2.
      let storedPrompt: string;
      try {
        storedPrompt = readFileSync(join(dir, "prompt.md"), "utf8");
      } catch {
        deps.writeErr(
          `pair panel start: cannot verify slug '${args.slug}' identity (missing ${join(dir, "prompt.md")}) — refusing to reconcile\n`,
        );
        return 2;
      }
      if (storedPrompt !== promptText) {
        deps.writeErr(
          `pair panel start: slug '${args.slug}' already exists with a different prompt — refusing a colliding-run merge (use a new --slug)\n`,
        );
        return 2;
      }
      if (!sameMemberSet(resolved.members, existing.members)) {
        deps.writeErr(
          `pair panel start: slug '${args.slug}' already exists with a different member set — refusing a colliding-run merge (use a new --slug)\n`,
        );
        return 2;
      }

      // A boot mismatch means the machine rebooted since launch → every recorded
      // pid is a dead pre-reboot process, so every non-terminal leg relaunches.
      const bootMismatch =
        Math.abs(currentBootEpochMs - (existing.boot_epoch_ms ?? 0)) >
        BOOT_EPOCH_TOLERANCE_MS;
      const priorByName = new Map(existing.members.map((m) => [m.name, m]));
      const newGeneration = (existing.generation ?? 1) + 1;
      let relaunched = false;
      const members: PanelManifestMember[] = [];
      for (const member of resolved.members) {
        // Guaranteed present — the member-set guard above passed.
        const prior = priorByName.get(member.name) as PanelManifestMember;
        const action = reconcileLeg(prior, deps, { bootMismatch, graceMs });
        if (action === "reuse" || action === "leave") {
          members.push(prior);
          continue;
        }
        // RELAUNCH to a fresh per-generation result PATH so a still-writing prior
        // leg (a pid-recycle / grace race) and its successor never collide on a
        // path — the live winner is authoritative, so the presumed-dead leg is
        // never SIGTERM'd.
        relaunched = true;
        const base = legBaseName(member.name, newGeneration);
        const entry: PanelManifestMember = {
          name: member.name,
          harness: member.harness,
          yaml: join(dir, `${base}.yaml`),
          pidfile: join(dir, `${base}.pidfile`),
          startfile: join(dir, `${base}.starttime`),
          launched_at: null,
        };
        members.push(entry);
        launchTasks.push({ member, entry, logPath: join(dir, `${base}.log`) });
      }
      manifest = {
        dir,
        slug: args.slug,
        // Re-stamp the boot-epoch + bump the generation only when a leg actually
        // relaunched; a pure reuse/leave reconcile leaves the run's identity intact.
        boot_epoch_ms: relaunched
          ? currentBootEpochMs
          : (existing.boot_epoch_ms ?? currentBootEpochMs),
        generation: relaunched ? newGeneration : (existing.generation ?? 1),
        members,
      };
    }

    const persistManifest = (): void => {
      writeFileAtomic(
        dir,
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    };
    persistManifest();

    for (const { member, entry, logPath } of launchTasks) {
      // A launch-task entry always carries a string pidfile path (nulled only on a
      // spawn throw below). `$LOG` captures the leg's stderr/diagnostics for the
      // crash-without-file case; it is not read by `wait`, so it stays out of the
      // manifest.
      const pidfilePath = entry.pidfile as string;
      // The wrapper writes the leg's OS start-time here (the recycle-guard anchor),
      // beside the pidfile in the same run dir.
      const startfilePath = entry.startfile as string;
      const legArgv = buildPanelLegArgv({
        keeperBin: deps.keeperBin,
        keeperAgentPath: deps.keeperAgentPath,
        prompt: promptText,
        member,
        slug: args.slug,
        yamlPath: entry.yaml,
        stopTimeoutMs,
      });
      try {
        deps.spawn(buildDetachWrapperArgv(legArgv), {
          env: {
            ...deps.env,
            LOG: logPath,
            PIDFILE: pidfilePath,
            STARTFILE: startfilePath,
          },
          cwd: deps.cwd,
        });
        entry.launched_at = deps.now();
      } catch {
        // Spawn threw → the leg never started. Null the pidfile (the launch-failed
        // signal `wait` surfaces as an N-of-N fail) + the startfile; launched_at
        // stays null.
        entry.pidfile = null;
        entry.startfile = null;
      }
      persistManifest();
    }

    deps.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  } finally {
    lock.release();
  }
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
 *
 * REBOOT GUARD (Guard B): a mid-wait reboot kills every recorded leg pid, so a
 * non-terminal leg can never finish. Derive the current boot instant through the
 * SAME sleep-proof seam `start` stamps with; if it disagrees with the manifest's
 * `boot_epoch_ms` beyond {@link BOOT_EPOCH_TOLERANCE_MS}, classify every
 * non-terminal leg as terminal-failed with a distinct `machine-rebooted` reason
 * and return promptly (exit 0, `ok:false`) rather than spin to 124 — the driver's
 * cue to re-issue `start` (idempotent reconcile relaunches the legs) then `wait`
 * again. An ABSENT `boot_epoch_ms` (pre-durable manifest) fails OPEN — no guard, no
 * boot derivation. STRICTLY read-only: zero manifest writes, zero relaunches.
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
  // Per-invocation recycle-probe cache: the `(pid, start_time)` identity is fixed
  // for the run, so `ps` is forked at most once per leg across every poll tick.
  const startTimeMemo = new Map<string, boolean>();

  // Guard B: a reboot is a one-shot fact for this invocation — derive it once. An
  // ABSENT boot-epoch (pre-durable manifest) fails open: no derivation, no guard.
  const storedBoot = parsed.manifest.boot_epoch_ms;
  const rebooted =
    storedBoot !== undefined &&
    Math.abs(
      (deps.bootEpochMs !== undefined
        ? deps.bootEpochMs()
        : readBootEpochMs(deps.now)) - storedBoot,
    ) > BOOT_EPOCH_TOLERANCE_MS;

  for (;;) {
    const evals = members.map((m) =>
      evaluateLeg(m, deps, waitStartMs, startTimeMemo),
    );
    if (rebooted) {
      // Every pre-reboot pid is dead → a still-"running" leg can never finish.
      // Turn it terminal-failed with a distinct reason; a leg that already wrote a
      // result keeps its real (pre-reboot) verdict. Return promptly, no spin.
      const rebootEvals = evals.map((e) =>
        e.status === "running"
          ? {
              status: "fail" as const,
              yaml: null,
              reason: "machine-rebooted",
            }
          : e,
      );
      deps.write(
        `${JSON.stringify(buildVerdict(dir, members, rebootEvals))}\n`,
      );
      return 0;
    }
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

/** Inputs to {@link panelStatus}. */
export interface PanelStatusArgs {
  dir: string;
}

/**
 * `status`: read the manifest and print a single-pass, NON-blocking, NON-mutating
 * per-leg snapshot ({@link PanelStatus}). Each leg is classified via the
 * `launched_at`-anchored grace (a read-only call must never report a long-dead
 * no-result leg as `running`). Missing/corrupt manifest (an unknown or pruned
 * slug) → exit 2, consistent with `wait`. Returns the process exit code.
 */
export function panelStatus(args: PanelStatusArgs, deps: PanelDeps): number {
  const manifestPath = join(args.dir, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    deps.writeErr(
      `pair panel status: cannot read manifest at ${manifestPath}: ${(err as Error).message}\n`,
    );
    return 2;
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) {
    deps.writeErr(`pair panel status: corrupt manifest: ${parsed.error}\n`);
    return 2;
  }
  const { dir, slug, generation, members } = parsed.manifest;
  const graceMs = deps.graceMs ?? PID_STARTUP_GRACE_MS;
  const out: PanelStatusMember[] = members.map((m) => {
    const c = classifyLegStatus(m, deps, { graceMs });
    return {
      name: m.name,
      harness: m.harness,
      status: c.status,
      yaml: c.yaml,
      reason: c.reason,
    };
  });
  const snapshot: PanelStatus = {
    dir,
    slug,
    generation: generation ?? 1,
    all_terminal: out.every((m) => m.status !== "running"),
    members: out,
  };
  deps.write(`${JSON.stringify(snapshot)}\n`);
  return 0;
}

/** True iff ANY of a run dir's manifest legs has a live pid that is STILL the
 *  process it launched ({@link legIdentityHolds} — a recycled pid must not veto
 *  `prune`). A running detached leg is lock-free, so this pid probe — not the
 *  advisory lock — is what protects a live run from `prune`. A missing/corrupt
 *  manifest proves no live leg. */
function hasLiveLeg(slugDir: string, deps: PanelDeps): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(slugDir, "manifest.json"), "utf8"));
  } catch {
    return false;
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) {
    return false;
  }
  for (const m of parsed.manifest.members) {
    if (m.pidfile === null) {
      continue;
    }
    const pid = readPid(m.pidfile);
    if (pid !== null && deps.pidAlive(pid) && legIdentityHolds(m, pid, deps)) {
      return true;
    }
  }
  return false;
}

/** TOCTOU-safe delete: rename the run dir into the same-parent trash (an atomic,
 *  EXDEV-safe move so a lock-free reader never sees a half-deleted dir), then
 *  recursive-remove the trashed entry. EAFP/fail-open — a vanished source returns
 *  false (nothing pruned); a failed removal leaves a trash entry the next prune
 *  sweeps. */
function trashAndRemove(
  trashRoot: string,
  name: string,
  slugDir: string,
  deps: PanelDeps,
): boolean {
  try {
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  } catch {
    // fall through — the rename below throws + is caught if the trash is unusable.
  }
  const trashPath = join(
    trashRoot,
    `${name}-${deps.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    renameSync(slugDir, trashPath);
  } catch {
    return false;
  }
  try {
    rmSync(trashPath, { recursive: true, force: true });
  } catch {
    // best-effort — a leftover trash entry is reclaimed at the next prune.
  }
  return true;
}

/** Inputs to {@link panelPrune}. `ttlMs` overrides {@link PANEL_PRUNE_TTL_MS}
 *  (tests). */
export interface PanelPruneArgs {
  ttlMs?: number;
}

/**
 * `prune`: GC abandoned durable panel run dirs under
 * `~/.local/state/keeper/panels/`. A slug dir is reclaimed ONLY when all three
 * hold — (a) its per-slug advisory lock is free (no `start`/reconcile mid-flight),
 * (b) NO manifest leg pid is live (a live detached run is lock-free, so this veto,
 * not the lock, is the liveness guard), and (c) its `started-at` sentinel mtime is
 * older than the TTL. Deletion is TOCTOU-safe (rename-to-trash then recursive
 * remove). Fail-open throughout — an un-ageable (sentinel-less) or in-use dir is
 * kept, never force-deleted. Prints the {@link PanelPruneResult}; returns 0.
 */
export function panelPrune(args: PanelPruneArgs, deps: PanelDeps): number {
  const ttlMs = args.ttlMs ?? PANEL_PRUNE_TTL_MS;
  const root = join(keeperStateDir(), "panels");
  const trashRoot = join(root, PANEL_TRASH_DIR);
  const pruned: string[] = [];
  const kept: string[] = [];

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No panels root → nothing to prune.
    deps.write(`${JSON.stringify({ root, pruned, kept })}\n`);
    return 0;
  }

  // Clear any trash left by a prior interrupted prune first — the main scan skips
  // the trash dir, so a stranded entry would otherwise leak forever. Fail-open.
  try {
    rmSync(trashRoot, { recursive: true, force: true });
  } catch {
    // a stubborn leftover is swept next run.
  }

  for (const name of names) {
    if (name === PANEL_TRASH_DIR) {
      continue;
    }
    const slugDir = join(root, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(slugDir);
    } catch {
      continue; // vanished under us.
    }
    if (!st.isDirectory()) {
      continue;
    }

    // (a) A held per-slug lock means a start/reconcile is mid-flight → never prune.
    const lockPath = join(slugDir, ".lock");
    const lock =
      deps.lock !== undefined
        ? deps.lock(lockPath)
        : { release: (): void => {} };
    if (lock === null) {
      kept.push(name);
      continue;
    }
    try {
      // (b) A live leg pid vetoes deletion regardless of age.
      if (hasLiveLeg(slugDir, deps)) {
        kept.push(name);
        continue;
      }
      // (c) The started-at sentinel's mtime must be older than the TTL; an absent
      // sentinel is un-ageable → keep (never dir mtime, which a leg write bumps).
      let sentinelMtimeMs: number;
      try {
        sentinelMtimeMs = statSync(join(slugDir, STARTED_AT_SENTINEL)).mtimeMs;
      } catch {
        kept.push(name);
        continue;
      }
      if (deps.now() - sentinelMtimeMs <= ttlMs) {
        kept.push(name);
        continue;
      }
      if (trashAndRemove(trashRoot, name, slugDir, deps)) {
        pruned.push(name);
      } else {
        kept.push(name);
      }
    } finally {
      lock.release();
    }
  }

  const result: PanelPruneResult = { root, pruned, kept };
  deps.write(`${JSON.stringify(result)}\n`);
  return 0;
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
 *  `Bun.sleep`, the pid probe, the sleep-proof boot-epoch + live start-time
 *  readers (the recycle + reboot guards), the per-slug advisory lock
 *  ({@link FileLock}), the real registry loader, and the resolved launcher
 *  transport. */
export function buildPanelDeps(): PanelDeps {
  return {
    keeperBin: process.execPath,
    keeperAgentPath: resolveKeeperAgentPathDepFree(),
    env: process.env as Record<string, string | undefined>,
    cwd: process.cwd(),
    loadRegistry: () => {
      const catalog = loadPresetCatalog();
      const selections = loadPanelSelections(catalog);
      return { catalog, selections };
    },
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
    readStartTime: readPanelStartTime,
    // Sleep-proof, kernel-derived boot instant — start + wait share it so a mid-run
    // sleep never false-trips the reboot guard.
    bootEpochMs: () => readBootEpochMs(() => Date.now()),
    // Non-blocking per-slug lock (flock/CLOEXEC — a detached leg never inherits it).
    lock: (lockPath) => FileLock.tryAcquire(lockPath),
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  };
}

export const PANEL_HELP = `keeper agent panel — cross-OS panel fan-out (start | wait | status | prune)

Usage:
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>] [--run-dir <d>] [--timeout <s>]
  keeper agent panel start <prompt-file> --slug <slug> (--preset <name> | --cli <claude|codex|pi>)
       [--role <r>] [--model <m>] [--effort <e>] [--read-only] [--run-dir <d>] [--timeout <s>]
  keeper agent panel wait   (--slug <slug> | --run-dir <d>) [--chunk <s>]
  keeper agent panel status (--slug <slug> | --run-dir <d>)
  keeper agent panel prune

start  idempotent-by-slug. Resolves the panel members (a panel.yaml panel or a
       single catalog preset; an absent/empty --slug, or a missing/invalid catalog
       or panel.yaml, is fail-loud exit 2), derives the run's DURABLE dir from the
       slug (~/.local/state/keeper/panels/<slug>/, 0700 — or the --run-dir override),
       and under a per-slug advisory lock either fans out fresh (launch each member
       as a DETACHED read-only \`keeper agent run\` leg named \`panel::<slug>::<preset>\`
       in the 'panels' session) or RECONCILES an existing run — reuse terminal legs
       (completed OR failed; resume is not retry), leave running legs, relaunch only
       no-result legs. Prints the manifest, exits 0. A colliding-slug prompt/member
       mismatch or lock contention exits 2. An ad-hoc --preset/--cli builds a
       1-member panel (pairing = a panel of one); --panel and --preset/--cli are
       mutually exclusive.
wait   re-reads the manifest (by --slug or --run-dir) and blocks ONE --chunk window
       polling each leg. Exit 0 + verdict JSON {dir, ok, members:[…]} when all legs
       are terminal; exit 124 when the chunk elapses (re-issue it); exit 2 on a
       missing/corrupt manifest (an unknown/pruned slug) or bad flags. Exit 0 means
       ALL-TERMINAL, not all-success — key off the verdict's 'ok' flag.
status read-only, non-blocking per-leg snapshot {dir, slug, generation,
       all_terminal, members:[{name,harness,status,yaml,reason}]} where status is
       completed|running|failed|absent (a dead no-result leg reads failed/absent,
       never a phantom 'running'). Exit 0; exit 2 on a missing/corrupt manifest.
prune  GC abandoned run dirs under ~/.local/state/keeper/panels/. Reclaims a slug
       dir ONLY when its lock is free AND no leg pid is live AND its started-at
       sentinel is older than the ${PANEL_PRUNE_TTL_MS / 86_400_000}-day TTL; a
       live or in-reconcile run is always kept. Prints {root, pruned, kept}.

Options:
  --slug <slug>     start: REQUIRED run id (each leg launches as
                    panel::<slug>::<preset>). wait/status: resolves the durable
                    slug dir. Slugified to [a-z0-9-]; empties-to-nothing → exit 2.
  --panel <name>    Panel/preset name (default: the 'default' panel in panel.yaml)
  --preset <name>   Ad-hoc single member from a catalog preset (panel of one)
  --cli <x>         Ad-hoc single member harness: claude|codex|pi
  --role <r>        Ad-hoc role prompt: default|planner|codereviewer|coplanner
                    (rides the leg as --system; default/empty adds no block)
  --model <m>       Ad-hoc model override (rides onto the leg)
  --effort <e>      Ad-hoc reasoning effort (codex only)
  --read-only       Ad-hoc read-only posture (forwarded to the leg)
  --run-dir <d>     Location override for the run dir. start: replaces the durable
                    slug dir; wait/status: an alternative to --slug (--run-dir wins
                    if both are given).
  --timeout <s>     Per-leg keeper agent run stop-timeout (default: ${DEFAULT_PANEL_TIMEOUT_SECONDS})
  --chunk <s>       wait window in seconds (default: ${DEFAULT_PANEL_CHUNK_SECONDS}, max ${MAX_CHUNK_SECONDS})
  --help, -h        Show this help
`;

/** Resolve a `wait`/`status` run dir from its flags: `--run-dir` is an explicit
 *  location override and WINS when both are given; otherwise `--slug` resolves the
 *  durable slug-keyed dir. A slug that slugifies to nothing, or neither flag, is a
 *  bad-flags fault (the caller exits 2). Pure. */
function resolvePanelDir(values: {
  "run-dir"?: string;
  slug?: string;
}): { ok: true; dir: string } | { ok: false; msg: string } {
  const runDir = values["run-dir"];
  if (runDir !== undefined && runDir !== "") {
    return { ok: true, dir: runDir };
  }
  if (values.slug !== undefined && values.slug !== "") {
    const slug = slugify(values.slug);
    if (slug === null) {
      return {
        ok: false,
        msg: `--slug '${values.slug}' slugifies to nothing — use [a-z0-9-]`,
      };
    }
    return { ok: true, dir: join(keeperStateDir(), "panels", slug) };
  }
  return { ok: false, msg: "--run-dir <d> or --slug <slug> is required" };
}

/**
 * Run one panel sub-verb's `parseArgs` under a fault guard. An unknown flag (e.g. a
 * retired spelling) or a value-shape fault is CLI misuse → exit 2 with the parser's
 * own message, never the uncaught-throw exit 1. The thunk preserves `parseArgs`'s
 * own precise per-flag `values` typing (the `never` from `process.exit` unions
 * away). */
function parsePanelArgs<R>(op: string, parse: () => R): R {
  try {
    return parse();
  } catch (err) {
    process.stderr.write(`pair panel ${op}: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

/**
 * Route `keeper agent panel <start|wait|status|prune> …`. Parses flags, builds the
 * production deps, dispatches to {@link panelStart}/{@link panelWait}/{@link
 * panelStatus}/{@link panelPrune}, and exits with their code. Never returns
 * (always exits).
 */
export async function runPanel(argv: string[]): Promise<void> {
  const op = argv[0];
  if (op === "--help" || op === "-h" || op === undefined) {
    process.stdout.write(PANEL_HELP);
    process.exit(op === undefined ? 2 : 0);
  }
  if (op !== "start" && op !== "wait" && op !== "status" && op !== "prune") {
    process.stderr.write(
      `pair panel: unknown operation '${op}' (expected 'start', 'wait', 'status', or 'prune')\n`,
    );
    process.exit(2);
  }

  const deps = buildPanelDeps();

  if (op === "start") {
    const parsed = parsePanelArgs("start", () =>
      parseArgs({
        args: argv.slice(1),
        options: {
          slug: { type: "string" },
          panel: { type: "string" },
          preset: { type: "string" },
          cli: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          role: { type: "string" },
          "read-only": { type: "boolean", default: false },
          "run-dir": { type: "string" },
          timeout: { type: "string" },
          help: { type: "boolean", default: false },
        },
        allowPositionals: true,
      }),
    );
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

    // --slug is REQUIRED: it names the run, and each leg launches as
    // `panel::<slug>::<preset>`. Slugify to `[a-z0-9-]`; absent OR a value that
    // slugifies to nothing (all non-ASCII / punctuation-only) is misuse → exit 2
    // with a panel-scoped message (never the leaf's raw string).
    if (parsed.values.slug === undefined) {
      process.stderr.write(
        "pair panel start: --slug is required (a human-meaningful run id; each leg launches as panel::<slug>::<preset>)\n",
      );
      process.exit(2);
    }
    const slug = slugify(parsed.values.slug);
    if (slug === null) {
      process.stderr.write(
        `pair panel start: --slug '${parsed.values.slug}' slugifies to nothing — use [a-z0-9-]\n`,
      );
      process.exit(2);
    }

    // The configured `--panel` form and the ad-hoc `--preset`/`--cli` form are
    // mutually exclusive — one member source per launch.
    const hasAdHoc =
      parsed.values.preset !== undefined || parsed.values.cli !== undefined;
    if (parsed.values.panel !== undefined && hasAdHoc) {
      process.stderr.write(
        "pair panel start: --panel is mutually exclusive with --preset/--cli (pick a configured panel OR an ad-hoc member)\n",
      );
      process.exit(2);
    }

    // The ad-hoc override flags (`--model`/`--effort`/`--role`) only apply to an
    // ad-hoc member; without a `--preset`/`--cli` selector they would be
    // silently dropped onto the configured-panel path. Fail loud instead.
    if (!hasAdHoc) {
      const orphaned = (["model", "effort", "role"] as const).find(
        (flag) => parsed.values[flag] !== undefined,
      );
      if (orphaned !== undefined) {
        process.stderr.write(
          `pair panel start: --${orphaned} requires an ad-hoc member selector (--preset or --cli)\n`,
        );
        process.exit(2);
      }
    }

    let adHoc: AdHocMemberSpec | undefined;
    if (hasAdHoc) {
      // Resolve the `--role` catalog to its prompt text HERE (the CLI layer owns
      // the fs read); it rides the leg as `agent run --system <text>`. An
      // absent/`default` role is a no-op (no `--system` block).
      let system: string | undefined;
      const role = parsed.values.role;
      if (role !== undefined && role !== "" && role !== "default") {
        const roleResult = loadRolePrompt(role);
        if (!roleResult.ok) {
          process.stderr.write(`pair panel start: ${roleResult.error}\n`);
          process.exit(2);
        }
        system = roleResult.text;
      }
      adHoc = {
        preset: parsed.values.preset,
        cli: parsed.values.cli,
        model: parsed.values.model,
        effort: parsed.values.effort,
        system,
        readOnly: parsed.values["read-only"] ?? false,
      };
    }

    const code = await panelStart(
      {
        promptFile,
        slug,
        panel: parsed.values.panel,
        adHoc,
        dir: parsed.values["run-dir"],
        timeoutSeconds,
      },
      deps,
    );
    process.exit(code);
  }

  if (op === "prune") {
    const parsed = parsePanelArgs("prune", () =>
      parseArgs({
        args: argv.slice(1),
        options: { help: { type: "boolean", default: false } },
        allowPositionals: true,
      }),
    );
    if (parsed.values.help) {
      process.stdout.write(PANEL_HELP);
      process.exit(0);
    }
    process.exit(panelPrune({}, deps));
  }

  if (op === "status") {
    const parsed = parsePanelArgs("status", () =>
      parseArgs({
        args: argv.slice(1),
        options: {
          slug: { type: "string" },
          "run-dir": { type: "string" },
          help: { type: "boolean", default: false },
        },
        allowPositionals: true,
      }),
    );
    if (parsed.values.help) {
      process.stdout.write(PANEL_HELP);
      process.exit(0);
    }
    const resolved = resolvePanelDir(parsed.values);
    if (!resolved.ok) {
      process.stderr.write(`pair panel status: ${resolved.msg}\n`);
      process.exit(2);
    }
    process.exit(panelStatus({ dir: resolved.dir }, deps));
  }

  const parsed = parsePanelArgs("wait", () =>
    parseArgs({
      args: argv.slice(1),
      options: {
        slug: { type: "string" },
        "run-dir": { type: "string" },
        chunk: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }),
  );
  if (parsed.values.help) {
    process.stdout.write(PANEL_HELP);
    process.exit(0);
  }
  const resolved = resolvePanelDir(parsed.values);
  if (!resolved.ok) {
    process.stderr.write(`pair panel wait: ${resolved.msg}\n`);
    process.exit(2);
  }
  const chunkSeconds =
    parsed.values.chunk !== undefined
      ? Number(parsed.values.chunk)
      : DEFAULT_PANEL_CHUNK_SECONDS;
  const code = await panelWait({ dir: resolved.dir, chunkSeconds }, deps);
  process.exit(code);
}
