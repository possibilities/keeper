#!/usr/bin/env bun
/**
 * restore-agents — Chrome-style "restore previous session" for keeper-managed
 * Claude Code agents (epic fn-677 T4; rebuilt on the DB-derived model in
 * fn-817 T4). The candidate set is derived RETROSPECTIVELY from `keeper.db` at
 * read time (`src/restore-set.ts`): a `state='killed'` job whose
 * producer-stamped `close_kind` reads crash-like, that was live recently and
 * doesn't already re-occupy a backend. There is no frozen `restore.json`
 * snapshot to read — the daemon-down disaster-recovery path is now first-class
 * (a read-only `keeper.db` connection, no socket round-trip).
 *
 * Each surviving candidate is replayed back into its original backend session
 * via keeper's SOLE launch transport — `agentwrapLaunch` in resume mode (the
 * same transport `keeper dispatch` and `keeper bus wake` use). agentwrap owns
 * the tmux window (session get-or-create + handoff), re-attaches via
 * `--resume <target>`, and holds the pane open after claude exits;
 * `scripts/resume.ts` keeps the human-facing DISPLAY form
 * (`buildResumeCommand`). The resume key is the job's LATEST name (`title`,
 * `job_id` fallback) — read live from the jobs projection at restore time,
 * never a frozen one — so a renamed session restores to the name keeper
 * currently knows.
 *
 * The candidate set already excludes any `job_id` still occupying a live
 * backend (`restore-set.ts`'s UUID-liveness dedup, computed from the same DB
 * read) — so there is no UDS round-trip and no separate skip-set probe. Every
 * candidate routes through the one `agentwrapLaunch` resume seam.
 *
 * Across every mode, restored windows come back in their ORIGINAL visual
 * (left-to-right) tmux order: `restore-set.ts` sorts candidates by the captured
 * `window_index` (unknown order sinks to the tail by `created_at` then
 * `job_id`). `--apply` paces window creation by 0.5s between consecutive
 * launches (never before the first or after the last).
 *
 * Usage:
 *   bun scripts/restore-agents.ts [--session <name>] [--apply] [--last-generation] [--db <path>]
 *   bun scripts/restore-agents.ts --snapshot-current [--session <name>] [--db <path>] > revive.sh
 *
 *   --session <name>   Restore only agents from this backend session. Default:
 *                      all sessions in the candidate set.
 *   --apply            Actually relaunch via `ensureLaunched`. Default is
 *                      DRY-RUN — print what would be restored, touch nothing.
 *   --last-generation  Bound the crash set to the LAST tmux-server generation
 *                      window ("the session you just lost") instead of the full
 *                      7-day pool. Composes with --apply and --session.
 *   --snapshot-current Emit a runnable bash script that revives the CURRENT live
 *                      set (every working/stopped session) into tmux windows — a
 *                      manual safety net independent of the crash-derivation path.
 *                      Pipe to a file and run later. Read-only, no daemon.
 *   --db <path>        keeper.db path override (else $KEEPER_DB, else the
 *                      ~/.local/state/keeper/keeper.db default).
 *   --help             Show this help.
 *
 * `--apply` and `--snapshot-current` are mutually exclusive.
 *
 * Exit codes:
 *   0 — printed the plan (dry-run), completed the restore (--apply), or emitted
 *       the revive script (--snapshot-current). Zero candidates exits 0.
 *   1 — arguments are malformed/conflicting, or the keeper.db read failed. The
 *       reason goes to stderr.
 */

import { parseArgs } from "node:util";
import { openDb, resolveDbPath } from "../src/db";
import {
  agentwrapLaunch,
  buildAgentwrapLaunchArgv,
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  localeDefaultedEnv,
} from "../src/exec-backend";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "../src/keeper-agent-path";
import {
  deriveCurrentSet,
  deriveLastGenerationSetFromTopology,
  deriveRestoreSet,
  type RestoreCandidate,
} from "../src/restore-set";
import { probeServerGeneration } from "../src/restore-worker";
import { buildResumeCommand } from "../src/resume-descriptor";

