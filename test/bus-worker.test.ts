/**
 * Fast-tier pure-decision tests for `src/bus-worker.ts` (epic fn-886 task .1).
 *
 * Exercises the worker's PURE decision symbols — `authoritativeFrom` (anti-spoof
 * from-overwrite), `selectFanoutTargets` (namespace ∩ resolved-target routing,
 * connected-only), `backpressureDecision` (bounded-queue eviction),
 * `publishOutcome` (the honest directed-send result vocabulary),
 * `closeOwnsBinding` (the takeover generation token), `toLiveChannel` (the
 * presence axis), `takeoverVictim` (duplicate-watcher/takeover on the stable
 * `(pid, start_time)` key), `liveChannelsAtBoot` (dead-pid drop), and
 * `enrichPeerFromJobs` (read-only keeper.db identity enrichment, including the
 * `(pid, start_time)` recycled-pid guard that fails closed to the ancestry walk).
 *
 * NO Worker spawn — the `isMainThread` guard keeps the plain import inert (the
 * same shape every other worker fast-test uses; worker lifecycle is covered by
 * the daemon ALL_WORKERS pin + the full-tier integration test). The
 * keeper.db-backed `enrichPeerFromJobs` test uses a `freshMemDb` clone seeded by
 * direct `INSERT INTO jobs`.
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleWatchFrame,
  WATCH_BACKOFF_JITTER_RATIO,
  WATCH_BACKOFF_MIN_MS,
  WATCH_BACKOFF_RESET_AFTER_MS,
  WatchTerminalError,
  watchReconnectDecision,
} from "../cli/bus";
import { encodeBusArtifactRef, publishBusArtifact } from "../src/bus-artifact";
import {
  appendMessage,
  artifactRowExists,
  type ChannelRow,
  loadChannels,
  openBusDb,
  QUEUED_FOR_WAKE,
  replayFromCursor,
  upsertChannel,
} from "../src/bus-db";
import type { BusResolveResult, ResolvedIdentity } from "../src/bus-identity";
import {
  authoritativeFrom,
  backpressureDecision,
  CHANNEL_PRESENCE_HORIZON_MS,
  type ChannelLiveness,
  channelPruneDecision,
  cleanupBusArtifacts,
  closeOwnsBinding,
  createRetentionSingleFlight,
  duplicateRegistrationDecision,
  enrichPeerFromJobs,
  HARNESS_WALK_MAX_DEPTH,
  type JobIdentity,
  liveChannelsAtBoot,
  MAX_CLIENT_QUEUE,
  offlineSendPersist,
  payloadFromMessage,
  publishOutcome,
  type RegistryEntry,
  readBoundedPsOutput,
  registrationPresenceEffects,
  requeueTail,
  resolveHarnessIdentity,
  retireSocketlessChannel,
  selectFanoutTargets,
  sweepChannelRetention,
  takeoverVictim,
  toLiveChannel,
  validateChatPayload,
} from "../src/bus-worker";
import { drainMicrotasks, ManualScheduler } from "./helpers/retry-until";
import { freshMemDb } from "./helpers/template-db";

/** A no-op writable stand-in: a non-null `sock` so an entry counts as CONNECTED
 *  in the connected-only fan-out selection (the bytes are never inspected). */
const FAKE_SOCK = {
  write: () => 0,
  data: {},
} as unknown as RegistryEntry["sock"];

function makeChannel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channel_id: "ch-1",
    pid: 1000,
    start_time: "t1",
    session_id: "sess-1",
    current_name: "alpha",
    name_history: ["alpha"],
    namespaces: ["chat"],
    registered_at: 1,
    last_heartbeat: 1,
    ...overrides,
  };
}

function makeEntry(
  channelOverrides: Partial<ChannelRow> = {},
  entryOverrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  const channel = makeChannel(channelOverrides);
  return {
    channel,
    namespaces: channel.namespaces,
    connection: FAKE_SOCK,
    // Default to CONNECTED (a bound socket) so fan-out selection includes the
    // entry; a disconnected case overrides `sock: null`.
    sock: FAKE_SOCK,
    queue: [],
    generation: 1,
    ...entryOverrides,
  };
}

// ---------------------------------------------------------------------------
// authoritativeFrom — anti-spoof from-overwrite
// ---------------------------------------------------------------------------

test("authoritativeFrom stamps the PEER pid + resolved identity, ignoring any claim", () => {
  const from = authoritativeFrom("ch-42", 4242, {
    session_id: "sess-real",
    name: "real-name",
  });
  expect(from).toEqual({
    channel_id: "ch-42",
    pid: 4242,
    session_id: "sess-real",
    name: "real-name",
  });
});

// ---------------------------------------------------------------------------
// selectFanoutTargets — (namespace ∩ resolved-target) routing
// ---------------------------------------------------------------------------

test("directed send routes to the single resolved channel, excluding the sender", () => {
  const a = makeEntry({ channel_id: "ch-a", namespaces: ["chat"] });
  const b = makeEntry({ channel_id: "ch-b", namespaces: ["chat"] });
  const c = makeEntry({ channel_id: "ch-c", namespaces: ["chat"] });
  const targets = selectFanoutTargets([a, b, c], "chat", "ch-b", "ch-a");
  expect(targets.map((t) => t.channel.channel_id)).toEqual(["ch-b"]);
});

test("fan-out is namespace-scoped: a directed send only reaches a target subscribed to the namespace", () => {
  const chatter = makeEntry({ channel_id: "ch-chat", namespaces: ["chat"] });
  const pairer = makeEntry({ channel_id: "ch-pair", namespaces: ["pair"] });
  // A directed send to ch-chat in `chat` reaches it; the same channel id in the
  // `pair` namespace reaches no one — proving the core routes tenant-agnostically
  // (a future `pair` tenant rides the same path).
  const chat = selectFanoutTargets([chatter, pairer], "chat", "ch-chat", null);
  expect(chat.map((t) => t.channel.channel_id)).toEqual(["ch-chat"]);
  const pair = selectFanoutTargets([chatter, pairer], "pair", "ch-pair", null);
  expect(pair.map((t) => t.channel.channel_id)).toEqual(["ch-pair"]);
});

