/**
 * restore-agents tests (epic fn-677 task .4).
 *
 * Drive the pure pieces of `scripts/restore-agents.ts` against in-memory
 * fixtures: `classifySchemaVersion` gate, `buildLiveJobIdSet` dedup,
 * `planRestore` session-filter + skip logic, `buildResumeLaunchArgv` shell
 * wrap, `applyRestore` apply-vs-dry-run via a capturing fake ensureLaunched,
 * `loadRestoreFile` parse / missing / future-schema branches.
 *
 * The util's `main()` exit path (Bun.argv parsing, real Bun.connect probe,
 * real tmux ensureLaunched) is NOT spawned — the same shape every other
 * one-shot CLI test in this repo uses. `KEEPER_RESTORE_FILE` is set per-test
 * for fs sandboxing per CLAUDE.md "test-isolation" rules.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRestore,
  buildLiveJobIdSet,
  buildResumeLaunchArgv,
  classifySchemaVersion,
  compareRestoreAgents,
  loadRestoreFile,
  loadRestoreTiers,
  planRestore,
  renderOutcomes,
  renderSnapshotScript,
  resolveCrashSource,
  shellQuote,
} from "../scripts/restore-agents";
import type { RestoreAgent, RestoreSession } from "../src/restore-worker";
import type { Job } from "../src/types";

let tmpDir: string;
let restorePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-agents-test-"));
  restorePath = join(tmpDir, "restore.json");
  process.env.KEEPER_RESTORE_FILE = restorePath;
});

afterEach(() => {
  delete process.env.KEEPER_RESTORE_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifySchemaVersion — future-refuse / safe-default gate
// ---------------------------------------------------------------------------

test("classifySchemaVersion returns ok for the current version (v3)", () => {
  expect(classifySchemaVersion(3)).toBe("ok");
});

test("classifySchemaVersion returns ok for older versions (v1, v2)", () => {
  // v1/v2 are <= RESTORE_SCHEMA_VERSION (now 3), so they fall through, not
  // future. A v2 file (no per-bucket backend) coerces to the default downstream.
  expect(classifySchemaVersion(1)).toBe("ok");
  expect(classifySchemaVersion(2)).toBe("ok");
});

test("classifySchemaVersion treats missing schema_version as 0 (ok, safe default)", () => {
  expect(classifySchemaVersion(undefined)).toBe("ok");
  expect(classifySchemaVersion(null)).toBe("ok");
});

test("classifySchemaVersion treats non-numeric schema_version as 0 (ok)", () => {
  expect(classifySchemaVersion("v1")).toBe("ok");
  expect(classifySchemaVersion({})).toBe("ok");
});

test("classifySchemaVersion refuses a future version", () => {
  expect(classifySchemaVersion(4)).toBe("future");
  expect(classifySchemaVersion(999)).toBe("future");
});

// ---------------------------------------------------------------------------
// buildLiveJobIdSet — dedup substrate
// ---------------------------------------------------------------------------

test("buildLiveJobIdSet collects non-empty job_ids", () => {
  const jobs = [
    { job_id: "a" } as unknown as Job,
    { job_id: "b" } as unknown as Job,
    { job_id: "c" } as unknown as Job,
  ];
  expect([...buildLiveJobIdSet(jobs)].sort()).toEqual(["a", "b", "c"]);
});

test("buildLiveJobIdSet drops empty / unset job_ids defensively", () => {
  const jobs = [
    { job_id: "real" } as unknown as Job,
    { job_id: "" } as unknown as Job,
    { job_id: null } as unknown as Job,
  ];
  expect([...buildLiveJobIdSet(jobs)]).toEqual(["real"]);
});

// ---------------------------------------------------------------------------
// planRestore — session filter + skip-live diff
// ---------------------------------------------------------------------------

function fakeAgent(opts: {
  job_id: string;
  cwd?: string | null;
  resume_target?: string;
  tier?: string | null;
  window_index?: number | null;
  created_at?: number;
}): RestoreAgent {
  // Preserve an explicit `null` cwd — tests cover the no-cd branch.
  const cwd = "cwd" in opts ? (opts.cwd ?? null) : "/repo";
  return {
    job_id: opts.job_id,
    cwd,
    resume_target: opts.resume_target ?? opts.job_id,
    tier: opts.tier ?? null,
    plan_verb: null,
    plan_ref: null,
    window_index: opts.window_index ?? null,
    created_at: opts.created_at ?? 1000,
  };
}

/**
 * Build the resolved `sessions` map `planRestore` now consumes directly
 * (epic fn-702 reshape — `planRestore` takes the restore-source `sessions`
 * map, not the full two-tier descriptor).
 */
