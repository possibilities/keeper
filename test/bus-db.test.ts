/**
 * Pure in-process tests for `src/bus-db.ts` — the Agent Bus's OWN SQLite store
 * (epic fn-875). Covers the bus's independent `user_version` migrate ladder
 * (idempotent re-open, downgrade refusal), the `channels` registry-cache upsert
 * keyed on `(pid, start_time)` (pid-reuse safety), and the append-only `messages`
 * log's monotonic-cursor + replay-from-cursor contract.
 *
 * `openBusDb(":memory:")` runs the bus ladder against a private memory DB — no
 * sandbox env needed (the store never touches keeper.db or any prod path).
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BusArtifactRef } from "../src/bus-artifact";
import {
  appendMessage,
  BUS_SCHEMA_VERSION,
  type ChannelRow,
  DELIVERED_AFTER_WAKE,
  deleteChannel,
  loadChannels,
  loadOldestChannels,
  markMessageDelivered,
  maxMessageId,
  migrateBusDb,
  openBusDb,
  pruneControlMessagesOlderThan,
  pruneMessagesOlderThan,
  QUEUED_FOR_WAKE,
  replayFromCursor,
  selectQueuedForWake,
  upsertChannel,
} from "../src/bus-db";

function artifactRef(id = "a".repeat(32), body = "héllo"): BusArtifactRef {
  return {
    id,
    len: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

function makeChannel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channel_id: "ch-1",
    pid: 1000,
    start_time: "2026-06-21T00:00:00Z",
    session_id: "sess-1",
    current_name: "alpha",
    name_history: ["alpha"],
    namespaces: ["chat"],
    registered_at: 1,
    last_heartbeat: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migrate ladder
// ---------------------------------------------------------------------------

test("openBusDb stamps the bus user_version and creates both tables", () => {
  const db = openBusDb(":memory:");
  const ver = (
    db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;
  expect(ver).toBe(BUS_SCHEMA_VERSION);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  expect(tables).toContain("channels");
  expect(tables).toContain("messages");
  db.close();
});

test("migrateBusDb upgrades a v1 messages table without changing legacy rows", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, namespace TEXT NOT NULL,
    event TEXT NOT NULL, from_channel_id TEXT, from_pid INTEGER, from_name TEXT,
    to_target TEXT, resolved_channel_id TEXT, resolved_session_id TEXT, body TEXT,
    body_size INTEGER NOT NULL DEFAULT 0, status TEXT, reply_to INTEGER
  )`);
  db.run(
    "INSERT INTO messages (ts, namespace, event, body, body_size) VALUES (1, 'chat', 'send', 'legacy', 6)",
  );
  db.run("PRAGMA user_version = 1");
  migrateBusDb(db);
  const row = db.prepare("SELECT * FROM messages").get() as Record<
    string,
    unknown
  >;
  expect(row.body).toBe("legacy");
  expect(row.artifact_id).toBeNull();
  expect(row.delivered_at).toBeNull();
  expect(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  ).toBe(2);
  db.close();
});

test("migrateBusDb is idempotent across re-runs (no duplicate-column / table throw)", () => {
  const db = openBusDb(":memory:");
  expect(() => migrateBusDb(db)).not.toThrow();
  expect(() => migrateBusDb(db)).not.toThrow();
  const ver = (
    db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;
  expect(ver).toBe(BUS_SCHEMA_VERSION);
  db.close();
});

test("migrateBusDb refuses to downgrade a newer bus.db", () => {
  const db = new Database(":memory:");
  db.run(`PRAGMA user_version = ${BUS_SCHEMA_VERSION + 5}`);
  expect(() => migrateBusDb(db)).toThrow(/newer than this binary/);
  db.close();
});

test("bus.db migrate never calls keeper's openDb — keeper.db is untouched", () => {
  // A bus DB carries the bus user_version, NOT keeper's meta(schema_version).
  const db = openBusDb(":memory:");
  const metaExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
    )
    .get();
  expect(metaExists).toBeNull();
  db.close();
});

// ---------------------------------------------------------------------------
// channels — registry cache keyed on (pid, start_time)
// ---------------------------------------------------------------------------

test("upsertChannel inserts then updates in place on the same (pid, start_time)", () => {
  const db = openBusDb(":memory:");
  upsertChannel(db, makeChannel({ current_name: "alpha" }));
  upsertChannel(
    db,
    makeChannel({
      current_name: "alpha-renamed",
      name_history: ["alpha", "alpha-renamed"],
    }),
  );
  const all = loadChannels(db);
  expect(all).toHaveLength(1);
  expect(all[0].current_name).toBe("alpha-renamed");
  expect(all[0].name_history).toEqual(["alpha", "alpha-renamed"]);
  db.close();
});

test("pid reuse with a different start_time is a DISTINCT channel row", () => {
  const db = openBusDb(":memory:");
  upsertChannel(
    db,
    makeChannel({ channel_id: "ch-1", pid: 1000, start_time: "t1" }),
  );
  upsertChannel(
    db,
    makeChannel({ channel_id: "ch-2", pid: 1000, start_time: "t2" }),
  );
  const all = loadChannels(db);
  expect(all).toHaveLength(2);
  expect(new Set(all.map((c) => c.start_time))).toEqual(new Set(["t1", "t2"]));
  db.close();
});

test("loadChannels round-trips JSON-TEXT arrays and deleteChannel reaps by identity", () => {
  const db = openBusDb(":memory:");
  upsertChannel(
    db,
    makeChannel({
      name_history: ["a", "b", "c"],
      namespaces: ["chat", "pair"],
    }),
  );
  const [loaded] = loadChannels(db);
  expect(loaded.name_history).toEqual(["a", "b", "c"]);
  expect(loaded.namespaces).toEqual(["chat", "pair"]);
  deleteChannel(db, loaded.pid, loaded.start_time);
  expect(loadChannels(db)).toHaveLength(0);
  db.close();
});

// ---------------------------------------------------------------------------
// messages — append-only monotonic cursor + replay
// ---------------------------------------------------------------------------

test("appendMessage assigns a strictly increasing monotonic id cursor", () => {
  const db = openBusDb(":memory:");
  const id1 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "one",
  });
  const id2 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "two",
  });
  const id3 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "three",
  });
  expect(id2).toBeGreaterThan(id1);
  expect(id3).toBeGreaterThan(id2);
  expect(maxMessageId(db)).toBe(id3);
  db.close();
});

test("maxMessageId is 0 on an empty log", () => {
  const db = openBusDb(":memory:");
  expect(maxMessageId(db)).toBe(0);
  db.close();
});

test("appendMessage stores typed references without a body and uses declared byte size", () => {
  const db = openBusDb(":memory:");
  const ref = artifactRef();
  const id = appendMessage(db, {
    namespace: "chat",
    event: "send",
    artifact_ref: ref,
    payload_media_type: "application/vnd.keeper.bus-ref+json",
  });
  const raw = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as Record<string, unknown>;
  expect(raw.body).toBeNull();
  expect(raw.body_size).toBe(6);
  expect(raw.artifact_id).toBe("a".repeat(32));
  const [row] = replayFromCursor(db, 0);
  expect(row.artifact_ref).toEqual(ref);
  expect(row.payload_media_type).toBe("application/vnd.keeper.bus-ref+json");
  db.close();
});

test("appendMessage derives body_size from the UTF-8 byte length", () => {
  const db = openBusDb(":memory:");
  const id = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "héllo",
  });
  const row = db
    .prepare("SELECT body_size FROM messages WHERE id = ?")
    .get(id) as {
    body_size: number;
  };
  expect(row.body_size).toBe(Buffer.byteLength("héllo", "utf8"));
  db.close();
});

test("replayFromCursor returns only messages strictly after the cursor, oldest-first", () => {
  const db = openBusDb(":memory:");
  const id1 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "a",
  });
  const id2 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "b",
  });
  const id3 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "c",
  });
  const recovered = replayFromCursor(db, id1);
  expect(recovered.map((m) => m.id)).toEqual([id2, id3]);
  expect(recovered.map((m) => m.body)).toEqual(["b", "c"]);
  // Cursor at the head recovers nothing.
  expect(replayFromCursor(db, id3)).toHaveLength(0);
  db.close();
});

test("replayFromCursor narrows to one tenant namespace when given", () => {
  const db = openBusDb(":memory:");
  appendMessage(db, { namespace: "chat", event: "message", body: "chat-1" });
  appendMessage(db, { namespace: "pair", event: "message", body: "pair-1" });
  appendMessage(db, { namespace: "chat", event: "message", body: "chat-2" });
  const chatOnly = replayFromCursor(db, 0, "chat");
  expect(chatOnly.map((m) => m.body)).toEqual(["chat-1", "chat-2"]);
  const pairOnly = replayFromCursor(db, 0, "pair");
  expect(pairOnly.map((m) => m.body)).toEqual(["pair-1"]);
  db.close();
});

test("appendMessage persists the full forensic envelope including reply_to + namespace", () => {
  const db = openBusDb(":memory:");
  const root = appendMessage(db, {
    namespace: "chat",
    event: "message",
    from_channel_id: "ch-a",
    from_pid: 42,
    from_name: "alpha",
    to_target: "beta",
    resolved_channel_id: "ch-b",
    resolved_session_id: "sess-b",
    body: "hi",
    status: "delivered",
  });
  const reply = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "re: hi",
    reply_to: root,
  });
  const [m] = replayFromCursor(db, root);
  expect(m.id).toBe(reply);
  expect(m.reply_to).toBe(root);
  expect(m.namespace).toBe("chat");
  const rootRow = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(root) as Record<string, unknown>;
  expect(rootRow.from_name).toBe("alpha");
  expect(rootRow.resolved_session_id).toBe("sess-b");
  expect(rootRow.status).toBe("delivered");
  db.close();
});

// ---------------------------------------------------------------------------
// selectQueuedForWake — recipient-keyed durable wake-on-send replay
// ---------------------------------------------------------------------------

/** Append one `queued_for_wake` escalation addressed to a creator session. */
function queueForWake(
  db: Database,
  resolvedSessionId: string,
  overrides: Partial<Parameters<typeof appendMessage>[1]> = {},
): number {
  return appendMessage(db, {
    namespace: "chat",
    event: "send",
    to_target: "planner@fn-1",
    resolved_session_id: resolvedSessionId,
    body: "escalation",
    status: QUEUED_FOR_WAKE,
    ...overrides,
  });
}

