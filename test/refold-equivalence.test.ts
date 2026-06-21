/**
 * Re-fold equivalence harness — the correctness GATE for the
 * `fn-836-shed-event-blob-bloat-and-add-retention` epic.
 *
 * `.1` established this harness as the proof METHODOLOGY (simulating the future
 * shed by relocating into `event_blobs`). As of `.4` the shed has LANDED — the
 * v74 migration restored every keep-set body inline and DROPPED `event_blobs` —
 * so the harness now proves the POST-SHED reality directly: a from-scratch
 * re-fold over a SHED-SHAPED corpus reproduces byte-identical PROJECTION rows.
 *
 * The shed split the conflated `events.data` blob into its two real roles:
 *
 *   - the KEEP-SET — an explicit ALLOW-list of event types whose `data` BODY a
 *     LIVE fold reads (via `JSON.parse(event.data)` inside `applyEvent`). These
 *     stay inline in `events.data` forever; dropping their body breaks re-fold.
 *   - the SHED CLASS — PostToolUse bodies for the four mutation tools (Write /
 *     Edit / MultiEdit / NotebookEdit) whose ONLY fold consumption is the single
 *     scalar `tool_input.file_path`, promoted to the `mutation_path` column. The
 *     rest of the body is the redundant transcript archive — its `events.data`
 *     is NULL after the shed, and the fold never reads it.
 *
 * Four proof layers, cheapest first:
 *   (1) the keep-set ALLOW-list + an ENUMERATION test that asserts NO source site
 *       reads an event `data` body through the (now-dropped) `event_blobs` table —
 *       every fold-path read resolves straight from `events.data`;
 *   (2) a per-event AUDIT — the `mutation_path` column carries exactly the
 *       `tool_input.file_path` the git-attribution scan reads, for every mutation
 *       row, with the shed body NULL;
 *   (3) a LEGACY-SHAPE charter (legacy Agent `tool_response.agentId` fallback,
 *       malformed→null, old Commit/GitSnapshot shapes, the planctl Bash
 *       `tool_response.stdout` envelope);
 *   (4) the full DIFFERENTIAL RE-FOLD — over a SHED-shaped corpus (shed-class
 *       rows: `events.data IS NULL`, `mutation_path` set; keep-set rows inline),
 *       assert two from-scratch re-folds are byte-identical (re-fold determinism)
 *       AND that the post-shed attribution set reproduces every tool-sourced
 *       attribution the corpus implies.
 *
 * Scope of the byte-identical charter: the **deterministic-replayed** projection
 * class only. `git_status` + `file_attributions` (and the three `jobs` git-counter
 * columns) are the canonical **live-only** counter-example (fn-868, v79) — a
 * live-producer-fed surface that is boot-seeded + kept current above a skip-floor,
 * NOT replayed from history, and DELIBERATELY excluded from this charter via the
 * central `LIVE_ONLY_PROJECTIONS` / `LIVE_ONLY_JOBS_COLUMNS` registry (`src/db.ts`).
 * These differential tests deliberately LOWER the skip-floor to 0 before re-folding
 * (`UPDATE git_projection_state SET floor = 0`) so the historical git folds replay
 * and the shed's `mutation_path` preservation stays observable — the production
 * carve-out (the surface is never replayed) is asserted separately, not here.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countAbsentBlobs,
  RETENTION_SHED_CLASS_PREDICATE,
  RETENTION_SHED_PREDICATE,
  retainColdPayloads,
} from "../src/compaction";
import { openDb, SCHEMA_VERSION } from "../src/db";
import { extractMutationPath } from "../src/derivers";
import { drain } from "../src/reducer";
import { resolveBridgeAgentId } from "../src/subagent-invocations";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// The KEEP-SET ALLOW-list (the central proof obligation)
// ---------------------------------------------------------------------------

/**
 * The four PostToolUse tool names whose `data` body is SHED. Their ONLY fold
 * consumption is the scalar `tool_input.file_path` (promoted to the
 * `mutation_path` column in task .2). The body is never `JSON.parse`d inside
 * `applyEvent` for these (the PostToolUse arm gates `tool_name !== 'Agent'` and
 * returns; the bash/api-error/permission clear arm reads scalar columns only),
 * so dropping the body is lossless once `mutation_path` carries the file_path.
 */
const SHED_MUTATION_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * KEEP-SET: the explicit ALLOW-list of `hook_event` values whose `data` BODY a
 * live fold (`applyEvent`) parses. Every entry was verified against a fold read
 * in `src/reducer.ts` / `src/subagent-invocations.ts` (the enumeration test below
 * pins the reader sites). The shed NULLs only bodies in the widened shed-set
 * ({@link RETENTION_SHED_CLASS_PREDICATE}), whose complement is exactly this set.
 *
 * fn-837 widened the shed-set: BackendExecSnapshot / Notification / SubagentStart
 * / SubagentStop folds read CHEAP COLUMNS only (`backend_exec_*` / `event_type` /
 * `agent_id`), never the body, so they moved OUT of the keep-set into the shed.
 *
 * NOTE on the three PARTIALLY-kept tool hook_events (they stay in this set as a
 * hook_event because some `tool_name` slice of each is keep):
 *  - PostToolUse: body is keep-set for `tool_name='Agent'` only on a LEGACY row
 *    (`subagent_agent_id IS NULL` → `resolveBridgeAgentId` reads
 *    `tool_response.agentId`); modern Agent rows shed. Also keep for the cron
 *    tools (`tool_response.id` / `tool_input.id`) and planctl-op Bash rows
 *    (`extractPlanctlStateRepo` reads `tool_response.stdout`). The eight
 *    SHED_POSTTOOLUSE tools + non-planctl Bash + modern Agent are the carve-OUT.
 *  - PreToolUse: body keep-set for `tool_name='Agent'` (the bridge); every other
 *    PreToolUse tool body sheds.
 *  - PostToolUseFailure: body keep-set for `tool_name='Agent'` (legacy
 *    `tool_response.agentId` fallback); every other failure tool body sheds.
 */
const KEEP_SET_HOOK_EVENTS = new Set([
  // Snapshot / synthetic-event folds that JSON.parse(event.data) directly.
  "EpicSnapshot",
  "TaskSnapshot",
  "EpicDeleted",
  "TaskDeleted",
  "GitSnapshot",
  "GitRootDropped",
  "Commit",
  "UsageSnapshot",
  "UsageDeleted",
  "BuildSnapshot",
  "BuildDeleted",
  "DispatchFailed",
  "DispatchCleared",
  "Dispatched",
  "DispatchExpired",
  "AutopilotPaused",
  "AutopilotCapSet",
  "AutopilotMode",
  "EpicArmed",
  "TmuxPaneSnapshot",
  "WindowIndexSnapshot",
  "BackendExecStart",
  // Session / prompt / title folds.
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "TranscriptTitle",
  "Stop",
  "InputRequest",
  "RateLimited",
  "ApiError",
  "Killed",
  // Subagent lifecycle (PreToolUse:Agent body is read via the bridge).
  "SubagentTurn",
  "PreToolUse",
  // PostToolUse is keep-set for legacy Agent / cron / planctl-op Bash rows; the
  // eight shed tools + non-planctl Bash + modern Agent are the carve-out.
  "PostToolUse",
  "PostToolUseFailure",
]);

test("keep-set and shed-class are disjoint and exhaustively classify the mutation tools", () => {
  // The shed-mutation tool names must never be confused with a keep-set
  // hook_event — they are a tool_name carve-out WITHIN PostToolUse, not a
  // distinct hook_event. This guards a future refactor from accidentally
  // listing a mutation tool name as a keep-set hook_event (which would shed
  // nothing and defeat the whole epic).
  for (const tool of SHED_MUTATION_TOOLS) {
    expect(KEEP_SET_HOOK_EVENTS.has(tool)).toBe(false);
  }
  // The promoted column carries exactly the four mutation tools.
  expect([...SHED_MUTATION_TOOLS].sort()).toEqual([
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Write",
  ]);
});