const HELP = `restore-agents — replay crash-killed Claude Code agents derived from keeper.db

Usage:
  bun scripts/restore-agents.ts [--session <name>] [--apply] [--last-generation] [--db <path>]
  bun scripts/restore-agents.ts --snapshot-current [--session <name>] [--db <path>] > revive.sh

  --session <name>    Restore only agents from this backend session (default: all)
  --apply             Actually relaunch via ensureLaunched (default: DRY-RUN)
  --last-generation   Bound the crash set to the LAST tmux-server generation
                      window ("the session you just lost"); composes with --apply/--session
  --snapshot-current  Emit a runnable revive script for the CURRENT live set (read-only)
  --db <path>         keeper.db path override ($KEEPER_DB / default otherwise)
  --help              Show this help

Derives the crash-restore candidate set RETROSPECTIVELY from keeper.db: a
killed job whose producer-stamped close_kind reads crash-like, that was live
recently and doesn't already re-occupy a backend. Resumes by the latest session
name (read live from keeper.db, never a frozen one) via the absolute 'keeper
agent' launcher (alias-independent; the session name rides as a positional, so
shell metacharacters are safe), into the original tmux session. Works with
keeperd DOWN — the read is a read-only keeper.db connection with no socket
round-trip.

--last-generation narrows the crash set to the LAST tmux-server generation —
the agents you just lost when the server died — instead of the full 7-day pool,
bounding on the kill-anchored BackendExecStart boundary (falls back to the most-
recent crash burst when no generation boundary is recorded yet).

--snapshot-current is the manual safety net: it reads the CURRENT live set
(every working/stopped session) and emits a runnable bash script that revives
each via the bare 'keeper agent claude --agentwrap-tmux … --resume' argv
(agentwrap owns the session+window), byte-aligned with what --apply spawns. Pipe
it to a file and run it later — a dump you can trust independent of the
automatic crash path.

Restored windows come back in their original visual (left-to-right) tmux order
(by the captured window_index; unknown order sinks to the tail). --apply and
--snapshot-current pace window creation with a 0.5s pause between consecutive
launches.

--apply and --snapshot-current are mutually exclusive. Zero candidates prints a
clear message and exits 0 (nothing to restore).

When --apply runs while autopilot is unpaused, restored tabs are not
'verb::id'-named, so autopilot's fn-674 dedup probe cannot see them and may
double-dispatch — pause autopilot before --apply.
`;

interface ParsedArgs {
  session: string | null;
  apply: boolean;
  snapshotCurrent: boolean;
  lastGeneration: boolean;
  db: string | null;
  help: boolean;
}

/**
 * Outcome of one restore attempt — fed into the summary counts and (for the
 * dry-run path) the per-agent label lines. PURE shape — no I/O leaks out. The
 * candidate carries everything the launch needs: `resume_target` (the latest-name
 * resume key), `backend_exec_session_id` (the tmux session to relaunch into), and
 * `cwd` (the directory the resumed window opens in, set on the `agentwrapLaunch`
 * spawn). `tier` is irrelevant — fn-10 inverted tier routing dropped the
 * `--plugin-dir` flag, so a resume command never carries a tier.
 */
export type AgentOutcome =
  | { kind: "would-restore"; candidate: RestoreCandidate }
  | { kind: "restored"; candidate: RestoreCandidate }
  | { kind: "failed"; candidate: RestoreCandidate; error: string };

const seg = (v: unknown): string => (v == null ? "" : String(v));

function die(message: string): never {
  process.stderr.write(`restore-agents: ${message}\n`);
  process.exit(1);
}

/** Pure: parseArgs wrapper that surfaces a typed shape. */
function parseArgsTyped(argv: string[]): ParsedArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      apply: { type: "boolean", default: false },
      "snapshot-current": { type: "boolean", default: false },
      "last-generation": { type: "boolean", default: false },
      db: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    session: parsed.values.session ?? null,
    apply: parsed.values.apply === true,
    snapshotCurrent: parsed.values["snapshot-current"] === true,
    lastGeneration: parsed.values["last-generation"] === true,
    db: parsed.values.db ?? null,
    help: parsed.values.help === true,
  };
}

/**
 * Pure: turn the candidate set into the per-agent pre-action plan, narrowed by
 * the optional `--session` filter (matched against the candidate's backend
 * session). Candidates arrive already sorted by visual window order from
 * `deriveRestoreSet`, so this preserves that order. The `--apply` path upgrades
 * each `"would-restore"` to `"restored"` / `"failed"`. Exported for tests.
 */
