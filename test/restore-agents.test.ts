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
 * real zellij ensureLaunched) is NOT spawned — the same shape every other
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
  loadRestoreFile,
  planRestore,
  renderOutcomes,
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
  // future. A v2 file (no per-bucket backend) reads as zellij downstream.
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

test("planRestore marks every agent would-restore when the skip-set is empty", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "a" }), fakeAgent({ job_id: "b" })],
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan.map((p) => p.kind)).toEqual(["would-restore", "would-restore"]);
});

test("planRestore skips agents whose job_id is in the live skip-set", () => {
  const desc = fakeSessions({
    autopilot: [fakeAgent({ job_id: "live" }), fakeAgent({ job_id: "dead" })],
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

test("planRestore reads a v2/legacy bucket (no backend tag) as zellij — would-restore", () => {
  // fakeSessions builds buckets without a `backend` field — the v2/legacy
  // shape. They must route normally (default zellij), not skip.
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

test("planRestore skips an unknown-backend bucket with skipped-backend", () => {
  const desc = fakeSessionsWithBackend({
    weird: { agents: [fakeAgent({ job_id: "a" })], backend: "wezterm" },
  });
  const plan = planRestore(desc, null, new Set());
  expect(plan).toHaveLength(1);
  expect(plan[0].kind).toBe("skipped-backend");
  expect((plan[0] as { backend: string }).backend).toBe("wezterm");
});

test("planRestore mixes per-bucket backend routing — zellij/tmux restore, unknown skips", () => {
  const desc = fakeSessionsWithBackend({
    z: { agents: [fakeAgent({ job_id: "z1" })], backend: "zellij" },
    t: { agents: [fakeAgent({ job_id: "t1" })], backend: "tmux" },
    x: { agents: [fakeAgent({ job_id: "x1" })], backend: "kitty" },
  });
  const plan = planRestore(desc, null, new Set());
  // Alpha order: t, x, z.
  expect(plan.map((p) => [p.session, p.kind])).toEqual([
    ["t", "would-restore"],
    ["x", "skipped-backend"],
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
        return { ok: false, error: "zellij ENOENT" };
      }
      return { ok: true };
    },
    "/bin/zsh",
  );
  expect(out).toHaveLength(2);
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("zellij ENOENT");
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
  );
  expect(calls).toBe(0);
  expect(out.map((o) => o.kind)).toEqual(["skipped-live", "skipped-live"]);
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
  );
  const rendered = renderOutcomes(out, "/bin/zsh", true);
  expect(rendered).toContain("restored=1");
  expect(rendered).toContain("skipped-live=1");
  expect(rendered).toContain("failed=1");
  expect(rendered).toContain("FAILED z");
});

test("renderOutcomes reports skipped-backend in the summary and a per-agent note", () => {
  const desc = fakeSessionsWithBackend({
    weird: { agents: [fakeAgent({ job_id: "a" })], backend: "wezterm" },
  });
  const plan = planRestore(desc, null, new Set());
  const out = renderOutcomes(plan, "/bin/zsh", false);
  expect(out).toContain("skipped-backend=1");
  expect(out).toContain("unknown backend 'wezterm'");
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
          ztab: { backend: "zellij", agents: [fakeAgent({ job_id: "z" })] },
          ttab: { backend: "tmux", agents: [fakeAgent({ job_id: "t" })] },
        },
      },
      current: null,
    }),
    "utf8",
  );
  const sessions = okSessions(await loadRestoreFile(restorePath));
  expect(sessions.ztab.backend).toBe("zellij");
  expect(sessions.ttab.backend).toBe("tmux");
});

test("loadRestoreFile v2: a legacy bucket carries no backend tag (reads as zellij downstream)", async () => {
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
  // planRestore treats the undefined tag as the zellij default → would-restore.
  expect(planRestore(sessions, null, new Set()).map((p) => p.kind)).toEqual([
    "would-restore",
  ]);
});
