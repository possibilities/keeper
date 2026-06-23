/**
 * Builds-worker tests — DETERMINISM unit tests against the PURE core (no Worker,
 * no network):
 *
 * (a) Response parsers: `parseBuilders` (ghost filter, name guard, shape
 *     tolerance) and `parseLatestBuild` (running vs finished, never-built →
 *     null, malformed → null).
 * (b) Change-gate: `BuildsScanner.applySnapshot` dedupes unchanged builds; a
 *     running→finished transition emits exactly two messages (start, finish);
 *     `state_string`-only churn is suppressed (the gate-exclusion tripwire).
 * (c) Disappearance diff: `reconcileEnumeration` tombstones a previously-seen
 *     builder absent from a fresh successful enumeration, and ONLY then.
 * (d) `runPollCycle` end-to-end with a stubbed fetcher: failed enumeration is a
 *     no-op (no emit, no tombstone, gate preserved); a per-builder fetch failure
 *     skips that builder without tombstoning it.
 * (e) `seedFromDb` round-trip: a seeded projection row suppresses its re-emit
 *     (slot-order discipline — the seed key must match the live gate key).
 */

import { expect, test } from "bun:test";
import {
  type BuildSnapshotMessage,
  type BuildsMessage,
  BuildsScanner,
  buildsGateKey,
  NEVER_BUILT_STATE,
  parseBuilders,
  parseLatestBuild,
  runPollCycle,
  seedFromDb,
} from "../src/builds-worker";
import { serializeBuildSnapshot } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

/** A finished-build snapshot message for `project`, overridable per field. */
function finished(
  project: string,
  overrides: Partial<BuildSnapshotMessage> = {},
): BuildSnapshotMessage {
  return {
    kind: "build-snapshot",
    project,
    builder_id: 1,
    build_number: 42,
    complete: 1,
    results: 0,
    state_string: "build successful",
    started_at: 1000,
    complete_at: 1100,
    ...overrides,
  };
}

/** An all-null `never built` placeholder message for `project`. */
function neverBuilt(
  project: string,
  builderId: number | null = 1,
): BuildSnapshotMessage {
  return {
    kind: "build-snapshot",
    project,
    builder_id: builderId,
    build_number: null,
    complete: null,
    results: null,
    state_string: NEVER_BUILT_STATE,
    started_at: null,
    complete_at: null,
  };
}

// ── (a) parseBuilders ──────────────────────────────────────────────────────

test("parseBuilders keeps registered builders and filters ghosts (empty masterids)", () => {
  const body = {
    builders: [
      { builderid: 1, name: "alpha", masterids: [1] },
      { builderid: 2, name: "ghost", masterids: [] },
      { builderid: 3, name: "no-masters" }, // absent masterids → ghost
      { builderid: 4, name: "beta", masterids: [1, 2] },
    ],
  };
  expect(parseBuilders(body)).toEqual([
    { name: "alpha", builderid: 1 },
    { name: "beta", builderid: 4 },
  ]);
});

test("parseBuilders drops nameless entries and tolerates a malformed body", () => {
  expect(
    parseBuilders({ builders: [{ builderid: 1, masterids: [1] }] }),
  ).toEqual([]);
  expect(parseBuilders({ builders: "nope" })).toEqual([]);
  expect(parseBuilders(null)).toEqual([]);
  expect(parseBuilders({})).toEqual([]);
});

// ── (a) parseLatestBuild ───────────────────────────────────────────────────

test("parseLatestBuild reports a finished build", () => {
  const body = {
    builds: [
      {
        number: 42,
        complete: true,
        results: 2,
        state_string: "failed compile",
        started_at: 1000,
        complete_at: 1100,
      },
    ],
  };
  expect(parseLatestBuild("alpha", 1, body)).toEqual({
    kind: "build-snapshot",
    project: "alpha",
    builder_id: 1,
    build_number: 42,
    complete: 1,
    results: 2,
    state_string: "failed compile",
    started_at: 1000,
    complete_at: 1100,
  });
});

test("parseLatestBuild reports a running build (complete:false, results:null)", () => {
  const body = {
    builds: [
      {
        number: 43,
        complete: false,
        results: null,
        state_string: "building",
        started_at: 2000,
        complete_at: null,
      },
    ],
  };
  const msg = parseLatestBuild("alpha", 1, body);
  expect(msg?.complete).toBe(0);
  expect(msg?.results).toBeNull();
  expect(msg?.complete_at).toBeNull();
  expect(msg?.state_string).toBe("building");
});

test("parseLatestBuild mints an all-null `never built` placeholder for a parsed empty array", () => {
  // The ONLY null-producing shape promoted to a placeholder: HTTP 200 +
  // `{"builds":[]}` (a registered builder that has never produced a build).
  expect(parseLatestBuild("alpha", 7, { builds: [] })).toEqual({
    kind: "build-snapshot",
    project: "alpha",
    builder_id: 7,
    build_number: null,
    complete: null,
    results: null,
    state_string: NEVER_BUILT_STATE,
    started_at: null,
    complete_at: null,
  });
});

