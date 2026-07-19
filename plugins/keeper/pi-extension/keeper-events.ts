/**
 * keeper's ephemeral pi extension — M3b live-state for pi.
 *
 * pi fires no subprocess hooks the way claude does, but it loads in-process
 * TypeScript extensions (the `-e <path>` per-launch flag) that observe its
 * AgentHarness lifecycle. The keeper launcher arms THIS file on every tracked pi
 * launch (interactive or detached); it translates pi's events into keeper's
 * events-log NDJSON contract so a pi session shows the same working/stopped churn
 * on the board that a claude session does, installs keeper's status footer and
 * telemetry sink, holds a session-scoped Agent Bus inbox, and registers bounded
 * history and ownership-safe commit-work tools backed by the Keeper CLI.
 *
 * EPHEMERAL, NEVER a persistent `pi install`: a global install would fire on the
 * human's own non-keeper pi sessions. The `-e` per-launch arming plus the
 * `KEEPER_JOB_ID` env gate keep it scoped to keeper-launched sessions only — with
 * no marker the extension registers nothing and writes nothing.
 *
 * HOOK-WRITER CLASS (same discipline as the claude events-writer hook and the
 * other event writers): this is an in-process mechanism that dies with the harness, so it
 * writes per-pid events-log NDJSON keyed on the keeper job id — NOT a synthetic
 * MAIN-minted event (that channel is for state decoupled from harness liveness:
 * birth records, the codex rollout tail).
 *
 * SELF-CONTAINED ISLAND: pi loads this file in ISOLATION via jiti, outside the
 * keeper build — it can import nothing from keeper's `src/` tree and the pi
 * package is not on keeper's module path either. Its local helpers import only
 * `node:*`; this entry point carries minimal structural types for the pi events
 * it reads and local copies of the byte-identical events-log/dead-letter shapes
 * plus fixed OS-user store resolver. Matching comments are the drift guard.
 *
 * FAIL-OPEN IS LOAD-BEARING, NOT OPTIONAL: pi ABORTS the launch when an extension
 * throws while loading (verified live against pi 0.80.3), and its handler-error
 * isolation is not something to rely on. So the factory body is wrapped in a
 * top-level guard and every handler swallows its own throws — a bug here degrades
 * pi to presence-only (the birth record still seeds the row), and can NEVER crash
 * or interfere with the human's pi session. Lifecycle handlers are pure
 * observers: they return nothing, so they never block or rewrite a message.
 * Registered tools run only when the model explicitly calls them.
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
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AmbientBusWatchTask,
  claimBusInboxOwnership,
  PiBusInboxController,
  releaseBusInboxOwnership,
} from "./bus-inbox.ts";
import {
  createPiCommitWorkTool,
  type PiCommitWorkToolDefinition,
} from "./commit-work-tool.ts";
import {
  installPiEditorBorder,
  type PiEditorBorderContext,
} from "./editor-border.ts";
import {
  createMonitorFacadeTool,
  type MonitorLineBatch,
  type MonitorTaskSnapshot,
  type MonitorTerminalOutcome,
  PiMonitorController,
  type PiMonitorControllerOptions,
  type PiMonitorToolDefinition,
} from "./monitor-facade.ts";
import { type PiRenameApi, registerRenameCommand } from "./rename-command.ts";
import {
  expandSkillShorthandInput,
  installSkillShorthandAutocomplete,
  type PiSkillAutocompleteContext,
  SKILL_SHORTHANDS,
} from "./skill-autocomplete.ts";
import {
  installPiStatusFooter,
  type PiFooterApi,
  type PiFooterContext,
} from "./status-footer.ts";
import {
  createTaskFacadeTool,
  type PiTaskEventBus,
  type PiTaskToolDefinition,
} from "./task-facade.ts";

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
  /** Correlator carried by Pi tool events. */
  toolCallId?: string;
  /** Raw tool-call arguments (attacker-influenced — JSON-encoded as data only). */
  input?: unknown;
  /** Tool result content/details (attacker-influenced, bounded before storage). */
  content?: unknown;
  details?: unknown;
  /** True when a `tool_result` carried an error. */
  isError?: boolean;
  /** Producer-canonical path, computed only after a successful file mutation. */
  mutationPath?: string | null;
}

/**
 * pi's `input` event, fired on raw user text before skill/template expansion.
 * A `transform` result rewrites `text` and pi resumes native expansion on the
 * rewritten form — the input handler never registers an extension command,
 * which would bypass that pipeline entirely.
 */
export interface PiInputEvent {
  type: "input";
  text: string;
}

export interface PiInputTransformResult {
  action: "transform";
  text: string;
}

/**
 * pi's `resources_discover` event, fired once after every `session_start`
 * (`reason: "startup" | "reload"`). A returned `skillPaths` entry contributes
 * an additional skill directory alongside pi's own discovery.
 */
export interface PiResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

export interface PiResourcesDiscoverResult {
  skillPaths?: string[];
}

/** The minimal surface of pi's `ExtensionAPI` this extension calls. Structural so
 *  the file needs no import from the pi package; pi passes an object with `.on`. */
export type PiSessionContext = PiFooterContext &
  PiEditorBorderContext &
  PiSkillAutocompleteContext;

export interface PiExtensionApi {
  on(
    event: "input",
    handler: (
      event: PiInputEvent,
      context?: PiSessionContext,
    ) =>
      | PiInputTransformResult
      | undefined
      | Promise<PiInputTransformResult | undefined>,
  ): void;
  on(
    event: "resources_discover",
    handler: (
      event: PiResourcesDiscoverEvent,
      context?: PiSessionContext,
    ) =>
      | PiResourcesDiscoverResult
      | undefined
      | Promise<PiResourcesDiscoverResult | undefined>,
  ): void;
  on(
    event: string,
    handler: (
      event: PiObservedEvent,
      context?: PiSessionContext,
    ) => void | Promise<void>,
  ): void;
  events?: PiTaskEventBus;
  getThinkingLevel?(): string;
  getSessionName?(): string | undefined;
  registerTool?(
    tool:
      | PiToolDefinition<unknown>
      | PiTaskToolDefinition
      | PiCommitWorkToolDefinition
      | PiMonitorToolDefinition,
  ): void;
  /** Presence-gated: `/rename` registers only when both this and
   *  `setSessionName` exist (see the `registerRenameCommand` call site). The
   *  real options/handler shape lives in `rename-command.ts`'s `PiRenameApi`
   *  — kept `unknown` here so this file needs no import from it beyond the
   *  registration call itself. */
  registerCommand?(name: string, options: unknown): void;
  setSessionName?(name: string): void;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): void;
}

