/**
 * Integration tests for the three read-only history verbs (epic fn-794):
 * `search-history`, `find-file-history`, `show-session-events`. Each spawns the
 * real CLI (`bun cli/keeper.ts <verb> ...`) against a sandboxed KEEPER_DB with
 * seeded rows, asserting the JSON-on-stdout envelope.
 *
 * The search test pins the COALESCE behavior: one seeded UserPromptSubmit whose
 * inline `data` is NULL with the payload relocated to `event_blobs` (a compacted
 * event) MUST still match and re-read — otherwise older events are silently
 * missed.
 *
 * Per the CLAUDE.md isolation rule every spawn routes through `sandboxEnv`,
 * pinning ALL KEEPER_* state paths under the per-test tmpDir.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { sandboxEnv as buildSandboxEnv } from "./helpers/sandbox-env";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const KEEPER_CLI = join(ROOT, "cli", "keeper.ts");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-hist-")));
  dbPath = join(tmpDir, "keeper.db");
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sandboxEnv(): Record<string, string> {
  return buildSandboxEnv({ tmpDir, dbPath });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runVerb(verb: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", KEEPER_CLI, verb, ...args], {
    cwd: tmpDir,
    env: sandboxEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Insert an event row; `data` NULL relocates the payload to `event_blobs`. */