function fakeSessions(
  sessions: Record<string, RestoreAgent[]>,
): Record<string, RestoreSession> {
  const out: Record<string, RestoreSession> = {};
  for (const [name, agents] of Object.entries(sessions)) {
    out[name] = { agents };
  }
  return out;
}

/**
 * Like {@link fakeSessions} but stamps each bucket's `backend` tag (schema v3),
 * so the backend-routing / unknown-skip paths can be exercised.
 */
function fakeSessionsWithBackend(
  sessions: Record<string, { agents: RestoreAgent[]; backend: string }>,
): Record<string, RestoreSession> {
  const out: Record<string, RestoreSession> = {};
  for (const [name, { agents, backend }] of Object.entries(sessions)) {
    out[name] = { agents, backend };
  }
  return out;
}

// ---------------------------------------------------------------------------
// compareRestoreAgents — visual window-order comparator (total order)
// ---------------------------------------------------------------------------

test("compareRestoreAgents orders known window_index ascending", () => {
  const agents = [
    fakeAgent({ job_id: "c", window_index: 2 }),
    fakeAgent({ job_id: "a", window_index: 0 }),
    fakeAgent({ job_id: "b", window_index: 1 }),
  ];
  agents.sort(compareRestoreAgents);
  expect(agents.map((a) => a.job_id)).toEqual(["a", "b", "c"]);
});

test("compareRestoreAgents sinks a null window_index to the tail", () => {
  const agents = [
    fakeAgent({ job_id: "null", window_index: null }),
    fakeAgent({ job_id: "known", window_index: 5 }),
  ];
  agents.sort(compareRestoreAgents);
  expect(agents.map((a) => a.job_id)).toEqual(["known", "null"]);
});

test("compareRestoreAgents tiebreaks null-vs-null by created_at then job_id", () => {
  const agents = [
    fakeAgent({ job_id: "z", window_index: null, created_at: 100 }),
    fakeAgent({ job_id: "a", window_index: null, created_at: 200 }),
    fakeAgent({ job_id: "b", window_index: null, created_at: 100 }),
  ];
  agents.sort(compareRestoreAgents);
  // created_at ascending first (b,z share 100 → job_id b<z), then a at 200.
  expect(agents.map((a) => a.job_id)).toEqual(["b", "z", "a"]);
});

test("compareRestoreAgents tiebreaks equal window_index by created_at then job_id", () => {
  const agents = [
    fakeAgent({ job_id: "z", window_index: 1, created_at: 50 }),
    fakeAgent({ job_id: "a", window_index: 1, created_at: 50 }),
    fakeAgent({ job_id: "m", window_index: 1, created_at: 10 }),
  ];
  agents.sort(compareRestoreAgents);
  // created_at 10 wins; then the two at 50 break by job_id a<z.
  expect(agents.map((a) => a.job_id)).toEqual(["m", "a", "z"]);
});

test("compareRestoreAgents on an all-null bucket sorts deterministically", () => {
  const mk = () => [
    fakeAgent({ job_id: "c", window_index: null, created_at: 3 }),
    fakeAgent({ job_id: "a", window_index: null, created_at: 1 }),
    fakeAgent({ job_id: "b", window_index: null, created_at: 2 }),
  ];
  const first = mk()
    .sort(compareRestoreAgents)
    .map((a) => a.job_id);
  const second = mk()
    .sort(compareRestoreAgents)
    .map((a) => a.job_id);
  expect(first).toEqual(["a", "b", "c"]);
  expect(first).toEqual(second);
});

test("compareRestoreAgents coerces a non-finite created_at to a stable order", () => {
  const agents = [
    fakeAgent({ job_id: "nan", window_index: null, created_at: NaN }),
    fakeAgent({ job_id: "real", window_index: null, created_at: 5 }),
  ];
  agents.sort(compareRestoreAgents);
  // NaN coerces to 0, sorting ahead of created_at=5 — no NaN-poisoned order.
  expect(agents.map((a) => a.job_id)).toEqual(["nan", "real"]);
});

