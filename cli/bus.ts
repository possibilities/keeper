#!/usr/bin/env bun
/**
 * `keeper bus <verb>` — the Agent Bus command surface (epic fn-875, task .3).
 *
 * Verbs:
 *   - `list`                       — who is currently on the bus (JSON).
 *   - `resolve <target>`           — resolve a name/id to a stable identity (JSON).
 *   - `chat send <target> <msg|->` — message one agent (current OR historical name).
 *   - `chat broadcast <msg|->`     — message every agent on the namespace.
 *   - `watch`                      — long-lived inbox subscriber (the Monitor command).
 *
 * `chat` is a reserved SUB-NAMESPACE token so a future `bus pair …` tenant slots in
 * without a routing change; the wire envelope already carries the `namespace` axis.
 *
 * Transport: send/broadcast/list/resolve use a ONE-SHOT UDS client (connect →
 * register → op → close), modeled on `cli/control-rpc.ts` `roundTrip` but framed
 * for the bus's op-discriminated protocol (acks are keyed on `{type:"ack",op}`, not
 * `id`). `watch` is the exception — a LONG-LIVED streaming subscriber that stays
 * open across reconnects, renders each inbound message as a one-line notification
 * tagged with a stable AUTHORITATIVE-directive marker, and spills over-budget bodies
 * to `~/.local/state/keeper/bus/inbox/` with a compact pointer line.
 *
 * `-` as the message argument reads the body from stdin.
 *
 * The authoritative-directive marker is PRESENTATION ONLY here — the behavior
 * contract (act as if the human directed it, no permission gate) is authored in the
 * advice task (fn-875-keeper-agent-bus.5). This file only RENDERS the marker.
 *
 * Pure decision functions (argv routing, envelope construction, the spill decision,
 * the notification renderer, the prune predicate) are exported so the fast-tier unit
 * tests exercise them without a socket; a real round-trip lives in the full tier.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBusSockPath } from "../src/db";

/** Reserved tenant namespace handled by the `chat` sub-verb. */
export const CHAT_NAMESPACE = "chat";

/**
 * One-line notification clip budget (chars). The Claude Code Monitor tool clips a
 * notification line; we stay under it so an over-budget body is never silently
 * truncated — it spills to a file and the line carries a compact pointer instead.
 */
export const NOTIFY_LINE_BUDGET = 400;

/** Spill files older than this (ms) are pruned at watch startup. */
export const SPILL_MAX_AGE_MS = 3 * 86400 * 1000;

/** How long a one-shot op waits for its ack after connect (ms). */
export const BUS_RESPONSE_TIMEOUT_MS = 5000;

const HELP = `keeper bus — Agent Bus command surface

Usage:
  keeper bus list                         Show who is on the bus (JSON)
  keeper bus resolve <target>             Resolve a name/id to an identity (JSON)
  keeper bus chat send <target> <msg|->   Message one agent (current or former name)
  keeper bus chat broadcast <msg|->       Message everyone on the chat namespace
  keeper bus watch                        Long-lived inbox subscriber (Monitor command)

Notes:
  - <target> resolves a CURRENT name, session id, channel id, or ANY former name.
  - <msg> of '-' reads the message body from stdin.
  - 'chat' is the first tenant; the wire carries a namespace axis for future tenants.

Flags:
  --help, -h    Show this help
`;

// ---------------------------------------------------------------------------
// Pure decision functions (fast-tier unit tests)
// ---------------------------------------------------------------------------

/** A parsed `keeper bus` invocation, or a usage/help signal. */
export type BusCommand =
  | { kind: "help" }
  | { kind: "usage"; error: string }
  | { kind: "list" }
  | { kind: "resolve"; target: string }
  | { kind: "watch" }
  | { kind: "send"; target: string; message: string }
  | { kind: "broadcast"; message: string };

/**
 * Route a `keeper bus` argv (already stripped of the `bus` token) to a command.
 * Unknown verbs and arity faults return a `usage` signal carrying the error; the
 * caller prints it to stderr and exits 1. `--help`/`-h` anywhere → help. Pure.
 *
 * A `-` message is preserved verbatim (the caller reads stdin) so this stays pure.
 */