test("the REAL widened shed predicate sheds the fold-unread classes and KEEPS every keep-set hook_event", () => {
  // Import the PRODUCTION predicate (not a test fiction) and assert its CHEAP-
  // COLUMN class gate matches exactly what a fold reads. A standalone events
  // table lets us evaluate the real SQL string against synthetic rows: a row is
  // "shed" iff the predicate selects it. This is the disjointness gate — the
  // keep-set complement IS the shed-set.
  const probe = new Database(":memory:");
  probe.run(
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, hook_event TEXT, tool_name TEXT,
       plan_op TEXT, subagent_agent_id TEXT, mutation_path TEXT, data TEXT
     )`,
  );
  const shedRow = (row: {
    hook_event: string;
    tool_name?: string | null;
    plan_op?: string | null;
    subagent_agent_id?: string | null;
    mutation_path?: string | null;
    data?: string | null;
  }): boolean => {
    probe.run("DELETE FROM events");
    probe.run(
      `INSERT INTO events (hook_event, tool_name, plan_op, subagent_agent_id, mutation_path, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.hook_event,
        row.tool_name ?? null,
        row.plan_op ?? null,
        row.subagent_agent_id ?? null,
        row.mutation_path ?? null,
        row.data ?? "{}",
      ],
    );
    return (
      (
        probe
          .query(
            `SELECT COUNT(*) AS n FROM events WHERE ${RETENTION_SHED_PREDICATE}`,
          )
          .get() as { n: number }
      ).n === 1
    );
  };

  // SHED classes (cheap-column allow-list). Every mutation-tool row carries
  // mutation_path so the backfill guard does not re-keep it.
  for (const tool of [
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "WebFetch",
    "Skill",
    "ToolSearch",
  ]) {
    expect({
      tool,
      shed: shedRow({
        hook_event: "PostToolUse",
        tool_name: tool,
        mutation_path: "/repo/x.ts",
      }),
    }).toEqual({ tool, shed: true });
  }
  expect(
    shedRow({ hook_event: "PostToolUse", tool_name: "Bash", plan_op: null }),
  ).toBe(true); // non-planctl Bash sheds
  expect(
    shedRow({
      hook_event: "PostToolUse",
      tool_name: "Agent",
      subagent_agent_id: "agent-modern",
    }),
  ).toBe(true); // modern Agent sheds
  expect(shedRow({ hook_event: "PreToolUse", tool_name: "Bash" })).toBe(true);
  expect(shedRow({ hook_event: "PostToolUseFailure", tool_name: "Read" })).toBe(
    true,
  );
  for (const he of [
    "SubagentStart",
    "SubagentStop",
    "BackendExecSnapshot",
    "Notification",
  ]) {
    expect({ he, shed: shedRow({ hook_event: he }) }).toEqual({
      he,
      shed: true,
    });
  }

  // KEEP — the three exact inversions (a flip here is a silent re-fold break).
  expect(
    shedRow({
      hook_event: "PostToolUse",
      tool_name: "Bash",
      plan_op: "done",
    }),
  ).toBe(false); // planctl Bash KEPT (state_repo fold-read)
  expect(
    shedRow({
      hook_event: "PostToolUse",
      tool_name: "Agent",
      subagent_agent_id: null,
    }),
  ).toBe(false); // legacy Agent KEPT (agentId fold-read)
  expect(shedRow({ hook_event: "PreToolUse", tool_name: "Agent" })).toBe(false); // bridge body
  expect(
    shedRow({ hook_event: "PostToolUseFailure", tool_name: "Agent" }),
  ).toBe(false); // legacy failure agentId
  // A backfill-owing mutation row (mutation_path NULL, body carries file_path)
  // is KEPT by the json_extract guard even though its class is shed.
  expect(
    shedRow({
      hook_event: "PostToolUse",
      tool_name: "Write",
      mutation_path: null,
      data: JSON.stringify({ tool_input: { file_path: "/repo/owes.ts" } }),
    }),
  ).toBe(false);

  // Every keep-set hook_event with NO tool_name (snapshot/synthetic/session) is
  // KEPT — the shed-set never lists them.
  for (const he of KEEP_SET_HOOK_EVENTS) {
    if (
      he === "PostToolUse" ||
      he === "PreToolUse" ||
      he === "PostToolUseFailure"
    ) {
      continue; // partially-kept tool events covered above
    }
    expect({ he, shed: shedRow({ hook_event: he }) }).toEqual({
      he,
      shed: false,
    });
  }

  // A NEW/unlisted event type defaults to KEPT (fail-safe — positive allow-list).
  expect(shedRow({ hook_event: "SomeFutureEvent", tool_name: "NewTool" })).toBe(
    false,
  );

  probe.close();
});

test("the class predicate (cheap-cols) carries no json parse — countAbsentBlobs never re-parses a NULL body", () => {
  // The class predicate is the cheap-column allow-list ONLY. It must contain
  // neither json_extract nor json_valid — those live solely in the full
  // RETENTION_SHED_PREDICATE's mutation-tool backfill guard. countAbsentBlobs
  // reuses the CLASS predicate inside its NOT(), so it can classify a row whose
  // body is already NULL without re-parsing the (gone) body.
  expect(RETENTION_SHED_CLASS_PREDICATE).not.toContain("json_extract");
  expect(RETENTION_SHED_CLASS_PREDICATE).not.toContain("json_valid");
  // The full predicate DOES carry the lone json_extract (the backfill guard).
  expect(RETENTION_SHED_PREDICATE).toContain("json_extract");
});

test("broad per-event body folds lose nothing when a shed-class body is NULLed (no session_title / prompt / transcript_path)", () => {
  // The session-title fold (`extractSessionTitle`) runs on ANY event and reads
  // top-level `session_title` from `event.data`; the prompt / transcript folds
  // similarly read top-level `prompt` / `transcript_path`. After the shed a
  // mutation row's body is NULL, so these folds read null. That is LOSSLESS
  // ONLY IF a shed-class PostToolUse mutation body never carries those top-level
  // fields. A mutation tool's payload is `{tool_input, tool_response}` — the
  // three broad-read top-level keys are structurally absent. This is the
  // correctness gate that makes the shed safe for the broad per-event readers
  // (NOT just the git-attribution scan). If a future Claude Code payload added
  // a top-level `session_title` to a mutation tool, this assertion would force
  // re-classifying that tool out of the shed.
  const mutationBody = JSON.stringify({
    tool_input: { file_path: "/repo/x.ts", content: "..." },
    tool_response: { ok: true, filePath: "/repo/x.ts" },
  });
  const parsed = JSON.parse(mutationBody) as Record<string, unknown>;
  expect(parsed.session_title).toBeUndefined();
  expect(parsed.prompt).toBeUndefined();
  expect(parsed.transcript_path).toBeUndefined();
  // The only top-level keys a mutation body carries are tool_input/tool_response
  // — neither is read by any keep-set fold for a non-Agent mutation row (the
  // file_path inside tool_input is promoted to the mutation_path column).
  expect(Object.keys(parsed).sort()).toEqual(["tool_input", "tool_response"]);
});

// ---------------------------------------------------------------------------
// Blob-reader ENUMERATION — assert no fold reads a SHED-class event body
// ---------------------------------------------------------------------------

/**
 * Read a source file from the repo root (tests run with cwd = repo root). The
 * enumeration asserts over SOURCE TEXT so a NEW blob-reader added in a later
 * task is forced through this classification gate (the test fails until the
 * author classifies the new reader keep vs shed).
 */
function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

