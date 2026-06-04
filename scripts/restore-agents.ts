#!/usr/bin/env bun
/**
 * restore-agents — Chrome-style "restore previous session" for keeper-managed
 * Claude Code agents (epic fn-677, T4). Reads the side-file
 * `~/.local/state/keeper/restore.json` that the restore-worker (T3) maintains
 * under a **last-non-empty-wins** policy (epic fn-689: the worker rewrites
 * the file on content change BUT unconditionally skips an empty descriptor,
 * so the file intentionally outlives reboot / seed-sweep zeroing events and
 * is NOT always current-state — it's the last populated snapshot), and
 * replays each surviving agent back into its original
 * zellij session via `ExecBackend.ensureLaunched` (T2) using the resume
 * command `scripts/resume.ts` and the worker already agree on
 * (`buildResumeCommand` / `resumeTarget`, T1 — the shared `src/resume-descriptor`
 * substrate that makes the three resume-command producers byte-identical).
 *
 * The side-file is a HINT, not truth — the util always validates each agent
 * against live jobs at restore time (one `query` round-trip for the `jobs`
 * collection's default scope, which is live-only = `working` + `stopped`)
 * and skips any `job_id` still occupying a backend. Daemon-down degrades
 * to an empty skip-set so the disaster-recovery path (machine reboot, daemon
 * gone, no live jobs) restores everything rather than aborting.
 *
 * The file's own top-level `schema_version` is independent of the DB schema
 * version (the side-file is NOT a projection — see CLAUDE.md "Worker
 * contract" + epic spec "Best practices"). An unknown FUTURE version makes
 * this util refuse to act rather than guess at garbage; an older / missing
 * version falls back to safe defaults.
 *
 * Usage:
 *   bun scripts/restore-agents.ts [--session <name>] [--apply] [--sock <path>]
 *
 *   --session <name>  Restore only agents from this zellij session. Default:
 *                     all sessions in the file.
 *   --apply           Actually relaunch via `ensureLaunched`. Default is
 *                     DRY-RUN — print what would be restored, touch nothing.
 *   --sock <path>     Socket path override (else $KEEPER_SOCK, else the
 *                     ~/.local/state/keeper/keeperd.sock default).
 *   --help            Show this help.
 *
 * Exit codes:
 *   0 — printed the plan (dry-run) or completed the restore (--apply).
 *       A malformed/absent restore.json is "nothing to restore" and exits 0
 *       with a clear message.
 *   1 — arguments are malformed, or the side-file's schema_version is from
 *       a FUTURE version we don't understand. The reason goes to stderr.
 */

import { parseArgs } from "node:util";
import { resolveRestorePath, resolveSockPath } from "../src/db";
import { createZellijBackend } from "../src/exec-backend";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import {
  RESTORE_SCHEMA_VERSION,
  type RestoreAgent,
  type RestoreDescriptor,
} from "../src/restore-worker";
import { buildResumeCommand } from "../src/resume-descriptor";
import type { Job } from "../src/types";

/**
 * Hard upper bound on how long the CLI waits for a `result` frame after a
 * successful connect. Mirrors `resume.ts` / `commands.ts` / `approve.ts`.
 */
const RESPONSE_TIMEOUT_MS = 5000;

const HELP = `restore-agents — replay surviving Claude Code agents from restore.json

Usage: bun scripts/restore-agents.ts [--session <name>] [--apply] [--sock <path>]

  --session <name>  Restore only agents from this zellij session (default: all)
  --apply           Actually relaunch via ensureLaunched (default: DRY-RUN)
  --sock <path>     Socket path override ($KEEPER_SOCK / default otherwise)
  --help            Show this help

Reads ~/.local/state/keeper/restore.json (override: $KEEPER_RESTORE_FILE) and
relaunches each agent NOT currently live via 'claude --resume' wrapped in the
same shell-prologue scripts/resume.ts emits. Always validates against live
jobs at restore time (working+stopped); a daemon-down probe degrades to an
empty skip-set so the disaster-recovery path restores everything.

A malformed/absent restore.json prints a clear message and exits 0
(nothing to restore). A future-version schema_version refuses to act and
exits 1 — older/missing versions fall back to safe defaults.

When --apply runs while autopilot is unpaused, the util prints a warning:
restored tabs are not 'verb::id'-named, so autopilot's fn-674 dedup probe
cannot see them and may double-dispatch.
`;