test("selectQueuedForWake returns only the queued_for_wake rows for one session, oldest-first", () => {
  const db = openBusDb(":memory:");
  const a1 = queueForWake(db, "creator-a", { body: "first" });
  queueForWake(db, "creator-b", { body: "other recipient" });
  const a2 = queueForWake(db, "creator-a", { body: "second" });
  const rows = selectQueuedForWake(db, "creator-a");
  expect(rows.map((r) => r.id)).toEqual([a1, a2]);
  expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
  db.close();
});

test("selectQueuedForWake never leaks another recipient's rows", () => {
  const db = openBusDb(":memory:");
  queueForWake(db, "creator-a");
  queueForWake(db, "creator-b");
  expect(
    selectQueuedForWake(db, "creator-b").map((r) => r.resolved_session_id),
  ).toEqual(["creator-b"]);
  expect(selectQueuedForWake(db, "creator-c")).toHaveLength(0);
  db.close();
});

test("selectQueuedForWake excludes rows already flipped to delivered_after_wake (the dedup)", () => {
  const db = openBusDb(":memory:");
  const id = queueForWake(db, "creator-a");
  expect(selectQueuedForWake(db, "creator-a")).toHaveLength(1);
  db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(
    DELIVERED_AFTER_WAKE,
    id,
  );
  // A second subscribe re-queries and finds nothing — the flip is the dedup.
  expect(selectQueuedForWake(db, "creator-a")).toHaveLength(0);
  db.close();
});

