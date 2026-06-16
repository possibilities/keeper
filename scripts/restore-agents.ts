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
 * resume key is the job's `job_id` UUID, never its (mutable) session name, so a
 * RENAMED session restores correctly.
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
 *   bun scripts/restore-agents.ts [--session <name>] [--apply] [--db <path>]
 *
 *   --session <name>   Restore only agents from this backend session. Default:
 *                      all sessions in the candidate set.
 *   --apply            Actually relaunch via `ensureLaunched`. Default is
 *                      DRY-RUN — print what would be restored, touch nothing.
 *   --db <path>        keeper.db path override (else $KEEPER_DB, else the
 *                      ~/.local/state/keeper/keeper.db default).
 *   --help             Show this help.
 *
 * Exit codes:
 *   0 — printed the plan (dry-run) or completed the restore (--apply).
 *       Zero candidates is "nothing to restore" and exits 0.
 *   1 — arguments are malformed, or the keeper.db read failed. The reason goes
 *       to stderr.
 */

import { parseArgs } from "node:util";
import { openDb, resolveDbPath } from "../src/db";
import { type ExecBackend, resolveExecBackend } from "../src/exec-backend";
import { deriveRestoreSet, type RestoreCandidate } from "../src/restore-set";
import { buildResumeCommand } from "../src/resume-descriptor";

const HELP = `restore-agents — replay crash-killed Claude Code agents derived from keeper.db

Usage:
  bun scripts/restore-agents.ts [--session <name>] [--apply] [--db <path>]

  --session <name>    Restore only agents from this backend session (default: all)
  --apply             Actually relaunch via ensureLaunched (default: DRY-RUN)
  --db <path>         keeper.db path override ($KEEPER_DB / default otherwise)
  --help              Show this help

Derives the crash-restore candidate set RETROSPECTIVELY from keeper.db: a
killed job whose producer-stamped close_kind reads crash-like, that was live
recently and doesn't already re-occupy a backend. Resumes by the job_id UUID
(rename-proof) wrapped in the same shell prologue scripts/resume.ts emits, into
the original tmux session. Works with keeperd DOWN — the read is a read-only
keeper.db connection with no socket round-trip.

Restored windows come back in their original visual (left-to-right) tmux order
(by the captured window_index; unknown order sinks to the tail). --apply paces
window creation with a 0.5s pause between consecutive launches.

Zero candidates prints a clear message and exits 0 (nothing to restore).

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
  db: string | null;
  help: boolean;
}

/**
 * Outcome of one restore attempt — fed into the summary counts and (for the
 * dry-run path) the per-agent label lines. PURE shape — no I/O leaks out. The
 * candidate carries everything the launch needs: `resume_target` (the job_id
 * UUID resume key), `backend_exec_session_id` (the tmux session to relaunch
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
      db: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    session: parsed.values.session ?? null,
    apply: parsed.values.apply === true,
    db: parsed.values.db ?? null,
    help: parsed.values.help === true,
  };
}

/**
 * Pure: assemble the agent's resume shell command. Wraps it in the same
 * `$SHELL -l -i -c "<cmd> ; exec $SHELL -l -i"` prologue the autopilot
 * worker's `buildLaunchArgv` uses, so a freshly minted tab survives the
 * `claude` process exiting (you keep a login shell). The resume key is the
 * candidate's `resume_target` (the job_id UUID). The shell is injected for
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

async function main(): Promise<void> {
  const args = parseArgsTyped(Bun.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const dbPath = args.db ?? resolveDbPath();
  let candidates: RestoreCandidate[];
  let excludedIdleCount: number;
  try {
    const set = loadRestoreSet(dbPath);
    candidates = set.candidates;
    excludedIdleCount = set.excludedIdleCount;
  } catch (err) {
    die(`failed to open keeper.db at ${dbPath}: ${(err as Error).message}`);
  }

  const shell = process.env.SHELL ?? DEFAULT_SHELL;
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

  // --apply path. Resolve ONE tmux backend instance (tmux is the sole backend);
  // route every candidate through it.
  const noteLine = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const backend: ExecBackend = resolveExecBackend({ noteLine });
  const ensureLaunched: EnsureLaunchedFn = (session, argv, cwd) =>
    backend.ensureLaunched(session, argv, cwd);

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
