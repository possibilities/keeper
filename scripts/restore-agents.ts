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
 * via `ExecBackend.ensureLaunched` (T2) using the resume command
 * `scripts/resume.ts` and the restore worker already agree on
 * (`buildResumeCommand` / `resumeTarget` — the shared `src/resume-descriptor`
 * substrate that makes the three resume-command producers byte-identical). The
 * resume key is the job's LATEST name (`title`, `job_id` fallback) — read live
 * from the jobs projection at restore time, never a frozen one — so a renamed
 * session restores to the name keeper currently knows.
 *
 * The candidate set already excludes any `job_id` still occupying a live
 * backend (`restore-set.ts`'s UUID-liveness dedup, computed from the same DB
 * read) — so there is no UDS round-trip and no separate skip-set probe. tmux
 * is the sole exec backend, so every candidate routes through one resolved
 * backend instance.
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
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  buildTmuxNewWindowArgs,
  restoreReplayLaunch,
} from "../src/exec-backend";
import {
  deriveCurrentSet,
  deriveLastGenerationSet,
  deriveRestoreSet,
  type RestoreCandidate,
} from "../src/restore-set";
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
name (read live from keeper.db, never a frozen one) wrapped in the same shell
prologue scripts/resume.ts emits, into the original tmux session. Works with
keeperd DOWN — the read is a read-only keeper.db connection with no socket
round-trip.

--last-generation narrows the crash set to the LAST tmux-server generation —
the agents you just lost when the server died — instead of the full 7-day pool,
bounding on the kill-anchored BackendExecStart boundary (falls back to the most-
recent crash burst when no generation boundary is recorded yet).

--snapshot-current is the manual safety net: it reads the CURRENT live set
(every working/stopped session) and emits a runnable bash script that revives
each into its own tmux window (get-or-create the session first), byte-aligned
with what --apply spawns. Pipe it to a file and run it later — a dump you can
trust independent of the automatic crash path.

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

/**
 * Default `$SHELL` fallback used when env isn't set (e.g. when invoked from
 * a barebones LaunchAgent). Mirrors the autopilot worker's resolution.
 */
const DEFAULT_SHELL = "/bin/zsh" as const;

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
 * resume key), `backend_exec_session_id` (the tmux session to relaunch
 * into), and `cwd` (to `cd` into before `claude --resume`). `tier` is irrelevant
 * — fn-10 inverted tier routing dropped the `--plugin-dir` flag, so a resume
 * command never carries a tier.
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
 * Pure: assemble the agent's resume shell command. Wraps it in the same
 * `$SHELL -l -i -c "<cmd> ; exec $SHELL -l -i"` prologue the autopilot
 * worker's `buildLaunchArgv` uses, so a freshly minted tab survives the
 * `claude` process exiting (you keep a login shell). The resume key is the
 * candidate's `resume_target` (the latest name). The shell is injected for
 * testability — the live util passes `process.env.SHELL ?? DEFAULT_SHELL`.
 *
 * Exported for tests.
 */