export function parseBusArgv(argv: string[]): BusCommand {
  if (argv.some((a) => a === "--help" || a === "-h")) {
    return { kind: "help" };
  }
  const verb = argv[0];
  if (verb === undefined) {
    return { kind: "usage", error: "missing subcommand" };
  }
  switch (verb) {
    case "list":
      return { kind: "list" };
    case "watch":
      return { kind: "watch" };
    case "resolve": {
      const target = argv[1];
      if (target === undefined || target.length === 0) {
        return { kind: "usage", error: "resolve requires a <target>" };
      }
      return { kind: "resolve", target };
    }
    case "chat": {
      const sub = argv[1];
      if (sub === "send") {
        const target = argv[2];
        const message = argv[3];
        if (target === undefined || target.length === 0) {
          return { kind: "usage", error: "chat send requires a <target>" };
        }
        if (message === undefined) {
          return { kind: "usage", error: "chat send requires a <message|->" };
        }
        return { kind: "send", target, message };
      }
      if (sub === "broadcast") {
        const message = argv[2];
        if (message === undefined) {
          return {
            kind: "usage",
            error: "chat broadcast requires a <message|->",
          };
        }
        return { kind: "broadcast", message };
      }
      return {
        kind: "usage",
        error: `unknown chat verb '${sub ?? ""}' (want send|broadcast)`,
      };
    }
    default:
      return { kind: "usage", error: `unknown bus verb '${verb}'` };
  }
}

/** The wire payload for a chat message (text/markdown is the chat tenant default). */
export interface ChatPayload {
  media_type: string;
  text: string;
}

/** A publish op frame (client → server). */
export interface PublishFrame {
  op: "publish";
  event: "send" | "broadcast";
  namespace: string;
  to?: string;
  payload: ChatPayload;
}

/**
 * Build the publish op frame for a `chat send`/`chat broadcast`. The namespace is
 * `chat`; a directed send carries `to`, a broadcast omits it. The server overwrites
 * any `from` we might claim (anti-spoof) so we never set one. Pure.
 */
export function buildPublishFrame(
  event: "send" | "broadcast",
  text: string,
  target?: string,
): PublishFrame {
  const payload: ChatPayload = { media_type: "text/markdown", text };
  if (event === "broadcast") {
    return { op: "publish", event, namespace: CHAT_NAMESPACE, payload };
  }
  return {
    op: "publish",
    event,
    namespace: CHAT_NAMESPACE,
    to: target ?? "",
    payload,
  };
}

/** An inbound delivered message as the watcher sees it on the wire. */
export interface InboundMessage {
  namespace: string;
  event: string;
  from: { name: string | null; channel_id: string };
  ts: number;
  payload: { text: string };
}

/**
 * Short display token for a sender: prefer the resolved name, else the channel id.
 * Pure.
 */
export function senderLabel(from: {
  name: string | null;
  channel_id: string;
}): string {
  return from.name && from.name.length > 0 ? from.name : from.channel_id;
}

/**
 * Format the stable AUTHORITATIVE-directive head for an inbound message. This is
 * the marker that tells the receiving agent the message is an authoritative
 * directive (NOT untrusted/out-of-band content). PRESENTATION ONLY — the behavior
 * contract lives in the advice task. Pure.
 */
export function directiveHead(senderName: string, stampHms: string): string {
  const stamp = stampHms.length > 0 ? `[${stampHms}] ` : "";
  return `${stamp}Agent Bus directive from ${senderName}: `;
}