test("a directed send to a non-subscribed channel resolves to no targets", () => {
  const a = makeEntry({ channel_id: "ch-a", namespaces: ["chat"] });
  const b = makeEntry({ channel_id: "ch-b", namespaces: ["pair"] });
  // Target ch-b but in the `chat` namespace — b is not a chat subscriber.
  const targets = selectFanoutTargets([a, b], "chat", "ch-b", "ch-a");
  expect(targets).toEqual([]);
});

// ---------------------------------------------------------------------------
// backpressureDecision — bounded-queue eviction
// ---------------------------------------------------------------------------

test("a fully-accepted write is ok", () => {
  expect(backpressureDecision(100, 100, 0)).toBe("ok");
  expect(backpressureDecision(120, 100, 0)).toBe("ok");
});

test("a short write under the queue cap is queued, not evicted", () => {
  expect(backpressureDecision(50, 100, 0)).toBe("queue");
  expect(backpressureDecision(50, 100, MAX_CLIENT_QUEUE - 1)).toBe("queue");
});

test("a short write at/over the bounded queue cap evicts (never blocks the relay)", () => {
  expect(backpressureDecision(50, 100, MAX_CLIENT_QUEUE)).toBe("evict");
  expect(backpressureDecision(0, 100, MAX_CLIENT_QUEUE + 5)).toBe("evict");
});

// ---------------------------------------------------------------------------
// selectFanoutTargets — connected-only: a disconnected entry is never a target
// ---------------------------------------------------------------------------

