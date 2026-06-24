import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentKind } from "./dispatch";

export interface TranscriptStop {
  agent: AgentKind;
  eventType: string;
  reason: string;
  timestamp: string | null;
  /**
   * The final assistant message text carried by the stop event, when the
   * backend's stop record exposes it (codex `task_complete.last_agent_message`;
   * claude/pi assistant content). `null` for a tool-only / structural stop with
   * no readable text — `show-last-message` then falls back to scanning the
   * transcript for the latest assistant text.
   */
  message: string | null;
}

/**
 * The partner's final assistant message resolved for `show-last-message`.
 * `text` is null on an empty/tool-only/refusal final turn so a caller never
 * mistakes a structural stop for an empty answer; `found` records whether ANY
 * assistant message was located at all.
 */
export interface LastMessage {
  agent: AgentKind;
  text: string | null;
  found: boolean;
}

export interface TranscriptWatchOptions {
  agent: AgentKind;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  startedAtMs: number;
  sessionId: string | null;
  pollIntervalMs?: number;
  pathTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** A `waitForTranscriptStop` result that timed out before any stop appeared. */
export type WaitForStopOutcome =
  | { ok: true; stop: TranscriptStop }
  | { ok: false; timedOut: true };

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PATH_TIMEOUT_MS = 30_000;
/**
 * Wall-clock ceiling for the stop wait. A real model turn runs minutes (codex
 * took 238s observed), so this is generous — it is a fail-loud backstop against
 * an unbounded hang, not a turn-length SLA. Overridable via `stopTimeoutMs`.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 600_000;
const START_SLOP_MS = 1_000;

export async function waitForTranscriptPath(
  opts: TranscriptWatchOptions,
): Promise<string | null> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.pathTimeoutMs ?? DEFAULT_PATH_TIMEOUT_MS);

  while (true) {
    const path = findTranscriptPath(opts);
    if (path !== null) {
      return path;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(pollIntervalMs);
  }
}

export async function waitForTranscriptStop(
  opts: TranscriptWatchOptions & { transcriptPath: string },
): Promise<WaitForStopOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);

  while (true) {
    const stop = findTranscriptStop(
      opts.agent,
      opts.transcriptPath,
      opts.startedAtMs,
    );
    if (stop !== null) {
      return { ok: true, stop };
    }
    if (Date.now() >= deadline) {
      return { ok: false, timedOut: true };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Resolve the partner's final assistant message from a transcript, scanning the
 * WHOLE file (no started-at filter) so it works on a finished OR an in-flight
 * run — `wait-for-stop` is the blocking primitive; this just reads the latest.
 * Prefers the text carried on the latest stop event; if that stop is tool-only
 * (no text) it falls back to the latest assistant message with readable text.
 * `found:false` means no stop-or-text-bearing assistant turn was observed —
 * which includes a claude tool-only final turn, since `claudeStopFromObject`
 * excludes `stopReason:"tool_use"` and such a turn carries no assistant text,
 * so neither `sawStop` nor `sawAssistant` flips. `text:null` with `found:true`
 * means a turn was observed but carried no readable text (e.g. a codex refusal
 * whose stop event still registered).
 */
export function findLastMessage(agent: AgentKind, path: string): LastMessage {
  let latestStopText: string | null = null;
  let sawStop = false;
  let latestAssistantText: string | null = null;
  let sawAssistant = false;

  for (const line of readLines(path)) {
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }
    const stop = stopFromObject(agent, parsed);
    if (stop !== null) {
      sawStop = true;
      latestStopText = stop.message;
    }
    const text = assistantMessageText(agent, parsed);
    if (text !== null) {
      sawAssistant = true;
      latestAssistantText = text;
    }
  }

  if (sawStop) {
    return { agent, text: latestStopText ?? latestAssistantText, found: true };
  }
  if (sawAssistant) {
    return { agent, text: latestAssistantText, found: true };
  }
  return { agent, text: null, found: false };
}

/**
 * Extract the readable assistant text from a single transcript line, or null
 * when the line is not a text-bearing assistant message. Mirrors the per-backend
 * stop shapes but is permissive: it pulls text from ANY assistant turn, not only
 * a terminal one, so a fallback scan can find the latest text.
 */
