#!/usr/bin/env bun
/**
 * restore-agents — Chrome-style "restore previous session" for keeper-managed
 * Claude Code agents (epic fn-677, T4). Reads the side-file
 * `~/.local/state/keeper/restore.json` that the restore-worker (T3) maintains
 * as a **two-tier descriptor** (epic fn-702, schema v2; per-bucket `backend`
 * tags added v3 / epic fn-789):
 * `{ schema_version, last_session, current }`. `last_session` is the FROZEN
 * restore source (written only at boot-promote + the `>0→0` collapse edge);
 * `current` is the continuous live mirror. This util resolves the restore
 * source by precedence — `last_session ‖ current ‖` (v1) legacy top-level
 * `sessions` — so a reboot that reseeds a smaller live set still offers the
 * full pre-crash set from the frozen `last_session`. It then replays each
 * surviving agent back into its original backend session via
 * `ExecBackend.ensureLaunched` (T2) — routing each bucket through the backend
 * its `backend` tag names (schema v3 / epic fn-789; a v2/legacy bucket without
 * a tag coerces to the default backend) — using the resume command
 * `scripts/resume.ts` and the worker already agree on (`buildResumeCommand` /
 * `resumeTarget`, T1 — the shared `src/resume-descriptor` substrate that makes
 * the three resume-command producers byte-identical).
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
 * The restore SOURCE is resolved by two OPPOSITE precedence orders, and the
 * mode picks which:
 *   - Default / `--apply` use the READER precedence — `last_session ‖ current ‖`
 *     v1-legacy `sessions` (frozen wins) — the post-crash view, since after a
 *     reboot the worker has already boot-promoted the pre-crash live set into
 *     `last_session`.
 *   - `--preview-crash` uses the BOOT-PROMOTE precedence — `current ‖
 *     last_session ‖ legacy` (live mirror wins) — what a crash RIGHT NOW would
 *     actually replay, with an empty skip-set (a crash kills every live job).
 *   - `--snapshot-current` reads the `current` tier alone (the continuous live
 *     mirror) and emits a runnable restore SCRIPT.
 * Both `--preview-crash` and `--snapshot-current` are pure local-file reads —
 * no daemon round-trip, so they work even with `keeperd` down.
 *
 * Across every mode, restored windows come back in their ORIGINAL visual
 * (left-to-right) tmux order: each agent's `window_index` was captured at pulse
 * time (the live tmux server is dead at restore), and the util sorts each
 * session's agents by it (unknown order sinks to the tail by `created_at` then
 * `job_id`). The on-disk file stays `job_id`-sorted — visual order is resolved
 * here. `--apply` and `--snapshot-current` pace window creation by 0.5s between
 * consecutive launches (never before the first or after the last).
 *
 * Usage:
 *   bun scripts/restore-agents.ts [--session <name>] [--apply] [--sock <path>]
 *   bun scripts/restore-agents.ts --preview-crash [--session <name>]
 *   bun scripts/restore-agents.ts --snapshot-current [--session <name>] > restore.sh
 *
 *   --session <name>   Restore only agents from this backend session. Default:
 *                      all sessions in the file.
 *   --apply            Actually relaunch via `ensureLaunched`. Default is
 *                      DRY-RUN — print what would be restored, touch nothing.
 *   --preview-crash    Print what a crash RIGHT NOW would replay (boot-promote
 *                      precedence, empty skip-set). Read-only, no daemon.
 *   --snapshot-current Emit a runnable bash script that restores the CURRENT
 *                      live mirror into tmux windows. Pipe to a file and run
 *                      later. Read-only, no daemon.
 *   --sock <path>      Socket path override (else $KEEPER_SOCK, else the
 *                      ~/.local/state/keeper/keeperd.sock default). Ignored by
 *                      the two read-only modes above.
 *   --help             Show this help.
 *
 * `--apply`, `--preview-crash`, and `--snapshot-current` are mutually exclusive.
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
import {
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  buildTmuxNewWindowArgs,
  DEFAULT_EXEC_BACKEND,
  type ExecBackend,
  resolveExecBackend,
} from "../src/exec-backend";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import {
  RESTORE_SCHEMA_VERSION,
  type RestoreAgent,
  type RestoreSession,
} from "../src/restore-worker";
import { buildResumeCommand } from "../src/resume-descriptor";
import type { Job } from "../src/types";

/**
 * Hard upper bound on how long the CLI waits for a `result` frame after a
 * successful connect. Mirrors `resume.ts` / `commands.ts` / `approve.ts`.
 */