test("planRestore marks every agent would-restore when the skip-set is empty", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" }), fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => p.kind)).toEqual(["would-restore", "would-restore"]);
});

test("planRestore skips agents whose job_id is in the live skip-set", () => {
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "live", window_index: 0 }),
      fakeAgent({ job_id: "dead", window_index: 1 }),
    ],
  });
  const plan = planRestore(desc, null, new Set(["live"]));
  expect(plan).toHaveLength(2);
  expect(plan[0]).toMatchObject({ kind: "skipped-live" });
  expect((plan[0] as { agent: RestoreAgent }).agent.job_id).toBe("live");
  expect(plan[1]).toMatchObject({ kind: "would-restore" });
  expect((plan[1] as { agent: RestoreAgent }).agent.job_id).toBe("dead");
});

test("planRestore respects the --session filter (single session)", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" })],
    side: [fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, "autopilot", new Set());
  expect(plan).toHaveLength(1);
  expect((plan[0] as { session: string }).session).toBe("autopilot");
  expect((plan[0] as { agent: RestoreAgent }).agent.job_id).toBe("a");
});

test("planRestore session filter that matches no session yields an empty plan", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" })],
  });
  expect(planRestore(desc, "nope", new Set())).toEqual([]);
});

test("planRestore visits sessions in alpha-sorted order", () => {
  const desc = fakeSessions({
    zeta: [fakeAgent({ job_id: "z1" })],
    alpha: [fakeAgent({ job_id: "a1" })],
    mid: [fakeAgent({ job_id: "m1" })],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => (p as { session: string }).session)).toEqual([
    "alpha",
    "mid",
    "zeta",
  ]);
});

test("planRestore emits agents within a session in visual window order", () => {
  // On-disk order is job_id-sorted (a, b, c) but window_index is 2, 0, 1 —
  // the plan must come back in window order: b(0), c(1), a(2).
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "a", window_index: 2 }),
      fakeAgent({ job_id: "b", window_index: 0 }),
      fakeAgent({ job_id: "c", window_index: 1 }),
    ],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => (p as { agent: RestoreAgent }).agent.job_id)).toEqual([
    "b",
    "c",
    "a",
  ]);
});

test("planRestore sinks unknown-order agents to the session tail", () => {
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "no-idx", window_index: null, created_at: 1 }),
      fakeAgent({ job_id: "idx1", window_index: 1 }),
      fakeAgent({ job_id: "idx0", window_index: 0 }),
    ],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => (p as { agent: RestoreAgent }).agent.job_id)).toEqual([
    "idx0",
    "idx1",
    "no-idx",
  ]);
});

test("planRestore reads a v2/legacy bucket (no backend tag) as would-restore", () => {
  // fakeSessions builds buckets without a `backend` field — the v2/legacy
  // shape. They route normally through the default backend, never skipped.
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" })],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => p.kind)).toEqual(["would-restore"]);
});

test("planRestore routes a known tmux bucket as would-restore", () => {
  const desc = fakeSessionsWithBackend({
    autopilot: { agents: [fakeAgent({ job_id: "a" })], backend: "tmux" },
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => p.kind)).toEqual(["would-restore"]);
});

test("planRestore would-restores an explicit-zellij bucket (relaunches in tmux)", () => {
  // tmux is the sole backend: a legacy `zellij`-tagged bucket no longer skips —
  // it would-restores and `resolveExecBackend` routes it to tmux at launch.
  const desc = fakeSessionsWithBackend({
    z: { agents: [fakeAgent({ job_id: "z1" })], backend: "zellij" },
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => p.kind)).toEqual(["would-restore"]);
});

test("planRestore would-restores every bucket regardless of its backend tag", () => {
  const desc = fakeSessionsWithBackend({
    z: { agents: [fakeAgent({ job_id: "z1" })], backend: "zellij" },
    t: { agents: [fakeAgent({ job_id: "t1" })], backend: "tmux" },
    x: { agents: [fakeAgent({ job_id: "x1" })], backend: "kitty" },
  });
  const plan = planRestore(desc, null, new Set());
  // Alpha order: t, x, z — all would-restore (no backend is skipped).
  expect(plan.map((p) => [p.session, p.kind])).toEqual([
    ["t", "would-restore"],
    ["x", "would-restore"],
    ["z", "would-restore"],
  ]);
});

