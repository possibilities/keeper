/**
 * keeper's ephemeral pi extension — M3b live-state for pi.
 *
 * pi fires no subprocess hooks the way claude does, but it loads in-process
 * TypeScript extensions (the `-e <path>` per-launch flag) that observe its
 * AgentHarness lifecycle. The keeper launcher arms THIS file on every tracked pi
 * launch (interactive or detached); it translates pi's events into keeper's
 * events-log NDJSON contract so a pi session shows the same working/stopped churn
 * on the board that a claude session does, and registers a read-only transcript
 * tool backed by the keeper CLI.
 *
 * EPHEMERAL, NEVER a persistent `pi install`: a global install would fire on the
 * human's own non-keeper pi sessions. The `-e` per-launch arming plus the
 * `KEEPER_JOB_ID` env gate keep it scoped to keeper-launched sessions only — with
 * no marker the extension registers nothing and writes nothing.
 *
 * HOOK-WRITER CLASS (same discipline as the claude events-writer hook and the
 * hermes shim): this is an in-process mechanism that dies with the harness, so it
 * writes per-pid events-log NDJSON keyed on the keeper job id — NOT a synthetic
 * MAIN-minted event (that channel is for state decoupled from harness liveness:
 * birth records, the codex rollout tail).
 *
 * SELF-CONTAINED ISLAND: pi loads this file in ISOLATION via jiti, outside the
 * keeper build — it can import nothing from keeper's `src/` tree and the pi
 * package is not on keeper's module path either. So it imports ONLY `node:*` and
 * carries its own minimal structural types for the pi events it reads and its own
 * copy of the events-log contract (the byte-identical NDJSON shape + dir
 * resolver). The matching comments on both sides are the drift guard.
 *
 * FAIL-OPEN IS LOAD-BEARING, NOT OPTIONAL: pi ABORTS the launch when an extension
 * throws while loading (verified live against pi 0.80.3), and its handler-error
 * isolation is not something to rely on. So the factory body is wrapped in a
 * top-level guard and every handler swallows its own throws — a bug here degrades
 * pi to presence-only (the birth record still seeds the row), and can NEVER crash
 * or interfere with the human's pi session. Lifecycle handlers are pure
 * observers: they return nothing, so they never block or rewrite a message. The
 * transcript tool runs only when the model explicitly calls it.
 *
 * IDENTITY: the birth record the launcher drops is pi's authoritative presence +
 * identity seed (pi pins its session uuid at launch, so `KEEPER_JOB_ID` == that
 * uuid == `jobs.job_id`). The event channel owns LIVE STATE only, so it emits no
 * SessionStart — the birth-ingest synthetic SessionStart already seeds the row
 * and stamps `harness=pi`, and a second seed would double-touch the revive arm
 * (the same reason claude is exempt from birth records). It DOES emit a clean
 * SessionEnd on a graceful quit, the one terminal signal the birth channel can't
 * give — an ungraceful death still degrades to the exit-watcher's `killed`.
 */

import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// pi event shapes (minimal structural subset)
// ---------------------------------------------------------------------------

/**
 * The structural subset of a pi AgentHarness event this extension reads. pi's
 * real event union (`@earendil-works/pi-coding-agent`) is far richer; we depend
 * only on `type` plus the few fields the translation needs, so an unknown or
 * reshaped event degrades to a no-op rather than a type error.
 */
export interface PiObservedEvent {
  /** The event discriminator (`agent_start` | `agent_end` | `tool_call` | …). */
  type: string;
  /** `session_shutdown` reason (`quit` is the only real process exit). */
  reason?: string;
  /** Tool name on `tool_call` / `tool_result`. */
  toolName?: string;
  /** Raw tool-call arguments (attacker-influenced — JSON-encoded as data only). */
  input?: unknown;
  /** True when a `tool_result` carried an error. */
  isError?: boolean;
}

/** The minimal surface of pi's `ExtensionAPI` this extension calls. Structural so
 *  the file needs no import from the pi package; pi passes an object with `.on`. */
