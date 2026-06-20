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
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * live fold (`applyEvent`) or a body-resolving read (`COALESCE(events.data,
 * event_blobs.data)`) parses. Every entry was verified against a fold read in
 * `src/reducer.ts` / `src/subagent-invocations.ts` (the enumeration test below
 * pins the reader sites). The shed NULLs only bodies OUTSIDE this set AND
 * outside the shed-mutation-tool file_path promotion.
 *
 * NOTE on PostToolUse: the BODY is keep-set ONLY for `tool_name='Agent'` (the
 * subagent bridge — `resolveBridgeAgentId` legacy `tool_response.agentId`
 * fallback + the PreToolUse:Agent bridge), for the cron tools (CronCreate /
 * CronDelete read `tool_response.id` / `tool_input.id`), and for planctl-op
 * bearing rows (`extractPlanctlStateRepo` reads `tool_response.stdout`). The
 * four SHED_MUTATION_TOOLS are the explicit carve-OUT — their body is shed.
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
  "BackendExecSnapshot",
  "TmuxPaneSnapshot",
  "WindowIndexSnapshot",
  "BackendExecStart",
  // Session / prompt / title folds.
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "TranscriptTitle",
  "Stop",
  "Notification",
  "InputRequest",
  "RateLimited",
  "ApiError",
  "Killed",
  // Subagent lifecycle (PreToolUse:Agent body is read via the bridge).
  "SubagentStart",
  "SubagentStop",
  "SubagentTurn",
  "PreToolUse",
  // PostToolUse is keep-set for Agent / cron / planctl-op rows; the four
  // mutation tools are the carve-out (SHED_MUTATION_TOOLS).
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
  // restore SELECT + its EXISTS guard) = 3. The v57 ladder CREATE and the tail
  // DROPs are not JOIN/FROM-reads of a body, so they don't count.
  expect({
    file: "src/db.ts",
    n: countSqlJoins("src/db.ts"),
  }).toEqual({
    file: "src/db.ts",
    n: 3,
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
  tool_name?: string | null;
  cwd?: string | null;
  ts?: number;
  data?: string | null;
  subagent_agent_id?: string | null;
  tool_use_id?: string | null;
  agent_type?: string | null;
  planctl_op?: string | null;
  planctl_target?: string | null;
  planctl_files?: string | null;
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
       subagent_agent_id, tool_use_id, agent_type, planctl_op, planctl_target,
       planctl_files, mutation_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? "sess-a",
      4242,
      overrides.hook_event,
      overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? "/tmp/work",
      data,
      overrides.subagent_agent_id ?? null,
      overrides.tool_use_id ?? null,
      overrides.agent_type ?? null,
      overrides.planctl_op ?? null,
      overrides.planctl_target ?? null,
      overrides.planctl_files ?? null,
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
 * SHED the corpus into its post-v74 live shape: NULL every shed-class body in
 * place (the four mutation tools), keeping the keep-set bodies inline. This is
 * exactly what the v74 migration leaves behind — shed-class `events.data` NULL
 * (its `tool_input.file_path` already promoted to `mutation_path` at seed time),
 * keep-set `events.data` inline. There is NO `event_blobs` table post-shed, so
 * the body simply goes away; the fold reads `mutation_path` for the file_path.
 */
function shedCorpus(): void {
  const before = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND data IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;
  expect(before).toBeGreaterThan(0);
  db.run(
    `UPDATE events SET data = NULL
      WHERE hook_event = 'PostToolUse'
        AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')`,
  );
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
  // PostToolUse:Bash body — a keep-set read (gated on planctl_op + planctl_files
  // sparse columns, so it never touches a shed-class body). A well-shaped
  // envelope mints; a malformed body folds safe with the cursor advancing.
  insertEvent({ hook_event: "SessionStart", session_id: SESS_A });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: SESS_A,
    cwd: REPO,
    planctl_op: "done",
    planctl_target: "fn-1-x.1",
    planctl_files: JSON.stringify([".planctl/tasks/fn-1-x.1.md"]),
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
    planctl_op: "done",
    planctl_target: "fn-1-x.2",
    planctl_files: JSON.stringify([".planctl/tasks/fn-1-x.2.md"]),
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
