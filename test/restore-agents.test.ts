/**
 * restore-agents tests (epic fn-677 task .4; DB-derived rebuild fn-817 T4).
 *
 * Drive the pure pieces of `scripts/restore-agents.ts` against in-memory
 * candidate fixtures and a seeded read-only `keeper.db`:
 *  - `renderSnapshotScript` — the --snapshot-current revive script: each
 *    candidate emits the BARE `keeper agent claude --x-tmux … --resume`
 *    argv (byte-aligned with --apply, NO `tmux new-window` wrapper).
 *  - `planRestore` — `--session` filter over the candidate's backend session.
 *  - `applyRestore` — apply-vs-dry-run via a capturing fake ensureLaunched
 *    (carrying the resume target), the 0.5s inter-window pacing,
 *    continue-past-failure.
 *  - `renderOutcomes` — latest-name resume commands, label display, idle note.
 *  - `loadRestoreSet` — read-only `deriveRestoreSet` over a seeded DB (daemon-down,
 *    no socket); a candidate resumes by its latest name, read live from the DB.
 *
 * The util's `main()` exit path (Bun.argv parsing, real openDb, real
 * `agentwrapLaunch`) is NOT spawned — the same shape every other one-shot CLI
 * test uses. The fixture DB is a `freshDbFile` clone (no subprocess, no daemon).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentOutcome,
  applyRestore,
  autopilotGateDecision,
  loadLastGenerationSet,
  loadRestoreSet,
  planRestore,
  readAutopilotPaused,
  renderOutcomes,
  renderSnapshotScript,
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

/** Insert a synthetic `BackendExecStart` generation-boundary at an explicit
 *  rowid — pins the generation window relative to the seeded Killed event_ids. */
