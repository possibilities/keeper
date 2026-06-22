/**
 * Agent Bus worker (epic fn-875, the keystone task .2). keeperd's sixteenth Bun
 * Worker thread — a UDS pub/sub relay over the T1 storage (`src/bus-db.ts`) +
 * two-layer resolution (`src/bus-identity.ts`) layers. It is the load-bearing
 * proof that the bus rides INSIDE keeperd without touching keeper.db's blast
 * radius: it opens keeper.db READ-ONLY (jobs identity reads only) and owns its
 * OWN writable `bus.db` + a dedicated `bus.sock`. It adds NO keeper event type,
 * projection, RPC surface, or schema-version bump.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import (the fast-tier pure-fn tests) is inert.
 *  - TWO own connections: bus.db writable (sole writer, T1's `openBusDb`) and
 *    keeper.db read-only (`openDb(..,{readonly,prepareStmts:false,bootRetry})` —
 *    a reader open does NOT migrate).
 *  - Typed messages: `{type:"shutdown"}` main→worker ONLY; NO worker→main message
 *    (a pure relay actuator, like the renamer). Exit 0 clean / 1 boot-crash.
 *  - Subsystem-style teardown: the shutdown handler releases socket + lock + both
 *    DB connections within the deadline before `process.exit(0)`.
 *  - `fatalExit` (exit 1) is reserved for BOOT failures (bind / lock-held /
 *    db-open). Runtime handling NEVER throws to the top: a malformed/oversized
 *    frame is dropped + logged, a broken peer is evicted — never a daemon bounce.
 *
 * Wire (2-axis NDJSON, epic Architecture). The core routes ONLY on
 * `(namespace, resolved-target)`; the payload is opaque, so a future `pair`
 * tenant needs no core change. Op-discriminated socket frames: client →
 * register / heartbeat / subscribe / publish(send|broadcast) / list / resolve /
 * deregister; server → ack / event / presence / error. A `subscribe` ack carries
 * the `last_message_id` replay cursor.
 *
 * Anti-spoof: the server resolves the connecting peer's pid via `peerPidForFd`
 * (authoritative LOCAL_PEERPID), walks its ancestry to the nearest pid keeper
 * tracks (the Claude harness — the peer is the `keeper bus watch` subprocess two
 * hops below it), enriches THAT pid from keeper.db `jobs`, and OVERWRITES the
 * sender-claimed `from` with the harness-resolved identity. Because the walk
 * roots at the server-resolved peer pid, a client cannot forge an identity it is
 * not descended from.
 */

import type { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  appendMessage,
  type ChannelRow,
  deleteChannel,
  loadChannels,
  maxMessageId,
  openBusDb,
  upsertChannel,
} from "./bus-db";
import {
  type BusResolveResult,
  type LiveChannel,
  resolveTarget,
} from "./bus-identity";
import { openDb, resolveBusDbPath, resolveBusSockPath } from "./db";
import { LineBuffer } from "./protocol";
import {
  acquireLock,
  isPidAlive,
  LockHeldError,
  peerPidForFd,
  type Writable,
} from "./server-worker";

/** Reserved control namespace (lifecycle: join / part / reap / takeover). */
export const CONTROL_NAMESPACE = "bus";

/** Default tenant when a client omits `namespace` on register/publish. */
export const DEFAULT_NAMESPACE = "chat";

/** Per-client outbound queue cap (frames). A slow/dead subscriber that backs up
 *  past this is EVICTED rather than allowed to block the relay (head-of-line). */
export const MAX_CLIENT_QUEUE = 256;

/** Max inbound frame length (chars) — a longer line is a protocol error; the
 *  connection is destroyed. Mirrors the server worker's `MAX_LINE_LENGTH` order. */
export const MAX_FRAME_LENGTH = 1024 * 1024;

/** Heartbeat liveness thresholds on the MONOTONIC clock (ms since last beat). */
export const HEARTBEAT_WARN_MS = 60_000;
export const HEARTBEAT_EVICT_MS = 90_000;

/** Reap loop cadence (ms). */
export const REAP_INTERVAL_MS = 30_000;

/** Worker-shutdown grace (ms) before the worker force-exits. */
const SHUTDOWN_DEADLINE_MS = 2_000;

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only paths cross
 * the boundary — the connections (handles are thread-affine) are opened on the
 * worker thread. `sockPath`/`busDbPath` default to their resolvers worker-side.
 */
