/**
 * Parity tests for the `src/subagent-invocations.ts` parser.
 *
 * Strategy:
 * 1. Load the golden fixture at `test/fixtures/subagent_invocation_cases.jsonl`.
 *    This is a FROZEN golden with no generator — `src/subagent-invocations.ts`
 *    is the source of truth. Edit the JSONL by hand alongside deliberate
 *    behavior changes in `src/subagent-invocations.ts`.
 * 2. For each case, walk the events through a tiny per-event driver that
 *    mimics what task .3's reducer will do: SubagentStart inserts a row,
 *    SubagentStop closes the matching open row, PostToolUse:Agent folds
 *    bridge metadata. All four helpers under test (`extractTurnSeq`,
 *    `findOpenTurnForStop`, `findBridgePreToolUse`, `resolveBridgeAgentId`)
 *    are exercised.
 * 3. Read back the resulting rows and assert byte-identical canonical JSON
 *    against the Python reference output captured in the fixture.
 *
 * The driver lives INSIDE the test file (not in `src/`) because it is the
 * test's responsibility to wire the helpers together — task .3's reducer
 * is the production wiring. Keeping the driver here makes the test
 * self-contained and avoids dictating reducer shape ahead of task .3.
 *
 * Each fixture case becomes one `test(...)`; a failing case names the
 * `desc` so the diagnostic surfaces the scenario cleanly.
 *
 * Also exercises:
 * - `canonicalizeRow` against hand-crafted dicts (Python-shape unit test).
 * - `truncateDescription` boundary cases.
 * - Cross-job isolation of `findBridgePreToolUse` (the
 *   `cross-job-tool-use-id-collision` fixture verifies this end-to-end).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeEventInput,
  type CanonicalRow,
  canonicalizeRow,
  DESCRIPTION_MAX_CHARS,
  extractTurnSeq,
  findBridgePreToolUse,
  findOpenTurnForStop,
  findPendingPreToolUseForStart,
  resolveBridgeAgentId,
  truncateDescription,
} from "../src/subagent-invocations";
import { freshMemDb } from "./helpers/template-db";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface FixtureEvent {
  id: number;
  session_id: string;
  ts: number;
  hook_event: string;
  tool_name: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  subagent_agent_id: string | null;
  data: string;
}

interface FixtureCase {
  desc: string;
  events: FixtureEvent[];
  expected: CanonicalRow[];
}

function loadFixtures(): FixtureCase[] {
  const fixturePath = join(
    import.meta.dir,
    "fixtures",
    "subagent_invocation_cases.jsonl",
  );
  const text = readFileSync(fixturePath, "utf-8");
  const rows: FixtureCase[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    rows.push(JSON.parse(line) as FixtureCase);
  }
  return rows;
}

const FIXTURES = loadFixtures();

// ---------------------------------------------------------------------------
// Test DB scaffolding — mirrors test/reducer.test.ts pattern.
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-subagent-test-"));
  // fn-769 mem variant: each test drives a single in-process connection, so an
  // in-memory template clone is correct.
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Insert one events row from a fixture event. Mirrors the reducer test's
 * direct-INSERT helper but only sets the columns the helpers need.
 */
