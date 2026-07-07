/**
 * restore-sim — the fast-tier (default `bun test` run), pure in-process
 * acceptance instrument for the crash-restore hardening epic. Seeds a template
 * DB with a dead tmux-server generation whose candidates span the epic's
 * defect classes (a rehomed-transcript claude tab, a preflight-failing claude
 * tab, and non-claude tabs), fakes every non-pure seam (spawn/probe/fs/
 * evidence), and drives selection -> preflight -> apply -> verify end-to-end.
 *
 * One `test()` per epic acceptance concern this task names, so the mapping
 * stays auditable:
 *  - recency-first pick (the newest eligible generation wins over a richer,
 *    but not SUBSTANTIALLY richer, older cohort)
 *  - ambiguous escalation (a substantially richer older generation contests
 *    the newest pick, surfacing both in the picker menu)
 *  - disk-anchored rehomed-transcript restore + preflight-failure surfacing
 *    + verify-timeout disambiguation (alive -> launched-unverified warn,
 *    dead -> failed), all driven through the SAME plan -> apply pipeline
 *    `cli/tabs.ts` wires in production.
 *
 * No subprocess, no real tmux, no real fs — `test/restore-e2e.slow.test.ts` is
 * the real-tmux acceptance instrument for the harness this sim fakes.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RestoreCandidate } from "../src/restore-set";
import {
  type AttachVerdict,
  RESTORE_INTENT_SCHEMA_VERSION,
  RESTORE_VERIFY_POLL_MS,
  RESTORE_VERIFY_TIMEOUT_MS,
  type RestoreIntent,
  verifyAttach,
} from "../src/restore-verify";
import {
  makeResumeResolver,
  type ResumeResolveFs,
} from "../src/resume-resolve";
import type { IntentSink } from "../src/tabs-core";
import {
  applyRestoreVerified,
  loadRestorePlan,
  planRestore,
} from "../src/tabs-core";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let kdb: ReturnType<typeof freshDbFile>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-sim-"));
  dbPath = join(tmpDir, "keeper.db");
  kdb = freshDbFile(dbPath);
});

afterEach(() => {
  try {
    kdb.db.close();
  } catch {
    // best-effort
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers — same column/payload shape as test/restore-set.test.ts and
// test/tabs.test.ts, trimmed to what this file's scenarios need.
// ---------------------------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);

interface SeedJob {
  job_id: string;
  cwd?: string | null;
  harness?: string | null;
  resume_target?: string | null;
  created_at?: number;
}

function seedJob(db: Database, j: SeedJob): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, title, cwd,
       backend_exec_session_id, harness, resume_target
     ) VALUES (?, ?, ?, 'killed', NULL, ?, 'work', ?, ?)`,
    [
      j.job_id,
      j.created_at ?? NOW - 100,
      j.created_at ?? NOW - 100,
      j.cwd ?? null,
      j.harness ?? null,
      j.resume_target ?? null,
    ],
  );
}

interface SeedPane {
  pane_id: string;
  window_index: number;
  job_id: string;
}

/** Insert a `TmuxTopologySnapshot` event at an explicit rowid carrying
 *  `{generation_id, panes}` — mirrors the daemon producer's column mapping.
 *  The topology-anchored deriver reads job identity straight off each pane's
 *  payload `job_id`, so no separate pane/generation job-row linkage is needed. */
function seedGeneration(
  db: Database,
  id: number,
  generationId: string,
  panes: SeedPane[],
  ts: number,
): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [
      id,
      ts,
      JSON.stringify({
        generation_id: generationId,
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          session_name: "work",
          window_index: p.window_index,
          job_id: p.job_id,
        })),
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// In-memory ResumeResolveFs fake (mirrors test/resume-resolve.test.ts).
// ---------------------------------------------------------------------------

interface FakeFsSpec {
  files?: Record<string, string>;
  dirs?: string[];
}

function makeFakeFs(spec: FakeFsSpec): ResumeResolveFs {
  const files = spec.files ?? {};
  const filePaths = Object.keys(files);
  const dirSet = new Set<string>(spec.dirs ?? []);
  for (const p of [...filePaths, ...(spec.dirs ?? [])]) {
    let d = dirname(p);
    while (d !== "" && d !== "/" && d !== ".") {
      dirSet.add(d);
      d = dirname(d);
    }
  }
  return {
    listDir(dir) {
      const children = new Set<string>();
      for (const p of [...filePaths, ...dirSet]) {
        if (p !== dir && dirname(p) === dir) {
          children.add(basename(p));
        }
      }
      return [...children];
    },
    exists(path) {
      return files[path] !== undefined || dirSet.has(path);
    },
    realpath(path) {
      return path;
    },
    readTail(path, maxBytes) {
      const content = files[path];
      if (content === undefined) {
        return null;
      }
      const bytes = Buffer.from(content, "utf8");
      const start = bytes.length > maxBytes ? bytes.length - maxBytes : 0;
      return { text: bytes.toString("utf8", start), fromStart: start === 0 };
    },
  };
}