// ---------------------------------------------------------------------------
// buildResumeLaunchArgv — shell wrap shape
// ---------------------------------------------------------------------------

test("buildResumeLaunchArgv wraps the resume command in a login shell prologue", () => {
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeAgent({
      job_id: "sess-xyz",
      cwd: "/repo",
      resume_target: "work::fn-1-foo.2",
    }),
  );
  expect(argv[0]).toBe("/bin/zsh");
  expect(argv.slice(0, 4)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
  // The fifth element is the body — cd, claude --resume, exec back into the
  // shell so the tab survives `claude` exiting.
  expect(argv[4]).toContain("cd /repo");
  expect(argv[4]).toContain(`claude --resume "work::fn-1-foo.2"`);
  expect(argv[4]).toContain("exec /bin/zsh -l -i");
});

test("buildResumeLaunchArgv drops cd prefix when cwd is null", () => {
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeAgent({ job_id: "x", cwd: null, resume_target: "x" }),
  );
  // No `cd` segment; just `claude ... ; exec ...`.
  expect(argv[4]).not.toContain("cd ");
  expect(argv[4].startsWith(`claude --resume "x"`)).toBe(true);
});

test("buildResumeLaunchArgv never includes --plugin-dir, even when tier is set (fn-10)", () => {
  // fn-10 inverted tier routing: the resume command re-attaches to an
  // existing session and no longer carries a tier-plugin flag. The agent's
  // `tier` is still threaded through (board/projection read) but never shapes
  // the spawned argv.
  const argv = buildResumeLaunchArgv(
    "/bin/zsh",
    fakeAgent({
      job_id: "x",
      cwd: "/repo",
      resume_target: "x",
      tier: "mint",
    }),
  );
  expect(argv[4]).not.toContain("--plugin-dir");
  expect(argv[4]).not.toContain("work-plugins");
});

// ---------------------------------------------------------------------------
// applyRestore — apply-vs-dry-run, capture launches, continue past failure
// ---------------------------------------------------------------------------

test("applyRestore is a no-op for non-would-restore entries (skipped-live carries through)", async () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" }), fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, null, new Set(["a"]));
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
  // One skipped-live + one restored.
  expect(out.map((o) => o.kind)).toEqual(["skipped-live", "restored"]);
  // ensureLaunched only fires for the non-skipped agent.
  expect(calls).toHaveLength(1);
  expect(calls[0].session).toBe("autopilot");
  expect(calls[0].argv[4]).toContain(`claude --resume "b"`);
});

test("applyRestore continues past a single agent's launch failure", async () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "fail" }), fakeAgent({ job_id: "ok" })],
  });
  const plan = planRestore(desc, null, new Set());
  const out = await applyRestore(
    plan,
    async (_session, _argv, _cwd) => {
      // First call fails, second succeeds — capture which is which via the
      // call's argv body.
      if (_argv[4].includes(`"fail"`)) {
        return { ok: false, error: "tmux ENOENT" };
      }
      return { ok: true };
    },
    "/bin/zsh",
    async () => {},
  );
  expect(out).toHaveLength(2);
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("tmux ENOENT");
  expect(out[1].kind).toBe("restored");
});

test("applyRestore traps a thrown ensureLaunched and marks the entry failed", async () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "boom" })],
  });
  const plan = planRestore(desc, null, new Set());
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

test("applyRestore makes ZERO ensureLaunched calls when the plan is all skipped-live", async () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" }), fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, null, new Set(["a", "b"]));
  let calls = 0;
  const out = await applyRestore(
    plan,
    async () => {
      calls++;
      return { ok: true };
    },
    "/bin/zsh",
    async () => {},
  );
  expect(calls).toBe(0);
  expect(out.map((o) => o.kind)).toEqual(["skipped-live", "skipped-live"]);
});

