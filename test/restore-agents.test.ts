/**
 * restore-agents tests (epic fn-677 task .4; DB-derived rebuild fn-817 T4).
 *
 * Drive the pure pieces of `scripts/restore-agents.ts` against in-memory
 * candidate fixtures and a seeded read-only `keeper.db`:
 *  - `buildResumeLaunchArgv` — UUID resume key, login-shell wrap, no --plugin-dir.
 *  - `planRestore` — `--session` filter over the candidate's backend session.
 *  - `applyRestore` — apply-vs-dry-run via a capturing fake ensureLaunched, the
 *    0.5s inter-window pacing, continue-past-failure.
 *  - `renderOutcomes` — UUID-targeting commands, label display, idle note.
 *  - `loadRestoreSet` — read-only `deriveRestoreSet` over a seeded DB (daemon-down,
 *    no socket); a RENAMED session restores by its stable job_id UUID.
 *
 * The util's `main()` exit path (Bun.argv parsing, real openDb, real tmux
 * ensureLaunched) is NOT spawned — the same shape every other one-shot CLI test
 * uses. The fixture DB is a `freshDbFile` clone (no subprocess, no daemon).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentOutcome,
  applyRestore,
  buildResumeLaunchArgv,
  loadRestoreSet,
  planRestore,
  renderOutcomes,
} from "../scripts/restore-agents";
import type { RestoreCandidate } from "../src/restore-set";
import { freshDbFile } from "./helpers/template-db";

// `loadRestoreSet` calls `deriveRestoreSet(db)` with no `now` override, so the
// idle cutoff keys off the REAL wall clock. Seed rows "recent" (relative to the
// real clock) so a year-stale fixture isn't idle-excluded — a test-time clock
// read is fine (tests aren't folds). `RECENT` is a few minutes ago.
const RECENT = Math.floor(Date.now() / 1000) - 60;

let tmpDir: string;
let dbPath: string;
let kdb: ReturnType<typeof freshDbFile>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-agents-test-"));
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
// Fixture helpers
// ---------------------------------------------------------------------------

interface SeedJob {
  job_id: string;
  state?: string;
  close_kind?: string | null;
  window_index?: number | null;
  title?: string | null;
  cwd?: string | null;
  created_at?: number;
  updated_at?: number;
  backend_exec_session_id?: string | null;
  plan_verb?: string | null;
  last_event_id?: number | null;
}

/** Insert one jobs row with sensible defaults; only the fields a test cares
 *  about need to be passed. Writes raw — exercising the read path, not the fold. */
function seedJob(db: Database, j: SeedJob): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, title, cwd, close_kind,
       window_index, backend_exec_session_id, plan_verb, last_event_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      j.job_id,
      j.created_at ?? RECENT,
      j.updated_at ?? RECENT,
      j.state ?? "killed",
      j.title ?? null,
      j.cwd ?? null,
      j.close_kind ?? null,
      j.window_index ?? null,
      "backend_exec_session_id" in j
        ? (j.backend_exec_session_id ?? null)
        : "work",
      j.plan_verb ?? null,
      j.last_event_id ?? null,
    ],
  );
}

/** Build a `RestoreCandidate` for the pure presenter tests. */
function fakeCandidate(opts: {
  job_id: string;
  resume_target?: string;
  label?: string;
  window_index?: number | null;
  cwd?: string | null;
  backend_exec_session_id?: string;
  created_at?: number;
}): RestoreCandidate {
  return {
    job_id: opts.job_id,
    resume_target: opts.resume_target ?? opts.job_id,
    label: opts.label ?? opts.job_id,
    window_index: opts.window_index ?? null,
    cwd: "cwd" in opts ? (opts.cwd ?? null) : "/repo",
    backend_exec_session_id: opts.backend_exec_session_id ?? "work",
    created_at: opts.created_at ?? 1000,
  };
}

// ---------------------------------------------------------------------------
// buildResumeLaunchArgv — UUID resume key, shell wrap, no --plugin-dir
// ---------------------------------------------------------------------------

test("buildResumeLaunchArgv wraps the UUID resume command in a login shell prologue", () => {
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeCandidate({
      job_id: "sess-xyz",
      resume_target: "sess-xyz",
      cwd: "/repo",
    }),
  );
  expect(argv.slice(0, 4)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
  // The fifth element is the body — cd, claude --resume <uuid>, exec back into
  // the shell so the tab survives `claude` exiting.
  expect(argv[4]).toContain("cd /repo");
  expect(argv[4]).toContain(`claude --resume "sess-xyz"`);
  expect(argv[4]).toContain("exec /bin/zsh -l -i");
});

test("buildResumeLaunchArgv drops cd prefix when cwd is null", () => {
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeCandidate({ job_id: "x", resume_target: "x", cwd: null }),
  );
  expect(argv[4]).not.toContain("cd ");
  expect(argv[4].startsWith(`claude --resume "x"`)).toBe(true);
});