/**
 * Default `$SHELL` fallback used when env isn't set (e.g. when invoked from
 * a barebones LaunchAgent). Mirrors the autopilot worker's resolution.
 */
const DEFAULT_SHELL = "/bin/zsh" as const;

interface ParsedArgs {
  session: string | null;
  apply: boolean;
  sock: string | null;
  help: boolean;
}

/**
 * Outcome of one restore attempt — fed into the summary counts and (for the
 * dry-run path) the per-agent label lines. PURE shape — no I/O leaks out.
 */
type AgentOutcome =
  | { kind: "would-restore"; agent: RestoreAgent; session: string }
  | { kind: "skipped-live"; agent: RestoreAgent; session: string }
  | { kind: "restored"; agent: RestoreAgent; session: string }
  | {
      kind: "failed";
      agent: RestoreAgent;
      session: string;
      error: string;
    };

const seg = (v: unknown): string => (v == null ? "" : String(v));

function die(message: string): never {
  process.stderr.write(`restore-agents: ${message}\n`);
  process.exit(1);
}

/**
 * One round-trip on a fresh UDS connection — copied from `scripts/resume.ts`
 * (which copied it from `commands.ts`) so this util is self-contained and the
 * three short-lived UDS scripts share one stable shape. Rejects with a
 * human-readable `Error` on connect-fail, transport error, malformed frame,
 * server-side close before reply, or `RESPONSE_TIMEOUT_MS` elapsing
 * post-connect.
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
 * Fetch the LIVE job set (the `jobs` collection's default scope —
 * `working` + `stopped`). Used to build the per-`job_id` dedup skip-set.
 * Returns `null` on ANY transport / connect failure so the caller can
 * route the disaster-recovery branch (empty skip-set ⇒ restore everything)
 * rather than aborting — a fresh-reboot scenario is exactly when restore is
 * most valuable AND when the daemon is most likely down.
 *
 * A server-side `error` frame OR an unexpected frame type is treated the
 * same way: it's "daemon unhealthy," not "skip-set known empty," and we'd
 * rather restore aggressively than orphan agents. The text reason is
 * forwarded via a stderr note in the caller so an operator sees what
 * happened.
 */
async function fetchLiveJobsOrNull(
  sockPath: string,
): Promise<{ jobs: Job[] | null; reason: string | null }> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      {
        type: "query",
        collection: "jobs",
        id: queryId,
        // No filter → default scope (live only — working + stopped).
        limit: 0,
      },
      queryId,
    );
  } catch (err) {
    return { jobs: null, reason: (err as Error).message };
  }
  if (frame.type === "error") {
    return {
      jobs: null,
      reason: `server error ${frame.code}: ${frame.message}`,
    };
  }
  if (frame.type !== "result") {
    return {
      jobs: null,
      reason: `unexpected frame type for jobs query: ${frame.type}`,
    };
  }
  return { jobs: frame.rows as unknown as Job[], reason: null };
}

/**
 * Probe the singleton `autopilot_state` projection (schema v47 / fn-667) for
 * the paused flag. Returns `true` if known paused, `false` if known playing,
 * and `null` on any failure (no banner means no warning — the warning is
 * advisory, not load-bearing). Mirrors `cli/autopilot.ts:projectAutopilotPaused`'s
 * coercion of the `paused` integer column.
 */
async function fetchAutopilotPaused(sockPath: string): Promise<boolean | null> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      {
        type: "query",
        collection: "autopilot_state",
        id: queryId,
        limit: 1,
      },
      queryId,
    );
  } catch {
    return null;
  }
  if (frame.type !== "result" || frame.rows.length === 0) {
    return null;
  }
  const raw = (frame.rows[0] as Record<string, unknown>).paused;
  if (typeof raw !== "number") {
    return null;
  }
  return raw !== 0;
}

