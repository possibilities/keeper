/**
 * Fast-tier pure-decision tests for `src/bus-worker.ts` (epic fn-875 task .2).
 *
 * Exercises the worker's PURE decision symbols — `authoritativeFrom` (anti-spoof
 * from-overwrite), `selectFanoutTargets` (namespace ∩ resolved-target routing),
 * `backpressureDecision` (bounded-queue eviction), `reapDecision` (monotonic
 * two-threshold liveness), `takeoverVictim` (duplicate-watcher/takeover on the
 * stable `(pid, start_time)` key), `liveChannelsAtBoot` (dead-pid drop), and
 * `enrichPeerFromJobs` (read-only keeper.db identity enrichment).
 *
 * NO Worker spawn — the `isMainThread` guard keeps the plain import inert (the
 * same shape every other worker fast-test uses; worker lifecycle is covered by
 * the daemon ALL_WORKERS pin + the full-tier integration test). The
 * keeper.db-backed `enrichPeerFromJobs` test uses a `freshMemDb` clone seeded by
 * direct `INSERT INTO jobs`.
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChannelRow } from "../src/bus-db";
import {
  authoritativeFrom,
  backpressureDecision,
  enrichPeerFromJobs,
  HEARTBEAT_EVICT_MS,
  HEARTBEAT_WARN_MS,
  liveChannelsAtBoot,
  MAX_CLIENT_QUEUE,
  type RegistryEntry,
  reapDecision,
  selectFanoutTargets,
  takeoverVictim,
} from "../src/bus-worker";
import { freshMemDb } from "./helpers/template-db";

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
    sock: null,
    queue: [],
    lastBeatMono: 0,
    warned: false,
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

test("broadcast (null target) reaches every namespace subscriber except the sender", () => {
  const a = makeEntry({ channel_id: "ch-a", namespaces: ["chat"] });
  const b = makeEntry({ channel_id: "ch-b", namespaces: ["chat"] });
  const c = makeEntry({ channel_id: "ch-c", namespaces: ["chat"] });
  const targets = selectFanoutTargets([a, b, c], "chat", null, "ch-a");
  expect(targets.map((t) => t.channel.channel_id).sort()).toEqual([
    "ch-b",
    "ch-c",
  ]);
});

test("fan-out is namespace-scoped: a channel not subscribed to the namespace is skipped", () => {
  const chatter = makeEntry({ channel_id: "ch-chat", namespaces: ["chat"] });
  const pairer = makeEntry({ channel_id: "ch-pair", namespaces: ["pair"] });
  // A broadcast in `chat` reaches the chat subscriber only — proving the core
  // routes tenant-agnostically (a future `pair` tenant rides the same path).
  const chat = selectFanoutTargets([chatter, pairer], "chat", null, null);
  expect(chat.map((t) => t.channel.channel_id)).toEqual(["ch-chat"]);
  const pair = selectFanoutTargets([chatter, pairer], "pair", null, null);
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
// reapDecision — monotonic two-threshold liveness
// ---------------------------------------------------------------------------

test("reapDecision: a fresh heartbeat is live; the two thresholds fire in order", () => {
  expect(reapDecision(1000, 1000)).toBe("live");
  expect(reapDecision(1000 + HEARTBEAT_WARN_MS - 1, 1000)).toBe("live");
  expect(reapDecision(1000 + HEARTBEAT_WARN_MS, 1000)).toBe("warn");
  expect(reapDecision(1000 + HEARTBEAT_EVICT_MS - 1, 1000)).toBe("warn");
  expect(reapDecision(1000 + HEARTBEAT_EVICT_MS, 1000)).toBe("evict");
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

// ---------------------------------------------------------------------------
// liveChannelsAtBoot — dead-pid drop on registry-cache rehydrate
// ---------------------------------------------------------------------------

test("liveChannelsAtBoot drops dead-pid rows and keeps live ones", () => {
  const rows = [
    makeChannel({ channel_id: "ch-live", pid: 100 }),
    makeChannel({ channel_id: "ch-dead", pid: 200 }),
  ];
  const kept = liveChannelsAtBoot(rows, (pid) => pid === 100);
  expect(kept.map((r) => r.channel_id)).toEqual(["ch-live"]);
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

test("enrichPeerFromJobs maps a peer pid to its newest job identity", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 7777,
    start_time: "t1",
    title: "gamma",
    name_history: ["beta", "gamma"],
    updated_at: 10,
  });
  const id = enrichPeerFromJobs(db, 7777);
  expect(id).not.toBeNull();
  expect(id?.job_id).toBe("sess-1");
  expect(id?.title).toBe("gamma");
  expect(id?.name_history).toEqual(["beta", "gamma"]);
  db.close();
});

test("enrichPeerFromJobs prefers the NEWEST job for a reused pid", () => {
  const { db } = freshMemDb();
  seedJob(db, { job_id: "old", pid: 8888, title: "stale", updated_at: 5 });
  seedJob(db, { job_id: "new", pid: 8888, title: "fresh", updated_at: 50 });
  const id = enrichPeerFromJobs(db, 8888);
  expect(id?.job_id).toBe("new");
  expect(id?.title).toBe("fresh");
  db.close();
});

test("enrichPeerFromJobs returns null on a keeper miss (resume-gap fallback path)", () => {
  const { db } = freshMemDb();
  expect(enrichPeerFromJobs(db, 9999)).toBeNull();
  db.close();
});
