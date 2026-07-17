/**
 * Foundation-primitive tests for the `keeper commit-work` family (epic fn-715
 * task 1). Covers the four shared primitives that the later per-subcommand
 * tasks build on:
 *
 *   - session-id resolution precedence (arg → JOBCTL_SESSION_ID →
 *     CLAUDE_CODE_SESSION_ID → KEEPER_JOB_ID → null);
 *   - the `get_session_dirty_files` attribution reader against a temp git repo
 *     + sandboxed KEEPER_DB (parity output, per-repo fail-open, cwd_repo
 *     resolution, `.keeper/` board-dir client-side exclusion);
 *   - the `flock(2)` FFI primitive (acquire/release; a second concurrent
 *     non-blocking acquire blocks; constants are the on-the-wire values);
 *   - the write-capable git-exec helper draining both streams concurrently.
 *
 * Per the CLAUDE.md isolation rule the DB lives under a per-test tmpdir via the
 * KEEPER_DB override — the user's real `~/.local/state/keeper/keeper.db` is
 * never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  piEventBindings,
  preparePiMutationEvent,
  serializePiLine,
} from "../plugins/keeper/pi-extension/keeper-events";
import {
  serializeBirthIntent,
  serializeBirthRecord,
} from "../src/birth-record";
import {
  discoverSessionFiles,
  getSessionDirtyFiles,
} from "../src/commit-work/attribution";
import { CommitWorkLock, FLOCK_CONSTANTS } from "../src/commit-work/flock";
import { resolveSessionId } from "../src/commit-work/session-id";
import {
  defaultCommitWorkBirthDir,
  readOwnershipClaims,
} from "../src/commit-work/surface";
import { openDb } from "../src/db";
import {
  serializeDeadLetterRecord,
  serializeEventLogRecord,
} from "../src/dead-letter";
import {
  ATTRIBUTION_FLOOR_PATH,
  ATTRIBUTION_FLOOR_SESSION_ID,
} from "../src/git-attribution-floor";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let eventsLogDir: string;
let deadLetterDir: string;
let birthDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-commit-work-"));
  dbPath = join(tmpDir, "keeper.db");
  eventsLogDir = join(tmpDir, "events-log");
  deadLetterDir = join(tmpDir, "dead-letters");
  birthDir = join(tmpDir, "births");
  mkdirSync(eventsLogDir);
  mkdirSync(deadLetterDir);
  mkdirSync(join(birthDir, "new"), { recursive: true });
  // fn-769 file variant: seeds and the attribution reader open this SAME path
  // across separate connections, so the migrated schema must live on disk.
  // Pre-write the template image once (skipping the ladder); later opens pass
  // `migrate: false` since the file is already at the current schema_version.
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session-id resolution
// ---------------------------------------------------------------------------

describe("resolveSessionId", () => {
  test("explicit arg wins over both env vars", () => {
    expect(
      resolveSessionId("arg-sid", {
        JOBCTL_SESSION_ID: "jobctl-sid",
        CLAUDE_CODE_SESSION_ID: "claude-sid",
      }),
    ).toBe("arg-sid");
  });

  test("JOBCTL_SESSION_ID wins over CLAUDE_CODE_SESSION_ID", () => {
    expect(
      resolveSessionId(null, {
        JOBCTL_SESSION_ID: "jobctl-sid",
        CLAUDE_CODE_SESSION_ID: "claude-sid",
      }),
    ).toBe("jobctl-sid");
  });

  test("falls back to CLAUDE_CODE_SESSION_ID", () => {
    expect(
      resolveSessionId(null, {
        CLAUDE_CODE_SESSION_ID: "claude-sid",
        KEEPER_JOB_ID: "pi-job",
      }),
    ).toBe("claude-sid");
  });

  test("uses KEEPER_JOB_ID for tracked Pi sessions", () => {
    expect(resolveSessionId(null, { KEEPER_JOB_ID: "pi-job" })).toBe("pi-job");
  });

  test("returns null when no source is set", () => {
    expect(resolveSessionId(null, {})).toBeNull();
    expect(resolveSessionId(undefined, {})).toBeNull();
    expect(resolveSessionId("", {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attribution reader
// ---------------------------------------------------------------------------

function readClaims(
  worktree = "/repo",
  hooks: Parameters<typeof readOwnershipClaims>[2] = {},
) {
  return readOwnershipClaims(worktree, dbPath, {
    eventsLogDir,
    deadLetterDir,
    birthDir,
    ...hooks,
  });
}

/** Seed an undischarged file_attributions row in the temp DB. */
function seedAttribution(opts: {
  projectDir: string;
  sessionId: string;
  filePath: string;
  lastMutationAt?: number;
  lastCommitAt?: number | null;
  source?: string;
}): void {
  const { db } = openDb(dbPath, { migrate: false });
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      opts.projectDir,
      opts.sessionId,
      opts.filePath,
      opts.lastMutationAt ?? 100,
      opts.lastCommitAt ?? null,
      "edit",
      opts.source ?? "tool",
    ],
  );
  db.close();
}