export function buildResumeLaunchArgv(
  shell: string,
  candidate: RestoreCandidate,
): string[] {
  const cwd = candidate.cwd == null ? "" : seg(candidate.cwd);
  // fn-10: the resume command no longer carries a tier-plugin flag, so tier is
  // always null on the restore path.
  const workerCommand = buildResumeCommand(cwd, candidate.resume_target, null);
  const body = `${workerCommand} ; exec ${shell} -l -i`;
  return [shell, "-l", "-i", "-c", body];
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
 * The `ensureLaunched` shape the action loop uses. Real binding in `main()`
 * routes through the resolved tmux backend's `ensureLaunched`; tests inject a
 * capturing fake so `--apply` can be asserted without spawning a real
 * multiplexer.
 */
export type EnsureLaunchedFn = (
  session: string,
  argv: string[],
  cwd: string,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Sleep injection for {@link applyRestore} — `main()` passes the real
 * `Bun.sleep`, tests pass a no-op so the apply suite never actually waits. The
 * pause spaces out window creation so a burst of `new-window` launches don't
 * race the multiplexer.
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
  shell: string,
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
    const argv = buildResumeLaunchArgv(shell, entry.candidate);
    const cwd = entry.candidate.cwd == null ? "" : seg(entry.candidate.cwd);
    const session = entry.candidate.backend_exec_session_id;
    try {
      const res = await ensureLaunched(session, argv, cwd);
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
 * that revives each session into its own tmux window. Byte-aligned with what
 * `--apply` spawns — the same `buildResumeLaunchArgv` inner argv wrapped in the
 * same `buildTmuxNewWindowArgs` new-window — but preceded by a per-session
 * `has-session || new-session` get-or-create guard and emitted as shell text, so
 * it can be piped to a file and run later (daemon-independent).
 *
 * Sessions emit in alpha order; candidates within a session in the visual window
 * order `deriveCurrentSet` already sorted them into. A `sleep 0.5` line separates
 * consecutive `new-window` emissions (tracked globally across session boundaries
 * — never before the first window or after the last) so the revived windows don't
 * race the multiplexer. `sleep 0.5` is portable across BSD/GNU with a dot decimal.
 * Every argv token is single-quoted via {@link shellQuote}. The `--session` filter
 * narrows to one bucket. Exported for tests.
 */
export function renderSnapshotScript(
  candidates: RestoreCandidate[],
  sessionFilter: string | null,
  shell: string,
  sourcePath: string,
): string {
  const quoteArgv = (args: string[]): string => args.map(shellQuote).join(" ");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# restore-agents --snapshot-current — runnable snapshot of the CURRENT live set.",
    `# Source: ${sourcePath}. Pipe to a file and run to revive these tabs.`,
    "# Each window relaunches via claude --resume by its LATEST name; the session is get-or-created.",
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
  // Tracks whether any new-window has been emitted yet, ACROSS session boundaries
  // — `sleep 0.5` precedes every new-window after the first, so it lands strictly
  // between consecutive windows (no leading or trailing sleep).
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
    // Get-or-create the session so the new-window targets land. `|| ` keeps
    // `set -e` from tripping when has-session exits non-zero (session absent).
    lines.push(
      `${quoteArgv(buildTmuxHasSessionArgs(sessionName))} 2>/dev/null || ` +
        `${quoteArgv(buildTmuxNewSessionArgs(sessionName))}`,
    );
    for (const candidate of bucket) {
      const cwd = candidate.cwd == null ? "" : seg(candidate.cwd);
      const innerArgv = buildResumeLaunchArgv(shell, candidate);
      // No window name — mirrors --apply (ensureLaunched passes none), so the
      // revived window stays unnamed and the renamer worker labels it later.
      if (windowsEmitted > 0) {
        lines.push("sleep 0.5");
      }
      lines.push(`# ${candidate.label}`);
      lines.push(
        quoteArgv(buildTmuxNewWindowArgs(sessionName, cwd, innerArgv)),
      );
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
 * Read the LAST-GENERATION crash-restore set off a read-only `keeper.db` in one
 * open span — the `--last-generation` source. Same membership/filters as
 * {@link loadRestoreSet}, bounded to the kill-anchored generation window (see
 * {@link deriveLastGenerationSet}). Re-throws on open failure (the caller maps
 * it to `die`). Exported for tests so the read path is assertable against a
 * seeded DB.
 */
export function loadLastGenerationSet(dbPath: string): {
  candidates: RestoreCandidate[];
  excludedIdleCount: number;
} {
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const set = deriveLastGenerationSet(db);
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
  const shell = process.env.SHELL ?? DEFAULT_SHELL;

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
      renderSnapshotScript(current, args.session, shell, dbPath),
    );
    process.exit(0);
  }

  // --last-generation bounds the crash set to the kill-anchored generation
  // window ("the session you just lost"); it composes with --apply and --session
  // by swapping ONLY which load feeds the candidate set — the plan/render/apply
  // path is identical.
  let candidates: RestoreCandidate[];
  let excludedIdleCount: number;
  try {
    const set = args.lastGeneration
      ? loadLastGenerationSet(dbPath)
      : loadRestoreSet(dbPath);
    candidates = set.candidates;
    excludedIdleCount = set.excludedIdleCount;
  } catch (err) {
    die(`failed to open keeper.db at ${dbPath}: ${(err as Error).message}`);
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

  // --apply path. The restore replay is the ONE surviving direct tmux launch —
  // route every candidate through the `restoreReplayLaunch` seam (a spec-less
  // get-or-create + new-window of the recorded shell-wrapped argv).
  const noteLine = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const ensureLaunched: EnsureLaunchedFn = (session, argv, cwd) =>
    restoreReplayLaunch(session, argv, cwd, { noteLine });

  const outcomes = await applyRestore(
    plan,
    ensureLaunched,
    shell,
    defaultSleep,
  );
  process.stdout.write(renderOutcomes(outcomes, true, excludedIdleCount));
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
