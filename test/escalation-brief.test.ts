/**
 * Pure in-process tests for `keeper escalation-brief` (`cli/escalation-brief.ts`)
 * — the cross-store escalation context envelope. Drives the pure
 * `buildEscalationBrief(db, key, cwd)` core against a `freshMemDb` keeper.db clone
 * with hand-seeded `epics` / `jobs` / `dispatch_failures` rows plus a tmp `.keeper`
 * tree, then the real `main()` for single-JSON-root output conformance on a
 * `freshDbFile`.
 *
 * Coverage: key parsing (both shapes + mismatches); a non-closer creator; a closer
 * creator resolving through `created_by_close_of` to the original creator; a
 * missing creator edge; a missing transcript; a dead creator (edge, no jobs row);
 * the unblock blocked-state incident + sibling scan; the deconflict merge-conflict
 * incident + resolver jobs; unparseable-key / unknown-incident exit-1 paths.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEscalationBrief,
  main,
  parseEscalationKey,
} from "../cli/escalation-brief";
import { freshDbFile, freshMemDb } from "./helpers/template-db";

// ── Seed helpers ───────────────────────────────────────────────────────────

interface JobLink {
  kind: string;
  job_id: string;
}

function seedEpic(
  db: Database,
  opts: { epic_id: string; project_dir?: string | null; job_links?: JobLink[] },
): void {
  db.query(
    "INSERT INTO epics (epic_id, updated_at, project_dir, job_links) VALUES (?, ?, ?, ?)",
  ).run(
    opts.epic_id,
    1,
    opts.project_dir ?? null,
    JSON.stringify(opts.job_links ?? []),
  );
}

function seedJob(
  db: Database,
  opts: {
    job_id: string;
    plan_verb?: string | null;
    plan_ref?: string | null;
    transcript_path?: string | null;
    state?: string;
    updated_at?: number;
  },
): void {
  db.query(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.job_id,
    1,
    opts.updated_at ?? 1,
    opts.state ?? "stopped",
    opts.plan_verb ?? null,
    opts.plan_ref ?? null,
    opts.transcript_path ?? null,
  );
}

function seedMergeConflict(
  db: Database,
  opts: {
    epic_id: string;
    reason: string;
    dir?: string | null;
    resolver_dispatched_at?: number | null;
    merge_escalated_at?: number | null;
  },
): void {
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        resolver_dispatched_at, merge_escalated_at)
     VALUES ('close', ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
  ).run(
    opts.epic_id,
    opts.reason,
    opts.dir ?? null,
    opts.resolver_dispatched_at ?? null,
    opts.merge_escalated_at ?? null,
  );
}

function writeEpicFile(
  root: string,
  epicId: string,
  fields: Record<string, unknown>,
): void {
  const dir = join(root, ".keeper", "epics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${epicId}.json`),
    JSON.stringify({ id: epicId, ...fields }),
  );
}

function writeTaskState(
  root: string,
  taskId: string,
  state: Record<string, unknown>,
): void {
  const dir = join(root, ".keeper", "state", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.state.json`), JSON.stringify(state));
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "escalation-brief-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── Key parsing ────────────────────────────────────────────────────────────

test("parseEscalationKey accepts both key shapes", () => {
  expect(parseEscalationKey("deconflict::fn-12-add-oauth")).toEqual({
    kind: "deconflict",
    epic_id: "fn-12-add-oauth",
  });
  expect(parseEscalationKey("unblock::fn-12-add-oauth.3")).toEqual({
    kind: "unblock",
    epic_id: "fn-12-add-oauth",
    task_id: "fn-12-add-oauth.3",
  });
});

test("parseEscalationKey rejects shape mismatches and garbage", () => {
  // deconflict wants an epic ref; a task ref is a mismatch.
  expect(parseEscalationKey("deconflict::fn-12-add-oauth.3")).toBeNull();
  // unblock wants a task ref; an epic ref is a mismatch.
  expect(parseEscalationKey("unblock::fn-12-add-oauth")).toBeNull();
  expect(parseEscalationKey("resolve::fn-12-add-oauth")).toBeNull();
  expect(parseEscalationKey("garbage")).toBeNull();
  expect(parseEscalationKey("deconflict::")).toBeNull();
});

// ── Error paths (exit non-zero) ────────────────────────────────────────────

test("an unparseable key returns the unparseable_key error", () => {
  const { db } = freshMemDb();
  const r = buildEscalationBrief(db, "not-a-key", tmp);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.code).toBe("unparseable_key");
  }
  db.close();
});

test("an epic present nowhere returns the unknown_incident error", () => {
  const { db } = freshMemDb();
  const r = buildEscalationBrief(db, "deconflict::fn-999-nope", tmp);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.code).toBe("unknown_incident");
  }
  db.close();
});

// ── Deconflict lineage: closer → original creator ──────────────────────────

test("a closer creator resolves through created_by_close_of to the original creator", () => {
  const { db } = freshMemDb();
  // The escalated child epic was created by a closer session that closed the
  // parent epic; the parent's own creator is the original (non-closer) creator.
  seedEpic(db, {
    epic_id: "fn-100-child",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "closer-sess" }],
  });
  seedJob(db, {
    job_id: "closer-sess",
    plan_verb: "close",
    plan_ref: "fn-50-parent",
    transcript_path: "/t/closer.jsonl",
    updated_at: 200,
  });
  seedEpic(db, {
    epic_id: "fn-50-parent",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "orig-sess" }],
  });
  seedJob(db, {
    job_id: "orig-sess",
    plan_verb: null,
    plan_ref: null,
    transcript_path: "/t/orig.jsonl",
    updated_at: 100,
  });
  writeEpicFile(tmp, "fn-100-child", {
    primary_repo: "/repo",
    created_by_close_of: "fn-50-parent",
  });
  writeEpicFile(tmp, "fn-50-parent", { primary_repo: "/repo" });
  seedMergeConflict(db, {
    epic_id: "fn-100-child",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-100-child into main — CONFLICT (content): foo.ts",
    dir: "/repo",
    resolver_dispatched_at: 123,
  });
  seedJob(db, {
    job_id: "resolve-sess",
    plan_verb: "resolve",
    plan_ref: "fn-100-child",
    transcript_path: "/t/resolve.jsonl",
    state: "ended",
  });

  const r = buildEscalationBrief(db, "deconflict::fn-100-child", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const b = r.brief;
  expect(b.kind).toBe("deconflict");
  expect(b.epic_id).toBe("fn-100-child");
  expect(b.task_id).toBeNull();
  expect(b.primary_repo).toBe("/repo");

  // Lineage: direct creator is the flagged closer; original is the parent creator.
  expect(b.lineage.creator?.session_id).toBe("closer-sess");
  expect(b.lineage.creator?.is_closer).toBe(true);
  expect(b.lineage.creator?.transcript_path).toBe("/t/closer.jsonl");
  expect(b.lineage.original_creator?.session_id).toBe("orig-sess");
  expect(b.lineage.original_creator?.is_closer).toBe(false);
  expect(b.lineage.original_creator?.transcript_path).toBe("/t/orig.jsonl");
  expect(b.lineage.chain.map((l) => l.epic_id)).toEqual([
    "fn-100-child",
    "fn-50-parent",
  ]);

  // Incident: parsed source/base branches + stderr, resolver job.
  const inc = b.incident as {
    conflict: {
      source_branch: string | null;
      base_branch: string | null;
      stderr: string | null;
      repo_dir: string | null;
      resolver_dispatched_at: number | null;
    } | null;
    resolver_jobs: Array<{
      session_id: string;
      state: string | null;
      transcript_path: string | null;
    }>;
  };
  expect(inc.conflict?.source_branch).toBe("keeper/epic/fn-100-child");
  expect(inc.conflict?.base_branch).toBe("main");
  expect(inc.conflict?.stderr).toBe("CONFLICT (content): foo.ts");
  expect(inc.conflict?.repo_dir).toBe("/repo");
  expect(inc.conflict?.resolver_dispatched_at).toBe(123);
  expect(inc.resolver_jobs).toEqual([
    {
      session_id: "resolve-sess",
      state: "ended",
      transcript_path: "/t/resolve.jsonl",
    },
  ]);

  // Fully resolved — no degraded flags.
  expect(b.degraded).toEqual([]);
  db.close();
});

// ── Unblock incident: non-closer creator + sibling scan ────────────────────

test("an unblock brief lifts the blocked reason, CATEGORY, and blocked siblings", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-200-solo",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "solo-sess" }],
  });
  seedJob(db, {
    job_id: "solo-sess",
    plan_verb: null,
    transcript_path: "/t/solo.jsonl",
  });
  writeEpicFile(tmp, "fn-200-solo", { primary_repo: "/repo" });
  writeTaskState(tmp, "fn-200-solo.1", {
    status: "blocked",
    blocked_reason:
      "BLOCKED: DEPENDENCY_BLOCKED\nSummary: the migration fn-199 has not landed",
  });
  writeTaskState(tmp, "fn-200-solo.2", {
    status: "blocked",
    blocked_reason: "",
  });
  writeTaskState(tmp, "fn-200-solo.3", { status: "todo" });

  const r = buildEscalationBrief(db, "unblock::fn-200-solo.1", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const b = r.brief;
  expect(b.kind).toBe("unblock");
  expect(b.epic_id).toBe("fn-200-solo");
  expect(b.task_id).toBe("fn-200-solo.1");

  // Non-closer creator: original == direct.
  expect(b.lineage.creator?.session_id).toBe("solo-sess");
  expect(b.lineage.creator?.is_closer).toBe(false);
  expect(b.lineage.original_creator?.session_id).toBe("solo-sess");
  expect(b.lineage.chain).toHaveLength(1);

  const inc = b.incident as {
    status: string | null;
    blocked_reason: string | null;
    category: string | null;
    blocked_siblings: string[];
  };
  expect(inc.status).toBe("blocked");
  expect(inc.category).toBe("DEPENDENCY_BLOCKED");
  expect(inc.blocked_reason).toContain("fn-199");
  // Only the OTHER blocked sibling (.2), never .1 (self) or .3 (todo).
  expect(inc.blocked_siblings).toEqual(["fn-200-solo.2"]);
  expect(b.degraded).toEqual([]);
  db.close();
});

test("an unblock brief parses a SHARED_BASE_BROKEN blocked reason to its category", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-201-solo",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "solo-sess-2" }],
  });
  seedJob(db, {
    job_id: "solo-sess-2",
    plan_verb: null,
    transcript_path: "/t/solo2.jsonl",
  });
  writeEpicFile(tmp, "fn-201-solo", { primary_repo: "/repo" });
  writeTaskState(tmp, "fn-201-solo.1", {
    status: "blocked",
    blocked_reason:
      "BLOCKED: SHARED_BASE_BROKEN\nSummary: base sha abc123 fails `bun test` independent of this diff",
  });

  const r = buildEscalationBrief(db, "unblock::fn-201-solo.1", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const inc = r.brief.incident as { category: string | null };
  expect(inc.category).toBe("SHARED_BASE_BROKEN");
  expect(r.brief.degraded).toEqual([]);
  db.close();
});

// ── Degrade paths (exit 0 with flags) ──────────────────────────────────────

test("a missing creator edge degrades lineage but still emits", () => {
  const { db } = freshMemDb();
  seedEpic(db, { epic_id: "fn-300-noedge", project_dir: tmp, job_links: [] });
  writeEpicFile(tmp, "fn-300-noedge", { primary_repo: "/repo" });

  const r = buildEscalationBrief(db, "deconflict::fn-300-noedge", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief.lineage.creator).toBeNull();
  expect(r.brief.lineage.chain).toEqual([
    { epic_id: "fn-300-noedge", creator: null },
  ]);
  expect(r.brief.degraded).toContain("lineage_creator_missing:fn-300-noedge");
  expect(r.brief.degraded).toContain("incident_merge_conflict_row_missing");
  expect(r.brief.degraded).toContain("incident_resolver_job_missing");
  db.close();
});

test("a missing transcript_path degrades with an explicit flag", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-400-notx",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "notx-sess" }],
  });
  seedJob(db, { job_id: "notx-sess", transcript_path: null });
  writeEpicFile(tmp, "fn-400-notx", { primary_repo: "/repo" });

  const r = buildEscalationBrief(db, "deconflict::fn-400-notx", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief.lineage.creator?.session_id).toBe("notx-sess");
  expect(r.brief.lineage.creator?.transcript_path).toBeNull();
  expect(r.brief.degraded).toContain("lineage_transcript_missing:notx-sess");
  db.close();
});

test("a creator edge with no jobs row (dead session) degrades but keeps the pointer", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-500-dead",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "ghost-sess" }],
  });
  // No jobs row for ghost-sess.
  writeEpicFile(tmp, "fn-500-dead", { primary_repo: "/repo" });

  const r = buildEscalationBrief(db, "deconflict::fn-500-dead", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief.lineage.creator?.session_id).toBe("ghost-sess");
  expect(r.brief.lineage.creator?.job_row_present).toBe(false);
  expect(r.brief.degraded).toContain(
    "lineage_creator_job_row_missing:ghost-sess",
  );
  db.close();
});

test("an epic found only in the .keeper tree (no db row) still emits, using cwd", () => {
  const { db } = freshMemDb();
  // No epics row at all; the .keeper file under `tmp` (== cwd) is the only trace.
  writeEpicFile(tmp, "fn-600-fileonly", { primary_repo: "/repo" });

  const r = buildEscalationBrief(db, "deconflict::fn-600-fileonly", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief.primary_repo).toBe("/repo");
  expect(r.brief.degraded).toContain("lineage_creator_missing:fn-600-fileonly");
  db.close();
});

// ── main() single-JSON-root output conformance ─────────────────────────────

interface RunResult {
  out: string;
  code: number;
}

function runMain(dbPath: string, argv: string[]): RunResult {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  const origDb = process.env.KEEPER_DB;
  process.env.KEEPER_DB = dbPath;
  let code = 0;
  class ExitSignal extends Error {}
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((c?: number): never => {
    code = c ?? 0;
    throw new ExitSignal();
  }) as typeof process.exit;
  try {
    main(argv);
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      throw e;
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
    if (origDb === undefined) {
      delete process.env.KEEPER_DB;
    } else {
      process.env.KEEPER_DB = origDb;
    }
  }
  return { out: chunks.join(""), code };
}

test("main() emits exactly one JSON root on stdout at exit 0", () => {
  const dbPath = join(tmp, "keeper.db");
  const { db } = freshDbFile(dbPath);
  seedEpic(db, {
    epic_id: "fn-700-emit",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "emit-sess" }],
  });
  seedJob(db, {
    job_id: "emit-sess",
    plan_verb: null,
    transcript_path: "/t/emit.jsonl",
  });
  db.close();
  writeEpicFile(tmp, "fn-700-emit", { primary_repo: "/repo" });

  const { out, code } = runMain(dbPath, ["deconflict::fn-700-emit"]);
  expect(code).toBe(0);
  // Exactly one JSON root: a second document makes JSON.parse throw "Extra data".
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.schema_version).toBe(1);
  expect(parsed.kind).toBe("deconflict");
  expect(parsed.epic_id).toBe("fn-700-emit");
  expect(parsed.primary_repo).toBe("/repo");
  expect(parsed).toHaveProperty("incident");
  expect(parsed).toHaveProperty("lineage");
  expect(parsed).toHaveProperty("degraded");
  expect(parsed.lineage.creator.session_id).toBe("emit-sess");
});

test("main() emits a single ok:false root at exit 1 for an unparseable key", () => {
  const dbPath = join(tmp, "keeper.db");
  freshDbFile(dbPath).db.close();

  const { out, code } = runMain(dbPath, ["nonsense-key"]);
  expect(code).toBe(1);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("unparseable_key");
});