test("applyRestore pauses 0.5s between consecutive real launches only", async () => {
  // a (skipped) , b, c live → two real launches, one pause of 500ms between
  // them; never before the first or around the skipped entry.
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "a", window_index: 0 }),
      fakeAgent({ job_id: "b", window_index: 1 }),
      fakeAgent({ job_id: "c", window_index: 2 }),
    ],
  });
  const plan = planRestore(desc, null, new Set(["a"]));
  const sleeps: number[] = [];
  let launches = 0;
  const out = await applyRestore(
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
  expect(out.map((o) => o.kind)).toEqual([
    "skipped-live",
    "restored",
    "restored",
  ]);
  expect(launches).toBe(2);
  // Exactly ONE pause (between the two real launches), of 500ms.
  expect(sleeps).toEqual([500]);
});

test("applyRestore emits no pause for a single real launch", async () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "solo" })],
  });
  const plan = planRestore(desc, null, new Set());
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
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "fail", window_index: 0 }),
      fakeAgent({ job_id: "ok", window_index: 1 }),
    ],
  });
  const plan = planRestore(desc, null, new Set());
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
// renderOutcomes — summary line shape
// ---------------------------------------------------------------------------

test("renderOutcomes dry-run summary names would-restore + skipped-live", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" }), fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, null, new Set(["a"]));
  const out = renderOutcomes(plan, "/bin/zsh", false);
  expect(out).toContain("would-restore=1");
  expect(out).toContain("skipped-live=1");
  expect(out).not.toContain("restored=");
});

test("renderOutcomes apply summary names restored / skipped-live / failed", async () => {
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "x" }),
      fakeAgent({ job_id: "y" }),
      fakeAgent({ job_id: "z" }),
    ],
  });
  const plan = planRestore(desc, null, new Set(["x"]));
  const out = await applyRestore(
    plan,
    async (_s, argv, _c) => {
      if (argv[4].includes(`"z"`)) {
        return { ok: false, error: "nope" };
      }
      return { ok: true };
    },
    "/bin/zsh",
    async () => {},
  );
  const rendered = renderOutcomes(out, "/bin/zsh", true);
  expect(rendered).toContain("restored=1");
  expect(rendered).toContain("skipped-live=1");
  expect(rendered).toContain("failed=1");
  expect(rendered).toContain("FAILED z");
});

test("renderOutcomes labels use the resolved title, not the session id", () => {
  const desc = fakeSessions({
    autopilot: [
      fakeAgent({
        job_id: "sess-aaaa",
        resume_target: "epic-benchmark-monitor",
      }),
      fakeAgent({
        job_id: "sess-bbbb",
        resume_target: "tab-naming-resume-issue",
      }),
    ],
  });
  const plan = planRestore(desc, null, new Set(["sess-bbbb"]));
  const out = renderOutcomes(plan, "/bin/zsh", false);
  // Labels are keyed by the resolved title.
  expect(out).toContain("would restore epic-benchmark-monitor");
  expect(out).toContain("skipping tab-naming-resume-issue — already live");
  // The raw session ids never appear (label was the only place they showed).
  expect(out).not.toContain("sess-aaaa");
  expect(out).not.toContain("sess-bbbb");
});

// ---------------------------------------------------------------------------
// loadRestoreFile — parse / missing / future / ok branches
// ---------------------------------------------------------------------------

test("loadRestoreFile returns missing when the file does not exist", async () => {
  const res = await loadRestoreFile(join(tmpDir, "nope.json"));
  expect(res.kind).toBe("missing");
});

test("loadRestoreFile returns parse-error on malformed JSON", async () => {
  writeFileSync(restorePath, "{not json", "utf8");
  const res = await loadRestoreFile(restorePath);
  expect(res.kind).toBe("parse-error");
});

test("loadRestoreFile returns parse-error when top-level isn't an object", async () => {
  writeFileSync(restorePath, "42", "utf8");
  const res = await loadRestoreFile(restorePath);
  expect(res.kind).toBe("parse-error");
});

test("loadRestoreFile returns future when schema_version is from the future (v4)", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({ schema_version: 4, current: { sessions: {} } }),
    "utf8",
  );
  const res = await loadRestoreFile(restorePath);
  expect(res.kind).toBe("future");
  expect((res as { version: number }).version).toBe(4);
});

