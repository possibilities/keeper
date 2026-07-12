/**
 * The post-launch transcript verbs: `wait-for-stop` and `show-last-message`.
 * They decouple a detached `--x-tmux --x-tmux-detached` launch
 * from reading its result, so a caller composes `launch-detached → wait-for-stop
 * → show-last-message` instead of a single blocking flag.
 *
 * Both take a `<handle>`: the detached launch JSON's `id` (a `tmux-<uuid>` run
 * id resolving to `<stateDir>/tmux-runs/<id>/run.json`, which carries the agent,
 * cwd, transcript session id and start time), OR a direct transcript path (a
 * value containing a `/`) paired with `--agent <kind>`. The run-id form is the
 * happy path; the path form serves a `--no-artifacts` launch that wrote no
 * run.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "../duration";
import type { AgentKind } from "./dispatch";
import { HARNESS_NAME_SET } from "./harness";
import {
  attributeHermesSession,
  type HermesExportFn,
  hermesLastMessage,
  hermesSessionStop,
  parseHermesExport,
} from "./hermes-capture";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  defaultTranscriptPathTimeoutMs,
  findLastMessage,
  type TranscriptStop,
  type WaitForPathOutcome,
  waitForTranscriptPath,
  waitForTranscriptStop,
} from "./transcript-watch";

/** A run handle resolved to everything the verbs need to read its transcript. */
export interface ResolvedHandle {
  agent: AgentKind;
  cwd: string;
  sessionId: string | null;
  startedAtMs: number;
  /** Known up-front only for the direct-path handle form; else resolved later. */
  transcriptPath: string | null;
  /**
   * Caller-supplied stop-wait ceiling in ms (`--stop-timeout`), threaded into
   * `waitForTranscriptStop`. Null when the flag is absent — the watcher then
   * falls back to `DEFAULT_STOP_TIMEOUT_MS`. Meaningful only to `wait-for-stop`;
   * `show-last-message` shares this resolver and tolerantly ignores it.
   */
  stopTimeoutMs: number | null;
  /**
   * Resume marker threaded into transcript discovery: a resumed codex leg resolves
   * its PRE-EXISTING rollout by the known uuid (`sessionId`) rather than the
   * fresh-launch created-at floor. claude/pi stay strict-pinned; every harness's
   * stop-scan still anchors at `startedAtMs` so a pre-resume stop is skipped.
   * Absent/false = fresh launch, byte-unchanged.
   */
  isResume?: boolean;
}

export interface ResolveHandleArgs {
  rest: string[];
  cwd: string;
  stateDir: string;
}

export type HandleResolution =
  | { ok: true; handle: ResolvedHandle }
  | { ok: false; error: string };

const AGENTS: ReadonlySet<string> = HARNESS_NAME_SET;
const AGENT_ROSTER = [...HARNESS_NAME_SET].join("|");

/**
 * Parse a verb's argv into a resolved handle. The first non-flag positional is
 * the handle; `--agent <kind>` overrides/supplies the agent for a path handle.
 * A handle containing `/` is treated as a transcript path; otherwise it is a run
 * id looked up under the state dir.
 */
export function resolveHandle(args: ResolveHandleArgs): HandleResolution {
  let handleArg: string | null = null;
  let agentOverride: AgentKind | null = null;
  let stopTimeoutMs: number | null = null;

  for (let i = 0; i < args.rest.length; i++) {
    const arg = args.rest[i] as string;
    if (arg === "--agent") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--agent requires a value" };
      }
      if (!AGENTS.has(value)) {
        return {
          ok: false,
          error: `--agent must be ${AGENT_ROSTER}: ${value}`,
        };
      }
      agentOverride = value as AgentKind;
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length);
      if (!AGENTS.has(value)) {
        return {
          ok: false,
          error: `--agent must be ${AGENT_ROSTER}: ${value}`,
        };
      }
      agentOverride = value as AgentKind;
      continue;
    }
    if (arg === "--stop-timeout") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--stop-timeout requires a value" };
      }
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout=")) {
      const value = arg.slice("--stop-timeout=".length);
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      continue;
    }
    if (handleArg === null) {
      handleArg = arg;
      continue;
    }
    return { ok: false, error: `unexpected extra argument: ${arg}` };
  }

  if (handleArg === null) {
    return { ok: false, error: "missing handle (a run id or transcript path)" };
  }

  if (handleArg.includes("/")) {
    if (agentOverride === null) {
      return {
        ok: false,
        error: "--agent is required when the handle is a transcript path",
      };
    }
    return {
      ok: true,
      handle: {
        agent: agentOverride,
        cwd: args.cwd,
        sessionId: null,
        startedAtMs: 0,
        transcriptPath: handleArg,
        stopTimeoutMs,
      },
    };
  }

  return resolveRunId(handleArg, args.stateDir, agentOverride, stopTimeoutMs);
}