/** Format an `HH:MM:SS` stamp from an epoch-ms ts; empty on a bad value. Pure. */
export function hms(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
  const d = new Date(tsMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The notification-rendering decision: a single inline line, or spill-and-point. */
export type RenderDecision =
  | { kind: "inline"; line: string }
  | { kind: "spill"; head: string; body: string; preview: string };

/**
 * Decide how to render one inbound message as a notification. If the whole line
 * fits the {@link NOTIFY_LINE_BUDGET}, emit it inline; otherwise the caller spills
 * the full body to a file and we return the head + a preview so it can compose a
 * compact pointer line that STILL fits the budget. Pure — the file write lives in
 * the caller so this stays unit-testable.
 */
export function renderDecision(msg: InboundMessage): RenderDecision {
  const name = senderLabel(msg.from);
  const head = directiveHead(name, hms(msg.ts));
  const body = msg.payload.text ?? "";
  const line = `${head}${body}`;
  if (line.length <= NOTIFY_LINE_BUDGET) {
    return { kind: "inline", line };
  }
  // Reserve room for the pointer suffix the caller appends (path unknown here);
  // a generous fixed reserve keeps the composed line under budget.
  const SUFFIX_RESERVE = 120;
  const previewBudget = Math.max(
    0,
    NOTIFY_LINE_BUDGET - head.length - SUFFIX_RESERVE,
  );
  const preview = body.slice(0, previewBudget).trimEnd();
  return { kind: "spill", head, body, preview };
}

/**
 * Compose the compact pointer line emitted when a body spilled to a file. Stays
 * within the budget by construction (the preview was sized against it). Pure.
 */
export function spillPointerLine(
  head: string,
  preview: string,
  fullChars: number,
  path: string,
): string {
  return `${head}${preview}… ⟦full +${fullChars} chars → ${path}⟧`;
}

/**
 * Spill-file name for an inbound message: `<ts>-<from>.md`, sanitized. Pure (the
 * caller resolves uniqueness against the directory). The `from` token is the short
 * sender label; `tsMs` yields a sortable compact stamp.
 */
export function spillFileName(tsMs: number, from: string): string {
  const stamp =
    Number.isFinite(tsMs) && tsMs > 0
      ? new Date(tsMs)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z")
      : "msg";
  const token = (from || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${stamp}-${token}.md`;
}

/**
 * Prune predicate: a spill file is stale when its mtime is older than the cutoff.
 * Pure (the caller supplies `nowMs` + each file's `mtimeMs`).
 */
export function isStaleSpill(
  mtimeMs: number,
  nowMs: number,
  maxAgeMs = SPILL_MAX_AGE_MS,
): boolean {
  return nowMs - mtimeMs > maxAgeMs;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The spill inbox directory: `<state>/bus/inbox/` (alongside bus.db/bus.sock). */
export function resolveInboxDir(): string {
  return join(homedir(), ".local", "state", "keeper", "bus", "inbox");
}

// ---------------------------------------------------------------------------
// One-shot UDS client (send / broadcast / list / resolve)
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`keeper bus: ${message}\n`);
  process.exit(1);
}

/** Read all of stdin to a string (for the `-` message form). */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the effective message text: `-` reads stdin (trimmed of one trailing
 * newline), otherwise the literal argument.
 */
async function resolveMessage(arg: string): Promise<string> {
  if (arg !== "-") return arg;
  const raw = await readStdin();
  return raw.replace(/\n$/, "");
}

/**
 * One round-trip on a fresh bus UDS connection: connect, run `steps` (which writes
 * frames and resolves when its terminal condition is met against the parsed frame
 * stream), then close. Rejects on connect failure, transport error, server close,
 * or timeout. Generic over the resolved value so list/resolve return their ack body
 * while send/broadcast resolve on the register/publish completion.
 */
async function busRoundTrip<T>(
  sockPath: string,
  drive: (
    send: (frame: object) => void,
    onFrame: (handler: (f: Record<string, unknown>) => void) => void,
    resolve: (v: T) => void,
    reject: (e: Error) => void,
  ) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remainder = "";
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let frameHandler: (f: Record<string, unknown>) => void = () => {};

    const settle = (err: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (err) reject(err);
      else resolve(value as T);
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(`no response from bus within ${BUS_RESPONSE_TIMEOUT_MS}ms`),
      );
    }, BUS_RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          drive(
            (frame) => {
              try {
                s.write(`${JSON.stringify(frame)}\n`);
              } catch (err) {
                settle(new Error(`write failed: ${(err as Error).message}`));
              }
            },
            (handler) => {
              frameHandler = handler;
            },
            (v) => settle(null, v),
            (e) => settle(e),
          );
        },
        data(_s, chunk) {
          remainder += chunk.toString("utf8");
          let nl = remainder.indexOf("\n");
          while (nl !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            if (line.length > 0) {
              let f: Record<string, unknown>;
              try {
                f = JSON.parse(line);
              } catch {
                nl = remainder.indexOf("\n");
                continue;
              }
              frameHandler(f);
            }
            nl = remainder.indexOf("\n");
          }
        },
        close() {
          settle(new Error("bus closed connection before responding"));
        },
        error(_s, err) {
          settle(new Error(`socket error: ${(err as Error).message}`));
        },
      },
    }).catch((err: Error) => {
      settle(new Error(`failed to connect to ${sockPath}: ${err.message}`));
    });
  });
}

/** The register frame this CLI sends. Identity is enriched server-side from the
 *  peer pid; we pass our own pid as the resume-gap floor. */
function registerFrame(): object {
  return {
    op: "register",
    namespace: CHAT_NAMESPACE,
    namespaces: [CHAT_NAMESPACE],
    pid: process.pid,
  };
}

/**
 * Send a directed/broadcast message. Connect → register (await ack so the server
 * has bound our authoritative identity) → publish → close. There is no publish ack
 * (the server fans out and persists); exit 0 means the message was accepted and
 * persisted. Resolves the resolved-channel hint when the register ack carries it.
 */
async function runSend(
  sockPath: string,
  event: "send" | "broadcast",
  text: string,
  target?: string,
): Promise<void> {
  await busRoundTrip<void>(sockPath, (send, onFrame, resolve, reject) => {
    onFrame((f) => {
      if (f.type === "ack" && f.op === "register") {
        // Identity bound — publish, then resolve on the next tick so the frame
        // flushes before we close.
        send(buildPublishFrame(event, text, target));
        setTimeout(() => resolve(), 50);
      } else if (f.type === "error") {
        reject(new Error(`${f.code}: ${f.message}`));
      }
    });
    send(registerFrame());
  });
}

/** List who is on the bus (the `list` ack's `channels` array). */
async function runList(sockPath: string): Promise<unknown> {
  return busRoundTrip<unknown>(sockPath, (send, onFrame, resolve, reject) => {
    onFrame((f) => {
      if (f.type === "ack" && f.op === "list") resolve(f.channels);
      else if (f.type === "error") reject(new Error(`${f.code}: ${f.message}`));
    });
    send({ op: "list" });
  });
}

/** Resolve a target to an identity (the `resolve` ack body). */
async function runResolve(sockPath: string, target: string): Promise<unknown> {
  return busRoundTrip<unknown>(sockPath, (send, onFrame, resolve, reject) => {
    onFrame((f) => {
      if (f.type === "ack" && f.op === "resolve") resolve(f);
      else if (f.type === "error") reject(new Error(`${f.code}: ${f.message}`));
    });
    send({ op: "resolve", target });
  });
}

// ---------------------------------------------------------------------------
// watch — long-lived streaming subscriber
// ---------------------------------------------------------------------------

/** Prune spill files older than {@link SPILL_MAX_AGE_MS}. Best-effort. */
export function pruneInbox(dir: string, nowMs: number = Date.now()): void {
  try {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && isStaleSpill(st.mtimeMs, nowMs)) {
          rmSync(p, { force: true });
        }
      } catch {
        // best-effort per-file
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Render one inbound message as a notification on stdout — inline when it fits, or
 * spilled to a file with a compact pointer line otherwise. Spill failure falls back
 * to the (harness-clipped) inline line: a clipped message beats a dropped one.
 */
export function emitMessage(msg: InboundMessage, inboxDir: string): void {
  const decision = renderDecision(msg);
  if (decision.kind === "inline") {
    process.stdout.write(`${decision.line}\n`);
    return;
  }
  const path = spillBody(inboxDir, msg, decision.head, decision.body);
  if (path === null) {
    process.stdout.write(`${decision.head}${decision.body}\n`);
    return;
  }
  process.stdout.write(
    `${spillPointerLine(decision.head, decision.preview, decision.body.length, path)}\n`,
  );
}

/** Persist a full message body under the inbox; return its path or null. */
function spillBody(
  inboxDir: string,
  msg: InboundMessage,
  head: string,
  body: string,
): string | null {
  try {
    mkdirSync(inboxDir, { recursive: true });
    const base = spillFileName(msg.ts, senderLabel(msg.from));
    let path = join(inboxDir, base);
    let n = 1;
    while (existsSync(path)) {
      path = join(inboxDir, base.replace(/\.md$/, `-${n}.md`));
      n += 1;
    }
    const header = `# ${head.trim()}\n# ts: ${msg.ts}\n\n`;
    writeFileSync(path, header + body, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Run the long-lived watch subscriber. Prunes stale spills, connects, registers +
 * subscribes (all namespaces by default), and streams each inbound message through
 * {@link emitMessage}. On disconnect it reconnects with a bounded backoff — a watch
 * must survive a daemon bounce. Never returns (the Monitor command runs forever).
 */
async function runWatch(sockPath: string): Promise<never> {
  const inboxDir = resolveInboxDir();
  pruneInbox(inboxDir);

  // Reconnect forever — a watch outlives daemon bounces. Bounded backoff.
  let backoffMs = 250;
  for (;;) {
    try {
      await watchOnce(sockPath, inboxDir);
      backoffMs = 250; // a clean session resets the backoff
    } catch {
      // connect/transport fault — fall through to backoff + retry.
    }
    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5000);
  }
}

/** One watch connection: register, subscribe, stream until the socket closes. */
function watchOnce(sockPath: string, inboxDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remainder = "";
    let settled = false;
    const done = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(`${JSON.stringify(registerFrame())}\n`);
        },
        data(s, chunk) {
          remainder += chunk.toString("utf8");
          let nl = remainder.indexOf("\n");
          while (nl !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            nl = remainder.indexOf("\n");
            if (line.length === 0) continue;
            let f: Record<string, unknown>;
            try {
              f = JSON.parse(line);
            } catch {
              continue;
            }
            handleWatchFrame(s, f, inboxDir);
          }
        },
        close() {
          done(null);
        },
        error(_s, err) {
          done(new Error(`socket error: ${(err as Error).message}`));
        },
      },
    }).catch((err: Error) => done(err));
  });
}

