#!/usr/bin/env bun
/**
 * resume — print a `claude --resume` command for every job in the `jobs`
 * namespace (the same projection `keeper jobs` renders). The sibling of
 * `scripts/commands.ts`: where that one reads a single planctl id off the
 * `epics` namespace and prints the autopilot dispatch command pair, this one
 * sweeps the `jobs` collection and prints, per job, the shell command that
 * re-attaches to that session:
 *
 *   cd <cwd> && claude [--plugin-dir <tier-dir>] --resume "<session-name>"
 *
 * The descriptor-building primitives — `resumeTarget` / `buildResumeCommand` /
 * `tierForJobFromEpics` — live in the shared `src/resume-descriptor.ts`
 * module. That module exposes ONE DISPLAY form (`buildResumeCommand`, the bare
 * `claude --resume` string THIS script prints); the launch surfaces
 * (`keeper bus wake` + `scripts/restore-agents.ts`) resume via `agentwrapLaunch`
 * in resume mode (`src/exec-backend.ts`), which builds the `--resume` argv
 * itself. This script is the DISPLAY producer. It keeps the lazy per-epic UDS fetch loop (one
 * round-trip per distinct work-job epic, memoized) because it's read-on-
 * demand against the daemon; the restore worker subscribes the full epics
 * projection once and feeds the pure helper its in-memory map instead.
 *
 * Scope mirrors `keeper jobs`: by default only LIVE jobs (running + stopped)
 * are listed — terminal `ended`/`killed` rows are hidden unless `--all` is
 * passed. Each job is printed as a `#`-comment label line (cwd basename +
 * title + role + state, the jobs-view shape) followed by its resume command,
 * so the output pastes straight into a shell.
 *
 * Like `commands.ts` / `approve.ts`, this is a short-lived one-shot read over
 * fresh `Bun.connect` round-trips: one `query` for the job list, then one
 * cached `query` per distinct work-job epic for the tier. No subscription —
 * if the daemon is down, `Bun.connect` rejects and the CLI fails fast.
 *
 * Usage:
 *   bun scripts/resume.ts [--sock <path>] [--all]
 *
 *   --sock <path>  Socket path override (else $KEEPER_SOCK, else the
 *                  ~/.local/state/keeper/keeperd.sock default).
 *   --all          Include terminal (`ended` / `killed`) jobs too.
 *   --help         Show this help.
 *
 * Exit codes:
 *   0 — the resume commands were printed to stdout (zero jobs prints
 *       nothing and still exits 0).
 *   1 — the daemon is down, the server returned `error`, a response never
 *       arrived before the deadline, or the arguments are malformed. The
 *       reason goes to stderr.
 */

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import {
  buildResumeCommand,
  resumeTarget,
  tierForJobFromEpics,
} from "../src/resume-descriptor";
import type { Epic, Job } from "../src/types";

/**
 * Hard upper bound on how long the CLI waits for a `result` frame after a
 * successful connect. Mirrors `commands.ts` / `approve.ts` — a healthy daemon
 * answers in well under a millisecond on local UDS; 5s is generous and avoids
 * a blocked client wedging forever.
 */
const RESPONSE_TIMEOUT_MS = 5000;

const HELP = `resume — print a 'claude --resume' command for every job in 'keeper jobs'

Usage: bun scripts/resume.ts [--sock <path>] [--all]

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --all          Include terminal (ended / killed) jobs, not just live ones
  --help         Show this help

Output (per job, two lines):
  # ({cwd-basename}) {title} [{role}]? [{state}]
  cd <cwd> && claude [--plugin-dir <tier-dir>] --resume "<session-name>"

--resume uses the job's latest session name (keeper's title) so 'claude
--resume' filters the /resume picker straight to it; a job with no name falls
back to its session id. The --plugin-dir tier directory is reconstructed only
for 'work'-bound jobs (looked up off the owning epic's task, exactly as
scripts/commands.ts does); every other job gets the plain
'cd <cwd> && claude --resume "<session-name>"' form.

On success: prints the commands to stdout and exits 0 (zero jobs → no output).
On failure (daemon down, timeout, malformed args): prints the reason to
stderr and exits 1.
`;

const seg = (v: unknown): string => (v == null ? "" : String(v));

function die(message: string): never {
  process.stderr.write(`resume: ${message}\n`);
  process.exit(1);
}

/**
 * One round-trip on a fresh UDS connection: open, write `send`, wait for the
 * server frame whose `id === matchId`, return it. Copied from `commands.ts`'s
 * `roundTrip` (not exported there) — connection-local `LineBuffer` so a
 * partial line never crosses round-trips; rejects with a human-readable
 * `Error` on connect-fail, transport error, malformed frame, server-side
 * close before reply, or `RESPONSE_TIMEOUT_MS` elapsing post-connect.
 */