test("selectQueuedForWake ignores non-send events and other statuses for the same session", () => {
  const db = openBusDb(":memory:");
  // A delivered live message + a non-`send` event to the same session id must
  // not appear (the value-filter pins `event = 'send'`).
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    resolved_session_id: "creator-a",
    body: "already delivered",
    status: "delivered",
  });
  appendMessage(db, {
    namespace: "chat",
    event: "other",
    resolved_session_id: "creator-a",
    body: "other event",
    status: QUEUED_FOR_WAKE,
  });
  const queued = queueForWake(db, "creator-a", { body: "the real one" });
  const rows = selectQueuedForWake(db, "creator-a");
  expect(rows.map((r) => r.id)).toEqual([queued]);
  db.close();
});

// ---------------------------------------------------------------------------
// Retention — age-horizon message prune + oldest-channel candidate window
// ---------------------------------------------------------------------------

function idsOf(db: ReturnType<typeof openBusDb>): number[] {
  return (
    db.prepare("SELECT id FROM messages ORDER BY id ASC").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

function idsOfNamespace(
  db: ReturnType<typeof openBusDb>,
  namespace: string,
): number[] {
  return (
    db
      .prepare("SELECT id FROM messages WHERE namespace = ? ORDER BY id ASC")
      .all(namespace) as { id: number }[]
  ).map((r) => r.id);
}

test("pruneMessagesOlderThan deletes rows older than the cutoff and keeps recent ones", () => {
  const db = openBusDb(":memory:");
  appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "old1",
    ts: 1000,
  });
  appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "old2",
    ts: 2000,
  });
  const recent = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "recent",
    ts: 9000,
  });
  expect(pruneMessagesOlderThan(db, 5000, 100)).toEqual([]);
  expect(idsOf(db)).toEqual([recent]);
  db.close();
});