describe("readOwnershipClaims", () => {
  test("uses the OS account home for the authority-sensitive birth tree", () => {
    expect(defaultCommitWorkBirthDir()).toBe(
      join(userInfo().homedir, ".local", "state", "keeper", "births"),
    );
  });

  test("includes exact tool mutations above the root's pre-read Git watermark", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'working', 1)",
    );
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       VALUES ('/repo', 1, 0)`,
    );
    const mutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/a.ts')`,
    );
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (2, 'outside', 'PostToolUse', 'post_tool_use', 'Write', '/other', '{}', '/other/a.ts')`,
    );
    db.close();

    expect(readClaims()).toEqual([
      {
        path: "a.ts",
        sessionId: "foreign",
        liveness: "live",
        state: "working",
        oid: null,
        mode: null,
        source: "direct",
      },
    ]);

    const { db: folded } = openDb(dbPath, { migrate: false });
    folded.run(
      `INSERT INTO file_attributions
         (project_dir, session_id, file_path, last_mutation_at, op, source,
          last_event_id, updated_at)
       VALUES ('/repo', 'foreign', 'a.ts', 1, 'Write', 'tool', ?, 1)`,
      [mutation.lastInsertRowid],
    );
    folded.run(
      "UPDATE git_status SET attribution_event_id = ? WHERE project_dir = '/repo'",
      [mutation.lastInsertRowid],
    );
    folded.close();

    const claims = readClaims();
    expect(claims).toHaveLength(1);
    expect(claims?.[0]).toMatchObject({
      path: "a.ts",
      sessionId: "foreign",
      source: "tool",
    });
  });

  test("a never-observed root conservatively scans exact mutations from genesis", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'working', 1)",
    );
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/genesis.ts')`,
    );
    db.close();

    expect(readClaims()).toEqual([
      {
        path: "genesis.ts",
        sessionId: "foreign",
        liveness: "live",
        state: "working",
        oid: null,
        mode: null,
        source: "direct",
      },
    ]);
  });

  test("merges a foreign exact mutation receipt before daemon ingestion", () => {
    const repo = join(tmpDir, "repo");
    mkdirSync(join(repo, "real"), { recursive: true });
    writeFileSync(join(repo, "real", "late.ts"), "late\n");
    symlinkSync("real", join(repo, "alias"));

    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'working', 1)",
    );
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       VALUES (?, 1, 0)`,
      [repo],
    );
    db.close();
    writeFileSync(
      join(eventsLogDir, "123.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "foreign",
          hook_event: "PostToolUse",
          tool_name: "Write",
          mutation_path: join(repo, "alias", "late.ts"),
        },
      }),
    );

    expect(readClaims(repo)).toEqual([
      {
        path: "real/late.ts",
        sessionId: "foreign",
        liveness: "live",
        state: "working",
        oid: null,
        mode: null,
        source: "direct",
      },
    ]);
  });

  test("an un-ingested successful Pi write is immediately ownership-visible", () => {
    const repo = join(tmpDir, "pi-repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "pi-owned.ts"), "owned\n");
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at, harness) VALUES ('pi-foreign', 1, 'working', 1, 'pi')",
    );
    db.close();
    const event = preparePiMutationEvent(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "pi-owned.ts", content: "owned" },
        isError: false,
      },
      repo,
    );
    const bindings = piEventBindings(event, {
      jobId: "pi-foreign",
      pid: 4242,
      cwd: repo,
      tsSec: 2,
    });
    if (bindings === null) throw new Error("expected Pi mutation bindings");
    writeFileSync(join(eventsLogDir, "pi.ndjson"), serializePiLine(bindings));

    expect(readClaims(repo)).toEqual([
      expect.objectContaining({
        path: "pi-owned.ts",
        sessionId: "pi-foreign",
        liveness: "live",
        source: "direct",
      }),
    ]);
  });

  test("present-null canonical mutation evidence fails closed before and after ingest", () => {
    const data = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "unstable.ts" },
    });
    writeFileSync(
      join(eventsLogDir, "canonical-unavailable.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "pi-foreign",
          hook_event: "PostToolUse",
          tool_name: "Write",
          cwd: "/repo",
          data,
          mutation_path: null,
        },
      }),
    );
    expect(readClaims()).toBeNull();

    rmSync(eventsLogDir, { recursive: true, force: true });
    mkdirSync(eventsLogDir);
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (1, 'pi-foreign', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', ?, NULL)`,
      [data],
    );
    db.close();
    expect(readClaims()).toBeNull();
  });

  test("legacy relative receipts resolve against the producer cwd", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'working', 1)",
    );
    db.close();
    writeFileSync(
      join(eventsLogDir, "legacy-relative.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "foreign",
          hook_event: "PostToolUse",
          tool_name: "Write",
          cwd: "/repo/sub",
          data: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_input: { file_path: "file.ts" },
          }),
        },
      }),
    );

    expect(readClaims()).toEqual([
      expect.objectContaining({
        path: "sub/file.ts",
        sessionId: "foreign",
        source: "direct",
      }),
    ]);
  });

  test("fresh pending and receipt mutations never inherit stale terminal liveness", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'ended', 1)",
    );
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       VALUES ('/repo', 1, 0)`,
    );
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', '{}', '/repo/pending.ts')`,
    );
    db.close();
    writeFileSync(
      join(eventsLogDir, "terminal-lag.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "foreign",
          hook_event: "PostToolUse",
          tool_name: "Write",
          mutation_path: "/repo/receipt.ts",
        },
      }),
    );

    expect(readClaims()).toEqual([
      expect.objectContaining({
        path: "pending.ts",
        sessionId: "foreign",
        liveness: "unknown",
        state: "ended",
        source: "direct",
      }),
      expect.objectContaining({
        path: "receipt.ts",
        sessionId: "foreign",
        liveness: "unknown",
        state: "ended",
        source: "direct",
      }),
    ]);
  });

  test("pending mutations accept a later folded terminal lifecycle proof", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `INSERT INTO jobs (job_id, created_at, state, updated_at)
       VALUES ('ended-after', 1, 'ended', 1),
              ('killed-after', 1, 'killed', 1),
              ('ended-before', 1, 'ended', 1),
              ('resume-pending', 1, 'ended', 1),
              ('receipt-pending', 1, 'ended', 1)`,
    );

    const endedMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (1, 'ended-after', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', '{}', '/repo/ended-after.ts')`,
    );
    const endedEvent = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (2, 'ended-after', 'SessionEnd', 'session_end', '/repo', '{}')`,
    );
    db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = 'ended-after'", [
      endedEvent.lastInsertRowid,
    ]);

    const killedMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (3, 'killed-after', 'PostToolUse', 'post_tool_use', 'Edit',
               '/repo', '{}', '/repo/killed-after.ts')`,
    );
    const killedEvent = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (4, 'killed-after', 'Killed', 'killed', '/repo', '{}')`,
    );
    db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = 'killed-after'", [
      killedEvent.lastInsertRowid,
    ]);

    const endedBefore = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (5, 'ended-before', 'SessionEnd', 'session_end', '/repo', '{}')`,
    );
    const lateMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (6, 'ended-before', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', '{}', '/repo/ended-before.ts')`,
    );
    db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = 'ended-before'", [
      endedBefore.lastInsertRowid,
    ]);

    const resumeMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (7, 'resume-pending', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', '{}', '/repo/resume-pending.ts')`,
    );
    const resumeTerminal = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (8, 'resume-pending', 'SessionEnd', 'session_end', '/repo', '{}')`,
    );
    const queuedResume = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (9, 'resume-pending', 'UserPromptSubmit', 'user_prompt_submit',
               '/repo', '{}')`,
    );
    db.run(
      "UPDATE jobs SET last_event_id = ? WHERE job_id = 'resume-pending'",
      [resumeTerminal.lastInsertRowid],
    );

    const receiptMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (10, 'receipt-pending', 'PostToolUse', 'post_tool_use', 'Write',
               '/repo', '{}', '/repo/receipt-pending.ts')`,
    );
    const receiptTerminal = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (11, 'receipt-pending', 'SessionEnd', 'session_end', '/repo', '{}')`,
    );
    db.run(
      "UPDATE jobs SET last_event_id = ? WHERE job_id = 'receipt-pending'",
      [receiptTerminal.lastInsertRowid],
    );
    db.run(
      "UPDATE reducer_state SET last_event_id = (SELECT MAX(id) FROM events) WHERE id = 1",
    );
    db.close();
    writeFileSync(
      join(eventsLogDir, "resume-receipt.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "receipt-pending",
          hook_event: "PostToolUse",
          tool_name: "Write",
          mutation_path: "/other/resumed.ts",
        },
      }),
    );

    expect(Number(endedEvent.lastInsertRowid)).toBeGreaterThan(
      Number(endedMutation.lastInsertRowid),
    );
    expect(Number(killedEvent.lastInsertRowid)).toBeGreaterThan(
      Number(killedMutation.lastInsertRowid),
    );
    expect(Number(endedBefore.lastInsertRowid)).toBeLessThan(
      Number(lateMutation.lastInsertRowid),
    );
    expect(Number(resumeTerminal.lastInsertRowid)).toBeGreaterThan(
      Number(resumeMutation.lastInsertRowid),
    );
    expect(Number(queuedResume.lastInsertRowid)).toBeGreaterThan(
      Number(resumeTerminal.lastInsertRowid),
    );
    expect(Number(receiptTerminal.lastInsertRowid)).toBeGreaterThan(
      Number(receiptMutation.lastInsertRowid),
    );
    expect(readClaims()).toEqual([
      expect.objectContaining({
        path: "ended-after.ts",
        sessionId: "ended-after",
        liveness: "terminal",
        state: "ended",
        source: "direct",
      }),
      expect.objectContaining({
        path: "killed-after.ts",
        sessionId: "killed-after",
        liveness: "terminal",
        state: "killed",
        source: "direct",
      }),
      expect.objectContaining({
        path: "ended-before.ts",
        sessionId: "ended-before",
        liveness: "unknown",
        state: "ended",
        source: "direct",
      }),
      expect.objectContaining({
        path: "resume-pending.ts",
        sessionId: "resume-pending",
        liveness: "unknown",
        state: "ended",
        source: "direct",
      }),
      expect.objectContaining({
        path: "receipt-pending.ts",
        sessionId: "receipt-pending",
        liveness: "unknown",
        state: "ended",
        source: "direct",
      }),
    ]);
  });

  test("durable terminal claims require cursor-fresh lifecycle evidence", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `INSERT INTO jobs (job_id, created_at, state, updated_at)
       VALUES ('durable-terminal', 1, 'ended', 1),
              ('durable-resume', 1, 'ended', 1),
              ('durable-cross-repo', 1, 'ended', 1),
              ('durable-receipt', 1, 'ended', 1),
              ('durable-birth', 1, 'ended', 1)`,
    );

    let ts = 1;
    const seedDurable = (sessionId: string, path: string) => {
      const mutation = db.run(
        `INSERT INTO events
           (ts, session_id, hook_event, event_type, tool_name, cwd, data,
            mutation_path)
         VALUES (?, ?, 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', ?)`,
        [ts++, sessionId, `/repo/${path}`],
      );
      const terminal = db.run(
        `INSERT INTO events
           (ts, session_id, hook_event, event_type, cwd, data)
         VALUES (?, ?, 'SessionEnd', 'session_end', '/repo', '{}')`,
        [ts++, sessionId],
      );
      db.run(
        `INSERT INTO file_attributions
           (project_dir, session_id, file_path, last_mutation_at, op, source,
            last_event_id, updated_at)
         VALUES ('/repo', ?, ?, 1, 'Write', 'tool', ?, 1)`,
        [sessionId, path, mutation.lastInsertRowid],
      );
      db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = ?", [
        terminal.lastInsertRowid,
        sessionId,
      ]);
      return terminal;
    };

    seedDurable("durable-terminal", "durable-terminal.ts");
    seedDurable("durable-resume", "durable-resume.ts");
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (?, 'durable-resume', 'UserPromptSubmit', 'user_prompt_submit',
               '/repo', '{}')`,
      [ts++],
    );
    seedDurable("durable-cross-repo", "durable-cross-repo.ts");
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data,
          mutation_path)
       VALUES (?, 'durable-cross-repo', 'PostToolUse', 'post_tool_use', 'Edit',
               '/other', '{}', '/other/new.ts')`,
      [ts++],
    );
    seedDurable("durable-receipt", "durable-receipt.ts");
    seedDurable("durable-birth", "durable-birth.ts");
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       SELECT '/repo', 1, MAX(id) FROM events`,
    );
    db.run(
      "UPDATE reducer_state SET last_event_id = (SELECT MAX(id) FROM events) WHERE id = 1",
    );
    db.close();
    mkdirSync(join(birthDir, "pending"));
    writeFileSync(
      join(birthDir, "pending", "777.intent.json"),
      serializeBirthIntent({
        schema_version: 1,
        session_id: "durable-birth",
        harness: "pi",
        launcher_pid: 777,
        launch_ts: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(birthDir, "new", "123.darwin-test.json"),
      serializeBirthRecord({
        schema_version: 1,
        session_id: "durable-birth",
        harness: "pi",
        pid: 123,
        start_time: "darwin:test",
        cwd: "/repo",
        spawn_name: null,
        config_dir: null,
        backend_exec_type: null,
        backend_exec_session_id: null,
        backend_exec_pane_id: null,
        worktree: null,
        launch_ts: "2026-01-01T00:00:00.000Z",
        resume_target: null,
        dispatch_attempt_id: null,
      }),
    );
    writeFileSync(
      join(eventsLogDir, "resume-lifecycle.ndjson"),
      serializeEventLogRecord({
        bindings: {
          session_id: "durable-receipt",
          hook_event: "SessionStart",
        },
      }),
    );

    const claims = readClaims();
    expect(claims).toHaveLength(5);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "durable-terminal.ts",
          sessionId: "durable-terminal",
          liveness: "terminal",
          state: "ended",
          source: "tool",
        }),
        expect.objectContaining({
          path: "durable-resume.ts",
          sessionId: "durable-resume",
          liveness: "unknown",
          state: "ended",
          source: "tool",
        }),
        expect.objectContaining({
          path: "durable-cross-repo.ts",
          sessionId: "durable-cross-repo",
          liveness: "terminal",
          state: "ended",
          source: "tool",
        }),
        expect.objectContaining({
          path: "durable-receipt.ts",
          sessionId: "durable-receipt",
          liveness: "unknown",
          state: "ended",
          source: "tool",
        }),
        expect.objectContaining({
          path: "durable-birth.ts",
          sessionId: "durable-birth",
          liveness: "unknown",
          state: "ended",
          source: "tool",
        }),
      ]),
    );
  });

  test("unresolved same-session dead letters invalidate terminal proof", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `INSERT INTO jobs (job_id, created_at, state, updated_at)
       VALUES ('dead-lifecycle', 1, 'ended', 1),
              ('dead-cross-repo', 1, 'ended', 1)`,
    );
    let ts = 1;
    for (const sessionId of ["dead-lifecycle", "dead-cross-repo"]) {
      const path = `${sessionId}.ts`;
      const mutation = db.run(
        `INSERT INTO events
           (ts, session_id, hook_event, event_type, tool_name, cwd, data,
            mutation_path)
         VALUES (?, ?, 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', ?)`,
        [ts++, sessionId, `/repo/${path}`],
      );
      const terminal = db.run(
        `INSERT INTO events
           (ts, session_id, hook_event, event_type, cwd, data)
         VALUES (?, ?, 'SessionEnd', 'session_end', '/repo', '{}')`,
        [ts++, sessionId],
      );
      db.run(
        `INSERT INTO file_attributions
           (project_dir, session_id, file_path, last_mutation_at, op, source,
            last_event_id, updated_at)
         VALUES ('/repo', ?, ?, 1, 'Write', 'tool', ?, 1)`,
        [sessionId, path, mutation.lastInsertRowid],
      );
      db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = ?", [
        terminal.lastInsertRowid,
        sessionId,
      ]);
    }
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       SELECT '/repo', 1, MAX(id) FROM events`,
    );
    db.run(
      "UPDATE reducer_state SET last_event_id = (SELECT MAX(id) FROM events) WHERE id = 1",
    );
    db.close();

    writeFileSync(
      join(deadLetterDir, "444.ndjson"),
      serializeDeadLetterRecord({
        dl_id: "dead-lifecycle-resume",
        session_id: "dead-lifecycle",
        hook_event: "SessionStart",
        ts: 10,
        dl_written_at: 11,
        pid: 444,
        bindings: {
          session_id: "dead-lifecycle",
          hook_event: "SessionStart",
        },
      }) +
        serializeDeadLetterRecord({
          dl_id: "dead-cross-repo-mutation",
          session_id: "dead-cross-repo",
          hook_event: "PostToolUse",
          ts: 12,
          dl_written_at: 13,
          pid: 444,
          bindings: {
            session_id: "dead-cross-repo",
            hook_event: "PostToolUse",
            tool_name: "Edit",
            mutation_path: "/other/new.ts",
          },
        }),
    );

    expect(readClaims()).toEqual([
      expect.objectContaining({
        path: "dead-cross-repo.ts",
        sessionId: "dead-cross-repo",
        liveness: "unknown",
      }),
      expect.objectContaining({
        path: "dead-lifecycle.ts",
        sessionId: "dead-lifecycle",
        liveness: "unknown",
      }),
    ]);
  });

  test("fails closed on unclassifiable poison dead-letter evidence", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `INSERT INTO dead_letters
         (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings, status)
       VALUES ('poison-event', 'poison', 'PoisonEventLogRecord', 1, 2, 444,
               '{"raw":"unclassifiable"}', 'poison')`,
    );
    db.close();
    expect(readClaims()).toBeNull();
  });

  test("fails closed while an exact mutation waits in the dead-letter channel", () => {
    writeFileSync(
      join(deadLetterDir, "321.ndjson"),
      serializeDeadLetterRecord({
        dl_id: "dead-mutation-1",
        session_id: "foreign",
        hook_event: "PostToolUse",
        ts: 1,
        dl_written_at: 2,
        pid: 321,
        bindings: {
          session_id: "foreign",
          hook_event: "PostToolUse",
          ts: 1,
          tool_name: "Write",
          mutation_path: "/repo/dead.ts",
        },
      }),
    );
    expect(readClaims()).toBeNull();
  });

  test("rechecks the dead-letter tree after the final event-head read", () => {
    expect(
      readClaims("/repo", {
        afterDeadLetterRead: () => {
          writeFileSync(
            join(deadLetterDir, "late.ndjson"),
            serializeDeadLetterRecord({
              dl_id: "dead-mutation-late",
              session_id: "foreign",
              hook_event: "PostToolUse",
              ts: 1,
              dl_written_at: 2,
              pid: 322,
              bindings: {
                session_id: "foreign",
                hook_event: "PostToolUse",
                ts: 1,
                tool_name: "Write",
                mutation_path: "/repo/late-dead.ts",
              },
            }),
          );
        },
      }),
    ).toBeNull();
  });

  test("fails closed when a dead-letter imports during its disk scan", () => {
    let imported = false;
    expect(
      readClaims("/repo", {
        duringDeadLetterRead: () => {
          if (imported) return;
          imported = true;
          const { db } = openDb(dbPath, { migrate: false });
          db.run(
            `INSERT INTO dead_letters
               (dl_id, session_id, hook_event, ts, dl_written_at, pid,
                bindings, status, recovered_at, replayed_event_id)
             VALUES ('import-race', 'foreign', 'PostToolUse', 1, 2, 333,
                     ?, 'recovered', 3, 1)`,
            [
              JSON.stringify({
                session_id: "foreign",
                hook_event: "PostToolUse",
                tool_name: "Write",
                mutation_path: "/repo/imported.ts",
              }),
            ],
          );
          db.close();
        },
      }),
    ).toBeNull();
    expect(imported).toBe(true);
  });

  test("fails closed when a receipt is ingested and deleted across the DB snapshot", () => {
    const receipt = join(eventsLogDir, "late.ndjson");
    let moved = false;
    const claims = readClaims("/repo", {
      afterReceiptRead: () => {
        writeFileSync(
          receipt,
          serializeEventLogRecord({
            bindings: {
              session_id: "foreign",
              hook_event: "PostToolUse",
              tool_name: "Write",
              mutation_path: "/repo/handoff.ts",
            },
          }),
        );
        const { db } = openDb(dbPath, { migrate: false });
        db.run(
          `INSERT INTO events
             (ts, session_id, hook_event, event_type, tool_name, cwd, data,
              mutation_path)
           VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write',
                   '/repo', '{}', '/repo/handoff.ts')`,
        );
        db.close();
        unlinkSync(receipt);
        moved = true;
      },
    });

    expect(moved).toBe(true);
    // The old SQLite snapshot and both directory listings are individually
    // empty, but the fresh append-only head exposes the source handoff.
    expect(claims).toBeNull();
  });

  test("cannot miss a reducer fold between durable and watermark reads", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('foreign', 1, 'working', 1)",
    );
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       VALUES ('/repo', 1, 0)`,
    );
    const mutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/race.ts')`,
    );
    db.close();

    let folded = false;
    const claims = readClaims("/repo", {
      afterDurableRead: () => {
        const { db: writer } = openDb(dbPath, { migrate: false });
        writer
          .transaction(() => {
            writer.run(
              `INSERT INTO file_attributions
               (project_dir, session_id, file_path, last_mutation_at, op,
                source, last_event_id, updated_at)
             VALUES ('/repo', 'foreign', 'race.ts', 1, 'Write', 'tool', ?, 1)`,
              [mutation.lastInsertRowid],
            );
            writer.run(
              "UPDATE git_status SET attribution_event_id = ? WHERE project_dir = '/repo'",
              [mutation.lastInsertRowid],
            );
          })
          .immediate();
        writer.close();
        folded = true;
      },
    });

    expect(folded).toBe(true);
    // The reader's one snapshot predates the fold: its durable set is empty,
    // but its old watermark still admits the exact event through the tail.
    expect(claims).toEqual([
      {
        path: "race.ts",
        sessionId: "foreign",
        liveness: "live",
        state: "working",
        oid: null,
        mode: null,
        source: "direct",
      },
    ]);
  });

  test("a dropped root reads its retained sentinel floor", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES ('old', 1, 'working', 1), ('new', 1, 'working', 1)",
    );
    const oldMutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1, 'old', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/old.ts')`,
    );
    db.run(
      `INSERT INTO file_attributions
         (project_dir, session_id, file_path, last_mutation_at, last_commit_at,
          op, source, last_event_id, updated_at)
       VALUES (?, ?, ?, 1, 1, 'attribution-floor', 'plan', ?, 1)`,
      [
        "/repo",
        ATTRIBUTION_FLOOR_SESSION_ID,
        ATTRIBUTION_FLOOR_PATH,
        oldMutation.lastInsertRowid,
      ],
    );
    db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (2, 'new', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/new.ts')`,
    );
    db.close();

    expect(readClaims()).toEqual([
      {
        path: "new.ts",
        sessionId: "new",
        liveness: "live",
        state: "working",
        oid: null,
        mode: null,
        source: "direct",
      },
    ]);
  });

  test("durable claim overflow returns unavailable rather than truncating", () => {
    const { db } = openDb(dbPath, { migrate: false });
    db.run(
      `WITH RECURSIVE n(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM n WHERE value < 10000
       )
       INSERT INTO file_attributions
         (project_dir, session_id, file_path, last_mutation_at, op, source)
       SELECT '/repo', 'foreign-' || value, 'f-' || value, 1, 'Write', 'tool'
         FROM n`,
    );
    db.close();

    expect(readClaims()).toBeNull();
  });

  test("future or corrupt persisted watermarks make ownership unavailable", () => {
    const { db } = openDb(dbPath, { migrate: false });
    const mutation = db.run(
      `INSERT INTO events
         (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (1, 'foreign', 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/a.ts')`,
    );
    db.run(
      `INSERT INTO git_status
         (project_dir, updated_at, attribution_event_id)
       VALUES ('/repo', 1, ?)`,
      [Number(mutation.lastInsertRowid) + 1],
    );
    db.close();

    expect(readClaims()).toBeNull();

    const { db: corrupt } = openDb(dbPath, { migrate: false });
    corrupt.run(
      "UPDATE git_status SET attribution_event_id = -1 WHERE project_dir = '/repo'",
    );
    corrupt.close();
    expect(readClaims()).toBeNull();
  });
});

