/**
 * `test/builds-watch.test.ts` (fn-790 task .1) — the `builds` sitter's suite.
 *
 * Two layers, mirroring `test/keeper-watch.test.ts`:
 *  1. The PURE detectors / folders (`detectBuilderFindings`, `categorizeStep`,
 *     `sanitizeToken`, `selectOnsets`, `foldSeenState`) — fed hand-built rows,
 *     asserted against the expected `Finding[]` / state. No DB.
 *  2. The DB + tick layer — seeds a sandbox buildbot `state.sqlite` in a tmpdir
 *     (raw `bun:sqlite` writer + INSERTs), points `BUILDBOT_STATE_SQLITE` at it
 *     and `BABYSITTER_STATE_DIR` at a tmpdir, and asserts that `--tick` writes a
 *     followup per red onset (via an injected spawn stub that captures the
 *     frozen findings file), none for incomplete/cancelled/retry/warnings
 *     builds, none repeated while a step stays red, and a fresh one after
 *     green→red.
 *
 * The sitter's state dir is its OWN tree (NOT a KEEPER_* path), so the env this
 * isolates is `BABYSITTER_STATE_DIR` (the seen-state / followups root) +
 * `BUILDBOT_STATE_SQLITE` (the surface) — neither touches keeper's feed.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuilderScan,
  categorizeStep,
  detectBuilderFindings,
  EXCEPTION,
  emptySeenState,
  FAILURE,
  type Finding,
  fingerprint,
  foldSeenState,
  loadSeenState,
  resolveBuildbotDbPath,
  resolveSeenStatePath,
  type SeenState,
  type SpawnAgentFn,
  SUCCESS,
  sanitizeToken,
  scan,
  selectOnsets,
  tick,
} from "../babysitters/builds/watch";

// ---------------------------------------------------------------------------
// Sandbox: tmpdir buildbot DB + the sitter's OWN state dir overridden.
// ---------------------------------------------------------------------------

let tmpDir: string;
let bbDbPath: string;
let stateDir: string;
let savedEnv: Record<string, string | undefined>;

const SANDBOXED_ENV = [
  "BABYSITTER_STATE_DIR",
  "BUILDBOT_STATE_SQLITE",
] as const;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "builds-watch-"));
  bbDbPath = join(tmpDir, "state.sqlite");
  const bbRoot = join(tmpDir, "bb-state");
  stateDir = join(bbRoot, "builds");
  savedEnv = {};
  for (const k of SANDBOXED_ENV) savedEnv[k] = process.env[k];
  process.env.BABYSITTER_STATE_DIR = bbRoot;
  process.env.BUILDBOT_STATE_SQLITE = bbDbPath;
});

afterEach(() => {
  for (const k of SANDBOXED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed a buildbot-shaped state.sqlite (builds / builders / steps).
// ---------------------------------------------------------------------------

interface SeedBuild {
  id: number;
  number: number;
  builderid: number;
  /** null = incomplete (the #1 false-positive class). */
  complete_at: number | null;
  results: number | null;
  /** step name → step results (0 SUCCESS, non-zero == failed, null == not-run). */
  steps: Array<{ name: string; results: number | null }>;
}

function seedBuildbotDb(
  builders: Array<{ id: number; name: string }>,
  builds: SeedBuild[],
): void {
  const db = new Database(bbDbPath, { create: true });
  // Match production: buildbot runs WAL mode. The scanner's read-only open uses
  // `file:?immutable=1` precisely because a plain read-only open fails on a
  // WAL DB — seeding WAL here exercises that real open path under test.
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE builders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_hash TEXT)",
  );
  db.run(
    `CREATE TABLE builds (id INTEGER PRIMARY KEY, number INTEGER NOT NULL,
       builderid INTEGER NOT NULL, complete_at INTEGER, results INTEGER,
       started_at INTEGER, state_string TEXT)`,
  );
  db.run(
    `CREATE TABLE steps (id INTEGER PRIMARY KEY, number INTEGER NOT NULL,
       name TEXT NOT NULL, buildid INTEGER NOT NULL, results INTEGER,
       state_string TEXT, urls_json TEXT)`,
  );
  for (const b of builders) {
    db.query("INSERT INTO builders (id, name, name_hash) VALUES (?, ?, ?)").run(
      b.id,
      b.name,
      `h${b.id}`,
    );
  }
  let stepId = 1;
  for (const bld of builds) {
    db.query(
      `INSERT INTO builds (id, number, builderid, complete_at, results, started_at, state_string)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bld.id,
      bld.number,
      bld.builderid,
      bld.complete_at,
      bld.results,
      1000,
      "x",
    );
    let stepNo = 0;
    for (const s of bld.steps) {
      db.query(
        `INSERT INTO steps (id, number, name, buildid, results, state_string, urls_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(stepId++, stepNo++, s.name, bld.id, s.results, "x", "[]");
    }
  }
  db.close();
}