export interface PiExtensionApi {
  on(event: string, handler: (event: PiObservedEvent) => void): void;
  registerTool?(tool: PiToolDefinition): void;
}

export interface PiTranscriptParams {
  session_id?: string;
  subagent?: string;
  project?: string;
  offset?: number;
  before?: number;
  limit?: number;
  max_chars?: number;
  tools?: string;
  grep?: string;
  since?: string;
  until?: string;
  global?: boolean;
  include_meta?: boolean;
  include_thinking?: boolean;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: PiTranscriptParams,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// translation — pure, unit-tested with golden fixtures
// ---------------------------------------------------------------------------

/** The per-launch identity + context every emitted line carries. */
export interface PiTranslateMeta {
  /** `KEEPER_JOB_ID` — the join key to the birth-record row (== jobs.job_id). */
  jobId: string;
  /** The pi process pid (== the birth record's recorded child pid). */
  pid: number;
  /** The session cwd. */
  cwd: string;
  /** Event timestamp in Unix SECONDS (the live fire instant — this is a live
   *  channel, not a replay tail, so wall-clock at emit is authoritative). */
  tsSec: number;
}

/** One bare-column `events` binding map — the payload of an events-log line.
 *  Values are the SQLite-storable scalars the ingester accepts. */
export type PiEventBindings = Record<string, string | number | null>;

/**
 * Cap for the JSON-encoded `data` blob. A runaway tool payload must not mint a
 * multi-MiB line; over the cap we drop the oversized field and keep a minimal
 * valid-JSON envelope, so `data` is ALWAYS parseable (the fold JSON-parses it).
 */
const MAX_DATA_BYTES = 16_384;

/** JSON-encode a hook-shaped payload, bounded: over {@link MAX_DATA_BYTES} we
 *  fall back to a minimal `{hook_event_name, truncated}` envelope so the result
 *  is always valid JSON, never a torn string. */
function boundedData(
  hookEvent: string,
  payload: Record<string, unknown>,
): string {
  const full = JSON.stringify(payload);
  if (full.length <= MAX_DATA_BYTES) {
    return full;
  }
  return JSON.stringify({ hook_event_name: hookEvent, truncated: true });
}

/**
 * Translate one pi event into its bare-column `events` bindings, or `null` when
 * the event does not map (unknown kind, or a `session_shutdown` that is a
 * mid-process session switch rather than a real quit). PURE: same inputs → same
 * output, no fs / clock / env — the caller supplies `tsSec`.
 *
 * The event → hook_event map is LOCKED against the installed pi vocabulary
 * (0.80.3), overriding the planner's provisional `message_end → Stop` guess:
 * `message_end` fires per-message (multiple times a turn) and would flap the
 * row, whereas `agent_end` is the one terminal "loop finished" signal. The map
 * mirrors claude's lifecycle so the SAME jobs fold arms drive pi's churn:
 *
 *   agent_start              → UserPromptSubmit  (turn begins → working)
 *   agent_end                → Stop              (turn ends → stopped)
 *   tool_call                → PreToolUse        (tool churn → working)
 *   tool_result              → PostToolUse       (tool churn → un-stop)
 *   session_shutdown[quit]   → SessionEnd        (clean terminal → ended)
 *
 * No SessionStart is emitted — the birth record owns pi presence + identity (see
 * the module header). Every line's `session_id` is `meta.jobId`; `harness` is
 * left unset (the fold's non-SessionStart arms never write it, and the birth
 * synthetic SessionStart is the sole writer of `jobs.harness`).
 */
export function piEventBindings(
  event: PiObservedEvent,
  meta: PiTranslateMeta,
): PiEventBindings | null {
  const base = (hookEvent: string, eventType: string): PiEventBindings => ({
    ts: meta.tsSec,
    session_id: meta.jobId,
    pid: meta.pid,
    hook_event: hookEvent,
    event_type: eventType,
    cwd: meta.cwd,
  });

  switch (event.type) {
    case "agent_start":
      return {
        ...base("UserPromptSubmit", "user_prompt_submit"),
        data: boundedData("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
        }),
      };
    case "agent_end":
      return {
        ...base("Stop", "stop"),
        data: boundedData("Stop", { hook_event_name: "Stop" }),
      };
    case "tool_call": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : null;
      return {
        ...base("PreToolUse", "pre_tool_use"),
        tool_name: toolName,
        // The tool arguments ride in `data` JSON-encoded (attacker-influenced
        // content — quotes / newlines / shell metacharacters — round-trips as
        // data in a valid NDJSON line, never interpolated anywhere).
        data: boundedData("PreToolUse", {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: event.input ?? null,
        }),
      };
    }
    case "tool_result": {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : null;
      return {
        ...base("PostToolUse", "post_tool_use"),
        tool_name: toolName,
        data: boundedData("PostToolUse", {
          hook_event_name: "PostToolUse",
          tool_name: toolName,
          is_error: event.isError === true,
        }),
      };
    }
    case "session_shutdown":
      // Only a real process quit is a session end. `reload`/`new`/`resume`/`fork`
      // tear down the extension runtime for an IN-PROCESS session switch — pi
      // keeps running, so emitting SessionEnd would wrongly flip the live row
      // terminal.
      if (event.reason !== "quit") {
        return null;
      }
      return {
        ...base("SessionEnd", "session_end"),
        data: boundedData("SessionEnd", { hook_event_name: "SessionEnd" }),
      };
    default:
      // Unknown / unmapped event kind — a no-op, never an error. Keeps the
      // translation forward-compatible with pi vocabulary additions.
      return null;
  }
}