export function planRestore(
  candidates: RestoreCandidate[],
  sessionFilter: string | null,
): AgentOutcome[] {
  const out: AgentOutcome[] = [];
  for (const candidate of candidates) {
    if (
      sessionFilter !== null &&
      candidate.backend_exec_session_id !== sessionFilter
    ) {
      continue;
    }
    out.push({ kind: "would-restore", candidate });
  }
  return out;
}

/**
 * The launch shape the action loop uses. Real binding in `main()` routes through
 * `agentwrapLaunch` in resume mode (keeper's sole launch transport); tests inject
 * a capturing fake so `--apply` can be asserted without spawning a real
 * multiplexer. Carries the RESUME TARGET (not a pre-wrapped argv) — agentwrap
 * builds the `--resume <target>` invocation and owns the tmux window, mirroring
 * the `keeper bus wake` seam.
 */
export type EnsureLaunchedFn = (
  session: string,
  resumeTarget: string,
  cwd: string,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Sleep injection for {@link applyRestore} — `main()` passes the real
 * `Bun.sleep`, tests pass a no-op so the apply suite never actually waits. The
 * pause spaces out window creation so a burst of launches don't race the
 * multiplexer.
 */
export type SleepFn = (ms: number) => Promise<void>;

/** Inter-window pacing for restore (ms). Held between consecutive real launches
 * only — never before the first or after the last. */
export const INTER_WINDOW_PAUSE_MS = 500;

/** Real sleep binding `main()` injects into {@link applyRestore}. */
const defaultSleep: SleepFn = (ms) => Bun.sleep(ms);

/**
 * Pure-ish: drive the plan through `ensureLaunched`, upgrading each
 * `"would-restore"` to `"restored"` or `"failed"`. Continues past a single
 * agent's launch failure (don't abort the batch — one busted tab shouldn't
 * strand the rest). Pauses {@link INTER_WINDOW_PAUSE_MS} via the injected
 * `sleep` BETWEEN consecutive launches only (never before the first or after
 * the last) — the pacing sits OUTSIDE the per-agent try/catch so one launch
 * failure doesn't drop the next agent's pause.
 *
 * Exported for tests — they pass a capturing fake `ensureLaunched` plus a
 * no-op `sleep` so `--apply` is asserted without a real multiplexer or a wait.
 */
export async function applyRestore(
  plan: AgentOutcome[],
  ensureLaunched: EnsureLaunchedFn,
  sleep: SleepFn = defaultSleep,
): Promise<AgentOutcome[]> {
  const out: AgentOutcome[] = [];
  let launched = 0;
  for (const entry of plan) {
    if (entry.kind !== "would-restore") {
      out.push(entry);
      continue;
    }
    // Pace BETWEEN real launches: pause before every launch after the first.
    if (launched > 0) {
      await sleep(INTER_WINDOW_PAUSE_MS);
    }
    launched++;
    const cwd = entry.candidate.cwd == null ? "" : seg(entry.candidate.cwd);
    const session = entry.candidate.backend_exec_session_id;
    try {
      const res = await ensureLaunched(
        session,
        entry.candidate.resume_target,
        cwd,
      );
      if (res.ok) {
        out.push({ kind: "restored", candidate: entry.candidate });
      } else {
        out.push({
          kind: "failed",
          candidate: entry.candidate,
          error: res.error,
        });
      }
    } catch (err) {
      out.push({
        kind: "failed",
        candidate: entry.candidate,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

/**
 * Pure renderer: turn the outcome list into the stdout block. One stanza per
 * agent (a `#` comment label line — keyed by the candidate's `label` (the
 * latest title, falling back to the job_id) — plus the resume command)
 * followed by a trailing `# summary:` line. When `excludedIdleCount > 0` a
 * trailing note surfaces the idle-excluded count (a false-negative we make
 * visible, never a silent drop). Exported for tests so the rendering shape is
 * locked down without parsing real stdout.
 */
export function renderOutcomes(
  outcomes: AgentOutcome[],
  apply: boolean,
  excludedIdleCount: number,
): string {
  const stanzas: string[] = [];
  let restored = 0;
  let failed = 0;
  let wouldRestore = 0;

  for (const o of outcomes) {
    const c = o.candidate;
    const cwd = c.cwd == null ? "" : seg(c.cwd);
    const cmd = buildResumeCommand(cwd, c.resume_target, null);
    const session = c.backend_exec_session_id;
    if (o.kind === "would-restore") {
      wouldRestore++;
      stanzas.push(`# (${session}) would restore ${c.label}\n${cmd}`);
    } else if (o.kind === "restored") {
      restored++;
      stanzas.push(`# (${session}) restored ${c.label}\n${cmd}`);
    } else {
      failed++;
      stanzas.push(`# (${session}) FAILED ${c.label}: ${o.error}\n${cmd}`);
    }
  }

  const summary = apply
    ? `# summary: restored=${restored} failed=${failed}`
    : `# summary: would-restore=${wouldRestore}`;
  const idleNote =
    excludedIdleCount > 0
      ? `\n# note: ${excludedIdleCount} crash-like candidate(s) excluded as idle past the cutoff`
      : "";

  return stanzas.length > 0
    ? `${stanzas.join("\n\n")}\n\n${summary}${idleNote}\n`
    : `${summary}${idleNote}\n`;
}

/**
 * Pure: POSIX single-quote-escape one argv token for safe embedding in the
 * generated `--snapshot-current` shell script. Wraps in single quotes and
 * renders any embedded single quote as the `'\''` close-escape-reopen idiom —
 * the only metacharacter a single-quoted string doesn't already neutralize, so
 * tmux metachars (`;`, `#{pane_id}`) and the resume body's double quotes reach
 * tmux literally. An empty string becomes `''`. Exported for tests.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pure renderer: turn the CURRENT live candidate set into a RUNNABLE bash script
 * that revives each session via the SAME `agentwrapLaunch` transport `--apply`
 * uses. Each candidate emits the BARE `buildAgentwrapLaunchArgv` resume argv
 * (`keeper agent claude --agentwrap-tmux … --resume <target>`) shell-quoted —
 * byte-aligned with what `--apply` spawns, with NO `tmux new-window` wrapper
 * (agentwrap creates its OWN session+window; a `new-window` wrapper would
 * DOUBLE-create). A `cd <cwd> &&` prefix sets the directory agentwrap reads from
 * `process.cwd()` (the `--apply` path sets it on the spawn). Each session is
 * still preceded by a redundant-but-explicit `has-session || new-session`
 * get-or-create guard so the script reads self-contained even though agentwrap
 * mints the session itself.
 *
 * Sessions emit in alpha order; candidates within a session in the visual window
 * order `deriveCurrentSet` already sorted them into. A `sleep 0.5` line separates
 * consecutive launches (tracked globally across session boundaries — never before
 * the first or after the last) so the revived windows don't race the multiplexer.
 * `sleep 0.5` is portable across BSD/GNU with a dot decimal. Every argv token is
 * single-quoted via {@link shellQuote}. The `--session` filter narrows to one
 * bucket. Exported for tests.
 */
export function renderSnapshotScript(
  candidates: RestoreCandidate[],
  sessionFilter: string | null,
  prefix: string[],
  sourcePath: string,
): string {
  const quoteArgv = (args: string[]): string => args.map(shellQuote).join(" ");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# restore-agents --snapshot-current — runnable snapshot of the CURRENT live set.",
    `# Source: ${sourcePath}. Pipe to a file and run to revive these tabs.`,
    "# Each window relaunches via agentwrap claude --resume by its LATEST name; the session is get-or-created.",
    "set -euo pipefail",
  ];
  // Group candidates by backend session, preserving the incoming visual order
  // (deriveCurrentSet already sorted by window_index, so each bucket stays in
  // left-to-right order).
  const bySession = new Map<string, RestoreCandidate[]>();
  for (const c of candidates) {
    const sess = c.backend_exec_session_id;
    if (sessionFilter !== null && sess !== sessionFilter) {
      continue;
    }
    const bucket = bySession.get(sess);
    if (bucket === undefined) {
      bySession.set(sess, [c]);
    } else {
      bucket.push(c);
    }
  }
  let sessionCount = 0;
  // Tracks whether any launch has been emitted yet, ACROSS session boundaries —
  // `sleep 0.5` precedes every launch after the first, so it lands strictly
  // between consecutive launches (no leading or trailing sleep).
  let windowsEmitted = 0;
  for (const sessionName of [...bySession.keys()].sort()) {
    const bucket = bySession.get(sessionName);
    if (bucket === undefined || bucket.length === 0) {
      continue;
    }
    sessionCount++;
    const n = bucket.length;
    lines.push("");
    lines.push(`# session: ${sessionName} (${n} window${n === 1 ? "" : "s"})`);
    // Get-or-create the session up front. agentwrap also mints it, so this is
    // redundant — kept so the script reads self-contained. `|| ` keeps `set -e`
    // from tripping when has-session exits non-zero (session absent).
    lines.push(
      `${quoteArgv(buildTmuxHasSessionArgs(sessionName))} 2>/dev/null || ` +
        `${quoteArgv(buildTmuxNewSessionArgs(sessionName))}`,
    );
    for (const candidate of bucket) {
      const cwd = candidate.cwd == null ? "" : seg(candidate.cwd);
      // The BARE agentwrap resume argv — byte-aligned with what --apply spawns.
      // agentwrap owns the session+window, so NO `tmux new-window` wrapper.
      const launchArgv = buildAgentwrapLaunchArgv({
        launcherArgvPrefix: prefix,
        session: sessionName,
        prompt: "",
        resumeTarget: candidate.resume_target,
        noConfirm: true,
      });
      if (windowsEmitted > 0) {
        lines.push("sleep 0.5");
      }
      lines.push(`# ${candidate.label}`);
      // `cd <cwd> &&` sets agentwrap's process.cwd() (the directory it reads for
      // the launch-script `cd`); the --apply path sets it on the spawn instead.
      const cdPrefix = cwd === "" ? "" : `cd ${shellQuote(cwd)} && `;
      lines.push(`${cdPrefix}${quoteArgv(launchArgv)}`);
      windowsEmitted++;
    }
  }
  lines.push("");
  lines.push(
    `# summary: snapshot-current sessions=${sessionCount} windows=${windowsEmitted}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Derive the crash-restore candidate set from a read-only `keeper.db`
 * connection in ONE open span: open, `deriveRestoreSet`, close. The candidate
 * shape already carries everything the launch needs (`resume_target`, `cwd`,
 * `backend_exec_session_id`, ordered by `window_index`), so no second read is
 * needed. Re-throws on an open failure (the caller maps it to `die`). Exported
 * for tests so the read path is assertable against a seeded DB.
 */
export function loadRestoreSet(dbPath: string): {
  candidates: RestoreCandidate[];
  excludedIdleCount: number;
} {
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const set = deriveRestoreSet(db);
    return {
      candidates: set.candidates,
      excludedIdleCount: set.excludedIdleCount,
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the script is one-shot and exits next.
    }
  }
}

/**
 * Probe `G_now` — the CURRENT tmux server pid — at restore time via
 * {@link probeServerGeneration}, wrapped in the LOAD-BEARING locale default (a
 * C-locale daemon client corrupts tmux output). Returns the pid string, or
 * `null` when no server is up / the probe degrades. The topology deriver excludes
 * the snapshot of this (still-running) generation, isolating the dying one.
 * Injectable for tests.
 */
export type ProbeGenerationFn = () => string | null;

const defaultProbeGeneration: ProbeGenerationFn = () =>
  probeServerGeneration((cmd) =>
    Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "ignore",
      env: localeDefaultedEnv(
        process.env as Record<string, string | undefined>,
      ),
    }),
  );

/**
 * Read the LAST-GENERATION crash-restore set off a read-only `keeper.db` in one
 * open span — the `--last-generation` source. PRIMARY path: derive from the
 * DYING generation's last `TmuxTopologySnapshot`
 * ({@link deriveLastGenerationSetFromTopology}), selected by probing `G_now`
 * (the current server pid) and excluding its still-live snapshot. When no
 * dying-generation snapshot survives, the deriver degrades to the retrospective
 * killed-cohort model and sets `fallbackNote` (a VISIBLE degraded-restore
 * banner). Re-throws on open failure (the caller maps it to `die`). `probeNow`
 * is injectable for tests; production probes the live server. Exported for tests
 * so the read path is assertable against a seeded DB.
 */
export function loadLastGenerationSet(
  dbPath: string,
  probeNow: ProbeGenerationFn = defaultProbeGeneration,
): {
  candidates: RestoreCandidate[];
  excludedIdleCount: number;
  fallbackNote?: string;
} {
  const currentGenerationId = probeNow();
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const set = deriveLastGenerationSetFromTopology(db, {
      currentGenerationId,
    });
    return {
      candidates: set.candidates,
      excludedIdleCount: set.excludedIdleCount,
      fallbackNote: set.fallbackNote,
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the script is one-shot and exits next.
    }
  }
}

/**
 * Read the CURRENT live set (every `working`/`stopped` session with backend
 * coords) off a read-only `keeper.db` in one open span — the `--snapshot-current`
 * source. Re-throws on open failure (the caller maps it to `die`). Exported for
 * tests so the read path is assertable against a seeded DB.
 */
export function loadCurrentSet(dbPath: string): RestoreCandidate[] {
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    return deriveCurrentSet(db);
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the script is one-shot and exits next.
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgsTyped(Bun.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (args.apply && args.snapshotCurrent) {
    die("--apply and --snapshot-current are mutually exclusive");
  }

  const dbPath = args.db ?? resolveDbPath();
  // The absolute `keeper agent` launcher prefix — PATH-independent, so a
  // restored tab never depends on the `claude` alias. `agentwrapLaunch` builds
  // the `claude --agentwrap-tmux … --resume <target>` invocation off it.
  const launcherPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolveKeeperAgentPathDepFree(),
  );

  // --snapshot-current: emit a runnable revive script for the CURRENT live set
  // (every working/stopped session), independent of the crash-derivation path —
  // the manual safety net. Pure local read: no crash-membership filtering, no
  // daemon round-trip.
  if (args.snapshotCurrent) {
    let current: RestoreCandidate[];
    try {
      current = loadCurrentSet(dbPath);
    } catch (err) {
      die(`failed to open keeper.db at ${dbPath}: ${(err as Error).message}`);
    }
    process.stdout.write(
      renderSnapshotScript(current, args.session, launcherPrefix, dbPath),
    );
    process.exit(0);
  }

  // --last-generation bounds the crash set to the kill-anchored generation
  // window ("the session you just lost"); it composes with --apply and --session
  // by swapping ONLY which load feeds the candidate set — the plan/render/apply
  // path is identical.
  let candidates: RestoreCandidate[];
  let excludedIdleCount: number;
  let fallbackNote: string | undefined;
  try {
    if (args.lastGeneration) {
      const set = loadLastGenerationSet(dbPath);
      candidates = set.candidates;
      excludedIdleCount = set.excludedIdleCount;
      fallbackNote = set.fallbackNote;
    } else {
      const set = loadRestoreSet(dbPath);
      candidates = set.candidates;
      excludedIdleCount = set.excludedIdleCount;
    }
  } catch (err) {
    die(`failed to open keeper.db at ${dbPath}: ${(err as Error).message}`);
  }

  // Surface the degraded-restore banner BEFORE the plan (mirrors the [paused]
  // convention) so a topology-anchored miss is never silent. Goes to stderr so
  // it never pollutes a `--snapshot-current`-style stdout consumer.
  if (fallbackNote !== undefined) {
    process.stderr.write(`restore-agents: [fallback] ${fallbackNote}\n`);
  }

  const plan = planRestore(candidates, args.session);

  if (!args.apply) {
    if (plan.length === 0) {
      process.stdout.write(
        "# restore-agents: no crash-restore candidates (nothing to restore)\n",
      );
    }
    process.stdout.write(renderOutcomes(plan, false, excludedIdleCount));
    process.exit(0);
  }

  // --apply path. Route every candidate through keeper's sole launch transport —
  // `agentwrapLaunch` in resume mode (the same seam `keeper bus wake` uses).
  // agentwrap mints/owns the recorded `backend_exec_session_id` and re-attaches
  // via `--resume <target>`; cwd is set on the spawn (agentwrap has no cwd flag).
  // Per-candidate failure isolation rides on the returned LaunchResult verdict.
  const noteLine = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const ensureLaunched: EnsureLaunchedFn = (session, resumeTarget, cwd) =>
    agentwrapLaunch({
      noteLine,
      launcherArgvPrefix: launcherPrefix,
      session,
      cwd,
      label: `restore resume ${resumeTarget}`,
      spec: { prompt: "", resumeTarget },
    });

  const outcomes = await applyRestore(plan, ensureLaunched, defaultSleep);
  process.stdout.write(renderOutcomes(outcomes, true, excludedIdleCount));
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