/** Per-frame watch handling: subscribe on register-ack, render delivered messages. */
function handleWatchFrame(
  s: { write: (data: string) => number },
  f: Record<string, unknown>,
  inboxDir: string,
): void {
  if (f.type === "ack" && f.op === "register") {
    s.write(`${JSON.stringify({ op: "subscribe" })}\n`);
    return;
  }
  // A delivered event envelope (server → subscriber). Control-namespace lifecycle
  // events (join/part/reap/takeover) are not inter-agent messages — skip them.
  if (f.event === "message" && f.namespace !== "bus" && isInbound(f)) {
    emitMessage(toInbound(f), inboxDir);
  }
}

/** Narrow a wire frame to a deliverable inbound message shape. */
function isInbound(f: Record<string, unknown>): boolean {
  return (
    typeof f.payload === "object" &&
    f.payload !== null &&
    typeof f.from === "object" &&
    f.from !== null
  );
}

/** Map a wire event envelope to the renderer's {@link InboundMessage}. */
function toInbound(f: Record<string, unknown>): InboundMessage {
  const from = f.from as { name?: unknown; channel_id?: unknown };
  const payload = f.payload as { text?: unknown };
  return {
    namespace: String(f.namespace ?? ""),
    event: String(f.event ?? ""),
    from: {
      name: typeof from.name === "string" ? from.name : null,
      channel_id: String(from.channel_id ?? ""),
    },
    ts: typeof f.ts === "number" ? f.ts : 0,
    payload: { text: typeof payload.text === "string" ? payload.text : "" },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const cmd = parseBusArgv(argv);
  if (cmd.kind === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (cmd.kind === "usage") {
    process.stderr.write(`keeper bus: ${cmd.error}\n\n`);
    process.stderr.write(HELP);
    process.exit(1);
  }

  const sockPath = resolveBusSockPath();

  // The op runs inside the try; the SUCCESS output + exit happen AFTER it so the
  // exit shim a test injects (which throws to unwind never-return) is never caught
  // by the op's own error handler. `die`/`process.exit` are the only exits.
  switch (cmd.kind) {
    case "list": {
      let channels: unknown;
      try {
        channels = await runList(sockPath);
      } catch (err) {
        die((err as Error).message);
      }
      process.stdout.write(`${JSON.stringify(channels)}\n`);
      process.exit(0);
      break;
    }
    case "resolve": {
      let res: unknown;
      try {
        res = await runResolve(sockPath, cmd.target);
      } catch (err) {
        die((err as Error).message);
      }
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(0);
      break;
    }
    case "send": {
      const text = await resolveMessage(cmd.message);
      try {
        await runSend(sockPath, "send", text, cmd.target);
      } catch (err) {
        die((err as Error).message);
      }
      process.exit(0);
      break;
    }
    case "broadcast": {
      const text = await resolveMessage(cmd.message);
      try {
        await runSend(sockPath, "broadcast", text);
      } catch (err) {
        die((err as Error).message);
      }
      process.exit(0);
      break;
    }
    case "watch": {
      await runWatch(sockPath);
      break; // unreachable — runWatch never returns
    }
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