function insertEvent(ev: FixtureEvent): void {
  db.run(
    `INSERT INTO events (
       id, ts, session_id, pid, hook_event, event_type, tool_name,
       data, agent_id, agent_type, subagent_agent_id, tool_use_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ev.id,
      ev.ts,
      ev.session_id,
      null,
      ev.hook_event,
      ev.hook_event,
      ev.tool_name,
      ev.data,
      ev.agent_id,
      ev.agent_type,
      ev.subagent_agent_id,
      ev.tool_use_id,
    ],
  );
}

// ---------------------------------------------------------------------------
// Per-event driver — mimics task .3's reducer wiring of the four helpers.
//
// The driver maintains `subagent_invocations` rows by reacting to:
// - SubagentStart  → INSERT a new row at turn_seq from extractTurnSeq().
// - SubagentStop   → UPDATE the row identified by findOpenTurnForStop()
//                    (gate: duration_ms IS NULL alone; fn-480).
// - PostToolUse:Agent → resolveBridgeAgentId → findBridgePreToolUse →
//                    UPDATE turn-0 row's description / prompt_chars /
//                    subagent_type (if non-empty) + flip status to "ok"
//                    if not already failed/unknown.
// - PostToolUseFailure:Agent → no-op (matches Python drop behavior).
// - PreToolUse:Agent → no-op at fold-time (the row is just queried later by
//                    findBridgePreToolUse via the events-table lookup).
// ---------------------------------------------------------------------------

function driveEvent(ev: FixtureEvent): void {
  // The events row must be persisted BEFORE the helpers run so the
  // events-table lookups (findBridgePreToolUse) see it.
  insertEvent(ev);

  const tsMs = Math.trunc(ev.ts * 1000);

  if (ev.hook_event === "SubagentStart") {
    if (!ev.agent_id) return;
    const turnSeq = extractTurnSeq(db, ev.session_id, ev.agent_id);
    const pendingPre = findPendingPreToolUseForStart(
      db,
      ev.session_id,
      ev.agent_type,
    );
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
         description, prompt_chars, status, duration_ms,
         last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ev.session_id,
        ev.agent_id,
        turnSeq,
        tsMs,
        pendingPre?.tool_use_id ?? null,
        ev.agent_type ?? null,
        pendingPre?.description ?? null,
        pendingPre?.prompt_chars ?? 0,
        "running",
        null,
        ev.id,
        ev.ts,
      ],
    );
    return;
  }

  if (ev.hook_event === "SubagentStop") {
    if (!ev.agent_id) return;
    const openTurnSeq = findOpenTurnForStop(db, ev.session_id, ev.agent_id);
    if (openTurnSeq === null) return; // orphan stop — safe no-op
    const row = db
      .prepare(
        `SELECT ts, status FROM subagent_invocations
          WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
      )
      .get(ev.session_id, ev.agent_id, openTurnSeq) as {
      ts: number;
      status: string;
    } | null;
    if (row === null) return;
    const duration = tsMs - row.ts;
    const nextStatus =
      row.status === "failed" || row.status === "unknown" ? row.status : "ok";
    db.run(
      `UPDATE subagent_invocations
          SET duration_ms = ?, status = ?, last_event_id = ?, updated_at = ?
        WHERE job_id = ? AND agent_id = ? AND turn_seq = ?`,
      [
        duration,
        nextStatus,
        ev.id,
        ev.ts,
        ev.session_id,
        ev.agent_id,
        openTurnSeq,
      ],
    );
    return;
  }

  if (ev.hook_event === "PostToolUse" && ev.tool_name === "Agent") {
    if (!ev.tool_use_id) return;
    const bridgeInput: BridgeEventInput = {
      subagent_agent_id: ev.subagent_agent_id,
      data: ev.data,
    };
    const agentId = resolveBridgeAgentId(bridgeInput);
    if (agentId === null) return;
    // Find the turn-0 row for this agent_id in this session.
    const turn0 = db
      .prepare(
        `SELECT status FROM subagent_invocations
          WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
      )
      .get(ev.session_id, agentId) as { status: string } | null;
    if (turn0 === null) return; // PostToolUse with no SubagentStart — drop
    const preMeta = findBridgePreToolUse(db, ev.session_id, ev.tool_use_id);
    // Fold spawn metadata onto turn-0 (PreToolUse-wins / SubagentStart-seeds-the-gap).
    if (preMeta !== null) {
      const updates: string[] = [];
      const params: (string | number | null)[] = [];
      if (preMeta.subagent_type) {
        updates.push("subagent_type = ?");
        params.push(preMeta.subagent_type);
      }
      if (preMeta.description) {
        updates.push("description = ?");
        params.push(preMeta.description);
      }
      // prompt_chars from PreToolUse always wins (matches Python: writes
      // whenever the raw value is not None — even 0).
      updates.push("prompt_chars = ?");
      params.push(preMeta.prompt_chars);
      updates.push("tool_use_id = ?");
      params.push(ev.tool_use_id);

      // Flip status to "ok" unless already failed/unknown.
      const nextStatus =
        turn0.status === "failed" || turn0.status === "unknown"
          ? turn0.status
          : "ok";
      updates.push("status = ?");
      params.push(nextStatus);
      updates.push("last_event_id = ?");
      params.push(ev.id);
      updates.push("updated_at = ?");
      params.push(ev.ts);
      params.push(ev.session_id, agentId);
      db.run(
        `UPDATE subagent_invocations
            SET ${updates.join(", ")}
          WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
        params,
      );
    } else {
      // No bridge PreToolUse — just flip status.
      const nextStatus =
        turn0.status === "failed" || turn0.status === "unknown"
          ? turn0.status
          : "ok";
      db.run(
        `UPDATE subagent_invocations
            SET status = ?, last_event_id = ?, updated_at = ?
          WHERE job_id = ? AND agent_id = ? AND turn_seq = 0`,
        [nextStatus, ev.id, ev.ts, ev.session_id, agentId],
      );
    }
    return;
  }

  // PreToolUse:Agent + PostToolUseFailure:Agent + other events: no row
  // mutation. The events row is already inserted above so future lookups
  // see it (PreToolUse is what findBridgePreToolUse looks up).
}