// A capturing spawn stub: records the frozen findings handed to the agent and
// acks every fingerprint (simulating a successful collect). Tests inspect the
// captured findings to assert WHICH onsets were collected.
function capturingSpawn(): {
  spawn: SpawnAgentFn;
  calls: number;
  lastFindings: Finding[];
} {
  const box = {
    spawn: (async () => ({
      exitCode: 0,
      ackedFingerprints: null,
    })) as SpawnAgentFn,
    calls: 0,
    lastFindings: [] as Finding[],
  };
  box.spawn = async (input) => {
    box.calls++;
    const snapshot = JSON.parse(
      require("node:fs").readFileSync(input.findingsFile, "utf8"),
    ) as { findings: Finding[] };
    box.lastFindings = snapshot.findings;
    // Ack every handed fingerprint.
    require("node:fs").writeFileSync(
      input.ackFile,
      JSON.stringify(snapshot.findings.map((f) => f.fingerprint)),
    );
    return {
      exitCode: 0,
      ackedFingerprints: snapshot.findings.map((f) => f.fingerprint),
    };
  };
  return box;
}

const seenPath = (): string => join(stateDir, "seen.json");
const now = (): number => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Layer 1 — pure helpers
// ---------------------------------------------------------------------------

describe("sanitizeToken", () => {
  test("collapses : and . to _ (test:full / test.e2e would corrupt the key)", () => {
    expect(sanitizeToken("test:full")).toBe("test_full");
    expect(sanitizeToken("test.e2e")).toBe("test_e2e");
  });
  test("folds runs and strips edge underscores/dashes", () => {
    expect(sanitizeToken("::foo::bar::")).toBe("foo_bar");
    expect(sanitizeToken("-zig fmt-")).toBe("zig_fmt");
  });
});

describe("categorizeStep", () => {
  test("test / test:full / pytest → test-failure", () => {
    expect(categorizeStep("test")).toBe("test-failure");
    expect(categorizeStep("test:full")).toBe("test-failure");
    expect(categorizeStep("test:e2e")).toBe("test-failure");
    expect(categorizeStep("pytest")).toBe("test-failure");
  });
  test("lint / ruff / zig fmt → lint-failure", () => {
    expect(categorizeStep("lint")).toBe("lint-failure");
    expect(categorizeStep("ruff")).toBe("lint-failure");
    expect(categorizeStep("zig fmt")).toBe("lint-failure");
  });
  test("typecheck / ty → typecheck-failure", () => {
    expect(categorizeStep("typecheck")).toBe("typecheck-failure");
    expect(categorizeStep("ty")).toBe("typecheck-failure");
  });
  test("an unrecognized failed step defaults to test-failure (broad collector)", () => {
    expect(categorizeStep("worker_preparation")).toBe("test-failure");
  });
});

describe("fingerprint", () => {
  test("is stable across calls for the same (category, resourceId)", () => {
    expect(fingerprint("test-failure", "test_full:keeper")).toBe(
      fingerprint("test-failure", "test_full:keeper"),
    );
  });
  test("differs by category and by resourceId (no build number folded in)", () => {
    expect(fingerprint("test-failure", "test_full:keeper")).not.toBe(
      fingerprint("lint-failure", "test_full:keeper"),
    );
    expect(fingerprint("test-failure", "test_full:keeper")).not.toBe(
      fingerprint("test-failure", "test_full:planctl"),
    );
  });
});