function resolveRunId(
  runId: string,
  stateDir: string,
  agentOverride: AgentKind | null,
  stopTimeoutMs: number | null,
): HandleResolution {
  const runJsonPath = join(stateDir, "tmux-runs", runId, "run.json");
  if (!existsSync(runJsonPath)) {
    return { ok: false, error: `no run found for handle: ${runId}` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(runJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, error: `unreadable run metadata: ${runJsonPath}` };
  }

  const agent = agentOverride ?? coerceAgent(parsed.agent);
  if (agent === null) {
    return { ok: false, error: `run metadata has no agent: ${runJsonPath}` };
  }
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : null;
  if (cwd === null) {
    return { ok: false, error: `run metadata has no cwd: ${runJsonPath}` };
  }

  return {
    ok: true,
    handle: {
      agent,
      cwd,
      sessionId:
        typeof parsed.transcriptSessionId === "string"
          ? parsed.transcriptSessionId
          : null,
      startedAtMs:
        typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : 0,
      transcriptPath: null,
      stopTimeoutMs,
    },
  };
}

function coerceAgent(value: unknown): AgentKind | null {
  return typeof value === "string" && AGENTS.has(value)
    ? (value as AgentKind)
    : null;
}

export interface VerbDeps {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /**
   * Hermes capture seam: run `hermes sessions export` and return its JSONL text
   * (or null on failure). Hermes has no per-session transcript FILE — its sessions
   * live in a SQLite store — so its wait/show path polls this export instead of
   * watching the filesystem. Bound in `main.ts` (a bounded subprocess); absent for
   * the claude/codex/pi file-transcript verbs, which never read it.
   */
  hermesExport?: HermesExportFn;
}

/** Poll cadence for the hermes export (heavier than a file stat — a full
 *  subprocess + SQLite read per tick — so gentler than the 250ms file poll). */
const HERMES_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WaitForStopResult =
  | { ok: true; transcriptPath: string; stop: TranscriptStop }
  | {
      ok: false;
      error: string;
      reason?: "timeout" | "ambiguous";
      /** Set when the transcript path DID resolve and only the stop wait timed
       *  out — the caller reads that known path once instead of re-running
       *  path discovery on a second budget. */
      transcriptPath?: string;
    };

/**
 * Block until the handle's transcript shows the next per-backend stop event,
 * resolving the transcript path first when the handle is a run id. Returns the
 * stop record (carrying the final message text when the backend exposes it).
 *
 * Path discovery and the stop wait share ONE absolute deadline derived from the
 * handle's stop budget: pi creates its session file only at the first assistant
 * message, so a healthy slow leg can legitimately spend most of the budget
 * before any file exists — path discovery may consume the whole remainder for
 * pi, while the fast-writing harnesses keep their small discovery window. The
 * stop wait then gets exactly what is left, so total wall time obeys the one
 * budget instead of stacking a fresh stop budget on top of the path window.
 */
export async function runWaitForStop(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<WaitForStopResult> {
  if (handle.agent === "hermes") {
    return hermesWaitForStop(handle, deps);
  }
  const totalMs = handle.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const deadlineMs = Date.now() + totalMs;
  const remainingForPath = Math.max(1, deadlineMs - Date.now());
  const pathTimeoutMs =
    handle.agent === "pi"
      ? remainingForPath
      : Math.min(
          defaultTranscriptPathTimeoutMs(handle.agent),
          remainingForPath,
        );
  const resolved = await resolveTranscriptPath(handle, deps, pathTimeoutMs);
  if (!resolved.ok) {
    return transcriptPathFailure(resolved.reason);
  }
  const transcriptPath = resolved.path;
  const outcome = await waitForTranscriptStop({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
    isResume: handle.isResume,
    transcriptPath,
    stopTimeoutMs: Math.max(1, deadlineMs - Date.now()),
  });
  // A bounded timeout maps to the caller's RETRYABLE (exit 4) path, mirroring the
  // transcript-path timeout above — a retryable transient, not a wrong answer.
  // The error self-reports the effective deadline and its source so the next
  // failure tells us whether the caller's --stop-timeout or the default bit.
  if (!outcome.ok) {
    const source = handle.stopTimeoutMs !== null ? "caller" : "default";
    return {
      ok: false,
      reason: "timeout",
      transcriptPath,
      error: `timed out waiting for transcript stop after ${totalMs}ms (${source})`,
    };
  }
  return { ok: true, transcriptPath, stop: outcome.stop };
}

export type ShowLastMessageResult =
  | { ok: true; transcriptPath: string; text: string | null; found: boolean }
  | { ok: false; error: string; reason?: "timeout" | "ambiguous" };

/**
 * Resolve the handle's transcript and return the partner's final assistant
 * message. Works on a finished OR in-flight run — it never blocks past the
 * transcript-path discovery. `text:null, found:true` is a defined empty signal
 * (tool-only / refusal final turn); `found:false` means no assistant message
 * exists yet.
 */
export async function runShowLastMessage(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<ShowLastMessageResult> {
  if (handle.agent === "hermes") {
    return hermesShowLastMessage(handle, deps);
  }
  const resolved = await resolveTranscriptPath(handle, deps);
  if (!resolved.ok) {
    return transcriptPathFailure(resolved.reason);
  }
  const transcriptPath = resolved.path;
  const last = findLastMessage(handle.agent, transcriptPath);
  return {
    ok: true,
    transcriptPath,
    text: last.text,
    found: last.found,
  };
}

/**
 * A direct-path handle resolves to itself; a run-id handle polls for the
 * backend's transcript file (bounded by the watcher's path timeout). The
 * `ambiguous` failure — a codex leg colliding with a concurrent same-cwd session
 * — is propagated distinctly so the caller never degrades it into a plain
 * path-timeout (or, worse, a guessed foreign transcript).
 */
async function resolveTranscriptPath(
  handle: ResolvedHandle,
  deps: VerbDeps,
  pathTimeoutMs?: number,
): Promise<WaitForPathOutcome> {
  if (handle.transcriptPath !== null) {
    return { ok: true, path: handle.transcriptPath };
  }
  return waitForTranscriptPath({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
    isResume: handle.isResume,
    pathTimeoutMs,
  });
}

const HERMES_AMBIGUOUS_ERROR =
  "hermes session ambiguous: multiple concurrent same-cwd sessions match, cannot attribute";

/**
 * Block until the leg's hermes session records a terminal assistant turn, polling
 * `hermes sessions export` and attributing by cwd + created-at. A concurrent
 * same-cwd session collision fails distinctly (`ambiguous`) so the caller never
 * degrades it into a plain timeout; the session id doubles as the "transcript
 * path" (hermes has no transcript FILE — the id is its resume target).
 */
async function hermesWaitForStop(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<WaitForStopResult> {
  const exportFn = deps.hermesExport;
  if (exportFn === undefined) {
    return {
      ok: false,
      reason: "timeout",
      error: "hermes export seam unavailable",
    };
  }
  const deadline =
    Date.now() + (handle.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  while (true) {
    const text = exportFn();
    if (text !== null) {
      const attr = attributeHermesSession(
        parseHermesExport(text),
        handle.cwd,
        handle.startedAtMs,
      );
      if (attr.kind === "ambiguous") {
        return {
          ok: false,
          reason: "ambiguous",
          error: HERMES_AMBIGUOUS_ERROR,
        };
      }
      if (attr.kind === "found") {
        const stop = hermesSessionStop(attr.session, handle.startedAtMs);
        if (stop !== null) {
          return { ok: true, transcriptPath: attr.session.id, stop };
        }
      }
    }
    if (Date.now() >= deadline) {
      const effectiveMs = handle.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      const source = handle.stopTimeoutMs !== null ? "caller" : "default";
      return {
        ok: false,
        reason: "timeout",
        error: `timed out waiting for hermes session stop after ${effectiveMs}ms (${source})`,
      };
    }
    await sleep(HERMES_POLL_INTERVAL_MS);
  }
}

/**
 * Resolve the leg's hermes session (one export snapshot, no blocking) and return
 * its final assistant message. `ambiguous` propagates distinctly; a session not
 * yet present maps to the retryable timeout reason (mirrors a transcript that
 * never appeared). The session id rides back as the transcript path.
 */
async function hermesShowLastMessage(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<ShowLastMessageResult> {
  const exportFn = deps.hermesExport;
  if (exportFn === undefined) {
    return {
      ok: false,
      reason: "timeout",
      error: "hermes export seam unavailable",
    };
  }
  const text = exportFn();
  if (text === null) {
    return {
      ok: false,
      reason: "timeout",
      error: "hermes export produced no output",
    };
  }
  const attr = attributeHermesSession(
    parseHermesExport(text),
    handle.cwd,
    handle.startedAtMs,
  );
  if (attr.kind === "ambiguous") {
    return { ok: false, reason: "ambiguous", error: HERMES_AMBIGUOUS_ERROR };
  }
  if (attr.kind !== "found") {
    return {
      ok: false,
      reason: "timeout",
      error: "no attributable hermes session found in export",
    };
  }
  const last = hermesLastMessage(attr.session);
  return {
    ok: true,
    transcriptPath: attr.session.id,
    text: last.text,
    found: last.found,
  };
}

/** Map a transcript-path resolution failure to a verb result — carrying the
 *  `reason` so run-capture separates a concurrent-session collision
 *  (`transcript_ambiguous`) from a transcript that never appeared. */
function transcriptPathFailure(reason: "timeout" | "ambiguous"): {
  ok: false;
  error: string;
  reason: "timeout" | "ambiguous";
} {
  return {
    ok: false,
    reason,
    error:
      reason === "ambiguous"
        ? "transcript ambiguous: multiple concurrent same-cwd sessions match, cannot attribute"
        : "timed out waiting for transcript path",
  };
}