/**
 * Pure schema-version gate. Returns:
 *   - `"ok"` when the file's `schema_version` is `<= RESTORE_SCHEMA_VERSION`
 *     (older = fall through, current = fall through). Missing / non-numeric is
 *     treated as older (`0`) per the spec's "safe defaults" carve-out.
 *   - `"future"` when the file's `schema_version` is strictly greater than
 *     `RESTORE_SCHEMA_VERSION` — we refuse to act.
 *
 * Exported for tests.
 */
export function classifySchemaVersion(raw: unknown): "ok" | "future" {
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return v > RESTORE_SCHEMA_VERSION ? "future" : "ok";
}

/**
 * Pure: build the dedup skip-set from a live-jobs list. Includes every
 * non-empty `job_id`. Used to filter restore candidates so agents whose
 * Claude session is still occupying a backend tab don't get a second tab.
 *
 * Exported for tests.
 */
export function buildLiveJobIdSet(jobs: Job[]): Set<string> {
  const set = new Set<string>();
  for (const job of jobs) {
    const id = seg(job.job_id);
    if (id !== "") {
      set.add(id);
    }
  }
  return set;
}

/**
 * Pure: pick the agents to act on, given the parsed descriptor, the optional
 * `--session` filter, and the live `job_id` skip-set. Returns the per-agent
 * outcome list in stable order: sessions alpha-sorted, agents in their
 * pre-sorted order (the worker sorts by `job_id` on disk).
 *
 * Exported for tests — this is the heart of the util's selection logic.
 *
 * `kind: "would-restore"` is the pre-action verdict; the caller upgrades it
 * to `"restored"` / `"failed"` on the `--apply` path.
 */
export function planRestore(
  descriptor: RestoreDescriptor,
  sessionFilter: string | null,
  liveSkipSet: Set<string>,
): AgentOutcome[] {
  const out: AgentOutcome[] = [];
  const sessionNames = Object.keys(descriptor.sessions).sort();
  for (const sessionName of sessionNames) {
    if (sessionFilter !== null && sessionName !== sessionFilter) {
      continue;
    }
    const bucket = descriptor.sessions[sessionName];
    if (!bucket) {
      continue;
    }
    for (const agent of bucket.agents) {
      if (liveSkipSet.has(agent.job_id)) {
        out.push({ kind: "skipped-live", agent, session: sessionName });
        continue;
      }
      out.push({ kind: "would-restore", agent, session: sessionName });
    }
  }
  return out;
}

/**
 * Pure: assemble the agent's resume shell command. Wraps it in the same
 * `$SHELL -l -i -c "<cmd> ; exec $SHELL -l -i"` prologue the autopilot
 * worker's `buildLaunchArgv` uses, so a freshly minted tab survives the
 * `claude` process exiting (you keep a login shell). The shell is injected
 * for testability — the live util passes `process.env.SHELL ?? DEFAULT_SHELL`.
 *
 * Exported for tests.
 */
export function buildResumeLaunchArgv(
  shell: string,
  agent: RestoreAgent,
): string[] {
  const cwd = agent.cwd == null ? "" : seg(agent.cwd);
  const workerCommand = buildResumeCommand(
    cwd,
    agent.resume_target,
    agent.tier,
  );
  const body = `${workerCommand} ; exec ${shell} -l -i`;
  return [shell, "-l", "-i", "-c", body];
}

/** Pure: parseArgs wrapper that surfaces a typed shape and validates flags. */
function parseArgsTyped(argv: string[]): ParsedArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      apply: { type: "boolean", default: false },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    session: parsed.values.session ?? null,
    apply: parsed.values.apply === true,
    sock: parsed.values.sock ?? null,
    help: parsed.values.help === true,
  };
}