export interface PiHistoryParams {
  operation?: string;
  session?: string;
  query?: string;
  harness?: string;
  project?: string;
  artifact?: string;
  offset?: number;
  before?: number;
  limit?: number;
  max_chars?: number;
  grep?: string;
  since?: string;
  until?: string;
  /** Specialist transcript-show parameters. */
  subagent?: string;
  tools?: string;
  include_meta?: boolean;
  include_thinking?: boolean;
  /** Specialist Pi turn parameters. */
  leaf?: string;
  strip_skills?: boolean;
}

interface PiToolDefinition<TParams> {
  name: string;
  label: string;
  description: string;
  executionMode?: "parallel" | "sequential";
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: TParams,
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
type PiBackgroundTask =
  | MonitorTaskSnapshot
  | (AmbientBusWatchTask & { kind: "ambient" });

export interface PiBackendExecCoords {
  type: "tmux" | null;
  sessionId: string | null;
  paneId: string | null;
}

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
  /** Exact Dispatch attempt carried by the launch adapter. Omitted for manual,
   *  legacy, or malformed metadata. */
  dispatchAttemptId?: number;
  /** Harness-armed background resources reflected on Stop. */
  backgroundTasks?: PiBackgroundTask[];
  /** Launch-time tmux identity retained on every lifecycle event. */
  backendExec?: PiBackendExecCoords;
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

/**
 * Resolve the default-server tmux coordinate from Pi's launch environment.
 * This self-contained extension cannot import the shared source helper, so it
 * mirrors the native-TMUX and stripped-TMUX carrier arms and fails closed for a
 * foreign socket or missing pane.
 */
export function piBackendExecCoordsFromEnv(
  env: NodeJS.ProcessEnv,
): PiBackendExecCoords {
  const collapse = (value: string | undefined): string | null =>
    value === undefined || value === "" ? null : value;
  const sessionId = collapse(env.KEEPER_TMUX_SESSION);
  const tmux = collapse(env.TMUX);
  if (tmux !== null) {
    const comma = tmux.indexOf(",");
    const socketPath = comma < 0 ? tmux : tmux.slice(0, comma);
    const leaf = socketPath.slice(socketPath.lastIndexOf("/") + 1);
    if (leaf !== "default") {
      return { type: null, sessionId: null, paneId: null };
    }
    const paneId = collapse(env.TMUX_PANE);
    return paneId === null
      ? { type: null, sessionId: null, paneId: null }
      : { type: "tmux", sessionId, paneId };
  }
  const paneId = collapse(env.KEEPER_TMUX_PANE);
  return paneId === null
    ? { type: null, sessionId: null, paneId: null }
    : { type: "tmux", sessionId, paneId };
}

/** Parse Pi's local copy of the bounded Dispatch-attempt environment contract.
 * This isolated extension cannot import keeper source; every malformed shape
 * degrades to absent evidence. */
export function piDispatchAttemptFromEnv(
  env: NodeJS.ProcessEnv,
): number | null {
  const raw = env.KEEPER_DISPATCH_ATTEMPT_ID;
  if (raw === undefined || !/^[1-9]\d{0,15}$/.test(raw)) {
    return null;
  }
  const attemptId = Number(raw);
  return Number.isSafeInteger(attemptId) ? attemptId : null;
}

/**
 * The canonical Hack and Plan skill directories Keeper contributes through
 * `resources_discover`, resolved from THIS module's own location — never the
 * launch cwd or another repository — so every Keeper-launched Pi session
 * discovers the same skill bodies the Claude side ships, with no sibling
 * `plugins/plan/skills/*` entries exposed.
 */
export function piSkillShorthandResourcePaths(): string[] {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  return SKILL_SHORTHANDS.map((shorthand) =>
    resolve(extensionDir, "..", "..", "plan", "skills", shorthand.name),
  );
}

function dispatchAttemptPayload(
  meta: PiTranslateMeta,
): { dispatch_attempt_id: number } | Record<string, never> {
  return meta.dispatchAttemptId !== undefined &&
    Number.isSafeInteger(meta.dispatchAttemptId) &&
    meta.dispatchAttemptId > 0
    ? { dispatch_attempt_id: meta.dispatchAttemptId }
    : {};
}

/** JSON-encode a hook-shaped payload, bounded: over {@link MAX_DATA_BYTES} we
 *  fall back to a minimal `{hook_event_name, truncated}` envelope so the result
 *  is always valid JSON, never a torn string. */
function boundedData(
  hookEvent: string,
  payload: Record<string, unknown>,
): string {
  const full = JSON.stringify(payload);
  if (Buffer.byteLength(full, "utf8") <= MAX_DATA_BYTES) {
    return full;
  }
  return JSON.stringify({ hook_event_name: hookEvent, truncated: true });
}

function normalizedPiToolName(name: string | null): string | null {
  switch (name) {
    case "bash":
      return "Bash";
    case "edit":
      return "Edit";
    case "read":
      return "Read";
    case "write":
      return "Write";
    default:
      return name;
  }
}

function compatiblePiToolInput(
  toolName: string | null,
  input: unknown,
): unknown {
  if (
    (toolName !== "Write" && toolName !== "Edit") ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return input ?? null;
  }
  const record = input as Record<string, unknown>;
  return typeof record.path === "string"
    ? { ...record, file_path: record.path }
    : record;
}

function piResultText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  let bytes = 0;
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    bytes +=
      Buffer.byteLength(record.text, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes > 64_000) return null;
    parts.push(record.text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function piMonitorTaskId(details: unknown): string | null {
  try {
    if (
      details === null ||
      typeof details !== "object" ||
      Array.isArray(details)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(details);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const taskId = (details as Record<string, unknown>).taskId;
    return typeof taskId === "string" && taskId.trim() !== "" ? taskId : null;
  } catch {
    return null;
  }
}

export interface PiMutationPathFs {
  lstat: typeof lstatSync;
  stat: typeof statSync;
  realpath: typeof realpathSync;
}

function samePiFsIdentity(
  left: { dev: number | bigint; ino: number | bigint; mode: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; mode: number | bigint },
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino) &&
    (BigInt(left.mode) & 0o170000n) === (BigInt(right.mode) & 0o170000n)
  );
}

const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Byte-for-byte local mirror of Pi's write/edit `resolveToCwd` path grammar.
 * Keep self-contained: this extension is loaded in isolation and cannot import
 * Pi's internal implementation. */
export function resolvePiMutationInputPath(path: string, cwd: string): string {
  const normalize = (
    input: string,
    options: { unicodeSpaces?: boolean; stripAt?: boolean } = {},
  ): string => {
    let normalized = options.unicodeSpaces
      ? input.replace(PI_UNICODE_SPACES, " ")
      : input;
    if (options.stripAt && normalized.startsWith("@")) {
      normalized = normalized.slice(1);
    }
    if (normalized === "~") return homedir();
    if (
      normalized.startsWith("~/") ||
      (process.platform === "win32" && normalized.startsWith("~\\"))
    ) {
      normalized = join(homedir(), normalized.slice(2));
    }
    if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
    return normalized;
  };
  const normalized = normalize(path, {
    unicodeSpaces: true,
    stripAt: true,
  });
  const normalizedCwd = normalize(cwd);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(normalizedCwd, normalized);
}

/** Canonical successful Pi write/edit identity. Filesystem reads are producer-
 * side only; reducers and commit-work consume the persisted scalar. */
export function canonicalPiMutationPath(
  path: string | null,
  cwd: string,
  fs: PiMutationPathFs = {
    lstat: lstatSync,
    stat: statSync,
    realpath: realpathSync,
  },
): string | null {
  if (
    path === null ||
    path === "" ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 32_768
  ) {
    return null;
  }
  let absolute: string;
  try {
    absolute = resolvePiMutationInputPath(path, cwd);
  } catch {
    return null;
  }
  if (absolute === "") return null;
  try {
    const before = fs.lstat(absolute);
    const followedBefore = fs.stat(absolute);
    const canonical = fs.realpath(absolute);
    const canonicalIdentity = fs.stat(canonical);
    const after = fs.lstat(absolute);
    const followedAfter = fs.stat(absolute);
    if (
      samePiFsIdentity(before, after) &&
      samePiFsIdentity(followedBefore, followedAfter) &&
      samePiFsIdentity(followedBefore, canonicalIdentity) &&
      fs.realpath(absolute) === canonical
    ) {
      // Pi's native write/edit follows a leaf symlink. Attribute the bytes it
      // actually changed, unlike Git operations that intentionally edit the
      // symlink entry itself.
      return canonical;
    }
  } catch {
    // A new/deleted/swapped leaf is represented through a stable parent below.
  }
  let parent = dirname(absolute);
  const suffix = [basename(absolute)];
  for (;;) {
    try {
      const before = fs.lstat(parent);
      const followedBefore = fs.stat(parent);
      const canonical = fs.realpath(parent);
      const canonicalIdentity = fs.stat(canonical);
      const after = fs.lstat(parent);
      const followedAfter = fs.stat(parent);
      if (
        samePiFsIdentity(before, after) &&
        samePiFsIdentity(followedBefore, followedAfter) &&
        samePiFsIdentity(followedBefore, canonicalIdentity) &&
        fs.realpath(parent) === canonical
      ) {
        return join(canonical, ...suffix.reverse());
      }
    } catch {
      // Continue to the nearest stable existing ancestor.
    }
    const next = dirname(parent);
    if (next === parent) return null;
    suffix.push(basename(parent));
    parent = next;
  }
}

/** Enrich only a confirmed successful native Pi file mutation. */
export function preparePiMutationEvent(
  event: PiObservedEvent,
  cwd: string,
  fs?: PiMutationPathFs,
): PiObservedEvent {
  const toolName = normalizedPiToolName(
    typeof event.toolName === "string" ? event.toolName : null,
  );
  if (
    event.type !== "tool_result" ||
    event.isError !== false ||
    (toolName !== "Write" && toolName !== "Edit") ||
    event.input === null ||
    typeof event.input !== "object" ||
    Array.isArray(event.input)
  ) {
    return event;
  }
  const path = (event.input as Record<string, unknown>).path;
  return {
    ...event,
    mutationPath: canonicalPiMutationPath(
      typeof path === "string" ? path : null,
      cwd,
      fs,
    ),
  };
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
 *   tool_result              → PostToolUse[/Failure] (tool churn → un-stop)
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
    ...(meta.backendExec?.type === "tmux" &&
    meta.backendExec.paneId !== null
      ? {
          backend_exec_type: meta.backendExec.type,
          backend_exec_session_id: meta.backendExec.sessionId,
          backend_exec_pane_id: meta.backendExec.paneId,
        }
      : {}),
  });

  switch (event.type) {
    case "agent_start":
      return {
        ...base("UserPromptSubmit", "user_prompt_submit"),
        data: boundedData("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
          ...dispatchAttemptPayload(meta),
        }),
      };
    case "agent_end":
      return {
        ...base("Stop", "stop"),
        data: boundedData("Stop", {
          hook_event_name: "Stop",
          ...dispatchAttemptPayload(meta),
          ...(meta.backgroundTasks === undefined
            ? {}
            : { background_tasks: meta.backgroundTasks }),
        }),
      };
    case "tool_call": {
      const toolName = normalizedPiToolName(
        typeof event.toolName === "string" ? event.toolName : null,
      );
      return {
        ...base("PreToolUse", "pre_tool_use"),
        tool_name: toolName,
        // Native Pi `{path}` is adapted to the cross-harness `file_path`
        // shape, while the original inert fields remain available in `data`.
        data: boundedData("PreToolUse", {
          hook_event_name: "PreToolUse",
          ...dispatchAttemptPayload(meta),
          tool_name: toolName,
          tool_input: compatiblePiToolInput(toolName, event.input),
        }),
      };
    }
    case "tool_result": {
      const toolName = normalizedPiToolName(
        typeof event.toolName === "string" ? event.toolName : null,
      );
      const stdout = piResultText(event.content);
      const succeeded = event.isError === false;
      const failed = !succeeded;
      const taskId =
        succeeded && toolName === "Monitor"
          ? piMonitorTaskId(event.details)
          : null;
      const toolResponse =
        stdout === null && taskId === null
          ? null
          : {
              ...(stdout === null ? {} : { stdout }),
              ...(taskId === null ? {} : { taskId }),
            };
      const hookEvent = failed ? "PostToolUseFailure" : "PostToolUse";
      return {
        ...base(hookEvent, failed ? "post_tool_use_failure" : "post_tool_use"),
        tool_name: toolName,
        ...(!failed && (toolName === "Write" || toolName === "Edit")
          ? {
              // Present NULL is authoritative at the ingest seam: a failed
              // canonicalization must never be re-derived from lexical data as
              // though it came from an older producer.
              mutation_path:
                typeof event.mutationPath === "string"
                  ? event.mutationPath
                  : null,
            }
          : {}),
        data: boundedData(hookEvent, {
          hook_event_name: hookEvent,
          ...dispatchAttemptPayload(meta),
          tool_name: toolName,
          tool_input: compatiblePiToolInput(toolName, event.input),
          is_error: failed,
          ...(toolResponse === null ? {} : { tool_response: toolResponse }),
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
        data: boundedData("SessionEnd", {
          hook_event_name: "SessionEnd",
          ...dispatchAttemptPayload(meta),
        }),
      };
    default:
      // Unknown / unmapped event kind — a no-op, never an error. Keeps the
      // translation forward-compatible with pi vocabulary additions.
      return null;
  }
}

/**
 * Translate a Pi session title into the same lifecycle-neutral `TranscriptTitle`
 * shape the daemon's transcript worker mints synthetically for claude
 * (`src/daemon.ts`'s `transcript-title` handler): `hook_event:
 * "TranscriptTitle"` folds at the reducer's priority-3 `'transcript'` title
 * source (`src/reducer.ts`'s `titleSourceForEvent`) regardless of whether the
 * rename came from `/rename`, `/name`, or RPC — `session_info_changed` fires
 * for all three. PURE.
 */
export function titleEventBindings(
  title: string,
  meta: PiTranslateMeta,
): PiEventBindings {
  return {
    ts: meta.tsSec,
    session_id: meta.jobId,
    pid: meta.pid,
    hook_event: "TranscriptTitle",
    event_type: "transcript_title",
    cwd: meta.cwd,
    data: boundedData("TranscriptTitle", { session_title: title }),
  };
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

export interface PiEventStorePaths {
  eventsLogDir: string;
  deadLetterDir: string;
}

/** Fixed OS-user authority stores. Environment overrides are daemon/test
 * configuration and cannot divert a live Pi session's mutation evidence. */
export function defaultPiEventStorePaths(): PiEventStorePaths {
  const state = join(userInfo().homedir, ".local", "state", "keeper");
  return {
    eventsLogDir: join(state, "events-log"),
    deadLetterDir: join(state, "dead-letters"),
  };
}

function appendPrivateLine(dir: string, pid: number, line: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // The append below is authoritative; mkdir can race an existing directory.
  }
  const file = join(dir, `${pid}.ndjson`);
  appendFileSync(file, line);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Data is already append-complete; mode repair is best effort.
  }
}