export interface BusWorkerData {
  /** keeper.db path (read-only jobs reads). */
  dbPath: string;
  /** bus.db path; defaults to {@link resolveBusDbPath} worker-side. */
  busDbPath?: string;
  /** bus.sock path; defaults to {@link resolveBusSockPath} worker-side. */
  sockPath?: string;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

// ---------------------------------------------------------------------------
// Wire envelope (2-axis) — the on-the-wire shapes
// ---------------------------------------------------------------------------

/** The resolved/claimed sender identity carried on an event envelope. */
export interface FromIdentity {
  channel_id: string;
  pid: number;
  session_id: string | null;
  name: string | null;
}

/** The addressed target on a publish/event envelope. */
export interface ToIdentity {
  target: string;
  channel_id: string | null;
  session_id: string | null;
}

/** The opaque payload — the core never inspects it (tenant-owned). */
export interface Payload {
  media_type: string;
  text: string;
}

/**
 * One delivered event line (server → subscriber). The 2-axis envelope: the core
 * routes on `(namespace, to)`; `payload` is opaque.
 */
export interface EventEnvelope {
  v: 1;
  namespace: string;
  event: string;
  id: number;
  ts: number;
  from: FromIdentity;
  to: ToIdentity;
  payload: Payload;
  reply_to: number | null;
}

// ---------------------------------------------------------------------------
// Inbound op frames (client → server) — op-discriminated
// ---------------------------------------------------------------------------

export type ClientOp =
  | {
      op: "register";
      namespace?: string;
      namespaces?: string[];
      name?: string;
      session_id?: string;
      pid?: number;
      start_time?: string;
    }
  | { op: "heartbeat" }
  | { op: "subscribe"; namespaces?: string[]; after_id?: number }
  | {
      op: "publish";
      event?: "send" | "broadcast";
      namespace?: string;
      to?: string;
      payload?: Payload;
      reply_to?: number | null;
    }
  | { op: "list" }
  | { op: "resolve"; target: string }
  | { op: "deregister" };

// ---------------------------------------------------------------------------
// Pure decision functions — exercised by the fast-tier tests (no Worker spawn)
// ---------------------------------------------------------------------------

/**
 * ANTI-SPOOF: build the authoritative `from` identity from the PEER-RESOLVED
 * pid + keeper-resolved fields, IGNORING any `from` the client tried to claim. A
 * client cannot forge another agent's identity — the server stamps it from the
 * connection's own peer pid. `channelId` is the server-minted channel id; the
 * keeper enrichment (session_id, current name) flows in via `resolved`. Pure.
 */
export function authoritativeFrom(
  channelId: string,
  peerPid: number,
  resolved: { session_id: string | null; name: string | null },
): FromIdentity {
  return {
    channel_id: channelId,
    pid: peerPid,
    session_id: resolved.session_id,
    name: resolved.name,
  };
}

/**
 * Fan-out target selection: the live channels that should receive a message in
 * `namespace` addressed to `resolvedChannelId`. A `broadcast` (null target) goes
 * to every channel SUBSCRIBED to the namespace except the sender; a directed
 * send goes to the single resolved channel (when it is subscribed). The sender
 * is never echoed its own message. Pure over the registry snapshot.
 *
 * @param registry          all live channels (the routing universe).
 * @param namespace         the tenant axis.
 * @param resolvedChannelId the directed target's channel id, or `null` for broadcast.
 * @param senderChannelId   the publisher's channel id (excluded from delivery).
 */
export function selectFanoutTargets(
  registry: RegistryEntry[],
  namespace: string,
  resolvedChannelId: string | null,
  senderChannelId: string | null,
): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const e of registry) {
    if (e.channel.channel_id === senderChannelId) continue;
    if (!e.namespaces.includes(namespace)) continue;
    if (
      resolvedChannelId !== null &&
      e.channel.channel_id !== resolvedChannelId
    ) {
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Backpressure decision per subscriber: given the bytes the socket ACCEPTED of a
 * `wanted`-byte frame and the subscriber's current queued-frame count, decide
 * whether to evict. We evict ONLY when the bounded per-client queue would
 * overflow (`queued >= MAX_CLIENT_QUEUE`) — a transient short write is queued,
 * not fatal. The relay never AWAITS a drain (that is head-of-line blocking); it
 * queues or evicts and moves to the next subscriber. Pure.
 */
export function backpressureDecision(
  accepted: number,
  wanted: number,
  queuedFrames: number,
): "ok" | "queue" | "evict" {
  if (accepted >= wanted) return "ok";
  if (queuedFrames >= MAX_CLIENT_QUEUE) return "evict";
  return "queue";
}

/**
 * Reap predicate on the MONOTONIC clock (never `Date.now()` — a wall-clock jump
 * must not spuriously reap a live agent). Two thresholds: `warn` past
 * {@link HEARTBEAT_WARN_MS}, `evict` past {@link HEARTBEAT_EVICT_MS}, measured
 * from the channel's last heartbeat. `nowMono`/`lastBeatMono` are both
 * `performance.now()`-domain values. Pure.
 */
export function reapDecision(
  nowMono: number,
  lastBeatMono: number,
): "live" | "warn" | "evict" {
  const age = nowMono - lastBeatMono;
  if (age >= HEARTBEAT_EVICT_MS) return "evict";
  if (age >= HEARTBEAT_WARN_MS) return "warn";
  return "live";
}

/**
 * Duplicate-watcher / takeover decision keyed on the STABLE `(pid, start_time)`
 * identity. A new register for an identity that already has a live channel is a
 * TAKEOVER: the old channel is superseded (its watcher reconnected, or a stale
 * one lingers). Returns the channel_id to evict (the prior holder), or null when
 * this is a fresh identity. Keyed on `(pid, start_time)` so OS pid-reuse never
 * collapses two distinct agents. Pure.
 */
export function takeoverVictim(
  registry: RegistryEntry[],
  pid: number,
  startTime: string,
  newChannelId: string,
): string | null {
  for (const e of registry) {
    if (
      e.channel.pid === pid &&
      e.channel.start_time === startTime &&
      e.channel.channel_id !== newChannelId
    ) {
      return e.channel.channel_id;
    }
  }
  return null;
}

/**
 * Drop dead-pid channels from a rehydrated channel set — the boot registry-cache
 * pass. A persisted channel whose `(pid)` is no longer alive is stale (the agent
 * exited while the bus was down) and is dropped. Pure relative to the injected
 * `isAlive` probe so it unit-tests deterministically.
 */
export function liveChannelsAtBoot(
  rows: ChannelRow[],
  isAlive: (pid: number) => boolean,
): ChannelRow[] {
  return rows.filter((r) => isAlive(r.pid));
}

// ---------------------------------------------------------------------------
// Runtime registry — the in-memory source of truth (bus.db is a cache)
// ---------------------------------------------------------------------------

/**
 * One live registry entry: the channel identity, the namespaces it subscribes
 * to, the bound socket (null until `subscribe`), the bounded outbound queue, and
 * the MONOTONIC last-heartbeat stamp the reaper reads.
 */
export interface RegistryEntry {
  channel: ChannelRow;
  namespaces: string[];
  /** The subscribed socket; null until a `subscribe` op binds it. */
  sock: Writable | null;
  /**
   * Bounded outbound queue of pre-serialized, UTF-8-encoded NDJSON frames. Held
   * as bytes (never decoded strings) so a partial-write tail re-flushes
   * byte-identical — a short write splitting a multi-byte sequence must not be
   * round-tripped through a TextDecoder (it would mint U+FFFD).
   */
  queue: Uint8Array[];
  /** `performance.now()` of the last heartbeat (monotonic). */
  lastBeatMono: number;
  /** Whether a warn was already logged this miss-window (de-dupes warn spam). */
  warned: boolean;
}

/** Map a {@link RegistryEntry}'s channel to the resolver's {@link LiveChannel}. */
export function toLiveChannel(e: RegistryEntry): LiveChannel {
  return {
    channel_id: e.channel.channel_id,
    pid: e.channel.pid,
    start_time: e.channel.start_time,
    session_id: e.channel.session_id,
    current_name: e.channel.current_name,
    name_history: e.channel.name_history,
  };
}

// ---------------------------------------------------------------------------
// keeper.db jobs enrichment (Layer-2 identity, read-only)
// ---------------------------------------------------------------------------

/** A keeper `jobs` identity row (the read-only enrichment source). */
export interface JobIdentity {
  job_id: string;
  pid: number | null;
  start_time: string | null;
  title: string | null;
  name_history: string[];
}

/**
 * Enrich a connecting peer's pid from keeper.db `jobs` (read-only): the newest
 * job for that pid yields session_id (`job_id`), current title (name), and
 * name_history. A keeper MISS (a just-started session keeper has not folded yet)
 * returns null and the caller falls back to the client-provided floor name.
 * Bound params only.
 */
export function enrichPeerFromJobs(
  keeperDb: Database,
  pid: number,
): JobIdentity | null {
  const row = keeperDb
    .prepare(
      `SELECT job_id, pid, start_time, title, name_history
         FROM jobs WHERE pid = ?
        ORDER BY COALESCE(updated_at, created_at) DESC, job_id ASC
        LIMIT 1`,
    )
    .get(pid) as Record<string, unknown> | null;
  if (!row) return null;
  let history: string[] = [];
  const cell = row.name_history;
  if (typeof cell === "string" && cell.length > 0) {
    try {
      const parsed = JSON.parse(cell);
      if (Array.isArray(parsed)) history = parsed.map((v) => String(v));
    } catch {
      history = [];
    }
  }
  return {
    job_id: String(row.job_id),
    pid: row.pid == null ? null : Number(row.pid),
    start_time: row.start_time == null ? null : String(row.start_time),
    title: row.title == null ? null : String(row.title),
    name_history: history,
  };
}

// ---------------------------------------------------------------------------
// Harness identity resolution (server-side ancestry walk, anti-spoof-preserving)
// ---------------------------------------------------------------------------

/** Ancestry-walk depth bound (matches chatctl's `identity.py` walk). */
export const HARNESS_WALK_MAX_DEPTH = 40;

/** Resolved harness identity: the ancestor pid keeper tracks + its job row. */
export interface HarnessIdentity {
  /** The ancestor pid that has a keeper `jobs` row — the Claude harness. */
  pid: number;
  /** That ancestor's keeper-resolved identity. */
  identity: JobIdentity;
}

/**
 * Walk a connecting peer's pid up its ancestry and return the NEAREST ancestor
 * (the peer pid itself counts) that has a keeper.db `jobs` row — keeper only
 * tracks Claude HARNESS pids, so the nearest ancestor keeper knows IS the
 * harness. The `keeper bus watch` client is two hops below its harness (harness
 * → zsh → watch), so enriching the bare peer pid always missed; this lifts the
 * identity to the real session.
 *
 * ANTI-SPOOF: the walk roots at the SERVER-resolved peer pid (never a
 * client-supplied pid), so a client can only resolve to an ancestor it is
 * actually descended from — it cannot claim a harness pid it does not belong to.
 *
 * Pure relative to the injected `getPpid` (parent-pid probe) and `lookupJobs`
 * (keeper.db enrichment) so it unit-tests deterministically. Returns null on the
 * resume-gap case (no ancestor within the depth bound has a jobs row) — the
 * caller falls back to the client-provided floor identity exactly as before.
 */
export function resolveHarnessIdentity(
  peerPid: number,
  getPpid: (pid: number) => number | null,
  lookupJobs: (pid: number) => JobIdentity | null,
  maxDepth = HARNESS_WALK_MAX_DEPTH,
): HarnessIdentity | null {
  let pid = peerPid;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (pid <= 1) break; // pid 0 (kernel) / 1 (init) are never a harness
    const identity = lookupJobs(pid);
    if (identity !== null) return { pid, identity };
    const parent = getPpid(pid);
    if (parent === null || parent === pid) break;
    pid = parent;
  }
  return null;
}

/**
 * Parent pid of `pid` via `ps -o ppid=` (macOS has no /proc). Synchronous and
 * bounded — registrations are infrequent, so a per-register `ps` per ancestry
 * hop is fine. Returns null on any failure (unknown pid, ps unavailable, parse
 * miss) so the ancestry walk terminates gracefully. A process-state read in the
 * worker, like `isPidAlive` — the producer-side process-state precedent.
 */
export function ppidViaPs(pid: number): number | null {
  if (pid <= 0) return null;
  try {
    const res = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!res.success) return null;
    const raw = res.stdout.toString().trim();
    if (raw.length === 0) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker runtime (lifecycle) — only inside a real Worker
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Per-connection state. `entry` is the bound registry entry once the conn
 * registers; `buffer` frames NDJSON; `peerPid` is the authoritative anti-spoof
 * pid captured at accept; `id` is a debug sequence id.
 */
interface BusConnState {
  buffer: LineBuffer;
  entry: RegistryEntry | null;
  peerPid: number | null;
  id: number;
}

/** The bus relay runtime: registry + both DB handles + the bound listener. */
interface BusServer {
  stop(): void;
}

let __nextConnId = 0;

/**
 * Boot + serve the bus relay. Acquires the lock (stale-reclaim), binds the UDS
 * socket, chmods it 0600, and wires the op handlers. The registry is the runtime
 * source of truth; `bus.db` is the durable cache + forensic message log.
 *
 * A bind / lock failure THROWS (the caller `fatalExit`s — boot failure is the
 * ONLY fatal class). Runtime handling never throws to the top.
 */
export function startBusServer(
  busDb: Database,
  keeperDb: Database,
  sockPath: string,
  lockPath: string,
): BusServer {
  acquireLock(lockPath, sockPath);

  // Rehydrate the registry cache, dropping dead-pid channels (agents that exited
  // while the bus was down). These are persistence-cache rows only — no socket is
  // bound until the agent reconnects + subscribes, so they seed identity/name
  // resolution but are not delivery targets yet.
  const registry = new Map<string, RegistryEntry>();
  for (const row of liveChannelsAtBoot(loadChannels(busDb), isPidAlive)) {
    registry.set(row.channel_id, {
      channel: row,
      namespaces: row.namespaces,
      sock: null,
      queue: [],
      lastBeatMono: performance.now(),
      warned: false,
    });
  }

  const registryList = (): RegistryEntry[] => [...registry.values()];

  /** Resolve a target to a delivery channel id via the two-layer resolver. */
  const resolve = (target: string): BusResolveResult =>
    resolveTarget(registryList().map(toLiveChannel), keeperDb, target);

  /** Pre-serialize one event line ONCE, then fan out to each target. */
  const fanout = (
    namespace: string,
    resolvedChannelId: string | null,
    senderChannelId: string | null,
    envelope: EventEnvelope,
  ): void => {
    const line = `${JSON.stringify(envelope)}\n`;
    const targets = selectFanoutTargets(
      registryList(),
      namespace,
      resolvedChannelId,
      senderChannelId,
    );
    for (const t of targets) deliver(t, line);
  };

  /**
   * Deliver one pre-serialized line to a subscriber with bounded-queue
   * backpressure. NEVER awaits — a short write queues the tail; an overflow
   * EVICTS via destroy() (not end(), which would flush the dead queue). The
   * relay moves to the next subscriber regardless.
   */
  const deliver = (entry: RegistryEntry, line: string): void => {
    const sock = entry.sock;
    if (sock === null) {
      // Not subscribed (a registry-cache rehydrate, or a register without a
      // subscribe). Nothing to deliver to.
      return;
    }
    // Already-queued frames: append behind them (preserve order), then try to
    // flush. The queue is the bounded resource.
    if (entry.queue.length > 0) {
      if (entry.queue.length >= MAX_CLIENT_QUEUE) {
        evict(entry, "queue-overflow");
        return;
      }
      entry.queue.push(encoder.encode(line));
      flushQueue(entry);
      return;
    }
    const bytes = encoder.encode(line);
    const accepted = safeWrite(sock, bytes);
    if (accepted < 0) {
      // Socket closing/closed — evict.
      evict(entry, "write-closed");
      return;
    }
    const decision = backpressureDecision(accepted, bytes.length, 0);
    if (decision === "ok") return;
    // Short write — stash the unaccepted byte tail (never decoded; see queue
    // doc) so it re-flushes byte-identical even when split mid-UTF-8-sequence.
    entry.queue.push(requeueTail(bytes, accepted));
  };

  /** Flush queued frames until the socket backpressures or the queue empties. */
  const flushQueue = (entry: RegistryEntry): void => {
    const sock = entry.sock;
    if (sock === null) return;
    while (entry.queue.length > 0) {
      const bytes = entry.queue[0];
      const accepted = safeWrite(sock, bytes);
      if (accepted < 0) {
        evict(entry, "write-closed");
        return;
      }
      if (accepted >= bytes.length) {
        entry.queue.shift();
        continue;
      }
      // Partial — replace the head with its byte tail and stop (drain resumes
      // us). Sliced, not decoded, so a mid-UTF-8-sequence split stays intact.
      entry.queue[0] = requeueTail(bytes, accepted);
      return;
    }
  };

  /** Evict a subscriber: drop it from the registry + destroy() the socket. */
  const evict = (entry: RegistryEntry, reason: string): void => {
    console.error(
      `[bus-worker] evicting channel ${entry.channel.channel_id} (${reason})`,
    );
    registry.delete(entry.channel.channel_id);
    try {
      deleteChannel(busDb, entry.channel.pid, entry.channel.start_time);
    } catch {
      // best-effort cache delete
    }
    const sock = entry.sock;
    entry.sock = null;
    entry.queue = [];
    if (sock) {
      try {
        // destroy(), NOT end(): a slow subscriber's pending tail must be dropped,
        // not flushed (flushing a dead queue is the head-of-line block we evict
        // to avoid).
        (
          sock as unknown as { terminate?: () => void; end?: () => void }
        ).terminate?.();
        (sock as unknown as { end?: () => void }).end?.();
      } catch {
        // best-effort
      }
    }
  };

  // -- op dispatch -----------------------------------------------------------

  const handleOp = (sock: Writable, conn: BusConnState, op: ClientOp): void => {
    switch (op.op) {
      case "register":
        opRegister(sock, conn, op);
        return;
      case "heartbeat":
        opHeartbeat(conn);
        return;
      case "subscribe":
        opSubscribe(sock, conn, op);
        return;
      case "publish":
        opPublish(conn, op);
        return;
      case "list":
        opList(sock);
        return;
      case "resolve":
        opResolve(sock, op);
        return;
      case "deregister":
        opDeregister(conn);
        return;
      default:
        sendError(
          sock,
          "unknown_op",
          `unknown op: ${(op as { op?: string }).op}`,
        );
    }
  };

  const opRegister = (
    sock: Writable,
    conn: BusConnState,
    op: Extract<ClientOp, { op: "register" }>,
  ): void => {
    // Anti-spoof: the pid is the PEER pid, never the client-claimed one. The
    // peer is the `keeper bus watch` subprocess (harness → zsh → watch), so we
    // resolve the channel's IDENTITY from the nearest ancestor keeper tracks —
    // the Claude harness — rooting the walk at the server-resolved peer pid so a
    // client cannot forge an identity it is not descended from.
    const peerPid = conn.peerPid ?? op.pid ?? 0;
    const harness =
      peerPid > 0
        ? resolveHarnessIdentity(peerPid, ppidViaPs, (p) =>
            enrichPeerFromJobs(keeperDb, p),
          )
        : null;
    const enriched = harness?.identity ?? null;
    // The channel's identity pid is the resolved HARNESS pid (stable across a
    // `/clear`, and what keeper's liveness/takeover keys must track); on a keeper
    // miss (resume gap) it falls back to the bare peer pid.
    const identityPid = harness?.pid ?? peerPid;
    // keeper miss → fall back to the client-provided floor name/session (resume
    // gap before keeper folds the new session).
    const sessionId = enriched?.job_id ?? op.session_id ?? null;
    // Pair the resolved pid with its keeper start_time (pid-reuse defense); the
    // jobs-row start_time on a hit, else the client floor / a synthetic stamp.
    const startTime =
      enriched?.start_time ?? op.start_time ?? `${identityPid}-${Date.now()}`;
    const name = enriched?.title ?? op.name ?? null;
    const history =
      enriched && enriched.name_history.length > 0
        ? enriched.name_history
        : name != null
          ? [name]
          : [];
    const namespaces = normalizeNamespaces(op.namespaces, op.namespace);

    const channelId = `ch-${crypto.randomUUID()}`;
    // Takeover: a prior live channel for the SAME (pid, start_time) is superseded.
    const victim = takeoverVictim(
      registryList(),
      identityPid,
      startTime,
      channelId,
    );
    if (victim !== null) {
      const v = registry.get(victim);
      if (v) {
        publishControl(
          busDb,
          "takeover",
          v.channel,
          namespaces[0] ?? DEFAULT_NAMESPACE,
        );
        evict(v, "takeover");
      }
    }

    const channel: ChannelRow = {
      channel_id: channelId,
      pid: identityPid,
      start_time: startTime,
      session_id: sessionId,
      current_name: name,
      name_history: history,
      namespaces,
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    };
    const entry: RegistryEntry = {
      channel,
      namespaces,
      sock: null,
      queue: [],
      lastBeatMono: performance.now(),
      warned: false,
    };
    registry.set(channelId, entry);
    conn.entry = entry;
    try {
      upsertChannel(busDb, channel);
    } catch (err) {
      console.error("[bus-worker] upsertChannel failed (non-fatal):", err);
    }
    publishControl(busDb, "join", channel, namespaces[0] ?? DEFAULT_NAMESPACE);
    sendAck(sock, "register", {
      channel_id: channelId,
      session_id: sessionId,
      name,
      namespaces,
    });
  };

  const opHeartbeat = (conn: BusConnState): void => {
    if (conn.entry === null) return;
    conn.entry.lastBeatMono = performance.now();
    conn.entry.warned = false;
    conn.entry.channel.last_heartbeat = Date.now();
  };

  const opSubscribe = (
    sock: Writable,
    conn: BusConnState,
    op: Extract<ClientOp, { op: "subscribe" }>,
  ): void => {
    if (conn.entry === null) {
      sendError(sock, "not_registered", "subscribe before register");
      return;
    }
    const entry = conn.entry;
    if (op.namespaces && op.namespaces.length > 0) {
      entry.namespaces = [...new Set(op.namespaces)];
      entry.channel.namespaces = entry.namespaces;
    }
    entry.sock = sock;
    entry.lastBeatMono = performance.now();
    try {
      upsertChannel(busDb, entry.channel);
    } catch {
      // best-effort cache update
    }
    // The replay cursor: a reconnecting client recovers rows > after_id from the
    // durable message log, then streams live. The ack carries the CURRENT max id
    // so the client fences the gap.
    sendAck(sock, "subscribe", {
      channel_id: entry.channel.channel_id,
      last_message_id: maxMessageId(busDb),
      namespaces: entry.namespaces,
    });
  };

  const opPublish = (
    conn: BusConnState,
    op: Extract<ClientOp, { op: "publish" }>,
  ): void => {
    if (conn.entry === null) {
      // A publish before register has no authoritative identity — drop it.
      return;
    }
    const entry = conn.entry;
    const namespace = op.namespace ?? entry.namespaces[0] ?? DEFAULT_NAMESPACE;
    const event = op.event ?? "send";
    const payload: Payload = op.payload ?? {
      media_type: "text/plain",
      text: "",
    };
    const from = authoritativeFrom(
      entry.channel.channel_id,
      entry.channel.pid,
      {
        session_id: entry.channel.session_id,
        name: entry.channel.current_name,
      },
    );

    let resolvedChannelId: string | null = null;
    let resolvedSessionId: string | null = null;
    let toTarget: string | null = null;
    if (event === "send") {
      toTarget = op.to ?? "";
      const res = resolve(toTarget);
      if (res.kind === "ok" && res.channel) {
        resolvedChannelId = res.channel.channel_id;
        resolvedSessionId = res.channel.session_id;
      } else {
        // Unknown / not-on-the-bus / ambiguous: persist the attempt for forensics
        // but deliver to no one. The sender's own CLI surfaces the miss.
        appendMessage(busDb, {
          namespace,
          event,
          from_channel_id: from.channel_id,
          from_pid: from.pid,
          from_name: from.name,
          to_target: toTarget,
          resolved_channel_id: null,
          resolved_session_id: null,
          body: payload.text,
          status: res.kind,
          reply_to: op.reply_to ?? null,
        });
        return;
      }
    }

    const id = appendMessage(busDb, {
      namespace,
      event,
      from_channel_id: from.channel_id,
      from_pid: from.pid,
      from_name: from.name,
      to_target: toTarget,
      resolved_channel_id: resolvedChannelId,
      resolved_session_id: resolvedSessionId,
      body: payload.text,
      status: "delivered",
      reply_to: op.reply_to ?? null,
    });

    const envelope: EventEnvelope = {
      v: 1,
      namespace,
      event: "message",
      id,
      ts: Date.now(),
      from,
      to: {
        target: toTarget ?? "",
        channel_id: resolvedChannelId,
        session_id: resolvedSessionId,
      },
      payload,
      reply_to: op.reply_to ?? null,
    };
    fanout(namespace, resolvedChannelId, from.channel_id, envelope);
  };

  const opList = (sock: Writable): void => {
    const channels = registryList().map((e) => ({
      channel_id: e.channel.channel_id,
      pid: e.channel.pid,
      session_id: e.channel.session_id,
      name: e.channel.current_name,
      namespaces: e.namespaces,
      subscribed: e.sock !== null,
    }));
    sendAck(sock, "list", { channels });
  };

  const opResolve = (
    sock: Writable,
    op: Extract<ClientOp, { op: "resolve" }>,
  ): void => {
    const res = resolve(op.target);
    sendAck(sock, "resolve", {
      target: op.target,
      kind: res.kind,
      method: res.kind === "unknown" ? "unknown" : res.method,
      channel_id: res.kind === "ok" ? (res.channel?.channel_id ?? null) : null,
      session_id:
        res.kind === "ok"
          ? (res.channel?.session_id ?? res.identity?.job_id ?? null)
          : null,
    });
  };

  const opDeregister = (conn: BusConnState): void => {
    if (conn.entry === null) return;
    const entry = conn.entry;
    publishControl(
      busDb,
      "part",
      entry.channel,
      entry.namespaces[0] ?? DEFAULT_NAMESPACE,
    );
    registry.delete(entry.channel.channel_id);
    try {
      deleteChannel(busDb, entry.channel.pid, entry.channel.start_time);
    } catch {
      // best-effort
    }
    entry.sock = null;
    conn.entry = null;
  };

  // -- listener --------------------------------------------------------------

  const listener = Bun.listen<BusConnState>({
    unix: sockPath,
    socket: {
      open(socket) {
        try {
          socket.data = {
            buffer: new LineBuffer(),
            entry: null,
            peerPid: peerPidForFd(
              (socket as unknown as { fd?: number }).fd ?? -1,
            ),
            id: ++__nextConnId,
          };
        } catch (err) {
          console.error("[bus-worker] open handler failed:", err);
        }
      },
      data(socket, chunk) {
        // Per-chunk try/catch: a malformed/oversized frame is DROPPED + logged,
        // never thrown to the top (a runtime fault must not bounce the daemon).
        const w = socket as unknown as Writable;
        let lines: string[];
        try {
          lines = socket.data.buffer.push(chunk.toString("utf8"));
        } catch (err) {
          // Oversized line — reject + destroy this conn only (sibling conns
          // unaffected). The peer is misbehaving / corrupt.
          console.error("[bus-worker] oversized frame, dropping conn:", err);
          try {
            socket.end();
          } catch {
            // best-effort
          }
          return;
        }
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          if (line.length > MAX_FRAME_LENGTH) {
            console.error("[bus-worker] oversized line dropped");
            continue;
          }
          let op: ClientOp;
          try {
            op = JSON.parse(line) as ClientOp;
          } catch {
            // Malformed JSON — drop this frame, keep the connection (a corrupt
            // line must not affect other frames or other subscribers).
            console.error("[bus-worker] malformed frame dropped");
            continue;
          }
          if (!op || typeof (op as { op?: unknown }).op !== "string") {
            console.error("[bus-worker] frame missing op, dropped");
            continue;
          }
          try {
            handleOp(w, socket.data, op);
          } catch (err) {
            // A handler fault is a logged non-fatal drop — NEVER a daemon bounce.
            console.error("[bus-worker] op handler threw (non-fatal):", err);
          }
        }
      },
      drain(socket) {
        const entry = socket.data?.entry;
        if (entry?.sock) flushQueue(entry);
      },
      close(socket) {
        // The peer went away. Unbind its socket but KEEP the registry entry as a
        // cache row (the agent may reconnect + replay) UNLESS it never registered.
        const entry = socket.data?.entry;
        if (entry) {
          entry.sock = null;
          entry.queue = [];
        }
      },
      error(_socket, err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "EPIPE" || code === "ECONNRESET") return;
        console.error("[bus-worker] socket error:", err);
      },
    },
  });

  // 0700 parent dir is the real ACL gate on macOS; chmod 0600 as Linux
  // defense-in-depth (matches the server worker).
  try {
    chmodSync(sockPath, 0o600);
  } catch {
    // best-effort; the dir mode is the real gate
  }

  // Reap loop on the MONOTONIC clock — a silent channel past the evict threshold
  // is dropped; a warn threshold logs once. Unref'd so it never holds the loop.
  const reapTimer = setInterval(() => {
    try {
      reapOnce();
    } catch (err) {
      console.error("[bus-worker] reap threw (non-fatal):", err);
    }
  }, REAP_INTERVAL_MS);
  reapTimer.unref?.();

  const reapOnce = (): void => {
    const now = performance.now();
    for (const entry of registryList()) {
      const verdict = reapDecision(now, entry.lastBeatMono);
      if (verdict === "evict") {
        publishControl(
          busDb,
          "reap",
          entry.channel,
          entry.namespaces[0] ?? DEFAULT_NAMESPACE,
        );
        evict(entry, "heartbeat-timeout");
      } else if (verdict === "warn" && !entry.warned) {
        entry.warned = true;
        console.error(
          `[bus-worker] channel ${entry.channel.channel_id} missed heartbeat (warn)`,
        );
      }
    }
  };

  return {
    stop() {
      clearInterval(reapTimer);
      try {
        listener.stop(true);
      } catch {
        // best-effort
      }
      cleanupSock(sockPath, lockPath);
    },
  };
}

