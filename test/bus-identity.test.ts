/**
 * Pure in-process tests for `src/bus-identity.ts` — the Agent Bus two-layer name
 * resolver (epic fn-875), the keystone correctness surface. Exercises every
 * resolution path against a synthetic `jobs` table (seeded into a `freshMemDb`
 * keeper.db clone) plus an in-memory live-channel set:
 *
 *  - current-name + former-name (name_history) + pid + session_id exact hits
 *  - prefix (job_id) and substring (current title only) tiers
 *  - dead-name resolution (an OLD name maps to the same agent's CURRENT channel)
 *  - miss → fail-soft to the live registry (resume gap), else `unknown`
 *  - ambiguity → live-preferred, then surfaced
 *  - pid reuse (same pid, different start_time → distinct agents)
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type LiveChannel, resolveTarget } from "../src/bus-identity";
import { freshMemDb } from "./helpers/template-db";

interface JobSeed {
  job_id: string;
  pid?: number | null;
  start_time?: string | null;
  title?: string | null;
  name_history?: string[];
  updated_at?: number;
}

function seedJob(db: Database, job: JobSeed): void {
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

interface EpicSeed {
  epic_id: string;
  /** Raw JSON-TEXT for `job_links`. A string is stored verbatim (lets a test
   *  seed malformed JSON); an array is stringified. */
  job_links: { kind: string; job_id: string }[] | string;
}

function seedEpic(db: Database, epic: EpicSeed): void {
  const cell =
    typeof epic.job_links === "string"
      ? epic.job_links
      : JSON.stringify(epic.job_links);
  db.query(
    `INSERT INTO epics (epic_id, updated_at, job_links) VALUES (?, ?, ?)`,
  ).run(epic.epic_id, 1, cell);
}

function makeChannel(overrides: Partial<LiveChannel> = {}): LiveChannel {
  return {
    channel_id: "ch-1",
    pid: 1000,
    start_time: "t1",
    session_id: "sess-1",
    current_name: "alpha",
    name_history: ["alpha"],
    // Default to CONNECTED: most resolution tests assert delivery to a live
    // channel, which now requires an open socket. A disconnected case sets it.
    connected: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Layer 2 exact tier — current name, former name, pid, session_id
// ---------------------------------------------------------------------------

test("resolves a CURRENT name to its live channel (exact)", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 1000,
    start_time: "t1",
    title: "alpha",
    name_history: ["alpha"],
  });
  const channels = [
    makeChannel({ session_id: "sess-1", current_name: "alpha" }),
  ];
  const r = resolveTarget(channels, db, "alpha");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.method).toBe("jobs-exact");
    expect(r.channel?.channel_id).toBe("ch-1");
    expect(r.identity?.job_id).toBe("sess-1");
  }
  db.close();
});

test("dead-name resolution: a FORMER name maps to the agent's CURRENT live channel", () => {
  const { db } = freshMemDb();
  // The agent was once "alpha", now "alpha-prime" (append-only name_history).
  seedJob(db, {
    job_id: "sess-1",
    pid: 1000,
    start_time: "t1",
    title: "alpha-prime",
    name_history: ["alpha", "alpha-prime"],
  });
  const channels = [
    makeChannel({
      session_id: "sess-1",
      current_name: "alpha-prime",
      name_history: ["alpha", "alpha-prime"],
    }),
  ];
  // Reaching the DEAD name "alpha" still lands on the live channel.
  const r = resolveTarget(channels, db, "alpha");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.channel?.channel_id).toBe("ch-1");
    expect(r.identity?.title).toBe("alpha-prime");
  }
  db.close();
});

test("resolves by exact pid and by exact session_id (job_id)", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-7",
    pid: 4242,
    start_time: "t1",
    title: "gamma",
  });
  const channels = [
    makeChannel({ session_id: "sess-7", pid: 4242, current_name: "gamma" }),
  ];
  const byPid = resolveTarget(channels, db, "4242");
  expect(byPid.kind).toBe("ok");
  const bySession = resolveTarget(channels, db, "sess-7");
  expect(bySession.kind).toBe("ok");
  if (bySession.kind === "ok")
    expect(bySession.channel?.channel_id).toBe("ch-1");
  db.close();
});