function serializePiDeadLetter(bindings: PiEventBindings, pid: number): string {
  const sessionId = bindings.session_id;
  const hookEvent = bindings.hook_event;
  const ts = bindings.ts;
  return `${JSON.stringify({
    dl_id: randomUUID(),
    session_id: typeof sessionId === "string" ? sessionId : "unknown",
    hook_event: typeof hookEvent === "string" ? hookEvent : "unknown",
    ts: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now() / 1000,
    dl_written_at: Date.now() / 1000,
    pid,
    bindings,
  })}\n`;
}

/** Append one complete receipt or route the exact bindings to the recovery
 * channel. Neither failure may escape into the human's Pi session. */
function appendPiBindings(
  paths: PiEventStorePaths,
  pid: number,
  bindings: PiEventBindings,
): void {
  try {
    appendPrivateLine(paths.eventsLogDir, pid, serializePiLine(bindings));
    return;
  } catch {
    // Preserve the mutation evidence through the dead-letter channel below.
  }
  try {
    appendPrivateLine(
      paths.deadLetterDir,
      pid,
      serializePiDeadLetter(bindings, pid),
    );
  } catch {
    // Presence-only degradation remains fail-open for the harness.
  }
}

// ---------------------------------------------------------------------------
// bounded cross-harness history tool (keeper CLI bridge)
// ---------------------------------------------------------------------------