describe("detectBuilderFindings", () => {
  const builder = { id: 2, name: "keeper" };

  test("a FAILURE build's failed steps yield one finding each", () => {
    const sc: BuilderScan = {
      builder,
      builds: [
        { id: 10, number: 5, builderid: 2, complete_at: 100, results: FAILURE },
      ],
      failedSteps: new Map([[10, ["lint", "test"]]]),
    };
    const out = detectBuilderFindings(sc);
    expect(out.cursor).toBe(5);
    expect(out.findings.map((f) => f.category).sort()).toEqual([
      "lint-failure",
      "test-failure",
    ]);
    // The key embeds the SANITIZED step + builder, never the build number.
    const lint = out.findings.find((f) => f.category === "lint-failure");
    expect(lint?.key).toBe("lint-failure:lint:keeper");
  });

  test("test:full failed step sanitizes in the key (no `:` corruption)", () => {
    const sc: BuilderScan = {
      builder,
      builds: [
        { id: 11, number: 6, builderid: 2, complete_at: 100, results: FAILURE },
      ],
      failedSteps: new Map([[11, ["test:full"]]]),
    };
    const out = detectBuilderFindings(sc);
    expect(out.findings[0].key).toBe("test-failure:test_full:keeper");
  });

  test("a SUCCESS newest build yields NO findings (green clears via empty)", () => {
    const sc: BuilderScan = {
      builder,
      builds: [
        { id: 12, number: 7, builderid: 2, complete_at: 100, results: SUCCESS },
      ],
      failedSteps: new Map(),
    };
    expect(detectBuilderFindings(sc).findings).toEqual([]);
  });

  test("an EXCEPTION build with no failed step yields one build-exception finding", () => {
    const sc: BuilderScan = {
      builder,
      builds: [
        {
          id: 13,
          number: 8,
          builderid: 2,
          complete_at: 100,
          results: EXCEPTION,
        },
      ],
      failedSteps: new Map(),
    };
    const out = detectBuilderFindings(sc);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].category).toBe("build-exception");
    expect(out.findings[0].key).toBe("build-exception:keeper");
  });

  test("only the NEWEST completed build defines redness (failed-then-green = green)", () => {
    const sc: BuilderScan = {
      builder,
      // number-DESC: newest is the green #9, older red #8.
      builds: [
        { id: 14, number: 9, builderid: 2, complete_at: 200, results: SUCCESS },
        { id: 13, number: 8, builderid: 2, complete_at: 100, results: FAILURE },
      ],
      failedSteps: new Map([[13, ["test"]]]),
    };
    const out = detectBuilderFindings(sc);
    expect(out.findings).toEqual([]);
    expect(out.cursor).toBe(9);
  });

  test("an empty builds list yields nothing and a zero cursor", () => {
    const out = detectBuilderFindings({
      builder,
      builds: [],
      failedSteps: new Map(),
    });
    expect(out.findings).toEqual([]);
    expect(out.cursor).toBe(0);
  });
});

describe("selectOnsets", () => {
  const f = (fp: string): Finding => ({
    key: "k",
    fingerprint: fp,
    severity: "warning",
    category: "test-failure",
    title: "t",
    detail: "d",
    evidence: {},
  });

  test("a finding absent from seen-state is a new onset", () => {
    const prior: SeenState = emptySeenState();
    expect(selectOnsets([f("a")], prior).map((x) => x.fingerprint)).toEqual([
      "a",
    ]);
  });

  test("a finding already in seen-state with a SUCCESSFUL collect is suppressed (stayed red)", () => {
    const prior: SeenState = {
      version: 1,
      cursors: {},
      fingerprints: { a: { first_seen: 1, last_seen: 1, spawn_failures: 0 } },
    };
    expect(selectOnsets([f("a")], prior)).toEqual([]);
  });

  test("a finding whose prior collect FAILED (under the cap) re-attempts", () => {
    const prior: SeenState = {
      version: 1,
      cursors: {},
      fingerprints: { a: { first_seen: 1, last_seen: 1, spawn_failures: 2 } },
    };
    expect(selectOnsets([f("a")], prior).map((x) => x.fingerprint)).toEqual([
      "a",
    ]);
  });

  test("a finding at the retry cap is suppressed", () => {
    const prior: SeenState = {
      version: 1,
      cursors: {},
      fingerprints: { a: { first_seen: 1, last_seen: 1, spawn_failures: 5 } },
    };
    expect(selectOnsets([f("a")], prior)).toEqual([]);
  });
});