test("name match is case-insensitive (current title + history)", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    title: "AlphaBeta",
    name_history: ["OldName"],
  });
  const channels = [makeChannel({ session_id: "sess-1" })];
  expect(resolveTarget(channels, db, "alphabeta").kind).toBe("ok");
  expect(resolveTarget(channels, db, "OLDNAME").kind).toBe("ok");
  db.close();
});

// ---------------------------------------------------------------------------
// prefix + substring tiers
// ---------------------------------------------------------------------------

test("prefix tier matches a job_id by leading characters", () => {
  const { db } = freshMemDb();
  seedJob(db, { job_id: "abcdef-1234", title: "delta" });
  const channels = [
    makeChannel({ session_id: "abcdef-1234", current_name: "delta" }),
  ];
  const r = resolveTarget(channels, db, "abcdef");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.method).toBe("jobs-prefix");
    expect(r.identity?.job_id).toBe("abcdef-1234");
  }
  db.close();
});

test("substring tier matches the CURRENT title only (history is exact-only)", () => {
  const { db } = freshMemDb();
  // "worker" is a substring of the CURRENT title → hit.
  seedJob(db, {
    job_id: "sess-1",
    title: "build-worker-9",
    name_history: ["build-worker-9"],
  });
  // A second agent has "worker" ONLY in an OLD name → must NOT substring-match.
  seedJob(db, {
    job_id: "sess-2",
    title: "renamed",
    name_history: ["old-worker-name", "renamed"],
  });
  const channels = [makeChannel({ session_id: "sess-1" })];
  const r = resolveTarget(channels, db, "worker");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.method).toBe("jobs-substring");
    expect(r.identity?.job_id).toBe("sess-1");
  }
  db.close();
});

// ---------------------------------------------------------------------------
// miss → fail-soft / unknown
// ---------------------------------------------------------------------------

test("a total miss with no live match returns unknown (never throws)", () => {
  const { db } = freshMemDb();
  seedJob(db, { job_id: "sess-1", title: "alpha" });
  const r = resolveTarget([], db, "nobody-here");
  expect(r.kind).toBe("unknown");
  if (r.kind === "unknown") expect(r.target).toBe("nobody-here");
  db.close();
});

test("resume gap: keeper miss fails soft to the live registry (register-frame name)", () => {
  const { db } = freshMemDb();
  // keeper.db has NOT yet folded this just-started agent — no jobs row.
  const channels = [
    makeChannel({
      channel_id: "ch-new",
      session_id: "sess-new",
      current_name: "fresh-agent",
      name_history: ["fresh-agent"],
    }),
  ];
  const r = resolveTarget(channels, db, "fresh-agent");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.method).toBe("live-fallback");
    expect(r.channel?.channel_id).toBe("ch-new");
    expect(r.identity).toBeNull();
  }
  db.close();
});

test("a known agent NOT currently on the bus resolves identity with a null channel", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    pid: 1000,
    start_time: "t1",
    title: "offline",
  });
  const r = resolveTarget([], db, "offline");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.identity?.job_id).toBe("sess-1");
    expect(r.channel).toBeNull();
  }
  db.close();
});

// ---------------------------------------------------------------------------
// ambiguity → live-preferred
// ---------------------------------------------------------------------------

test("ambiguity prefers the single LIVE channel among multiple jobs sharing a former name", () => {
  const { db } = freshMemDb();
  // Two agents both carried "common" in history; only one is live now.
  seedJob(db, {
    job_id: "sess-old",
    pid: 1,
    start_time: "t1",
    title: "renamed-old",
    name_history: ["common", "renamed-old"],
    updated_at: 1,
  });
  seedJob(db, {
    job_id: "sess-live",
    pid: 2,
    start_time: "t2",
    title: "renamed-live",
    name_history: ["common", "renamed-live"],
    updated_at: 9,
  });
  const channels = [
    makeChannel({
      channel_id: "ch-live",
      pid: 2,
      start_time: "t2",
      session_id: "sess-live",
    }),
  ];
  const r = resolveTarget(channels, db, "common");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.channel?.channel_id).toBe("ch-live");
    expect(r.identity?.job_id).toBe("sess-live");
  }
  db.close();
});