/** Append a `bus`-namespace lifecycle event to the durable log (forensics). */
function publishControl(
  busDb: Database,
  event: string,
  channel: ChannelRow,
  _ns: string,
): void {
  try {
    appendMessage(busDb, {
      namespace: CONTROL_NAMESPACE,
      event,
      from_channel_id: channel.channel_id,
      from_pid: channel.pid,
      from_name: channel.current_name,
      to_target: null,
      body: null,
      status: event,
    });
  } catch (err) {
    console.error("[bus-worker] publishControl failed (non-fatal):", err);
  }
}

/** Normalize the namespaces a register/subscribe declares to a deduped array. */
function normalizeNamespaces(
  list: string[] | undefined,
  single: string | undefined,
): string[] {
  const set = new Set<string>();
  if (list) for (const n of list) if (typeof n === "string" && n) set.add(n);
  if (single) set.add(single);
  if (set.size === 0) set.add(DEFAULT_NAMESPACE);
  return [...set];
}

/** Write bytes to a socket, returning bytes accepted or a negative on close. */
function safeWrite(sock: Writable, bytes: Uint8Array): number {
  try {
    return sock.write(bytes, 0, bytes.length);
  } catch {
    return -1;
  }
}

/**
 * Slice the unaccepted byte tail of a frame after a short write, for
 * re-queueing. Returns a byte view (never a decoded string) so a write that
 * lands mid multi-byte UTF-8 sequence re-flushes byte-identical instead of
 * collapsing the split bytes to a U+FFFD replacement char.
 */