function okSessions(
  res: Awaited<ReturnType<typeof loadRestoreFile>>,
): Record<string, RestoreSession> {
  expect(res.kind).toBe("ok");
  return (res as { sessions: Record<string, RestoreSession> }).sessions;
}

test("loadRestoreFile v2: resolves the restore source to last_session", async () => {
  // Both tiers populated — last_session (frozen) wins over current (mirror).
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: {
        captured_at: 100,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "frozen" })] } },
      },
      current: {
        captured_at: 200,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "live" })] } },
      },
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.autopilot.agents[0].job_id).toBe("frozen");
});

test("loadRestoreFile v2: falls back to current when last_session is empty", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: { captured_at: 100, sessions: {} },
      current: {
        captured_at: 200,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "live" })] } },
      },
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.autopilot.agents[0].job_id).toBe("live");
});

test("loadRestoreFile v1: reads legacy top-level sessions as the last_session source", async () => {
  // A pre-fn-702 v1 file frozen under last-non-empty-wins.
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 1,
      captured_at: 1234,
      sessions: { autopilot: { agents: [fakeAgent({ job_id: "v1" })] } },
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.autopilot.agents[0].job_id).toBe("v1");
});

test("loadRestoreFile resolves to {} when every tier is empty", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: { captured_at: 1, sessions: {} },
      current: { captured_at: 2, sessions: {} },
    }),
    "utf8",
  );
  expect(okSessions(await loadRestoreFile(restorePath))).toEqual({});
});

test("loadRestoreFile v3: preserves each bucket's backend tag", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 3,
      last_session: {
        captured_at: 100,
        sessions: {
          ztab: { backend: "legacy", agents: [fakeAgent({ job_id: "z" })] },
          ttab: { backend: "tmux", agents: [fakeAgent({ job_id: "t" })] },
        },
      },
      current: null,
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.ztab.backend).toBe("legacy");
  expect(sessions.ttab.backend).toBe("tmux");
});

test("loadRestoreFile v2: a legacy bucket carries no backend tag (would-restore downstream)", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: {
        captured_at: 100,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "a" })] } },
      },
      current: null,
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.autopilot.backend).toBeUndefined();
  // planRestore would-restores the undefined-tag bucket (default backend).
  expect(planRestore(sessions, null, new Set()).map((p) => p.kind)).toEqual([
    "would-restore",
  ]);
});

// ---------------------------------------------------------------------------
// loadRestoreTiers — raw tiers, no precedence collapse
// ---------------------------------------------------------------------------

function okTiers(res: Awaited<ReturnType<typeof loadRestoreTiers>>) {
  expect(res.kind).toBe("ok");
  return res as Extract<typeof res, { kind: "ok" }>;
}

test("loadRestoreTiers exposes last_session + current as raw, uncollapsed tiers", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 3,
      last_session: {
        captured_at: 1,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "frozen" })] } },
      },
      current: {
        captured_at: 2,
        sessions: { autopilot: { agents: [fakeAgent({ job_id: "live" })] } },
      },
    }),
    "utf8",
  );
  const t = okTiers(await loadRestoreTiers(restorePath));
  // Both tiers survive independently — no frozen-wins collapse here.
  expect(t.lastSession?.autopilot.agents[0].job_id).toBe("frozen");
  expect(t.current?.autopilot.agents[0].job_id).toBe("live");
  expect(t.legacy).toBeNull();
});

test("loadRestoreTiers lifts a v1 legacy top-level sessions block into the legacy tier", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 1,
      captured_at: 9,
      sessions: { autopilot: { agents: [fakeAgent({ job_id: "v1" })] } },
    }),
    "utf8",
  );
  const t = okTiers(await loadRestoreTiers(restorePath));
  expect(t.lastSession).toBeNull();
  expect(t.current).toBeNull();
  expect(t.legacy?.autopilot.agents[0].job_id).toBe("v1");
});

test("loadRestoreTiers coerces an empty tier to null", async () => {
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 3,
      last_session: { captured_at: 1, sessions: {} },
      current: null,
    }),
    "utf8",
  );
  const t = okTiers(await loadRestoreTiers(restorePath));
  expect(t.lastSession).toBeNull();
  expect(t.current).toBeNull();
});