/** A claude transcript line carrying a top-level `cwd`, newline-terminated. */
function transcriptLine(cwd: string): string {
  return `${JSON.stringify({ type: "user", cwd })}\n`;
}

// ---------------------------------------------------------------------------
// Selection: recency-first pick + ambiguous escalation
// ---------------------------------------------------------------------------

test("recency-first pick: the newest eligible generation wins over a richer-but-not-substantially-richer older cohort", () => {
  // gen-old: 2 days old, 4 restorable panes.
  seedJob(kdb.db, { job_id: "old-1" });
  seedJob(kdb.db, { job_id: "old-2" });
  seedJob(kdb.db, { job_id: "old-3" });
  seedJob(kdb.db, { job_id: "old-4" });
  seedGeneration(
    kdb.db,
    11,
    "gen-old",
    [
      { pane_id: "%1", window_index: 0, job_id: "old-1" },
      { pane_id: "%2", window_index: 1, job_id: "old-2" },
      { pane_id: "%3", window_index: 2, job_id: "old-3" },
      { pane_id: "%4", window_index: 3, job_id: "old-4" },
    ],
    NOW - 2 * 24 * 60 * 60,
  );
  // gen-new: just killed (1 minute ago), 3 restorable panes — fewer than
  // gen-old (4 vs 3 is NOT substantially richer: 4 < 3 * 2), so recency wins.
  seedJob(kdb.db, { job_id: "new-1" });
  seedJob(kdb.db, { job_id: "new-2" });
  seedJob(kdb.db, { job_id: "new-3" });
  seedGeneration(
    kdb.db,
    21,
    "gen-new",
    [
      { pane_id: "%1", window_index: 0, job_id: "new-1" },
      { pane_id: "%2", window_index: 1, job_id: "new-2" },
      { pane_id: "%3", window_index: 2, job_id: "new-3" },
    ],
    NOW - 60,
  );

  const sel = loadRestorePlan(dbPath, { probeNow: () => null });
  expect(sel.pickedGeneration?.generation_id).toBe("gen-new");
  expect(sel.ambiguous).toBe(false);
  expect(sel.candidates.map((c) => c.job_id).sort()).toEqual([
    "new-1",
    "new-2",
    "new-3",
  ]);
});

test("ambiguous escalation: a substantially richer older generation contests the newest pick, surfacing both in the picker menu", () => {
  // gen-old: 2 days old, 8 restorable panes — substantially richer than
  // gen-new's 2 (8 >= 2 * AMBIGUOUS_RICHER_FACTOR(2) and gap 6 >= MIN_GAP(2)).
  const oldJobIds = Array.from({ length: 8 }, (_, i) => `rich-old-${i}`);
  for (const id of oldJobIds) {
    seedJob(kdb.db, { job_id: id });
  }
  seedGeneration(
    kdb.db,
    11,
    "gen-old",
    oldJobIds.map((id, i) => ({
      pane_id: `%${i}`,
      window_index: i,
      job_id: id,
    })),
    NOW - 2 * 24 * 60 * 60,
  );
  seedJob(kdb.db, { job_id: "new-1" });
  seedJob(kdb.db, { job_id: "new-2" });
  seedGeneration(
    kdb.db,
    21,
    "gen-new",
    [
      { pane_id: "%1", window_index: 0, job_id: "new-1" },
      { pane_id: "%2", window_index: 1, job_id: "new-2" },
    ],
    NOW - 60,
  );

  const sel = loadRestorePlan(dbPath, { probeNow: () => null });
  // Recency-first still auto-picks the just-killed generation...
  expect(sel.pickedGeneration?.generation_id).toBe("gen-new");
  // ...but the pick is CONTESTED: the consumer must escalate (TTY picker) or
  // refuse (non-TTY), never silently restore the newest over the richer one.
  expect(sel.ambiguous).toBe(true);
  expect(sel.eligible.map((e) => e.generation_id).sort()).toEqual([
    "gen-new",
    "gen-old",
  ]);
});