function projectionRows(): CanonicalRow[] {
  const rows = db
    .prepare(
      `SELECT job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
              description, prompt_chars, status, duration_ms
         FROM subagent_invocations
        ORDER BY ts ASC, agent_id ASC, turn_seq ASC`,
    )
    .all() as {
    job_id: string;
    agent_id: string;
    turn_seq: number;
    ts: number;
    tool_use_id: string | null;
    subagent_type: string | null;
    description: string | null;
    prompt_chars: number;
    status: string;
    duration_ms: number | null;
  }[];
  // Project to the canonical-row shape (drop job_id — the Python entry doesn't
  // carry it because we ran parse_rows with group_by=None).
  return rows.map((r) => ({
    agent_id: r.agent_id,
    description: r.description,
    duration_ms: r.duration_ms,
    prompt_chars: r.prompt_chars,
    status: r.status as CanonicalRow["status"],
    subagent_type: r.subagent_type,
    tool_use_id: r.tool_use_id,
    ts: r.ts,
    turn_seq: r.turn_seq,
  }));
}

// ---------------------------------------------------------------------------
// Sanity gates on the fixture itself
// ---------------------------------------------------------------------------

test("fixture file loads with the expected scale", () => {
  // Acceptance lists ten edge-case scenarios (`concurrent-same-type` added
  // alongside the SubagentStart-time FIFO bridge — pins the deterministic
  // FIFO assignment when two pending PreToolUse:Agent rows share a
  // subagent_type within a session).
  expect(FIXTURES.length).toBe(10);
  const descs = FIXTURES.map((f) => f.desc);
  expect(descs).toContain("clean-close");
  expect(descs).toContain("still-running");
  expect(descs).toContain("orphan-stop");
  expect(descs).toContain("concurrent-same-type");
  expect(descs).toContain("orphan-failure");
  expect(descs).toContain("post-before-stop");
  expect(descs).toContain("multi-turn");
  expect(descs).toContain("interleaved");
  expect(descs).toContain("pre-without-post");
  expect(descs).toContain("cross-job-tool-use-id-collision");
});

// ---------------------------------------------------------------------------
// Golden-fixture parity: byte-identical canonical JSON per case.
// ---------------------------------------------------------------------------