test("pruneMessagesOlderThan preserves an undelivered queued_for_wake row regardless of age", () => {
  const db = openBusDb(":memory:");
  const qfw = appendMessage(db, {
    namespace: "chat",
    event: "send",
    resolved_session_id: "job-1",
    body: "escalation",
    ts: 100,
    status: QUEUED_FOR_WAKE,
  });
  appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "old",
    ts: 100,
  });
  // Both are far older than the cutoff, but only the plain row is pruned; the
  // undelivered wake queue survives unconditionally.
  expect(pruneMessagesOlderThan(db, 5000, 100)).toEqual([]);
  expect(idsOf(db)).toEqual([qfw]);
  db.close();
});

test("pruneMessagesOlderThan ages out a delivered_after_wake row (only the undelivered queue is immune)", () => {
  const db = openBusDb(":memory:");
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    resolved_session_id: "job-1",
    body: "already redelivered",
    ts: 100,
    status: DELIVERED_AFTER_WAKE,
  });
  expect(pruneMessagesOlderThan(db, 5000, 100)).toEqual([]);
  expect(idsOf(db)).toEqual([]);
  db.close();
});

test("pruneMessagesOlderThan honors the batch bound, draining oldest-first across calls", () => {
  const db = openBusDb(":memory:");
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(
      appendMessage(db, {
        namespace: "chat",
        event: "message",
        body: `m${i}`,
        ts: 1000 + i,
      }),
    );
  }
  // Everything is older than the cutoff; a batch of 2 removes the 2 oldest only.
  expect(pruneMessagesOlderThan(db, 100_000, 2)).toEqual([]);
  expect(idsOf(db)).toEqual(ids.slice(2));
  expect(pruneMessagesOlderThan(db, 100_000, 2)).toEqual([]);
  expect(idsOf(db)).toEqual(ids.slice(4));
  db.close();
});

test("pruneMessagesOlderThan is a no-op when nothing is older than the cutoff", () => {
  const db = openBusDb(":memory:");
  appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "recent",
    ts: 9000,
  });
  expect(pruneMessagesOlderThan(db, 5000, 100)).toEqual([]);
  expect(idsOf(db)).toHaveLength(1);
  db.close();
});

