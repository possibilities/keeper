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
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEscalationBrief,
  findGrantRef,
  MAX_GRANT_LEAF_BYTES,
  main,
  parseEscalationKey,
} from "../cli/escalation-brief";
import { probeWorkMergeIncidentResolutions } from "../src/autopilot-worker";
import type { GitRunner } from "../src/commit-work/git-exec";
import {
  buildConflictHeadFence,
  buildPendingIntegrationTail,
  parseConflictHeadFence,
  parseMergeConflictReason,
} from "../src/dispatch-failure-key";
import { repoToken as deriveRepoToken } from "../src/worktree-plan";
import { freshDbFile, freshMemDb } from "./helpers/template-db";

// ── Seed helpers ───────────────────────────────────────────────────────────

interface JobLink {
  kind: string;
  job_id: string;
}

interface SeedTask {
  task_id: string;
  target_repo?: string | null;
  runtime_status?: string;
}

function seedEpic(
  db: Database,
  opts: {
    epic_id: string;
    project_dir?: string | null;
    job_links?: JobLink[];
    tasks?: SeedTask[];
  },
): void {
  db.query(
    "INSERT INTO epics (epic_id, updated_at, project_dir, job_links, tasks) VALUES (?, ?, ?, ?, ?)",
  ).run(
    opts.epic_id,
    1,
    opts.project_dir ?? null,
    JSON.stringify(opts.job_links ?? []),
    JSON.stringify(opts.tasks ?? []),
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
    /** The sticky row's `id` — an epic id for the (default) close verb, a
     *  task id for the work verb. */
    id: string;
    verb?: "close" | "work";
    reason: string;
    dir?: string | null;
    /** The collapsed owner-attachment count (0/1/2) — the retired two once-marker
     *  slots. */
    owner_redispatch_attempts?: number;
    instance_event_id?: number | null;
    attempt_id?: number | null;
    claim?: {
      session_id: string;
      pid: number | null;
      start_time: string | null;
      claimed_at: number | null;
    } | null;
  },
): void {
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        owner_redispatch_attempts, instance_event_id,
        attempt_id, claim_session_id, claim_pid, claim_start_time, claimed_at)
     VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.verb ?? "close",
    opts.id,
    opts.reason,
    opts.dir ?? null,
    opts.owner_redispatch_attempts ?? 0,
    opts.instance_event_id ?? null,
    opts.attempt_id ?? null,
    opts.claim?.session_id ?? null,
    opts.claim?.pid ?? null,
    opts.claim?.start_time ?? null,
    opts.claim?.claimed_at ?? null,
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

test("parseEscalationKey accepts all three key shapes", () => {
  expect(parseEscalationKey("deconflict::fn-12-add-oauth")).toEqual({
    kind: "deconflict",
    epic_id: "fn-12-add-oauth",
  });
  expect(parseEscalationKey("unblock::fn-12-add-oauth.3")).toEqual({
    kind: "unblock",
    epic_id: "fn-12-add-oauth",
    task_id: "fn-12-add-oauth.3",
  });
  expect(parseEscalationKey("repair::keeper-qzvs8i")).toEqual({
    kind: "repair",
    repo_token: "keeper-qzvs8i",
  });
});

test("parseEscalationKey accepts task deconflicts and direct work/close incident ids", () => {
  expect(parseEscalationKey("deconflict::fn-12-add-oauth.3")).toEqual({
    kind: "deconflict",
    epic_id: "fn-12-add-oauth",
    task_id: "fn-12-add-oauth.3",
  });
  expect(parseEscalationKey("work::fn-12-add-oauth.3")).toEqual({
    kind: "deconflict",
    epic_id: "fn-12-add-oauth",
    task_id: "fn-12-add-oauth.3",
  });
  expect(parseEscalationKey("close::fn-12-add-oauth")).toEqual({
    kind: "deconflict",
    epic_id: "fn-12-add-oauth",
  });
});

test("parseEscalationKey rejects shape mismatches and garbage", () => {
  // unblock wants a task ref; an epic ref is a mismatch.
  expect(parseEscalationKey("unblock::fn-12-add-oauth")).toBeNull();
  expect(parseEscalationKey("resolve::fn-12-add-oauth")).toBeNull();
  expect(parseEscalationKey("work::fn-12-add-oauth")).toBeNull();
  expect(parseEscalationKey("close::fn-12-add-oauth.3")).toBeNull();
  expect(parseEscalationKey("garbage")).toBeNull();
  expect(parseEscalationKey("deconflict::")).toBeNull();
});