/**
 * The `ensureLaunched` shape the action loop uses. Real binding in `main()`
 * wires `createZellijBackend(...).ensureLaunched`; tests inject a capturing
 * fake so `--apply` can be asserted without spawning real zellij.
 */
type EnsureLaunchedFn = (
  session: string,
  argv: string[],
  cwd: string,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Pure-ish: drive the outcome list through `ensureLaunched`, upgrading each
 * `"would-restore"` to `"restored"` or `"failed"`. Continues past a single
 * agent's launch failure (don't abort the batch — one busted tab shouldn't
 * strand the rest).
 *
 * Exported for tests — they pass a capturing fake `ensureLaunched` so
 * `--apply` is asserted without real zellij.
 */
export async function applyRestore(
  plan: AgentOutcome[],
  ensureLaunched: EnsureLaunchedFn,
  shell: string,
): Promise<AgentOutcome[]> {
  const out: AgentOutcome[] = [];
  for (const entry of plan) {
    if (entry.kind !== "would-restore") {
      out.push(entry);
      continue;
    }
    const argv = buildResumeLaunchArgv(shell, entry.agent);
    const cwd = entry.agent.cwd == null ? "" : seg(entry.agent.cwd);
    try {
      const res = await ensureLaunched(entry.session, argv, cwd);
      if (res.ok) {
        out.push({
          kind: "restored",
          agent: entry.agent,
          session: entry.session,
        });
      } else {
        out.push({
          kind: "failed",
          agent: entry.agent,
          session: entry.session,
          error: res.error,
        });
      }
    } catch (err) {
      out.push({
        kind: "failed",
        agent: entry.agent,
        session: entry.session,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

/**
 * Pure renderer: turn the outcome list into the stdout block. One stanza per
 * agent (a `#` comment label line — keyed by the resolved title
 * (`resume_target`), not the raw session id, so it reads like what
 * `claude --resume` targets — plus the resume command) followed by a trailing
 * `# summary:` line. Exported for tests so the rendering shape is locked
 * down without parsing real stdout.
 */
export function renderOutcomes(
  outcomes: AgentOutcome[],
  shell: string,
  apply: boolean,
): string {
  const stanzas: string[] = [];
  let restored = 0;
  let skippedLive = 0;
  let failed = 0;
  let wouldRestore = 0;

  for (const o of outcomes) {
    const cwd = o.agent.cwd == null ? "" : seg(o.agent.cwd);
    const cmd = buildResumeCommand(cwd, o.agent.resume_target, o.agent.tier);
    // Label each line with the resolved title (`resume_target` — the latest
    // session name, falling back to the session id only for a job that never
    // carried a name), so the human-readable label matches what the
    // `claude --resume` command actually targets.
    const label = o.agent.resume_target;
    if (o.kind === "would-restore") {
      wouldRestore++;
      stanzas.push(`# (${o.session}) would restore ${label}\n${cmd}`);
    } else if (o.kind === "skipped-live") {
      skippedLive++;
      stanzas.push(`# (${o.session}) skipping ${label} — already live`);
    } else if (o.kind === "restored") {
      restored++;
      stanzas.push(`# (${o.session}) restored ${label}\n${cmd}`);
    } else {
      failed++;
      stanzas.push(`# (${o.session}) FAILED ${label}: ${o.error}\n${cmd}`);
    }
  }

  // Keep `shell` referenced — useful for debug/diagnostics output and to
  // explicitly mark the prologue substrate. A future verbose flag can lift
  // this into a stanza. Reading process.env was avoided in the pure path.
  void shell;

  const summary = apply
    ? `# summary: restored=${restored} skipped-live=${skippedLive} failed=${failed}`
    : `# summary: would-restore=${wouldRestore} skipped-live=${skippedLive}`;

  return stanzas.length > 0
    ? `${stanzas.join("\n\n")}\n\n${summary}\n`
    : `${summary}\n`;
}

/**
 * Pure: load the side-file off disk. Returns either the parsed descriptor or
 * a typed reason — caller maps `"missing"` / `"parse-error"` to the no-op
 * exit-0 path, `"future"` to die(), and `"ok"` to the action path.
 *
 * Exported for tests.
 */
export async function loadRestoreFile(
  path: string,
): Promise<
  | { kind: "ok"; descriptor: RestoreDescriptor }
  | { kind: "missing" }
  | { kind: "parse-error"; message: string }
  | { kind: "future"; version: number }
> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { kind: "missing" };
  }
  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    return { kind: "parse-error", message: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "parse-error", message: (err as Error).message };
  }
  if (parsed == null || typeof parsed !== "object") {
    return { kind: "parse-error", message: "not a JSON object" };
  }
  const rec = parsed as Record<string, unknown>;
  if (classifySchemaVersion(rec.schema_version) === "future") {
    return {
      kind: "future",
      version:
        typeof rec.schema_version === "number" ? rec.schema_version : NaN,
    };
  }
  // Coerce defensively — older versions may have minor shape drift; we only
  // touch `sessions` from here on, so a missing `sessions` falls back to {}.
  const sessions =
    rec.sessions != null && typeof rec.sessions === "object"
      ? (rec.sessions as RestoreDescriptor["sessions"])
      : {};
  const descriptor: RestoreDescriptor = {
    schema_version:
      typeof rec.schema_version === "number" ? rec.schema_version : 0,
    captured_at: typeof rec.captured_at === "number" ? rec.captured_at : 0,
    sessions,
  };
  return { kind: "ok", descriptor };
}

async function main(): Promise<void> {
  const args = parseArgsTyped(Bun.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const restorePath = resolveRestorePath();
  const loaded = await loadRestoreFile(restorePath);
  if (loaded.kind === "missing") {
    process.stdout.write(
      `# restore-agents: no snapshot at ${restorePath} (nothing to restore)\n`,
    );
    process.exit(0);
  }
  if (loaded.kind === "parse-error") {
    process.stdout.write(
      `# restore-agents: ${restorePath} is malformed (${loaded.message}); nothing to restore\n`,
    );
    process.exit(0);
  }
  if (loaded.kind === "future") {
    die(
      `restore.json schema_version ${loaded.version} is from the future ` +
        `(this util supports up to ${RESTORE_SCHEMA_VERSION}); refusing to act`,
    );
  }

  const sockPath = args.sock ?? resolveSockPath();
  const { jobs, reason } = await fetchLiveJobsOrNull(sockPath);
  const skipSet = jobs == null ? new Set<string>() : buildLiveJobIdSet(jobs);
  if (jobs == null) {
    process.stderr.write(
      `restore-agents: live-jobs probe failed (${reason}); ` +
        `treating skip-set as empty and restoring everything in the file\n`,
    );
  }

  const plan = planRestore(loaded.descriptor, args.session, skipSet);
  const shell = process.env.SHELL ?? DEFAULT_SHELL;

  if (!args.apply) {
    process.stdout.write(renderOutcomes(plan, shell, false));
    process.exit(0);
  }

  // --apply path. Warn upfront if autopilot is unpaused: restored tabs are
  // not `verb::id`-named, so the fn-674 tab-probe dedup arm cannot see them
  // and the reconciler may double-dispatch. A null probe (autopilot_state
  // not folded, daemon down) skips the warning — we already noted the
  // daemon-down case above.
  if (jobs != null) {
    const paused = await fetchAutopilotPaused(sockPath);
    if (paused === false) {
      process.stderr.write(
        `restore-agents: WARNING — autopilot is unpaused. Restored tabs are ` +
          `not 'verb::id'-named, so autopilot's fn-674 tab probe cannot dedup ` +
          `against them. Pause autopilot before --apply to avoid double-dispatch.\n`,
      );
    }
  }

  const backend = createZellijBackend({
    noteLine: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  });
  const ensureLaunched: EnsureLaunchedFn = (session, argv, cwd) =>
    backend.ensureLaunched(session, argv, cwd);

  const outcomes = await applyRestore(plan, ensureLaunched, shell);
  process.stdout.write(renderOutcomes(outcomes, shell, true));
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