test("pruneControlMessagesOlderThan deletes only rows in the target namespace", () => {
  const db = openBusDb(":memory:");
  const controlOld1 = appendMessage(db, {
    namespace: "bus",
    event: "join",
    body: "control old 1",
    ts: 1000,
  });
  const chatOld1 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "chat old 1",
    ts: 1000,
  });
  const controlOld2 = appendMessage(db, {
    namespace: "bus",
    event: "takeover",
    body: "control old 2",
    ts: 1000,
  });
  const chatOld2 = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "chat old 2",
    ts: 1000,
  });
  const controlRecent = appendMessage(db, {
    namespace: "bus",
    event: "part",
    body: "control recent",
    ts: 9000,
  });

  expect(pruneControlMessagesOlderThan(db, "bus", 5000, 100)).toBe(2);
  expect(idsOfNamespace(db, "bus")).toEqual([controlRecent]);
  expect(idsOfNamespace(db, "chat")).toEqual([chatOld1, chatOld2]);
  expect(idsOf(db)).toEqual([chatOld1, chatOld2, controlRecent]);
  expect(idsOf(db)).not.toContain(controlOld1);
  expect(idsOf(db)).not.toContain(controlOld2);
  db.close();
});

test("pruneControlMessagesOlderThan preserves a queued_for_wake row regardless of age", () => {
  const db = openBusDb(":memory:");
  const qfw = appendMessage(db, {
    namespace: "bus",
    event: "send",
    resolved_session_id: "job-1",
    body: "control wake",
    ts: 100,
    status: QUEUED_FOR_WAKE,
  });
  appendMessage(db, {
    namespace: "bus",
    event: "join",
    body: "old control",
    ts: 100,
  });

  expect(pruneControlMessagesOlderThan(db, "bus", 5000, 100)).toBe(1);
  expect(idsOfNamespace(db, "bus")).toEqual([qfw]);
  db.close();
});

test("pruneControlMessagesOlderThan honors the batch bound across a large backlog", () => {
  const db = openBusDb(":memory:");
  const controlIds: number[] = [];
  const chatIds: number[] = [];
  for (let i = 0; i < 53; i++) {
    controlIds.push(
      appendMessage(db, {
        namespace: "bus",
        event: "takeover",
        body: `control ${i}`,
        ts: 1000 + i,
      }),
    );
    if (i % 10 === 0) {
      chatIds.push(
        appendMessage(db, {
          namespace: "chat",
          event: "message",
          body: `chat ${i}`,
          ts: 1000 + i,
        }),
      );
    }
  }

  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(10);
  expect(idsOfNamespace(db, "bus")).toEqual(controlIds.slice(10));
  expect(idsOfNamespace(db, "chat")).toEqual(chatIds);
  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(10);
  expect(idsOfNamespace(db, "bus")).toEqual(controlIds.slice(20));

  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(10);
  expect(idsOfNamespace(db, "bus")).toEqual(controlIds.slice(30));
  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(10);
  expect(idsOfNamespace(db, "bus")).toEqual(controlIds.slice(40));
  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(10);
  expect(idsOfNamespace(db, "bus")).toEqual(controlIds.slice(50));
  expect(pruneControlMessagesOlderThan(db, "bus", 100_000, 10)).toBe(3);
  expect(idsOfNamespace(db, "bus")).toEqual([]);
  expect(idsOfNamespace(db, "chat")).toEqual(chatIds);
  db.close();
});

test("pruneControlMessagesOlderThan is a no-op when nothing in the namespace is older than the cutoff", () => {
  const db = openBusDb(":memory:");
  const controlRecent = appendMessage(db, {
    namespace: "bus",
    event: "join",
    body: "recent control",
    ts: 9000,
  });
  const chatOld = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "old chat",
    ts: 100,
  });

  expect(pruneControlMessagesOlderThan(db, "bus", 5000, 100)).toBe(0);
  expect(idsOfNamespace(db, "bus")).toEqual([controlRecent]);
  expect(idsOfNamespace(db, "chat")).toEqual([chatOld]);
  expect(idsOf(db)).toEqual([controlRecent, chatOld]);
  db.close();
});