describe("getSessionDirtyFiles", () => {
  test("returns on-hook files intersected with the live dirty set, sorted", () => {
    const repo = "/repo/a";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "z.ts" });
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "a.ts" });
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "clean.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      // a.ts + z.ts dirty; clean.ts is NOT dirty so it must be dropped.
      liveDirtyPaths: () => new Set(["a.ts", "z.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/a": ["a.ts", "z.ts"] });
    expect(result.cwdRepo).toBe("/repo/a");
  });

  test("discharged rows (last_commit_at >= last_mutation_at) are excluded", () => {
    const repo = "/repo/b";
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "discharged.ts",
      lastMutationAt: 100,
      lastCommitAt: 200, // committed AFTER the mutation → discharged
    });
    seedAttribution({
      projectDir: repo,
      sessionId: "s1",
      filePath: "live.ts",
      lastMutationAt: 100,
      lastCommitAt: 50, // mutation AFTER the last commit → still on hook
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["discharged.ts", "live.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/b": ["live.ts"] });
  });

  test("fails OPEN per-repo: an unreadable git status keeps all on-hook files", () => {
    const okRepo = "/repo/ok";
    const brokenRepo = "/repo/broken";
    seedAttribution({ projectDir: okRepo, sessionId: "s1", filePath: "a.ts" });
    seedAttribution({ projectDir: okRepo, sessionId: "s1", filePath: "b.ts" });
    seedAttribution({
      projectDir: brokenRepo,
      sessionId: "s1",
      filePath: "kept-1.ts",
    });
    seedAttribution({
      projectDir: brokenRepo,
      sessionId: "s1",
      filePath: "kept-2.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      // okRepo intersects normally; brokenRepo returns null → fail open.
      liveDirtyPaths: (dir) => (dir === okRepo ? new Set(["a.ts"]) : null),
      gitRoot: () => okRepo,
    });

    expect(result.filesByRepo).toEqual({
      "/repo/ok": ["a.ts"],
      // ALL of brokenRepo's on-hook files survive (sorted) — never dropped.
      "/repo/broken": ["kept-1.ts", "kept-2.ts"],
    });
  });

  test("repos with no surviving file are omitted entirely", () => {
    const repo = "/repo/empty";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "gone.ts" });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(), // nothing dirty
      gitRoot: () => null,
    });

    expect(result.filesByRepo).toEqual({});
    expect(result.cwdRepo).toBeNull();
  });

  test("another session's rows are not visible", () => {
    const repo = "/repo/c";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "mine.ts" });
    seedAttribution({
      projectDir: repo,
      sessionId: "s2",
      filePath: "theirs.ts",
    });

    const result = getSessionDirtyFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["mine.ts", "theirs.ts"]),
      gitRoot: () => repo,
    });

    expect(result.filesByRepo).toEqual({ "/repo/c": ["mine.ts"] });
  });
});