function assistantMessageText(
  agent: AgentKind,
  obj: Record<string, unknown>,
): string | null {
  if (agent === "codex") {
    if (obj.type !== "event_msg") {
      return null;
    }
    const payload = objectValue(obj.payload);
    if (stringValue(payload?.type) === "agent_message") {
      const text = stringValue(payload?.message);
      return text !== null && text !== "" ? text : null;
    }
    if (stringValue(payload?.type) === "task_complete") {
      return codexMessageText(obj);
    }
    return null;
  }
  const type = stringValue(obj.type);
  const message = objectValue(obj.message);
  const role = stringValue(message?.role);
  // claude assistant turns are top-level `type:"assistant"`; pi assistant turns
  // are `type:"message"` with `message.role:"assistant"`. Both carry a
  // `message.content[]` text-block array.
  if (
    role === "assistant" &&
    ((agent === "claude" && type === "assistant") ||
      (agent === "pi" && type === "message"))
  ) {
    return contentArrayText(message?.content);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findTranscriptPath(opts: TranscriptWatchOptions): string | null {
  if (opts.agent === "claude") {
    return findClaudeTranscriptPath(opts);
  }
  if (opts.agent === "codex") {
    return findCodexTranscriptPath(opts);
  }
  return findPiTranscriptPath(opts);
}

function findClaudeTranscriptPath(opts: TranscriptWatchOptions): string | null {
  const projectDir = join(
    opts.homeDir,
    ".claude",
    "projects",
    encodeClaudeCwd(opts.cwd),
  );
  // Strict pinned resolution: a pinned session id resolves to its EXACT
  // `<uuid>.jsonl` or null — never the newest-by-mtime fallback. A concurrent
  // driver in the same project dir writes a newer file; falling through to it is
  // the self-transcript collision this guards against. A future id divergence
  // surfaces as a loud path-timeout, not a silent wrong file. Newest-by-mtime is
  // kept ONLY for the no-id case (codex never reaches here).
  if (opts.sessionId !== null) {
    const exact = join(projectDir, `${opts.sessionId}.jsonl`);
    return existsSync(exact) ? exact : null;
  }
  return newestFreshFile(jsonlFiles(projectDir, false), opts.startedAtMs);
}

function findCodexTranscriptPath(opts: TranscriptWatchOptions): string | null {
  const codexHome =
    (opts.env.CODEX_HOME ?? "").trim() || join(opts.homeDir, ".codex");
  const files = jsonlFiles(join(codexHome, "sessions"), true).filter((path) => {
    const name = basename(path);
    return name.startsWith("rollout-") && name.endsWith(".jsonl");
  });
  const fresh = freshFiles(files, opts.startedAtMs);
  const cwdMatches = fresh.filter((path) => readCodexCwd(path) === opts.cwd);
  return newestFile(cwdMatches) ?? newestFile(fresh);
}

function findPiTranscriptPath(opts: TranscriptWatchOptions): string | null {
  const roots = uniqueStrings([
    (opts.env.PI_CODING_AGENT_DIR ?? "").trim() || null,
    join(opts.homeDir, ".pi", "agent"),
  ]);

  for (const root of roots) {
    const sessionsDir = join(root, "sessions");
    const cwdDir = join(sessionsDir, encodePiCwd(opts.cwd));
    const local = findPiTranscriptInFiles(jsonlFiles(cwdDir, false), opts);
    if (local !== null) {
      return local;
    }
    const recursive = findPiTranscriptInFiles(
      jsonlFiles(sessionsDir, true),
      opts,
    );
    if (recursive !== null) {
      return recursive;
    }
  }
  return null;
}

function findPiTranscriptInFiles(
  files: string[],
  opts: TranscriptWatchOptions,
): string | null {
  // Strict pinned resolution (mirrors claude): a pinned session id resolves to
  // its id-matching file or null — never the newest-by-mtime fallback, so a
  // concurrently-written decoy can't win. Newest-by-mtime serves only the no-id
  // case below.
  if (opts.sessionId !== null) {
    const idMatches = files.filter((path) => {
      return (
        basename(path).includes(opts.sessionId ?? "") ||
        readPiMeta(path).id === opts.sessionId
      );
    });
    return newestFile(idMatches);
  }

  const fresh = freshFiles(files, opts.startedAtMs);
  const cwdMatches = fresh.filter((path) => readPiMeta(path).cwd === opts.cwd);
  return newestFile(cwdMatches) ?? newestFile(fresh);
}

function findTranscriptStop(
  agent: AgentKind,
  path: string,
  startedAtMs: number,
): TranscriptStop | null {
  for (const line of readLines(path)) {
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }
    const eventMs = objectTimestampMs(parsed);
    if (eventMs !== null && eventMs < startedAtMs - START_SLOP_MS) {
      continue;
    }
    const stop = stopFromObject(agent, parsed);
    if (stop !== null) {
      return stop;
    }
  }
  return null;
}

function stopFromObject(
  agent: AgentKind,
  obj: Record<string, unknown>,
): TranscriptStop | null {
  if (agent === "claude") {
    return claudeStopFromObject(obj);
  }
  if (agent === "codex") {
    return codexStopFromObject(obj);
  }
  return piStopFromObject(obj);
}

function claudeStopFromObject(
  obj: Record<string, unknown>,
): TranscriptStop | null {
  const type = stringValue(obj.type);
  const message = objectValue(obj.message);
  const stopReason = stringValue(message?.stop_reason);
  if (
    type === "assistant" &&
    stopReason !== null &&
    stopReason !== "tool_use"
  ) {
    return stopInfo(
      "claude",
      "assistant",
      stopReason,
      obj,
      claudeMessageText(obj),
    );
  }

  const subtype = stringValue(obj.subtype);
  if (type === "system" && subtype === "turn_duration") {
    return stopInfo("claude", subtype, "turn_duration", obj, null);
  }
  if (type === "system" && subtype === "stop_hook_summary") {
    return stopInfo(
      "claude",
      subtype,
      stringValue(obj.stopReason) ?? "stop",
      obj,
      null,
    );
  }
  return null;
}

function codexStopFromObject(
  obj: Record<string, unknown>,
): TranscriptStop | null {
  if (obj.type !== "event_msg") {
    return null;
  }
  const payload = objectValue(obj.payload);
  const eventType = stringValue(payload?.type);
  if (
    eventType === "task_complete" ||
    eventType === "turn_aborted" ||
    eventType === "error"
  ) {
    return stopInfo("codex", eventType, eventType, obj, codexMessageText(obj));
  }
  return null;
}

function piStopFromObject(obj: Record<string, unknown>): TranscriptStop | null {
  const type = stringValue(obj.type);
  if (type === "turn.completed" || type === "turn.failed") {
    return stopInfo("pi", type, type, obj, null);
  }

  const message = objectValue(obj.message);
  const role = stringValue(message?.role);
  const stopReason = stringValue(message?.stopReason);
  if (
    type === "message" &&
    role === "assistant" &&
    stopReason !== null &&
    stopReason !== "toolUse"
  ) {
    return stopInfo("pi", "assistant", stopReason, obj, piMessageText(obj));
  }
  return null;
}

function stopInfo(
  agent: AgentKind,
  eventType: string,
  reason: string,
  obj: Record<string, unknown>,
  message: string | null,
): TranscriptStop {
  return {
    agent,
    eventType,
    reason,
    timestamp: stringValue(obj.timestamp),
    message,
  };
}

/**
 * Concatenate the text of an assistant `message.content[]` block array (claude
 * and pi share this shape). Thinking / tool-use / non-text blocks are skipped.
 * Returns null when no text block carries content, so a tool-only final turn is
 * a defined empty signal rather than a misleading "".
 */
function contentArrayText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      const text = stringValue(b.text);
      if (text !== null && text !== "") {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function claudeMessageText(obj: Record<string, unknown>): string | null {
  return contentArrayText(objectValue(obj.message)?.content);
}

function piMessageText(obj: Record<string, unknown>): string | null {
  return contentArrayText(objectValue(obj.message)?.content);
}

/**
 * Codex carries the final assistant text on the `task_complete` event payload
 * as `last_agent_message`. `turn_aborted` / `error` stops have no such field, so
 * they resolve to null (a defined empty/failed signal).
 */
function codexMessageText(obj: Record<string, unknown>): string | null {
  const payload = objectValue(obj.payload);
  const text = stringValue(payload?.last_agent_message);
  return text !== null && text !== "" ? text : null;
}

function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

function jsonlFiles(root: string, recursive: boolean): string[] {
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: Array<{
      name: string | Buffer;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const path = join(dir, name);
      if (entry.isDirectory()) {
        if (recursive) {
          visit(path);
        }
      } else if (entry.isFile() && name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function freshFiles(files: string[], startedAtMs: number): string[] {
  return files.filter((path) => {
    const stat = safeStat(path);
    return stat !== null && stat.mtimeMs >= startedAtMs - START_SLOP_MS;
  });
}

function newestFreshFile(files: string[], startedAtMs: number): string | null {
  return newestFile(freshFiles(files, startedAtMs));
}

function newestFile(files: string[]): string | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const path of files) {
    const stat = safeStat(path);
    if (stat === null) {
      continue;
    }
    if (newest === null || stat.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return newest?.path ?? null;
}

function safeStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readCodexCwd(path: string): string | null {
  for (const line of readLines(path, 64 * 1024)) {
    if (!line.includes('"type":"session_meta"')) {
      continue;
    }
    const parsed = parseJsonObject(line);
    const payload = objectValue(parsed?.payload);
    return stringValue(payload?.cwd);
  }
  return null;
}

function readPiMeta(path: string): { id: string | null; cwd: string | null } {
  for (const line of readLines(path, 64 * 1024)) {
    const parsed = parseJsonObject(line);
    if (parsed?.type !== "session") {
      continue;
    }
    return {
      id: stringValue(parsed.id),
      cwd: stringValue(parsed.cwd),
    };
  }
  return { id: null, cwd: null };
}

function readLines(path: string, maxBytes?: number): string[] {
  try {
    let text = readFileSync(path, "utf8");
    if (maxBytes !== undefined && text.length > maxBytes) {
      text = text.slice(0, maxBytes);
    }
    return text.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore partial JSONL lines while the agent is writing.
  }
  return null;
}

function objectTimestampMs(obj: Record<string, unknown>): number | null {
  const timestamp = obj.timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof timestamp === "number") {
    return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  }
  const message = objectValue(obj.message);
  const messageTimestamp = message?.timestamp;
  if (typeof messageTimestamp === "number") {
    return messageTimestamp > 1_000_000_000_000
      ? messageTimestamp
      : messageTimestamp * 1000;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}