function seedBackendExecStart(db: Database, id: number): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'backend-exec-start', 'BackendExecStart', 'backend_exec_start', ?)`,
    [
      id,
      RECENT,
      JSON.stringify({ backend_type: "tmux", generation_id: `gen-${id}` }),
    ],
  );
}

/** Insert a synthetic `TmuxTopologySnapshot` at an explicit rowid carrying the
 *  dying generation's live panes (each with the producer-stamped job_id) — the
 *  positive pre-crash evidence the topology-anchored deriver reads. */
function seedTmuxTopologySnapshot(
  db: Database,
  id: number,
  generationId: string,
  panes: {
    pane_id: string;
    session_name: string;
    window_index?: number | null;
    job_id?: string;
  }[],
): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [
      id,
      RECENT,
      JSON.stringify({
        generation_id: generationId,
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          session_name: p.session_name,
          window_index: p.window_index ?? null,
          ...(p.job_id !== undefined ? { job_id: p.job_id } : {}),
        })),
      }),
    ],
  );
}

/** Upsert the singleton `autopilot_state` row at `paused` (1 paused, 0 playing)
 *  — the daemon-down fail-closed gate's read source. */
function seedAutopilotPaused(db: Database, paused: number): void {
  db.run(
    `INSERT OR REPLACE INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?)`,
    [paused, RECENT, RECENT],
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

/** The absolute `keeper agent` launcher prefix injected into the LAUNCH form
 *  (the live util resolves it from `process.execPath` +
 *  `resolveKeeperAgentPathDepFree`; tests inject a fixed one). */
const RESTORE_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"];

// ---------------------------------------------------------------------------
// renderSnapshotScript — the --snapshot-current revive script
// ---------------------------------------------------------------------------

test("renderSnapshotScript emits a get-or-create guard + paced BARE agentwrap resume argv", () => {
  const candidates = [
    fakeCandidate({
      job_id: "j1",
      resume_target: "first-name",
      label: "first-name",
      cwd: "/repo/a",
      window_index: 1,
      backend_exec_session_id: "work",
    }),
    fakeCandidate({
      job_id: "j2",
      resume_target: "second-name",
      label: "second-name",
      cwd: "/repo/b",
      window_index: 2,
      backend_exec_session_id: "work",
    }),
  ];
  const script = renderSnapshotScript(
    candidates,
    null,
    RESTORE_PREFIX,
    "/tmp/keeper.db",
  );
  expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  expect(script).toContain("set -euo pipefail");
  // Get-or-create the session up front (every argv token single-quoted).
  expect(script).toContain("'tmux' 'has-session' '-t' '=work'");
  expect(script).toContain("'tmux' 'new-session' '-d' '-s' 'work'");
  // Each candidate is the BARE agentwrap resume argv — agentwrap owns the
  // session+window, so there is NO `tmux new-window` wrapper around it. cwd is
  // applied via a `cd <cwd> &&` prefix (agentwrap reads its own process.cwd()).
  expect(script).not.toContain("'tmux' 'new-window'");
  expect(script).toContain("cd '/repo/a' && '/abs/bun' '/abs/cli/keeper.ts'");
  expect(script).toContain(
    "'agent' 'claude' '--x-tmux' '--x-tmux-detached' " +
      "'--x-tmux-session' 'work' '--x-tmux-env' " +
      "'KEEPER_TMUX_SESSION=work' '--x-tmux-env' 'KEEPER_PLAN_WORKTREE=' " +
      "'--x-tmux-env' 'KEEPER_PLAN_WORKTREE_BRANCH=' " +
      "'--x-no-confirm' '--resume' 'first-name'",
  );
  // Resume by the LATEST name, never the job_id UUID.
  expect(script).toContain("'--resume' 'first-name'");
  expect(script).toContain("'--resume' 'second-name'");
  expect(script).not.toContain("j1");
  expect(script).not.toContain("j2");
  // Exactly one inter-launch pause (between the two; none leading/trailing).
  expect(script.match(/^sleep 0\.5$/gm) ?? []).toHaveLength(1);
  expect(script).toContain("# summary: snapshot-current sessions=1 windows=2");
});

test("renderSnapshotScript is byte-aligned with what --apply spawns (bare agentwrap argv, no shell wrapper)", () => {
  // The inner per-candidate line must equal the argv agentwrapLaunch spawns on
  // --apply, so the manual snapshot revives identically to the crash path. No
  // login-shell `-c` hold-open wrapper (agentwrap's tmuxShellBody holds the pane
  // open) and no `tmux new-window` (agentwrap mints its own window).
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "j",
        resume_target: "name",
        label: "name",
        cwd: "/repo",
        backend_exec_session_id: "work",
      }),
    ],
    null,
    RESTORE_PREFIX,
    "/tmp/keeper.db",
  );
  expect(script).toContain(
    "cd '/repo' && '/abs/bun' '/abs/cli/keeper.ts' 'agent' 'claude' " +
      "'--x-tmux' '--x-tmux-detached' '--x-tmux-session' " +
      "'work' '--x-tmux-env' 'KEEPER_TMUX_SESSION=work' " +
      "'--x-tmux-env' 'KEEPER_PLAN_WORKTREE=' " +
      "'--x-tmux-env' 'KEEPER_PLAN_WORKTREE_BRANCH=' " +
      "'--x-no-confirm' '--resume' 'name'",
  );
  expect(script).not.toContain('"$@"');
  expect(script).not.toContain("exec ");
});

test("renderSnapshotScript: a resume target with shell metacharacters is single-quoted, never fires", () => {
  const nasty = [
    "single ' quote",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the adversarial byte content under test
    "$VAR and ${BRACED}",
    "back`tick`s",
    "$(rm -rf /)",
    "semis ; and && pipes |",
    "-leading-dash",
  ].join(" :: ");
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "x",
        resume_target: nasty,
        label: "x",
        cwd: "/repo",
        backend_exec_session_id: "work",
      }),
    ],
    null,
    RESTORE_PREFIX,
    "/tmp/keeper.db",
  );
  // The target rides as a single-quoted `--resume` value — `'` is the close-
  // escape-reopen idiom, every other metachar is neutralized by the quotes.
  const quoted = `'${nasty.replace(/'/g, `'\\''`)}'`;
  expect(script).toContain(`'--resume' ${quoted}`);
});

test("renderSnapshotScript --session filter narrows to one bucket", () => {
  const candidates = [
    fakeCandidate({
      job_id: "a",
      resume_target: "a-name",
      label: "a-name",
      backend_exec_session_id: "work",
    }),
    fakeCandidate({
      job_id: "b",
      resume_target: "b-name",
      label: "b-name",
      backend_exec_session_id: "other",
    }),
  ];
  const script = renderSnapshotScript(
    candidates,
    "other",
    RESTORE_PREFIX,
    "/tmp/keeper.db",
  );
  expect(script).toContain("'--resume' 'b-name'");
  expect(script).not.toContain("'--resume' 'a-name'");
  expect(script).toContain("# summary: snapshot-current sessions=1 windows=1");
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

test("applyRestore launches each would-restore via ensureLaunched, carrying the resume target", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", resume_target: "a-name", cwd: "/repo/a" }),
      fakeCandidate({ job_id: "b", resume_target: "b-name", cwd: "/repo/b" }),
    ],
    null,
  );
  const calls: { session: string; resumeTarget: string; cwd: string }[] = [];
  const out = await applyRestore(
    plan,
    async (session, resumeTarget, cwd) => {
      calls.push({ session, resumeTarget, cwd });
      return { ok: true };
    },
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls).toHaveLength(2);
  // The candidate's recorded session, latest-name resume target, and cwd flow
  // straight to the agentwrapLaunch seam — agentwrap builds the --resume argv.
  expect(calls[0]).toEqual({
    session: "work",
    resumeTarget: "a-name",
    cwd: "/repo/a",
  });
  expect(calls[1].resumeTarget).toBe("b-name");
});

test("applyRestore continues past a single agent's launch failure", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "fail" }), fakeCandidate({ job_id: "ok" })],
    null,
  );
  const out = await applyRestore(
    plan,
    async (_session, resumeTarget) =>
      resumeTarget === "fail"
        ? { ok: false, error: "agentwrap launch no-op (exit 3 NOOP)" }
        : { ok: true },
    async () => {},
  );
  expect(out).toHaveLength(2);
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe(
    "agentwrap launch no-op (exit 3 NOOP)",
  );
  expect(out[1].kind).toBe("restored");
});

test("applyRestore traps a thrown ensureLaunched and marks the entry failed", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "boom" })], null);
  const out = await applyRestore(
    plan,
    async () => {
      throw new Error("spawn failed");
    },
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
    async (_s, resumeTarget) =>
      resumeTarget === "fail" ? { ok: false, error: "boom" } : { ok: true },
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
    async (_s, resumeTarget) =>
      resumeTarget === "z" ? { ok: false, error: "nope" } : { ok: true },
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

test("loadRestoreSet derives a crash-killed session into a latest-name candidate (no socket)", () => {
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
  // The resume target is the LATEST name (the current title) — a renamed session
  // resumes to the name keeper currently knows, read live from the DB. The label
  // shows the same name.
  expect(candidates[0].resume_target).toBe("my-renamed-session");
  expect(candidates[0].label).toBe("my-renamed-session");
  expect(candidates[0].cwd).toBe("/repo");

  // And the rendered command targets the latest name end-to-end.
  const out = renderOutcomes(planRestore(candidates, null), false, 0);
  expect(out).toContain(`claude --resume "my-renamed-session"`);
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
  const calls: { session: string; resumeTarget: string; cwd: string }[] = [];
  const out: AgentOutcome[] = await applyRestore(
    plan,
    async (session, resumeTarget, cwd) => {
      calls.push({ session, resumeTarget, cwd });
      return { ok: true };
    },
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls.map((c) => c.session)).toEqual(["work", "work"]);
  // The candidate's latest-name resume target (the UUID here, no title) + cwd
  // flow straight to the agentwrapLaunch seam.
  expect(calls[0].resumeTarget).toBe("uuid-a");
  expect(calls[0].cwd).toBe("/repo/a");
  expect(calls[1].resumeTarget).toBe("uuid-b");
  expect(calls[1].cwd).toBe("/repo/b");
});

// ---------------------------------------------------------------------------
// loadLastGenerationSet — the --last-generation source (epic fn-819 T2)
// ---------------------------------------------------------------------------

test("loadLastGenerationSet bounds to the last generation; the full set offers more", () => {
  // gen-A start at id 100, gen-B start at id 200. A prior-gen kill (id 150) and
  // two last-gen kills (ids 250/251).
  seedBackendExecStart(kdb.db, 100);
  seedBackendExecStart(kdb.db, 200);
  seedJob(kdb.db, {
    job_id: "prior-gen",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "last-gen-a",
    close_kind: "server_gone",
    window_index: 1,
    last_event_id: 250,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "last-gen-b",
    close_kind: "server_gone",
    window_index: 2,
    last_event_id: 251,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  // The full set offers all three; last-generation bounds to gen-B's two kills.
  expect(loadRestoreSet(dbPath).candidates.map((c) => c.job_id)).toEqual([
    "prior-gen",
    "last-gen-a",
    "last-gen-b",
  ]);
  expect(loadLastGenerationSet(dbPath).candidates.map((c) => c.job_id)).toEqual(
    ["last-gen-a", "last-gen-b"],
  );
});

test("loadLastGenerationSet composes with the --session filter", () => {
  // Two last-generation kills in different sessions; planRestore narrows to one.
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "legacy-agent",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "legacy",
  });
  seedJob(kdb.db, {
    job_id: "work-agent",
    close_kind: "server_gone",
    window_index: 1,
    last_event_id: 151,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const { candidates } = loadLastGenerationSet(dbPath);
  expect(candidates.map((c) => c.job_id).sort()).toEqual([
    "legacy-agent",
    "work-agent",
  ]);
  // --session work narrows to the work bucket only.
  const plan = planRestore(candidates, "work");
  expect(plan).toHaveLength(1);
  expect(plan[0].candidate.job_id).toBe("work-agent");
});

test("loadLastGenerationSet: topology-anchored — offers ONLY the dying-gen snapshot panes (injected G_now)", () => {
  // The dying generation (gen-dead) left a snapshot with 2 live panes; a day of
  // historically-closed killed rows the OLD retrospective model would sweep in
  // also sits in the DB. The injected G_now (a respawned-server pid != gen-dead)
  // selects the dying generation; the topology model offers only its 2 panes.
  for (let i = 0; i < 10; i++) {
    seedJob(kdb.db, {
      job_id: `historical-${i}`,
      close_kind: "server_gone",
      window_index: i,
      last_event_id: 150 + i,
      backend_exec_session_id: "work",
    });
  }
  seedJob(kdb.db, {
    job_id: "live-a",
    state: "killed",
    title: "alpha",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "live-b",
    state: "killed",
    title: "beta",
    window_index: 1,
    backend_exec_session_id: "work",
  });
  seedTmuxTopologySnapshot(kdb.db, 900, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "live-a" },
    { pane_id: "%2", session_name: "work", window_index: 1, job_id: "live-b" },
  ]);
  kdb.db.close();

  // The full set offers the whole pool; the topology-anchored last-gen offers
  // only the dying-gen snapshot's 2 panes. G_now injected as a fresh pid.
  expect(loadRestoreSet(dbPath).candidates.length).toBeGreaterThan(2);
  const set = loadLastGenerationSet(dbPath, () => "gen-now");
  expect(set.candidates.map((c) => c.job_id)).toEqual(["live-a", "live-b"]);
  expect(set.fallbackNote).toBeUndefined();
});

test("loadLastGenerationSet: no snapshot ⇒ labeled fallback, killed cohort offered", () => {
  // No TmuxTopologySnapshot — the deriver degrades to the retrospective model and
  // surfaces a visible fallbackNote. The injected G_now is irrelevant (no
  // snapshot to exclude).
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "killed-cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const set = loadLastGenerationSet(dbPath, () => "gen-now");
  expect(set.candidates.map((c) => c.job_id)).toEqual(["killed-cohort"]);
  expect(set.fallbackNote).toBeDefined();
});

// ---------------------------------------------------------------------------
// autopilotGateDecision / readAutopilotPaused — the --apply fail-closed gate
// (epic fn-955 T3)
// ---------------------------------------------------------------------------

test("autopilotGateDecision: paused ⇒ proceed regardless of --force", () => {
  expect(autopilotGateDecision(true, false)).toBe("proceed");
  expect(autopilotGateDecision(true, true)).toBe("proceed");
});

test("autopilotGateDecision: unpaused without --force ⇒ blocked (fail closed)", () => {
  expect(autopilotGateDecision(false, false)).toBe("blocked");
});

test("autopilotGateDecision: unpaused with --force ⇒ forced (launch + warn)", () => {
  expect(autopilotGateDecision(false, true)).toBe("forced");
});

test("readAutopilotPaused: folded paused=0 reads UNPAUSED (the gate-tripping state)", () => {
  seedAutopilotPaused(kdb.db, 0);
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(false);
});

test("readAutopilotPaused: folded paused=1 reads PAUSED", () => {
  seedAutopilotPaused(kdb.db, 1);
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(true);
});

test("readAutopilotPaused: absent singleton (fresh board) reads PAUSED (permissive)", () => {
  // No autopilot_state row seeded — a quiet/fresh board.
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(true);
});

// ---------------------------------------------------------------------------
// The --apply gate in the action loop: unpaused + no --force launches NOTHING.
// applyRestore is the launch seam; the gate sits BEFORE it. Assert via the
// capturing-fake launcher that a "blocked" decision spawns zero windows while a
// "proceed"/"forced" decision spawns all of them.
// ---------------------------------------------------------------------------

test("--apply gate: blocked decision launches zero windows (capturing fake)", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  let launches = 0;
  const launcher = async () => {
    launches++;
    return { ok: true as const };
  };
  // The gate trips before applyRestore is ever reached — mirror main()'s order.
  const decision = autopilotGateDecision(/* paused */ false, /* force */ false);
  if (decision !== "blocked") {
    await applyRestore(plan, launcher, async () => {});
  }
  expect(decision).toBe("blocked");
  expect(launches).toBe(0);
});

test("--apply gate: forced/proceed decision launches every window (capturing fake)", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  for (const decision of [
    autopilotGateDecision(true, false), // proceed (paused)
    autopilotGateDecision(false, true), // forced (unpaused + --force)
  ]) {
    let launches = 0;
    const launcher = async () => {
      launches++;
      return { ok: true as const };
    };
    if (decision !== "blocked") {
      await applyRestore(plan, launcher, async () => {});
    }
    expect(launches).toBe(2);
  }
});