describe("golden-fixture parity", () => {
  for (const fixture of FIXTURES) {
    test(`case: ${fixture.desc}`, () => {
      // Events arrive in spawn order; mirror that here.
      const sorted = [...fixture.events].sort(
        (a, b) => a.ts - b.ts || a.id - b.id,
      );
      for (const ev of sorted) {
        driveEvent(ev);
      }

      const actual = projectionRows();
      // String equality on canonical JSON — NOT deep equality. Any field
      // typo or missing-vs-null divergence fails loudly.
      const actualJson = actual.map((r) => canonicalizeRow(r)).join("\n");
      const expectedJson = fixture.expected
        .map((r) => canonicalizeRow(r))
        .join("\n");
      expect(actualJson).toBe(expectedJson);
    });
  }
});

// ---------------------------------------------------------------------------
// Canonicalizer unit tests — Python `json.dumps(sort_keys=True,
// separators=(',', ':'))` byte-for-byte parity.
// ---------------------------------------------------------------------------

describe("canonicalizeRow", () => {
  test("keys sort alphabetically", () => {
    expect(canonicalizeRow({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  test("no whitespace between separators", () => {
    expect(canonicalizeRow({ k: "v", n: 1 })).toBe('{"k":"v","n":1}');
  });

  test("null preserved as explicit null (not dropped like JS undefined)", () => {
    expect(canonicalizeRow({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  test("undefined coerces to null (Python None / SQLite NULL parity)", () => {
    expect(canonicalizeRow({ a: undefined, b: 1 })).toBe('{"a":null,"b":1}');
  });

  test("integers serialize without trailing .0", () => {
    // JS `JSON.stringify` of an integer Number is already no-trailing-zero;
    // pin the behavior as a regression.
    expect(canonicalizeRow({ n: 100 })).toBe('{"n":100}');
    expect(canonicalizeRow({ n: 0 })).toBe('{"n":0}');
  });

  test("nested objects sort recursively", () => {
    expect(canonicalizeRow({ outer: { z: 1, a: 2 } })).toBe(
      '{"outer":{"a":2,"z":1}}',
    );
  });

  test("arrays preserve insertion order (only dict keys sort)", () => {
    expect(canonicalizeRow({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}');
  });

  test("full canonical row shape matches Python sort", () => {
    const row: CanonicalRow = {
      agent_id: "agent_clean",
      description: "Find auth code",
      duration_ms: 1000,
      prompt_chars: 46,
      status: "ok",
      subagent_type: "Explore",
      tool_use_id: "toolu_clean",
      ts: 100500,
      turn_seq: 0,
    };
    // Same byte string Python emits — keys alphabetical, no spaces.
    expect(canonicalizeRow(row)).toBe(
      '{"agent_id":"agent_clean","description":"Find auth code","duration_ms":1000,"prompt_chars":46,"status":"ok","subagent_type":"Explore","tool_use_id":"toolu_clean","ts":100500,"turn_seq":0}',
    );
  });
});

// ---------------------------------------------------------------------------
// truncateDescription
// ---------------------------------------------------------------------------

describe("truncateDescription", () => {
  test("short string passes through unchanged", () => {
    expect(truncateDescription("hello")).toBe("hello");
  });

  test("at-cap string passes through unchanged", () => {
    const s = "x".repeat(DESCRIPTION_MAX_CHARS);
    expect(truncateDescription(s).length).toBe(DESCRIPTION_MAX_CHARS);
  });

  test("over-cap string truncates to MAX", () => {
    const s = "x".repeat(DESCRIPTION_MAX_CHARS + 100);
    expect(truncateDescription(s).length).toBe(DESCRIPTION_MAX_CHARS);
  });

  test("custom max", () => {
    expect(truncateDescription("hello world", 5)).toBe("hello");
  });

  test("constant matches Python source-of-truth", () => {
    expect(DESCRIPTION_MAX_CHARS).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// resolveBridgeAgentId — column-then-JSON fallback + defensive parsing
// ---------------------------------------------------------------------------

describe("resolveBridgeAgentId", () => {
  test("prefers indexed column when populated", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: "agent_X",
        data: '{"tool_response":{"agentId":"agent_Y"}}',
      }),
    ).toBe("agent_X");
  });

  test("falls back to data.tool_response.agentId when column is null", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: null,
        data: '{"tool_response":{"agentId":"agent_Y"}}',
      }),
    ).toBe("agent_Y");
  });

  test("returns null on malformed JSON (no throw)", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: null,
        data: "not-json",
      }),
    ).toBeNull();
  });

  test("returns null on missing tool_response", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: null,
        data: "{}",
      }),
    ).toBeNull();
  });

  test("returns null on non-string agentId", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: null,
        data: '{"tool_response":{"agentId":42}}',
      }),
    ).toBeNull();
  });

  test("empty-string subagent_agent_id falls through to JSON path", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: "",
        data: '{"tool_response":{"agentId":"agent_Y"}}',
      }),
    ).toBe("agent_Y");
  });

  test("data as object (not string) works too", () => {
    expect(
      resolveBridgeAgentId({
        subagent_agent_id: null,
        data: { tool_response: { agentId: "agent_obj" } },
      }),
    ).toBe("agent_obj");
  });
});