test("no fold-path reader touches the dropped event_blobs table; every body read resolves from events.data", () => {
  // POST-SHED (fn-836.4): `event_blobs` is DROPPED, so NO fold-path reader may
  // JOIN it. The four fold-path body readers now resolve straight from
  // `events.data`. Each needle pins the post-shed query so a regression
  // (re-adding a COALESCE/JOIN, or moving the reader) fails here.
  const foldPathReaders: Array<{
    file: string;
    needle: string;
    why: string;
  }> = [
    {
      file: "src/reducer.ts",
      needle: "stop_hook_active, data,",
      why: "main drain reads events.data inline; shed-class arm ignores the body",
    },
    {
      file: "src/subagent-invocations.ts",
      needle: "SELECT data\n         FROM events e",
      why: "PreToolUse:Agent bridge body — Agent is keep-set, body inline",
    },
    {
      file: "src/subagent-invocations.ts",
      needle: "SELECT e.tool_use_id, e.data AS data",
      why: "pending PreToolUse:Agent FIFO bridge body — keep-set, inline",
    },
    {
      file: "cli/search-history.ts",
      needle: "json_extract(events.data, '$.prompt')",
      why: "search-history reads UserPromptSubmit $.prompt inline — keep-set",
    },
  ];
  for (const r of foldPathReaders) {
    const src = readSrc(r.file);
    expect({ file: r.file, present: src.includes(r.needle) }).toEqual({
      file: r.file,
      present: true,
    });
  }

  // The git-attribution tool scan SEEKs the `mutation_path` column (ARM B and
  // its `event_blobs` rowid-join were deleted in .3), and the reducer touches
  // `event_blobs` nowhere.
  const reducerSrc = readSrc("src/reducer.ts");
  expect(reducerSrc).toContain("AND mutation_path = ?");

  // Count NON-COMMENT lines that JOIN `event_blobs`. The fold-path files
  // (reducer, subagent bridges, search-history, the mutation_path backfill) must
  // be ZERO — the shed dropped every body read there. `db.ts` (the v57 ladder
  // CREATE + the v67 Commit-trailer backfill read, both historical migration
  // steps that run against the transiently-recreated table on a fresh walk) still
  // references it and is exempt. (`compaction.ts` was the relocator/sentinel; .5
  // retired it into the retention pass, which NULLs `events.data` in place and no
  // longer touches `event_blobs` at all.) Comment lines are stripped so a doc
  // mention never inflates the count.
  const countSqlJoins = (file: string): number => {
    const lines = readSrc(file).split("\n");
    let n = 0;
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }
      if (
        line.includes("LEFT JOIN event_blobs") ||
        line.includes("FROM event_blobs") ||
        line.includes("JOIN event_blobs")
      ) {
        n += 1;
      }
    }
    return n;
  };

  // Fold-path files: ZERO event_blobs JOINs post-shed.
  const foldPathFiles = [
    "src/reducer.ts",
    "src/subagent-invocations.ts",
    "cli/search-history.ts",
    "src/backfill-mutation-path.ts",
  ];
  for (const file of foldPathFiles) {
    expect({ file, n: countSqlJoins(file) }).toEqual({ file, n: 0 });
  }
  // Migration-internal event_blobs sites in db.ts stay (historical/destructive,
  // NOT fold-path): the v67 Commit-trailer backfill `LEFT JOIN event_blobs` (1)
  // + the v74 tail restore's two `FROM event_blobs` subqueries (the keep-set
  // restore SELECT + its EXISTS guard) (2) + the v74 tail mutation_path-capture's
  // two `FROM event_blobs` subqueries (the json_valid + json_extract COALESCE that
  // rescues a relocated shed-class `tool_input.file_path` into `mutation_path`
  // BEFORE the DROP — the fn-836 hardening) (2) = 5. All run during migrate(),
  // before the unconditional tail DROP; none is a fold-path read. The v57 ladder
  // CREATE and the tail DROPs are not JOIN/FROM body-reads, so they don't count.
  expect({
    file: "src/db.ts",
    n: countSqlJoins("src/db.ts"),
  }).toEqual({
    file: "src/db.ts",
    n: 5,
  });
});

// ---------------------------------------------------------------------------
// Shed-shaped corpus seeding (shed-class rows: data IS NULL, mutation_path set;
// keep-set rows: body inline in events.data — the post-shed live shape)
// ---------------------------------------------------------------------------

let tsCounter = 5_000;

/** Insert one raw event row with the full column set the fold reads. */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  event_type?: string | null;
  tool_name?: string | null;
  cwd?: string | null;
  ts?: number;
  data?: string | null;
  subagent_agent_id?: string | null;
  tool_use_id?: string | null;
  agent_id?: string | null;
  agent_type?: string | null;
  plan_op?: string | null;
  plan_target?: string | null;
  plan_files?: string | null;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  const data = overrides.data ?? "{}";
  // Derive `mutation_path` (the v73 promoted column) from `data` the SAME way
  // the live hook does, so a seeded mutation row carries the column BEFORE the
  // body is shed — the post-shed git-attribution scan reads the column, not the
  // body. A no-file_path body folds to NULL here, matching the forward deriver.
  let mutationPath: string | null = null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      mutationPath = extractMutationPath(
        overrides.hook_event,
        overrides.tool_name ?? null,
        parsed as Record<string, unknown>,
      );
    }
  } catch {
    mutationPath = null;
  }
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, cwd, data,
       subagent_agent_id, tool_use_id, agent_id, agent_type, plan_op,
       plan_target, plan_files, mutation_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? "sess-a",
      4242,
      overrides.hook_event,
      overrides.event_type ?? overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? "/tmp/work",
      data,
      overrides.subagent_agent_id ?? null,
      overrides.tool_use_id ?? null,
      overrides.agent_id ?? null,
      overrides.agent_type ?? null,
      overrides.plan_op ?? null,
      overrides.plan_target ?? null,
      overrides.plan_files ?? null,
      mutationPath,
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

function drainAll(): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db);
    total += n;
  } while (n > 0);
  return total;
}

const REPO = "/repo";
const SESS_A = "01234567-89ab-cdef-0123-456789abcdef";
const SESS_B = "fedcba98-7654-3210-fedc-ba9876543210";
const OID = "0123456789abcdef0123456789abcdef01234567";

/**
 * Seed a corpus that exercises EVERY path the shed touches:
 *  - a DISCHARGED mutation (cold.ts, committed clean) whose file_path is needed
 *    on re-fold (the Commit replays AFTER the GitSnapshot — see the reducer's
 *    "currently-discharged ⇒ safe to drop is FALSE" comment), now served by
 *    `mutation_path` not the shed body;
 *  - an UNDISCHARGED mutation (live.ts, never committed) — stays live;
 *  - an Edit and a NotebookEdit (the other shed tools) so the file_path
 *    promotion covers all four;
 *  - a no-file_path mutation (mutation_path NULL → skipped);
 *  - keep-set bodies that MUST survive inline: a PreToolUse:Agent bridge, a
 *    planctl Bash stdout envelope, a UserPromptSubmit, a Commit.
 */
