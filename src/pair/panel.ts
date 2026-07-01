/**
 * `keeper pair panel start|wait` — the cross-OS panel fan-out orchestrator the
 * `plan:panel-runner` agent drives instead of hand-rolling `setsid`/`timeout` in
 * shell (neither exists on stock macOS). All the OS-specific machinery lives here
 * in TS: detachment via a `nohup` double-fork POSIX-shell wrapper (NOT
 * `setsid`/`timeout`/`gtimeout`), a `Date.now()`-deadline poll loop (NOT a shell
 * `timeout`), and atomic same-dir temp-then-rename result files (EXDEV-safe on
 * macOS, where `os.tmpdir()` is a different APFS volume).
 *
 *   - `start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]`
 *     resolves the panel members in-process, copies the prompt into a scratch
 *     dir, launches every member as a DETACHED `keeper agent run` leg (each writes
 *     its own uniform JSON result envelope via `--output`), persists
 *     `<dir>/manifest.json`, prints it, and exits 0 immediately.
 *   - `wait --dir <d> [--chunk <s>]` re-reads the manifest and blocks ONE chunk
 *     polling each leg's terminality; exit 0 + verdict JSON when all legs are
 *     terminal, exit 124 when the chunk elapses (re-issuable), exit 2 on a
 *     missing/corrupt manifest or bad flags.
 *
 * CONTENT-BLIND: `wait` reads each leg's result file only for its `outcome`
 * (`completed` → ok; every other outcome → fail, `reason=<outcome>`) — NEVER a
 * panelist's `message` content — with the pidfile the sole crash backstop for a
 * leg that dies before producing a file. `exit 0` means all-terminal, NOT
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
  loadPanelSelections,
  loadPresetCatalog,
  type PanelSelections,
  type Preset,
  type PresetCatalog,
  resolvePreset,
} from "../agent/config";
import {
  loadRolePrompt,
  PAIR_CLIS,
  type PairCli,
  resolvePairKeeperAgentPath,
} from "../pair-command";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-leg `keeper agent run` stop-timeout default (seconds; translated to
 *  `--stop-timeout-ms` at launch). */
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
  harness: PairCli;
  preset?: string;
  model?: string;
  effort?: string;
  system?: string;
  readOnly?: boolean;
}

/** One member's persisted launch record in the manifest. `yaml` is the leg's
 *  `--output` result-file path (a `keeper agent run` JSON envelope). `pidfile` is
 *  null when the leg's spawn threw at launch (it never started → a normal N-of-N
 *  fail). */
export interface PanelManifestMember {
  name: string;
  harness: string;
  yaml: string;
  pidfile: string | null;
}