test("fan-out excludes a known-but-disconnected channel (sock === null)", () => {
  const connected = makeEntry({ channel_id: "ch-on", namespaces: ["chat"] });
  const disconnected = makeEntry(
    { channel_id: "ch-off", namespaces: ["chat"] },
    { sock: null },
  );
  // A directed send to the disconnected channel resolves to no delivery target.
  expect(
    selectFanoutTargets([connected, disconnected], "chat", "ch-off", "ch-on"),
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// publishOutcome — the honest directed-send result vocabulary
// ---------------------------------------------------------------------------

test("publishOutcome maps resolution + delivered-count to the true result", () => {
  // Unknown / ambiguous resolution ignore the connected/count axes.
  expect(publishOutcome("unknown", false, 0)).toBe("unknown_target");
  expect(publishOutcome("ambiguous", false, 0)).toBe("ambiguous_target");
  // Resolved but no open socket → not_connected (identity resolved, no delivery).
  expect(publishOutcome("ok", false, 0)).toBe("not_connected");
  // Resolved + connected + at least one full-frame delivery → delivered.
  expect(publishOutcome("ok", true, 1)).toBe("delivered");
  // Resolved + connected but nothing got fully written (partial/evicted) →
  // delivery_failed (the false-negative the epic accepts without L2 receipts).
  expect(publishOutcome("ok", true, 0)).toBe("delivery_failed");
});

// ---------------------------------------------------------------------------
// closeOwnsBinding — the takeover late-close generation token
// ---------------------------------------------------------------------------

test("closeOwnsBinding: a connection only nulls the socket when it still owns the binding", () => {
  // The connection bound at the entry's current generation → its close owns it.
  expect(closeOwnsBinding(3, 3)).toBe(true);
  // A takeover re-subscribed and bumped the entry's generation; the victim's
  // late close carries the OLDER generation → it must NOT clobber the rebinding.
  expect(closeOwnsBinding(2, 3)).toBe(false);
});

// ---------------------------------------------------------------------------
// toLiveChannel — the presence axis (connected === has an open socket)
// ---------------------------------------------------------------------------

test("toLiveChannel surfaces connected presence from the bound socket", () => {
  const live = toLiveChannel(makeEntry({ channel_id: "ch-on" }));
  expect(live.connected).toBe(true);
  const dead = toLiveChannel(
    makeEntry({ channel_id: "ch-off" }, { sock: null }),
  );
  expect(dead.connected).toBe(false);
});

// ---------------------------------------------------------------------------
// takeoverVictim — duplicate-watcher / stale takeover on (pid, start_time)
// ---------------------------------------------------------------------------

test("takeoverVictim names the prior channel for the SAME (pid, start_time)", () => {
  const prior = makeEntry({
    channel_id: "ch-old",
    pid: 5000,
    start_time: "tA",
  });
  const victim = takeoverVictim([prior], 5000, "tA", "ch-new");
  expect(victim).toBe("ch-old");
});

test("pid reuse: same pid, DIFFERENT start_time is NOT a takeover (distinct agent)", () => {
  const prior = makeEntry({
    channel_id: "ch-old",
    pid: 5000,
    start_time: "tA",
  });
  // Same pid recycled by the OS, but a different process start → distinct agent.
  const victim = takeoverVictim([prior], 5000, "tB", "ch-new");
  expect(victim).toBeNull();
});

test("takeoverVictim ignores the new channel itself (no self-takeover)", () => {
  const self = makeEntry({
    channel_id: "ch-new",
    pid: 5000,
    start_time: "tA",
  });
  expect(takeoverVictim([self], 5000, "tA", "ch-new")).toBeNull();
});

test("duplicate registration rejects a live predecessor without disturbing it", () => {
  const prior = makeEntry({
    channel_id: "ch-live",
    pid: 5000,
    start_time: "tA",
  });
  expect(
    duplicateRegistrationDecision([prior], 5000, "tA", "ch-new", () => true),
  ).toEqual({ kind: "reject", code: "duplicate_subscriber" });
  expect(prior.channel.channel_id).toBe("ch-live");
});

test("duplicate registration evicts a dead predecessor and admits distinct identities", () => {
  const prior = makeEntry({
    channel_id: "ch-dead",
    pid: 5000,
    start_time: "tA",
  });
  expect(
    duplicateRegistrationDecision([prior], 5000, "tA", "ch-new", () => false),
  ).toEqual({ kind: "evict", victim: "ch-dead" });
  expect(
    duplicateRegistrationDecision([prior], 5000, "tB", "ch-new", () => true),
  ).toEqual({ kind: "admit" });
});

test("send-only registration bypasses duplicate presence handling", () => {
  const prior = makeEntry({ pid: 5000, start_time: "tA" });
  expect(
    duplicateRegistrationDecision(
      [prior],
      5000,
      "tA",
      "ch-send",
      () => true,
      true,
    ),
  ).toEqual({ kind: "admit" });
  expect(registrationPresenceEffects(true)).toEqual({
    joinRegistry: false,
    persistChannel: false,
    emitJoin: false,
    removeOnClose: false,
  });
  expect(registrationPresenceEffects(false)).toEqual({
    joinRegistry: true,
    persistChannel: true,
    emitJoin: true,
    removeOnClose: true,
  });
});

// ---------------------------------------------------------------------------
// watch client — terminal duplicate rejection and reconnect backoff
// ---------------------------------------------------------------------------

test("duplicate_subscriber is terminal and names the one-watcher contract", () => {
  const writes: string[] = [];
  const outcome = handleWatchFrame(
    {
      write(frame) {
        writes.push(frame);
        return frame.length;
      },
    },
    { type: "error", code: "duplicate_subscriber" },
    "/tmp/ignored",
  );
  expect(outcome).toBeInstanceOf(WatchTerminalError);
  expect(outcome?.message).toContain("one watcher per session");
  expect(writes).toEqual([]);
});

test("short watch sessions grow jittered reconnect backoff before reset", () => {
  const first = watchReconnectDecision(WATCH_BACKOFF_MIN_MS, 1, () => 0);
  const second = watchReconnectDecision(first.nextBackoffMs, 1, () => 1);
  expect(first.nextBackoffMs).toBe(WATCH_BACKOFF_MIN_MS * 2);
  expect(second.nextBackoffMs).toBe(WATCH_BACKOFF_MIN_MS * 4);
  expect(first.delayMs).toBe(
    Math.round(WATCH_BACKOFF_MIN_MS * (1 - WATCH_BACKOFF_JITTER_RATIO)),
  );
  expect(second.delayMs).toBe(
    Math.round(WATCH_BACKOFF_MIN_MS * 2 * (1 + WATCH_BACKOFF_JITTER_RATIO)),
  );
  const reset = watchReconnectDecision(
    second.nextBackoffMs,
    WATCH_BACKOFF_RESET_AFTER_MS,
    () => 0.5,
  );
  expect(reset.delayMs).toBe(WATCH_BACKOFF_MIN_MS);
  expect(reset.nextBackoffMs).toBe(WATCH_BACKOFF_MIN_MS * 2);
});

// ---------------------------------------------------------------------------
// liveChannelsAtBoot — dead-pid drop on registry-cache rehydrate
// ---------------------------------------------------------------------------

test("liveChannelsAtBoot keeps live-identity rows and drops dead / recycled ones", () => {
  const rows = [
    makeChannel({ channel_id: "ch-live", pid: 100, start_time: "st-100" }),
    makeChannel({ channel_id: "ch-dead", pid: 200, start_time: "st-200" }),
    makeChannel({
      channel_id: "ch-recycled",
      pid: 300,
      start_time: "st-300-old",
    }),
  ];
  // pid 100: alive AND start_time matches → kept. pid 200: no live process →
  // dropped. pid 300: pid alive but the live process's start_time differs (an
  // OS-recycled pid) → dropped, where a pid-only probe would have kept it.
  const isLiveIdentity = (pid: number, startTime: string): boolean => {
    if (pid === 100) return startTime === "st-100";
    if (pid === 300) return startTime === "st-300-new";
    return false;
  };
  const kept = liveChannelsAtBoot(rows, isLiveIdentity);
  expect(kept.map((r) => r.channel_id)).toEqual(["ch-live"]);
});

// ---------------------------------------------------------------------------
// channelPruneDecision — steady-state (pid, start_time) identity retention
// ---------------------------------------------------------------------------

const DEAD: ChannelLiveness = { alive: false };
const aliveWith = (startTime: string | null): ChannelLiveness => ({
  alive: true,
  startTime,
});

test("channelPruneDecision keeps a connected identity regardless of what the probe says", () => {
  // A live socket is authoritative — even a dead-looking probe cannot prune it.
  expect(
    channelPruneDecision(
      "st",
      10_000_000,
      1000,
      true,
      DEAD,
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
  // Protects a keeper-miss synthetic start_time a real OS probe would never match.
  expect(
    channelPruneDecision(
      "synthetic",
      10_000_000,
      1000,
      true,
      aliveWith("darwin:real"),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
  // A live socket survives even PAST the presence horizon — age alone never
  // reaps a connected identity.
  expect(
    channelPruneDecision(
      "st",
      CHANNEL_PRESENCE_HORIZON_MS + 1,
      1000,
      true,
      aliveWith(null),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
});

test("channelPruneDecision keeps a row younger than the grace age", () => {
  expect(
    channelPruneDecision(
      "st",
      500,
      1000,
      false,
      DEAD,
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
});

test("channelPruneDecision prunes a dead identity once past the grace age", () => {
  expect(
    channelPruneDecision(
      "st",
      2000,
      1000,
      false,
      DEAD,
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("prune");
});

test("channelPruneDecision keeps matching identity only inside the Presence horizon", () => {
  expect(
    channelPruneDecision(
      "darwin:x",
      2000,
      1000,
      false,
      aliveWith("darwin:x"),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
  expect(
    channelPruneDecision(
      "darwin:x",
      CHANNEL_PRESENCE_HORIZON_MS,
      1000,
      false,
      aliveWith("darwin:x"),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("prune");
});

test("channelPruneDecision prunes an alive-but-recycled pid (live start_time differs)", () => {
  expect(
    channelPruneDecision(
      "darwin:old",
      2000,
      1000,
      false,
      aliveWith("darwin:new"),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("prune");
});

test("channelPruneDecision keeps an unverifiable identity inside the presence horizon (never prune on a null read within the fail-safe window)", () => {
  expect(
    channelPruneDecision(
      "darwin:x",
      2000,
      1000,
      false,
      aliveWith(null),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
  // Still inside the horizon, well past the grace age.
  expect(
    channelPruneDecision(
      "darwin:x",
      CHANNEL_PRESENCE_HORIZON_MS - 1,
      1000,
      false,
      aliveWith(null),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("keep");
});

test("channelPruneDecision prunes a socketless unverifiable identity once past the presence horizon", () => {
  expect(
    channelPruneDecision(
      "darwin:x",
      CHANNEL_PRESENCE_HORIZON_MS,
      1000,
      false,
      aliveWith(null),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("prune");
  expect(
    channelPruneDecision(
      "darwin:x",
      CHANNEL_PRESENCE_HORIZON_MS + 1,
      1000,
      false,
      aliveWith(null),
      CHANNEL_PRESENCE_HORIZON_MS,
    ),
  ).toBe("prune");
});

test("channel retention advances beyond a connected head with bounded work", async () => {
  const db = openBusDb(":memory:");
  const connectedPids = new Set<number>();
  for (let i = 0; i < 70; i++) {
    const pid = 20_000 + i;
    connectedPids.add(pid);
    upsertChannel(
      db,
      makeChannel({
        channel_id: `ch-${String(i).padStart(3, "0")}`,
        pid,
        start_time: `live-${i}`,
        last_heartbeat: 0,
      }),
    );
  }
  for (let i = 70; i < 73; i++) {
    upsertChannel(
      db,
      makeChannel({
        channel_id: `ch-${i}`,
        pid: 20_000 + i,
        start_time: `stale-${i}`,
        last_heartbeat: 0,
      }),
    );
  }

  const state = { cursor: null };
  let processChecks = 0;
  const retired: string[] = [];
  for (let tick = 0; tick < 4; tick++) {
    const result = await sweepChannelRetention(
      db,
      10_000,
      state,
      {
        identityConnected: (pid) => connectedPids.has(pid),
        isPidAlive: () => {
          processChecks += 1;
          return true;
        },
        probeStartTime: async () => {
          processChecks += 1;
          return "matching";
        },
        retire: (row) => retired.push(row.channel_id),
      },
      {
        candidates: 64,
        probes: 1,
        deletes: 2,
        graceMs: 100,
        horizonMs: 1_000,
      },
    );
    expect(result.examined).toBeLessThanOrEqual(64);
    expect(result.probes).toBeLessThanOrEqual(1);
    expect(result.deleteAttempts).toBeLessThanOrEqual(2);
  }

  expect(processChecks).toBe(0);
  expect(retired.sort()).toEqual(["ch-70", "ch-71", "ch-72"]);
  expect(loadChannels(db)).toHaveLength(70);
  db.close();
});

test("channel retention freshness and live-socket fences win async probe races", async () => {
  const refreshedDb = openBusDb(":memory:");
  upsertChannel(
    refreshedDb,
    makeChannel({
      channel_id: "ch-refresh-old",
      pid: 300,
      start_time: "old-start",
      last_heartbeat: 1_000,
    }),
  );
  const refreshed = await sweepChannelRetention(
    refreshedDb,
    10_000,
    { cursor: null },
    {
      identityConnected: () => false,
      isPidAlive: () => true,
      probeStartTime: async () => {
        upsertChannel(
          refreshedDb,
          makeChannel({
            channel_id: "ch-refresh-new",
            pid: 300,
            start_time: "old-start",
            last_heartbeat: 9_500,
          }),
        );
        return "recycled-start";
      },
      retire: () => {
        throw new Error("fresh row must not retire");
      },
    },
    {
      candidates: 1,
      probes: 1,
      deletes: 1,
      graceMs: 100,
      horizonMs: 100_000,
    },
  );
  expect(refreshed.deleteAttempts).toBe(1);
  expect(refreshed.deleted).toBe(0);
  expect(loadChannels(refreshedDb)[0].channel_id).toBe("ch-refresh-new");
  refreshedDb.close();

  const subscribedDb = openBusDb(":memory:");
  upsertChannel(
    subscribedDb,
    makeChannel({
      channel_id: "ch-subscribe",
      pid: 400,
      start_time: "subscribe-start",
      last_heartbeat: 1_000,
    }),
  );
  let subscribed = false;
  const resubscribed = await sweepChannelRetention(
    subscribedDb,
    10_000,
    { cursor: null },
    {
      identityConnected: () => subscribed,
      isPidAlive: () => true,
      probeStartTime: async () => {
        subscribed = true;
        return "recycled-start";
      },
      retire: () => {
        throw new Error("subscribed row must not retire");
      },
    },
    {
      candidates: 1,
      probes: 1,
      deletes: 1,
      graceMs: 100,
      horizonMs: 100_000,
    },
  );
  expect(resubscribed.deleteAttempts).toBe(0);
  expect(resubscribed.deleted).toBe(0);
  expect(loadChannels(subscribedDb)).toHaveLength(1);
  subscribedDb.close();
});

test("retention probe timeouts release the single-flight pass for the next tick", async () => {
  const db = openBusDb(":memory:");
  upsertChannel(
    db,
    makeChannel({
      channel_id: "ch-never-probe",
      last_heartbeat: 0,
    }),
  );
  const timer = new ManualScheduler();
  const state = { cursor: null };
  let completedPasses = 0;
  let probes = 0;
  const runPass = async (): Promise<void> => {
    await sweepChannelRetention(
      db,
      10_000,
      state,
      {
        identityConnected: () => false,
        isPidAlive: () => true,
        probeStartTime: () => {
          probes += 1;
          return new Promise<string | null>(() => {});
        },
        retire: () => {
          throw new Error("timed-out probe must keep its row");
        },
        probeTimeoutMs: 1,
        probeTimer: timer,
      },
      {
        candidates: 1,
        probes: 1,
        deletes: 1,
        graceMs: 100,
        horizonMs: 100_000,
      },
    );
    completedPasses += 1;
  };
  const retention = createRetentionSingleFlight(runPass, (error) => {
    throw error;
  });

  retention.tick();
  await drainMicrotasks();
  expect(retention.active).toBe(true);
  await timer.advanceBy(1);
  expect(retention.active).toBe(false);
  expect(completedPasses).toBe(1);
  expect(loadChannels(db)).toHaveLength(1);

  retention.tick();
  await drainMicrotasks();
  expect(retention.active).toBe(true);
  await timer.advanceBy(1);
  expect(retention.active).toBe(false);
  expect(completedPasses).toBe(2);
  expect(probes).toBe(2);
  db.close();
});

test("bounded ps output kills an unresponsive probe and returns null", async () => {
  const timer = new ManualScheduler();
  let killed = 0;
  const output = readBoundedPsOutput(
    {
      readOutput: () => new Promise<string>(() => {}),
      exited: new Promise<never>(() => {}),
      kill: () => {
        killed += 1;
      },
    },
    1,
    timer,
  );

  await timer.advanceBy(1);
  expect(await output).toBeNull();
  expect(killed).toBe(1);
});

test("horizon reap closes and detaches a stale unsubscribed registration", async () => {
  const db = openBusDb(":memory:");
  const channel = makeChannel({
    channel_id: "ch-open-stale",
    pid: 500,
    start_time: "matching-live-process",
    last_heartbeat: 0,
  });
  upsertChannel(db, channel);

  let ended = 0;
  const connection = {
    write: () => 0,
    end: () => {
      ended += 1;
    },
    data: {},
  } as unknown as NonNullable<RegistryEntry["connection"]>;
  const entry = makeEntry(channel, { connection, sock: null });
  (connection.data as unknown as { entry: RegistryEntry }).entry = entry;
  const registry = new Map([[channel.channel_id, entry]]);
  let processChecks = 0;

  const result = await sweepChannelRetention(
    db,
    1_000,
    { cursor: null },
    {
      identityConnected: () => false,
      isPidAlive: () => {
        processChecks += 1;
        return true;
      },
      probeStartTime: async () => {
        processChecks += 1;
        return channel.start_time;
      },
      retire: (row) => {
        retireSocketlessChannel(registry, row);
      },
    },
    {
      candidates: 1,
      probes: 1,
      deletes: 1,
      graceMs: 100,
      horizonMs: 1_000,
    },
  );

  expect(result.deleted).toBe(1);
  expect(result.probes).toBe(0);
  expect(processChecks).toBe(0);
  expect(ended).toBe(1);
  expect(
    (connection.data as unknown as { entry: RegistryEntry | null }).entry,
  ).toBeNull();
  expect(registry.size).toBe(0);
  expect(loadChannels(db)).toHaveLength(0);
  db.close();
});

// ---------------------------------------------------------------------------
// enrichPeerFromJobs — read-only keeper.db jobs identity enrichment
// ---------------------------------------------------------------------------

function seedJob(
  db: Database,
  job: {
    job_id: string;
    pid?: number | null;
    start_time?: string | null;
    title?: string | null;
    name_history?: string[];
    updated_at?: number;
  },
): void {
  db.query(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, pid, start_time, title, name_history)
     VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?)`,
  ).run(
    job.job_id,
    1,
    job.updated_at ?? 1,
    job.pid ?? null,
    job.start_time ?? null,
    job.title ?? null,
    JSON.stringify(job.name_history ?? []),
  );
}

test("enrichPeerFromJobs maps a peer pid to its newest job identity", async () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 7777,
    start_time: "t1",
    title: "gamma",
    name_history: ["beta", "gamma"],
    updated_at: 10,
  });
  // Live probe matches the row's start_time → the same process that registered.
  const id = await enrichPeerFromJobs(db, 7777, () => "t1");
  expect(id).not.toBeNull();
  expect(id?.job_id).toBe("sess-1");
  expect(id?.title).toBe("gamma");
  expect(id?.name_history).toEqual(["beta", "gamma"]);
  db.close();
});

test("enrichPeerFromJobs prefers the NEWEST job for a reused pid", async () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "old",
    pid: 8888,
    start_time: "t1",
    title: "stale",
    updated_at: 5,
  });
  seedJob(db, {
    job_id: "new",
    pid: 8888,
    start_time: "t2",
    title: "fresh",
    updated_at: 50,
  });
  const id = await enrichPeerFromJobs(db, 8888, () => "t2");
  expect(id?.job_id).toBe("new");
  expect(id?.title).toBe("fresh");
  db.close();
});

test("enrichPeerFromJobs returns null on a keeper miss (resume-gap fallback path)", async () => {
  const { db } = freshMemDb();
  expect(await enrichPeerFromJobs(db, 9999, () => "t1")).toBeNull();
  db.close();
});

test("enrichPeerFromJobs returns null for a recycled pid whose live start_time differs from the stale dead row (anti-misattribution)", async () => {
  const { db } = freshMemDb();
  // A lingering dead `jobs` row from a former agent that held this pid; the OS
  // has since recycled the number to a new, unrelated process.
  seedJob(db, {
    job_id: "dead-agent",
    pid: 89510,
    start_time: "darwin:Sat Jun  7 12:00:00 2026",
    title: "fix-duplicate-approve-bug",
    updated_at: 10,
  });
  // Live probe returns the CURRENT process's start_time — a different boot.
  const id = await enrichPeerFromJobs(
    db,
    89510,
    () => "darwin:Mon Jun 23 09:00:00 2026",
  );
  expect(id).toBeNull();
  db.close();
});

test("enrichPeerFromJobs fails closed when the start_time probe is null/unreadable", async () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 7777,
    start_time: "t1",
    title: "gamma",
    updated_at: 10,
  });
  // Probe failure (ps timeout, gone pid) → cannot verify → drop the enrichment.
  expect(await enrichPeerFromJobs(db, 7777, () => null)).toBeNull();
  db.close();
});

test("enrichPeerFromJobs fails closed when the row itself has no start_time", async () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 7777,
    start_time: null,
    title: "gamma",
    updated_at: 10,
  });
  expect(await enrichPeerFromJobs(db, 7777, () => "t1")).toBeNull();
  db.close();
});

test("enrichPeerFromJobs awaits an ASYNC start_time probe (the off-loop serve-path shape)", async () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 7777,
    start_time: "t1",
    title: "gamma",
    updated_at: 10,
  });
  // The production default probe (startTimeViaPs) is async — awaiting a `ps`
  // spawn OFF the serve loop. A match still enriches; the recycle guard still
  // fires, just awaited rather than parking the kqueue loop.
  const match = await enrichPeerFromJobs(db, 7777, async () => "t1");
  expect(match?.job_id).toBe("sess-1");
  const recycled = await enrichPeerFromJobs(db, 7777, async () => "t2");
  expect(recycled).toBeNull();
  db.close();
});

test("enrichPeerFromJobs probes at most ONCE on a hit and NOT AT ALL on a miss or a null-start_time row", async () => {
  const { db } = freshMemDb();
  seedJob(db, { job_id: "hit", pid: 7777, start_time: "t1", updated_at: 10 });
  seedJob(db, {
    job_id: "legacy",
    pid: 6666,
    start_time: null,
    updated_at: 10,
  });
  let probes = 0;
  const probe = async (_pid: number): Promise<string | null> => {
    probes += 1;
    return "t1";
  };
  // keeper miss (no row) → fail closed, zero spawns on the common serve path.
  expect(await enrichPeerFromJobs(db, 5555, probe)).toBeNull();
  expect(probes).toBe(0);
  // null-start_time row → unverifiable, fail closed WITHOUT probing.
  expect(await enrichPeerFromJobs(db, 6666, probe)).toBeNull();
  expect(probes).toBe(0);
  // Genuine row hit with a stored start_time → exactly one probe.
  expect((await enrichPeerFromJobs(db, 7777, probe))?.job_id).toBe("hit");
  expect(probes).toBe(1);
  db.close();
});

// ---------------------------------------------------------------------------
// resolveHarnessIdentity — server-side ancestry walk to the nearest pid keeper
// tracks (the harness), rooted at the anti-spoof peer pid
// ---------------------------------------------------------------------------

function jobIdentity(over: Partial<JobIdentity> = {}): JobIdentity {
  return {
    job_id: "sess-1",
    pid: 5000,
    start_time: "t1",
    title: "alice",
    name_history: ["alice"],
    ...over,
  };
}

test("resolveHarnessIdentity climbs from the watcher peer pid to the nearest ancestor with a jobs row", async () => {
  // peer (watch subprocess) → zsh → claude harness. Only the harness has a job.
  const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
  const jobs: Record<number, JobIdentity> = {
    100: jobIdentity({ pid: 100, title: "harness" }),
  };
  const res = await resolveHarnessIdentity(
    300,
    (p) => parents[p] ?? null,
    (p) => jobs[p] ?? null,
  );
  expect(res).not.toBeNull();
  expect(res?.pid).toBe(100);
  expect(res?.identity.title).toBe("harness");
});

test("resolveHarnessIdentity prefers the NEAREST ancestor when multiple have jobs rows", async () => {
  // Both the peer and a grandparent have rows; the nearest (the peer itself) wins.
  const parents: Record<number, number> = { 300: 200, 200: 100 };
  const jobs: Record<number, JobIdentity> = {
    300: jobIdentity({ pid: 300, title: "near" }),
    100: jobIdentity({ pid: 100, title: "far" }),
  };
  const res = await resolveHarnessIdentity(
    300,
    (p) => parents[p] ?? null,
    (p) => jobs[p] ?? null,
  );
  expect(res?.pid).toBe(300);
  expect(res?.identity.title).toBe("near");
});

test("resolveHarnessIdentity returns null when no ancestor has a jobs row (resume gap)", async () => {
  const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
  const res = await resolveHarnessIdentity(
    300,
    (p) => parents[p] ?? null,
    () => null,
  );
  expect(res).toBeNull();
});

test("resolveHarnessIdentity terminates at pid 1 / a missing parent without looping", async () => {
  // getPpid returns null after the first hop — the walk must stop, not spin.
  let calls = 0;
  const res = await resolveHarnessIdentity(
    300,
    () => {
      calls++;
      return null;
    },
    () => null,
  );
  expect(res).toBeNull();
  expect(calls).toBe(1);
});

test("resolveHarnessIdentity stops at the depth bound on a pathological chain", async () => {
  // A chain longer than the bound with no jobs row: the walk caps at maxDepth
  // lookups and returns null rather than walking forever.
  let lookups = 0;
  const res = await resolveHarnessIdentity(
    1_000_000,
    (p) => p - 1, // strictly-decreasing parent, never null, all > 1
    () => {
      lookups++;
      return null;
    },
    HARNESS_WALK_MAX_DEPTH,
  );
  expect(res).toBeNull();
  expect(lookups).toBe(HARNESS_WALK_MAX_DEPTH);
});

test("resolveHarnessIdentity treats a self-parent as a terminal (no infinite loop)", async () => {
  // ps occasionally reports ppid == pid for an orphaned/init-adopted process.
  const res = await resolveHarnessIdentity(
    300,
    () => 300, // parent == pid
    () => null,
  );
  expect(res).toBeNull();
});

test("recycled-pid send/watch: a stale dead-agent row is skipped and the walk climbs to the TRUE parent agent", async () => {
  // The 4th send subprocess inherited pid 89510 — a number a dead agent's
  // lingering jobs row still holds. The TRUE sender is the parent harness (pid
  // 100, sitter-system-overview). The single opRegister path governs BOTH a send
  // (send_only:true) and a watch (send_only:false), so one guard fixes both:
  // assert the resolved chain for each registration form.
  const { db } = freshMemDb();
  // Dead agent's lingering row on the recycled pid (different boot start_time).
  seedJob(db, {
    job_id: "dead-agent",
    pid: 89510,
    start_time: "darwin:Sat Jun  7 12:00:00 2026",
    title: "fix-duplicate-approve-bug",
    updated_at: 10,
  });
  // The TRUE parent agent (the harness that actually issued the send).
  seedJob(db, {
    job_id: "sitter-sess",
    pid: 100,
    start_time: "darwin:Mon Jun 23 09:00:00 2026",
    title: "sitter-system-overview",
    updated_at: 50,
  });
  // peer (send/watch subprocess, pid 89510) → zsh (200) → harness (100).
  const parents: Record<number, number> = { 89510: 200, 200: 100, 100: 1 };
  // The live probe returns the CURRENT process start_time for whichever pid is
  // probed: pid 89510 is now a recycled, unrelated process (mismatch → skip);
  // pid 100 is the live sitter harness (match → enrich).
  const liveStartTime: Record<number, string> = {
    89510: "darwin:Mon Jun 23 11:00:00 2026", // recycled — NOT the dead boot
    100: "darwin:Mon Jun 23 09:00:00 2026", // the real sitter harness
  };
  const probe = (pid: number): string | null => liveStartTime[pid] ?? null;

  // The same enrichment lambda opRegister passes to resolveHarnessIdentity, for
  // both send_only:true and send_only:false (the flag never touches enrichment).
  for (const _form of ["send_only:true", "send_only:false"]) {
    const res = await resolveHarnessIdentity(
      89510,
      (p) => parents[p] ?? null,
      (p) => enrichPeerFromJobs(db, p, probe),
    );
    expect(res).not.toBeNull();
    expect(res?.pid).toBe(100);
    expect(res?.identity.job_id).toBe("sitter-sess");
    expect(res?.identity.title).toBe("sitter-system-overview");
    // Crucially NOT the dead agent the bare-pid match would have bound.
    expect(res?.identity.title).not.toBe("fix-duplicate-approve-bug");
  }
  db.close();
});

// The production `getPpid` (`ppidViaPs`) is async — it awaits a `ps` spawn off
// the serve loop. The walk must await each hop and thread a promise-returning
// probe correctly. These inject an ASYNC getPpid (no subprocess) to cover the
// seam the manual harness proves under real load.

test("resolveHarnessIdentity awaits an async getPpid and climbs to the nearest jobs row", async () => {
  const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
  const jobs: Record<number, JobIdentity> = {
    100: jobIdentity({ pid: 100, title: "harness" }),
  };
  const res = await resolveHarnessIdentity(
    300,
    async (p) => parents[p] ?? null,
    (p) => jobs[p] ?? null,
  );
  expect(res?.pid).toBe(100);
  expect(res?.identity.title).toBe("harness");
});

test("resolveHarnessIdentity walks async hops strictly in order, one at a time", async () => {
  // A single conn's walk is serial: the next hop is not probed until the prior
  // hop's promise resolves. Record the probe order and assert it climbs monotone.
  const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
  const probed: number[] = [];
  const res = await resolveHarnessIdentity(
    300,
    async (p) => {
      probed.push(p);
      await Promise.resolve();
      return parents[p] ?? null;
    },
    () => null,
  );
  expect(res).toBeNull();
  expect(probed).toEqual([300, 200, 100]);
});

test("resolveHarnessIdentity with an async probe still caps at the depth bound", async () => {
  let lookups = 0;
  const res = await resolveHarnessIdentity(
    1_000_000,
    async (p) => p - 1,
    () => {
      lookups++;
      return null;
    },
    HARNESS_WALK_MAX_DEPTH,
  );
  expect(res).toBeNull();
  expect(lookups).toBe(HARNESS_WALK_MAX_DEPTH);
});

// ---------------------------------------------------------------------------
// requeueTail — byte-tail re-flush across a multi-byte-UTF-8-splitting short
// write (regression: decoding the tail to a string minted U+FFFD, fn-876 F1)
// ---------------------------------------------------------------------------

test("requeueTail re-flushes a multi-byte UTF-8 body byte-identically across a write that splits a sequence", () => {
  // A body whose bytes include markdown, emoji, and non-Latin script — routine
  // bus traffic that a fixed-byte short write will split mid-sequence.
  const source = "héllo **wörld** 🚀 日本語 — café\n";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(source);

  // Drive the relay's partial-write loop against a fake socket that accepts a
  // fixed, sequence-splitting chunk per write. Each short write stashes a byte
  // tail via requeueTail (mirrors deliver/flushQueue); the wire is the
  // concatenation of every accepted chunk.
  const CHUNK = 7; // small + prime → lands mid multi-byte sequence repeatedly
  let frame: Uint8Array = bytes;
  const wire: number[] = [];
  // Bound the loop defensively; one byte minimum drains per iteration.
  for (let guard = 0; guard < bytes.length + 1 && frame.length > 0; guard++) {
    const accepted = Math.min(CHUNK, frame.length);
    for (let i = 0; i < accepted; i++) wire.push(frame[i]);
    frame = requeueTail(frame, accepted);
  }

  expect(frame.length).toBe(0);
  const delivered = new Uint8Array(wire);
  // Byte-identical on the wire …
  expect(Array.from(delivered)).toEqual(Array.from(bytes));
  // … and therefore decodes back to the exact source — no U+FFFD corruption.
  expect(new TextDecoder("utf-8", { fatal: true }).decode(delivered)).toBe(
    source,
  );
});

test("requeueTail returns an empty tail when the whole frame was accepted", () => {
  const bytes = new TextEncoder().encode("done\n");
  expect(requeueTail(bytes, bytes.length).length).toBe(0);
  // A spurious over-accept clamps to empty, never a negative-offset view.
  expect(requeueTail(bytes, bytes.length + 5).length).toBe(0);
});

// ---------------------------------------------------------------------------
// offlineSendPersist — the durable wake-on-send persist decision
// ---------------------------------------------------------------------------

/** An offline `ok` resolution: identity known, no live channel (creator off-bus). */
function okResolution(identity: ResolvedIdentity | null): BusResolveResult {
  return { kind: "ok", method: "jobs-exact", channel: null, identity };
}

function makeIdentity(jobId: string): ResolvedIdentity {
  return {
    job_id: jobId,
    pid: null,
    start_time: null,
    title: null,
    name_history: [],
  };
}

test("offlineSendPersist queues a planner@<epic> role send to a known offline creator", () => {
  const res = okResolution(makeIdentity("fn-1-creator-job"));
  const { resolvedSessionId, status } = offlineSendPersist(
    res,
    "planner@fn-1",
    "not_connected",
  );
  expect(resolvedSessionId).toBe("fn-1-creator-job");
  expect(status).toBe("queued_for_wake");
});

test("offlineSendPersist keeps a generic offline name send as not_connected (never queued)", () => {
  const res = okResolution(makeIdentity("bob-job"));
  const { resolvedSessionId, status } = offlineSendPersist(
    res,
    "bob",
    "not_connected",
  );
  // The resolved identity's job_id is still persisted as the recipient key …
  expect(resolvedSessionId).toBe("bob-job");
  // … but a non-role address is NOT turned into a durable queue.
  expect(status).toBe("not_connected");
});

test("offlineSendPersist never queues a role send whose creator identity is unknown", () => {
  // Keeper-miss live-fallback resolves identity:null → no durable recipient key.
  const res: BusResolveResult = {
    kind: "ok",
    method: "live-fallback",
    channel: null,
    identity: null,
  };
  const { resolvedSessionId, status } = offlineSendPersist(
    res,
    "planner@fn-9",
    "not_connected",
  );
  expect(resolvedSessionId).toBeNull();
  expect(status).toBe("not_connected");
});

test("reference payload validation rejects inline and malformed/missing references", () => {
  const base = mkdtempSync(join(tmpdir(), "bus-worker-ref-"));
  const root = join(base, "artifacts");
  try {
    expect(
      validateChatPayload({ media_type: "text/plain", text: "inline" }, root),
    ).toEqual({ ok: false, code: "inline_not_allowed" });
    expect(
      validateChatPayload(
        {
          media_type: "application/json",
          text: JSON.stringify({ t: "bus-artifact-ref", v: 1, id: "bad" }),
        },
        root,
      ),
    ).toEqual({ ok: false, code: "invalid_reference" });
    const published = publishBusArtifact(root, "héllo");
    expect(
      validateChatPayload(
        {
          media_type: "application/vnd.keeper.bus-ref+json",
          text: encodeBusArtifactRef(published.ref),
        },
        root,
      ),
    ).toEqual({ ok: true, ref: published.ref });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("queued replay reconstructs reference payload identity and retains legacy inline text", () => {
  const db = openBusDb(":memory:");
  const ref = {
    id: "4".repeat(32),
    len: 6,
    sha256: "5".repeat(64),
  };
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    artifact_ref: ref,
    payload_media_type: "application/vnd.keeper.bus-ref+json",
    status: QUEUED_FOR_WAKE,
  });
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    body: "legacy inline",
    status: QUEUED_FOR_WAKE,
  });
  const [reference, legacy] = replayFromCursor(db, 0);
  expect(payloadFromMessage(reference)).toEqual({
    media_type: "application/vnd.keeper.bus-ref+json",
    text: '{"t":"bus-artifact-ref","v":1,"id":"44444444444444444444444444444444","len":6,"sha256":"5555555555555555555555555555555555555555555555555555555555555555"}',
  });
  expect(payloadFromMessage(legacy)).toEqual({
    media_type: "text/plain",
    text: "legacy inline",
  });
  db.close();
});

test("artifact cleanup deletes rows first, is bounded, and retains on delete/check failure", () => {
  const db = openBusDb(":memory:");
  const id = "6".repeat(32);
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    ts: 1,
    artifact_ref: { id, len: 1, sha256: "7".repeat(64) },
  });
  const removed: string[] = [];
  let listedLimit = 0;
  const result = cleanupBusArtifacts(db, "/unused", 10_000, 5_000, 1, 100, 3, {
    referenced: artifactRowExists,
    remove(_root, candidate) {
      expect(artifactRowExists(db, candidate)).toBe(false);
      removed.push(candidate);
      return false;
    },
    list(_root, limit) {
      listedLimit = limit;
      return { ids: ["8".repeat(32)], complete: true };
    },
    mtime() {
      return 1;
    },
  });
  expect(result).toEqual({ rowArtifacts: 0, orphanArtifacts: 0 });
  expect(removed).toEqual([id, "8".repeat(32)]);
  expect(listedLimit).toBe(3);
  expect(replayFromCursor(db, 0)).toHaveLength(0);

  let deleteAttempted = false;
  cleanupBusArtifacts(db, "/unused", 10_000, 5_000, 1, 100, 2, {
    referenced() {
      throw new Error("database busy");
    },
    remove() {
      deleteAttempted = true;
      return true;
    },
    list() {
      return { ids: ["9".repeat(32)], complete: true };
    },
    mtime() {
      return 1;
    },
  });
  expect(deleteAttempted).toBe(false);
  db.close();
});

test("offlineSendPersist carries the honest miss outcome for unknown / ambiguous targets", () => {
  const unknown: BusResolveResult = { kind: "unknown", target: "ghost" };
  expect(offlineSendPersist(unknown, "ghost", "unknown_target")).toEqual({
    resolvedSessionId: null,
    status: "unknown_target",
  });
  const ambiguous: BusResolveResult = {
    kind: "ambiguous",
    method: "jobs-substring",
    identities: [makeIdentity("a"), makeIdentity("b")],
  };
  // Even a role-shaped ambiguous target is never queued (no single creator id).
  expect(
    offlineSendPersist(ambiguous, "planner@fn-2", "ambiguous_target"),
  ).toEqual({
    resolvedSessionId: null,
    status: "ambiguous_target",
  });
});
