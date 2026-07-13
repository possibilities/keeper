/**
 * Hermes M2 capture — the PURE parsers behind `keeper agent run hermes` / a
 * hermes panel leg. Hermes sessions live in a SQLite store (`~/.hermes/state.db`),
 * NOT per-session JSONL files, so keeper cannot watch a transcript file the way it
 * does for Claude/Pi. Instead the launcher's capture path polls
 * `hermes sessions export` (JSONL out, read-only) and feeds its text here.
 *
 * Every function is a PURE reducer over that export text — no fs, no subprocess,
 * no clock. The bounded polling loop and the `hermes sessions export` subprocess
 * are production seams in the callers (`pair-subcommands.ts` drives the loop,
 * `main.ts` binds the export), so these parsers are unit-tested on synthetic
 * fixtures with no live hermes.
 *
 * Attribution is refuse-to-guess: a Hermes session is
 * attributable to a leg only when it is rooted at the leg's cwd AND created at or
 * after the launch instant. Exactly one survivor IS the leg's session; more than
 * one is an unresolvable concurrent-session collision (ambiguous, never guessed);
 * none yet means keep polling.
 */

import type { LastMessage, TranscriptStop } from "./transcript-watch";

/** Slop (ms) absorbing clock skew between the launch instant and the session's
 *  recorded `started_at`. */
const START_SLOP_MS = 1_000;

/**
 * The production seam that runs `hermes sessions export` and returns its JSONL
 * text, or null when the export failed / produced nothing. Bound in `main.ts` to a
 * bounded subprocess; injected as a fixture in tests so the parsers stay
 * subprocess-free. A null return maps to "keep polling" (or a terminal
 * no_transcript once the deadline passes), never a throw.
 */
export type HermesExportFn = () => string | null;

/** One message row from a hermes session export. */
export interface HermesMessage {
  role: string | null;
  /** The assistant/user text (a string in the export); null for a non-string
   *  content (tool payloads are JSON strings and are ignored for capture). */
  content: string | null;
  /** The API finish reason. A TERMINAL turn is any non-null reason other than
   *  `tool_calls` (which marks a mid-turn tool hop); `stop`/`length` are terminal. */
  finishReason: string | null;
  timestampMs: number | null;
}

/** One session from a `hermes sessions export` JSONL line. */
export interface HermesSession {
  id: string;
  source: string | null;
  cwd: string | null;
  startedAtMs: number | null;
  messages: HermesMessage[];
}

/**
 * The terminal outcome of {@link attributeHermesSession}: the leg's session, or a
 * pending/ambiguous signal. `ambiguous` is TERMINAL (never guessed) — a confident
 * wrong session is worse than a retryable failure; `pending` means keep polling.
 */
export type HermesAttribution =
  | { kind: "found"; session: HermesSession }
  | { kind: "pending" }
  | { kind: "ambiguous" };

/** epoch SECONDS (hermes's format, e.g. 1783112086.48) → ms; a value already in
 *  ms (> 1e12) is passed through; a non-finite value is null. */
function toMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value > 1e12 ? value : value * 1000;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseMessage(value: unknown): HermesMessage {
  const obj =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    role: stringOrNull(obj.role),
    content: stringOrNull(obj.content),
    finishReason: stringOrNull(obj.finish_reason),
    timestampMs: toMs(obj.timestamp),
  };
}

/**
 * Parse `hermes sessions export` JSONL text into sessions. One JSON object per
 * line; a line that is blank, not valid JSON, or lacks a string `id` is skipped
 * (the export may interleave a stray status line, and a partial line can appear
 * mid-write). Never throws — a malformed export yields the sessions it could read.
 */
export function parseHermesExport(text: string): HermesSession[] {
  const sessions: HermesSession[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const id = stringOrNull(obj.id);
    if (id === null) {
      continue;
    }
    const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
    sessions.push({
      id,
      source: stringOrNull(obj.source),
      cwd: stringOrNull(obj.cwd),
      startedAtMs: toMs(obj.started_at),
      messages: rawMessages.map(parseMessage),
    });
  }
  return sessions;
}

/**
 * Positively attribute a hermes session to a leg by cwd + created-at, refusing to
 * guess on a collision. A session qualifies when it is rooted at the leg's `cwd`
 * AND its recorded `started_at` is at or after the launch instant (a session
 * predating launch belongs to a concurrent run even if it keeps churning). Exactly
 * one match is `found`; more than one is `ambiguous`; none is `pending`.
 */
export function attributeHermesSession(
  sessions: HermesSession[],
  cwd: string,
  startedAtMs: number,
): HermesAttribution {
  const floor = startedAtMs - START_SLOP_MS;
  const matches = sessions.filter(
    (s) => s.cwd === cwd && s.startedAtMs !== null && s.startedAtMs >= floor,
  );
  const [first] = matches;
  if (matches.length === 1 && first !== undefined) {
    return { kind: "found", session: first };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "pending" };
}

/** True when a finish reason marks a completed turn (any non-null reason other
 *  than the mid-turn `tool_calls` hop). */
function isTerminalFinish(reason: string | null): boolean {
  return reason !== null && reason !== "tool_calls";
}

/**
 * The session's terminal stop, or null when no completed assistant turn has been
 * recorded yet. A stop is the LATEST assistant message carrying a terminal finish
 * reason — mid-turn tool hops (`finish_reason: "tool_calls"`) never qualify, so a
 * still-working turn keeps the caller polling. The stop's `message` is that turn's
 * text (null when the final turn carried none).
 */
export function hermesSessionStop(
  session: HermesSession,
  _startedAtMs: number,
): TranscriptStop | null {
  let stop: TranscriptStop | null = null;
  for (const msg of session.messages) {
    if (msg.role === "assistant" && isTerminalFinish(msg.finishReason)) {
      stop = {
        agent: "hermes",
        eventType: "assistant",
        reason: msg.finishReason ?? "stop",
        timestamp: null,
        message:
          msg.content !== null && msg.content !== "" ? msg.content : null,
      };
    }
  }
  return stop;
}

/**
 * The session's final assistant message. Prefers the latest terminal-finish
 * assistant turn's text; falls back to the latest assistant turn with readable
 * text (mirrors `findLastMessage`). `found:false` means no assistant turn was
 * observed at all; `text:null, found:true` is a defined empty final turn.
 */
export function hermesLastMessage(session: HermesSession): LastMessage {
  let latestStopText: string | null = null;
  let sawStop = false;
  let latestAssistantText: string | null = null;
  let sawAssistant = false;

  for (const msg of session.messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const text =
      msg.content !== null && msg.content !== "" ? msg.content : null;
    if (isTerminalFinish(msg.finishReason)) {
      sawStop = true;
      latestStopText = text;
    }
    if (text !== null) {
      sawAssistant = true;
      latestAssistantText = text;
    }
  }

  if (sawStop) {
    return {
      agent: "hermes",
      text: latestStopText ?? latestAssistantText,
      found: true,
    };
  }
  if (sawAssistant) {
    return { agent: "hermes", text: latestAssistantText, found: true };
  }
  return { agent: "hermes", text: null, found: false };
}