function seedLiveShapedCorpus(): void {
  insertEvent({ hook_event: "SessionStart", session_id: SESS_A });
  insertEvent({ hook_event: "SessionStart", session_id: SESS_B });

  // A keep-set UserPromptSubmit body (search-history reads $.prompt).
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: SESS_A,
    data: JSON.stringify({ prompt: "do the thing", session_title: "t" }),
  });

  // COLD: session A writes cold.ts (Write), then commits it clean.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: SESS_A,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { file_path: `${REPO}/cold.ts`, content: "x".repeat(200) },
      tool_response: { ok: true },
    }),
  });
  // An Edit on a second cold file (covers the Edit shed tool).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: SESS_A,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { file_path: `${REPO}/edited.ts`, content: "y".repeat(200) },
    }),
  });
  // A NotebookEdit (covers the NotebookEdit shed tool).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "NotebookEdit",
    session_id: SESS_A,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { file_path: `${REPO}/nb.ipynb`, content: "z".repeat(200) },
    }),
  });

  // LIVE: session B writes live.ts, never commits.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: SESS_B,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { file_path: `${REPO}/live.ts`, content: "w".repeat(200) },
    }),
  });

  // A mutation body with NO file_path (MultiEdit) → mutation_path null → no
  // attribution, on both the pre- and post-shed paths (folds the same). Its body
  // is shed (NULLed) like every other shed-class row; with no file_path it never
  // contributed an attribution, so the shed is lossless for it.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "MultiEdit",
    session_id: SESS_B,
    cwd: REPO,
    data: JSON.stringify({ tool_input: { no_file: "here" } }),
  });

  // A keep-set PreToolUse:Agent body (the subagent bridge reads it).
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    session_id: SESS_A,
    tool_use_id: "tu-1",
    agent_type: "worker",
    data: JSON.stringify({
      tool_input: {
        subagent_type: "worker",
        description: "spawn a worker",
        prompt: "go",
      },
    }),
  });

  // GitSnapshot: every dirty file gets an attribution row.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: REPO,
    cwd: REPO,
    data: JSON.stringify({
      project_dir: REPO,
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "cold.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
        {
          path: "edited.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
        {
          path: "nb.ipynb",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
        {
          path: "live.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
      ],
    }),
  });

  // Commit discharges cold.ts ONLY (session A). live.ts stays on the hook.
  insertEvent({
    hook_event: "Commit",
    session_id: REPO,
    cwd: REPO,
    data: JSON.stringify({
      project_dir: REPO,
      commit_oid: OID,
      parent_oid: null,
      files: ["cold.ts"],
      committer_session_id: SESS_A,
      committed_at_ms: 200_000,
    }),
  });

  // Filler so cold ids sit well below the recent-retention window.
  for (let i = 0; i < 30; i++) {
    insertEvent({ hook_event: "Stop", session_id: SESS_A });
  }
}

/** Snapshot the projections the shed could affect, ordered for byte-diff. */
function snapshotProjections() {
  return {
    file_attributions: db
      .query(
        "SELECT project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
    git_status: db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    jobs: db.query("SELECT * FROM jobs ORDER BY job_id").all(),
    epics: db.query("SELECT * FROM epics ORDER BY epic_id").all(),
    subagent_invocations: db
      .query(
        "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
      )
      .all(),
    usage: db.query("SELECT * FROM usage ORDER BY rowid").all(),
    commit_trailer_facts: db
      .query("SELECT * FROM commit_trailer_facts ORDER BY event_id")
      .all(),
  };
}

/**
 * SHED the corpus into its post-fn-837 live shape by driving the PRODUCTION
 * retention path — {@link retainColdPayloads} importing the REAL widened
 * predicate, watermark, cursor gate, and backfill guard. This is NOT a test
 * fiction: it exercises exactly the SQL the daemon runs. `recentRetentionMargin`
 * is 0 so the whole cold-and-past-cursor tail is eligible; `incrementalVacuumPages`
 * is 0 because the mem template DB is not `auto_vacuum=INCREMENTAL`.
 *
 * Returns the {@link RetentionResult} so callers can assert the shed actually
 * fired over the seeded shed-class rows.
 */
function shedCorpus(): ReturnType<typeof retainColdPayloads> {
  const result = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(result.shed).toBeGreaterThan(0);
  return result;
}

function rewindAndWipeProjections(): void {
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  db.run("DELETE FROM usage");
  db.run("DELETE FROM commit_trailer_facts");
  // Reset the LIVE-ONLY git skip-floor to 0 alongside the cursor rewind. In
  // PRODUCTION the git surface (`git_status`/`file_attributions`/the 3 jobs
  // git-counters) is live-only and a rewind leaves it to the boot-seed — but
  // these charter tests deliberately REPLAY the historical git folds to assert
  // the SHED preserves what the git-attribution scan reads (the fn-836/837
  // `mutation_path` mechanism). Resetting the floor reopens that replay, so the
  // two from-scratch re-folds stay byte-identical across the FULL projection set
  // (including the live surface). The separate enumeration test
  // (`charter excludes the live-only surface`) covers the production carve-out.
  db.run("UPDATE git_projection_state SET floor = 0 WHERE id = 1");
}

// ---------------------------------------------------------------------------
// Layer 1 — aggregate counts over the live-shaped corpus
// ---------------------------------------------------------------------------

test("shed-shaped corpus: every shed-class body is NULL, every keep-set body stays inline", () => {
  seedLiveShapedCorpus();
  drainAll();
  shedCorpus();

  // Every shed-class mutation row has its body NULLed — the post-shed shape.
  // cold.ts(Write) + edited.ts(Edit) + nb.ipynb(NotebookEdit) + live.ts(Write)
  // + the no-file_path MultiEdit = 5 mutation rows, all shed.
  const shedMutations = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND data IS NULL`,
      )
      .get() as { n: number }
  ).n;
  expect(shedMutations).toBe(5);

  // The keep-set bodies stay INLINE — the fold reads them from events.data on a
  // from-scratch re-fold (no side table to resolve them from anymore).
  const inlineKeepBodies = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
          WHERE data IS NOT NULL
            AND hook_event IN ('UserPromptSubmit','PreToolUse','GitSnapshot','Commit')`,
      )
      .get() as { n: number }
  ).n;
  expect(inlineKeepBodies).toBeGreaterThan(0);

  // The four well-formed shed-class rows kept their promoted mutation_path even
  // though the body is gone; the no-file_path MultiEdit has NULL mutation_path.
  const mp = db
    .query(
      `SELECT mutation_path FROM events
        WHERE hook_event = 'PostToolUse'
          AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        ORDER BY id`,
    )
    .all() as Array<{ mutation_path: string | null }>;
  expect(mp.filter((r) => r.mutation_path !== null).length).toBe(4);
});

// ---------------------------------------------------------------------------
// Layer 2 — per-event audit (mutation_path == file_path, with the body shed)
// ---------------------------------------------------------------------------