describe("discoverSessionFiles", () => {
  test("selects the cwd repo and drops .keeper/ board-dir paths client-side", () => {
    const repo = "/repo/d";
    for (const f of [
      "src/a.ts",
      ".keeper/epics/fn-1.json",
      ".keeper/specs/fn-1.md",
      "src/b.ts",
    ]) {
      seedAttribution({ projectDir: repo, sessionId: "s1", filePath: f });
    }

    const files = discoverSessionFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () =>
        new Set([
          "src/a.ts",
          ".keeper/epics/fn-1.json",
          ".keeper/specs/fn-1.md",
          "src/b.ts",
        ]),
      gitRoot: () => repo,
    });

    // .keeper/ (live board) paths excluded; remaining sorted (parity output
    // order).
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns [] when the cwd repo has nothing on the hook", () => {
    const repo = "/repo/e";
    seedAttribution({ projectDir: repo, sessionId: "s1", filePath: "a.ts" });

    const files = discoverSessionFiles("s1", "/cwd", {
      dbPath,
      liveDirtyPaths: () => new Set(["a.ts"]),
      // cwd resolves to a DIFFERENT repo with no on-hook rows.
      gitRoot: () => "/repo/other",
    });

    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flock primitive
// ---------------------------------------------------------------------------

describe("CommitWorkLock", () => {
  test("constants are the platform-correct flock(2)/fcntl/open values", () => {
    expect(FLOCK_CONSTANTS.LOCK_EX).toBe(2);
    expect(FLOCK_CONSTANTS.LOCK_NB).toBe(4);
    expect(FLOCK_CONSTANTS.LOCK_UN).toBe(8);
    expect(FLOCK_CONSTANTS.EWOULDBLOCK).toBe(
      process.platform === "darwin" ? 35 : 11,
    );
    expect(FLOCK_CONSTANTS.F_GETFD).toBe(1);
    expect(FLOCK_CONSTANTS.FD_CLOEXEC).toBe(1);
    expect(FLOCK_CONSTANTS.O_CLOEXEC).toBe(
      process.platform === "darwin" ? 0x1000000 : 0o2000000,
    );
  });

  test("atomic O_CLOEXEC open sets FD_CLOEXEC", () => {
    const lockPath = join(tmpDir, "keeper-commit-work-cloexec.lock");
    const lock = CommitWorkLock.acquire(lockPath);
    try {
      expect(lock.readFdFlagsForTest() & FLOCK_CONSTANTS.FD_CLOEXEC).toBe(
        FLOCK_CONSTANTS.FD_CLOEXEC,
      );
    } finally {
      lock.release();
    }
  });

  test("acquire then release round-trips; re-acquire after release succeeds", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = CommitWorkLock.acquire(lockPath);
    lock.release();
    // After release a fresh blocking acquire returns immediately.
    const again = CommitWorkLock.acquire(lockPath);
    again.release();
  });

  test("release is idempotent", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = CommitWorkLock.acquire(lockPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("a second concurrent (non-blocking) acquire blocks while held", () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    try {
      // tryAcquire must report contention (null) while `held` owns the lock.
      const second = CommitWorkLock.tryAcquire(lockPath);
      expect(second).toBeNull();
    } finally {
      held.release();
    }
    // Once released, tryAcquire succeeds.
    const third = CommitWorkLock.tryAcquire(lockPath);
    expect(third).not.toBeNull();
    third?.release();
  });

  test("acquireWithDeadline TIMES OUT (→ null) while another holder owns the lock", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    try {
      // Real FFI in-process: the held lock forces the bounded poll to exhaust its
      // (tiny) deadline and degrade to null — never a freeze on a blocking acquire.
      const start = Date.now();
      const timedOut = await CommitWorkLock.acquireWithDeadline(lockPath, 100);
      const elapsed = Date.now() - start;
      expect(timedOut).toBeNull();
      // It actually WAITED out the deadline (poll-retried), and bounded it — not an
      // instant null, not a runaway. Generous upper bound for CI scheduling jitter.
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      held.release();
    }
  });

  test("acquireWithDeadline returns the lock once the holder releases", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const held = CommitWorkLock.acquire(lockPath);
    // Release shortly; the bounded poll must then acquire well within its deadline.
    setTimeout(() => held.release(), 30);
    const lock = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("acquireWithDeadline takes a free lock on the first poll", async () => {
    const lockPath = join(tmpDir, "keeper-commit-work.lock");
    const lock = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(lock).not.toBeNull();
    lock?.release();
    // And a fresh bounded acquire after release succeeds immediately too.
    const again = await CommitWorkLock.acquireWithDeadline(lockPath, 5_000);
    expect(again).not.toBeNull();
    again?.release();
  });
});