async function roundTrip(
  sockPath: string,
  send: ClientFrame,
  matchId: string,
): Promise<ServerFrame> {
  return new Promise<ServerFrame>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const settle = (err: Error | null, frame: ServerFrame | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (err) {
        reject(err);
      } else if (frame) {
        resolve(frame);
      } else {
        reject(new Error("internal: settle called with neither err nor frame"));
      }
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${RESPONSE_TIMEOUT_MS}ms (id ${matchId})`,
        ),
        null,
      );
    }, RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          s.write(encodeFrame(send));
        },
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            settle(
              new Error(`protocol error: ${(err as Error).message}`),
              null,
            );
            return;
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            let frame: ServerFrame;
            try {
              frame = JSON.parse(line) as ServerFrame;
            } catch (err) {
              settle(
                new Error(`malformed server frame: ${(err as Error).message}`),
                null,
              );
              return;
            }
            if ((frame as { id?: string }).id !== matchId) {
              continue;
            }
            settle(null, frame);
            return;
          }
        },
        close() {
          settle(
            new Error(
              `daemon closed connection before responding (id ${matchId})`,
            ),
            null,
          );
        },
        error(_s, err) {
          settle(new Error(`socket error: ${err.message}`), null);
        },
      },
    }).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
}

/**
 * Fetch the job list from the `jobs` collection. With no filter the server's
 * default scope applies (live jobs only — running + stopped, terminal rows
 * hidden), matching what `keeper jobs` shows; `--all` overrides it with an
 * explicit all-states `in` set. `limit: 0` is the "no row cap" sentinel so
 * the full set comes back in one page. Newest-created first (the collection's
 * `created_at desc` default sort).
 */
async function fetchJobs(sockPath: string, all: boolean): Promise<Job[]> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      {
        type: "query",
        collection: "jobs",
        id: queryId,
        filter: all
          ? { state: { in: ["working", "stopped", "ended", "killed"] } }
          : undefined,
        limit: 0,
      },
      queryId,
    );
  } catch (err) {
    die((err as Error).message);
  }
  if (frame.type === "error") {
    die(`server error ${frame.code}: ${frame.message}`);
  }
  if (frame.type !== "result") {
    die(`unexpected frame type for jobs query: ${frame.type}`);
  }
  return frame.rows as unknown as Job[];
}

/**
 * Soft epic fetch by pk for the tier lookup — returns `null` instead of dying
 * when the epic is gone (a work job can outlive a deleted epic). A pk-filter
 * `query` bypasses the server's default scope so the epic resolves regardless
 * of its own status/approval (mirrors `commands.ts`'s `fetchEpic`, minus the
 * fatal not-found). Transport / server-error frames still die — those mean the
 * daemon is unhealthy, not that this one epic is absent.
 */
async function fetchEpic(
  sockPath: string,
  epicId: string,
): Promise<Epic | null> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      {
        type: "query",
        collection: "epics",
        id: queryId,
        filter: { epic_id: epicId },
        limit: 1,
      },
      queryId,
    );
  } catch (err) {
    die((err as Error).message);
  }
  if (frame.type === "error") {
    die(`server error ${frame.code}: ${frame.message}`);
  }
  if (frame.type !== "result") {
    die(`unexpected frame type for epic query: ${frame.type}`);
  }
  if (frame.rows.length === 0) {
    return null;
  }
  return frame.rows[0] as unknown as Epic;
}

/**
 * Resolve a `work`-bound job's tier the way autopilot's dispatch knows it:
 * the job's `plan_ref` is the task id (`<epic-slug>.<N>`); strip the suffix
 * for the epic id, fetch the epic (memoized per epic across jobs so a busy
 * epic costs one round-trip), find the task, return `task.tier`. Returns
 * `null` for any job that isn't a `work` job, has no parseable task ref, or
 * whose epic/task can't be found — those render without a `--plugin-dir`.
 *
 * Mixed lazy-fetch + pure-core: this function owns the per-epic UDS fetch
 * loop (one round-trip per distinct work-job epic, memoized via `epicCache`)
 * and delegates the actual epic→task→tier lookup to the shared pure
 * `tierForJobFromEpics` so this script and the restore worker (epic fn-677)
 * agree on tier resolution by construction.
 */
async function tierForJob(
  sockPath: string,
  job: Job,
  epicCache: Map<string, Epic | null>,
): Promise<string | null> {
  if (job.plan_verb !== "work" || job.plan_ref == null) {
    return null;
  }
  const ref = seg(job.plan_ref);
  const taskMatch = /^(.+)\.\d+$/.exec(ref);
  if (taskMatch === null) {
    return null;
  }
  const epicId = taskMatch[1];
  let epic = epicCache.get(epicId);
  if (epic === undefined) {
    epic = await fetchEpic(sockPath, epicId);
    epicCache.set(epicId, epic);
  }
  if (epic === null) {
    return null;
  }
  // Build a single-entry map for the pure helper. The map shape is what the
  // restore worker passes too (its full epicsById), so both paths land on
  // identical resolution semantics.
  const singletonMap = new Map<string, Epic>([[epicId, epic]]);
  return tierForJobFromEpics(job, singletonMap);
}

/**
 * The `#`-comment label line for a job — the jobs-view row shape
 * (`({cwd-basename}) {title} [{role}]? [{state}]`), prefixed with `# ` so it
 * is shell-inert above its command. The `(cwd)` prefix and the `[role]` pill
 * are suppressed when absent, exactly as `cli/jobs.ts:projectJobRow` does.
 */
function jobLabel(job: Job): string {
  const cwd = job.cwd == null ? "" : basename(seg(job.cwd));
  const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
  const title = seg(job.title);
  const role = job.plan_verb == null ? "" : ` [${seg(job.plan_verb)}]`;
  return `# ${cwdSeg}${title}${role} [${seg(job.state)}]`;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      all: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();
  const jobs = await fetchJobs(sockPath, parsed.values.all);

  const epicCache = new Map<string, Epic | null>();
  const stanzas: string[] = [];
  for (const job of jobs) {
    const sessionId = seg(job.job_id);
    if (sessionId === "") {
      continue;
    }
    const tier = await tierForJob(sockPath, job, epicCache);
    const cwd = job.cwd == null ? "" : seg(job.cwd);
    stanzas.push(
      `${jobLabel(job)}\n${buildResumeCommand(cwd, resumeTarget(job), tier)}`,
    );
  }

  if (stanzas.length > 0) {
    process.stdout.write(`${stanzas.join("\n\n")}\n`);
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