const HISTORY_TOOL_TIMEOUT_MS = 20_000;
const HISTORY_TOOL_MAX_BUFFER = 256 * 1024;
const HISTORY_MAX_CHARS_CAP = 60_000;
const HISTORY_LIST_LIMIT_CAP = 100;
const HISTORY_SHOW_LIMIT_CAP = 500;
const HISTORY_SEARCH_LIMIT_CAP = 200;
const HISTORY_REFERENCE_MAX_CHARS = 4_096;
const HISTORY_QUERY_MAX_CHARS = 4_096;
const HISTORY_PATH_MAX_CHARS = 4_096;
const HISTORY_OPERATIONS = [
  "list",
  "show",
  "page",
  "search",
  "transcript_show",
  "transcript_turn",
] as const;

type HistoryOperation = (typeof HISTORY_OPERATIONS)[number];

/** Plain JSON Schema keeps this isolated extension node:*-only while retaining
 * Pi's normal number/boolean coercion behavior. */
function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function integerSchema(description: string): Record<string, unknown> {
  return { type: "integer", description };
}

function booleanSchema(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

const HISTORY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: HISTORY_OPERATIONS,
      description:
        "list, show, page, or search unified history; transcript_show/transcript_turn explicitly select specialist low-level readers.",
    },
    session: stringSchema(
      "Shared Session reference: qualified native id, exact job/native id, or exact title.",
    ),
    query: stringSchema("Literal history search query."),
    harness: stringSchema(
      "Harness filter (claude or pi), or the explicit low-level harness.",
    ),
    project: stringSchema("Optional project path used to filter/disambiguate."),
    artifact: stringSchema(
      "History show/page only: exact artifact path for duplicate native ids.",
    ),
    offset: integerSchema("Result or transcript page offset."),
    before: integerSchema("Backward transcript page boundary."),
    limit: integerSchema("Maximum sessions, hits, or transcript entries."),
    max_chars: integerSchema("Maximum rendered transcript characters."),
    grep: stringSchema("Case-insensitive transcript content filter."),
    since: stringSchema(
      "Show/search entry lower time bound (ISO/date or relative duration).",
    ),
    until: stringSchema("Show/search entry upper time bound."),
    subagent: stringSchema(
      "Low-level transcript_show only: subagent id/prefix or all.",
    ),
    tools: stringSchema(
      "Low-level transcript_show only: none, compact, or full.",
    ),
    include_meta: booleanSchema(
      "Low-level transcript_show only: include injected meta/system entries.",
    ),
    include_thinking: booleanSchema(
      "Low-level transcript_show only: include thinking blocks.",
    ),
    leaf: stringSchema("Low-level transcript_turn only: Pi entry id or root."),
    strip_skills: booleanSchema(
      "Low-level transcript_turn only: remove expanded skill envelopes.",
    ),
  },
};

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

