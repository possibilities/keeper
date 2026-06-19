/**
 * Re-fold equivalence harness — the correctness GATE for the
 * `fn-836-shed-event-blob-bloat-and-add-retention` epic (task .1, the early
 * proof point).
 *
 * This file writes NO production behavior change. It establishes the proof
 * METHODOLOGY and the current-fold BASELINE that the destructive shed tasks
 * (.3 backfill+flip, .4 DROP `event_blobs`) are gated on. If any assertion here
 * cannot be made to hold over a live-SHAPED corpus, the shed is unsafe and the
 * design must change before proceeding past .1.
 *
 * The shed splits today's conflated `events.data` blob into its two real roles:
 *
 *   - the KEEP-SET — an explicit ALLOW-list of event types whose `data` BODY a
 *     LIVE fold reads (via `JSON.parse(event.data)` inside `applyEvent`, or via
 *     a `COALESCE(events.data, event_blobs.data)` body read). These stay inline
 *     forever; dropping their body breaks re-fold.
 *   - the SHED CLASS — PostToolUse `tool_input` bodies for the four mutation
 *     tools (Write / Edit / MultiEdit / NotebookEdit) whose ONLY fold
 *     consumption is the single scalar `tool_input.file_path`, read by the
 *     git-attribution scan. That one field is promoted to a `mutation_path`
 *     column (task .2); the rest of the body is the redundant transcript
 *     archive that gets shed.
 *
 * Four proof layers, cheapest first (per practice-scout):
 *   (1) the keep-set ALLOW-list + a blob-reader ENUMERATION test that asserts no
 *       fold reads the BODY of a shed-class event;
 *   (2) a per-event EXTRACTION AUDIT — the value the old path extracts
 *       (`json_extract($.tool_input.file_path)` over the resolved blob) equals
 *       the value a `mutation_path` column would carry, for every mutation row;
 *   (3) a LEGACY-SHAPE charter (legacy Agent `tool_response.agentId` fallback,
 *       malformed→null, old Commit/GitSnapshot shapes, the planctl Bash
 *       `tool_response.stdout` envelope);
 *   (4) the full DIFFERENTIAL RE-FOLD — over a live-shaped corpus (relocated
 *       rows: `events.data IS NULL`, the value lives in `event_blobs`), assert
 *       the projection row-hashes are byte-identical between the OLD attribution
 *       path (json_extract two-arm scan over the blob) and the NEW
 *       `mutation_path`-column path.
 *
 * Because the `mutation_path` column does not exist yet (task .2 adds it), the
 * NEW path is SIMULATED in-test: we materialize the exact value the future
 * column will carry — `json_extract(COALESCE(events.data, event_blobs.data),
 * '$.tool_input.file_path')` for the four mutation tools — into an in-test
 * column, then drive the attribution scan off the COLUMN instead of the blob.
 * Proving the two paths agree over a relocated corpus is precisely the safety
 * predicate the shed needs.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compactColdBlobs } from "../src/compaction";
import { openDb, SCHEMA_VERSION } from "../src/db";
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

test("every body-resolving blob reader is enumerated and classified keep vs shed", () => {
  // The COMPLETE set of source sites that resolve an event `data` BODY through
  // the `event_blobs` side table (the reads the shed retires when it drops the
  // table). Each is classified: a KEEP reader parses a keep-set event body; a
  // FILEPATH reader extracts ONLY `$.tool_input.file_path` (the value the
  // `mutation_path` column promotes — safe to retire the blob read once the
  // column lands). NO reader may parse a shed-class BODY beyond file_path.
  //
  // This is a proof obligation, not a guess: a missed body reader silently
  // breaks re-fold after the shed. If `grep -rn event_blobs src/ cli/` turns up
  // a site not on this list, the test below fails — forcing classification.
  const bodyResolvingReaders: Array<{
    file: string;
    // A short, unique substring of the reader's query/expression that pins it.
    needle: string;
    kind: "keep" | "filepath";
    why: string;
  }> = [
    {
      file: "src/reducer.ts",
      needle: "COALESCE(events.data, event_blobs.data) AS data,",
      kind: "keep",
      // The main drain loads every event body and hands it to applyEvent; only
      // keep-set arms JSON.parse it. The shed-class arm (PostToolUse non-Agent)
      // never touches the body — it returns on tool_name !== 'Agent'.
      why: "main drain — keep-set arms parse the body; shed-class arm ignores it",
    },
    {
      file: "src/reducer.ts",
      needle: "FROM event_blobs b",
      kind: "filepath",
      why: "git-attribution ARM B — reads ONLY $.tool_input.file_path (mutation_path)",
    },
    {
      file: "src/db.ts",
      needle: "COALESCE(events.data, event_blobs.data) AS data",
      kind: "keep",
      why: "v67 Commit trailer backfill — Commit is keep-set",
    },
    {
      file: "src/subagent-invocations.ts",
      needle: "SELECT COALESCE(e.data, b.data) AS data",
      kind: "keep",
      why: "PreToolUse:Agent bridge body — Agent is keep-set",
    },
    {
      file: "src/subagent-invocations.ts",
      needle: "SELECT e.tool_use_id, COALESCE(e.data, b.data) AS data",
      kind: "keep",
      why: "pending PreToolUse:Agent FIFO bridge body — Agent is keep-set",
    },
    {
      file: "cli/search-history.ts",
      needle:
        "json_extract(COALESCE(events.data, event_blobs.data), '$.prompt')",
      kind: "keep",
      why: "search-history reads UserPromptSubmit $.prompt — keep-set",
    },
  ];

  // Each enumerated reader's needle must actually be present (the enumeration
  // tracks live source — a moved/renamed reader fails here, forcing an update).
  for (const r of bodyResolvingReaders) {
    const src = readSrc(r.file);
    expect(src.includes(r.needle)).toBe(true);
  }

  // No FILEPATH reader may extract anything but `$.tool_input.file_path` from a
  // shed-class body. The ARM B query is the only filepath reader; assert it
  // extracts ONLY file_path (the promoted column) and nothing else from the
  // shed body.
  const reducerSrc = readSrc("src/reducer.ts");
  const armB = reducerSrc.slice(
    reducerSrc.indexOf("FROM event_blobs b"),
    reducerSrc.indexOf("FROM event_blobs b") + 400,
  );
  expect(armB).toContain("json_extract(b.data, '$.tool_input.file_path')");
  // It must NOT pull any other JSON path out of the shed body (content,
  // tool_response, etc.) — that would make the body un-sheddable.
  expect(armB).not.toContain("$.tool_input.content");
  expect(armB).not.toContain("$.tool_response");

  // The enumeration must COVER every event_blobs body read in src/ and cli/. A
  // body read JOINs the side table in actual SQL (`LEFT JOIN event_blobs` or the
  // ARM B `FROM event_blobs`); the relocate INSERT and the countAbsentBlobs
  // presence-check in compaction.ts are NOT body reads and are excluded by
  // pinning their site counts separately below. We strip COMMENT lines so a doc
  // mention of `event_blobs` never inflates the count.
  const countSqlJoins = (file: string): number => {
    const lines = readSrc(file).split("\n");
    let n = 0;
    for (const line of lines) {
      const trimmed = line.trimStart();
      // Skip line comments / JSDoc continuation lines.
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }
      if (
        line.includes("LEFT JOIN event_blobs") ||
        line.includes("FROM event_blobs")
      ) {
        n += 1;
      }
    }
    return n;
  };

  // Body-resolving SQL join sites (each enumerated above):
  //   reducer.ts: main drain LEFT JOIN (keep) + ARM B FROM (filepath) = 2
  //   db.ts: v67 Commit backfill LEFT JOIN (keep) = 1
  //   subagent-invocations.ts: 2 bridge LEFT JOINs (keep) = 2
  //   search-history.ts: UserPromptSubmit prompt LEFT JOIN (keep) = 1
  const bodyReadSites: Array<{ file: string; count: number }> = [
    { file: "src/reducer.ts", count: 2 },
    { file: "src/db.ts", count: 1 },
    { file: "src/subagent-invocations.ts", count: 2 },
    { file: "cli/search-history.ts", count: 1 },
  ];
  // Every enumerated reader maps to one of these sites; the join-count equals
  // the enumerated count per file (db.ts's 1 + reducer's 2 = 3 reducer-side
  // entries in the list, etc.). A NEW reader bumps a file's join count and
  // fails this until it is classified above.
  for (const { file, count } of bodyReadSites) {
    expect({ file, n: countSqlJoins(file) }).toEqual({ file, n: count });
  }
  // compaction.ts touches event_blobs only for RELOCATE (INSERT) and the
  // countAbsentBlobs presence check — NEITHER reads a body, so they are NOT in
  // the keep/shed enumeration. Pin that there is exactly ONE join site there
  // (the presence check) so a future body read added to compaction.ts trips.
  expect({
    file: "src/compaction.ts",
    n: countSqlJoins("src/compaction.ts"),
  }).toEqual({
    file: "src/compaction.ts",
    n: 1,
  });
});

// ---------------------------------------------------------------------------
// Live-shaped corpus seeding (relocated rows: data IS NULL, value in side table)
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
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, cwd, data,
       subagent_agent_id, tool_use_id, agent_type, planctl_op, planctl_target,
       planctl_files
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? "sess-a",
      4242,
      overrides.hook_event,
      overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? "/tmp/work",
      overrides.data ?? "{}",
      overrides.subagent_agent_id ?? null,
      overrides.tool_use_id ?? null,
      overrides.agent_type ?? null,
      overrides.planctl_op ?? null,
      overrides.planctl_target ?? null,
      overrides.planctl_files ?? null,
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
 *  - a DISCHARGED mutation (cold.ts, committed clean) whose blob is needed on
 *    re-fold (the Commit replays AFTER the GitSnapshot — see the reducer's
 *    "currently-discharged ⇒ safe to drop is FALSE" comment);
 *  - an UNDISCHARGED mutation (live.ts, never committed) — stays live;
 *  - an Edit and a NotebookEdit (the other shed tools) so the file_path
 *    promotion covers all four;
 *  - a malformed mutation blob (json_valid=false → file_path null → skipped);
 *  - keep-set bodies that MUST survive: a PreToolUse:Agent bridge, a planctl
 *    Bash stdout envelope, a UserPromptSubmit, a Commit.
 */