test("ambiguity with NO single live channel is surfaced (newest-first ordered)", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-a",
    title: "ra",
    name_history: ["common", "ra"],
    updated_at: 5,
  });
  seedJob(db, {
    job_id: "sess-b",
    title: "rb",
    name_history: ["common", "rb"],
    updated_at: 9,
  });
  const r = resolveTarget([], db, "common");
  expect(r.kind).toBe("ambiguous");
  if (r.kind === "ambiguous") {
    // Newest by updated_at leads the deterministic order.
    expect(r.identities[0].job_id).toBe("sess-b");
    expect(r.identities.map((i) => i.job_id).sort()).toEqual([
      "sess-a",
      "sess-b",
    ]);
  }
  db.close();
});

// ---------------------------------------------------------------------------
// pid reuse
// ---------------------------------------------------------------------------

test("pid reuse: same pid different start_time maps to the correct distinct agent", () => {
  const { db } = freshMemDb();
  // Old agent (now dead) and new agent share pid 1000 but differ on start_time.
  seedJob(db, {
    job_id: "sess-old",
    pid: 1000,
    start_time: "t-old",
    title: "ghost",
  });
  seedJob(db, {
    job_id: "sess-new",
    pid: 1000,
    start_time: "t-new",
    title: "current",
  });
  // The live channel is the NEW agent's (pid 1000, start_time t-new).
  const channels = [
    makeChannel({
      channel_id: "ch-new",
      pid: 1000,
      start_time: "t-new",
      session_id: "sess-new",
      current_name: "current",
    }),
  ];
  // Reaching the OLD name "ghost" resolves the OLD identity — which has no live
  // channel (its (pid, start_time) differs from the live one).
  const ghost = resolveTarget(channels, db, "ghost");
  expect(ghost.kind).toBe("ok");
  if (ghost.kind === "ok") {
    expect(ghost.identity?.job_id).toBe("sess-old");
    expect(ghost.channel).toBeNull();
  }
  // Reaching "current" resolves the NEW identity AND its live channel.
  const current = resolveTarget(channels, db, "current");
  expect(current.kind).toBe("ok");
  if (current.kind === "ok") {
    expect(current.identity?.job_id).toBe("sess-new");
    expect(current.channel?.channel_id).toBe("ch-new");
  }
  db.close();
});

// ---------------------------------------------------------------------------
// role addressing — planner@<epic_id> resolves the epic's creator session
// ---------------------------------------------------------------------------

test("planner@<epic> resolves the creator's live channel", () => {
  const { db } = freshMemDb();
  // The creator's job_id IS a session id — seed it as a jobs row + live channel.
  seedJob(db, {
    job_id: "sess-creator",
    pid: 1000,
    start_time: "t1",
    title: "planner-session",
  });
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [{ kind: "creator", job_id: "sess-creator" }],
  });
  const channels = [
    makeChannel({
      channel_id: "ch-creator",
      pid: 1000,
      start_time: "t1",
      session_id: "sess-creator",
    }),
  ];
  const r = resolveTarget(channels, db, "planner@fn-1-demo");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.channel?.channel_id).toBe("ch-creator");
    expect(r.identity?.job_id).toBe("sess-creator");
  }
  db.close();
});

test("planner@<epic> with the creator OFFLINE resolves identity, null channel (not_connected shape)", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-creator",
    pid: 1000,
    start_time: "t1",
    title: "planner-session",
  });
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [{ kind: "creator", job_id: "sess-creator" }],
  });
  // No live channel for the creator.
  const r = resolveTarget([], db, "planner@fn-1-demo");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.identity?.job_id).toBe("sess-creator");
    expect(r.channel).toBeNull();
  }
  db.close();
});

test("planner@<epic> with NO creator edge (refiner-only job_links) → unknown", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [{ kind: "refiner", job_id: "sess-refiner" }],
  });
  const r = resolveTarget([], db, "planner@fn-1-demo");
  expect(r.kind).toBe("unknown");
  if (r.kind === "unknown") expect(r.target).toBe("planner@fn-1-demo");
  db.close();
});

test("planner@<epic> with EMPTY job_links → unknown (just-scaffolded epic, fail-soft)", () => {
  const { db } = freshMemDb();
  seedEpic(db, { epic_id: "fn-1-demo", job_links: [] });
  const r = resolveTarget([], db, "planner@fn-1-demo");
  expect(r.kind).toBe("unknown");
  db.close();
});

test("planner@<unknown-epic> → unknown (epic id not in the projection)", () => {
  const { db } = freshMemDb();
  const r = resolveTarget([], db, "planner@fn-does-not-exist");
  expect(r.kind).toBe("unknown");
  if (r.kind === "unknown") expect(r.target).toBe("planner@fn-does-not-exist");
  db.close();
});