test("loadRestoreTiers passes missing / parse-error / future through unchanged", async () => {
  expect((await loadRestoreTiers(join(tmpDir, "nope.json"))).kind).toBe(
    "missing",
  );
  writeFileSync(restorePath, "{not json", "utf8");
  expect((await loadRestoreTiers(restorePath)).kind).toBe("parse-error");
  writeFileSync(restorePath, JSON.stringify({ schema_version: 4 }), "utf8");
  const fut = await loadRestoreTiers(restorePath);
  expect(fut.kind).toBe("future");
  expect((fut as { version: number }).version).toBe(4);
});

// ---------------------------------------------------------------------------
// resolveCrashSource — boot-promote precedence (current wins), the OPPOSITE of
// loadRestoreFile's frozen-wins reader precedence
// ---------------------------------------------------------------------------

test("resolveCrashSource picks current over last_session (boot-promote precedence)", () => {
  const current = fakeSessions({ autopilot: [fakeAgent({ job_id: "live" })] });
  const lastSession = fakeSessions({
    autopilot: [fakeAgent({ job_id: "frozen" })],
  });
  // Contrast with loadRestoreFile, which would resolve to "frozen".
  expect(
    resolveCrashSource({ current, lastSession, legacy: null }).autopilot
      .agents[0].job_id,
  ).toBe("live");
});

test("resolveCrashSource falls back current → last_session → legacy → {}", () => {
  const lastSession = fakeSessions({ a: [fakeAgent({ job_id: "x" })] });
  expect(
    resolveCrashSource({ current: null, lastSession, legacy: null }).a.agents[0]
      .job_id,
  ).toBe("x");
  const legacy = fakeSessions({ b: [fakeAgent({ job_id: "y" })] });
  expect(
    resolveCrashSource({ current: null, lastSession: null, legacy }).b.agents[0]
      .job_id,
  ).toBe("y");
  expect(
    resolveCrashSource({ current: null, lastSession: null, legacy: null }),
  ).toEqual({});
});

// ---------------------------------------------------------------------------
// shellQuote — POSIX single-quote escaping for the snapshot script
// ---------------------------------------------------------------------------

test("shellQuote wraps tokens in single quotes", () => {
  expect(shellQuote("simple")).toBe("'simple'");
  expect(shellQuote("")).toBe("''");
  expect(shellQuote("a b c")).toBe("'a b c'");
});

test("shellQuote neutralizes tmux/shell metacharacters literally", () => {
  // The bits that make the snapshot script byte-faithful: the tmux command
  // separator, the pane-id format, and the resume body's double quotes all
  // survive as literals inside single quotes.
  expect(shellQuote(";")).toBe("';'");
  expect(shellQuote("#{pane_id}")).toBe("'#{pane_id}'");
  expect(shellQuote(`claude --resume "x"`)).toBe(`'claude --resume "x"'`);
});

test("shellQuote escapes an embedded single quote via the '\\'' idiom", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

// ---------------------------------------------------------------------------
// renderSnapshotScript — runnable tmux restore script for the current tier
// ---------------------------------------------------------------------------

test("renderSnapshotScript emits a bash header, get-or-create guard, and one new-window per agent", () => {
  const current = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "a", cwd: "/repo", resume_target: "epic-foo" }),
      fakeAgent({ job_id: "b", cwd: "/repo", resume_target: "epic-bar" }),
    ],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/state/r.json");
  expect(out.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  expect(out).toContain("set -euo pipefail");
  expect(out).toContain("/state/r.json (current tier)");
  // Get-or-create guard: has-session OR new-session, every token quoted.
  expect(out).toContain(
    "'tmux' 'has-session' '-t' '=autopilot' 2>/dev/null || " +
      "'tmux' 'new-session' '-d' '-s' 'autopilot' '-e' 'KEEPER_TMUX_SESSION=autopilot'",
  );
  // One new-window per agent, carrying the resume body + tmux ';' separator.
  expect(out).toContain("'new-window' '-t' 'autopilot:'");
  expect(out).toContain(`claude --resume "epic-foo"`);
  expect(out).toContain(`claude --resume "epic-bar"`);
  expect(out).toContain("';' 'set-option' '-p' 'remain-on-exit' 'on'");
  expect(out).toContain("# summary: snapshot-current sessions=1 agents=2");
});

