import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { codexSessionIdFromRolloutPath } from "./codex-session-index";
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
  /**
   * Resume marker: when true, transcript DISCOVERY resolves a PRE-EXISTING
   * session file rather than a fresh one. codex resolves its rollout strictly by
   * the known resume-target uuid (carried on {@link sessionId}), bypassing the
   * fresh-launch created-at floor that would reject a rollout whose session-start
   * predates this launch — codex appends to the SAME rollout on resume. claude/pi
   * are already strict-pinned by their session id, so their discovery is
   * unchanged. The stop-scan anchors at {@link startedAtMs} for every harness
   * regardless, so a pre-resume terminal stop already in the file is never
   * captured as the answer. Omitted/false = fresh launch, byte-unchanged.
   */
  isResume?: boolean;
}

/** A `waitForTranscriptStop` result that timed out before any stop appeared. */
export type WaitForStopOutcome =
  | { ok: true; stop: TranscriptStop }
  | { ok: false; timedOut: true };

/**
 * A single-tick transcript-path lookup.
 *  - `found`: exactly one positively-attributed transcript.
 *  - `pending`: nothing attributable yet — the caller keeps polling.
 *  - `ambiguous`: more than one candidate the leg cannot attribute to itself
 *    (a concurrent same-cwd codex session collided). TERMINAL — never guessed,
 *    since a confident wrong transcript is worse than a retryable failure.
 */
type TranscriptPathLookup =
  | { kind: "found"; path: string }
  | { kind: "pending" }
  | { kind: "ambiguous" };

/** The terminal outcome of {@link waitForTranscriptPath}: a resolved path, or a
 *  failure discriminated so the caller maps a concurrent-session collision to a
 *  DISTINCT non-completed outcome rather than the plain path-timeout. */
