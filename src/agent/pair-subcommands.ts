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
import type { AgentKind } from "./dispatch";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  findLastMessage,
  type TranscriptStop,
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
   * Caller-supplied stop-wait ceiling in ms (`--stop-timeout-ms`), threaded into
   * `waitForTranscriptStop`. Null when the flag is absent — the watcher then
   * falls back to `DEFAULT_STOP_TIMEOUT_MS`. Meaningful only to `wait-for-stop`;
   * `show-last-message` shares this resolver and tolerantly ignores it.
   */
  stopTimeoutMs: number | null;
}

export interface ResolveHandleArgs {
  rest: string[];
  cwd: string;
  stateDir: string;
}

export type HandleResolution =
  | { ok: true; handle: ResolvedHandle }
  | { ok: false; error: string };

const AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "pi"]);

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
          error: `--agent must be claude|codex|pi: ${value}`,
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
          error: `--agent must be claude|codex|pi: ${value}`,
        };
      }
      agentOverride = value as AgentKind;
      continue;
    }
    if (arg === "--stop-timeout-ms") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--stop-timeout-ms requires a value" };
      }
      const parsed = parseStopTimeoutMs(value);
      if (parsed === null) {
        return {
          ok: false,
          error: `--stop-timeout-ms must be a positive integer ms: ${value}`,
        };
      }
      stopTimeoutMs = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout-ms=")) {
      const value = arg.slice("--stop-timeout-ms=".length);
      const parsed = parseStopTimeoutMs(value);
      if (parsed === null) {
        return {
          ok: false,
          error: `--stop-timeout-ms must be a positive integer ms: ${value}`,
        };
      }
      stopTimeoutMs = parsed;
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

/**
 * Parse a `--stop-timeout-ms` value to a finite positive integer of ms, or null
 * for anything malformed (`abc`, `0`, negative, non-integer, blank). A null maps
 * to BAD_ARGS upstream — NEVER a silent fallback to the 600s default.
 */
function parseStopTimeoutMs(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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
}

export type WaitForStopResult =
  | { ok: true; transcriptPath: string; stop: TranscriptStop }
  | { ok: false; error: string };

/**
 * Block until the handle's transcript shows the next per-backend stop event,
 * resolving the transcript path first when the handle is a run id. Returns the
 * stop record (carrying the final message text when the backend exposes it).
 */
export async function runWaitForStop(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<WaitForStopResult> {
  const transcriptPath = await resolveTranscriptPath(handle, deps);
  if (transcriptPath === null) {
    return { ok: false, error: "timed out waiting for transcript path" };
  }
  const outcome = await waitForTranscriptStop({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
    transcriptPath,
    stopTimeoutMs: handle.stopTimeoutMs ?? undefined,
  });
  // A bounded timeout maps to the caller's RETRYABLE (exit 4) path, mirroring the
  // transcript-path timeout above — a retryable transient, not a wrong answer.
  // The error self-reports the effective deadline and its source so the next
  // failure tells us whether the caller's --stop-timeout-ms or the default bit.
  if (!outcome.ok) {
    const effectiveMs = handle.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    const source = handle.stopTimeoutMs !== null ? "caller" : "default";
    return {
      ok: false,
      error: `timed out waiting for transcript stop after ${effectiveMs}ms (${source})`,
    };
  }
  return { ok: true, transcriptPath, stop: outcome.stop };
}

export type ShowLastMessageResult =
  | { ok: true; transcriptPath: string; text: string | null; found: boolean }
  | { ok: false; error: string };

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
  const transcriptPath = await resolveTranscriptPath(handle, deps);
  if (transcriptPath === null) {
    return { ok: false, error: "timed out waiting for transcript path" };
  }
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
 * backend's transcript file (bounded by the watcher's path timeout).
 */
async function resolveTranscriptPath(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<string | null> {
  if (handle.transcriptPath !== null) {
    return handle.transcriptPath;
  }
  return waitForTranscriptPath({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
  });
}