test("parseLatestBuild returns null for malformed bodies — never a placeholder (conflation hazard)", () => {
  // Every shape EXCEPT a parsed empty array stays null: a placeholder minted
  // from `{}` / a missing-array / an array-of-non-objects would spawn phantom
  // rows or flap pending↔real.
  expect(parseLatestBuild("alpha", 1, {})).toBeNull();
  expect(parseLatestBuild("alpha", 1, null)).toBeNull();
  expect(parseLatestBuild("alpha", 1, { builds: "nope" })).toBeNull();
  expect(parseLatestBuild("alpha", 1, { builds: ["nope"] })).toBeNull();
});

// ── (b) change-gate ────────────────────────────────────────────────────────

test("applySnapshot suppresses an unchanged build (zero events between polls)", () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  s.applySnapshot(finished("alpha"));
  s.applySnapshot(finished("alpha")); // identical → suppressed
  s.applySnapshot(finished("alpha"));
  expect(out).toHaveLength(1);
});

test("a never-built placeholder emits exactly once and dedupes on repeat polls", () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  // Repeated never-built polls (gate key excludes state_string + builder_id,
  // so the all-null placeholder is stable) → emitted once.
  s.applySnapshot(neverBuilt("alpha"));
  s.applySnapshot(neverBuilt("alpha"));
  s.applySnapshot(neverBuilt("alpha"));
  expect(out).toEqual([neverBuilt("alpha")]);
  // When the builder later runs, build_number moves → the real snapshot
  // supersedes the placeholder (a second event).
  s.applySnapshot(finished("alpha", { build_number: 1 }));
  expect(out).toHaveLength(2);
  expect((out[1] as BuildSnapshotMessage).build_number).toBe(1);
});

test("a build emits exactly two events: start (running) then finish", () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  // Start: running build.
  s.applySnapshot(
    finished("alpha", {
      build_number: 50,
      complete: 0,
      results: null,
      state_string: "starting",
      complete_at: null,
    }),
  );
  // Intermediate progress line — same gate identity (only state_string moved).
  s.applySnapshot(
    finished("alpha", {
      build_number: 50,
      complete: 0,
      results: null,
      state_string: "compiling",
      complete_at: null,
    }),
  );
  // Finish.
  s.applySnapshot(
    finished("alpha", {
      build_number: 50,
      complete: 1,
      results: 0,
      state_string: "build successful",
      complete_at: 1200,
    }),
  );
  expect(out).toHaveLength(2);
  expect((out[0] as BuildSnapshotMessage).complete).toBe(0);
  expect((out[1] as BuildSnapshotMessage).complete).toBe(1);
});

test("buildsGateKey excludes state_string and builder_id from gate identity", () => {
  const a = finished("alpha", { state_string: "X", builder_id: 1 });
  const b = finished("alpha", { state_string: "Y", builder_id: 99 });
  expect(buildsGateKey(a)).toBe(buildsGateKey(b));
  // A real build-identity change (the number moved) DOES change the key.
  const c = finished("alpha", { build_number: 43 });
  expect(buildsGateKey(a)).not.toBe(buildsGateKey(c));
});

// ── (c) disappearance diff ─────────────────────────────────────────────────

test("reconcileEnumeration tombstones a seen builder absent from a fresh enumeration", () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  s.applySnapshot(finished("alpha"));
  s.applySnapshot(finished("beta"));
  out.length = 0;
  // beta gone, alpha stays, gamma is new (no row yet → nothing to tombstone).
  s.reconcileEnumeration(["alpha", "gamma"]);
  expect(out).toEqual([{ kind: "build-deleted", project: "beta" }]);
});

test("a re-created builder re-emits after tombstone (gate dropped on delete)", () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  s.applySnapshot(finished("alpha"));
  s.reconcileEnumeration([]); // alpha disappears → tombstone, gate dropped
  out.length = 0;
  s.applySnapshot(finished("alpha")); // back → re-emits (no stale gate)
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("build-snapshot");
});

// ── (d) runPollCycle with a stubbed fetcher ────────────────────────────────

const BASE = "http://localhost:8010";

function buildersResponse(names: string[]): unknown {
  return {
    builders: names.map((name, i) => ({
      builderid: i + 1,
      name,
      masterids: [1],
    })),
  };
}

function buildsResponse(number: number, complete: boolean): unknown {
  return {
    builds: [
      {
        number,
        complete,
        results: complete ? 0 : null,
        state_string: complete ? "build successful" : "building",
        started_at: 1000,
        complete_at: complete ? 1100 : null,
      },
    ],
  };
}

test("runPollCycle: a failed enumeration is a no-op — no emit, no tombstone, gate preserved", async () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  // Seed a row so a spurious tombstone would be observable.
  s.applySnapshot(finished("alpha"));
  out.length = 0;

  // Enumeration fetch fails (fetcher returns null for the builders endpoint).
  const fetcher = async (url: string): Promise<unknown | null> =>
    url.endsWith("/api/v2/builders") ? null : buildsResponse(42, true);
  await runPollCycle(BASE, s, new AbortController().signal, fetcher);
  expect(out).toEqual([]); // gate preserved; alpha NOT tombstoned.
});