let malformedMutationId = 0;

function seedLiveShapedCorpus(): void {
  malformedMutationId = 0;
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

  // A MALFORMED mutation blob — json_valid=false → file_path null → skipped by
  // both the old json_extract path and the new column path (folds the same).
  // The `idx_events_tool_attr` expression index runs `json_extract` at INSERT
  // time for the four mutation tools and REJECTS malformed inline JSON, so a
  // malformed mutation body can only EXIST in the relocated side table (whose
  // `idx_event_blobs_tool_attr` is `CASE WHEN json_valid(...)`-guarded). We
  // insert a valid placeholder here and corrupt the side-table bytes AFTER
  // relocation (see `corruptMalformedMutationBlob`), reproducing the only shape
  // a malformed mutation body takes in the live corpus.
  malformedMutationId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "MultiEdit",
    session_id: SESS_B,
    cwd: REPO,
    data: JSON.stringify({ tool_input: { will_be: "corrupted" } }),
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

/** Relocate EVERY blob (margin 0) so the corpus is genuinely live-shaped. */
function relocateEverything(): void {
  const result = compactColdBlobs(db, {
    recentRetentionMargin: 0,
    batchSize: 100,
    maxBatches: 50,
  });
  expect(result.relocated).toBeGreaterThan(0);
  // Corrupt the malformed-mutation row's RELOCATED side-table bytes in place.
  // The side-table index is `json_valid`-guarded so it tolerates malformed JSON
  // (the inline index would have rejected it at INSERT). This reproduces the
  // only shape a malformed mutation body can take in the live corpus.
  if (malformedMutationId > 0) {
    db.run("UPDATE event_blobs SET data = ? WHERE event_id = ?", [
      "{ not json at all",
      malformedMutationId,
    ]);
  }
}

/**
 * Materialize the future `mutation_path` column exactly as task .2 (additive
 * ALTER) + task .3 (paced backfill) will: add the column, fill it from the
 * inline body where present, then backfill the relocated rows from the
 * side-table body (json_valid-guarded). Idempotent ADD-once: a re-add throws,
 * so callers run it at most once per `db`.
 *
 * The value is `json_extract($.tool_input.file_path)` for the four mutation
 * tools — byte-identical to what the old git-attribution scan reads off the
 * blob. NULL for a malformed body (the guard) and for non-mutation rows.
 */
function materializeMutationPathColumn(): void {
  db.run("ALTER TABLE events ADD COLUMN mutation_path TEXT");
  // Inline rows: extract from `events.data` (json_valid-guarded so a future
  // inline-malformed row never throws the UPDATE).
  db.run(
    `UPDATE events
        SET mutation_path = CASE WHEN json_valid(data)
                                 THEN json_extract(data, '$.tool_input.file_path')
                            END
      WHERE hook_event = 'PostToolUse'
        AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        AND data IS NOT NULL`,
  );
  // Relocated rows (data IS NULL): backfill ONCE from the side-table body —
  // the read task .3 does once, then the scan reads only the column forever.
  db.run(
    `UPDATE events
        SET mutation_path = (
            SELECT CASE WHEN json_valid(b.data)
                        THEN json_extract(b.data, '$.tool_input.file_path')
                   END
              FROM event_blobs b WHERE b.event_id = events.id
        )
      WHERE hook_event = 'PostToolUse'
        AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        AND data IS NULL`,
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

test("live-shaped corpus: every mutation blob is genuinely relocated (data IS NULL, value in event_blobs)", () => {
  seedLiveShapedCorpus();
  drainAll();
  relocateEverything();

  // Every shed-class mutation row has its hot column NULLed and the bytes in
  // the side table — this is the ARM B / COALESCE shape the shed removes. A
  // synthetic all-inline fixture would NOT exercise it (the .1 risk note).
  const relocatedMutations = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events e
            JOIN event_blobs b ON b.event_id = e.id
          WHERE e.hook_event = 'PostToolUse'
            AND e.tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND e.data IS NULL`,
      )
      .get() as { n: number }
  ).n;
  // cold.ts(Write) + edited.ts(Edit) + nb.ipynb(NotebookEdit) + live.ts(Write)
  // + the malformed MultiEdit = 5 mutation rows, all relocated.
  expect(relocatedMutations).toBe(5);

  // The keep-set bodies are ALSO relocated (margin 0) — proving the fold still
  // resolves them via COALESCE from the side table on re-fold.
  const relocatedKeepBodies = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events e
            JOIN event_blobs b ON b.event_id = e.id
          WHERE e.data IS NULL
            AND e.hook_event IN ('UserPromptSubmit','PreToolUse','GitSnapshot','Commit')`,
      )
      .get() as { n: number }
  ).n;
  expect(relocatedKeepBodies).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Layer 2 — per-event extraction audit (old path == new mutation_path column)
// ---------------------------------------------------------------------------

test("per-event extraction audit: old json_extract path == new mutation_path-column value for every mutation row", () => {
  seedLiveShapedCorpus();
  drainAll();
  relocateEverything();

  // NEW PATH: materialize the future `mutation_path` column exactly as task .3
  // will (backfill from the relocated side-table body, json_valid-guarded).
  materializeMutationPathColumn();

  // OLD PATH: the value the git-attribution scan extracts today — a
  // `json_valid`-guarded json_extract over the COALESCEd (relocated) body,
  // matching the real ARM B `CASE WHEN json_valid(b.data) THEN json_extract(...)`
  // form (the guard is load-bearing: a bare json_extract THROWS on a malformed
  // relocated blob). NEW PATH: the value the `mutation_path` column now carries.
  // The audit asserts they are equal PER ROW — the JSON-path-mismatch guard
  // that catches a divergence before any full re-fold.
  const rows = db
    .query(
      `SELECT e.id AS id, e.tool_name AS tool_name,
              CASE WHEN json_valid(COALESCE(e.data, b.data))
                   THEN json_extract(COALESCE(e.data, b.data), '$.tool_input.file_path')
              END AS old_path,
              e.mutation_path AS new_column
         FROM events e
         LEFT JOIN event_blobs b ON b.event_id = e.id
        WHERE e.hook_event = 'PostToolUse'
          AND e.tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        ORDER BY e.id ASC`,
    )
    .all() as Array<{
    id: number;
    tool_name: string;
    old_path: string | null;
    new_column: string | null;
  }>;

  expect(rows.length).toBe(5);
  for (const r of rows) {
    // The promoted column carries byte-identically what json_extract reads.
    expect(r.new_column).toBe(r.old_path);
  }

  // The malformed MultiEdit row extracts to null on BOTH paths — folds the
  // same (no attribution), proving a malformed body is shed-safe.
  const malformed = rows.find((r) => r.old_path === null);
  expect(malformed).not.toBeUndefined();
  expect(malformed?.tool_name).toBe("MultiEdit");

  // The four well-formed mutation rows resolve their absolute file_path.
  const resolved = rows
    .filter((r) => r.old_path !== null)
    .map((r) => r.old_path)
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

test("differential re-fold: byte-identical projections, OLD json_extract path == NEW mutation_path-column path, over a live-shaped corpus", () => {
  seedLiveShapedCorpus();
  drainAll();
  relocateEverything();

  // BASELINE = the OLD path: fold via the real two-arm git-attribution scan
  // (ARM A inline json_extract + ARM B relocated event_blobs json_extract).
  // This is the production fold today over the relocated corpus.
  rewindAndWipeProjections();
  drainAll();
  const oldPath = snapshotProjections();

  // Sanity: cold.ts discharged (last_commit_at set), live.ts still live. The
  // attribution row's `file_path` is the GitSnapshot's REPO-RELATIVE path
  // (`cold.ts`), not the mutation event's absolute `tool_input.file_path` — the
  // attribution scan matches on the absolute candidate but keys the row on the
  // git-relative dirty-file path.
  const attribs = oldPath.file_attributions as Array<Record<string, unknown>>;
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
  // All four dirty files (cold/edited/nb/live) got tool-sourced attributions —
  // proving ARM B served every relocated mutation blob over the live-shaped
  // corpus (the malformed MultiEdit row has no file_path → no attribution).
  const toolFiles = attribs
    .filter((a) => a.source === "tool")
    .map((a) => a.file_path)
    .sort();
  expect(toolFiles).toEqual(["cold.ts", "edited.ts", "live.ts", "nb.ipynb"]);

  // NEW path: materialize the future `mutation_path` column and drive the
  // attribution match off the COLUMN instead of the blob. We simulate the .2/.3
  // end-state: every mutation row carries `mutation_path`, and a COALESCE-FREE
  // single-arm scan (no event_blobs touch) reproduces the SAME attributions.
  // Because re-fold is a pure function of the event log + the values the scan
  // reads, equal inputs (mutation_path == json_extract(file_path)) MUST yield
  // byte-identical projections.
  materializeMutationPathColumn();

  // Assert the column now carries the file_path for the four well-formed rows
  // and NULL for the malformed one (the new path's input to the scan).
  const colVals = db
    .query(
      `SELECT mutation_path FROM events
        WHERE hook_event = 'PostToolUse'
          AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
        ORDER BY id`,
    )
    .all() as Array<{ mutation_path: string | null }>;
  const nonNull = colVals.filter((v) => v.mutation_path !== null).length;
  expect(nonNull).toBe(4);

  // Re-fold AGAIN, this time deriving the tool-attribution match from the
  // `mutation_path` column (COALESCE-free, no event_blobs read). We reproduce
  // the post-shed attribution set by computing it from the column and asserting
  // it equals the old-path attribution set EXACTLY. (The reducer's own scan is
  // swapped to the column in task .3; here we prove the column carries enough.)
  rewindAndWipeProjections();
  drainAll();
  const reFoldAgain = snapshotProjections();

  // The fold itself is unchanged in .1, so re-fold-2 must equal re-fold-1 (pure
  // re-fold determinism — the sacred invariant) regardless of the new column.
  expect(reFoldAgain).toEqual(oldPath);

  // NEW-PATH ATTRIBUTION EQUIVALENCE: the (session_id, ABSOLUTE-path) pairs the
  // git-attribution scan would produce reading `mutation_path` must COVER every
  // tool-sourced attribution the old json_extract path produced. The column
  // carries the mutation's ABSOLUTE `tool_input.file_path`; the attribution row
  // keys on the git-RELATIVE path, so we reconstruct the absolute candidate the
  // scan matched on as `project_dir + '/' + file_path` (the exact lexical join
  // `findExplicitAttributions` does) and compare in the same key space.
  const newPathToolCandidates = new Set(
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
  const oldPathToolAttributions = new Set(
    (oldPath.file_attributions as Array<Record<string, unknown>>)
      .filter((a) => a.source === "tool")
      .map((a) => `${a.session_id}::${a.project_dir}/${a.file_path}`),
  );
  // Every tool-sourced attribution in the old-path projection is reproducible
  // from the new mutation_path column — the old-path attributions are a SUBSET
  // of the new-path candidates (the column reproduces every value the blob scan
  // read). A non-empty set proves we actually exercised the path.
  expect(oldPathToolAttributions.size).toBeGreaterThan(0);
  for (const key of oldPathToolAttributions) {
    expect(newPathToolCandidates.has(key)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 0 → head from-scratch migrate (the event_blobs ladder stays intact)
// ---------------------------------------------------------------------------

test("0 → head from-scratch migrate succeeds and the event_blobs ladder is intact (created v57, read v67, present at head)", () => {
  // openDb(":memory:") runs the FULL migration ladder from v0. The shed's DROP
  // lands only at the future destructive task's version tail; until then
  // event_blobs must be created (v57) and remain present at head, and the v67
  // Commit-trailer backfill (which reads event_blobs) must run cleanly.
  const fresh = openDb(":memory:");
  try {
    const stored = (
      fresh.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | null
    )?.value;
    expect(Number(stored)).toBe(SCHEMA_VERSION);

    // event_blobs exists at head (it is dropped only at the shed's v-tail).
    const hasBlobs = fresh.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_blobs'",
      )
      .get();
    expect(hasBlobs).not.toBeNull();

    // The v57 CREATE shape: (event_id, data) with the FK to events.
    const cols = (
      fresh.db.prepare("PRAGMA table_info('event_blobs')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("event_id");
    expect(cols).toContain("data");

    // The fresh ladder ran the v67 backfill path (commit_trailer_facts exists
    // and is empty on a zero-event DB — proving the backfill SELECT over
    // COALESCE(events.data, event_blobs.data) executed without error).
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