test("parseEscalationKey rejects a malformed or path-shaped repair token", () => {
  // repair:: does NOT route through parsePlanRef — an fn-shaped ref is not
  // rejected on THAT basis, but a genuinely malformed / path-shaped token
  // still fails the REPO_TOKEN_RE structural check.
  expect(parseEscalationKey("repair::nohyphenatall")).toBeNull();
  expect(parseEscalationKey("repair::../etc/passwd")).toBeNull();
  expect(parseEscalationKey("repair::")).toBeNull();
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
    id: "fn-100-child",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-100-child into main — CONFLICT (content): foo.ts",
    dir: "/repo",
    owner_redispatch_attempts: 1,
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
      owner_redispatch_attempts: number;
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
  expect(inc.conflict?.owner_redispatch_attempts).toBe(1);
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

// ── Repair (repo-scoped) ────────────────────────────────────────────────────

function seedRepairFailure(
  db: Database,
  opts: { repo_token: string; reason: string },
): void {
  db.query(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
     VALUES ('repair', ?, ?, NULL, 1, 1, 1, 1)`,
  ).run(opts.repo_token, opts.reason);
}

test("a repair token unresolvable against any epic returns unknown_incident", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-800-elsewhere",
    project_dir: join(tmp, "somewhere-else"),
  });
  const r = buildEscalationBrief(db, "repair::keeper-qzvs8i", tmp);
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.code).toBe("unknown_incident");
  }
  db.close();
});

test("a repair brief resolves the repo, fingerprint, base evidence, and affected tasks across every epic on that repo", () => {
  const { db } = freshMemDb();
  const repoDir = join(tmp, "repaired-repo");
  const otherDir = join(tmp, "unrelated");
  const token = deriveRepoToken(repoDir);
  // Two DIFFERENT epics share the repo — one via project_dir, one via a
  // task's own target_repo — so "every epic on that repo" is exercised.
  seedEpic(db, {
    epic_id: "fn-801-alpha",
    project_dir: repoDir,
    tasks: [
      { task_id: "fn-801-alpha.1", runtime_status: "blocked" },
      { task_id: "fn-801-alpha.2", runtime_status: "todo" },
    ],
  });
  seedEpic(db, {
    epic_id: "fn-802-beta",
    project_dir: otherDir,
    tasks: [
      {
        task_id: "fn-802-beta.1",
        target_repo: repoDir,
        runtime_status: "blocked",
      },
    ],
  });
  writeTaskState(repoDir, "fn-801-alpha.1", {
    status: "blocked",
    blocked_reason:
      "BLOCKED: SHARED_BASE_BROKEN\nSummary: base sha deadbeef fails `bun test` independent of this diff",
  });
  writeTaskState(repoDir, "fn-801-alpha.2", { status: "todo" });
  // fn-802-beta's OWN .keeper tree lives under its own project_dir, not repoDir.
  writeTaskState(otherDir, "fn-802-beta.1", {
    status: "blocked",
    blocked_reason:
      "BLOCKED: SHARED_BASE_BROKEN\nSummary: base sha deadbeef fails `bun test` independent of this diff",
  });
  seedRepairFailure(db, {
    repo_token: token,
    reason:
      'shared-base-broken:fp-deadbeef baseline_leaf="repo-deadbeef-tc" ' +
      'failing_tests="alpha; beta (+3 more)"',
  });

  const r = buildEscalationBrief(db, `repair::${token}`, tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const b = r.brief;
  expect(b.kind).toBe("repair");
  expect(b.epic_id).toBeNull();
  expect(b.task_id).toBeNull();
  expect(b.primary_repo).toBe(repoDir);
  expect(b.lineage).toEqual({
    creator: null,
    original_creator: null,
    chain: [],
  });

  const inc = b.incident as {
    repo_token: string;
    repo: string | null;
    fingerprint: string | null;
    baseline_leaf_key: string | null;
    failing_tests_digest: string | null;
    base_evidence: {
      base_sha: string | null;
      failing_command: string | null;
    } | null;
    affected_tasks: Array<{
      epic_id: string;
      task_id: string;
      blocked_reason: string | null;
    }>;
  };
  expect(inc.repo_token).toBe(token);
  expect(inc.repo).toBe(repoDir);
  expect(inc.fingerprint).toBe("fp-deadbeef");
  expect(inc.baseline_leaf_key).toBe("repo-deadbeef-tc");
  expect(inc.failing_tests_digest).toBe("alpha; beta (+3 more)");
  expect(inc.base_evidence).toEqual({
    base_sha: "deadbeef",
    failing_command: "bun test",
  });
  expect(inc.affected_tasks).toEqual([
    {
      epic_id: "fn-801-alpha",
      task_id: "fn-801-alpha.1",
      blocked_reason:
        "BLOCKED: SHARED_BASE_BROKEN\nSummary: base sha deadbeef fails `bun test` independent of this diff",
    },
    {
      epic_id: "fn-802-beta",
      task_id: "fn-802-beta.1",
      blocked_reason:
        "BLOCKED: SHARED_BASE_BROKEN\nSummary: base sha deadbeef fails `bun test` independent of this diff",
    },
  ]);
  expect(b.degraded).toEqual([]);
  db.close();
});

test("a repair brief with no dispatch_failures row and no matching blocked task degrades but still emits", () => {
  const { db } = freshMemDb();
  const repoDir = join(tmp, "quiet-repo");
  const token = deriveRepoToken(repoDir);
  seedEpic(db, { epic_id: "fn-810-quiet", project_dir: repoDir, tasks: [] });

  const r = buildEscalationBrief(db, `repair::${token}`, tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const b = r.brief;
  expect(b.kind).toBe("repair");
  expect(b.primary_repo).toBe(repoDir);
  const inc = b.incident as {
    fingerprint: string | null;
    baseline_leaf_key: string | null;
    failing_tests_digest: string | null;
    base_evidence: unknown;
    affected_tasks: unknown[];
  };
  expect(inc.fingerprint).toBeNull();
  expect(inc.baseline_leaf_key).toBeNull();
  expect(inc.failing_tests_digest).toBeNull();
  expect(inc.base_evidence).toBeNull();
  expect(inc.affected_tasks).toEqual([]);
  expect(b.degraded).toEqual([
    "incident_repair_row_missing",
    "incident_no_affected_tasks",
  ]);
  db.close();
});

test("a repair dispatch_failures row under an unrecognized reason shape degrades incident_reason_unparsed", () => {
  const { db } = freshMemDb();
  const repoDir = join(tmp, "odd-reason-repo");
  const token = deriveRepoToken(repoDir);
  seedEpic(db, { epic_id: "fn-811-odd", project_dir: repoDir, tasks: [] });
  seedRepairFailure(db, {
    repo_token: token,
    reason: "not-the-expected-shape",
  });

  const r = buildEscalationBrief(db, `repair::${token}`, tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const inc = r.brief.incident as { fingerprint: string | null };
  expect(inc.fingerprint).toBeNull();
  expect(r.brief.degraded).toContain("incident_reason_unparsed");
  db.close();
});

// ── Byte-equality regression: unblock/deconflict unaffected by repair ──────

test("byte-equality regression: an unblock brief's full shape is unchanged", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-820-byte",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "byte-sess" }],
  });
  seedJob(db, {
    job_id: "byte-sess",
    plan_verb: null,
    transcript_path: "/t/byte.jsonl",
  });
  writeEpicFile(tmp, "fn-820-byte", { primary_repo: "/repo" });
  writeTaskState(tmp, "fn-820-byte.1", {
    status: "blocked",
    blocked_reason: "BLOCKED: SPEC_UNCLEAR\nSummary: unclear",
  });

  const r = buildEscalationBrief(db, "unblock::fn-820-byte.1", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief).toEqual({
    kind: "unblock",
    epic_id: "fn-820-byte",
    task_id: "fn-820-byte.1",
    primary_repo: "/repo",
    incident: {
      task_id: "fn-820-byte.1",
      status: "blocked",
      blocked_reason: "BLOCKED: SPEC_UNCLEAR\nSummary: unclear",
      category: "SPEC_UNCLEAR",
      blocked_siblings: [],
    },
    lineage: {
      creator: {
        session_id: "byte-sess",
        transcript_path: "/t/byte.jsonl",
        is_closer: false,
        plan_verb: null,
        plan_ref: null,
        state: "stopped",
        job_row_present: true,
      },
      original_creator: {
        session_id: "byte-sess",
        transcript_path: "/t/byte.jsonl",
        is_closer: false,
        plan_verb: null,
        plan_ref: null,
        state: "stopped",
        job_row_present: true,
      },
      chain: [
        {
          epic_id: "fn-820-byte",
          creator: {
            session_id: "byte-sess",
            transcript_path: "/t/byte.jsonl",
            is_closer: false,
            plan_verb: null,
            plan_ref: null,
            state: "stopped",
            job_row_present: true,
          },
        },
      ],
    },
    degraded: [],
  });
  db.close();
});

test("byte-equality regression: a deconflict brief's full shape is unchanged", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-821-byte",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "byte-sess-2" }],
  });
  seedJob(db, {
    job_id: "byte-sess-2",
    plan_verb: null,
    transcript_path: "/t/byte2.jsonl",
  });
  writeEpicFile(tmp, "fn-821-byte", { primary_repo: "/repo" });
  seedMergeConflict(db, {
    id: "fn-821-byte",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-821-byte into main — CONFLICT (content): foo.ts",
    dir: "/repo",
  });

  const r = buildEscalationBrief(db, "deconflict::fn-821-byte", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  expect(r.brief).toEqual({
    kind: "deconflict",
    epic_id: "fn-821-byte",
    task_id: null,
    primary_repo: "/repo",
    incident: {
      conflict: {
        reason:
          "worktree-merge-conflict: merging keeper/epic/fn-821-byte into main — CONFLICT (content): foo.ts",
        source_branch: "keeper/epic/fn-821-byte",
        base_branch: "main",
        stderr: "CONFLICT (content): foo.ts",
        repo_dir: "/repo",
        expected_source_head: null,
        expected_base_head: null,
        source_class: null,
        fence_state: "unpinned",
        fence_kind: "legacy",
        owner_redispatch_attempts: 0,
        instance_event_id: null,
        attempt_id: null,
        claim: null,
      },
      resolver_jobs: [],
      grant_ref: null,
      grant_role: null,
    },
    lineage: {
      creator: {
        session_id: "byte-sess-2",
        transcript_path: "/t/byte2.jsonl",
        is_closer: false,
        plan_verb: null,
        plan_ref: null,
        state: "stopped",
        job_row_present: true,
      },
      original_creator: {
        session_id: "byte-sess-2",
        transcript_path: "/t/byte2.jsonl",
        is_closer: false,
        plan_verb: null,
        plan_ref: null,
        state: "stopped",
        job_row_present: true,
      },
      chain: [
        {
          epic_id: "fn-821-byte",
          creator: {
            session_id: "byte-sess-2",
            transcript_path: "/t/byte2.jsonl",
            is_closer: false,
            plan_verb: null,
            plan_ref: null,
            state: "stopped",
            job_row_present: true,
          },
        },
      ],
    },
    degraded: ["incident_resolver_job_missing"],
  });
  db.close();
});

test("a pinned pending-integration incident surfaces the durable head fence to the deconflict brief", () => {
  const { db } = freshMemDb();
  const sourceHead = "1".repeat(40);
  const baseHead = "2".repeat(40);
  writeEpicFile(tmp, "fn-830-pin", { primary_repo: "/repo" });
  seedMergeConflict(db, {
    id: "fn-830-pin",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-830-pin--fn-830-pin.2 into keeper/epic/fn-830-pin — " +
      buildPendingIntegrationTail(sourceHead, baseHead),
    dir: "/repo",
  });

  const r = buildEscalationBrief(db, "deconflict::fn-830-pin", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const inc = r.brief.incident as {
    conflict: {
      source_branch: string | null;
      base_branch: string | null;
      expected_source_head: string | null;
      expected_base_head: string | null;
    } | null;
  };
  expect(inc.conflict?.source_branch).toBe(
    "keeper/epic/fn-830-pin--fn-830-pin.2",
  );
  expect(inc.conflict?.base_branch).toBe("keeper/epic/fn-830-pin");
  expect(inc.conflict?.expected_source_head).toBe(sourceHead);
  expect(inc.conflict?.expected_base_head).toBe(baseHead);
  db.close();
});

test("P0-4 durable conflict: an actor conflict mint round-trips through the REAL parser → brief → pinned-clear seams [lock #8]", async () => {
  // The actor's CANONICAL conflict grammar carries the pinned source object, the target-
  // arrival object, and the obligation class in a `[conflict …]` head fence. Prove the WHOLE
  // pipeline end-to-end through the real seams (no in-memory field passing):
  const sourceBranch = "keeper/epic/fn-840-durable--fn-840-durable.3";
  const targetBranch = "keeper/epic/fn-840-durable--fn-840-durable.4";
  const sourceHead = "1".repeat(40);
  const targetHead = "2".repeat(40);
  const reason =
    `worktree-merge-conflict: merging ${sourceBranch} into ${targetBranch}` +
    ` — CONFLICT (content): foo.ts ${buildConflictHeadFence(sourceHead, targetHead, "rib")}`;

  // (1) MINT → PARSE: the canonical grammar is parseMergeConflictReason-parseable AND the
  //     head fence extracts the exact pins + class.
  const parsed = parseMergeConflictReason(reason);
  expect(parsed).toEqual({
    source: sourceBranch,
    base: targetBranch,
    stderr: `CONFLICT (content): foo.ts ${buildConflictHeadFence(sourceHead, targetHead, "rib")}`,
  });
  expect(parseConflictHeadFence(reason)).toEqual({
    sourceHead,
    targetHead,
    sourceClass: "rib",
  });

  // (2) BRIEF: the deconflict brief surfaces the durable heads + class (never null).
  const { db } = freshMemDb();
  writeEpicFile(tmp, "fn-840-durable", { primary_repo: "/repo" });
  seedMergeConflict(db, { id: "fn-840-durable", reason, dir: "/repo" });
  const r = buildEscalationBrief(db, "deconflict::fn-840-durable", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const inc = r.brief.incident as {
    conflict: {
      expected_source_head: string | null;
      expected_base_head: string | null;
      source_class: string | null;
      fence_state: string | null;
      fence_kind: string | null;
    } | null;
  };
  expect(inc.conflict?.expected_source_head).toBe(sourceHead);
  expect(inc.conflict?.expected_base_head).toBe(targetHead);
  expect(inc.conflict?.source_class).toBe("rib");
  // BOTH surfaces: fence_state stays the LEGACY schema-v1 value (`unpinned` for any genuine
  // content conflict — wire compatibility, never changed), while the NEW fence_kind carries
  // the AUTHORITATIVE-PINNED `actor-conflict` discriminator consumers route on. The resolver
  // merges the pinned source OBJECT gated on the target-arrival pin (`expected_base_head`).
  expect(inc.conflict?.fence_state).toBe("unpinned");
  expect(inc.conflict?.fence_kind).toBe("actor-conflict");
  db.close();

  // (3) PINNED-CLEAR: the resolution probe routes the conflict fence to the PINNED grader —
  //     both durable pins ancestors of the (stable, clean) current base → `merged`.
  const baseOid = "b".repeat(40);
  const durableRun: GitRunner = (async (args: string[]) => {
    const cmd = args.join(" ");
    if (args[0] === "rev-parse" && cmd.includes("^{commit}")) {
      return { code: 0, stdout: `${baseOid}\n`, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // both pins are ancestors of the base
    }
    if (args.includes("--git-dir")) return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "for-each-ref") return { code: 0, stdout: "", stderr: "" };
    if (
      cmd === "rev-parse --verify --quiet MERGE_HEAD" ||
      cmd === "rev-parse --verify --quiet MERGE_AUTOSTASH" ||
      cmd === "rev-parse --verify --quiet CHERRY_PICK_HEAD" ||
      cmd === "rev-parse --verify --quiet REVERT_HEAD"
    ) {
      return { code: 1, stdout: "", stderr: "" }; // no in-progress residue
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" }; // clean
    if (cmd === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: `${targetBranch}\n`, stderr: "" }; // on the base
    }
    return { code: 0, stdout: "", stderr: "" };
  }) as unknown as GitRunner;
  const verdicts = await probeWorkMergeIncidentResolutions(
    [{ id: "fn-840-durable.4", reason, dir: "/lane" }],
    durableRun,
  );
  expect(verdicts.get("fn-840-durable.4")).toBe("merged");
});

test("a legacy or malformed fence is surfaced as malformed-pending (fail closed, degraded, no live-head substitution)", () => {
  const read = (id: string, reason: string) => {
    const { db } = freshMemDb();
    writeEpicFile(tmp, id, { primary_repo: "/repo" });
    seedMergeConflict(db, { id, reason, dir: "/repo" });
    const r = buildEscalationBrief(db, `deconflict::${id}`, tmp);
    expect(r.kind).toBe("ok");
    const out =
      r.kind === "ok"
        ? {
            conflict: (
              r.brief.incident as {
                conflict: {
                  expected_source_head: string | null;
                  expected_base_head: string | null;
                  fence_state: string;
                  fence_kind: string;
                } | null;
              }
            ).conflict,
            degraded: r.brief.degraded,
          }
        : { conflict: null, degraded: [] as string[] };
    db.close();
    return out;
  };
  for (const [id, reason] of [
    [
      "fn-831-legacy",
      "worktree-merge-conflict: merging keeper/epic/fn-831-legacy--fn-831-legacy.2 into keeper/epic/fn-831-legacy — pending owner integration",
    ],
    [
      "fn-832-malformed",
      `worktree-merge-conflict: merging keeper/epic/fn-832-malformed--fn-832-malformed.2 into keeper/epic/fn-832-malformed — pending owner integration [expected src=${"a".repeat(
        12,
      )} base=${"b".repeat(40)}]`,
    ],
  ] as const) {
    const { conflict, degraded } = read(id, reason);
    expect(conflict?.expected_source_head).toBeNull();
    expect(conflict?.expected_base_head).toBeNull();
    // A malformed PENDING request keeps the legacy `malformed` fence_state AND the new
    // `malformed-pending` fence_kind — both fail-closed, no live-head substitution.
    expect(conflict?.fence_state).toBe("malformed");
    expect(conflict?.fence_kind).toBe("malformed-pending");
    expect(degraded).toContain("incident_pending_fence_malformed");
  }
});

test("a malformed ACTOR `[conflict …]` fence surfaces malformed (fail closed) under a DISTINCT degraded flag, no live-head substitution", () => {
  const { db } = freshMemDb();
  const id = "fn-833-actor-malformed";
  writeEpicFile(tmp, id, { primary_repo: "/repo" });
  // A GENUINE actor content-conflict reason carrying a `[conflict …]` control token whose
  // source id is too short to parse a valid fence — malformed-ACTOR, distinct from a legacy
  // fence-less conflict. It must FAIL CLOSED as `malformed` (never `unpinned`/`actor-conflict`)
  // and never substitute live branch heads as the missing authority.
  seedMergeConflict(db, {
    id,
    reason: `worktree-merge-conflict: merging keeper/epic/${id}--${id}.2 into keeper/epic/${id} — CONFLICT (content): x.ts [conflict src=${"a".repeat(12)} target=${"b".repeat(40)} class=rib]`,
    dir: "/repo",
  });
  const r = buildEscalationBrief(db, `deconflict::${id}`, tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const conflict = (
    r.brief.incident as {
      conflict: {
        expected_source_head: string | null;
        expected_base_head: string | null;
        source_class: string | null;
        fence_state: string;
        fence_kind: string;
      } | null;
    }
  ).conflict;
  // A malformed-actor is NOT a pending reason, so its legacy fence_state is `unpinned`
  // (schema-v1, unchanged), while the NEW fence_kind is `malformed-actor` — the field
  // consumers route on, which FAILS CLOSED. No live-head substitution (heads null).
  expect(conflict?.fence_state).toBe("unpinned");
  expect(conflict?.fence_kind).toBe("malformed-actor");
  expect(conflict?.expected_source_head).toBeNull();
  expect(conflict?.expected_base_head).toBeNull();
  expect(conflict?.source_class).toBeNull();
  // Surfaced DISTINCTLY from a malformed-pending row so an operator can tell them apart.
  expect(r.brief.degraded).toContain("incident_actor_fence_malformed");
  expect(r.brief.degraded).not.toContain("incident_pending_fence_malformed");
  db.close();
});

test("direct work and close incident ids resolve fenced claim and grant facts read-only", () => {
  const { db } = freshMemDb();
  const epicId = "fn-950-incident-brief";
  const taskId = `${epicId}.1`;
  seedEpic(db, { epic_id: epicId, project_dir: tmp });
  writeEpicFile(tmp, epicId, { primary_repo: "/repo" });
  seedMergeConflict(db, {
    verb: "work",
    id: taskId,
    reason:
      `worktree-merge-conflict: merging keeper/epic/${epicId}--${taskId} ` +
      `into keeper/epic/${epicId} — CONFLICT (content): work.ts`,
    dir: "/repo/lane",
    instance_event_id: 91,
    attempt_id: 14,
    claim: {
      session_id: "session-owner",
      pid: 9191,
      start_time: "proc:9191:1",
      claimed_at: 1_700_000_001,
    },
  });
  seedMergeConflict(db, {
    verb: "close",
    id: epicId,
    reason:
      `worktree-merge-conflict: merging keeper/epic/${epicId} into main — ` +
      `CONFLICT (content): close.ts`,
    dir: "/repo",
    instance_event_id: 92,
    attempt_id: 15,
  });
  const grantsDir = join(tmp, "grants");
  mkdirSync(grantsDir, { recursive: true, mode: 0o700 });
  const grant = (instanceEventId: number) => ({
    schema_version: 1,
    parent_job_id: "session-owner",
    agent_type: "plan:deconflicter",
    incident_id: `work::${taskId}`,
    attempt_id: "attempt-14",
    instance_event_id: instanceEventId,
    writable_root: "/repo",
    role: "deconflict",
    expires_at: 6_000,
    fencing_token: 3,
  });
  writeFileSync(
    join(grantsDir, "grant-stale.json"),
    JSON.stringify(grant(90)),
    { mode: 0o600 },
  );
  const grantPath = join(grantsDir, "grant-work.json");
  writeFileSync(grantPath, JSON.stringify(grant(91)), { mode: 0o600 });

  const work = buildEscalationBrief(
    db,
    `work::${taskId}`,
    tmp,
    grantsDir,
    5_000,
    "session-owner",
  );
  expect(work.kind).toBe("ok");
  if (work.kind === "ok") {
    expect(work.brief.kind).toBe("deconflict");
    expect(work.brief.epic_id).toBe(epicId);
    expect(work.brief.task_id).toBe(taskId);
    expect(work.brief.incident).toMatchObject({
      conflict: {
        instance_event_id: 91,
        attempt_id: 14,
        claim: {
          session_id: "session-owner",
          pid: 9191,
          start_time: "proc:9191:1",
          claimed_at: 1_700_000_001,
        },
      },
      grant_ref: grantPath,
      grant_role: "deconflict",
    });
  }

  const close = buildEscalationBrief(
    db,
    `close::${epicId}`,
    tmp,
    grantsDir,
    5_000,
    "session-owner",
  );
  expect(close.kind).toBe("ok");
  if (close.kind === "ok") {
    expect(close.brief.kind).toBe("deconflict");
    expect(close.brief.epic_id).toBe(epicId);
    expect(close.brief.task_id).toBeNull();
    expect(close.brief.incident).toMatchObject({
      conflict: {
        instance_event_id: 92,
        attempt_id: 15,
        claim: null,
      },
      grant_ref: null,
    });
  }
  db.close();
});

test("grant discovery rejects expired, oversized, symlinked, and ambiguous leaves", () => {
  const incidentId = "close::fn-951-grant-bounds";
  const instanceEventId = 101;
  const grant = {
    schema_version: 1,
    parent_job_id: "session-owner",
    agent_type: "plan:deconflicter",
    incident_id: incidentId,
    attempt_id: "attempt-20",
    instance_event_id: instanceEventId,
    writable_root: "/repo",
    role: "deconflict",
    expires_at: 6_000,
    fencing_token: 4,
  };

  const expiredDir = join(tmp, "expired-grants");
  mkdirSync(expiredDir, { mode: 0o700 });
  writeFileSync(
    join(expiredDir, "grant-expired.json"),
    JSON.stringify({ ...grant, expires_at: 5_000 }),
    { mode: 0o600 },
  );
  expect(
    findGrantRef(expiredDir, incidentId, instanceEventId, 5_000),
  ).toBeNull();

  const oversizedDir = join(tmp, "oversized-grants");
  mkdirSync(oversizedDir, { mode: 0o700 });
  writeFileSync(
    join(oversizedDir, "grant-oversized.json"),
    JSON.stringify({ ...grant, padding: "x".repeat(MAX_GRANT_LEAF_BYTES) }),
    { mode: 0o600 },
  );
  expect(
    findGrantRef(oversizedDir, incidentId, instanceEventId, 5_000),
  ).toBeNull();

  const symlinkDir = join(tmp, "symlink-grants");
  mkdirSync(symlinkDir, { mode: 0o700 });
  const target = join(tmp, "grant-target.json");
  writeFileSync(target, JSON.stringify(grant), { mode: 0o600 });
  symlinkSync(target, join(symlinkDir, "grant-linked.json"));
  expect(
    findGrantRef(symlinkDir, incidentId, instanceEventId, 5_000),
  ).toBeNull();

  const ambiguousDir = join(tmp, "ambiguous-grants");
  mkdirSync(ambiguousDir, { mode: 0o700 });
  const ownerPath = join(ambiguousDir, "grant-owner.json");
  writeFileSync(ownerPath, JSON.stringify(grant), { mode: 0o600 });
  writeFileSync(
    join(ambiguousDir, "grant-other.json"),
    JSON.stringify({ ...grant, parent_job_id: "session-other" }),
    { mode: 0o600 },
  );
  expect(
    findGrantRef(ambiguousDir, incidentId, instanceEventId, 5_000),
  ).toBeNull();
  expect(
    findGrantRef(
      ambiguousDir,
      incidentId,
      instanceEventId,
      5_000,
      "session-owner",
    ),
  ).toBe(ownerPath);
});

// ── Deconflict: work-verb task-form ref (fn-1246 F1) ───────────────────────

test("a task-form deconflict ref resolves the work-verb sticky row, keying the sticky lookup and resolver jobs on the task id while deriving epic_id for lineage", () => {
  const { db } = freshMemDb();
  seedEpic(db, {
    epic_id: "fn-900-work",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "work-sess" }],
  });
  seedJob(db, {
    job_id: "work-sess",
    plan_verb: null,
    transcript_path: "/t/work.jsonl",
  });
  writeEpicFile(tmp, "fn-900-work", { primary_repo: "/repo" });
  seedMergeConflict(db, {
    verb: "work",
    id: "fn-900-work.2",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-900-work--fn-900-work.2 into keeper/epic/fn-900-work — CONFLICT (content): bar.ts",
    dir: "/repo/lanes/fn-900-work.2",
    owner_redispatch_attempts: 1,
  });
  seedJob(db, {
    job_id: "resolve-work-sess",
    plan_verb: "resolve",
    plan_ref: "fn-900-work.2",
    transcript_path: "/t/resolve-work.jsonl",
    state: "ended",
  });
  // An epic-scoped resolver job that must NOT leak into this task's resolver_jobs —
  // the sticky lookup + resolver-job query are both keyed on the task id, never
  // the epic id, for a work-verb ref.
  seedJob(db, {
    job_id: "resolve-epic-sess",
    plan_verb: "resolve",
    plan_ref: "fn-900-work",
    transcript_path: "/t/resolve-epic.jsonl",
    state: "ended",
  });

  const r = buildEscalationBrief(db, "deconflict::fn-900-work.2", tmp);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") {
    db.close();
    return;
  }
  const b = r.brief;
  expect(b.kind).toBe("deconflict");
  expect(b.epic_id).toBe("fn-900-work");
  expect(b.task_id).toBe("fn-900-work.2");
  expect(b.primary_repo).toBe("/repo");
  const inc = b.incident as {
    conflict: {
      source_branch: string | null;
      base_branch: string | null;
      repo_dir: string | null;
    } | null;
    resolver_jobs: Array<{ session_id: string }>;
  };
  expect(inc.conflict?.source_branch).toBe(
    "keeper/epic/fn-900-work--fn-900-work.2",
  );
  expect(inc.conflict?.base_branch).toBe("keeper/epic/fn-900-work");
  expect(inc.conflict?.repo_dir).toBe("/repo/lanes/fn-900-work.2");
  expect(inc.resolver_jobs.map((j) => j.session_id)).toEqual([
    "resolve-work-sess",
  ]);
  expect(b.degraded).toEqual([]);
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

test("main() drives the daemon-dispatched deconflict::<taskId> handoff end-to-end and returns a parseable brief", () => {
  // The exact key `dispatchWorkDeconflict` launches (`verb: "deconflict", id:
  // row.id` where `row.id` is a task id) — this is F1/F4/F5's seam: before
  // this fix, `parseEscalationKey` rejected the task-form ref outright.
  const dbPath = join(tmp, "keeper.db");
  const { db } = freshDbFile(dbPath);
  seedEpic(db, {
    epic_id: "fn-901-work",
    project_dir: tmp,
    job_links: [{ kind: "creator", job_id: "e2e-sess" }],
  });
  seedJob(db, {
    job_id: "e2e-sess",
    plan_verb: null,
    transcript_path: "/t/e2e.jsonl",
  });
  seedMergeConflict(db, {
    verb: "work",
    id: "fn-901-work.1",
    reason:
      "worktree-merge-conflict: merging keeper/epic/fn-901-work--fn-901-work.1 into keeper/epic/fn-901-work — CONFLICT (content): baz.ts",
    dir: "/repo/lanes/fn-901-work.1",
    owner_redispatch_attempts: 1,
  });
  db.close();
  writeEpicFile(tmp, "fn-901-work", { primary_repo: "/repo" });

  const { out, code } = runMain(dbPath, ["deconflict::fn-901-work.1"]);
  expect(code).toBe(0);
  // Exactly one JSON root: a second document makes JSON.parse throw "Extra data".
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.schema_version).toBe(1);
  expect(parsed.kind).toBe("deconflict");
  expect(parsed.epic_id).toBe("fn-901-work");
  expect(parsed.task_id).toBe("fn-901-work.1");
  expect(parsed.primary_repo).toBe("/repo");
  expect(parsed.incident.conflict.repo_dir).toBe("/repo/lanes/fn-901-work.1");
  expect(parsed.incident.conflict.source_branch).toBe(
    "keeper/epic/fn-901-work--fn-901-work.1",
  );
  expect(parsed.lineage.creator.session_id).toBe("e2e-sess");
});