/** The `start`-persisted, `wait`-re-read manifest. */
export interface PanelManifest {
  dir: string;
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

/** A detached, fire-and-forget leg spawn (Bun.spawn-shaped subset; injectable
 *  for tests). The wrapper redirects the leg's std streams + writes its pidfile,
 *  so this returns nothing — the caller never waits on it. */
export type PanelSpawnFn = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; cwd: string },
) => void;

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
      if (!PAIR_CLIS.has(preset.harness)) {
        return {
          ok: false,
          error: `panel '${name}' member '${memberName}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex|pi only)`,
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

  const preset = catalog.presets[name];
  if (preset !== undefined) {
    if (!PAIR_CLIS.has(preset.harness)) {
      return {
        ok: false,
        error: `preset '${name}' pins harness ${preset.harness}, which is not pair-launchable (claude|codex|pi only)`,
      };
    }
    return {
      ok: true,
      members: [{ name, harness: preset.harness as PairCli, preset: name }],
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
 * Resolve an ad-hoc selector to a SINGLE {@link PanelMember} — the panel-of-one
 * that replaces `pair send`'s bespoke drive loop. `--preset <name>` resolves its
 * harness (+ model/effort launcher-side via the leg's `--preset`); `--cli <x>` is
 * a bare harness with the explicit `--model`/`--effort` overrides. `--effort` is
 * codex-only (mirrors `pair send`). A harness outside claude|codex|pi, an unknown
 * preset, or effort on a non-codex member fails loud (the caller exits 2). Pure —
 * the resulting member converges on the SAME manifest + leg path a configured
 * panel produces.
 */
export function resolveAdHocMember(
  catalog: PresetCatalog,
  spec: AdHocMemberSpec,
): ResolveMembersResult {
  let harness: PairCli;
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
    if (!PAIR_CLIS.has(resolved.harness)) {
      return {
        ok: false,
        error: `preset '${spec.preset}' pins harness ${resolved.harness}, which is not pair-launchable (claude|codex|pi only)`,
      };
    }
    harness = resolved.harness as PairCli;
    name = spec.preset as string;
    preset = spec.preset as string;
  } else if (hasCli) {
    if (!PAIR_CLIS.has(spec.cli as string)) {
      return {
        ok: false,
        error: `--cli must be claude|codex|pi (got ${spec.cli})`,
      };
    }
    harness = spec.cli as PairCli;
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
 *     --session panels --output <dir>/<m>.yaml --stop-timeout-ms <ms>`.
 * The `[<bun>, <keeper.ts>]` prefix is the self-re-exec transport (daemon.ts
 * precedent); `<harness>` is the `agent run <cli>` positional and `<prompt>` the
 * task text passed inline (agent run takes the prompt literally, not a file);
 * `--preset` layers model/effort when the member carries one. The ad-hoc
 * (panel-of-one) posture layers `--system <text>` (a resolved `--role` prompt)
 * and explicit `--model`/`--effort` overrides; a configured member sets none of
 * these, so its argv stays byte-identical. `--read-only` keeps a panelist a
 * non-mutating explorer (default ON — a configured member omits `readOnly`), and
 * `--output` makes the leg write its own uniform JSON result envelope atomically.
 * Pure.
 */
export function buildPanelLegArgv(opts: {
  keeperBin: string;
  keeperAgentPath: string;
  prompt: string;
  member: PanelMember;
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
    "--stop-timeout-ms",
    String(opts.stopTimeoutMs),
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

/** One member's status, precedence: result file present → parse its `outcome`
 *  (`completed` → ok; anything else → fail with `reason=<outcome>`; unparseable →
 *  fail `reason=corrupt-result`); else a null/dead pidfile past grace → crash
 *  fail; else running. The pid is the crash backstop ONLY — a leg that dies
 *  before writing its file. */
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
  const pid = readPid(member.pidfile);
  if (pid !== null && !deps.pidAlive(pid)) {
    const graceMs = deps.graceMs ?? PID_STARTUP_GRACE_MS;
    if (deps.now() - waitStartMs >= graceMs) {
      return {
        status: "fail",
        yaml: null,
        reason: `leg process ${pid} exited before producing a result file`,
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
      !(mm.pidfile === null || typeof mm.pidfile === "string")
    ) {
      return { ok: false, error: "manifest member has malformed fields" };
    }
    members.push({
      name: mm.name,
      harness: mm.harness,
      yaml: mm.yaml,
      pidfile: mm.pidfile,
    });
  }
  return { ok: true, manifest: { dir: obj.dir, members } };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

/** Inputs to {@link panelStart}. `panel` undefined → the `panel.yaml` default.
 *  `adHoc` set → the panel-of-one path: members resolve from the ad-hoc selector
 *  instead of a configured panel name (`panel` is ignored, mutual exclusion
 *  enforced by the caller). */
export interface PanelStartArgs {
  promptFile: string;
  panel: string | undefined;
  adHoc?: AdHocMemberSpec;
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

  // A human-readable copy of the prompt in the scratch dir; the leg receives the
  // prompt text inline (agent run takes it as a positional, not a file).
  writeFileAtomic(dir, join(dir, "prompt.md"), promptText);

  // The panel's `--timeout <s>` is the per-leg stop budget; agent run wants ms.
  const stopTimeoutMs = args.timeoutSeconds * 1000;
  const manifestMembers: PanelManifestMember[] = [];
  for (const member of resolved.members) {
    const yamlPath = join(dir, `${member.name}.yaml`);
    // `$LOG` still captures the leg's stderr/diagnostics for the crash-without-
    // file case (the leg dies before writing its result file); it is not read by
    // `wait`, so it stays out of the manifest.
    const logPath = join(dir, `${member.name}.log`);
    const pidfilePath = join(dir, `${member.name}.pidfile`);
    const legArgv = buildPanelLegArgv({
      keeperBin: deps.keeperBin,
      keeperAgentPath: deps.keeperAgentPath,
      prompt: promptText,
      member,
      yamlPath,
      stopTimeoutMs,
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
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  };
}

export const PANEL_HELP = `keeper pair panel — cross-OS panel fan-out (start | wait)

Usage:
  keeper pair panel start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]
  keeper pair panel start <prompt-file> (--preset <name> | --cli <claude|codex|pi>)
       [--role <r>] [--model <m>] [--effort <e>] [--read-only] [--dir <d>] [--timeout <s>]
  keeper pair panel wait --dir <d> [--chunk <s>]

start  resolves the panel members (a panel.yaml panel or a single catalog
       preset; a missing/invalid catalog or panel.yaml is fail-loud exit 2),
       launches each as a DETACHED read-only \`keeper agent run\` leg in the
       'panels' session, writes <dir>/manifest.json, prints it, and exits 0
       immediately. Prints {dir, members:[{name,harness,yaml,pidfile}]}. An
       ad-hoc --preset/--cli builds a 1-member panel (pairing = a panel of one);
       --panel and --preset/--cli are mutually exclusive.
wait   re-reads the manifest and blocks ONE --chunk window polling each leg.
       Exit 0 + verdict JSON {dir, ok, members:[{name,harness,status,yaml,reason}]}
       when all legs are terminal; exit 124 when the chunk elapses (re-issue it);
       exit 2 on a missing/corrupt manifest or bad flags. Exit 0 means ALL-TERMINAL,
       not all-success — key off the verdict's 'ok' flag.

Options:
  --panel <name>    Panel/preset name (default: the 'default' panel in panel.yaml)
  --preset <name>   Ad-hoc single member from a catalog preset (panel of one)
  --cli <x>         Ad-hoc single member harness: claude|codex|pi
  --role <r>        Ad-hoc role prompt: default|planner|codereviewer|coplanner
                    (rides the leg as --system; default/empty adds no block)
  --model <m>       Ad-hoc model override (rides onto the leg)
  --effort <e>      Ad-hoc reasoning effort (codex only)
  --read-only       Ad-hoc read-only posture (forwarded to the leg)
  --dir <d>         Scratch dir (start: minted when absent; wait: required)
  --timeout <s>     Per-leg keeper agent run stop-timeout (default: ${DEFAULT_PANEL_TIMEOUT_SECONDS})
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
        preset: { type: "string" },
        cli: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        role: { type: "string" },
        "read-only": { type: "boolean", default: false },
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
        panel: parsed.values.panel,
        adHoc,
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