describe("foldSeenState", () => {
  const f = (fp: string): Finding => ({
    key: "k",
    fingerprint: fp,
    severity: "warning",
    category: "test-failure",
    title: "t",
    detail: "d",
    evidence: {},
  });

  test("green CLEARS: a prior fingerprint absent from present reds is dropped", () => {
    const prior: SeenState = {
      version: 1,
      cursors: {},
      fingerprints: {
        gone: { first_seen: 1, last_seen: 1, spawn_failures: 0 },
      },
    };
    const next = foldSeenState({
      prior,
      present: [f("still")],
      cursors: new Map(),
      spawnFailed: new Set(),
      nowSecs: 2,
    });
    expect(Object.keys(next.fingerprints)).toEqual(["still"]);
  });

  test("cursors advance to the high-water mark and never regress", () => {
    const prior: SeenState = {
      version: 1,
      cursors: { keeper: 10, planctl: 99 },
      fingerprints: {},
    };
    const next = foldSeenState({
      prior,
      present: [],
      cursors: new Map([
        ["keeper", 15],
        ["planctl", 50], // lower than prior 99 → must NOT regress
      ]),
      spawnFailed: new Set(),
      nowSecs: 2,
    });
    expect(next.cursors.keeper).toBe(15);
    expect(next.cursors.planctl).toBe(99);
  });

  test("a spawnFailed present fingerprint bumps its retry counter", () => {
    const next = foldSeenState({
      prior: emptySeenState(),
      present: [f("a")],
      cursors: new Map(),
      spawnFailed: new Set(["a"]),
      nowSecs: 2,
    });
    expect(next.fingerprints.a.spawn_failures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — DB scan + tick against a seeded sandbox state.sqlite
// ---------------------------------------------------------------------------

describe("scan (DB layer)", () => {
  test("missing buildbot DB → empty findings (degrade, never throw)", () => {
    expect(existsSync(bbDbPath)).toBe(false);
    const res = scan(bbDbPath, emptySeenState());
    expect(res.findings).toEqual([]);
    expect(res.cursors.size).toBe(0);
  });

  test("a FAILURE build's failed steps surface; SUCCESS / incomplete do not", () => {
    seedBuildbotDb(
      [
        { id: 2, name: "keeper" },
        { id: 1, name: "planctl" },
      ],
      [
        // keeper: newest #5 FAILURE with lint+test failed.
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: FAILURE,
          steps: [
            { name: "lint", results: FAILURE },
            { name: "test", results: FAILURE },
            { name: "typecheck", results: SUCCESS },
          ],
        },
        // planctl: newest #3 is INCOMPLETE (complete_at null) → ignored; the
        // newest COMPLETED is #2 SUCCESS → no finding.
        {
          id: 20,
          number: 3,
          builderid: 1,
          complete_at: null,
          results: null,
          steps: [],
        },
        {
          id: 21,
          number: 2,
          builderid: 1,
          complete_at: 90,
          results: SUCCESS,
          steps: [{ name: "test:full", results: SUCCESS }],
        },
      ],
    );
    const res = scan(bbDbPath, emptySeenState());
    const cats = res.findings.map((f) => f.category).sort();
    expect(cats).toEqual(["lint-failure", "test-failure"]);
    // keeper's cursor is the newest completed build number.
    expect(res.cursors.get("keeper")).toBe(5);
  });

  test("a CANCELLED (results=6) newest build yields no finding", () => {
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: 6,
          steps: [{ name: "test", results: 6 }],
        },
      ],
    );
    expect(scan(bbDbPath, emptySeenState()).findings).toEqual([]);
  });
});

describe("tick", () => {
  test("cold start collects a followup per currently-red onset (NO silent baseline)", async () => {
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: FAILURE,
          steps: [{ name: "test:full", results: FAILURE }],
        },
      ],
    );
    const box = capturingSpawn();
    const res = await tick(
      bbDbPath,
      { nowSecs: now, spawnAgent: box.spawn },
      seenPath(),
    );
    expect(res.spawned).toBe(true);
    expect(res.onsetCount).toBe(1);
    expect(res.collectedCount).toBe(1);
    expect(box.lastFindings[0].key).toBe("test-failure:test_full:keeper");
    // The collected onset is now recorded in seen-state.
    const state = loadSeenState(seenPath());
    expect(Object.keys(state.fingerprints)).toHaveLength(1);
    expect(state.cursors.keeper).toBe(5);
  });

  test("a step that stays red across ticks is NOT re-collected", async () => {
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: FAILURE,
          steps: [{ name: "test", results: FAILURE }],
        },
      ],
    );
    const box = capturingSpawn();
    await tick(bbDbPath, { nowSecs: now, spawnAgent: box.spawn }, seenPath());
    expect(box.calls).toBe(1);
    // Tick 2: same red, same newest build → no new onset, no spawn.
    const res = await tick(
      bbDbPath,
      { nowSecs: now, spawnAgent: box.spawn },
      seenPath(),
    );
    expect(res.spawned).toBe(false);
    expect(box.calls).toBe(1);
  });

  test("green→red writes a fresh onset (green clears, then the next red re-onsets)", async () => {
    // Tick 1: red.
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: FAILURE,
          steps: [{ name: "test", results: FAILURE }],
        },
      ],
    );
    const box = capturingSpawn();
    await tick(bbDbPath, { nowSecs: now, spawnAgent: box.spawn }, seenPath());
    expect(box.calls).toBe(1);

    // Tick 2: a newer GREEN build lands → the step clears from seen-state.
    rmSync(bbDbPath, { force: true });
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 11,
          number: 6,
          builderid: 2,
          complete_at: 200,
          results: SUCCESS,
          steps: [{ name: "test", results: SUCCESS }],
        },
      ],
    );
    await tick(bbDbPath, { nowSecs: now, spawnAgent: box.spawn }, seenPath());
    expect(box.calls).toBe(1); // green → no spawn
    expect(Object.keys(loadSeenState(seenPath()).fingerprints)).toHaveLength(0);

    // Tick 3: a newer RED build lands → fresh onset, spawns again.
    rmSync(bbDbPath, { force: true });
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 12,
          number: 7,
          builderid: 2,
          complete_at: 300,
          results: FAILURE,
          steps: [{ name: "test", results: FAILURE }],
        },
      ],
    );
    const res = await tick(
      bbDbPath,
      { nowSecs: now, spawnAgent: box.spawn },
      seenPath(),
    );
    expect(res.spawned).toBe(true);
    expect(box.calls).toBe(2);
  });

  test("missing buildbot DB → no spawn, heartbeat stamped, exit-0 shape", async () => {
    expect(existsSync(bbDbPath)).toBe(false);
    const box = capturingSpawn();
    const res = await tick(
      bbDbPath,
      { nowSecs: now, spawnAgent: box.spawn },
      seenPath(),
      join(stateDir, "heartbeat.json"),
    );
    expect(res.spawned).toBe(false);
    expect(box.calls).toBe(0);
    expect(existsSync(join(stateDir, "heartbeat.json"))).toBe(true);
  });

  test("a failed spawn does NOT mark the onset collected (retries next tick)", async () => {
    seedBuildbotDb(
      [{ id: 2, name: "keeper" }],
      [
        {
          id: 10,
          number: 5,
          builderid: 2,
          complete_at: 100,
          results: FAILURE,
          steps: [{ name: "test", results: FAILURE }],
        },
      ],
    );
    let calls = 0;
    const failSpawn: SpawnAgentFn = async () => {
      calls++;
      return { exitCode: 1, ackedFingerprints: null };
    };
    const res = await tick(
      bbDbPath,
      { nowSecs: now, spawnAgent: failSpawn },
      seenPath(),
    );
    expect(res.collectedCount).toBe(0);
    // The fingerprint is still present (it IS a current red) with a bumped
    // failure counter, so the next tick re-attempts.
    const state = loadSeenState(seenPath());
    const entry = Object.values(state.fingerprints)[0];
    expect(entry.spawn_failures).toBe(1);
    // Tick 2 re-attempts the same red (still under the cap).
    await tick(bbDbPath, { nowSecs: now, spawnAgent: failSpawn }, seenPath());
    expect(calls).toBe(2);
  });
});

describe("resolvers honor the env overrides", () => {
  test("resolveBuildbotDbPath honors BUILDBOT_STATE_SQLITE", () => {
    expect(resolveBuildbotDbPath()).toBe(bbDbPath);
  });
  test("resolveSeenStatePath is the sitter's OWN dir under BABYSITTER_STATE_DIR", () => {
    expect(resolveSeenStatePath()).toBe(join(stateDir, "seen.json"));
  });
});