test("per-event audit: mutation_path carries the file_path the git-attribution scan reads, body shed", () => {
  seedLiveShapedCorpus();
  drainAll();
  shedCorpus();

  // POST-SHED: the body is NULL for every shed-class row; the file_path the
  // git-attribution scan reads now lives ONLY in `mutation_path`. The audit
  // proves the column carries exactly what the forward deriver
  // (`extractMutationPath`) produces from the original body — the value the scan
  // SEEKs — for every mutation row, with the body genuinely gone.
  const rows = db
    .query(
      `SELECT id, tool_name, data, mutation_path
         FROM events
        WHERE hook_event = 'PostToolUse'
          AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    tool_name: string;
    data: string | null;
    mutation_path: string | null;
  }>;

  expect(rows.length).toBe(5);
  for (const r of rows) {
    // The body is genuinely shed — there is nothing left to read but the column.
    expect(r.data).toBeNull();
  }

  // The no-file_path MultiEdit row has a NULL mutation_path — no attribution,
  // shed-safe (it never contributed one).
  const noFile = rows.find((r) => r.mutation_path === null);
  expect(noFile).not.toBeUndefined();
  expect(noFile?.tool_name).toBe("MultiEdit");

  // The four well-formed mutation rows carry their absolute file_path.
  const resolved = rows
    .filter((r) => r.mutation_path !== null)
    .map((r) => r.mutation_path)
    .sort();
  expect(resolved).toEqual([
    `${REPO}/cold.ts`,
    `${REPO}/edited.ts`,
    `${REPO}/live.ts`,
    `${REPO}/nb.ipynb`,
  ]);
});

// ---------------------------------------------------------------------------
// Layer 3 — legacy-shape charter
// ---------------------------------------------------------------------------

test("legacy charter: Agent tool_response.agentId fallback resolves (the pre-fn-390 shape)", () => {
  // Pre-fn-390 PostToolUse:Agent rows have NULL subagent_agent_id but carry
  // `data.tool_response.agentId`. The bridge fallback must still resolve it —
  // Agent is keep-set, so the body survives the shed. The string form (stdout
  // serialized as a JSON string) is also accepted.
  expect(
    resolveBridgeAgentId({
      subagent_agent_id: null,
      data: JSON.stringify({ tool_response: { agentId: "agent-legacy" } }),
    }),
  ).toBe("agent-legacy");
  expect(
    resolveBridgeAgentId({
      subagent_agent_id: null,
      data: JSON.stringify({
        tool_response: JSON.stringify({ agentId: "agent-str" }),
      }),
    }),
  ).toBe("agent-str");
  // Modern shape: the indexed column wins, no body read needed.
  expect(
    resolveBridgeAgentId({ subagent_agent_id: "agent-modern", data: "{}" }),
  ).toBe("agent-modern");
});

test("legacy charter: malformed / missing agentId folds to null (never throws)", () => {
  expect(
    resolveBridgeAgentId({ subagent_agent_id: null, data: "{ not json" }),
  ).toBeNull();
  expect(
    resolveBridgeAgentId({
      subagent_agent_id: null,
      data: JSON.stringify({ tool_response: { other: 1 } }),
    }),
  ).toBeNull();
  expect(
    resolveBridgeAgentId({ subagent_agent_id: null, data: "{}" }),
  ).toBeNull();
});

test("legacy charter: planctl Bash tool_response.stdout envelope folds; malformed body does not throw", () => {
  // The planctl plan-invocation fold reads `tool_response.stdout` from a
  // PostToolUse:Bash body — a keep-set read (gated on plan_op + plan_files
  // sparse columns, so it never touches a shed-class body). A well-shaped
  // envelope mints; a malformed body folds safe with the cursor advancing.
  insertEvent({ hook_event: "SessionStart", session_id: SESS_A });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: SESS_A,
    cwd: REPO,
    plan_op: "done",
    plan_target: "fn-1-x.1",
    plan_files: JSON.stringify([".planctl/tasks/fn-1-x.1.md"]),
    data: JSON.stringify({
      tool_response: {
        stdout: JSON.stringify({
          plan_invocation: { state_repo: REPO },
        }),
      },
    }),
  });
  // A malformed planctl Bash body must NOT wedge the fold.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: SESS_A,
    cwd: REPO,
    plan_op: "done",
    plan_target: "fn-1-x.2",
    plan_files: JSON.stringify([".planctl/tasks/fn-1-x.2.md"]),
    data: "{ not json",
  });
  expect(() => drainAll()).not.toThrow();
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBeGreaterThan(0);
});

test("legacy charter: a malformed GitSnapshot / Commit body folds safe (cursor advances, no projection corruption)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: SESS_A });
  // Malformed GitSnapshot — must not throw; no git_status / attribution rows.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: REPO,
    cwd: REPO,
    data: "{ broken",
  });
  // Malformed Commit — must not throw; no commit_trailer_facts row.
  insertEvent({
    hook_event: "Commit",
    session_id: REPO,
    cwd: REPO,
    data: "also broken",
  });
  expect(() => drainAll()).not.toThrow();
  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM commit_trailer_facts").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
});

// ---------------------------------------------------------------------------
// Layer 4 — the full DIFFERENTIAL RE-FOLD (old path vs new mutation_path column)
// ---------------------------------------------------------------------------

test("differential re-fold: two from-scratch re-folds over a SHED corpus are byte-identical; attributions reproduced from mutation_path", () => {
  seedLiveShapedCorpus();
  drainAll();
  shedCorpus();

  // BASELINE: a from-scratch re-fold over the SHED corpus (shed-class bodies
  // NULL, mutation_path set; keep-set bodies inline). This is the production
  // fold post-v74 — the git-attribution scan SEEKs `mutation_path`, the
  // keep-set arms read inline `events.data`, nothing touches a side table.
  rewindAndWipeProjections();
  drainAll();
  const shed1 = snapshotProjections();

  // Sanity: cold.ts discharged (last_commit_at set), live.ts still live — the
  // discharged-mutation case the shed must preserve. On re-fold the Commit
  // replays AFTER the GitSnapshot and the scan needs cold.ts's file_path; it now
  // comes from `mutation_path` (the body is shed). The attribution row keys on
  // the GitSnapshot's REPO-RELATIVE path (`cold.ts`), not the absolute
  // `tool_input.file_path` the scan matched on.
  const attribs = shed1.file_attributions as Array<Record<string, unknown>>;
  const cold = attribs.find(
    (a) => a.file_path === "cold.ts" && a.session_id === SESS_A,
  );
  const live = attribs.find(
    (a) => a.file_path === "live.ts" && a.session_id === SESS_B,
  );
  expect(cold).not.toBeUndefined();
  expect(live).not.toBeUndefined();
  expect(cold?.last_commit_at).not.toBeNull();
  expect(live?.last_commit_at).toBeNull();
  // All four dirty files got tool-sourced attributions — proving the
  // `mutation_path` column served every shed mutation's file_path over the shed
  // corpus (the no-file_path MultiEdit row has NULL mutation_path → no attribution).
  const toolFiles = attribs
    .filter((a) => a.source === "tool")
    .map((a) => a.file_path)
    .sort();
  expect(toolFiles).toEqual(["cold.ts", "edited.ts", "live.ts", "nb.ipynb"]);

  // RE-FOLD DETERMINISM (the sacred invariant): a SECOND from-scratch re-fold
  // over the identical shed corpus reproduces byte-identical projection rows.
  rewindAndWipeProjections();
  drainAll();
  const shed2 = snapshotProjections();
  expect(shed2).toEqual(shed1);

  // ATTRIBUTION SOURCE: every tool-sourced attribution is reproducible from the
  // `mutation_path` column alone (no body read). The column carries the
  // mutation's ABSOLUTE `tool_input.file_path`; the attribution row keys on the
  // git-RELATIVE path, so reconstruct the absolute candidate the scan matched on
  // as `project_dir + '/' + file_path` (the exact lexical join
  // `findExplicitAttributions` does) and compare in the same key space.
  const columnCandidates = new Set(
    (
      db
        .query(
          `SELECT DISTINCT session_id, mutation_path AS abs_path
             FROM events
            WHERE hook_event = 'PostToolUse'
              AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
              AND mutation_path IS NOT NULL`,
        )
        .all() as Array<{ session_id: string; abs_path: string }>
    ).map((r) => `${r.session_id}::${r.abs_path}`),
  );
  const toolAttributions = new Set(
    (shed1.file_attributions as Array<Record<string, unknown>>)
      .filter((a) => a.source === "tool")
      .map((a) => `${a.session_id}::${a.project_dir}/${a.file_path}`),
  );
  expect(toolAttributions.size).toBeGreaterThan(0);
  for (const key of toolAttributions) {
    expect(columnCandidates.has(key)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Layer 5 — the WIDENED shed-set (fn-837): one row per newly-shed class + each
// guarded edge case, proving pre-shed P0 === post-shed re-fold P1 === P2 AND
// countAbsentBlobs == 0. The shed is driven through the PRODUCTION retention
// path (retainColdPayloads), so the proof exercises the real predicate/cursor/
// watermark, not a hardcoded UPDATE.
// ---------------------------------------------------------------------------

const SESS_C = "11111111-2222-3333-4444-555555555555";
const SESS_D = "66666666-7777-8888-9999-aaaaaaaaaaaa";

/**
 * Seed a corpus spanning EVERY newly-shed class beside its KEPT guarded sibling:
 *  - planctl Bash (KEEP, mints a source='plan' file_attribution) beside a
 *    non-planctl Bash (SHED);
 *  - modern PostToolUse:Agent `subagent_agent_id` (SHED) beside a legacy
 *    NULL-id Agent (KEEP — the bridge resolves its `tool_response.agentId`);
 *  - PreToolUse:Agent (KEEP — the bridge body) beside a PreToolUse:Bash (SHED);
 *  - PostToolUseFailure:Agent (KEEP) beside a PostToolUseFailure:Read (SHED);
 *  - SubagentStart + SubagentStop (SHED — cheap-column folds) for a full turn;
 *  - a Notification `event_type='permission_prompt'` (SHED — the fold reads the
 *    event_type column, stamping jobs.last_permission_prompt_*);
 *  - PostToolUse Read/WebFetch/Skill/ToolSearch + BackendExecSnapshot (SHED);
 *  - a Cron CronCreate (KEEP — scheduled_tasks reproduces from the body);
 *  - a malformed shed-class body (safe default, cursor advances);
 *  - a shed-class row carrying a top-level session_title/prompt/transcript_path
 *    a broad fold could read — proving the body is NOT read post-shed.
 */
function seedWidenedShedCorpus(): void {
  insertEvent({ hook_event: "SessionStart", session_id: SESS_C });
  insertEvent({ hook_event: "SessionStart", session_id: SESS_D });

  // --- planctl Bash (KEEP) beside non-planctl Bash (SHED) ---
  // planctl Bash: extractPlanctlStateRepo reads tool_response.stdout → KEEP.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: SESS_C,
    cwd: REPO,
    plan_op: "done",
    plan_target: "fn-9-z.1",
    plan_files: JSON.stringify([".planctl/tasks/fn-9-z.1.md"]),
    data: JSON.stringify({
      tool_response: {
        stdout: JSON.stringify({ plan_invocation: { state_repo: REPO } }),
      },
    }),
  });
  // non-planctl Bash: no fold reads its body → SHED. Real tool bodies carry only
  // {tool_input, tool_response} — never a top-level session_title (the lone
  // EVERY-event broad reader), which is exactly why the shed is lossless. The
  // structural-keys test ("broad per-event body folds lose nothing…") pins that
  // invariant; planting a session_title here would be a fiction (a body shape
  // that never occurs) and would correctly diverge on re-fold.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: SESS_C,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { command: "ls" },
      tool_response: { stdout: "x" },
    }),
  });

  // --- modern Agent (SHED) beside legacy NULL-id Agent (KEEP) ---
  // A SubagentStart so both Agent close-arms have a turn-0 row to resolve.
  insertEvent({
    hook_event: "SubagentStart",
    session_id: SESS_C,
    agent_id: "agent-modern",
    agent_type: "worker",
  });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: SESS_C,
    agent_id: "agent-legacy",
    agent_type: "worker",
  });
  // modern PostToolUse:Agent — resolves via the subagent_agent_id column → SHED.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    session_id: SESS_C,
    subagent_agent_id: "agent-modern",
    tool_use_id: "tu-modern",
    data: JSON.stringify({ tool_response: { ok: true } }),
  });
  // legacy PostToolUse:Agent — NULL subagent_agent_id, resolves via the body
  // `tool_response.agentId` → KEEP (body must survive the shed).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    session_id: SESS_C,
    subagent_agent_id: null,
    tool_use_id: "tu-legacy",
    data: JSON.stringify({ tool_response: { agentId: "agent-legacy" } }),
  });
  // SubagentStop for the modern turn — cheap-column fold (agent_id) → SHED.
  insertEvent({
    hook_event: "SubagentStop",
    session_id: SESS_C,
    agent_id: "agent-modern",
  });

  // --- PreToolUse:Agent (KEEP) beside PreToolUse:Bash (SHED) ---
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    session_id: SESS_D,
    tool_use_id: "tu-pre",
    agent_type: "scout",
    data: JSON.stringify({
      tool_input: { subagent_type: "scout", description: "look", prompt: "go" },
    }),
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: SESS_D,
    data: JSON.stringify({ tool_input: { command: "echo hi" } }),
  });

  // --- PostToolUseFailure:Agent (KEEP) beside PostToolUseFailure:Read (SHED) ---
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    session_id: SESS_D,
    subagent_agent_id: "agent-fail",
    data: JSON.stringify({ tool_response: { agentId: "agent-fail" } }),
  });
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Read",
    session_id: SESS_D,
    data: JSON.stringify({ tool_input: { file_path: "/repo/r.ts" } }),
  });

  // --- The pure cheap-column / no-fold-read shed classes ---
  // Each carries a top-level `prompt` + `transcript_path` to PROVE those folds
  // don't read a shed-class body: `extractPrompt` runs ONLY inside the
  // Notification arm and `extractTranscriptPath` ONLY on SessionStart, so a
  // PostToolUse:Read body's copies are never read — re-fold stays byte-identical.
  for (const tool of ["Read", "WebFetch", "Skill", "ToolSearch"]) {
    insertEvent({
      hook_event: "PostToolUse",
      tool_name: tool,
      session_id: SESS_C,
      data: JSON.stringify({
        prompt: "SHOULD NEVER BE READ",
        transcript_path: "/SHOULD/NEVER/READ",
        tool_input: { q: "x" },
        tool_response: { ok: true },
      }),
    });
  }
  insertEvent({
    hook_event: "BackendExecSnapshot",
    session_id: SESS_C,
    data: JSON.stringify({ note: "shed cheap-column fold" }),
  });

  // --- Cron CronCreate (KEEP — scheduled_tasks reproduces from the body) ---
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "CronCreate",
    session_id: SESS_C,
    data: JSON.stringify({
      tool_input: { cron: "0 9 * * *", prompt: "daily" },
      tool_response: { id: "cron-1" },
    }),
  });

  // --- A malformed shed-class body (safe default; cursor advances) ---
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Read",
    session_id: SESS_C,
    data: "{ not json",
  });

  // --- Notification (SHED) — the fold stamps from the event_type column ---
  // LAST on SESS_C: a downstream Pre/PostToolUse tool event on the same session
  // clears the permission-prompt stamp (the "dialog dismissed" inference), so the
  // stamp survives to the snapshot only when no later SESS_C tool event follows.
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: SESS_C,
    data: JSON.stringify({ message: "SHOULD NEVER BE READ" }),
  });

  // Filler keep-set events so every seeded shed-class row sits strictly below
  // the fold cursor AND the recent window after a full drain. Routed to a
  // DEDICATED filler session so a Stop never clears SESS_C's
  // last_permission_prompt_* stamp (the Stop arm clears it session-locally).
  const FILLER = "ffffffff-0000-1111-2222-333333333333";
  insertEvent({ hook_event: "SessionStart", session_id: FILLER });
  for (let i = 0; i < 30; i++) {
    insertEvent({ hook_event: "Stop", session_id: FILLER });
  }
}

/** Snapshot every projection the widened shed could touch (adds scheduled_tasks). */
function snapshotWidenedProjections() {
  return {
    ...snapshotProjections(),
    scheduled_tasks: db
      .query("SELECT * FROM scheduled_tasks ORDER BY job_id, cron_id")
      .all(),
  };
}

test("widened shed: pre-shed P0 === post-shed re-fold P1 === P2, countAbsentBlobs==0, over every newly-shed class + each guarded edge case", () => {
  seedWidenedShedCorpus();

  // P0 — the PRE-shed projection (every body inline). This is the ground truth
  // the post-shed re-folds must reproduce byte-identically.
  drainAll();
  const p0 = snapshotWidenedProjections();

  // Guarded-pair sanity on P0 (the inversions resolved the KEPT siblings):
  // both Agent close-arms resolved their turn-0 row to status terminal/ok.
  const p0Subs = p0.subagent_invocations as Array<Record<string, unknown>>;
  const modern = p0Subs.find((r) => r.agent_id === "agent-modern");
  const legacy = p0Subs.find((r) => r.agent_id === "agent-legacy");
  expect(modern).not.toBeUndefined();
  expect(legacy).not.toBeUndefined();
  // The planctl Bash minted a source='plan' attribution (state_repo fold-read).
  const planctlAttribs = (
    p0.file_attributions as Array<Record<string, unknown>>
  ).filter((a) => a.source === "plan");
  expect(planctlAttribs.length).toBeGreaterThan(0);
  // The Notification stamped jobs.last_permission_prompt_kind from event_type.
  const stampedJob = (p0.jobs as Array<Record<string, unknown>>).find(
    (j) => j.last_permission_prompt_kind === "permission",
  );
  expect(stampedJob).not.toBeUndefined();
  // The Cron minted a scheduled_tasks row from the body.
  expect(p0.scheduled_tasks.length).toBe(1);

  // SHED via the PRODUCTION retention path (real predicate/cursor/watermark).
  const result = shedCorpus();
  expect(result.shed).toBeGreaterThan(0);
  // The sentinel does NOT false-alarm — every NULLed body is a shed-class row.
  expect(countAbsentBlobs(db)).toBe(0);

  // The KEPT guarded siblings still carry their bodies inline post-shed.
  const inlineKept = (rowFilter: string): number =>
    (
      db
        .query(
          `SELECT COUNT(*) AS n FROM events WHERE data IS NOT NULL AND ${rowFilter}`,
        )
        .get() as { n: number }
    ).n;
  expect(inlineKept("plan_op = 'done'")).toBeGreaterThan(0); // planctl Bash
  expect(
    inlineKept(
      "hook_event = 'PostToolUse' AND tool_name = 'Agent' AND subagent_agent_id IS NULL",
    ),
  ).toBe(1); // legacy Agent
  expect(inlineKept("hook_event = 'PreToolUse' AND tool_name = 'Agent'")).toBe(
    1,
  ); // bridge
  expect(
    inlineKept("hook_event = 'PostToolUseFailure' AND tool_name = 'Agent'"),
  ).toBe(1); // failure agentId
  expect(inlineKept("tool_name = 'CronCreate'")).toBe(1); // cron body

  // P1 — a from-scratch re-fold over the SHED corpus.
  rewindAndWipeWidened();
  drainAll();
  const p1 = snapshotWidenedProjections();
  expect(p1).toEqual(p0);
  expect(countAbsentBlobs(db)).toBe(0);

  // P2 — a SECOND from-scratch re-fold reproduces byte-identical rows.
  rewindAndWipeWidened();
  drainAll();
  const p2 = snapshotWidenedProjections();
  expect(p2).toEqual(p1);
});

function rewindAndWipeWidened(): void {
  rewindAndWipeProjections();
  db.run("DELETE FROM scheduled_tasks");
}

// ---------------------------------------------------------------------------
// 0 → head from-scratch migrate (event_blobs created at v57, read at v67,
// DROPPED at the v74 tail — gone at head)
// ---------------------------------------------------------------------------

test("0 → head from-scratch migrate succeeds; event_blobs is gone at head (created v57, read v67, dropped at v74 tail)", () => {
  // openDb(":memory:") runs the FULL migration ladder from v0. The v57 ladder
  // step CREATEs event_blobs and the v67 Commit-trailer backfill READs it — both
  // run against the transiently-present table during the walk — and the v74 tail
  // DROPs it. So a successful migrate to head with event_blobs ABSENT proves the
  // whole ladder ran (a missing v57 create or a broken v67 read would throw
  // before the tail) AND that the shed converged.
  const fresh = openDb(":memory:");
  try {
    const stored = (
      fresh.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | null
    )?.value;
    expect(Number(stored)).toBe(SCHEMA_VERSION);

    // event_blobs is GONE at head — dropped at the v74 tail, never resurrected.
    const hasBlobs = fresh.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_blobs'",
      )
      .get();
    expect(hasBlobs ?? null).toBeNull();
    // Its expression index is gone too.
    const hasIdx = fresh.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_event_blobs_tool_attr'",
      )
      .get();
    expect(hasIdx ?? null).toBeNull();

    // The fresh ladder ran the v67 backfill path (commit_trailer_facts exists
    // and is empty on a zero-event DB — proving the backfill SELECT over the
    // transiently-present event_blobs executed without error before the tail
    // DROP).
    const facts = fresh.db
      .prepare("SELECT COUNT(*) AS n FROM commit_trailer_facts")
      .get() as { n: number };
    expect(facts.n).toBe(0);

    // A from-scratch re-fold over the empty fresh DB is a clean no-op (cursor
    // stays 0, no projection rows) — the zero-event determinism baseline.
    let n: number;
    do {
      n = drain(fresh.db);
    } while (n > 0);
    expect(
      (
        fresh.db
          .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
          .get() as { last_event_id: number }
      ).last_event_id,
    ).toBe(0);
  } finally {
    fresh.db.close();
  }
});

// ---------------------------------------------------------------------------
// v77→v78 (fn-864) — the planctl_*→plan_* rename + envelope-rewrite MERGE GATE
//
// Proves the riskiest migration of the strip is value-preserving and
// re-fold-equivalent: a v77-shaped DB carrying a `planctl_invocation`-only
// legacy event AND a `plan_invocation`-only new event migrates to v78 such that
// (a) no canonical event still carries the legacy envelope key, (b) the legacy
// envelope's `data` is rewritten in place preserving surrounding bytes, (c) the
// columns/indexes rename, and (d) the migrated projection is byte-identical to a
// from-scratch re-fold of the rewritten corpus — the same plan link mints off
// either spelling. NO cursor rewind (value-preserving). Idempotent (re-migrate
// finds nothing). Built by reverse-engineering a v77 fixture from a fresh v78
// `openDb` (rename the columns back, restore the old index identifiers, stamp
// 77), then reopening to drive the v78 step forward.
// ---------------------------------------------------------------------------

const V78_EVENT_COLS = [
  ["plan_op", "planctl_op"],
  ["plan_target", "planctl_target"],
  ["plan_epic_id", "planctl_epic_id"],
  ["plan_task_id", "planctl_task_id"],
  ["plan_subject_present", "planctl_subject_present"],
  ["plan_queue_jump", "planctl_queue_jump"],
  ["plan_files", "planctl_files"],
] as const;

/** Reverse-rename a fresh v78 DB to the v77 shape (columns + the 3 event index
 * identifiers), then stamp version 77 so the next open drives v77→v78. */
function downgradeToV77Shape(d: Database): void {
  for (const [newName, oldName] of V78_EVENT_COLS) {
    d.run(`ALTER TABLE events RENAME COLUMN ${newName} TO ${oldName}`);
  }
  for (const [newName, oldName] of [
    ["plan_op", "planctl_op"],
    ["plan_target", "planctl_target"],
    ["plan_epic_id", "planctl_epic_id"],
  ] as const) {
    d.run(
      `ALTER TABLE commit_trailer_facts RENAME COLUMN ${newName} TO ${oldName}`,
    );
  }
  // Restore the v77 index identifiers (the column rename above already rewrote
  // their predicates back to `planctl_op`).
  d.run("DROP INDEX IF EXISTS idx_events_plan_session");
  d.run(
    "CREATE INDEX IF NOT EXISTS idx_events_planctl_session ON events (session_id, id) WHERE planctl_op IS NOT NULL",
  );
  d.run("DROP INDEX IF EXISTS idx_events_plan_epic");
  d.run(
    "CREATE INDEX IF NOT EXISTS idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL",
  );
  d.run("DROP INDEX IF EXISTS idx_events_plan_target");
  d.run(
    "CREATE INDEX IF NOT EXISTS idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL",
  );
  d.run("UPDATE meta SET value = '77' WHERE key = 'schema_version'");
}

/** Snapshot the fold-output projection rows that a plan-link fold produces, for
 * byte-identity comparison across the migration / a re-fold. */
function planProjectionSnapshot(d: Database): {
  fileAttributions: unknown[];
  jobs: unknown[];
  epics: unknown[];
} {
  return {
    fileAttributions: d
      .query(
        `SELECT project_dir, session_id, file_path, op, source
           FROM file_attributions ORDER BY project_dir, session_id, file_path`,
      )
      .all(),
    jobs: d.query("SELECT job_id, epic_links FROM jobs ORDER BY job_id").all(),
    epics: d
      .query("SELECT epic_id, job_links FROM epics ORDER BY epic_id")
      .all(),
  };
}

test("v77→v78 MERGE GATE: legacy `planctl_invocation`-only + `plan_invocation`-only fold byte-identically across the rename + rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-v78-proof-"));
  const dbPath = join(dir, "keeper.db");
  const SESS_LEGACY = "11111111-1111-1111-1111-111111111111";
  const SESS_NEW = "22222222-2222-2222-2222-222222222222";
  try {
    // 1. Build a fresh v78 DB, downgrade it to the v77 shape, and seed a mixed
    // corpus: a SessionStart per session, ONE legacy `planctl_invocation`-only
    // scaffold (envelope inside tool_response.stdout) and ONE new
    // `plan_invocation`-only scaffold — identical op/target/files modulo the
    // envelope key spelling. The two events differ ONLY in that one key.
    {
      const { db: seed } = openDb(dbPath);
      downgradeToV77Shape(seed);
      const insert = seed.prepare(
        `INSERT INTO events (
           ts, session_id, pid, hook_event, event_type, tool_name, cwd, data,
           planctl_op, planctl_target, planctl_epic_id, planctl_subject_present,
           planctl_files
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // SessionStart rows (no plan columns).
      insert.run(
        1000,
        SESS_LEGACY,
        "SessionStart",
        "session_start",
        null,
        REPO,
        "{}",
        null,
        null,
        null,
        null,
        null,
      );
      insert.run(
        1001,
        SESS_NEW,
        "SessionStart",
        "session_start",
        null,
        REPO,
        "{}",
        null,
        null,
        null,
        null,
        null,
      );
      const envBody = (key: "planctl_invocation" | "plan_invocation") =>
        JSON.stringify({
          tool_response: {
            stdout: JSON.stringify({
              [key]: {
                op: "scaffold",
                target: "fn-1-x",
                state_repo: REPO,
                files: [".planctl/epics/fn-1-x.json"],
                subject: "x",
              },
            }),
          },
        });
      // Legacy `planctl_invocation`-only PostToolUse:Bash scaffold.
      insert.run(
        1002,
        SESS_LEGACY,
        "PostToolUse",
        "post_tool_use",
        "Bash",
        REPO,
        envBody("planctl_invocation"),
        "scaffold",
        "fn-1-x",
        "fn-1-x",
        1,
        JSON.stringify([".planctl/epics/fn-1-x.json"]),
      );
      // New `plan_invocation`-only PostToolUse:Bash scaffold (same shape).
      insert.run(
        1003,
        SESS_NEW,
        "PostToolUse",
        "post_tool_use",
        "Bash",
        REPO,
        envBody("plan_invocation"),
        "scaffold",
        "fn-1-x",
        "fn-1-x",
        1,
        JSON.stringify([".planctl/epics/fn-1-x.json"]),
      );
      // Sanity: the v77 fixture genuinely carries the legacy key.
      expect(
        (
          seed
            .query(
              "SELECT COUNT(*) AS n FROM events WHERE data LIKE '%planctl_invocation%'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      seed.close();
    }

    // 2. Reopen — migrate() drives v77→v78 (rename + envelope rewrite + COUNT==0
    // assert), then the boot drain folds the rewritten corpus.
    const { db } = openDb(dbPath);
    try {
      expect(
        (
          db
            .query("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as {
            value: string;
          }
        ).value,
      ).toBe(String(SCHEMA_VERSION));

      // (a) No canonical event carries the legacy envelope key post-migrate.
      expect(
        (
          db
            .query(
              "SELECT COUNT(*) AS n FROM events WHERE data LIKE '%planctl_invocation%'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
      // Both events now carry the renamed key.
      expect(
        (
          db
            .query(
              "SELECT COUNT(*) AS n FROM events WHERE data LIKE '%plan_invocation%'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(2);

      // (b) The columns renamed (a `plan_op` read succeeds; `planctl_op` is gone).
      const evCols = (
        db.query("PRAGMA table_info(events)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(evCols).toContain("plan_op");
      expect(evCols).not.toContain("planctl_op");

      // (c) The 3 event indexes renamed AND their predicates rewrote to plan_op.
      const idxSql = new Map(
        (
          db
            .query(
              "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='events'",
            )
            .all() as { name: string; sql: string | null }[]
        ).map((r) => [r.name, r.sql ?? ""]),
      );
      for (const name of [
        "idx_events_plan_session",
        "idx_events_plan_epic",
        "idx_events_plan_target",
      ]) {
        expect(idxSql.has(name)).toBe(true);
        expect(idxSql.get(name)).toContain("plan_op IS NOT NULL");
        expect(idxSql.get(name)).not.toContain("planctl_op");
      }

      // Lower the LIVE-ONLY git skip-floor to 0 before the re-fold. The v79
      // migration raised `floor = max(events.id)` so production never replays
      // historical `file_attributions` mints — but THIS test exercises the v78
      // envelope-rewrite fold-equivalence precisely BY replaying the two seeded
      // scaffold events, so it deliberately reopens the historical fold. (The
      // surface is live-only in production; here we want the deterministic fold
      // to run so the legacy-vs-new equivalence is observable.)
      db.run("UPDATE git_projection_state SET floor = 0 WHERE id = 1");

      // Fold the rewritten corpus.
      let n: number;
      do {
        n = drain(db);
      } while (n > 0);

      // (d) BOTH the legacy-spelled and new-spelled scaffold minted an
      // identical `source='plan'` file_attribution — the rewrite made the two
      // spellings fold the same. One row per session, same path/op/source.
      const attrs = db
        .query(
          `SELECT session_id, file_path, op, source
             FROM file_attributions ORDER BY session_id`,
        )
        .all() as {
        session_id: string;
        file_path: string;
        op: string;
        source: string;
      }[];
      expect(attrs).toEqual([
        {
          session_id: SESS_LEGACY,
          file_path: ".planctl/epics/fn-1-x.json",
          op: "scaffold",
          source: "plan",
        },
        {
          session_id: SESS_NEW,
          file_path: ".planctl/epics/fn-1-x.json",
          op: "scaffold",
          source: "plan",
        },
      ]);

      // Capture the migrated projection, then run a from-scratch re-fold and
      // assert byte-identity (value-equal across the column rename + rewrite).
      const migrated = planProjectionSnapshot(db);
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM file_attributions");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM git_status");
      db.run("DELETE FROM subagent_invocations");
      do {
        n = drain(db);
      } while (n > 0);
      const refolded = planProjectionSnapshot(db);
      expect(JSON.stringify(refolded)).toBe(JSON.stringify(migrated));
    } finally {
      db.close();
    }

    // 3. Idempotency: a second open re-runs migrate() with no `planctl_*` left —
    // the rename no-ops, the rewrite finds zero rows, the version holds at v78.
    const { db: again } = openDb(dbPath);
    try {
      expect(
        (
          again
            .query("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string }
        ).value,
      ).toBe(String(SCHEMA_VERSION));
      expect(
        (
          again
            .query(
              "SELECT COUNT(*) AS n FROM events WHERE data LIKE '%planctl_invocation%'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