test("reference retention uses delivery time, preserves queued rows, and returns exact removable ids", () => {
  const db = openBusDb(":memory:");
  const oldDelivered = appendMessage(db, {
    namespace: "chat",
    event: "send",
    ts: 100,
    artifact_ref: artifactRef("1".repeat(32), "old"),
    status: "pending",
  });
  markMessageDelivered(db, oldDelivered, "delivered", 200);
  const newlyDelivered = appendMessage(db, {
    namespace: "chat",
    event: "send",
    ts: 100,
    artifact_ref: artifactRef("2".repeat(32), "new"),
    status: "pending",
  });
  markMessageDelivered(db, newlyDelivered, "delivered", 9_000);
  const queued = appendMessage(db, {
    namespace: "chat",
    event: "send",
    ts: 100,
    artifact_ref: artifactRef("3".repeat(32), "queue"),
    status: QUEUED_FOR_WAKE,
  });
  expect(pruneMessagesOlderThan(db, 5_000, 100)).toEqual(["1".repeat(32)]);
  expect(idsOf(db)).toEqual([newlyDelivered, queued]);
  db.close();
});

test("pruneMessagesOlderThan reaches aged rows behind an immune head that fills the batch window", () => {
  const db = openBusDb(":memory:");
  const BATCH = 8;
  // A head block of immune queued_for_wake rows at the LOWEST ids, exactly filling
  // the batch window — the total-wedge threshold where the old front-window scan
  // saw ONLY immune rows and pruned nothing.
  const immuneHead: number[] = [];
  for (let i = 0; i < BATCH; i++) {
    immuneHead.push(queueForWake(db, "creator-a", { ts: 100 }));
  }
  // Aged eligible rows sit BEHIND the immune head (higher ids).
  const aged: number[] = [];
  for (let i = 0; i < 3; i++) {
    aged.push(
      appendMessage(db, {
        namespace: "chat",
        event: "message",
        body: `a${i}`,
        ts: 100,
      }),
    );
  }
  // The through-immune scan skips the head and prunes the aged rows behind it.
  expect(pruneMessagesOlderThan(db, 5000, BATCH)).toEqual([]);
  expect(idsOf(db)).toEqual(immuneHead);
  // Every immune row survives and the wake-queue replay returns them in id order,
  // unchanged by the prune.
  expect(selectQueuedForWake(db, "creator-a").map((r) => r.id)).toEqual(
    immuneHead,
  );
  db.close();
});

test("pruneMessagesOlderThan counts the batch in ELIGIBLE rows, skipping interleaved immune rows", () => {
  const db = openBusDb(":memory:");
  // Interleave immune and aged-eligible rows so a front-window batch (2 immune +
  // 2 eligible) and an eligible-count batch (4 eligible) diverge.
  const eligible: number[] = [];
  for (let i = 0; i < 6; i++) {
    queueForWake(db, "creator-a", { ts: 100 });
    eligible.push(
      appendMessage(db, {
        namespace: "chat",
        event: "message",
        body: `e${i}`,
        ts: 100,
      }),
    );
  }
  // A batch of 4 deletes exactly 4 ELIGIBLE rows, never counting an immune row
  // against the bound.
  expect(pruneMessagesOlderThan(db, 5000, 4)).toEqual([]);
  const remaining = idsOf(db);
  // 6 immune survive + the 2 youngest eligible rows remain.
  expect(remaining).toHaveLength(8);
  expect(eligible.filter((id) => remaining.includes(id))).toEqual(
    eligible.slice(4),
  );
  expect(selectQueuedForWake(db, "creator-a")).toHaveLength(6);
  db.close();
});

test("pruneMessagesOlderThan retains an artifact shared with a surviving immune row", () => {
  const db = openBusDb(":memory:");
  const shared = artifactRef("f".repeat(32), "shared");
  // An immune queued_for_wake row holds the artifact...
  const immune = appendMessage(db, {
    namespace: "chat",
    event: "send",
    resolved_session_id: "creator-a",
    ts: 100,
    status: QUEUED_FOR_WAKE,
    artifact_ref: shared,
  });
  // ...and an aged eligible row references the SAME artifact id.
  appendMessage(db, {
    namespace: "chat",
    event: "send",
    ts: 100,
    status: "delivered",
    artifact_ref: shared,
  });
  // The eligible row is pruned, but its artifact is NOT returned — the surviving
  // immune row still references it, so the row-first GC never collects the file.
  expect(pruneMessagesOlderThan(db, 5000, 100)).toEqual([]);
  expect(idsOf(db)).toEqual([immune]);
  db.close();
});