function seedEvent(
  db: Database,
  row: {
    ts: number;
    sessionId: string;
    hookEvent: string;
    toolName?: string | null;
    slashCommand?: string | null;
    skillName?: string | null;
    planctlOp?: string | null;
    data?: string | null;
    blob?: string | null;
  },
): void {
  db.run(
    `INSERT INTO events
       (ts, session_id, hook_event, event_type, tool_name,
        slash_command, skill_name, planctl_op, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.sessionId,
      row.hookEvent,
      row.hookEvent,
      row.toolName ?? null,
      row.slashCommand ?? null,
      row.skillName ?? null,
      row.planctlOp ?? null,
      row.data ?? null,
    ],
  );
  if (row.blob != null) {
    const id = (
      db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
    ).id;
    db.run("INSERT INTO event_blobs (event_id, data) VALUES (?, ?)", [
      id,
      row.blob,
    ]);
  }
}

function seedFileAttribution(
  db: Database,
  row: {
    projectDir: string;
    sessionId: string;
    filePath: string;
    lastMutationAt: number;
    op: string;
    source: string;
  },
): void {
  db.run(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.projectDir,
      row.sessionId,
      row.filePath,
      row.lastMutationAt,
      null,
      row.op,
      row.source,
    ],
  );
}

describe("search-history", () => {
  test("matches inline AND compacted (relocated-blob) prompts, JSON on stdout", async () => {
    const { db } = openDb(dbPath);
    // Inline payload.
    seedEvent(db, {
      ts: 100,
      sessionId: "s1",
      hookEvent: "UserPromptSubmit",
      data: JSON.stringify({ prompt: "please refactor the widget" }),
    });
    // Compacted: inline data NULL, payload relocated to event_blobs.
    seedEvent(db, {
      ts: 200,
      sessionId: "s2",
      hookEvent: "UserPromptSubmit",
      data: null,
      blob: JSON.stringify({ prompt: "refactor the gadget too" }),
    });
    // Non-matching prompt.
    seedEvent(db, {
      ts: 300,
      sessionId: "s3",
      hookEvent: "UserPromptSubmit",
      data: JSON.stringify({ prompt: "unrelated request" }),
    });
    db.close();

    const res = await runVerb("search-history", ["refactor"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    // Most-recent-first: the compacted row (ts 200) precedes the inline row.
    expect(
      parsed.matches.map((m: { session_id: string }) => m.session_id),
    ).toEqual(["s2", "s1"]);
    expect(parsed.matches[0].prompt).toBe("refactor the gadget too");
    expect(parsed.matches[1].prompt).toBe("please refactor the widget");
  });

  test("a literal-wildcard fragment matches only the literal row (escapeLike)", async () => {
    const { db } = openDb(dbPath);
    // Literal '%' in the prompt — the row the fragment '50%' must match.
    seedEvent(db, {
      ts: 100,
      sessionId: "lit",
      hookEvent: "UserPromptSubmit",
      data: JSON.stringify({ prompt: "deploy 50% done" }),
    });
    // Would match '50%' ONLY if '%' were a LIKE wildcard (50<anything>done).
    seedEvent(db, {
      ts: 200,
      sessionId: "wild",
      hookEvent: "UserPromptSubmit",
      data: JSON.stringify({ prompt: "deploy 5099 done" }),
    });
    db.close();

    const res = await runVerb("search-history", ["50%"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(
      parsed.matches.map((m: { session_id: string }) => m.session_id),
    ).toEqual(["lit"]);
  });
});

describe("find-file-history", () => {
  test("lists file_attributions matches most-recent-first", async () => {
    const { db } = openDb(dbPath);
    seedFileAttribution(db, {
      projectDir: "/repo",
      sessionId: "s1",
      filePath: "src/widget.ts",
      lastMutationAt: 100,
      op: "edit",
      source: "tool",
    });
    seedFileAttribution(db, {
      projectDir: "/repo",
      sessionId: "s2",
      filePath: "src/widget.ts",
      lastMutationAt: 300,
      op: "write",
      source: "bash",
    });
    seedFileAttribution(db, {
      projectDir: "/repo",
      sessionId: "s3",
      filePath: "src/other.ts",
      lastMutationAt: 200,
      op: "edit",
      source: "tool",
    });
    db.close();

    const res = await runVerb("find-file-history", ["widget"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.matches).toHaveLength(2);
    // Most-recent-first by last_mutation_at: ts 300 before ts 100.
    expect(parsed.matches[0].session_id).toBe("s2");
    expect(parsed.matches[0].op).toBe("write");
    expect(parsed.matches[0].source).toBe("bash");
    expect(parsed.matches[0].last_mutation_at).toBe(300);
    expect(parsed.matches[1].session_id).toBe("s1");
  });

  test("a literal-wildcard fragment matches only the literal row (escapeLike)", async () => {
    const { db } = openDb(dbPath);
    // Literal '_' in the path — the row the fragment 'a_b' must match.
    seedFileAttribution(db, {
      projectDir: "/repo",
      sessionId: "lit",
      filePath: "src/a_b.ts",
      lastMutationAt: 100,
      op: "edit",
      source: "tool",
    });
    // Would match 'a_b' ONLY if '_' were a single-char LIKE wildcard (a<x>b).
    seedFileAttribution(db, {
      projectDir: "/repo",
      sessionId: "wild",
      filePath: "src/axb.ts",
      lastMutationAt: 200,
      op: "edit",
      source: "tool",
    });
    db.close();

    const res = await runVerb("find-file-history", ["a_b"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(
      parsed.matches.map((m: { session_id: string }) => m.session_id),
    ).toEqual(["lit"]);
  });

  test("a read failure emits { success: false, error }, not an empty result", async () => {
    // Drop the table the verb reads so the LIKE scan throws inside the verb.
    const { db } = openDb(dbPath);
    db.run("DROP TABLE file_attributions");
    db.close();

    const res = await runVerb("find-file-history", ["widget"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.matches).toBeUndefined();
  });
});

describe("show-session-events", () => {
  test("emits the prompt/tool-call spine for one session, in order", async () => {
    const { db } = openDb(dbPath);
    seedEvent(db, {
      ts: 100,
      sessionId: "s1",
      hookEvent: "UserPromptSubmit",
      slashCommand: "/plan:plan",
      data: JSON.stringify({ prompt: "/plan:plan do a thing" }),
    });
    seedEvent(db, {
      ts: 200,
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolName: "Bash",
      planctlOp: "done",
    });
    seedEvent(db, {
      ts: 250,
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolName: "Skill",
      skillName: "plan:plan",
    });
    // Non-spine event for s1 (excluded), and another session (excluded).
    seedEvent(db, {
      ts: 300,
      sessionId: "s1",
      hookEvent: "PostToolUse",
      toolName: "Bash",
    });
    seedEvent(db, { ts: 400, sessionId: "s2", hookEvent: "UserPromptSubmit" });
    db.close();

    const res = await runVerb("show-session-events", ["--session-id", "s1"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.session_id).toBe("s1");
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]).toMatchObject({
      hook_event: "UserPromptSubmit",
      slash_command: "/plan:plan",
    });
    expect(parsed.events[1]).toMatchObject({
      hook_event: "PreToolUse",
      tool_name: "Bash",
      planctl_op: "done",
    });
    expect(parsed.events[2]).toMatchObject({
      hook_event: "PreToolUse",
      tool_name: "Skill",
      skill_name: "plan:plan",
    });
  });

  test("--session-id is required", async () => {
    const res = await runVerb("show-session-events", []);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--session-id is required");
  });

  test("a read failure emits { success: false, error }, not an empty result", async () => {
    // Drop the table the verb reads so the spine scan throws inside the verb.
    const { db } = openDb(dbPath);
    db.run("DROP TABLE events");
    db.close();

    const res = await runVerb("show-session-events", ["--session-id", "s1"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.events).toBeUndefined();
  });
});