// ---------------------------------------------------------------------------
// findBridgePreToolUse — cross-job isolation (explicit unit test on top of
// the cross-job fixture run).
// ---------------------------------------------------------------------------

describe("findBridgePreToolUse cross-job isolation", () => {
  test("session_id WHERE prevents cross-session contamination", () => {
    // Insert two PreToolUse:Agent rows with the same tool_use_id in DIFFERENT
    // sessions; the lookup for session B must return B's payload, not A's.
    db.run(
      `INSERT INTO events (
         id, ts, session_id, hook_event, event_type, tool_name, tool_use_id, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        1.0,
        "sess-A",
        "PreToolUse",
        "PreToolUse",
        "Agent",
        "toolu_collide",
        JSON.stringify({
          tool_use_id: "toolu_collide",
          tool_input: {
            description: "A description",
            prompt: "A prompt",
            subagent_type: "Explore",
          },
        }),
      ],
    );
    db.run(
      `INSERT INTO events (
         id, ts, session_id, hook_event, event_type, tool_name, tool_use_id, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        2,
        2.0,
        "sess-B",
        "PreToolUse",
        "PreToolUse",
        "Agent",
        "toolu_collide",
        JSON.stringify({
          tool_use_id: "toolu_collide",
          tool_input: {
            description: "B description",
            prompt: "BB",
            subagent_type: "Plan",
          },
        }),
      ],
    );

    const a = findBridgePreToolUse(db, "sess-A", "toolu_collide");
    expect(a).toEqual({
      description: "A description",
      prompt_chars: 8,
      subagent_type: "Explore",
    });
    const b = findBridgePreToolUse(db, "sess-B", "toolu_collide");
    expect(b).toEqual({
      description: "B description",
      prompt_chars: 2,
      subagent_type: "Plan",
    });
    const c = findBridgePreToolUse(db, "sess-C-missing", "toolu_collide");
    expect(c).toBeNull();
  });

  test("returns null for malformed JSON data (no throw)", () => {
    db.run(
      `INSERT INTO events (
         id, ts, session_id, hook_event, event_type, tool_name, tool_use_id, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        1.0,
        "sess-bad",
        "PreToolUse",
        "PreToolUse",
        "Agent",
        "toolu_bad",
        "not-json",
      ],
    );
    const result = findBridgePreToolUse(db, "sess-bad", "toolu_bad");
    // Safe-default to the empty triple instead of throwing.
    expect(result).toEqual({
      description: null,
      prompt_chars: 0,
      subagent_type: null,
    });
  });
});

// ---------------------------------------------------------------------------
// extractTurnSeq / findOpenTurnForStop — unit coverage on top of the
// fixture run.
// ---------------------------------------------------------------------------

describe("extractTurnSeq", () => {
  test("returns 0 on a fresh agent_id", () => {
    expect(extractTurnSeq(db, "sess-x", "agent_new")).toBe(0);
  });

  test("returns MAX+1 with persisted rows", () => {
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_mt", 0, 1.0, 0, "ok", 1, 1.0],
    );
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_mt", 1, 2.0, 0, "ok", 2, 2.0],
    );
    expect(extractTurnSeq(db, "sess-x", "agent_mt")).toBe(2);
  });

  test("ignores other agent_ids and other sessions", () => {
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_other", 5, 1.0, 0, "ok", 1, 1.0],
    );
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-y", "agent_target", 9, 1.0, 0, "ok", 1, 1.0],
    );
    expect(extractTurnSeq(db, "sess-x", "agent_target")).toBe(0);
  });
});

describe("findOpenTurnForStop", () => {
  test("returns null when no rows exist", () => {
    expect(findOpenTurnForStop(db, "sess-x", "agent_none")).toBeNull();
  });

  test("returns null when every turn is already closed", () => {
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, duration_ms,
         last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_closed", 0, 1.0, 0, "ok", 1000, 1, 1.0],
    );
    expect(findOpenTurnForStop(db, "sess-x", "agent_closed")).toBeNull();
  });

  test("returns latest open turn (duration_ms IS NULL alone gates)", () => {
    // turn 0 closed, turn 1 open.
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, duration_ms,
         last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_mix", 0, 1.0, 0, "ok", 1000, 1, 1.0],
    );
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, duration_ms,
         last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_mix", 1, 2.0, 0, "running", null, 2, 2.0],
    );
    expect(findOpenTurnForStop(db, "sess-x", "agent_mix")).toBe(1);
  });

  test("fn-480: status='ok' but duration_ms NULL is still open", () => {
    // PostToolUse:Agent flipped status to 'ok' BEFORE SubagentStop landed.
    db.run(
      `INSERT INTO subagent_invocations (
         job_id, agent_id, turn_seq, ts, prompt_chars, status, duration_ms,
         last_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-x", "agent_pbs", 0, 1.0, 0, "ok", null, 1, 1.0],
    );
    expect(findOpenTurnForStop(db, "sess-x", "agent_pbs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findPendingPreToolUseForStart — early FIFO bridge used by SubagentStart.
// Exercises type-match, FIFO order, already-bound skip, defensive parsing.
// ---------------------------------------------------------------------------

function insertPre(
  id: number,
  sessionId: string,
  toolUseId: string | null,
  toolInput: Record<string, unknown> | null,
  ts: number,
): void {
  const data =
    toolInput === null
      ? "not-json"
      : JSON.stringify({ tool_use_id: toolUseId, tool_input: toolInput });
  db.run(
    `INSERT INTO events (
       id, ts, session_id, hook_event, event_type, tool_name, tool_use_id, data
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ts, sessionId, "PreToolUse", "PreToolUse", "Agent", toolUseId, data],
  );
}

function bind(
  jobId: string,
  agentId: string,
  turnSeq: number,
  toolUseId: string,
): void {
  db.run(
    `INSERT INTO subagent_invocations (
       job_id, agent_id, turn_seq, ts, tool_use_id, prompt_chars, status,
       duration_ms, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [jobId, agentId, turnSeq, 1.0, toolUseId, 0, "running", null, 1, 1.0],
  );
}

describe("findPendingPreToolUseForStart", () => {
  test("returns null when no PreToolUse:Agent exists in session", () => {
    expect(
      findPendingPreToolUseForStart(db, "sess-empty", "Explore"),
    ).toBeNull();
  });

  test("returns null when agentType is null", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_1",
      { description: "d", prompt: "p", subagent_type: "Explore" },
      1.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-x", null)).toBeNull();
  });

  test("returns null when agentType is empty string", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_1",
      { description: "d", prompt: "p", subagent_type: "Explore" },
      1.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-x", "")).toBeNull();
  });

  test("single matching PreToolUse: returns its description / prompt_chars / tool_use_id", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_solo",
      {
        description: "Find auth code",
        prompt: "Search the codebase",
        subagent_type: "Explore",
      },
      1.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-x", "Explore")).toEqual({
      description: "Find auth code",
      prompt_chars: 19,
      tool_use_id: "toolu_solo",
    });
  });

  test("FIFO order: earliest id wins among multiple same-type pending rows", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_first",
      { description: "first", prompt: "p1", subagent_type: "Explore" },
      1.0,
    );
    insertPre(
      2,
      "sess-x",
      "toolu_second",
      { description: "second", prompt: "pp2", subagent_type: "Explore" },
      2.0,
    );
    const result = findPendingPreToolUseForStart(db, "sess-x", "Explore");
    expect(result?.tool_use_id).toBe("toolu_first");
    expect(result?.description).toBe("first");
  });

  test("already-bound tool_use_id is skipped, next unbound wins", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_first",
      { description: "first", prompt: "p1", subagent_type: "Explore" },
      1.0,
    );
    insertPre(
      2,
      "sess-x",
      "toolu_second",
      { description: "second", prompt: "pp2", subagent_type: "Explore" },
      2.0,
    );
    // Bind toolu_first to an existing subagent_invocations row in this session.
    bind("sess-x", "agent_prev", 0, "toolu_first");
    const result = findPendingPreToolUseForStart(db, "sess-x", "Explore");
    expect(result?.tool_use_id).toBe("toolu_second");
    expect(result?.description).toBe("second");
  });

  test("type mismatch falls through to next matching row", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_plan",
      { description: "plan thing", prompt: "p", subagent_type: "Plan" },
      1.0,
    );
    insertPre(
      2,
      "sess-x",
      "toolu_explore",
      { description: "explore thing", prompt: "pp", subagent_type: "Explore" },
      2.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-x", "Explore")).toEqual({
      description: "explore thing",
      prompt_chars: 2,
      tool_use_id: "toolu_explore",
    });
  });

  test("cross-session isolation: PreToolUse in sess-A invisible to sess-B lookup", () => {
    insertPre(
      1,
      "sess-A",
      "toolu_A",
      { description: "a thing", prompt: "p", subagent_type: "Explore" },
      1.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-B", "Explore")).toBeNull();
  });

  test("malformed JSON skipped, next matching row wins", () => {
    insertPre(1, "sess-x", "toolu_bad", null, 1.0);
    insertPre(
      2,
      "sess-x",
      "toolu_good",
      { description: "good", prompt: "p", subagent_type: "Explore" },
      2.0,
    );
    expect(
      findPendingPreToolUseForStart(db, "sess-x", "Explore")?.tool_use_id,
    ).toBe("toolu_good");
  });

  test("missing description in tool_input → result has description: null but tool_use_id set", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_nodesc",
      { prompt: "abc", subagent_type: "Explore" },
      1.0,
    );
    expect(findPendingPreToolUseForStart(db, "sess-x", "Explore")).toEqual({
      description: null,
      prompt_chars: 3,
      tool_use_id: "toolu_nodesc",
    });
  });

  test("missing prompt → prompt_chars: 0 (not null)", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_noprompt",
      { description: "d", subagent_type: "Explore" },
      1.0,
    );
    expect(
      findPendingPreToolUseForStart(db, "sess-x", "Explore")?.prompt_chars,
    ).toBe(0);
  });

  test("description over 200 chars truncates to DESCRIPTION_MAX_CHARS", () => {
    insertPre(
      1,
      "sess-x",
      "toolu_long",
      {
        description: "x".repeat(DESCRIPTION_MAX_CHARS + 50),
        prompt: "p",
        subagent_type: "Explore",
      },
      1.0,
    );
    expect(
      findPendingPreToolUseForStart(db, "sess-x", "Explore")?.description
        ?.length,
    ).toBe(DESCRIPTION_MAX_CHARS);
  });
});