/**
 * Serialize one bindings map to a single events-log NDJSON line, terminated by
 * `\n`. MUST match `serializeEventLogRecord` in `src/dead-letter.ts`
 * byte-for-byte — the record is `{ bindings }` and the daemon's
 * `parseEventLogLine` reads exactly that shape. Kept local because this file
 * cannot import keeper's tree; the matching comment is the drift guard.
 */
export function serializePiLine(bindings: PiEventBindings): string {
  return `${JSON.stringify({ bindings })}\n`;
}

/** Translate one pi event to a complete events-log line, or `null` for an
 *  unmapped event. The composed {@link piEventBindings} + {@link serializePiLine}. */
export function translatePiEvent(
  event: PiObservedEvent,
  meta: PiTranslateMeta,
): string | null {
  const bindings = piEventBindings(event, meta);
  return bindings === null ? null : serializePiLine(bindings);
}

// ---------------------------------------------------------------------------
// events-log write (per-pid append)
// ---------------------------------------------------------------------------

/**
 * Resolve the keeper events-log directory. MUST match `resolveEventsLogDir` in
 * `src/db.ts` (and the claude events-writer hook's copy) byte-for-byte —
 * `KEEPER_EVENTS_LOG` wins (tests point it at a tmp dir), else
 * `~/.local/state/keeper/events-log`. Local copy (self-contained island); the
 * matching comment is the drift guard.
 */
export function resolvePiEventsLogDir(env: NodeJS.ProcessEnv): string {
  const override = env.KEEPER_EVENTS_LOG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "events-log");
}

/**
 * Append one line to this pi process's per-pid events-log file. The pi process
 * is the SOLE long-lived writer of `<pid>.ndjson`, so single-`write()`-per-line
 * appends never interleave — the same guarantee the claude hook relies on. Best
 * -effort 0o600 (a line can carry tool payloads the user considers private); NO
 * fsync (the ingester re-reads from a durable byte-offset, so a lost buffer is
 * lag-not-loss). Never throws — the caller's guard is belt-and-suspenders.
 */