export type WaitForPathOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: "timeout" | "ambiguous" };

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
): Promise<WaitForPathOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.pathTimeoutMs ?? DEFAULT_PATH_TIMEOUT_MS);

  while (true) {
    const lookup = findTranscriptPath(opts);
    if (lookup.kind === "found") {
      return { ok: true, path: lookup.path };
    }
    // A concurrent-session collision won't resolve by waiting (both files keep
    // being written), so fail loud immediately rather than burning the deadline.
    if (lookup.kind === "ambiguous") {
      return { ok: false, reason: "ambiguous" };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: "timeout" };
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

function findTranscriptPath(
  opts: TranscriptWatchOptions,
): TranscriptPathLookup {
  if (opts.agent === "codex") {
    return findCodexTranscriptPath(opts);
  }
  // claude/pi pin their session id at launch, so their resolution is exact-or-
  // absent — never ambiguous. Map the string|null shape onto the lookup union.
  const path =
    opts.agent === "claude"
      ? findClaudeTranscriptPath(opts)
      : findPiTranscriptPath(opts);
  return path === null ? { kind: "pending" } : { kind: "found", path };
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

function findCodexTranscriptPath(
  opts: TranscriptWatchOptions,
): TranscriptPathLookup {
  const codexHome =
    (opts.env.CODEX_HOME ?? "").trim() || join(opts.homeDir, ".codex");
  const files = jsonlFiles(join(codexHome, "sessions"), true).filter((path) => {
    const name = basename(path);
    return name.startsWith("rollout-") && name.endsWith(".jsonl");
  });
  // RESUME: `codex resume <uuid>` appends to the SAME rollout, so the file
  // already exists and its session-start predates this launch — the fresh-launch
  // created-at floor below would wrongly reject it. Resolve strictly by the known
  // resume-target uuid (carried on `sessionId`, the same uuid the rollout is
  // named after) instead: the rollout whose filename uuid matches IS the resumed
  // session, no freshness/cwd guessing. A uuid is unique so at most one matches;
  // none yet keeps polling for the file to appear.
  if (opts.isResume && opts.sessionId !== null) {
    const match = files.find(
      (path) => codexSessionIdFromRolloutPath(path) === opts.sessionId,
    );
    return match === undefined
      ? { kind: "pending" }
      : { kind: "found", path: match };
  }
  // Positive attribution, NEVER a newest-by-mtime guess. A codex leg cannot pin
  // its session id at launch, so a rollout is attributable to the leg only when
  // it is (a) still being written since launch (fresh mtime), (b) CREATED at or
  // after the launch instant — a rollout whose session_meta timestamp predates
  // launch belongs to a concurrent session even while its mtime keeps advancing,
  // the exact wrong-file trap the newest-by-mtime heuristic fell into — and (c)
  // rooted at the leg's cwd. Exactly one survivor IS the leg's transcript; more
  // than one is an unresolvable concurrent-session collision (ambiguous, never
  // guessed); none yet means keep polling for the leg's own file to appear.
  const floor = opts.startedAtMs - START_SLOP_MS;
  const cwdMatches = files.filter((path) => {
    const stat = safeStat(path);
    if (stat === null || stat.mtimeMs < floor) {
      return false;
    }
    const meta = readCodexRolloutMeta(path);
    if (meta.createdAtMs === null || meta.createdAtMs < floor) {
      return false;
    }
    return meta.cwd === opts.cwd;
  });
  const [first] = cwdMatches;
  if (cwdMatches.length === 1 && first !== undefined) {
    return { kind: "found", path: first };
  }
  if (cwdMatches.length > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "pending" };
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
  // claude gates terminality on background-agent quiescence (a settled stop);
  // codex/pi keep the plain first-stop scan, byte-identical.
  if (agent === "claude") {
    return findClaudeStopGated(path, startedAtMs);
  }
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

/**
 * The claude stop scan, gated on background-agent quiescence. A claude session
 * can end a turn while background agents it launched (Agent tool /
 * `run_in_background`) are still working; the harness later injects their
 * results and the session runs the turns that carry the real answer. A
 * first-stop-wins scan captures the premature turn, so claude terminality is
 * gated on a SETTLED stop: a stop marker is accepted only when no launched
 * background agent is still outstanding at that point AND no governing
 * turn_duration line reports a nonzero pendingBackgroundAgentCount.
 *
 * Line order is authoritative — transcript timestamps are non-monotonic. The
 * pending set is tracked across the WHOLE file with no started-at filter (a
 * launch predating the wait but still outstanding must block quiescence), while
 * stop ACCEPTANCE keeps the started-at window. Everything fails open: a
 * transcript carrying none of the markers behaves byte-identically to the plain
 * first-stop parser, malformed lines are skipped, and the stop-timeout ceiling
 * still bounds the wait. A retired child resumed via SendMessage re-arms work
 * the pending set no longer sees — the final-message directive carries that.
 */
function findClaudeStopGated(
  path: string,
  startedAtMs: number,
): TranscriptStop | null {
  const pending = new Set<string>();
  // A stop held pending its governing turn_duration's count. turn_duration
  // trails the assistant end_turn by a beat in file order, so an accepted
  // assistant stop is provisional until its turn_duration confirms it (count
  // absent/zero) or rejects it (count nonzero); a dangling provisional with no
  // trailing turn_duration is accepted at end-of-scan, since the count rule
  // only binds when a governing line exists.
  let provisional: TranscriptStop | null = null;

  for (const line of readLines(path)) {
    // Hot-path pre-filter: skip JSON.parse for a line carrying no marker
    // substring — it can be neither a launch/retire nor any stop shape.
    if (!hasClaudeMarker(line)) {
      continue;
    }
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }

    // Pending-set maintenance runs over the WHOLE file (no started-at filter).
    const launchId = claudeAsyncLaunchedAgentId(parsed);
    if (launchId !== null) {
      pending.add(launchId);
    }
    for (const retiredId of claudeRetiredAgentIds(parsed)) {
      pending.delete(retiredId);
    }

    if (isClaudeTurnDuration(parsed)) {
      const count = claudeTurnDurationCount(parsed);
      // Nonzero count: the turn ended with live background children, so its
      // stop is premature — reject the provisional and keep scanning.
      if (count !== null && count > 0) {
        provisional = null;
        continue;
      }
      // Count absent or zero: the turn is settled. Confirm the turn's
      // text-bearing assistant stop, else the turn_duration is itself a
      // structural stop.
      if (provisional !== null && pending.size === 0) {
        return provisional;
      }
      provisional = null;
      if (pending.size === 0 && withinStartWindow(parsed, startedAtMs)) {
        return claudeStopFromObject(parsed);
      }
      continue;
    }

    // A non-turn_duration line: an assistant / stop_hook_summary stop candidate.
    // Hold the FIRST settled candidate as provisional (freeze-on-first); a
    // trailing turn_duration may still reject it on a nonzero count.
    if (
      provisional === null &&
      pending.size === 0 &&
      withinStartWindow(parsed, startedAtMs)
    ) {
      const stop = claudeStopFromObject(parsed);
      if (stop !== null) {
        provisional = stop;
      }
    }
  }

  return provisional;
}

/**
 * The marker substrings a claude stop-scan line must contain to matter — a
 * background launch, a retire, or any of the three stop shapes. A line with
 * none affects neither the pending set nor stop detection, so it is skipped
 * before the JSON parse (a false positive just gets parsed and rejected).
 */
const CLAUDE_STOP_SCAN_MARKERS: readonly string[] = [
  "async_launched",
  "task-id",
  "stop_reason",
  "turn_duration",
  "stop_hook_summary",
];

function hasClaudeMarker(line: string): boolean {
  for (const marker of CLAUDE_STOP_SCAN_MARKERS) {
    if (line.includes(marker)) {
      return true;
    }
  }
  return false;
}

function withinStartWindow(
  obj: Record<string, unknown>,
  startedAtMs: number,
): boolean {
  const eventMs = objectTimestampMs(obj);
  return eventMs === null || eventMs >= startedAtMs - START_SLOP_MS;
}

function isClaudeTurnDuration(obj: Record<string, unknown>): boolean {
  return (
    stringValue(obj.type) === "system" &&
    stringValue(obj.subtype) === "turn_duration"
  );
}

/**
 * The `pendingBackgroundAgentCount` a turn_duration line carries, or null when
 * the field is absent/non-numeric. Null imposes NO count constraint (fail-open);
 * only a strictly positive value blocks stop acceptance.
 */
function claudeTurnDurationCount(obj: Record<string, unknown>): number | null {
  const count = obj.pendingBackgroundAgentCount;
  return typeof count === "number" ? count : null;
}

/**
 * The `agentId` a claude background-agent LAUNCH line arms, or null. A launch is
 * a user tool_result whose top-level `toolUseResult` is an OBJECT with
 * `status:"async_launched"`. A FAILED launch carries a STRING `toolUseResult`
 * (with an is_error tool_result) — the object check excludes it, so it never
 * enters the pending set.
 */
function claudeAsyncLaunchedAgentId(
  obj: Record<string, unknown>,
): string | null {
  const result = objectValue(obj.toolUseResult);
  if (result === null || stringValue(result.status) !== "async_launched") {
    return null;
  }
  return stringValue(result.agentId);
}

const CLAUDE_TERMINAL_STATUS = /<status>(?:completed|failed|killed)<\/status>/;
const CLAUDE_TASK_ID = /<task-id>([^<]+)<\/task-id>/g;

/**
 * The background-agent ids a claude line RETIRES. Two carriers, both string
 * bodies embedding a `<task-id>…</task-id>` alongside a terminal `<status>`:
 * queue-operation lines (top-level `content`, any operation) and injected
 * task-notification user lines (`message.content`). A normal assistant/user
 * turn carries an ARRAY `content`, which yields no string body — so only a
 * genuine notification retires. Retiring a non-member is a caller-side no-op,
 * keeping descendant-agent and backgrounded-Bash notifications from gating.
 */
function claudeRetiredAgentIds(obj: Record<string, unknown>): string[] {
  const ids: string[] = [];
  collectRetiredIds(stringValue(obj.content), ids);
  collectRetiredIds(stringValue(objectValue(obj.message)?.content), ids);
  return ids;
}

function collectRetiredIds(body: string | null, into: string[]): void {
  if (body === null || !CLAUDE_TERMINAL_STATUS.test(body)) {
    return;
  }
  for (const match of body.matchAll(CLAUDE_TASK_ID)) {
    const id = match[1];
    if (id !== undefined) {
      into.push(id);
    }
  }
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

/**
 * The codex rollout `event_msg` payload types that mark a turn's END. The single
 * source of truth for a codex stop marker, shared by `show-last-message`'s stop
 * parser here and the daemon-side live-state producer (`codex-state-worker`).
 * codex's rollout stream carries no turn-START marker, so codex live churn is
 * stop-only — a fact recorded in its harness descriptor's `hookMechanism`.
 */
export const CODEX_STOP_MARKERS: ReadonlySet<string> = new Set([
  "task_complete",
  "turn_aborted",
  "error",
]);

function codexStopFromObject(
  obj: Record<string, unknown>,
): TranscriptStop | null {
  if (obj.type !== "event_msg") {
    return null;
  }
  const payload = objectValue(obj.payload);
  const eventType = stringValue(payload?.type);
  if (eventType !== null && CODEX_STOP_MARKERS.has(eventType)) {
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

/**
 * Read a codex rollout's `session_meta` line for the two attribution signals the
 * codex path lookup needs: the recorded `cwd` and the creation instant
 * (`createdAtMs`, from the meta `timestamp`). The timestamp is codex's own ISO
 * string with a timezone — authoritative and unambiguous, unlike the tz-naive
 * timestamp embedded in the filename. Either field is null when the meta line is
 * absent/unparseable, which the caller treats as "cannot attribute".
 */
function readCodexRolloutMeta(path: string): {
  cwd: string | null;
  createdAtMs: number | null;
} {
  for (const line of readLines(path, 64 * 1024)) {
    if (!line.includes('"type":"session_meta"')) {
      continue;
    }
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      return { cwd: null, createdAtMs: null };
    }
    const payload = objectValue(parsed.payload);
    return {
      cwd: stringValue(payload?.cwd),
      createdAtMs: objectTimestampMs(parsed),
    };
  }
  return { cwd: null, createdAtMs: null };
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
