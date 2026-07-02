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
 * register / subscribe / publish(send) / list / deregister; server →
 * ack / event / presence / error. A `subscribe` ack carries the
 * `last_message_id` replay cursor. A `publish` ack carries the synchronous
 * delivery result. Peer liveness is socket-close (a kill/crash FINs the fd);
 * there is NO heartbeat op and NO periodic liveness timer.
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
  DELIVERED_AFTER_WAKE,
  deleteChannel,
  loadChannels,
  type MessageRow,
  maxMessageId,
  openBusDb,
  QUEUED_FOR_WAKE,
  selectQueuedForWake,
  upsertChannel,
} from "./bus-db";
import {
  type BusResolveResult,
  type LiveChannel,
  parseRoleAddress,
  resolveTarget,
} from "./bus-identity";
import { openDb, resolveBusDbPath, resolveBusSockPath } from "./db";
import { LineBuffer } from "./protocol";
import { readOsStartTime } from "./seed-sweep";
import {
  acquireLock,
  isPidAlive,
  LockHeldError,
  peerPidForFd,
  unlinkIfExists,
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
      /**
       * A pure-send registration (e.g. `keeper bus chat send`): bind the
       * authoritative identity for the `from` stamp, but do NOT join the live
       * registry, take over the agent's live `watch` channel, or persist a
       * `bus.db` cache row. Without this a transient send would evict the agent's
       * subscribed watch channel (same `(pid, start_time)` takeover) AND leave a
       * `sock=null` ghost that reads as a reachable-but-disconnected target.
       */
      send_only?: boolean;
    }
  | { op: "subscribe"; namespaces?: string[]; after_id?: number }
  | {
      op: "publish";
      event?: "send";
      namespace?: string;
      to?: string;
      payload?: Payload;
      reply_to?: number | null;
    }
  | { op: "list" }
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
 * Fan-out target selection: the CONNECTED channels that should receive a message
 * in `namespace` addressed to `resolvedChannelId`. A directed send goes to the
 * single resolved channel (when it is connected + subscribed). A channel with no
 * open socket (`sock === null` — a rehydrated cache row or a closed-but-kept
 * identity) is NEVER a delivery target, so the fanned-out count matches what
 * actually got written. The sender is never echoed its own message. Pure over the
 * registry snapshot.
 *
 * @param registry          all registry entries (the routing universe).
 * @param namespace         the tenant axis.
 * @param resolvedChannelId the directed target's channel id.
 * @param senderChannelId   the publisher's channel id (excluded from delivery).
 */