const RESPONSE_TIMEOUT_MS = 5000;

const HELP = `restore-agents — replay surviving Claude Code agents from restore.json

Usage:
  bun scripts/restore-agents.ts [--session <name>] [--apply] [--sock <path>]
  bun scripts/restore-agents.ts --preview-crash [--session <name>]
  bun scripts/restore-agents.ts --snapshot-current [--session <name>] > restore.sh

  --session <name>    Restore only agents from this backend session (default: all)
  --apply             Actually relaunch via ensureLaunched (default: DRY-RUN)
  --preview-crash     Print what a crash RIGHT NOW would replay (read-only)
  --snapshot-current  Emit a runnable tmux restore script for the live set (read-only)
  --sock <path>       Socket path override ($KEEPER_SOCK / default otherwise)
  --help              Show this help

Reads ~/.local/state/keeper/restore.json (override: $KEEPER_RESTORE_FILE) and
relaunches each agent NOT currently live via 'claude --resume' wrapped in the
same shell-prologue scripts/resume.ts emits. Each session bucket routes through
the exec backend its 'backend' tag names; an absent tag coerces to the default
backend. Always validates
against live jobs at restore time (working+stopped); a daemon-down probe
degrades to an empty skip-set so the disaster-recovery path restores everything.

The default / --apply view resolves the restore source as 'last_session ‖
current ‖ legacy' (the frozen set wins — the post-crash view). Two read-only
modes pick a different source and skip the daemon entirely:

  --preview-crash     Boot-promote precedence 'current ‖ last_session ‖ legacy'
                      (live mirror wins) with an EMPTY skip-set — exactly what a
                      crash right now would promote and replay.
  --snapshot-current  Reads the 'current' tier alone and emits a runnable bash
                      script: each agent relaunches into its own tmux window
                      (get-or-create the session first), byte-aligned with what
                      --apply spawns. Pipe to a file and run later.

Every mode restores windows in their original visual (left-to-right) tmux order
(by the captured window_index; unknown order sinks to the tail). --apply and
--snapshot-current pace window creation with a 0.5s pause between consecutive
launches.

--apply, --preview-crash, and --snapshot-current are mutually exclusive.

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
  previewCrash: boolean;
  snapshotCurrent: boolean;
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

/**
 * Total-order comparator for restoring agents into their original visual
 * (left-to-right) tmux window order. A known `window_index` sorts ASCENDING
 * and always precedes an unknown (`null`) one; two unknown-order agents — and
 * agents sharing a `window_index` — tiebreak by `created_at` ascending, then
 * `job_id`. The order is total and deterministic for legacy/partial records:
 * a non-finite `created_at` coerces to `0` (never NaN, which would poison the
 * sort), and a missing `job_id` coerces to "" — so an all-null bucket still
 * sorts stably.
 *
 * `window_index` is a relative SORT KEY only — the consumer never passes it to
 * `tmux new-window -t <index>` (that would collide with base-index /
 * renumber-windows); it merely orders the emit/launch loop. Exported for tests.
 */
export function compareRestoreAgents(a: RestoreAgent, b: RestoreAgent): number {
  const ai = a.window_index;
  const bi = b.window_index;
  const aKnown = typeof ai === "number" && Number.isFinite(ai);
  const bKnown = typeof bi === "number" && Number.isFinite(bi);
  if (aKnown && bKnown) {
    if (ai !== bi) {
      return ai - bi;
    }
  } else if (aKnown !== bKnown) {
    // Exactly one side is known: the known index always wins (sinks the null).
    return aKnown ? -1 : 1;
  }
  // Equal index, or both unknown: tiebreak by created_at then job_id.
  const at = Number.isFinite(a.created_at) ? a.created_at : 0;
  const bt = Number.isFinite(b.created_at) ? b.created_at : 0;
  if (at !== bt) {
    return at - bt;
  }
  return seg(a.job_id).localeCompare(seg(b.job_id));
}

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
 * Pure: pick the agents to act on, given the resolved `sessions` map (the
 * RESTORE SOURCE — `last_session ‖ current ‖` v1-legacy `sessions`, picked by
 * {@link loadRestoreFile}), the optional `--session` filter, and the live
 * `job_id` skip-set. Returns the per-agent outcome list in stable order:
 * sessions alpha-sorted, agents in original VISUAL window order
 * ({@link compareRestoreAgents} — captured `window_index` ascending, unknown
 * order to the tail by `created_at` then `job_id`). The on-disk file stays
 * `job_id`-sorted; visual order is a restore-time concern resolved here.
 *
 * Exported for tests — this is the heart of the util's selection logic.
 *
 * `kind: "would-restore"` is the pre-action verdict; the caller upgrades it
 * to `"restored"` / `"failed"` on the `--apply` path.
 *
 * Every bucket routes through `resolveExecBackend`, which resolves any tag —
 * including a NULL/absent one coerced to `DEFAULT_EXEC_BACKEND` — to the tmux
 * backend.
 */
export function planRestore(
  sessions: Record<string, RestoreSession>,
  sessionFilter: string | null,
  liveSkipSet: Set<string>,
): AgentOutcome[] {
  const out: AgentOutcome[] = [];
  const sessionNames = Object.keys(sessions).sort();
  for (const sessionName of sessionNames) {
    if (sessionFilter !== null && sessionName !== sessionFilter) {
      continue;
    }
    const bucket = sessions[sessionName];
    if (!bucket) {
      continue;
    }
    // Window order is session-local: sort each bucket's agents by visual order
    // before emitting. Copy first — never mutate the caller's array.
    const ordered = [...bucket.agents].sort(compareRestoreAgents);
    for (const agent of ordered) {
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
      "preview-crash": { type: "boolean", default: false },
      "snapshot-current": { type: "boolean", default: false },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    session: parsed.values.session ?? null,
    apply: parsed.values.apply === true,
    previewCrash: parsed.values["preview-crash"] === true,
    snapshotCurrent: parsed.values["snapshot-current"] === true,
    sock: parsed.values.sock ?? null,
    help: parsed.values.help === true,
  };
}

/**
 * The `ensureLaunched` shape the action loop uses. Real binding in `main()`
 * routes each bucket through `resolveExecBackend({ backendType }).ensureLaunched`
 * (the backend its `backend` tag names); tests inject a capturing fake so
 * `--apply` can be asserted without spawning a real multiplexer.
 */
type EnsureLaunchedFn = (
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
type SleepFn = (ms: number) => Promise<void>;

/** Inter-window pacing for restore (ms). Held between consecutive real launches
 * only — never before the first, after the last, or around skipped entries. */
const INTER_WINDOW_PAUSE_MS = 500;

/** Real sleep binding `main()` injects into {@link applyRestore}. */
const defaultSleep: SleepFn = (ms) => Bun.sleep(ms);

/**
 * Pure-ish: drive the outcome list through `ensureLaunched`, upgrading each
 * `"would-restore"` to `"restored"` or `"failed"`. Continues past a single
 * agent's launch failure (don't abort the batch — one busted tab shouldn't
 * strand the rest). Pauses {@link INTER_WINDOW_PAUSE_MS} via the injected
 * `sleep` BETWEEN consecutive real launches only (never before the first, after
 * the last, or around `skipped-live` entries) — the pacing sits OUTSIDE the
 * per-agent try/catch so one launch failure doesn't drop the next agent's
 * pause.
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

/** Coerce a parsed value to a v2 tier's `sessions` map, or `null` on any
 * garbage / wrong shape. A tier is `{ captured_at, sessions }`; we only read
 * `sessions`. A present-but-empty `sessions` ({}) coerces to `null` so the
 * restore-source precedence chain skips an empty tier. */
function tierSessionsOrNull(
  raw: unknown,
): Record<string, RestoreSession> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const sessionsRaw = (raw as Record<string, unknown>).sessions;
  if (
    sessionsRaw === null ||
    typeof sessionsRaw !== "object" ||
    Array.isArray(sessionsRaw)
  ) {
    return null;
  }
  const sessions = sessionsRaw as Record<string, RestoreSession>;
  return Object.keys(sessions).length > 0 ? sessions : null;
}

/**
 * The three restore-source tiers, each coerced to a non-empty `sessions` map
 * or `null` (an empty/absent tier). Every mode derives its source by picking
 * a precedence over these:
 *  - `lastSession` — the FROZEN restore source (boot-promote / collapse-freeze).
 *  - `current` — the continuous live mirror.
 *  - `legacy` — a v1 file's top-level `sessions`, lifted into a tier (it was
 *    frozen under last-non-empty-wins, so it reads as a `last_session` source).
 */
export interface RestoreTiers {
  lastSession: Record<string, RestoreSession> | null;
  current: Record<string, RestoreSession> | null;
  legacy: Record<string, RestoreSession> | null;
}

/**
 * Pure: load the side-file off disk and surface the three RAW tiers WITHOUT
 * collapsing any precedence — each mode picks its own source order. Returns
 * either the tiers or a typed reason: caller maps `"missing"` / `"parse-error"`
 * to the no-op exit-0 path, `"future"` to die(), and `"ok"` to an action path.
 * The schema-version gate (future-refuse / safe-default) lives here so every
 * mode inherits it. Exported for tests.
 */
export async function loadRestoreTiers(
  path: string,
): Promise<
  | ({ kind: "ok" } & RestoreTiers)
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
  return {
    kind: "ok",
    lastSession: tierSessionsOrNull(rec.last_session),
    current: tierSessionsOrNull(rec.current),
    // v1 legacy: a top-level `sessions` block with no tier wrapper.
    legacy: tierSessionsOrNull({ sessions: rec.sessions }),
  };
}

/**
 * Pure: load the side-file and resolve the RESTORE SOURCE to a single
 * `sessions` map via the READER precedence — `last_session ‖ current ‖` (v1)
 * legacy `sessions` (frozen wins). This is the default / `--apply` view: after
 * a reboot the worker has already boot-promoted the pre-crash live set into
 * `last_session`, so the frozen tier is the post-crash truth. The resolved map
 * MAY be empty ({}) when every tier is empty — "nothing to restore". A thin
 * wrapper over {@link loadRestoreTiers}. Exported for tests.
 */
export async function loadRestoreFile(
  path: string,
): Promise<
  | { kind: "ok"; sessions: Record<string, RestoreSession> }
  | { kind: "missing" }
  | { kind: "parse-error"; message: string }
  | { kind: "future"; version: number }
> {
  const tiers = await loadRestoreTiers(path);
  if (tiers.kind !== "ok") {
    return tiers;
  }
  const sessions = tiers.lastSession ?? tiers.current ?? tiers.legacy ?? {};
  return { kind: "ok", sessions };
}

/**
 * Pure: the BOOT-PROMOTE restore source — `current ‖ last_session ‖ legacy`
 * (live mirror wins), the OPPOSITE of {@link loadRestoreFile}'s frozen-wins
 * reader precedence. This is exactly what `restorePulse`'s boot-promote lifts
 * into `last_session` on the first post-reboot pulse, so it is what a crash
 * RIGHT NOW would promote and then replay. Exported for tests.
 */
export function resolveCrashSource(
  tiers: RestoreTiers,
): Record<string, RestoreSession> {
  return tiers.current ?? tiers.lastSession ?? tiers.legacy ?? {};
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
 * Pure renderer: turn the `current`-tier session map into a RUNNABLE bash
 * script that restores each agent into its own tmux window. Byte-aligned with
 * what `--apply` spawns — the same `buildResumeLaunchArgv` inner argv wrapped
 * in the same `buildTmuxNewWindowArgs` new-window — but preceded by a per-
 * session `has-session || new-session` get-or-create guard and emitted as shell
 * text, so it can be piped to a file and run later (daemon-independent).
 *
 * Sessions are emitted in alpha order; agents within a session in original
 * VISUAL window order ({@link compareRestoreAgents}). A `sleep 0.5` line
 * separates consecutive `new-window` emissions (tracked globally across session
 * boundaries — never before the first window or after the last) so the restored
 * windows don't race the multiplexer. `sleep 0.5` is portable across BSD/GNU
 * with a dot decimal. Every argv token is single-quoted via {@link shellQuote}.
 * The `--session` filter narrows to one bucket. Exported for tests.
 */
export function renderSnapshotScript(
  sessions: Record<string, RestoreSession>,
  sessionFilter: string | null,
  shell: string,
  sourcePath: string,
): string {
  const quoteArgv = (args: string[]): string => args.map(shellQuote).join(" ");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# restore-agents --snapshot-current — runnable snapshot of the CURRENT live set.",
    `# Source: ${sourcePath} (current tier). Pipe to a file and run to restore.`,
    "# Each agent relaunches into its own tmux window; the session is get-or-created.",
    "set -euo pipefail",
  ];
  let sessionCount = 0;
  let agentCount = 0;
  // Tracks whether any new-window has been emitted yet, ACROSS session
  // boundaries — `sleep 0.5` precedes every new-window after the first, so it
  // lands strictly between consecutive windows (no leading or trailing sleep).
  let windowsEmitted = 0;
  for (const sessionName of Object.keys(sessions).sort()) {
    if (sessionFilter !== null && sessionName !== sessionFilter) {
      continue;
    }
    const bucket = sessions[sessionName];
    if (!bucket || bucket.agents.length === 0) {
      continue;
    }
    sessionCount++;
    const n = bucket.agents.length;
    lines.push("");
    lines.push(`# session: ${sessionName} (${n} agent${n === 1 ? "" : "s"})`);
    // Get-or-create the session so the new-window targets land. `|| ` keeps
    // `set -e` from tripping when has-session exits non-zero (session absent).
    lines.push(
      `${quoteArgv(buildTmuxHasSessionArgs(sessionName))} 2>/dev/null || ` +
        `${quoteArgv(buildTmuxNewSessionArgs(sessionName))}`,
    );
    // Visual window order is session-local; sort a copy, never the caller's.
    const ordered = [...bucket.agents].sort(compareRestoreAgents);
    for (const agent of ordered) {
      const cwd = agent.cwd == null ? "" : seg(agent.cwd);
      const innerArgv = buildResumeLaunchArgv(shell, agent);
      // No window name — mirrors --apply (ensureLaunched passes no name), so the
      // restored window stays unnamed and the renamer worker labels it later.
      if (windowsEmitted > 0) {
        lines.push("sleep 0.5");
      }
      lines.push(`# ${agent.resume_target}`);
      lines.push(
        quoteArgv(buildTmuxNewWindowArgs(sessionName, cwd, innerArgv)),
      );
      windowsEmitted++;
      agentCount++;
    }
  }
  lines.push("");
  lines.push(
    `# summary: snapshot-current sessions=${sessionCount} agents=${agentCount}`,
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgsTyped(Bun.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // `--apply`, `--preview-crash`, and `--snapshot-current` each own the run.
  if (
    [args.apply, args.previewCrash, args.snapshotCurrent].filter(Boolean)
      .length > 1
  ) {
    die(
      "--apply, --preview-crash, and --snapshot-current are mutually exclusive",
    );
  }

  const restorePath = resolveRestorePath();
  const tiers = await loadRestoreTiers(restorePath);
  if (tiers.kind === "missing") {
    process.stdout.write(
      `# restore-agents: no snapshot at ${restorePath} (nothing to restore)\n`,
    );
    process.exit(0);
  }
  if (tiers.kind === "parse-error") {
    process.stdout.write(
      `# restore-agents: ${restorePath} is malformed (${tiers.message}); nothing to restore\n`,
    );
    process.exit(0);
  }
  if (tiers.kind === "future") {
    die(
      `restore.json schema_version ${tiers.version} is from the future ` +
        `(this util supports up to ${RESTORE_SCHEMA_VERSION}); refusing to act`,
    );
  }

  const shell = process.env.SHELL ?? DEFAULT_SHELL;

  // --snapshot-current: emit a runnable restore script for the CURRENT live
  // mirror alone. Pure local-file op — no daemon round-trip, no live-jobs dedup
  // (every agent in `current` IS live; snapshotting it is the whole point).
  if (args.snapshotCurrent) {
    process.stdout.write(
      renderSnapshotScript(
        tiers.current ?? {},
        args.session,
        shell,
        restorePath,
      ),
    );
    process.exit(0);
  }

  // --preview-crash: simulate a crash+reboot. The boot-promote precedence is
  // `current ‖ last_session ‖ legacy` (live mirror wins) — the OPPOSITE of the
  // reader's frozen-wins default — so this shows what a crash RIGHT NOW would
  // actually replay. Empty skip-set: a crash kills every live job, so nothing
  // is "already live." Pure local-file op — no daemon round-trip.
  if (args.previewCrash) {
    const plan = planRestore(
      resolveCrashSource(tiers),
      args.session,
      new Set<string>(),
    );
    process.stdout.write(
      "# restore-agents --preview-crash: what a crash RIGHT NOW would replay\n" +
        "# (boot-promote precedence current‖last_session‖legacy; assumes every live agent is gone)\n",
    );
    process.stdout.write(renderOutcomes(plan, shell, false));
    process.exit(0);
  }

  // Default / --apply: resolve the restore source via the reader's frozen-wins
  // precedence (`last_session ‖ current ‖ legacy`) and dedup against live jobs.
  const sessions = tiers.lastSession ?? tiers.current ?? tiers.legacy ?? {};

  const sockPath = args.sock ?? resolveSockPath();
  const { jobs, reason } = await fetchLiveJobsOrNull(sockPath);
  const skipSet = jobs == null ? new Set<string>() : buildLiveJobIdSet(jobs);
  if (jobs == null) {
    process.stderr.write(
      `restore-agents: live-jobs probe failed (${reason}); ` +
        `treating skip-set as empty and restoring everything in the file\n`,
    );
  }

  const plan = planRestore(sessions, args.session, skipSet);

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

  // Route each bucket through the exec backend its `backend` tag names. Resolve
  // ONE backend instance per backend type (memoized) and look it up by the
  // session's tag at launch time — every tag resolves to the tmux backend via
  // `resolveExecBackend`.
  const noteLine = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const backendByType = new Map<string, ExecBackend>();
  const backendForType = (backendType: string): ExecBackend => {
    let b = backendByType.get(backendType);
    if (b == null) {
      b = resolveExecBackend({ backendType, noteLine });
      backendByType.set(backendType, b);
    }
    return b;
  };
  // Session-name → backend type, lifted off the resolved restore source.
  const backendBySession = new Map<string, string>();
  for (const [name, bucket] of Object.entries(sessions)) {
    backendBySession.set(name, bucket.backend ?? DEFAULT_EXEC_BACKEND);
  }
  const ensureLaunched: EnsureLaunchedFn = (session, argv, cwd) => {
    const backendType = backendBySession.get(session) ?? DEFAULT_EXEC_BACKEND;
    return backendForType(backendType).ensureLaunched(session, argv, cwd);
  };

  const outcomes = await applyRestore(
    plan,
    ensureLaunched,
    shell,
    defaultSleep,
  );
  process.stdout.write(renderOutcomes(outcomes, shell, true));
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