test("pruneMessagesOlderThan leaves the maxMessageId fence unchanged when it prunes behind an immune head", () => {
  const db = openBusDb(":memory:");
  for (let i = 0; i < 5; i++) queueForWake(db, "creator-a", { ts: 100 });
  for (let i = 0; i < 5; i++) {
    appendMessage(db, {
      namespace: "chat",
      event: "message",
      body: `a${i}`,
      ts: 100,
    });
  }
  // The newest row is within the horizon, so it holds the max-id subscribe-ack fence.
  const recent = appendMessage(db, {
    namespace: "chat",
    event: "message",
    body: "recent",
    ts: 9000,
  });
  expect(maxMessageId(db)).toBe(recent);
  // Pruning the aged tail behind the immune head must not move the fence.
  pruneMessagesOlderThan(db, 5000, 100);
  expect(maxMessageId(db)).toBe(recent);
  db.close();
});

test("the retention scan is served by the partial index, and no schema bump lands", () => {
  const db = openBusDb(":memory:");
  // The partial index landed in the unconditional create-if-missing block...
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_prune'",
      )
      .get(),
  ).not.toBeNull();
  // ...WITHOUT bumping the bus schema version.
  expect(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  ).toBe(BUS_SCHEMA_VERSION);
  expect(BUS_SCHEMA_VERSION).toBe(2);
  // The installed SQLite honors the partial-index predicate: the eligible-row scan
  // walks idx_messages_prune, so per-tick cost is bounded by the batch, never by
  // the immune-prefix length. `IS NOT '<literal>'` matches the index predicate
  // verbatim (a bound parameter would not), which is what lets the planner use it.
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
         SELECT id, artifact_id FROM messages
         WHERE status IS NOT '${QUEUED_FOR_WAKE}' AND COALESCE(delivered_at, ts) < ?
         ORDER BY id ASC LIMIT ?`,
    )
    .all(5000, 100) as { detail: string }[];
  expect(plan.some((r) => r.detail.includes("idx_messages_prune"))).toBe(true);
  db.close();
});

test("pruneControlMessagesOlderThan counts eligible rows and reaches aged rows behind an immune head", () => {
  const db = openBusDb(":memory:");
  // Defense in depth: control rows are never immune in production, but the shared
  // eligible-row shape must still skip a queued_for_wake head rather than park.
  const immune: number[] = [];
  for (let i = 0; i < 4; i++) {
    immune.push(
      appendMessage(db, {
        namespace: "bus",
        event: "send",
        resolved_session_id: "job-1",
        body: `wake${i}`,
        ts: 100,
        status: QUEUED_FOR_WAKE,
      }),
    );
  }
  const aged: number[] = [];
  for (let i = 0; i < 3; i++) {
    aged.push(
      appendMessage(db, {
        namespace: "bus",
        event: "join",
        body: `j${i}`,
        ts: 100,
      }),
    );
  }
  // Batch smaller than the immune head: the eligible-count batch prunes 2 aged
  // rows, never counting or deleting an immune row.
  expect(pruneControlMessagesOlderThan(db, "bus", 5000, 2)).toBe(2);
  expect(idsOfNamespace(db, "bus")).toEqual([...immune, aged[2]]);
  db.close();
});

test("loadOldestChannels returns the oldest channels by last_heartbeat, bounded by the limit", () => {
  const db = openBusDb(":memory:");
  upsertChannel(
    db,
    makeChannel({
      channel_id: "ch-newest",
      pid: 1,
      start_time: "s1",
      last_heartbeat: 300,
    }),
  );
  upsertChannel(
    db,
    makeChannel({
      channel_id: "ch-oldest",
      pid: 2,
      start_time: "s2",
      last_heartbeat: 100,
    }),
  );
  upsertChannel(
    db,
    makeChannel({
      channel_id: "ch-mid",
      pid: 3,
      start_time: "s3",
      last_heartbeat: 200,
    }),
  );
  expect(loadOldestChannels(db, 2).map((c) => c.channel_id)).toEqual([
    "ch-oldest",
    "ch-mid",
  ]);
  db.close();
});