test("runPollCycle: a per-builder fetch failure skips that builder without tombstoning it", async () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));

  const fetcher = async (url: string): Promise<unknown | null> => {
    if (url.endsWith("/api/v2/builders")) {
      return buildersResponse(["alpha", "beta"]);
    }
    // alpha's per-builder fetch succeeds; beta's fails.
    if (url.includes("/builders/1/")) return buildsResponse(42, true);
    return null;
  };
  await runPollCycle(BASE, s, new AbortController().signal, fetcher);
  // alpha emitted; beta NOT tombstoned (it was present in the enumeration).
  expect(out).toEqual([
    finished("alpha", { state_string: "build successful" }),
  ]);
  expect(out.some((m) => m.kind === "build-deleted")).toBe(false);
});

test("runPollCycle: an empty-array builder mints a placeholder but a fetch failure stays silent (no conflation)", async () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));

  const fetcher = async (url: string): Promise<unknown | null> => {
    if (url.endsWith("/api/v2/builders")) {
      return buildersResponse(["alpha", "beta"]);
    }
    // alpha: HTTP 200 + `{"builds":[]}` → placeholder. beta: fetch failure →
    // silent (a null body never reaches parseLatestBuild).
    if (url.includes("/builders/1/")) return { builds: [] };
    return null;
  };
  await runPollCycle(BASE, s, new AbortController().signal, fetcher);
  // alpha placeholder emitted; beta minted NOTHING and was NOT tombstoned.
  expect(out).toEqual([neverBuilt("alpha")]);
  expect(out.some((m) => m.kind === "build-deleted")).toBe(false);
});

test("runPollCycle: a successful enumeration drops a builder no longer present", async () => {
  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));

  // First cycle: alpha + beta present.
  await runPollCycle(BASE, s, new AbortController().signal, async (url) => {
    if (url.endsWith("/api/v2/builders")) {
      return buildersResponse(["alpha", "beta"]);
    }
    return buildsResponse(42, true);
  });
  out.length = 0;

  // Second cycle: only alpha present → beta tombstoned.
  await runPollCycle(BASE, s, new AbortController().signal, async (url) => {
    if (url.endsWith("/api/v2/builders")) return buildersResponse(["alpha"]);
    return buildsResponse(42, true);
  });
  expect(out).toEqual([{ kind: "build-deleted", project: "beta" }]);
});

// ── (e) seedFromDb round-trip ──────────────────────────────────────────────

test("seedFromDb suppresses a re-emit of an already-folded projection row", () => {
  const { db } = freshMemDb();
  const msg = finished("alpha", {
    builder_id: 7,
    build_number: 99,
    state_string: "build successful",
  });
  // Land the row exactly as main's onmessage handler would (the same wire shape).
  db.run(
    `INSERT INTO builds (
       project, builder_id, build_number, complete, results,
       state_string, started_at, complete_at, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.project,
      msg.builder_id,
      msg.build_number,
      msg.complete,
      msg.results,
      msg.state_string,
      msg.started_at,
      msg.complete_at,
      1,
      1100,
    ],
  );

  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  seedFromDb(db, s);
  // An identical live snapshot must be suppressed by the seeded gate.
  s.applySnapshot(msg);
  expect(out).toEqual([]);
  db.close();
});

test("seedFromDb round-trips an all-null `never built` placeholder row without re-emitting", () => {
  const { db } = freshMemDb();
  const msg = neverBuilt("alpha", 7);
  // Land the placeholder row exactly as main's onmessage handler would: all
  // build fields NULL, the sentinel state_string, builder_id carried.
  db.run(
    `INSERT INTO builds (
       project, builder_id, build_number, complete, results,
       state_string, started_at, complete_at, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.project,
      msg.builder_id,
      msg.build_number,
      msg.complete,
      msg.results,
      msg.state_string,
      msg.started_at,
      msg.complete_at,
      1,
      1100,
    ],
  );

  const out: BuildsMessage[] = [];
  const s = new BuildsScanner((m) => out.push(m));
  seedFromDb(db, s);
  // An identical placeholder poll must be suppressed by the seeded gate — no
  // re-emit on boot for a never-built builder.
  s.applySnapshot(msg);
  expect(out).toEqual([]);
  db.close();
});

test("serializeBuildSnapshot round-trips the snapshot message payload", () => {
  // The worker forwards a BuildSnapshotMessage (extends BuildSnapshotPayload)
  // straight to serializeBuildSnapshot; pin that the wire blob carries the
  // projection fields (and drops the kind/project envelope fields).
  const msg = finished("alpha", { builder_id: 5, build_number: 7 });
  const blob = JSON.parse(serializeBuildSnapshot(msg)) as Record<
    string,
    unknown
  >;
  expect(blob).toEqual({
    builder_id: 5,
    build_number: 7,
    complete: 1,
    results: 0,
    state_string: "build successful",
    started_at: 1000,
    complete_at: 1100,
  });
});