function appendEventsLogLine(
  env: NodeJS.ProcessEnv,
  pid: number,
  line: string,
): void {
  const dir = resolvePiEventsLogDir(env);
  const file = join(dir, `${pid}.ndjson`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Recursive mkdir is idempotent on absence; an existing dir with a different
    // mode throws harmlessly — the append below is the real success signal.
  }
  appendFileSync(file, line);
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod best-effort — the file may exist from a prior append this process
    // cannot re-chmod; the data is on disk and ingestible regardless.
  }
}

// ---------------------------------------------------------------------------
// transcript tool (read-only keeper CLI bridge)
// ---------------------------------------------------------------------------

const TRANSCRIPT_TOOL_TIMEOUT_MS = 20_000;
const TRANSCRIPT_TOOL_MAX_BUFFER = 256 * 1024;

function schema(
  kind: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...value };
  Object.defineProperty(result, "~kind", { value: kind, enumerable: false });
  return result;
}

function stringSchema(description: string): Record<string, unknown> {
  return schema("String", { type: "string", description });
}

function numberSchema(description: string): Record<string, unknown> {
  return schema("Number", { type: "number", description });
}

function booleanSchema(description: string): Record<string, unknown> {
  return schema("Boolean", { type: "boolean", description });
}

/** TypeBox-compatible schema without importing pi's isolated dependency tree. */
const TRANSCRIPT_TOOL_PARAMETERS = schema("Object", {
  type: "object",
  properties: {
    session_id: stringSchema(
      "Claude session id. Omit to list sessions in the current project.",
    ),
    subagent: stringSchema("Subagent id/prefix, or all. Requires session_id."),
    project: stringSchema(
      "Project path for list scope or session disambiguation.",
    ),
    offset: numberSchema("Page offset. Show defaults to the newest page."),
    before: numberSchema(
      "Backward page boundary. Requires session_id; mutually exclusive with offset.",
    ),
    limit: numberSchema("Maximum sessions or transcript entries."),
    max_chars: numberSchema("Maximum rendered characters for transcript show."),
    tools: stringSchema("Tool detail: none, compact, or full."),
    grep: stringSchema("Case-insensitive transcript content filter."),
    since: stringSchema("ISO time/date or relative duration such as 7d."),
    until: stringSchema("ISO time/date or relative duration."),
    global: booleanSchema("When listing, search every project instead of cwd."),
    include_meta: booleanSchema(
      "Include Claude-injected meta and system entries.",
    ),
    include_thinking: booleanSchema("Include thinking blocks."),
  },
});

function pushStringFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    args.push(flag, value.trim());
  }
}

function pushNumberFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(flag, String(Math.trunc(value)));
  }
}

/** Convert validated tool parameters to an argv-only keeper invocation. */
export function transcriptCliArgs(params: PiTranscriptParams): string[] {
  const sessionId = params.session_id?.trim() ?? "";
  const listing = sessionId.length === 0;
  const args = ["transcript", ...(listing ? ["list"] : [sessionId])];
  args.push("--harness", "claude");
  pushStringFlag(args, "--project", params.project);
  pushNumberFlag(args, "--offset", params.offset);
  pushNumberFlag(args, "--limit", params.limit);
  pushStringFlag(args, "--since", params.since);
  pushStringFlag(args, "--until", params.until);

  if (listing) {
    if (params.global === true) args.push("--global");
    return args;
  }

  pushStringFlag(args, "--subagent", params.subagent);
  pushNumberFlag(args, "--before", params.before);
  pushNumberFlag(args, "--max-chars", params.max_chars);
  pushStringFlag(args, "--tools", params.tools);
  pushStringFlag(args, "--grep", params.grep);
  if (params.include_meta === true) args.push("--meta");
  if (params.include_thinking === true) args.push("--thinking");
  return args;
}

function boundedToolText(text: string): string {
  if (text.length <= TRANSCRIPT_TOOL_MAX_BUFFER) return text;
  return `${text.slice(0, TRANSCRIPT_TOOL_MAX_BUFFER)}\n[output truncated by pi extension]`;
}