function historyOperation(params: PiHistoryParams): HistoryOperation | string {
  if (typeof params.operation === "string" && params.operation.length > 0) {
    return params.operation;
  }
  if ((params.query?.trim() ?? "").length > 0) return "search";
  if ((params.session?.trim() ?? "").length > 0) return "show";
  return "list";
}

export interface HistoryClamp {
  param: "limit" | "max_chars";
  requested: number;
  applied: number;
}

export function clampHistoryParams(params: PiHistoryParams): {
  params: PiHistoryParams;
  clamps: HistoryClamp[];
} {
  const next: PiHistoryParams = { ...params };
  const clamps: HistoryClamp[] = [];
  const operation = historyOperation(params);
  const limitCap =
    operation === "list"
      ? HISTORY_LIST_LIMIT_CAP
      : operation === "search"
        ? HISTORY_SEARCH_LIMIT_CAP
        : HISTORY_SHOW_LIMIT_CAP;
  if (
    typeof next.limit === "number" &&
    Number.isFinite(next.limit) &&
    next.limit > limitCap
  ) {
    clamps.push({ param: "limit", requested: next.limit, applied: limitCap });
    next.limit = limitCap;
  }
  if (
    (operation === "show" ||
      operation === "page" ||
      operation === "transcript_show") &&
    typeof next.max_chars === "number" &&
    Number.isFinite(next.max_chars) &&
    next.max_chars > HISTORY_MAX_CHARS_CAP
  ) {
    clamps.push({
      param: "max_chars",
      requested: next.max_chars,
      applied: HISTORY_MAX_CHARS_CAP,
    });
    next.max_chars = HISTORY_MAX_CHARS_CAP;
  }
  return { params: next, clamps };
}