// ---------------------------------------------------------------------------
// End-to-end transaction: preflight (disk-anchored resolve) -> apply -> verify
// ---------------------------------------------------------------------------

test("end-to-end restore transaction: rehomed-transcript resolve, preflight-failure surfacing, and verify-timeout disambiguation", async () => {
  const REHOMED_UUID = "51ee6f32-aaaa-bbbb-cccc-000000000001";
  const UNRESOLVABLE_UUID = "deba61ad-dead-beef-0000-000000000002";
  const STALE_CWD = "/Users/mike/code/keeper";
  const MOVED_CWD = "/Users/mike/worktrees/keeper-x";
  const HOME = "/home/tester";

  // The recorded cwd (STALE_CWD) is a HINT: the session actually rehomed to
  // MOVED_CWD, provable only from the transcript's own tail on disk.
  seedJob(kdb.db, {
    job_id: REHOMED_UUID,
    harness: "claude",
    cwd: STALE_CWD,
  });
  // No on-disk transcript at all for this uuid — must surface as a typed
  // preflight failure, never a doomed `--resume` line.
  seedJob(kdb.db, {
    job_id: UNRESOLVABLE_UUID,
    harness: "claude",
    cwd: STALE_CWD,
  });
  // Two non-claude tabs whose artifact resolves fine at preflight, but whose
  // attach never produces evidence within the verify bound — one alive
  // (a warn), one dead (a real failure). This is the disambiguation the
  // verify bound exists to make, never a false `verified`.
  seedJob(kdb.db, {
    job_id: "pi-alive-timeout",
    harness: "pi",
    resume_target: "pi-sess-alive",
    cwd: STALE_CWD,
  });
  seedJob(kdb.db, {
    job_id: "pi-dead-timeout",
    harness: "pi",
    resume_target: "pi-sess-dead",
    cwd: STALE_CWD,
  });
  seedGeneration(
    kdb.db,
    21,
    "gen-new",
    [
      { pane_id: "%1", window_index: 0, job_id: REHOMED_UUID },
      { pane_id: "%2", window_index: 1, job_id: UNRESOLVABLE_UUID },
      { pane_id: "%3", window_index: 2, job_id: "pi-alive-timeout" },
      { pane_id: "%4", window_index: 3, job_id: "pi-dead-timeout" },
    ],
    NOW - 60,
  );

  // Selection: one eligible generation, unambiguous auto-pick.
  const sel = loadRestorePlan(dbPath, { probeNow: () => null });
  expect(sel.pickedGeneration?.generation_id).toBe("gen-new");
  expect(sel.candidates).toHaveLength(4);

  // Preflight: disk-anchored resolution over a fake fs — no real ~/.claude,
  // no real pi sessions dir.
  const movedSlug = MOVED_CWD.replace(/[/.]/g, "-");
  const fakeFs = makeFakeFs({
    files: {
      [join(HOME, ".claude/projects", movedSlug, `${REHOMED_UUID}.jsonl`)]:
        transcriptLine(MOVED_CWD),
      [join(HOME, ".pi/agent/sessions", "pi-sess-alive.session")]: "{}",
      [join(HOME, ".pi/agent/sessions", "pi-sess-dead.session")]: "{}",
    },
    // The resolved (moved) cwd must itself exist on disk — resolveClaudeCwd's
    // risk guard refuses a resolved cwd a torn-down worktree left behind.
    dirs: [MOVED_CWD],
  });
  const resolver = makeResumeResolver({ fs: fakeFs, homeDir: HOME, env: {} });
  const plan = planRestore(sel.candidates, null, resolver);

  const rehomed = plan.find((o) => o.candidate.job_id === REHOMED_UUID);
  const unresolvable = plan.find(
    (o) => o.candidate.job_id === UNRESOLVABLE_UUID,
  );
  const piAlive = plan.find((o) => o.candidate.job_id === "pi-alive-timeout");
  const piDead = plan.find((o) => o.candidate.job_id === "pi-dead-timeout");

  // Rehomed transcript: the recorded (stale) cwd is OVERRIDDEN by the disk-
  // anchored resolution — never the recorded cwd, never a doomed line.
  expect(rehomed?.kind).toBe("would-restore");
  expect((rehomed as { candidate: RestoreCandidate }).candidate.cwd).toBe(
    MOVED_CWD,
  );

  // No transcript on disk at all: a typed preflight failure naming the fix,
  // never a launch attempt.
  expect(unresolvable?.kind).toBe("preflight-failed");
  expect(
    (unresolvable as { reason: string; fixCommand: string }).reason,
  ).toContain(UNRESOLVABLE_UUID);
  expect((unresolvable as { fixCommand: string }).fixCommand).toContain(
    UNRESOLVABLE_UUID,
  );

  // Both pi tabs' resume targets resolve on disk at preflight time — the
  // attach-evidence disambiguation happens only later, at apply/verify time.
  expect(piAlive?.kind).toBe("would-restore");
  expect(piDead?.kind).toBe("would-restore");

  // Apply + verify: every would-restore candidate "launches" via a fake
  // ensureLaunched; verify is the REAL verifyAttach driven by fake
  // evidence/liveness/clock/sleep seams (deterministic, no real waiting).
  const launchedJobIds: string[] = [];
  const writes: RestoreIntent[] = [];
  const intent: IntentSink = { write: (i) => writes.push({ ...i }) };
  const makeIntent = (c: RestoreCandidate): RestoreIntent => ({
    schema_version: RESTORE_INTENT_SCHEMA_VERSION,
    generation_id: "gen-new",
    job_id: c.job_id,
    session_uuid: c.resume_target,
    harness: c.harness ?? "claude",
    resume_target: c.resume_target,
    cwd: c.cwd ?? "",
    backend_exec_session_id: c.backend_exec_session_id,
    argv: [
      "keeper",
      "agent",
      c.harness ?? "claude",
      "--resume",
      c.resume_target,
    ],
    rerun_command: "keeper tabs restore --apply --session work",
    attempt: 1,
    state: "planned",
    reason: "",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  });

  async function verify(
    candidate: RestoreCandidate,
    launchStartMs: number,
  ): Promise<AttachVerdict> {
    if (candidate.job_id === REHOMED_UUID) {
      // Evidence present the instant we check — the happy verified path.
      return verifyAttach({
        hasEvidence: () => true,
        paneLiveness: () => "alive",
        now: () => launchStartMs,
        sleep: async () => {},
      });
    }
    // Both timeout scenarios: no evidence ever arrives within the bound —
    // drive the injected clock forward deterministically via `sleep` so the
    // poll loop terminates without any real waiting.
    let elapsed = 0;
    return verifyAttach({
      hasEvidence: () => false,
      paneLiveness: () =>
        candidate.job_id === "pi-alive-timeout" ? "alive" : "dead",
      now: () => launchStartMs + elapsed,
      sleep: async () => {
        elapsed += RESTORE_VERIFY_POLL_MS;
      },
      timeoutMs: RESTORE_VERIFY_TIMEOUT_MS,
      pollMs: RESTORE_VERIFY_POLL_MS,
    });
  }

  const outcomes = await applyRestoreVerified(plan, {
    ensureLaunched: async (_session, _resumeTarget, _cwd, _harness, jobId) => {
      launchedJobIds.push(jobId);
      return { ok: true };
    },
    verify,
    intent,
    makeIntent,
    sleep: async () => {},
  });

  // The preflight-failed tab was NEVER launched — passthrough, not a doomed
  // resume attempt.
  expect(launchedJobIds).not.toContain(UNRESOLVABLE_UUID);
  expect(launchedJobIds.sort()).toEqual(
    [REHOMED_UUID, "pi-alive-timeout", "pi-dead-timeout"].sort(),
  );

  const byJobId = new Map(outcomes.map((o) => [o.candidate.job_id, o]));
  expect(byJobId.get(REHOMED_UUID)?.kind).toBe("verified");
  expect(byJobId.get(UNRESOLVABLE_UUID)?.kind).toBe("preflight-failed");
  // Timed out but the pane is still alive: a WARN, never a failure — the tab
  // resurfaces in `keeper tabs list` until it verifies, but doesn't trip the
  // partial-failure exit code.
  expect(byJobId.get("pi-alive-timeout")?.kind).toBe("launched-unverified");
  // Timed out AND the pane is dead: a real failure — the resume died.
  expect(byJobId.get("pi-dead-timeout")?.kind).toBe("failed");

  // The durable intent trail: verified clears (drops off the resurface list),
  // the unverified/failed tabs are rewritten with their terminal state.
  const finalStates = new Map(writes.map((w) => [w.job_id, w.state]));
  expect(finalStates.get(REHOMED_UUID)).toBe("verified");
  expect(finalStates.get("pi-alive-timeout")).toBe("launched-unverified");
  expect(finalStates.get("pi-dead-timeout")).toBe("failed");
});