async function executeTranscriptTool(
  params: PiTranscriptParams,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const args = transcriptCliArgs(params);
  return new Promise((resolve) => {
    const options = {
      encoding: "utf8" as const,
      timeout: TRANSCRIPT_TOOL_TIMEOUT_MS,
      maxBuffer: TRANSCRIPT_TOOL_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    };
    execFile("keeper", args, options, (error, stdout, stderr) => {
      const out = boundedToolText(stdout);
      const err = boundedToolText(stderr);
      if (error === null) {
        resolve({
          content: [{ type: "text", text: out || "(no transcript output)" }],
          details: { argv: args, exit_code: 0 },
        });
        return;
      }
      const code = (error as { code?: unknown }).code ?? null;
      const message = err.trim() || out.trim() || error.message;
      resolve({
        content: [
          {
            type: "text",
            text: `keeper transcript failed: ${message}`,
          },
        ],
        details: { argv: args, exit_code: code },
      });
    });
  });
}

const TRANSCRIPT_TOOL: PiToolDefinition = {
  name: "keeper_transcript",
  label: "Keeper Transcript",
  description:
    "List Claude Code sessions or read a compact, paginated main/subagent transcript. Omit session_id to list the current project; provide it to read the newest page.",
  promptSnippet:
    "Read Claude Code session transcripts and subagent transcripts through Keeper.",
  promptGuidelines: [
    "Use keeper_transcript to recover Claude context; page backward with before=older_before, forward with offset=newer_offset, and inspect subagents by the ids in the header.",
  ],
  parameters: TRANSCRIPT_TOOL_PARAMETERS,
  async execute(_toolCallId, params, signal) {
    try {
      return await executeTranscriptTool(params, signal);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `keeper transcript failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        details: { argv: transcriptCliArgs(params), exit_code: null },
      };
    }
  },
};

// ---------------------------------------------------------------------------
// extension factory (pi's default-export entry point)
// ---------------------------------------------------------------------------

/** The keeper env marker whose presence arms the extension. Its value is the
 *  keeper job id every emitted line joins on. */
const KEEPER_JOB_ID_ENV = "KEEPER_JOB_ID";

/**
 * The pi extension entry point. Registers observer handlers that mirror pi's
 * lifecycle into the events-log plus the read-only transcript tool. NO-OPS
 * entirely when `KEEPER_JOB_ID` is absent
 * (a pi session started outside keeper), and is wrapped so it can NEVER throw out
 * of the factory (pi aborts the launch on a load-time throw) nor out of a handler
 * (degrade to presence-only, never crash the human's session).
 */
export default function keeperEvents(pi: PiExtensionApi): void {
  try {
    const jobId = (process.env[KEEPER_JOB_ID_ENV] ?? "").trim();
    if (jobId === "") {
      // No keeper marker → this is the human's own pi session. Register nothing,
      // write nothing: zero extension output, no orphan events.
      return;
    }
    const pid = process.pid;
    const cwd = process.cwd();

    const emit = (event: PiObservedEvent): void => {
      try {
        const line = translatePiEvent(event, {
          jobId,
          pid,
          cwd,
          tsSec: Date.now() / 1000,
        });
        if (line !== null) {
          appendEventsLogLine(process.env, pid, line);
        }
      } catch {
        // Fail-open: a translation / write failure degrades to presence-only.
        // Never propagate — the human's pi turn must not see a keeper error.
      }
    };

    // Observer-only: each handler returns undefined, so it never blocks a tool
    // call or rewrites a message. The set mirrors claude's lifecycle churn.
    for (const kind of [
      "agent_start",
      "agent_end",
      "tool_call",
      "tool_result",
      "session_shutdown",
    ]) {
      pi.on(kind, emit);
    }
    if (typeof pi.registerTool === "function") {
      pi.registerTool(TRANSCRIPT_TOOL);
    }
  } catch {
    // Top-level fail-open: a load-time throw would ABORT pi's launch. Swallow so
    // the worst case is a no-op extension, never a broken pi session.
  }
}