export function requeueTail(bytes: Uint8Array, accepted: number): Uint8Array {
  return bytes.subarray(Math.max(0, accepted));
}

/** Send an `ack` frame (server → client). Never throws. */
function sendAck(
  sock: Writable,
  op: string,
  body: Record<string, unknown>,
): void {
  writeLine(sock, { type: "ack", op, ...body });
}

/** Send an `error` frame (server → client). Never throws. */
function sendError(sock: Writable, code: string, message: string): void {
  writeLine(sock, { type: "error", code, message });
}

/** Serialize + write one NDJSON line, swallowing transport faults. */
function writeLine(sock: Writable, frame: Record<string, unknown>): void {
  try {
    const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
    sock.write(bytes, 0, bytes.length);
  } catch {
    // best-effort; a broken peer is handled by the close/error path
  }
}

/** Remove the socket + lock files (best-effort) on shutdown. */
function cleanupSock(sockPath: string, lockPath: string): void {
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  for (const p of [sockPath, lockPath]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Worker entrypoint. Opens both connections, binds + serves, wires the shutdown
 * message. A BOOT failure (bind / lock-held / db-open) exits non-zero so launchd
 * backs off and the daemon's onerror/close guard fatalExits; runtime faults are
 * handled inline and never escape.
 */
function main(): void {
  if (!parentPort) {
    console.error("[bus-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as BusWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[bus-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const sockPath = data.sockPath ?? resolveBusSockPath();
  const lockPath = `${sockPath}.lock`;
  const busDbPath = data.busDbPath ?? resolveBusDbPath();

  let busDb: Database;
  let keeperDb: Database;
  try {
    busDb = openBusDb(busDbPath);
    // keeper.db read-only: a reader open does NOT migrate (main is the sole
    // migrator). jobs identity reads only.
    keeperDb = openDb(data.dbPath, {
      readonly: true,
      prepareStmts: false,
      bootRetry: true,
    }).db;
  } catch (err) {
    console.error("[bus-worker] db open failed:", err);
    process.exit(1);
  }

  let server: BusServer;
  try {
    server = startBusServer(busDb, keeperDb, sockPath, lockPath);
  } catch (err) {
    // Lock held by a live instance, or bind failed — boot failure, the ONLY
    // fatal class. Exit non-zero; the daemon's guard fatalExits.
    if (err instanceof LockHeldError) {
      console.error(
        "[bus-worker] bus lock held; refusing to start:",
        err.message,
      );
    } else {
      console.error("[bus-worker] failed to start:", err);
    }
    try {
      busDb.close();
    } catch {
      // ignore
    }
    try {
      keeperDb.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    try {
      server.stop();
    } catch {
      // best-effort
    }
    try {
      busDb.close();
    } catch {
      // best-effort
    }
    try {
      keeperDb.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  };

  // Hard deadline guard: if a wedged close keeps the loop alive, force-exit.
  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      const timer = setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS);
      timer.unref?.();
      shutdown();
    }
  });
}

// Only run inside a real Worker; a plain import on the main thread (the fast-tier
// pure-decision tests) is inert.
if (!isMainThread) {
  main();
}