const LOW_LEVEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function invalidText(
  value: unknown,
  name: string,
  maxChars: number,
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${name} is required`;
  }
  if (value.length > maxChars) return `${name} exceeds ${maxChars} characters`;
  if (value.includes("\0")) return `${name} contains a NUL byte`;
  return null;
}

/** Validate semantic/tool argv constraints before any subprocess is spawned. */
export function historyParamError(params: PiHistoryParams): string | null {
  const operation = historyOperation(params);
  if (!(HISTORY_OPERATIONS as readonly string[]).includes(operation)) {
    return `operation must be one of ${HISTORY_OPERATIONS.join(", ")}`;
  }
  if (params.offset !== undefined && params.before !== undefined) {
    return "offset and before are mutually exclusive";
  }
  for (const [name, value] of [
    ["offset", params.offset],
    ["before", params.before],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    ) {
      return `${name} must be a non-negative integer`;
    }
  }
  for (const [name, value] of [
    ["limit", params.limit],
    ["max_chars", params.max_chars],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    ) {
      return `${name} must be a positive integer`;
    }
  }
  for (const [name, value, max] of [
    ["project", params.project, HISTORY_PATH_MAX_CHARS],
    ["artifact", params.artifact, HISTORY_PATH_MAX_CHARS],
    ["session", params.session, HISTORY_REFERENCE_MAX_CHARS],
    ["query", params.query, HISTORY_QUERY_MAX_CHARS],
    ["grep", params.grep, HISTORY_QUERY_MAX_CHARS],
    ["since", params.since, 512],
    ["until", params.until, 512],
  ] as const) {
    if (value !== undefined) {
      const error = invalidText(value, name, max);
      if (error !== null) return error;
    }
  }

  if (operation === "show" || operation === "page") {
    const error = invalidText(
      params.session,
      "session",
      HISTORY_REFERENCE_MAX_CHARS,
    );
    if (error !== null) return error;
  }
  if (
    operation === "page" &&
    params.offset === undefined &&
    params.before === undefined
  ) {
    return "page requires offset or before";
  }
  if (operation === "search") {
    const error = invalidText(params.query, "query", HISTORY_QUERY_MAX_CHARS);
    if (error !== null) return error;
  }
  if (operation === "transcript_show" || operation === "transcript_turn") {
    const sessionError = invalidText(
      params.session,
      "session",
      HISTORY_REFERENCE_MAX_CHARS,
    );
    if (sessionError !== null) return sessionError;
    if (
      typeof params.harness !== "string" ||
      !["claude", "pi"].includes(params.harness)
    ) {
      return "an explicit claude or pi harness is required for a low-level operation";
    }
  }
  if (operation === "transcript_turn") {
    if (params.harness !== "pi") return "transcript_turn is pi-only";
    const leafError = invalidText(params.leaf, "leaf", 512);
    if (leafError !== null) return leafError;
    if (params.leaf !== "root" && !LOW_LEVEL_ID.test(params.leaf as string)) {
      return "leaf must be root or an id containing letters, digits, dot, underscore, or hyphen";
    }
  }
  if (operation !== "transcript_show") {
    if (
      params.subagent !== undefined ||
      params.tools !== undefined ||
      params.include_meta !== undefined ||
      params.include_thinking !== undefined
    ) {
      return "subagent/tools/include_meta/include_thinking require operation=transcript_show";
    }
  } else {
    if (
      params.subagent !== undefined &&
      (!LOW_LEVEL_ID.test(params.subagent) || params.subagent.length > 200)
    ) {
      return "subagent is not a valid bounded id/prefix";
    }
    if (
      params.tools !== undefined &&
      !["none", "compact", "full"].includes(params.tools)
    ) {
      return "tools must be none, compact, or full";
    }
  }
  if (
    operation !== "transcript_turn" &&
    (params.leaf !== undefined || params.strip_skills !== undefined)
  ) {
    return "leaf/strip_skills require operation=transcript_turn";
  }
  if (
    operation === "list" &&
    (params.since !== undefined || params.until !== undefined)
  ) {
    return "since/until apply to show/search, not history list";
  }
  if (params.query !== undefined && operation !== "search") {
    return "query requires operation=search";
  }
  if (
    params.artifact !== undefined &&
    operation !== "show" &&
    operation !== "page"
  ) {
    return "artifact applies only to history show/page";
  }
  if (params.session !== undefined && operation === "list") {
    return "session does not apply to history list";
  }
  if (
    params.before !== undefined &&
    operation !== "show" &&
    operation !== "page" &&
    operation !== "transcript_show"
  ) {
    return "before applies only to show/page/transcript_show";
  }
  if (
    params.grep !== undefined &&
    operation !== "show" &&
    operation !== "page" &&
    operation !== "transcript_show"
  ) {
    return "grep applies only to show/page/transcript_show";
  }
  if (
    params.max_chars !== undefined &&
    operation !== "show" &&
    operation !== "page" &&
    operation !== "transcript_show"
  ) {
    return "max_chars applies only to show/page/transcript_show";
  }
  if (
    params.harness !== undefined &&
    operation !== "transcript_show" &&
    operation !== "transcript_turn"
  ) {
    if (!["claude", "pi"].includes(params.harness)) {
      return "history harness must be claude or pi";
    }
    if (operation !== "list" && operation !== "search") {
      return "harness filters apply only to list/search; qualify a show/page Session reference instead";
    }
  }
  return null;
}

function buildHistoryArgv(params: PiHistoryParams): string[] {
  const operation = historyOperation(params) as HistoryOperation;
  if (operation === "list") {
    const args = ["history", "list"];
    pushStringFlag(args, "--harness", params.harness);
    pushStringFlag(args, "--project", params.project);
    pushNumberFlag(args, "--offset", params.offset);
    pushNumberFlag(args, "--limit", params.limit);
    return args;
  }
  if (operation === "search") {
    const args = ["history", "search"];
    pushStringFlag(args, "--session", params.session);
    pushStringFlag(args, "--harness", params.harness);
    pushStringFlag(args, "--project", params.project);
    pushNumberFlag(args, "--offset", params.offset);
    pushNumberFlag(args, "--limit", params.limit);
    pushStringFlag(args, "--since", params.since);
    pushStringFlag(args, "--until", params.until);
    args.push("--", params.query as string);
    return args;
  }
  if (operation === "show" || operation === "page") {
    const args = ["history", "show"];
    pushStringFlag(args, "--project", params.project);
    pushStringFlag(args, "--artifact", params.artifact);
    pushNumberFlag(args, "--offset", params.offset);
    pushNumberFlag(args, "--before", params.before);
    pushNumberFlag(args, "--limit", params.limit);
    pushNumberFlag(args, "--max-chars", params.max_chars);
    pushStringFlag(args, "--grep", params.grep);
    pushStringFlag(args, "--since", params.since);
    pushStringFlag(args, "--until", params.until);
    args.push("--", params.session as string);
    return args;
  }
  const harness = params.harness as string;
  if (operation === "transcript_turn") {
    const args = ["transcript", harness, "turn"];
    pushStringFlag(args, "--project", params.project);
    pushStringFlag(args, "--leaf", params.leaf);
    if (params.strip_skills === true) args.push("--strip-skills");
    args.push("--", params.session as string);
    return args;
  }
  const args = ["transcript", harness, "show"];
  pushStringFlag(args, "--project", params.project);
  pushNumberFlag(args, "--offset", params.offset);
  pushNumberFlag(args, "--before", params.before);
  pushNumberFlag(args, "--limit", params.limit);
  pushNumberFlag(args, "--max-chars", params.max_chars);
  pushStringFlag(args, "--grep", params.grep);
  pushStringFlag(args, "--since", params.since);
  pushStringFlag(args, "--until", params.until);
  pushStringFlag(args, "--subagent", params.subagent);
  pushStringFlag(args, "--tools", params.tools);
  if (params.include_meta === true) args.push("--meta");
  if (params.include_thinking === true) args.push("--thinking");
  args.push("--", params.session as string);
  return args;
}

export function historyCliArgs(params: PiHistoryParams): string[] {
  return buildHistoryArgv(clampHistoryParams(params).params);
}

function boundedToolText(text: string): string {
  if (text.length <= HISTORY_TOOL_MAX_BUFFER) return text;
  return `${text.slice(0, HISTORY_TOOL_MAX_BUFFER)}\n[output truncated by pi extension]`;
}

const HISTORY_MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
const HISTORY_ABORT_CODE = "ABORT_ERR";

export type HistoryToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function historyToolResult(
  error: { code?: unknown; message?: string } | null | undefined,
  stdout: string,
  stderr: string,
  args: string[],
  clamps: HistoryClamp[],
): HistoryToolResult {
  const out = boundedToolText(stdout);
  const err = boundedToolText(stderr);
  const details: Record<string, unknown> = { argv: args };
  if (clamps.length > 0) details.clamps = clamps;
  if (error === null || error === undefined) {
    return {
      content: [{ type: "text", text: out || "(no history output)" }],
      details: { ...details, exit_code: 0 },
    };
  }
  const code = error.code ?? null;
  if (code === HISTORY_MAXBUFFER_CODE) {
    return {
      content: [
        {
          type: "text",
          text: `${out}${out ? "\n" : ""}[history output truncated - narrow with session/query/limit]`,
        },
      ],
      details: { ...details, exit_code: null, truncated: true },
    };
  }
  if (code === HISTORY_ABORT_CODE) {
    return {
      content: [{ type: "text", text: "keeper history cancelled" }],
      details: { ...details, exit_code: null, cancelled: true },
    };
  }
  const message = err.trim() || out.trim() || error.message || "unknown error";
  return {
    content: [{ type: "text", text: `keeper history failed: ${message}` }],
    details: { ...details, exit_code: code },
  };
}

export type HistoryExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
  callback: (
    error: { code?: unknown; message?: string } | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

export async function executeHistoryTool(
  params: PiHistoryParams,
  signal?: AbortSignal,
  run: HistoryExecFile = execFile as unknown as HistoryExecFile,
): Promise<HistoryToolResult> {
  const paramError = historyParamError(params);
  if (paramError !== null) {
    return {
      content: [
        { type: "text", text: `keeper history rejected: ${paramError}` },
      ],
      details: { rejected: paramError },
    };
  }
  const { params: clamped, clamps } = clampHistoryParams(params);
  const args = buildHistoryArgv(clamped);
  if (signal?.aborted === true) {
    return historyToolResult(
      { code: HISTORY_ABORT_CODE, message: "aborted" },
      "",
      "",
      args,
      clamps,
    );
  }
  return new Promise((resolve) => {
    const options = {
      encoding: "utf8" as const,
      timeout: HISTORY_TOOL_TIMEOUT_MS,
      maxBuffer: HISTORY_TOOL_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    };
    run("keeper", args, options, (error, stdout, stderr) => {
      resolve(historyToolResult(error, stdout, stderr, args, clamps));
    });
  });
}

const HISTORY_TOOL: PiToolDefinition<PiHistoryParams> = {
  name: "keeper_history",
  label: "Keeper History",
  description:
    "List, resolve, search, and page bounded Claude/Pi Session history. Session references accept qualified native ids, job aliases, native ids, and exact titles. Specialist transcript operations must be selected explicitly.",
  promptSnippet:
    "Traverse bounded cross-harness Session history through Keeper.",
  promptGuidelines: [
    "Use keeper_history for cross-harness discovery: list/search to find context, show for the newest bounded page, and page with older_before or newer_offset. Use transcript_show/transcript_turn only for specialist subagent or Pi branch operations.",
  ],
  parameters: HISTORY_TOOL_PARAMETERS,
  async execute(_toolCallId, params, signal) {
    try {
      return await executeHistoryTool(params, signal);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `keeper history failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        details: { exit_code: null },
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Agent Bus delivery
// ---------------------------------------------------------------------------

/** Inject one peer message with Monitor-like wake semantics. Never throws. */
export function sendPiBusMessage(pi: PiExtensionApi, line: string): void {
  try {
    pi.sendMessage?.(
      {
        customType: "keeper-agent-bus",
        content: line,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  } catch {
    // A session replacement invalidates the old extension API.
  }
}

function sendPiMonitorBatch(pi: PiExtensionApi, batch: MonitorLineBatch): void {
  try {
    pi.sendMessage?.(
      {
        customType: "keeper-monitor-batch",
        content: [
          "[automated monitor update — not a user message]",
          `task id: ${batch.taskId}`,
          `description: ${batch.description}`,
          "stdout:",
          ...batch.lines,
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  } catch {
    // A session replacement invalidates the old extension API.
  }
}

function monitorTerminalDetail(outcome: MonitorTerminalOutcome): string {
  if (outcome.status === "timed_out") return "timeout reached";
  if (outcome.signal !== null) return `signal: ${outcome.signal}`;
  if (outcome.exitCode !== null) return `exit code: ${outcome.exitCode}`;
  return "exit code: unavailable; signal: none";
}

function sendPiMonitorTerminal(
  pi: PiExtensionApi,
  outcome: MonitorTerminalOutcome,
): void {
  try {
    pi.sendMessage?.(
      {
        customType: "keeper-monitor-terminal",
        content: [
          "[automated monitor finished — not a user message]",
          `task id: ${outcome.taskId}`,
          `description: ${outcome.description}`,
          `status: ${outcome.status}`,
          monitorTerminalDetail(outcome),
          `private output artifact: ${outcome.artifactPath ?? "unavailable"}`,
          ...(outcome.error === undefined ? [] : [`error: ${outcome.error}`]),
          `suppressed lines: ${outcome.suppressedLines}`,
        ].join("\n"),
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  } catch {
    // A session replacement invalidates the old extension API.
  }
}

// ---------------------------------------------------------------------------
// extension factory (pi's default-export entry point)
// ---------------------------------------------------------------------------

/** The keeper env marker whose presence arms the extension. Its value is the
 *  keeper job id every emitted line joins on. */
const KEEPER_JOB_ID_ENV = "KEEPER_JOB_ID";

type PiMonitorRuntimeOptions = Omit<
  PiMonitorControllerOptions,
  "deliverBatch" | "deliverTerminal"
>;

interface PiBusInboxRuntime {
  start(): void;
  ambientTask(): AmbientBusWatchTask | null;
  stop(): Promise<void>;
}

export interface PiExtensionRuntimeOptions {
  monitor?: PiMonitorRuntimeOptions;
  busInbox?: PiBusInboxRuntime;
}

/**
 * The pi extension entry point. Registers observer handlers that mirror pi's
 * lifecycle into the events-log plus the bounded history tool. NO-OPS
 * entirely when `KEEPER_JOB_ID` is absent
 * (a pi session started outside keeper), and is wrapped so it can NEVER throw out
 * of the factory (pi aborts the launch on a load-time throw) nor out of a handler
 * (degrade to presence-only, never crash the human's session).
 */
export default function keeperEvents(
  pi: PiExtensionApi,
  injectedStorePaths?: PiEventStorePaths,
  runtimeOptions: PiExtensionRuntimeOptions = {},
): void {
  try {
    const jobId = (process.env[KEEPER_JOB_ID_ENV] ?? "").trim();
    if (jobId === "") {
      // No keeper marker → this is the human's own pi session. Register nothing,
      // write nothing: zero extension output, no orphan events.
      return;
    }
    const pid = process.pid;
    const cwd = process.cwd();
    const storePaths = injectedStorePaths ?? defaultPiEventStorePaths();
    const dispatchAttemptId = piDispatchAttemptFromEnv(process.env);
    const backendExec = piBackendExecCoordsFromEnv(process.env);
    const busInbox =
      typeof pi.sendMessage === "function"
        ? (runtimeOptions.busInbox ??
          new PiBusInboxController({
            deliver: (line) => sendPiBusMessage(pi, line),
          }))
        : null;
    const busOwnerToken = {};
    let ownsBusInbox = false;
    let monitorController: PiMonitorController | null = null;
    let monitorDeliveryFenced = false;
    let refreshStatusFooter = (): void => {};

    const emit = (event: PiObservedEvent, context?: PiSessionContext): void => {
      try {
        const eventCwd =
          typeof context?.cwd === "string" && context.cwd !== ""
            ? context.cwd
            : cwd;
        const observed = preparePiMutationEvent(event, eventCwd);
        const ambientTask =
          event.type === "agent_end" ? (busInbox?.ambientTask() ?? null) : null;
        const bindings = piEventBindings(observed, {
          jobId,
          pid,
          cwd: eventCwd,
          tsSec: Date.now() / 1000,
          backendExec,
          ...(dispatchAttemptId == null ? {} : { dispatchAttemptId }),
          ...(event.type === "agent_end"
            ? {
                backgroundTasks: [
                  ...(monitorController?.list() ?? []),
                  ...(ambientTask === null
                    ? []
                    : [{ ...ambientTask, kind: "ambient" as const }]),
                ],
              }
            : {}),
        });
        if (bindings !== null) appendPiBindings(storePaths, pid, bindings);
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
      pi.on(kind, (event, context) => {
        emit(event, context);
        if (kind === "tool_result" && event.toolName === "Monitor") {
          try {
            refreshStatusFooter();
          } catch {
            // Monitor UI is advisory; lifecycle recording remains authoritative.
          }
        }
      });
    }
    // NOT observer-only: pi awaits these return values to rewrite raw input
    // or extend its skill search path, so each handler resolves to a safe
    // undefined instead of letting a throw escape into pi's core (ADR 0091).
    pi.on("input", (event) => {
      try {
        const text = expandSkillShorthandInput(event.text);
        return text === event.text ? undefined : { action: "transform", text };
      } catch {
        return undefined;
      }
    });
    pi.on("resources_discover", () => {
      try {
        return { skillPaths: piSkillShorthandResourcePaths() };
      } catch {
        return undefined;
      }
    });
    pi.on("session_start", (_event, context) => {
      try {
        if (busInbox !== null && claimBusInboxOwnership(busOwnerToken)) {
          ownsBusInbox = true;
          busInbox.start();
        }
      } catch {
        // Presence-only degradation: a bus child must never break Pi startup.
      }
      try {
        if (context !== undefined) {
          refreshStatusFooter = installPiStatusFooter(
            pi as PiExtensionApi & PiFooterApi,
            context,
            jobId,
            {
              getMonitorCount: () => monitorController?.list().length ?? 0,
            },
          );

          void installPiEditorBorder(pi, context);
        }
      } catch {
        // A cosmetic footer/editor failure must never break Pi startup.
      }
      try {
        if (context !== undefined) {
          installSkillShorthandAutocomplete(context);
        }
      } catch {
        // Autocomplete is advisory and must never break Pi startup.
      }
    });
    for (const kind of ["turn_end", "model_select", "thinking_level_select"]) {
      pi.on(kind, () => {
        try {
          refreshStatusFooter();
        } catch {
          // Rendering and telemetry are advisory.
        }
      });
    }
    pi.on("session_shutdown", async () => {
      monitorDeliveryFenced = true;
      try {
        await monitorController?.stopAll();
      } catch {
        // Session teardown must remain fail-open for every shutdown reason.
      }
      if (!ownsBusInbox) return;
      ownsBusInbox = false;
      try {
        await busInbox?.stop();
      } catch {
        // Session teardown must remain fail-open for every shutdown reason.
      } finally {
        releaseBusInboxOwnership(busOwnerToken);
      }
    });
    if (typeof pi.registerTool === "function") {
      try {
        pi.registerTool(HISTORY_TOOL);
      } catch {
        // One unavailable tool must not suppress the rest of the extension.
      }
      try {
        pi.registerTool(createPiCommitWorkTool());
      } catch {
        // One unavailable tool must not suppress the rest of the extension.
      }
      if (pi.events !== undefined) {
        try {
          pi.registerTool(createTaskFacadeTool(pi.events));
        } catch {
          // One unavailable tool must not suppress the rest of the extension.
        }
      }
      if (typeof pi.sendMessage === "function") {
        try {
          const controller = new PiMonitorController({
            ...runtimeOptions.monitor,
            deliverBatch: (batch) => {
              if (monitorDeliveryFenced) return;
              try {
                sendPiMonitorBatch(pi, batch);
              } catch {
                // Delivery is advisory and may race session replacement.
              }
            },
            deliverTerminal: (outcome) => {
              if (monitorDeliveryFenced) return;
              try {
                sendPiMonitorTerminal(pi, outcome);
              } catch {
                // Delivery is advisory and may race session replacement.
              }
              try {
                refreshStatusFooter();
              } catch {
                // Monitor UI is advisory and may race session replacement.
              }
            },
          });
          pi.registerTool(createMonitorFacadeTool(controller));
          monitorController = controller;
        } catch {
          monitorController = null;
        }
      }
    }
    if (
      typeof pi.registerCommand === "function" &&
      typeof pi.setSessionName === "function"
    ) {
      // Cast to the real structural contract `rename-command.ts` needs
      // (`registerCommand`'s options shape plus typed title, settle, and
      // shutdown handlers) — same runtime object, a narrower view than this
      // file's own minimal `PiExtensionApi`.
      registerRenameCommand(pi as unknown as PiRenameApi, {
        onTitleChange: (title) => {
          try {
            appendPiBindings(
              storePaths,
              pid,
              titleEventBindings(title, {
                jobId,
                pid,
                cwd,
                tsSec: Date.now() / 1000,
              }),
            );
          } catch {
            // Fail-open: an events-log write failure must never surface to
            // Pi — a missed write heals on the next session_start replay.
          }
        },
      });
    }
  } catch {
    // Top-level fail-open: a load-time throw would ABORT pi's launch. Swallow so
    // the worst case is a no-op extension, never a broken pi session.
  }
}