test("planner@<epic> with MALFORMED job_links JSON → unknown, does NOT throw", () => {
  const { db } = freshMemDb();
  seedEpic(db, { epic_id: "fn-1-demo", job_links: "{not valid json[" });
  const r = resolveTarget([], db, "planner@fn-1-demo");
  expect(r.kind).toBe("unknown");
  db.close();
});

test("planner@<epic> with TWO creators, one connected → clean-picks the live one", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-a",
    pid: 1,
    start_time: "ta",
    title: "creator-a",
  });
  seedJob(db, {
    job_id: "sess-b",
    pid: 2,
    start_time: "tb",
    title: "creator-b",
  });
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [
      { kind: "creator", job_id: "sess-a" },
      { kind: "creator", job_id: "sess-b" },
    ],
  });
  // Only sess-b is live.
  const channels = [
    makeChannel({
      channel_id: "ch-b",
      pid: 2,
      start_time: "tb",
      session_id: "sess-b",
      connected: true,
    }),
  ];
  const r = resolveTarget(channels, db, "planner@fn-1-demo");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.identity?.job_id).toBe("sess-b");
    expect(r.channel?.channel_id).toBe("ch-b");
  }
  db.close();
});

test("planner@<epic> with TWO creators, both connected → ambiguous", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-a",
    pid: 1,
    start_time: "ta",
    title: "creator-a",
  });
  seedJob(db, {
    job_id: "sess-b",
    pid: 2,
    start_time: "tb",
    title: "creator-b",
  });
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [
      { kind: "creator", job_id: "sess-a" },
      { kind: "creator", job_id: "sess-b" },
    ],
  });
  const channels = [
    makeChannel({
      channel_id: "ch-a",
      pid: 1,
      start_time: "ta",
      session_id: "sess-a",
      connected: true,
    }),
    makeChannel({
      channel_id: "ch-b",
      pid: 2,
      start_time: "tb",
      session_id: "sess-b",
      connected: true,
    }),
  ];
  const r = resolveTarget(channels, db, "planner@fn-1-demo");
  expect(r.kind).toBe("ambiguous");
  if (r.kind === "ambiguous") {
    expect(r.identities.map((i) => i.job_id).sort()).toEqual([
      "sess-a",
      "sess-b",
    ]);
  }
  db.close();
});

test("refiner@<epic> → unknown (recognized but unwired in this task)", () => {
  const { db } = freshMemDb();
  // Even WITH a resolvable refiner edge + live channel, refiner stays unknown.
  seedJob(db, { job_id: "sess-r", pid: 5, start_time: "tr", title: "ref" });
  seedEpic(db, {
    epic_id: "fn-1-demo",
    job_links: [{ kind: "refiner", job_id: "sess-r" }],
  });
  const channels = [
    makeChannel({
      channel_id: "ch-r",
      pid: 5,
      start_time: "tr",
      session_id: "sess-r",
    }),
  ];
  const r = resolveTarget(channels, db, "refiner@fn-1-demo");
  expect(r.kind).toBe("unknown");
  if (r.kind === "unknown") expect(r.target).toBe("refiner@fn-1-demo");
  db.close();
});

test("a TYPO role token (plannr@…) falls through to the name tiers", () => {
  const { db } = freshMemDb();
  // No role match → name tiers. With nothing named "plannr@fn-1-demo" → unknown,
  // proving it took the name-tier path (not the role branch's clean unknown,
  // which would carry the same kind — so assert it reached the tiers by also
  // checking a literal-@ name DOES resolve below).
  const r = resolveTarget([], db, "plannr@fn-1-demo");
  expect(r.kind).toBe("unknown");
  db.close();
});

test("a literal agent NAME containing @ (not a valid role) resolves via the name tiers", () => {
  const { db } = freshMemDb();
  // An agent literally named "build@host" — '@' present but not a role prefix.
  seedJob(db, {
    job_id: "sess-1",
    pid: 1000,
    start_time: "t1",
    title: "build@host",
    name_history: ["build@host"],
  });
  const channels = [
    makeChannel({ session_id: "sess-1", current_name: "build@host" }),
  ];
  const r = resolveTarget(channels, db, "build@host");
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    expect(r.method).toBe("jobs-exact");
    expect(r.identity?.job_id).toBe("sess-1");
  }
  db.close();
});