export function selectFanoutTargets(
  registry: RegistryEntry[],
  namespace: string,
  resolvedChannelId: string,
  senderChannelId: string | null,
): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const e of registry) {
    if (e.sock === null) continue;
    if (e.channel.channel_id === senderChannelId) continue;
    if (!e.namespaces.includes(namespace)) continue;
    if (e.channel.channel_id !== resolvedChannelId) continue;
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
 * The synchronous result vocabulary a publish replies with (and persists to
 * `messages.status`). A directed send resolves to exactly one of these.
 *
 *  - `delivered`       — the resolved target had an OPEN socket and the full
 *                        frame was accepted (a directed send: 1 recipient).
 *  - `not_connected`   — the target resolved to a known identity, but no open
 *                        socket (delivered to no one). The seam for a future
 *                        wake-on-send.
 *  - `unknown_target`  — the name resolved to nothing.
 *  - `ambiguous_target`— the name resolved to >1 distinct identity.
 *  - `delivery_failed` — resolved + connected, but the write was partial/failed
 *                        (or the peer was evicted mid-fanout).
 */
export type PublishOutcome =
  | "delivered"
  | "not_connected"
  | "unknown_target"
  | "ambiguous_target"
  | "delivery_failed";

/**
 * Compute the TRUE directed-send outcome from the resolution kind and the count
 * of targets whose full frame was actually accepted into an open socket. Pure —
 * the impure fanout runs first and hands its delivered-count in.
 *
 *  - resolution `unknown`   → `unknown_target`
 *  - resolution `ambiguous` → `ambiguous_target`
 *  - resolution `ok` but the resolved channel has no open socket
 *    (`resolvedConnected === false`) → `not_connected`
 *  - resolution `ok` + connected, `delivered >= 1` → `delivered`
 *  - resolution `ok` + connected, but `delivered === 0` (partial write / the
 *    peer was evicted during fanout) → `delivery_failed`
 */
export function publishOutcome(
  resolveKind: "ok" | "ambiguous" | "unknown",
  resolvedConnected: boolean,
  deliveredCount: number,
): PublishOutcome {
  if (resolveKind === "unknown") return "unknown_target";
  if (resolveKind === "ambiguous") return "ambiguous_target";
  if (!resolvedConnected) return "not_connected";
  return deliveredCount >= 1 ? "delivered" : "delivery_failed";
}

/**
 * Decide what an OFFLINE directed send persists (the no-delivery branch: target
 * unknown/ambiguous, or known-but-disconnected). Two axes:
 *
 *  - `resolvedSessionId` — the durable recipient key. On an `ok` resolution the
 *    resolved IDENTITY carries the creator's stable `job_id` even when no live
 *    channel exists (`channel:null` offline); persist THAT, not the always-null
 *    `channel?.session_id`. A keeper-miss live-fallback resolves `identity:null`,
 *    which correctly yields `null` → not durably queued. Non-`ok` → `null`.
 *  - `status` — `queued_for_wake` ONLY for a `planner@<epic>`-shaped role address
 *    whose creator identity is known (a resolvable `job_id`); the returning
 *    creator replays it on resubscribe. EVERY other offline send keeps its honest
 *    {@link publishOutcome} verdict (`not_connected` / `unknown_target` /
 *    `ambiguous_target`) — a generic offline name is NOT turned into a durable
 *    queue.
 *
 * Pure over `(res, toTarget, fallbackOutcome)` — the impure resolve + outcome run
 * first and hand their results in.
 */
export function offlineSendPersist(
  res: BusResolveResult,
  toTarget: string,
  fallbackOutcome: string,
): { resolvedSessionId: string | null; status: string } {
  const resolvedSessionId =
    res.kind === "ok" ? (res.identity?.job_id ?? null) : null;
  const isRole = parseRoleAddress(toTarget) !== null;
  const status =
    isRole && resolvedSessionId !== null ? QUEUED_FOR_WAKE : fallbackOutcome;
  return { resolvedSessionId, status };
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
 * to, the bound socket (null until `subscribe`, null again on close), the
 * bounded outbound queue, and the binding generation token.
 *
 * Peer death is socket-close: there is NO heartbeat stamp and no reaper. A live
 * entry's presence is exactly `sock !== null`.
 */
export interface RegistryEntry {
  channel: ChannelRow;
  namespaces: string[];
  /** The subscribed socket; null until a `subscribe` op binds it, null on close. */
  sock: Writable | null;
  /**
   * Bounded outbound queue of pre-serialized, UTF-8-encoded NDJSON frames. Held
   * as bytes (never decoded strings) so a partial-write tail re-flushes
   * byte-identical — a short write splitting a multi-byte sequence must not be
   * round-tripped through a TextDecoder (it would mint U+FFFD).
   */
  queue: Uint8Array[];
  /**
   * Monotonic binding generation, bumped on every `subscribe` that binds a
   * socket. A connection captures the generation it bound at; a late `close()`
   * from a superseded connection only nulls `sock` when its captured generation
   * still matches — so a takeover that rebinds the entry to a fresh connection
   * is not clobbered by the victim socket's straggling close. See
   * {@link closeOwnsBinding}.
   */
  generation: number;
  /**
   * A pure-send registration not in the live `registry`: it carries the
   * authoritative `from` identity for `opPublish` but is never a delivery
   * target, never takes over the agent's live `watch` channel, and never writes
   * a `bus.db` cache row. So `opDeregister` must NOT delete the agent's real
   * persisted channel (keyed on the shared `(pid, start_time)`) on its behalf.
   */
  ephemeral?: boolean;
}

/**
 * Generation-token guard for the close handler: a closing connection may null
 * the entry's socket ONLY when the generation it bound at still matches the
 * entry's current generation. A takeover/re-subscribe bumps the generation, so a
 * superseded victim's late close (`connGeneration < entry.generation`) no-ops
 * and the reconnected channel keeps its fresh socket. Pure.
 */
export function closeOwnsBinding(
  connGeneration: number,
  entryGeneration: number,
): boolean {
  return connGeneration === entryGeneration;
}

/** Map a {@link RegistryEntry}'s channel to the resolver's {@link LiveChannel}.
 *  `connected` surfaces the presence axis — an open socket means deliverable. */
export function toLiveChannel(e: RegistryEntry): LiveChannel {
  return {
    channel_id: e.channel.channel_id,
    pid: e.channel.pid,
    start_time: e.channel.start_time,
    session_id: e.channel.session_id,
    current_name: e.channel.current_name,
    name_history: e.channel.name_history,
    connected: e.sock !== null,
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
 *
 * RECYCLED-PID GUARD: a bare-pid match proves only that SOME process holds that
 * number, not that it is the one that registered. An OS-recycled pid carrying a
 * lingering dead `jobs` row would otherwise bind the dead agent's identity. So
 * on a row hit we probe the LIVE process's start_time ONCE (`readStartTime`) and
 * compare it verbatim to the row's `start_time` — the same `(pid, start_time)`
 * identity `src/bus-identity.ts` and `src/exit-watcher.ts` already key on. The
 * persisted format is byte-identical to the probe (both share
 * `splitArgsLstart`/`parseLinuxStarttime`), so the compare is a plain string
 * match. On a mismatch OR a null/failed probe we return null (fail closed) — the
 * ancestry walk then climbs to the true parent rather than bind an unverified
 * pid-only identity. Probed at most once per matched row, never per ancestry hop.
 */
export function enrichPeerFromJobs(
  keeperDb: Database,
  pid: number,
  readStartTime: (pid: number) => string | null = readOsStartTime,
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
  const rowStartTime = row.start_time == null ? null : String(row.start_time);
  // Recycled-pid guard: verify the live pid is the SAME process the row tracks.
  // Fail closed (return null → keep climbing) on a stale/dead row or an
  // unreadable probe — never bind a pid-only identity.
  if (rowStartTime === null || readStartTime(pid) !== rowStartTime) return null;
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

/** Ancestry-walk depth bound for the server-side harness identity walk. */
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
  /**
   * The entry generation this connection bound at its last `subscribe`. The
   * close handler compares it against the entry's CURRENT generation so a
   * superseded victim's late close cannot clobber a reconnected channel.
   */
  boundGeneration: number;
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
  readStartTime: (pid: number) => string | null = readOsStartTime,
): BusServer {
  acquireLock(lockPath, sockPath);

  // AF_UNIX has no SO_REUSEADDR: a leftover socket file (a SIGKILLed prior
  // incarnation whose lock we just reclaimed, or a lock/socket mismatch) → an
  // EADDRINUSE bind failure. The lock is already ours, so unlinking here can't race
  // another live instance. Mirrors the server worker's unlink-at-boot.
  unlinkIfExists(sockPath);

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
      generation: 0,
    });
  }

  const registryList = (): RegistryEntry[] => [...registry.values()];

  /** Resolve a target to a delivery channel id via the two-layer resolver. */
  const resolve = (target: string): BusResolveResult =>
    resolveTarget(registryList().map(toLiveChannel), keeperDb, target);

  /**
   * Pre-serialize one event line ONCE, then fan out to each CONNECTED target.
   * Returns the count of targets whose FULL frame was accepted into an open
   * socket with no eviction — the honest delivered count the publish result is
   * computed from. A queued (short-write) or evicted target does NOT count.
   */
  const fanout = (
    namespace: string,
    resolvedChannelId: string,
    senderChannelId: string | null,
    envelope: EventEnvelope,
  ): number => {
    const line = `${JSON.stringify(envelope)}\n`;
    const targets = selectFanoutTargets(
      registryList(),
      namespace,
      resolvedChannelId,
      senderChannelId,
    );
    let delivered = 0;
    for (const t of targets) if (deliver(t, line)) delivered++;
    return delivered;
  };

  /**
   * Deliver one pre-serialized line to a subscriber with bounded-queue
   * backpressure. NEVER awaits — a short write queues the tail; an overflow
   * EVICTS via destroy() (not end(), which would flush the dead queue). The
   * relay moves to the next subscriber regardless. Returns true ONLY when the
   * full frame was accepted into the open socket with no eviction — a queued
   * tail or an evict returns false (so the publish result counts only L1-accepted
   * recipients, never a partially-buffered one).
   */
  const deliver = (entry: RegistryEntry, line: string): boolean => {
    const sock = entry.sock;
    if (sock === null) {
      // Not subscribed (a registry-cache rehydrate, or a register without a
      // subscribe). Nothing to deliver to.
      return false;
    }
    // Already-queued frames: append behind them (preserve order), then try to
    // flush. The queue is the bounded resource.
    if (entry.queue.length > 0) {
      if (entry.queue.length >= MAX_CLIENT_QUEUE) {
        evict(entry, "queue-overflow");
        return false;
      }
      entry.queue.push(encoder.encode(line));
      flushQueue(entry);
      // The frame is buffered behind a backlog, not yet fully on the wire.
      return false;
    }
    const bytes = encoder.encode(line);
    const accepted = safeWrite(sock, bytes);
    if (accepted < 0) {
      // Socket closing/closed — evict.
      evict(entry, "write-closed");
      return false;
    }
    const decision = backpressureDecision(accepted, bytes.length, 0);
    if (decision === "ok") return true;
    // Short write — stash the unaccepted byte tail (never decoded; see queue
    // doc) so it re-flushes byte-identical even when split mid-UTF-8-sequence.
    entry.queue.push(requeueTail(bytes, accepted));
    return false;
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
      case "subscribe":
        opSubscribe(sock, conn, op);
        return;
      case "publish":
        opPublish(sock, conn, op);
        return;
      case "list":
        opList(sock);
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
            enrichPeerFromJobs(keeperDb, p, readStartTime),
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
    const sendOnly = op.send_only === true;

    // Takeover: a prior live channel for the SAME (pid, start_time) is
    // superseded. A send-only registration NEVER takes over — a transient send
    // shares the agent's `(pid, start_time)` identity, so taking over here would
    // evict its live `watch` channel (the reachability regression this guards).
    if (!sendOnly) {
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
      generation: 0,
      ephemeral: sendOnly,
    };
    conn.entry = entry;
    // A send-only registration binds the `from` identity on `conn.entry` ONLY: it
    // is kept out of the live `registry` (invisible to list/resolve/fanout — no
    // `sock=null` ghost), writes no `bus.db` cache row, and emits no `join` (a
    // pure send is not a presence event). All other registrations join the
    // registry + persist + announce.
    if (!sendOnly) {
      registry.set(channelId, entry);
      try {
        upsertChannel(busDb, channel);
      } catch (err) {
        console.error("[bus-worker] upsertChannel failed (non-fatal):", err);
      }
      publishControl(
        busDb,
        "join",
        channel,
        namespaces[0] ?? DEFAULT_NAMESPACE,
      );
    }
    sendAck(sock, "register", {
      channel_id: channelId,
      session_id: sessionId,
      name,
      namespaces,
    });
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
    // Bump the binding generation and record it on THIS connection: a later
    // takeover/re-subscribe bumps it again, so a superseded conn's late close
    // (carrying the older generation) no-ops instead of nulling the fresh socket.
    entry.generation += 1;
    conn.boundGeneration = entry.generation;
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
    replayQueuedForWake(entry);
  };

  /**
   * Durable wake-on-send replay: a returning creator session receives the
   * `planner@<epic>` escalations queued while it was offline. Recipient-keyed on
   * the channel's stable `session_id` (the creator's job_id) so a session only ever
   * gets its OWN queued rows — never another recipient's, never an unrelated chat
   * row. Each accepted row flips to `delivered_after_wake`; the flip IS the dedup,
   * so a second subscribe re-queries and finds none. A row not accepted (the socket
   * just bound is full/closing — should not happen on a fresh bind) stays
   * `queued_for_wake` for the next resubscribe.
   */
  const replayQueuedForWake = (entry: RegistryEntry): void => {
    const sessionId = entry.channel.session_id;
    if (sessionId === null) return;
    let rows: MessageRow[];
    try {
      rows = selectQueuedForWake(busDb, sessionId);
    } catch (err) {
      console.error(
        "[bus-worker] selectQueuedForWake failed (non-fatal):",
        err,
      );
      return;
    }
    for (const row of rows) {
      const envelope = buildEnvelope(
        row.namespace,
        row.id,
        {
          channel_id: row.from_channel_id ?? "",
          pid: row.from_pid ?? 0,
          session_id: null,
          name: row.from_name,
        },
        row.to_target,
        row.resolved_channel_id,
        row.resolved_session_id,
        { media_type: "text/plain", text: row.body ?? "" },
        row.reply_to,
      );
      const line = `${JSON.stringify(envelope)}\n`;
      if (deliver(entry, line)) {
        setMessageStatus(busDb, row.id, DELIVERED_AFTER_WAKE);
      }
    }
  };

  const opPublish = (
    sock: Writable,
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

    // -- directed send: resolve, then gate DELIVERY on a connected socket -----
    // Every publish is a directed send. A degenerate `to`-less frame resolves to
    // `""` → `unknown_target` → loud non-delivery, never a silent drop.
    const toTarget = op.to ?? "";
    const res = resolve(toTarget);
    // The resolved live channel (present only on an `ok` resolution) carries
    // the presence axis: a delivery needs `connected === true`.
    const channel = res.kind === "ok" ? res.channel : null;
    // Resolution that yields no DELIVERY (unknown / ambiguous / known-but-
    // disconnected) persists the true outcome and replies; it fans out to no
    // one. A resolved-but-disconnected identity is `not_connected`, NOT
    // `unknown` — the seam for a future wake-on-send.
    if (channel === null || !channel.connected) {
      const outcome = publishOutcome(res.kind, channel?.connected ?? false, 0);
      // A `planner@<epic>` escalation to a KNOWN-but-offline creator is made
      // durable: persist the creator's stable job_id as the recipient key and
      // flag it `queued_for_wake` so the creator's resubscribe replays it. Every
      // other offline send keeps its honest non-delivery outcome.
      const { resolvedSessionId, status } = offlineSendPersist(
        res,
        toTarget,
        outcome,
      );
      appendMessage(busDb, {
        namespace,
        event,
        from_channel_id: from.channel_id,
        from_pid: from.pid,
        from_name: from.name,
        to_target: toTarget,
        resolved_channel_id: channel?.channel_id ?? null,
        resolved_session_id: resolvedSessionId,
        body: payload.text,
        status,
        reply_to: op.reply_to ?? null,
      });
      sendAck(sock, "publish", { result: status, recipients: 0 });
      return;
    }

    const resolvedChannelId = channel.channel_id;
    const resolvedSessionId = channel.session_id;
    // Persist provisionally so the envelope id (the replay cursor) is minted
    // BEFORE fanout, then compute the TRUE outcome from what fanout actually
    // wrote and reconcile the status. No unconditional pre-fanout `delivered`.
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
      status: "pending",
      reply_to: op.reply_to ?? null,
    });
    const envelope = buildEnvelope(
      namespace,
      id,
      from,
      toTarget,
      resolvedChannelId,
      resolvedSessionId,
      payload,
      op.reply_to ?? null,
    );
    const delivered = fanout(
      namespace,
      resolvedChannelId,
      from.channel_id,
      envelope,
    );
    const outcome = publishOutcome("ok", true, delivered);
    setMessageStatus(busDb, id, outcome);
    sendAck(sock, "publish", { result: outcome, recipients: delivered });
  };

  /** Build one delivered-message event envelope (the 2-axis wire shape). */
  const buildEnvelope = (
    namespace: string,
    id: number,
    from: FromIdentity,
    toTarget: string | null,
    resolvedChannelId: string | null,
    resolvedSessionId: string | null,
    payload: Payload,
    replyTo: number | null,
  ): EventEnvelope => ({
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
    reply_to: replyTo,
  });

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

  const opDeregister = (conn: BusConnState): void => {
    if (conn.entry === null) return;
    const entry = conn.entry;
    // A send-only ephemeral entry never joined the registry and never wrote a
    // cache row; deleting on its behalf would drop the agent's REAL persisted
    // channel (shared `(pid, start_time)` key) and emit a spurious `part`. Just
    // detach the connection.
    if (entry.ephemeral === true) {
      conn.entry = null;
      return;
    }
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
            boundGeneration: 0,
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
        // The peer went away — socket-close is the death signal (no heartbeat).
        // Unbind its socket but KEEP the registry entry as a cache row (the agent
        // may reconnect + replay). Generation guard: only null `sock` when THIS
        // connection still owns the current binding. A takeover/re-subscribe
        // rebound the entry to a fresh socket with a higher generation, so a
        // superseded victim's late close must NOT clobber the reconnected channel.
        const conn = socket.data;
        const entry = conn?.entry;
        if (entry && closeOwnsBinding(conn.boundGeneration, entry.generation)) {
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

  // No periodic liveness timer: peer death is socket-close (a kill/crash FINs
  // the peer fd → the `close` handler nulls the entry's socket). Boot rehydration
  // (`liveChannelsAtBoot`) drops dead pids once; steady state needs no sweep.

  return {
    stop() {
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

/**
 * Reconcile a persisted message's `status` to the TRUE post-fanout outcome — the
 * provisional `pending` row is rewritten to `delivered`/`delivery_failed` once
 * fanout reports what actually got written. `messages.status` is free-text TEXT,
 * so no schema bump. Direct UPDATE on the worker's own writable bus.db handle
 * (the bus worker is the sole bus.db writer). Best-effort — a forensic-log write
 * failure must never bounce the daemon.
 */
function setMessageStatus(busDb: Database, id: number, status: string): void {
  try {
    busDb
      .prepare("UPDATE messages SET status = ? WHERE id = ?")
      .run(status, id);
  } catch (err) {
    console.error("[bus-worker] setMessageStatus failed (non-fatal):", err);
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