test("renderSnapshotScript respects the --session filter", () => {
  const current = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a", resume_target: "keep" })],
    side: [fakeAgent({ job_id: "b", resume_target: "drop" })],
  });
  const out = renderSnapshotScript(current, "autopilot", "/bin/zsh", "/r.json");
  expect(out).toContain(`claude --resume "keep"`);
  expect(out).not.toContain(`claude --resume "drop"`);
  expect(out).toContain("# summary: snapshot-current sessions=1 agents=1");
});

test("renderSnapshotScript drops the cd prefix when cwd is null", () => {
  const current = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a", cwd: null, resume_target: "x" })],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/r.json");
  // The inner resume body starts straight at `claude`, no `cd` segment, and the
  // new-window `-c` carries an empty cwd (quoted as '').
  expect(out).toContain(
    `'claude --resume "x" --arthack-no-confirm ; exec /bin/zsh -l -i'`,
  );
  expect(out).not.toContain("cd  &&");
  expect(out).toContain("'-c' ''");
});

test("renderSnapshotScript on an empty current tier is a valid no-op script", () => {
  const out = renderSnapshotScript({}, null, "/bin/zsh", "/r.json");
  expect(out.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  expect(out).toContain("# summary: snapshot-current sessions=0 agents=0");
  // No tmux commands at all (the quoted command token never appears — only the
  // prose "tmux window" in the header does).
  expect(out).not.toContain("'tmux'");
});

test("renderSnapshotScript emits agents in visual window order", () => {
  const current = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "a", window_index: 2, resume_target: "third" }),
      fakeAgent({ job_id: "b", window_index: 0, resume_target: "first" }),
      fakeAgent({ job_id: "c", window_index: 1, resume_target: "second" }),
    ],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/r.json");
  const firstAt = out.indexOf(`claude --resume "first"`);
  const secondAt = out.indexOf(`claude --resume "second"`);
  const thirdAt = out.indexOf(`claude --resume "third"`);
  expect(firstAt).toBeLessThan(secondAt);
  expect(secondAt).toBeLessThan(thirdAt);
});

test("renderSnapshotScript puts 'sleep 0.5' BETWEEN new-window lines, not after the last", () => {
  const current = fakeSessions({
    autopilot: [
      fakeAgent({ job_id: "a", window_index: 0, resume_target: "w0" }),
      fakeAgent({ job_id: "b", window_index: 1, resume_target: "w1" }),
      fakeAgent({ job_id: "c", window_index: 2, resume_target: "w2" }),
    ],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/r.json");
  // Three windows → two interleaving sleeps.
  const sleepCount = out.split("\n").filter((l) => l === "sleep 0.5").length;
  expect(sleepCount).toBe(2);
  // The script never ENDS on a sleep (last non-empty line is the summary).
  const lines = out.split("\n").filter((l) => l.length > 0);
  expect(lines[lines.length - 1]).toContain("# summary:");
  expect(lines[lines.length - 1]).not.toBe("sleep 0.5");
});

test("renderSnapshotScript tracks the inter-window sleep ACROSS session boundaries", () => {
  // Two sessions, one agent each → exactly ONE sleep, between the two windows,
  // even though they live in different session stanzas. No leading sleep in the
  // second session's stanza.
  const current = fakeSessions({
    alpha: [fakeAgent({ job_id: "a", resume_target: "wa" })],
    beta: [fakeAgent({ job_id: "b", resume_target: "wb" })],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/r.json");
  const sleepCount = out.split("\n").filter((l) => l === "sleep 0.5").length;
  expect(sleepCount).toBe(1);
  // The sleep sits before the second session's new-window, after the first's.
  const waAt = out.indexOf(`claude --resume "wa"`);
  const sleepAt = out.indexOf("\nsleep 0.5\n");
  const wbAt = out.indexOf(`claude --resume "wb"`);
  expect(waAt).toBeLessThan(sleepAt);
  expect(sleepAt).toBeLessThan(wbAt);
});

test("renderSnapshotScript emits NO sleep for a single-agent run", () => {
  const current = fakeSessions({
    autopilot: [fakeAgent({ job_id: "solo", resume_target: "only" })],
  });
  const out = renderSnapshotScript(current, null, "/bin/zsh", "/r.json");
  expect(out).not.toContain("sleep 0.5");
});