test("buildResumeLaunchArgv never includes --plugin-dir (fn-10 inverted tier routing)", () => {
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeCandidate({ job_id: "x", resume_target: "x", cwd: "/repo" }),
  );
  expect(argv[4]).not.toContain("--plugin-dir");
  expect(argv[4]).not.toContain("work-plugins");
});

// ---------------------------------------------------------------------------
// planRestore — session filter (candidates arrive pre-ordered)
// ---------------------------------------------------------------------------

test("planRestore marks every candidate would-restore by default", () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  expect(plan.map((p) => p.kind)).toEqual(["would-restore", "would-restore"]);
});

test("planRestore respects the --session filter (matches the backend session)", () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", backend_exec_session_id: "autopilot" }),
      fakeCandidate({ job_id: "b", backend_exec_session_id: "side" }),
    ],
    "autopilot",
  );
  expect(plan).toHaveLength(1);
  expect(plan[0].candidate.job_id).toBe("a");
});

test("planRestore filter that matches no session yields an empty plan", () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], "nope");
  expect(plan).toEqual([]);
});

test("planRestore preserves the candidate input order (visual order from deriveRestoreSet)", () => {
  // deriveRestoreSet already sorts by window order; planRestore must not reshuffle.
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "first", window_index: 0 }),
      fakeCandidate({ job_id: "second", window_index: 1 }),
      fakeCandidate({ job_id: "third", window_index: 2 }),
    ],
    null,
  );
  expect(plan.map((p) => p.candidate.job_id)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

// ---------------------------------------------------------------------------
// applyRestore — apply-vs-dry-run, pacing, continue-past-failure
// ---------------------------------------------------------------------------

test("applyRestore launches each would-restore via ensureLaunched", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  const calls: { session: string; argv: string[]; cwd: string }[] = [];
  const out = await applyRestore(
    plan,
    async (session, argv, cwd) => {
      calls.push({ session, argv, cwd });
      return { ok: true };
    },
    "/bin/zsh",
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls).toHaveLength(2);
  expect(calls[0].session).toBe("work");
  expect(calls[0].argv[4]).toContain(`claude --resume "a"`);
});

test("applyRestore continues past a single agent's launch failure", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "fail" }), fakeCandidate({ job_id: "ok" })],
    null,
  );
  const out = await applyRestore(
    plan,
    async (_session, argv) =>
      argv[4].includes(`"fail"`)
        ? { ok: false, error: "tmux ENOENT" }
        : { ok: true },
    "/bin/zsh",
    async () => {},
  );
  expect(out).toHaveLength(2);
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("tmux ENOENT");
  expect(out[1].kind).toBe("restored");
});

test("applyRestore traps a thrown ensureLaunched and marks the entry failed", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "boom" })], null);
  const out = await applyRestore(
    plan,
    async () => {
      throw new Error("spawn failed");
    },
    "/bin/zsh",
    async () => {},
  );
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("spawn failed");
});

test("applyRestore pauses 0.5s between consecutive launches only", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", window_index: 0 }),
      fakeCandidate({ job_id: "b", window_index: 1 }),
      fakeCandidate({ job_id: "c", window_index: 2 }),
    ],
    null,
  );
  const sleeps: number[] = [];
  let launches = 0;
  await applyRestore(
    plan,
    async () => {
      launches++;
      return { ok: true };
    },
    "/bin/zsh",
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(launches).toBe(3);
  // Three launches → exactly TWO pauses of 500ms (never before the first).
  expect(sleeps).toEqual([500, 500]);
});

test("applyRestore emits no pause for a single launch", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "solo" })], null);
  const sleeps: number[] = [];
  await applyRestore(
    plan,
    async () => ({ ok: true }),
    "/bin/zsh",
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(sleeps).toEqual([]);
});

test("applyRestore still pauses after a launch FAILURE (pacing outside try/catch)", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "fail", window_index: 0 }),
      fakeCandidate({ job_id: "ok", window_index: 1 }),
    ],
    null,
  );
  const sleeps: number[] = [];
  const out = await applyRestore(
    plan,
    async (_s, argv) =>
      argv[4].includes(`"fail"`) ? { ok: false, error: "boom" } : { ok: true },
    "/bin/zsh",
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(out.map((o) => o.kind)).toEqual(["failed", "restored"]);
  // The first launch failing does not drop the second agent's pause.
  expect(sleeps).toEqual([500]);
});

// ---------------------------------------------------------------------------
// renderOutcomes — summary line, UUID-targeting commands, idle note
// ---------------------------------------------------------------------------

test("renderOutcomes dry-run summary names would-restore", () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  const out = renderOutcomes(plan, false, 0);
  expect(out).toContain("would-restore=2");
  expect(out).not.toContain("restored=");
});

test("renderOutcomes apply summary names restored / failed", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "x" }),
      fakeCandidate({ job_id: "y" }),
      fakeCandidate({ job_id: "z" }),
    ],
    null,
  );
  const out = await applyRestore(
    plan,
    async (_s, argv) =>
      argv[4].includes(`"z"`) ? { ok: false, error: "nope" } : { ok: true },
    "/bin/zsh",
    async () => {},
  );
  const rendered = renderOutcomes(out, true, 0);
  expect(rendered).toContain("restored=2");
  expect(rendered).toContain("failed=1");
  expect(rendered).toContain("FAILED z");
});

test("renderOutcomes labels use the candidate label, command targets the UUID", () => {
  const plan = planRestore(
    [
      fakeCandidate({
        job_id: "sess-aaaa",
        resume_target: "sess-aaaa",
        label: "epic-benchmark-monitor",
      }),
    ],
    null,
  );
  const out = renderOutcomes(plan, false, 0);
  // The label is the human-readable display name (latest title).
  expect(out).toContain("would restore epic-benchmark-monitor");
  // The resume command targets the stable UUID, not the label.
  expect(out).toContain(`claude --resume "sess-aaaa"`);
});

test("renderOutcomes surfaces the idle-excluded count as a note", () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const out = renderOutcomes(plan, false, 3);
  expect(out).toContain("3 crash-like candidate(s) excluded as idle");
});

test("renderOutcomes omits the idle note when zero excluded", () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const out = renderOutcomes(plan, false, 0);
  expect(out).not.toContain("excluded as idle");
});

// ---------------------------------------------------------------------------
// loadRestoreSet — read-only deriveRestoreSet over a seeded DB (daemon-down)
// ---------------------------------------------------------------------------

test("loadRestoreSet derives a crash-killed session into a UUID-keyed candidate (no socket)", () => {
  // Persist the seeded rows so the fresh read-only open in loadRestoreSet sees
  // them, then close our writer handle.
  seedJob(kdb.db, {
    job_id: "uuid-1111",
    close_kind: "server_gone",
    title: "my-renamed-session",
    cwd: "/repo",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const { candidates } = loadRestoreSet(dbPath);
  expect(candidates).toHaveLength(1);
  // The resume target is the stable job_id UUID — a renamed session resumes by
  // UUID, never by the (renamed) title. The label still shows the latest title.
  expect(candidates[0].resume_target).toBe("uuid-1111");
  expect(candidates[0].label).toBe("my-renamed-session");
  expect(candidates[0].cwd).toBe("/repo");

  // And the rendered command targets the UUID end-to-end.
  const out = renderOutcomes(planRestore(candidates, null), false, 0);
  expect(out).toContain(`claude --resume "uuid-1111"`);
  expect(out).toContain("would restore my-renamed-session");
});

test("loadRestoreSet excludes a user-closed window, offers a crash-killed one", () => {
  seedJob(kdb.db, {
    job_id: "closed",
    close_kind: "window_gone_server_alive",
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "crashed",
    close_kind: "pid_died",
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const { candidates } = loadRestoreSet(dbPath);
  expect(candidates.map((c) => c.job_id)).toEqual(["crashed"]);
});

test("loadRestoreSet returns candidates in visual window order", () => {
  // On-disk insert order does not match window order; deriveRestoreSet sorts by
  // window_index.
  seedJob(kdb.db, {
    job_id: "third",
    close_kind: "server_gone",
    window_index: 2,
  });
  seedJob(kdb.db, {
    job_id: "first",
    close_kind: "server_gone",
    window_index: 0,
  });
  seedJob(kdb.db, {
    job_id: "second",
    close_kind: "server_gone",
    window_index: 1,
  });
  kdb.db.close();

  const { candidates } = loadRestoreSet(dbPath);
  expect(candidates.map((c) => c.job_id)).toEqual(["first", "second", "third"]);
});

test("loadRestoreSet end-to-end: the apply path relaunches each derived candidate by UUID", async () => {
  seedJob(kdb.db, {
    job_id: "uuid-a",
    close_kind: "server_gone",
    cwd: "/repo/a",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "uuid-b",
    close_kind: "pid_died",
    cwd: "/repo/b",
    window_index: 1,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const { candidates } = loadRestoreSet(dbPath);
  const plan = planRestore(candidates, null);
  const calls: { session: string; argv: string[]; cwd: string }[] = [];
  const out: AgentOutcome[] = await applyRestore(
    plan,
    async (session, argv, cwd) => {
      calls.push({ session, argv, cwd });
      return { ok: true };
    },
    "/bin/zsh",
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls.map((c) => c.session)).toEqual(["work", "work"]);
  expect(calls[0].argv[4]).toContain(`claude --resume "uuid-a"`);
  expect(calls[0].cwd).toBe("/repo/a");
  expect(calls[1].argv[4]).toContain(`claude --resume "uuid-b"`);
  expect(calls[1].cwd).toBe("/repo/b");
});
